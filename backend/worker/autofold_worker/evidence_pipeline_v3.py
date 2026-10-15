"""Trusted Proto scoring/diagnostic pipeline bridge v3.

This version adds experiment-frozen scoring-stage isolation. Diagnostic stages
remain fully artifact-backed but cannot change the candidate evidence consumed
by the locked evaluator. The prior v2 source remains immutable in
evidence_boltz2_v1.py for historical contract verification.
"""

from __future__ import annotations

import hashlib
import json
import statistics
import time
from pathlib import Path
from typing import Any

MODEL_VERSION = "2.2.1"
from autofold_worker.evidence_recorder import _agreement, _canonical, _clamp, _condition_matches, _generation, _metric_value, _sequence_metrics, _sha256_bytes, _sha256_text, _structure_cif, _write, _write_json


def _capture_scoped_model(spec, inputs, config, directory, tool, seconds):
    """Bound original native call, cold hydration and native serialization."""
    from autofold_worker.native_lifecycle import RequestRecorder, measurement_scope
    from autofold_worker.adapters.proto import _run_with_hard_deadline
    observer = RequestRecorder(directory / "native-requests.json", root_tool=tool)
    started = time.monotonic()
    captured = []
    def call_and_copy():
        with measurement_scope(observer, seconds):
            prediction = spec.function(inputs, config)
            if getattr(prediction, "success", True) is False or not prediction.structures:
                raise RuntimeError("Required Proto tool returned no structure: " + tool)
            structure = prediction.structures[0]
            metrics = json.loads(json.dumps(structure.metrics.model_dump(mode="json"), allow_nan=False))
            cif = _structure_cif(structure)
            receipt = observer.receipt(tool)
            captured.append((metrics, cif, receipt))
    _run_with_hard_deadline(call_and_copy, "frozen evaluation " + tool, seconds)
    return (*captured[0], time.monotonic() - started)


