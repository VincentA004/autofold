from __future__ import annotations

import json
import hashlib
import math
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


def _same_json(left: Any, right: Any) -> bool:
    # JSON numbers have one category; booleans must never compare equal to 0/1.
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        if any(isinstance(v, float) and not math.isfinite(v) for v in (left, right)):
            return False
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_json(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def pipeline_policy_hash(pipeline: dict[str, Any], canonical_json: str | None = None) -> str:
    """Hash exact host JSON bytes after proving their full semantic correspondence.

    Old bundles keep their original Python-rendered verification path. New native
    bundles carry the existing host canonical bytes, avoiding number, Unicode and
    numeric-object-key ordering differences without changing the host policy hash.
    """
    if canonical_json is None:
        canonical_json = json.dumps(pipeline, sort_keys=True, separators=(",", ":"))
    else:
        if not isinstance(canonical_json, str) or len(canonical_json.encode("utf-8")) > 1024 * 1024:
            raise ProtocolError("Canonical pipeline bytes exceed 1 MiB or are not a string")
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("Duplicate canonical pipeline key")
                result[key] = value
            return result
        def finite(token):
            raise ValueError("Nonfinite canonical pipeline number")
        try:
            parsed = json.loads(canonical_json, object_pairs_hook=unique, parse_constant=finite)
        except (ValueError, TypeError) as error:
            raise ProtocolError(f"Invalid canonical pipeline JSON: {error}") from error
        if not _same_json(parsed, pipeline):
            raise ProtocolError("Canonical pipeline bytes do not match the frozen policy")
    return "sha256:" + hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


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
        worker = value.get("worker")
        if worker is not None:
            if not isinstance(worker, dict) or worker.get("format") != "autofold.worker-tree.v1":
                raise ProtocolError("Worker tree identity is invalid")
            require_string(worker, "sourceHash", "sha256:")
        pipeline = value.get("pipeline")
        if not isinstance(pipeline, dict) or not isinstance(pipeline.get("stages"), list) or not pipeline["stages"]:
            raise ProtocolError("Scientific bundle v4 requires a pipeline policy")
        require_string(pipeline, "id")
        if "sourceHash" in pipeline:
            require_string(pipeline, "sourceHash", "sha256:")
        if "protoToolsCommit" in pipeline:
            if require_string(pipeline, "protoToolsCommit") != value["proto"]["toolsCommit"]:
                raise ProtocolError("Pipeline policy uses another proto-tools commit")
        if pipeline.get("executionBackend", "legacy_dag_v1") not in {"legacy_dag_v1", "native_tool_sequence_v1"}:
            raise ProtocolError("Unsupported evidence execution backend")
        if pipeline.get("executionBackend") == "native_tool_sequence_v1":
            from .evidence_execution import validate_native_sequence
            try:
                validate_native_sequence(pipeline["stages"])
            except (KeyError, TypeError, ValueError) as error:
                raise ProtocolError(str(error)) from error
        authored_diagnostics = pipeline.get("authoredDiagnostics", [])
        if not isinstance(authored_diagnostics, list) or not all(
            isinstance(stage, dict) for stage in authored_diagnostics
        ):
            raise ProtocolError("Pipeline authoredDiagnostics must be an array of stage objects")
        if any(stage.get("role") != "diagnostic" for stage in authored_diagnostics):
            raise ProtocolError("Pipeline authoredDiagnostics may contain only diagnostic stages")
        execution_budget = pipeline.get("executionBudget")
        if execution_budget is not None:
            if not isinstance(execution_budget, dict) or execution_budget.get("semantics") != "aggregate_worker_gpu_wall_v1":
                raise ProtocolError("Pipeline aggregate execution budget is invalid")
            maximum = execution_budget.get("maximumGpuSeconds")
            if not isinstance(maximum, (int, float)) or isinstance(maximum, bool) or maximum <= 0:
                raise ProtocolError("Pipeline aggregate GPU budget must be positive")
        native_search = pipeline.get("nativeSearch")
        if native_search is not None:
            from .native_search import NativeSearch, NativeOutput
            try:
                if native_search.get("format") != "autofold.native-search.v1":
                    raise ValueError("Unsupported native search format")
                budget = native_search["budget"]
                search = NativeSearch(maximum_candidates=budget["maximumCandidates"], maximum_proposals=budget["maximumProposals"],
                    maximum_sampling_calls=budget["maximumSamplingCalls"], maximum_tool_calls=budget["maximumToolCalls"],
                    maximum_wall_seconds=budget["maximumWallSeconds"], allowed_tools=tuple(budget["allowedTools"]),
                    outputs=tuple(NativeOutput(**o) for o in budget["outputs"]))
                if not native_search["projection"] or search.maximum_candidates > value["candidateBudget"]:
                    raise ValueError("Native search exceeds final candidate budget or has no projection")
                reserved = sum(stage.get("budget", {}).get("maximumGpuSeconds", 0) for stage in pipeline["stages"])
                if execution_budget and execution_budget.get("reservationSemantics") is not None:
                    if execution_budget.get("reservationSemantics") != "per_model_candidate_seed_timeout_upper_bound_v1" or execution_budget.get("unit") != "wall_seconds":
                        raise ValueError("Unsupported native invocation reservation units")
                    expected = []
                    for stage in pipeline["stages"]:
                        requests = search.maximum_candidates * len(value["seeds"]) * len(stage["models"])
                        seconds = stage.get("budget", {}).get("maximumGpuSeconds")
                        if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not math.isfinite(seconds) or seconds <= 0:
                            raise ValueError("Fresh native model stage requires an explicit positive wall-time deadline")
                        expected.append({"stageId": stage["id"], "maximumCandidates": search.maximum_candidates,
                            "seedCount": len(value["seeds"]), "modelCount": len(stage["models"]), "maximumRequests": requests,
                            "perRequestTimeoutSeconds": seconds, "reservedWallSeconds": requests * seconds})
                    reserved = sum(item["reservedWallSeconds"] for item in expected)
                    if not _same_json(execution_budget.get("invocationReservations"), expected) or not _same_json(execution_budget.get("reservedEvidenceWallSeconds"), reserved):
                        raise ValueError("Native invocation reservations do not bind actual model/candidate/seed cardinality")
                if value.get("nativeExecution") is None and (not execution_budget or search.maximum_wall_seconds + reserved > execution_budget["maximumGpuSeconds"]):
                    raise ValueError("Native search and final evaluation exceed aggregate execution budget")
                if pipeline.get("staticConstruction") is not None:
                    raise ValueError("Native search cannot mutate a fixed construction")
            except (KeyError, TypeError, ValueError, AttributeError) as error:
                raise ProtocolError(f"Invalid native search policy: {error}") from error
        static_construction = pipeline.get("staticConstruction")
        generation = pipeline.get("generation")
        if generation is not None and static_construction is not None:
            raise ProtocolError("Generated and fixed construction policies are mutually exclusive")
        if static_construction is not None:
            if not isinstance(static_construction, dict) or static_construction.get("format") != "autofold.static-construction.v1":
                raise ProtocolError("Pipeline fixed construction receipt is invalid")
            if static_construction.get("kind") != "native" or static_construction.get("optimizerCount") != 1:
                raise ProtocolError("Fixed construction must use one native Proto optimizer")
            if static_construction.get("generatorCount") != 0 or static_construction.get("proposalSources") != ["existing_results"]:
                raise ProtocolError("Fixed construction must use existing results without generators")
            fixed = static_construction.get("fixedSequences")
            if (
                not isinstance(fixed, list)
                or len(fixed) != value.get("submissionSize")
                or len(set(fixed)) != len(fixed)
                or not all(isinstance(sequence, str) and re.fullmatch(r"[ACDEFGHIKLMNPQRSTVWY]+", sequence) for sequence in fixed)
            ):
                raise ProtocolError("Fixed construction sequences must exactly match the frozen submission size")
            if not isinstance(static_construction.get("constructCount"), int) or isinstance(static_construction["constructCount"], bool) or static_construction["constructCount"] <= 0:
                raise ProtocolError("Fixed construction must contain Proto constructs")
            if not isinstance(static_construction.get("programResultCount"), int) or isinstance(static_construction["programResultCount"], bool) or static_construction["programResultCount"] <= 0:
                raise ProtocolError("Fixed construction result count must be positive")
            if static_construction["programResultCount"] > value.get("candidateBudget", 0):
                raise ProtocolError("Fixed construction result count exceeds the candidate budget")
            samples = static_construction.get("optimizerSamples")
            if not isinstance(samples, list) or len(samples) != 1 or not isinstance(samples[0], dict):
                raise ProtocolError("Fixed construction must freeze one optimizer sampling receipt")
            if any(not isinstance(samples[0].get(key), int) or isinstance(samples[0][key], bool) or samples[0][key] <= 0 for key in ("numSamples", "numResults", "proposalBatchSize")):
                raise ProtocolError("Fixed construction optimizer sampling must be positive")
            if any(samples[0][key] > value.get("candidateBudget", 0) for key in ("numSamples", "numResults", "proposalBatchSize")):
                raise ProtocolError("Fixed construction optimizer sampling exceeds the candidate budget")
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
        if "pipelineCanonicalJson" in value and not isinstance(value["pipelineCanonicalJson"], str):
            raise ProtocolError("Canonical pipeline bytes must be a string")
        pipeline_hash = pipeline_policy_hash(pipeline, value.get("pipelineCanonicalJson"))
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
    if value.get("nativeExecution") is not None:
        validate_native_execution(value)
    return value


def validate_native_execution(bundle: dict[str, Any]) -> None:
    """Validate fresh authority independently of a scoring pipeline or format."""
    from .native_search import NativeOutput, NativeSearch
    execution = bundle.get("nativeExecution")
    if not isinstance(execution, dict) or execution.get("protocol") not in {"native_search_v1", "native_fixed_control_v1"} or execution.get("observation") != "scoped_native_lifecycle_v1":
        raise ProtocolError("Fresh native execution protocol or observation is invalid")
    if bundle.get("designAdapter") != "proto":
        raise ProtocolError("Native execution requires Proto")
    worker = bundle.get("worker")
    if not isinstance(worker, dict) or worker.get("format") != "autofold.worker-tree.v1":
        raise ProtocolError("Fresh native execution requires an executing worker identity")
    require_string(worker, "sourceHash", "sha256:")
    outputs = execution.get("outputs")
    try:
        if not isinstance(outputs, list) or not outputs:
            raise ValueError("Explicit native outputs required")
        selected = tuple(NativeOutput(**row) for row in outputs)
        if len(set(selected)) != len(selected):
            raise ValueError("Repeated native outputs")
    except (TypeError, ValueError) as error:
        raise ProtocolError(f"Invalid native output selectors: {error}") from error
    resources = execution.get("resources")
    if not isinstance(resources, dict):
        raise ProtocolError("Native resources are required")
    for key in ("maximumSearchWallSeconds", "maximumWorkerWallSeconds", "reservedEvaluationWallSeconds", "maximumComputeReservationSeconds", "reservedSearchComputeSeconds", "reservedEvaluationComputeSeconds"):
        number = resources.get(key)
        if type(number) not in {int, float} or not math.isfinite(number) or number < (0 if key.startswith("reserved") or key == "maximumComputeReservationSeconds" else 1):
            raise ProtocolError(f"Invalid native resource {key}")
    if resources["maximumSearchWallSeconds"] + resources["reservedEvaluationWallSeconds"] > resources["maximumWorkerWallSeconds"]:
        raise ProtocolError("Native search and evaluation reservations exceed worker wall authority")
    if resources["reservedSearchComputeSeconds"] > resources["maximumSearchWallSeconds"] or resources["reservedEvaluationComputeSeconds"] > resources["reservedEvaluationWallSeconds"] or resources["reservedSearchComputeSeconds"] + resources["reservedEvaluationComputeSeconds"] > resources["maximumComputeReservationSeconds"]:
        raise ProtocolError("Native compute reservations exceed their actual wall or compute authority")
    descriptor = execution.get("descriptor")
    pipeline = bundle.get("pipeline", {})
    if not isinstance(pipeline, dict):
        raise ProtocolError("Native evaluation pipeline must be an object")
    if not isinstance(descriptor, dict):
        raise ProtocolError("Native construction descriptor is required")
    if execution["protocol"] == "native_search_v1":
        try:
            budget = descriptor["budget"]
            search = NativeSearch(budget["maximumCandidates"], budget["maximumProposals"], budget["maximumSamplingCalls"], budget["maximumToolCalls"], budget["maximumWallSeconds"], tuple(NativeOutput(**o) for o in budget["outputs"]), tuple(budget["allowedTools"]))
            if descriptor.get("format") != "autofold.native-search.v1" or not descriptor.get("projection") or not _same_json(outputs, budget["outputs"]) or search.maximum_wall_seconds != resources["maximumSearchWallSeconds"] or search.maximum_candidates > bundle["candidateBudget"]:
                raise ValueError("Search descriptor, selectors or wall authority differ")
        except (KeyError, TypeError, ValueError) as error:
            raise ProtocolError(f"Invalid fresh native search descriptor: {error}") from error
        if pipeline.get("nativeSearch") is not None and not _same_json(pipeline["nativeSearch"], descriptor):
            raise ProtocolError("Pipeline and native search descriptors differ")
        candidates = search.maximum_candidates
    else:
        if bundle.get("intent") not in {"calibrate", "negative_control"} or descriptor.get("format") != "autofold.static-construction.v1" or descriptor.get("semantics") != "native_object_v2" or descriptor.get("generatorCount") != 0 or descriptor.get("optimizerCount") != len(descriptor.get("nativeProjection", {}).get("projection", [])) or descriptor.get("proposalSources") != ["existing_results"] * descriptor.get("optimizerCount", 0):
            raise ProtocolError("Invalid fresh native fixed control descriptor")
        fixed = descriptor.get("fixedSequences")
        if not isinstance(fixed, list) or not bundle.get("submissionSize", 0) <= len(fixed) <= bundle.get("candidateBudget", 0) or len(set(fixed)) != len(fixed) or any(not isinstance(s, str) or not re.fullmatch(r"[ACDEFGHIKLMNPQRSTVWY]+", s) for s in fixed):
            raise ProtocolError("Native fixed control must bind the exact canonical panel")
        projection = descriptor.get("nativeProjection")
        if not isinstance(projection, dict) or not _same_json(projection.get("budget", {}).get("outputs"), outputs) or projection.get("budget", {}).get("maximumWallSeconds") != resources["maximumSearchWallSeconds"]:
            raise ProtocolError("Native fixed construction projection and selectors differ")
        if pipeline.get("staticConstruction") is not None and not _same_json(pipeline["staticConstruction"], descriptor):
            raise ProtocolError("Pipeline and fixed control descriptors differ")
        candidates = len(fixed)
    expected = []
    if pipeline:
        if any(key in pipeline for key in ("sourceHash", "generation", "nativeSearch", "staticConstruction", "executionBudget")):
            raise ProtocolError("Fresh nativeExecution is the sole construction and resource authority")
        if pipeline.get("executionBackend") != "native_tool_sequence_v1" or pipeline.get("authoredDiagnostics"):
            raise ProtocolError("Fresh native execution cannot use routed legacy diagnostics")
        for stage in pipeline.get("stages", []):
            seconds = stage.get("budget", {}).get("maximumGpuSeconds")
            if type(seconds) not in {int, float} or not math.isfinite(seconds) or seconds <= 0:
                raise ProtocolError("Native scorer request reservation must be finite and positive")
            models = len(stage.get("models", []))
            requests = candidates * len(bundle["seeds"]) * models
            expected.append({"stageId": stage["id"], "maximumCandidates": candidates, "seedCount": len(bundle["seeds"]), "modelCount": models, "maximumRequests": requests, "perRequestTimeoutSeconds": seconds, "reservedWallSeconds": requests * seconds})
        if any(g.get("allocation") is not None for g in pipeline.get("generation", {}).get("generators", [])):
            raise ProtocolError("Fresh native execution cannot clamp legacy generator allocations")
    if not _same_json(resources.get("invocationReservations"), expected) or not _same_json(resources["reservedEvaluationWallSeconds"], sum(r["reservedWallSeconds"] for r in expected)):
        raise ProtocolError("Native invocation reservations do not match actual candidate/model/seed counts")


def validate_workflow_source(path: Path, bundle: dict[str, Any]) -> None:
    if bundle.get("nativeExecution") is not None:
        return
    from .compatibility.workflow_v1 import validate_workflow_source as historical_source
    historical_source(path, bundle)
