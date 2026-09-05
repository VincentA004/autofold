from __future__ import annotations

import json
import hashlib
import re
import ast
from pathlib import Path
from typing import Any

FORMATS = {
    "bundles": {"autofold.trial-bundle.v1", "autofold.trial-bundle.v2", "autofold.trial-bundle.v3", "autofold.trial-bundle.v4"},
    "candidates": "autofold.candidate-set.v1",
    "evaluation": "autofold.evaluation-result.v1",
    "manifest": "autofold.run-manifest.v1",
}


class ProtocolError(ValueError):
    pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProtocolError(f"Cannot read JSON from {path}: {error}") from error
    if not isinstance(value, dict):
        raise ProtocolError(f"Expected an object in {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def require_string(value: dict[str, Any], key: str, prefix: str | None = None) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ProtocolError(f"{key} must be a non-empty string")
    if prefix and not item.startswith(prefix):
        raise ProtocolError(f"{key} must start with {prefix}")
    return item


def validate_bundle(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("format") not in FORMATS["bundles"]:
        raise ProtocolError("Unsupported trial bundle format")
    require_string(value, "runId", "run_")
    require_string(value, "trialId", "trl_")
    require_string(value, "contractHash", "sha256:")
    if value["format"] in {"autofold.trial-bundle.v2", "autofold.trial-bundle.v3", "autofold.trial-bundle.v4"}:
        require_string(value, "targetArtifactHash", "sha256:")
        if "targetArtifactPath" in value:
            require_string(value, "targetArtifactPath")
    if value["format"] in {"autofold.trial-bundle.v3", "autofold.trial-bundle.v4"}:
        if value.get("designAdapter") != "proto" or not isinstance(value.get("proto"), dict):
            raise ProtocolError("Scientific bundle v3 requires the pinned Proto runtime")
        require_string(value, "targetArtifactPath")
        if "targetStructurePath" in value:
            require_string(value, "targetStructurePath")
        adapter = value.get("evidenceAdapter")
        if not isinstance(adapter, dict):
            raise ProtocolError("Scientific bundle v3 requires an evidence adapter")
        require_string(adapter, "id")
        require_string(adapter, "version")
        require_string(adapter, "sourceHash", "sha256:")
        if "scoringPipelineHash" in adapter:
            require_string(adapter, "scoringPipelineHash", "sha256:")
    if value["format"] == "autofold.trial-bundle.v4":
        pipeline = value.get("pipeline")
        if not isinstance(pipeline, dict) or not isinstance(pipeline.get("stages"), list) or not pipeline["stages"]:
            raise ProtocolError("Scientific bundle v4 requires a pipeline policy")
        require_string(pipeline, "id")
        if "sourceHash" in pipeline:
            require_string(pipeline, "sourceHash", "sha256:")
        if "protoToolsCommit" in pipeline:
            if require_string(pipeline, "protoToolsCommit") != value["proto"]["toolsCommit"]:
                raise ProtocolError("Pipeline policy uses another proto-tools commit")
        authored_diagnostics = pipeline.get("authoredDiagnostics", [])
        if not isinstance(authored_diagnostics, list) or not all(
            isinstance(stage, dict) for stage in authored_diagnostics
        ):
            raise ProtocolError("Pipeline authoredDiagnostics must be an array of stage objects")
        if any(stage.get("role") != "diagnostic" for stage in authored_diagnostics):
            raise ProtocolError("Pipeline authoredDiagnostics may contain only diagnostic stages")
        generation = pipeline.get("generation")
        if generation is not None:
            if not isinstance(generation, dict) or generation.get("mode") != "proto_program":
                raise ProtocolError("Pipeline generation policy is invalid")
            declared_generators = generation.get("generators")
            if not isinstance(declared_generators, list) or not declared_generators or not all(
                isinstance(generator, dict) for generator in declared_generators
            ):
                raise ProtocolError("Pipeline generation policy requires generator declarations")
            generator_ids = [require_string(generator, "id") for generator in declared_generators]
            if len(set(generator_ids)) != len(generator_ids):
                raise ProtocolError("Pipeline generation IDs must be unique")
            for generator in declared_generators:
                if require_string(generator, "version") != value["proto"]["languageCommit"]:
                    raise ProtocolError("Pipeline generator version does not match proto-language")
                tools_called = generator.get("toolsCalled")
                if not isinstance(tools_called, list) or not all(isinstance(tool, str) and tool for tool in tools_called):
                    raise ProtocolError("Pipeline generator tools must be string arrays")
                allocation = generator.get("allocation")
                if allocation is None and len(declared_generators) == 1:
                    continue
                if not isinstance(allocation, dict):
                    raise ProtocolError("Pipeline generator allocation is invalid")
                if not isinstance(allocation.get("maximumCandidates"), int) or allocation["maximumCandidates"] <= 0:
                    raise ProtocolError("Pipeline generator candidate allocation is invalid")
                if not isinstance(allocation.get("maximumGpuSeconds"), (int, float)) or allocation["maximumGpuSeconds"] <= 0:
                    raise ProtocolError("Pipeline generator GPU allocation is invalid")
            generation_budget = generation.get("budget")
            if not isinstance(generation_budget, dict):
                raise ProtocolError("Pipeline generation budget is invalid")
            maximum_candidates = generation_budget.get("maximumCandidates")
            if not isinstance(maximum_candidates, int) or maximum_candidates <= 0 or maximum_candidates > value["candidateBudget"]:
                raise ProtocolError("Pipeline generation candidate budget is invalid")
            maximum_gpu_seconds = generation_budget.get("maximumGpuSeconds")
            if maximum_gpu_seconds is not None and (
                not isinstance(maximum_gpu_seconds, (int, float)) or maximum_gpu_seconds <= 0
            ):
                raise ProtocolError("Pipeline generation GPU budget is invalid")
            allocations = [generator.get("allocation") for generator in declared_generators]
            if any(allocation is not None for allocation in allocations):
                if any(allocation is None for allocation in allocations):
                    raise ProtocolError("Pipeline generator allocations must be all present or all absent")
                if sum(allocation["maximumCandidates"] for allocation in allocations) != maximum_candidates:
                    raise ProtocolError("Pipeline generator allocations do not exhaust the candidate budget")
                if maximum_gpu_seconds is not None and sum(
                    allocation["maximumGpuSeconds"] for allocation in allocations
                ) > maximum_gpu_seconds:
                    raise ProtocolError("Pipeline generator allocations exceed the GPU budget")
        stage_ids: set[str] = set()
        for stage in pipeline["stages"]:
            if not isinstance(stage, dict):
                raise ProtocolError("Pipeline stages must be objects")
            stage_id = require_string(stage, "id")
            if stage.get("role", "scoring") not in {"scoring", "diagnostic"}:
                raise ProtocolError("Pipeline stage role must be scoring or diagnostic")
            if stage_id in stage_ids:
                raise ProtocolError("Pipeline stage IDs must be unique")
            stage_ids.add(stage_id)
            models = stage.get("models")
            if not isinstance(models, list) or not models or not all(isinstance(model, dict) for model in models):
                raise ProtocolError("Pipeline stages require model declarations")
            model_ids = [require_string(model, "id") for model in models]
            if not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", model_id) for model_id in model_ids):
                raise ProtocolError("Pipeline model IDs contain unsupported characters")
            for model in models:
                require_string(model, "version")
                if "toolKey" in model:
                    tool_key = require_string(model, "toolKey")
                    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", tool_key):
                        raise ProtocolError("Pipeline tool keys contain unsupported characters")
                    if pipeline.get("protoToolsCommit") and model["version"] != pipeline["protoToolsCommit"]:
                        raise ProtocolError("Resolved Proto tool version does not match the frozen registry commit")
                config = model.get("config", {})
                if not isinstance(config, dict):
                    raise ProtocolError("Resolved Proto tool config must be an object")
                if any(key in config for key in {"seed", "seeds", "timeout", "device"}):
                    raise ProtocolError("Resolved Proto tool config overrides an Autofold runtime setting")
            if len(set(model_ids)) != len(model_ids):
                raise ProtocolError("Pipeline stage model IDs must be unique")
            if not isinstance(stage.get("required"), bool) or not isinstance(stage.get("allowSkip"), bool):
                raise ProtocolError("Pipeline stage routing flags must be booleans")
            if stage["required"] and stage["allowSkip"]:
                raise ProtocolError("Required pipeline stages cannot allow skips")
            allowed_skips = stage.get("allowedSkips", [])
            if not isinstance(allowed_skips, list) or any(
                item not in {"condition_false", "candidate_filtered", "optional_tool_failure"}
                for item in allowed_skips
            ):
                raise ProtocolError("Pipeline allowed skips are invalid")
            if allowed_skips and not stage["allowSkip"]:
                raise ProtocolError("Pipeline stage declares skips without allowing them")
        dependencies: dict[str, list[str]] = {}
        for stage in pipeline["stages"]:
            depends_on = stage.get("dependsOn", [])
            if not isinstance(depends_on, list) or not all(isinstance(item, str) for item in depends_on):
                raise ProtocolError("Pipeline stage dependencies must be string arrays")
            if len(set(depends_on)) != len(depends_on) or any(item not in stage_ids or item == stage["id"] for item in depends_on):
                raise ProtocolError("Pipeline stage dependencies are invalid")
            dependencies[stage["id"]] = depends_on
            condition = stage.get("condition")
            if condition is not None:
                if not isinstance(condition, dict) or condition.get("source") not in depends_on:
                    raise ProtocolError("Pipeline condition must reference a direct dependency")
                if condition.get("operator") not in {"lt", "lte", "gt", "gte"} or not isinstance(condition.get("value"), (int, float)):
                    raise ProtocolError("Pipeline condition is invalid")
                require_string(condition, "metric")
            routing = stage.get("candidateRouting")
            if routing is not None:
                if not isinstance(routing, dict) or routing.get("source") not in depends_on:
                    raise ProtocolError("Candidate routing must reference a direct dependency")
                if routing.get("direction") not in {"minimize", "maximize"}:
                    raise ProtocolError("Candidate routing direction is invalid")
                require_string(routing, "metric")
                if not isinstance(routing.get("maximumCandidates"), int) or routing["maximumCandidates"] <= 0:
                    raise ProtocolError("Candidate routing budget must be positive")
            budget = stage.get("budget")
            if budget is not None and not isinstance(budget, dict):
                raise ProtocolError("Pipeline stage budget must be an object")
            if budget is not None:
                candidates = budget.get("maximumCandidates")
                gpu_seconds = budget.get("maximumGpuSeconds")
                if candidates is not None and (not isinstance(candidates, int) or candidates <= 0):
                    raise ProtocolError("Pipeline candidate budget must be positive")
                if gpu_seconds is not None and (not isinstance(gpu_seconds, (int, float)) or gpu_seconds <= 0):
                    raise ProtocolError("Pipeline GPU budget must be positive")
        visiting: set[str] = set()
        visited: set[str] = set()
        def visit(stage_id: str) -> None:
            if stage_id in visiting:
                raise ProtocolError("Pipeline stage dependencies must be acyclic")
            if stage_id in visited:
                return
            visiting.add(stage_id)
            for dependency in dependencies[stage_id]:
                visit(dependency)
            visiting.remove(stage_id)
            visited.add(stage_id)
        for stage_id in stage_ids:
            visit(stage_id)
        positions = {stage["id"]: index for index, stage in enumerate(pipeline["stages"])}
        for stage in pipeline["stages"]:
            if any(positions[dependency] >= positions[stage["id"]] for dependency in dependencies[stage["id"]]):
                raise ProtocolError("Frozen pipeline stages must be topologically ordered")
        scoring_hash = adapter.get("scoringPipelineHash")
        if scoring_hash:
            scoring = [stage for stage in pipeline["stages"] if stage.get("role", "scoring") == "scoring"]
            if not scoring:
                raise ProtocolError("Frozen experiment has no scoring stages")
            scoring_ids = {stage["id"] for stage in scoring}
            for stage in scoring:
                if (
                    not stage["required"]
                    or stage["allowSkip"]
                    or stage.get("condition") is not None
                    or stage.get("candidateRouting") is not None
                ):
                    raise ProtocolError("Scoring stages must evaluate every submitted candidate")
                if any(dependency not in scoring_ids for dependency in dependencies[stage["id"]]):
                    raise ProtocolError("Scoring stages cannot depend on diagnostic stages")
            scoring_policy = {
                "format": "autofold.scoring-pipeline.v1",
                "protoToolsCommit": pipeline.get("protoToolsCommit"),
                "stages": scoring,
            }
            scoring_canonical = json.dumps(scoring_policy, sort_keys=True, separators=(",", ":"))
            observed_scoring_hash = "sha256:" + hashlib.sha256(scoring_canonical.encode("utf-8")).hexdigest()
            if observed_scoring_hash != scoring_hash:
                raise ProtocolError("Scoring pipeline hash does not match the frozen experiment")
        require_string(value, "pipelineHash", "sha256:")
        canonical = json.dumps(pipeline, sort_keys=True, separators=(",", ":"))
        pipeline_hash = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        if pipeline_hash != value["pipelineHash"]:
            raise ProtocolError("Pipeline policy hash does not match its canonical content")
    if value.get("designAdapter") not in {"mock", "proto"}:
        raise ProtocolError("Unsupported design adapter")
    if value.get("intent", "optimize") not in {"optimize", "calibrate", "negative_control", "shadow_replay"}:
        raise ProtocolError("Unsupported trial intent")
    require_string(value, "programPath")
    require_string(value, "programHash", "sha256:")
    if value.get("modality") not in {
        "linear_minibinder",
        "short_peptide",
        "cyclic_peptide",
        "modified_peptide",
    }:
        raise ProtocolError("Unsupported modality")
    evaluator = value.get("evaluator")
    if not isinstance(evaluator, dict):
        raise ProtocolError("evaluator must be an object")
    require_string(evaluator, "id")
    require_string(evaluator, "version")
    require_string(evaluator, "sourceHash", "sha256:")
    if evaluator.get("direction") not in {"minimize", "maximize"}:
        raise ProtocolError("Unsupported evaluator direction")
    if value["designAdapter"] == "proto":
        proto = value.get("proto")
        if not isinstance(proto, dict):
            raise ProtocolError("Proto adapter requires proto runtime metadata")
        require_string(proto, "root")
        require_string(proto, "languageCommit")
        require_string(proto, "toolsCommit")
    seeds = value.get("seeds")
    if not isinstance(seeds, list) or not seeds or not all(isinstance(seed, int) for seed in seeds):
        raise ProtocolError("seeds must be a non-empty integer array")
    for key in ("candidateBudget", "submissionSize"):
        if not isinstance(value.get(key), int) or value[key] <= 0:
            raise ProtocolError(f"{key} must be a positive integer")
    return value


def validate_workflow_source(path: Path, bundle: dict[str, Any]) -> None:
    """Bind a compiled v4 policy to the literal manifest in immutable trial.py."""
    pipeline = bundle.get("pipeline", {})
    expected = pipeline.get("sourceHash")
    if bundle.get("format") != "autofold.trial-bundle.v4" or not expected:
        return
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    assignments = []
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if any(isinstance(target, ast.Name) and target.id == "AUTOFOLD_WORKFLOW" for target in targets):
            assignments.append(node)
    if len(assignments) != 1:
        raise ProtocolError("Compiled workflow requires exactly one literal AUTOFOLD_WORKFLOW")
    try:
        workflow = ast.literal_eval(assignments[0].value)
    except (ValueError, TypeError) as error:
        raise ProtocolError("AUTOFOLD_WORKFLOW must be a literal") from error
    if not isinstance(workflow, dict) or not isinstance(workflow.get("stages"), list):
        raise ProtocolError("AUTOFOLD_WORKFLOW must be an object with stages")
    for stage in workflow["stages"]:
        if not isinstance(stage, dict):
            raise ProtocolError("AUTOFOLD_WORKFLOW stages must be objects")
        stage.setdefault("selection", "all")
        stage.setdefault("configs", {})
        stage.setdefault("dependsOn", [])
        stage.setdefault("optional", False)
    canonical = json.dumps(workflow, sort_keys=True, separators=(",", ":"))
    actual = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if actual != expected:
        raise ProtocolError("Compiled pipeline does not match AUTOFOLD_WORKFLOW")