def _enrich_v4(
    bundle: dict[str, Any],
    candidate_set: dict[str, Any],
    output: Path,
    ToolRegistry: Any,
) -> dict[str, Any]:
    target = json.loads(Path(bundle["targetArtifactPath"]).read_text(encoding="utf-8"))
    target_sequences = [chain["sequence"] for chain in target["chains"]]
    adapter_hash = bundle["evidenceAdapter"]["sourceHash"]
    tools_commit = bundle["proto"]["toolsCommit"]
    entries: list[dict[str, Any]] = []
    candidates = list(candidate_set["candidates"])
    candidate_state = {
        candidate["id"]: {"predictors": [], "confidence": []}
        for candidate in candidates
    }
    stage_artifacts: dict[tuple[str, int, str], list[str]] = {}
    stage_metrics: dict[tuple[str, int, str], list[dict[str, Any]]] = {}

    for stage in bundle["pipeline"]["stages"]:
        for model in stage["models"]:
            tool_key = model.get("toolKey", model["id"])
            spec = ToolRegistry.get(tool_key)
            from autofold_worker.proto_model_registry import assert_input_requirements
            assert_input_requirements(spec, stage.get("inputRequirements", {}).get("features", []))
            if spec.category != "structure_prediction":
                raise ValueError(f"Trusted structure workflow cannot execute Proto category {spec.category}")

    def skip(candidate_id: str, stage: dict[str, Any], model: dict[str, Any], seed: int, parents: list[str], kind: str, reason: str) -> None:
        if kind not in stage.get("allowedSkips", []):
            raise RuntimeError(f"Frozen workflow does not permit {kind} for stage {stage['id']}")
        entries.append(
            {
                "status": "skipped",
                "kind": kind,
                "candidateId": candidate_id,
                "stage": stage["id"],
                "modelId": model["id"],
                "seed": seed,
                "parentArtifactHashes": parents,
                "reason": reason,
            }
        )

    from autofold_worker.evidence_execution import native_sequence, legacy_dag
    execution_backend = bundle["pipeline"].get("executionBackend", "legacy_dag_v1")
    if execution_backend == "native_tool_sequence_v1":
        requests = native_sequence(bundle, candidates)
    elif execution_backend == "legacy_dag_v1":
        requests = legacy_dag(bundle, candidates, stage_metrics, _metric_value, _condition_matches)
    else:
        raise ValueError(f"Unknown trusted evidence execution backend: {execution_backend}")
    for seed, stage, candidate, skip_kind, skip_reason in requests:
        candidate_id = candidate["id"]
        sequence = candidate["sequence"]
        candidate_key = hashlib.sha256(candidate_id.encode("utf-8")).hexdigest()[:16]
        parents = [artifact for dependency in stage.get("dependsOn", [])
                   for artifact in stage_artifacts.get((candidate_id, seed, dependency), [])]
        stage_hashes: list[str] = []
        native_stage_metrics: list[dict[str, Any]] = []

        for model in stage["models"]:
            if skip_kind:
                skip(candidate_id, stage, model, seed, parents, skip_kind, skip_reason)
                continue
            parameters = {
                "tool": model.get("toolKey", model["id"]),
                "seed": seed,
            }
            spec = ToolRegistry.get(parameters["tool"])
            config_values: dict[str, Any] = dict(model.get("config", {}))
            if "seed" in spec.config_model.model_fields:
                config_values["seed"] = seed
            if "seeds" in spec.config_model.model_fields:
                config_values["seeds"] = [seed]
            maximum_seconds = stage.get("budget", {}).get("maximumGpuSeconds")
            if maximum_seconds and "timeout" in spec.config_model.model_fields:
                config_values["timeout"] = maximum_seconds if bundle.get("nativeExecution") else max(1, int(maximum_seconds))
            config = spec.config_model(**config_values)
            parameters["config"] = config.model_dump(mode="json")
            parameters_hash = _sha256_text(_canonical(parameters))
            inputs = spec.input_model(complexes=[target_sequences + [sequence]])
            directory = output / "model-runs" / candidate_key / stage["id"] / model["id"] / str(seed)
            request_observation = None
            try:
                if bundle.get("nativeExecution") is not None:
                    if bundle["nativeExecution"]["observation"] != "scoped_native_lifecycle_v1":
                        raise ValueError("Fresh frozen evaluation requires native scoped lifecycle authority")
                    reservations = [r for r in bundle["nativeExecution"]["resources"]["invocationReservations"] if r["stageId"] == stage["id"]]
                    if len(reservations) != 1 or reservations[0]["perRequestTimeoutSeconds"] != maximum_seconds:
                        raise ValueError("Frozen model request has no exact wall reservation")
                    metrics, cif, request_observation, wall_seconds = _capture_scoped_model(spec,inputs,config,directory,parameters["tool"],reservations[0]["perRequestTimeoutSeconds"])
                    from autofold_worker.native_search import digest
                    root_request = next(r for r in request_observation["entries"] if r["requestId"] == request_observation["rootRequestId"])
                    parameters_hash = digest({"tool": parameters["tool"], "seed": seed, "configHash": root_request["configHash"]})
                else:
                    started = time.monotonic()
                    prediction = spec.function(inputs, config)
                    wall_seconds = time.monotonic() - started
                    # Original frozen sources retain their native request-only timeout.
                    if getattr(prediction,"success",True) is False or not prediction.structures:
                        raise RuntimeError("Required Proto tool returned no structure: " + parameters["tool"])
                    structure = prediction.structures[0]
                    metrics = structure.metrics.model_dump(mode="json")
                    cif = _structure_cif(structure)
            except Exception as error:
                if "optional_tool_failure" not in stage.get("allowedSkips", []):
                    raise
                skip(candidate_id,stage,model,seed,parents,"optional_tool_failure",f"Optional Proto tool failed: {type(error).__name__}")
                continue
            interface = float(metrics.get("protein_iptm", metrics.get("iptm", metrics.get("confidence_score", 0.0))))
            fold = float(metrics.get("complex_plddt", metrics.get("avg_plddt", metrics.get("ptm", interface))))
            # Diagnostic stages remain fully artifact-backed and feed
            # recursive interpretation/routing, but they must never
            # alter the comparable locked objective. Only the exact
            # experiment-frozen scoring lane contributes evaluator
            # confidence or predictor provenance.
            if stage.get("role", "scoring") == "scoring":
                candidate_state[candidate_id]["confidence"].append((interface, fold))
            native_stage_metrics.append(metrics)
            directory = output / "model-runs" / candidate_key / stage["id"] / model["id"] / str(seed)
            structure_path = directory / "prediction.cif"
            structure_hash = _write(structure_path, cif)
            metrics_path = directory / "metrics.json"
            metrics_hash = _write_json(metrics_path, metrics)
            artifact = {
                "format": "autofold.model-run.v2",
                "candidateId": candidate_id,
                "targetArtifactHash": bundle["targetArtifactHash"],
                "peptideSequenceHash": _sha256_text(sequence),
                "stage": stage["id"],
                "model": {
                    "id": model["id"],
                    "version": model["version"],
                    "adapterSourceHash": adapter_hash,
                    "protoToolsCommit": tools_commit,
                },
                "parametersHash": parameters_hash,
                "seed": seed,
                "parentArtifactHashes": parents,
                "runtime": {"wallSeconds": wall_seconds, **({"requestObservation": request_observation} if request_observation is not None else {})},
                "outputs": {"structureHash": structure_hash, "metricsHash": metrics_hash},
                "metrics": metrics,
            }
            artifact_path = directory / "model-run.json"
            artifact_hash = _write_json(artifact_path, artifact)
            entries.append(
                {
                    "status": "completed",
                    "candidateId": candidate_id,
                    "stage": stage["id"],
                    "modelId": model["id"],
                    "seed": seed,
                    "parentArtifactHashes": parents,
                    "artifactPath": str(artifact_path.relative_to(output)),
                    "artifactHash": artifact_hash,
                    "structurePath": str(structure_path.relative_to(output)),
                    "structureHash": structure_hash,
                    "metricsPath": str(metrics_path.relative_to(output)),
                    "metricsHash": metrics_hash,
                }
            )
            stage_hashes.append(artifact_hash)
            if stage.get("role", "scoring") == "scoring":
                candidate_state[candidate_id]["predictors"].append({"model": model["id"], "version": model["version"], "artifactHash": artifact_hash})
        stage_artifacts[(candidate_id, seed, stage["id"])] = stage_hashes
        stage_metrics[(candidate_id, seed, stage["id"])] = native_stage_metrics

    enriched: list[dict[str, Any]] = []
    for candidate in candidates:
        sequence = candidate["sequence"]
        state = candidate_state[candidate["id"]]
        confidence = state["confidence"]
        if not confidence:
            raise ValueError(f"Workflow produced no completed model evidence for {candidate['id']}")
        solubility, aggregation, synthesis = _sequence_metrics(sequence)
        enriched.append(
            {
                "format": "autofold.peptide-candidate.v1",
                **candidate,
                "modality": bundle["modality"],
                "generation": _generation(candidate, bundle),
                "evidence": {
                    "interfaceConfidence": sum(value[0] for value in confidence) / len(confidence),
                    "foldConfidence": sum(value[1] for value in confidence) / len(confidence),
                    "predictorAgreement": _agreement(confidence),
                    "solubility": solubility,
                    "aggregationRisk": aggregation,
                    "synthesisRisk": synthesis,
                    "predictors": state["predictors"],
                },
            }
        )
    _write_json(
        output / "model-runs" / "index.json",
        {
            "format": "autofold.model-run-index.v2",
            "runId": bundle["runId"],
            "pipelineHash": bundle["pipelineHash"],
            "entries": entries,
        },
    )
    return {
        "format": "autofold.candidate-set.v2",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        "targetArtifactHash": bundle["targetArtifactHash"],
        "candidates": enriched,
    }


def enrich(bundle: dict[str, Any], candidate_set: dict[str, Any], output: Path) -> dict[str, Any]:
    if bundle.get("format") == "autofold.trial-bundle.v4":
        try:
            from proto_tools import ToolRegistry
        except ImportError as error:
            raise RuntimeError("Pinned proto-tools registry is unavailable") from error
        return _enrich_v4(bundle, candidate_set, output, ToolRegistry)

    try:
        from proto_tools.tools.structure_prediction.boltz2 import Boltz2Config, Boltz2Input, run_boltz2
    except ImportError as error:
        raise RuntimeError("Pinned proto-tools Boltz2 adapter is unavailable") from error

    if candidate_set.get("format") != "autofold.candidate-set.v1":
        raise ValueError("Boltz2 evidence requires an unscored candidate-set.v1")
    target = json.loads(Path(bundle["targetArtifactPath"]).read_text(encoding="utf-8"))
    target_sequences = [chain["sequence"] for chain in target["chains"]]
    adapter_hash = bundle["evidenceAdapter"]["sourceHash"]
    tools_commit = bundle["proto"]["toolsCommit"]
    parameters = {
        "model": "boltz",
        "version": MODEL_VERSION,
        "use_msa": False,
        "recycling_steps": 3,
        "sampling_steps": 200,
        "diffusion_samples": 1,
        "subsample_msa": False,
    }
    parameters_hash = _sha256_text(_canonical(parameters))
    entries: list[dict[str, Any]] = []
    enriched: list[dict[str, Any]] = []

    for candidate in candidate_set["candidates"]:
        sequence = candidate["sequence"]
        candidate_key = hashlib.sha256(candidate["id"].encode("utf-8")).hexdigest()[:16]
        runs: list[tuple[dict[str, Any], str]] = []
        confidence: list[tuple[float, float]] = []
        for seed in bundle["seeds"]:
            config = Boltz2Config(
                use_msa=False,
                recycling_steps=3,
                sampling_steps=200,
                diffusion_samples=1,
                subsample_msa=False,
                seed=seed,
                include_pae_matrix=False,
            )
            prediction = run_boltz2(Boltz2Input(complexes=[target_sequences + [sequence]]), config)
            structure = prediction.structures[0]
            metrics = structure.metrics.model_dump(mode="json")
            interface = float(metrics.get("protein_iptm", metrics["iptm"]))
            fold = float(metrics.get("complex_plddt", metrics["ptm"]))
            confidence.append((interface, fold))
            directory = output / "model-runs" / candidate_key / str(seed)
            structure_path = directory / "prediction.cif"
            structure_hash = _write(structure_path, _structure_cif(structure))
            metrics_path = directory / "metrics.json"
            metrics_hash = _write_json(metrics_path, metrics)
            artifact = {
                "format": "autofold.model-run.v1",
                "candidateId": candidate["id"],
                "targetArtifactHash": bundle["targetArtifactHash"],
                "peptideSequenceHash": _sha256_text(sequence),
                "model": {
                    "id": "boltz2",
                    "version": MODEL_VERSION,
                    "adapterSourceHash": adapter_hash,
                    "protoToolsCommit": tools_commit,
                },
                "parametersHash": parameters_hash,
                "seed": seed,
                "outputs": {"structureHash": structure_hash, "metricsHash": metrics_hash},
                "metrics": metrics,
            }
            artifact_path = directory / "model-run.json"
            artifact_hash = _write_json(artifact_path, artifact)
            entries.append(
                {
                    "candidateId": candidate["id"],
                    "seed": seed,
                    "artifactPath": str(artifact_path.relative_to(output)),
                    "artifactHash": artifact_hash,
                    "structurePath": str(structure_path.relative_to(output)),
                    "structureHash": structure_hash,
                    "metricsPath": str(metrics_path.relative_to(output)),
                    "metricsHash": metrics_hash,
                }
            )
            runs.append((artifact, artifact_hash))

        solubility, aggregation, synthesis = _sequence_metrics(sequence)
        enriched.append(
            {
                "format": "autofold.peptide-candidate.v1",
                **candidate,
                "modality": bundle["modality"],
                "generation": _generation(candidate, bundle),
                "evidence": {
                    "interfaceConfidence": sum(value[0] for value in confidence) / len(confidence),
                    "foldConfidence": sum(value[1] for value in confidence) / len(confidence),
                    "predictorAgreement": _agreement(confidence),
                    "solubility": solubility,
                    "aggregationRisk": aggregation,
                    "synthesisRisk": synthesis,
                    "predictors": [
                        {"model": run[0]["model"]["id"], "version": run[0]["model"]["version"], "artifactHash": run[1]}
                        for run in runs
                    ],
                },
            }
        )

    _write_json(output / "model-runs" / "index.json", {"format": "autofold.model-run-index.v1", "runId": bundle["runId"], "entries": entries})
    return {
        "format": "autofold.candidate-set.v2",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        "targetArtifactHash": bundle["targetArtifactHash"],
        "candidates": enriched,
    }
