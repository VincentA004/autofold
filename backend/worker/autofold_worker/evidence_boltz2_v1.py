"""Trusted Proto structure pipeline bridge with legacy Boltz v3 support."""

from __future__ import annotations

import hashlib
import json
import statistics
import time
from pathlib import Path
from typing import Any

MODEL_VERSION = "2.2.1"
HYDROPHOBIC = set("AILMFWVY")


def _sha256_bytes(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def _sha256_text(content: str) -> str:
    return _sha256_bytes(content.encode("utf-8"))


def _canonical(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def _write(path: Path, content: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return _sha256_text(content)


def _write_json(path: Path, value: Any) -> str:
    return _write(path, _canonical(value))


def _structure_cif(structure: Any) -> str:
    """Read CIF text across proto-tools Structure API revisions."""
    value = structure.structure_cif
    return value() if callable(value) else value


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _sequence_metrics(sequence: str) -> tuple[float, float, float]:
    length = len(sequence)
    hydrophobic = sum(residue in HYDROPHOBIC for residue in sequence) / length
    charge = abs(sequence.count("K") + sequence.count("R") - sequence.count("D") - sequence.count("E")) / length
    solubility = _clamp(1.0 - abs(hydrophobic - 0.35) * 1.5 - charge * 0.5)
    windows = [sum(residue in HYDROPHOBIC for residue in sequence[index : index + 5]) / 5 for index in range(max(1, length - 4))]
    aggregation = _clamp(max(windows) * 0.75 + max(0.0, hydrophobic - 0.45) * 0.5)
    synthesis = _clamp(max(0, length - 30) / 100 + sequence.count("C") / length * 0.4)
    return solubility, aggregation, synthesis


def _agreement(values: list[tuple[float, float]]) -> float:
    if len(values) < 2:
        return 1.0
    return _clamp(1.0 - 2.0 * (statistics.pstdev(value[0] for value in values) + statistics.pstdev(value[1] for value in values)))


def _metric_value(metric: str, metrics: list[dict[str, Any]]) -> float | None:
    if metric == "predictor_disagreement":
        if not metrics:
            return None
        values = [
            (float(item["protein_iptm"] if "protein_iptm" in item else item["iptm"]), float(item["complex_plddt"] if "complex_plddt" in item else item["ptm"]))
            for item in metrics
        ]
        return 1.0 - _agreement(values)
    values = [float(item[metric]) for item in metrics if metric in item]
    if metric == "confidence_score" and not values:
        values = [
            (
                float(item.get("protein_iptm", item.get("iptm", 0.0)))
                + float(item.get("complex_plddt", item.get("avg_plddt", item.get("ptm", 0.0))))
            )
            / 2
            for item in metrics
        ]
    return sum(values) / len(values) if values else None


def _condition_matches(condition: dict[str, Any], metrics: list[dict[str, Any]]) -> bool:
    actual = _metric_value(condition["metric"], metrics)
    if actual is None:
        return False
    expected = float(condition["value"])
    return {
        "lt": actual < expected,
        "lte": actual <= expected,
        "gt": actual > expected,
        "gte": actual >= expected,
    }[condition["operator"]]


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
    stage_runtime: dict[str, float] = {}
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

    for seed in bundle["seeds"]:
        for stage in bundle["pipeline"]["stages"]:
            selected = {candidate["id"] for candidate in candidates}
            routing = stage.get("candidateRouting")
            if routing:
                scored: list[tuple[float, str]] = []
                for candidate in candidates:
                    metrics = stage_metrics.get((candidate["id"], seed, routing["source"]), [])
                    value = _metric_value(routing["metric"], metrics)
                    if value is not None:
                        scored.append((value, candidate["id"]))
                reverse = routing["direction"] == "maximize"
                scored.sort(key=lambda item: ((-item[0]) if reverse else item[0], item[1]))
                selected = {candidate_id for _, candidate_id in scored[: routing["maximumCandidates"]]}

            for candidate in candidates:
                candidate_id = candidate["id"]
                sequence = candidate["sequence"]
                candidate_key = hashlib.sha256(candidate_id.encode("utf-8")).hexdigest()[:16]
                parents = [
                    artifact
                    for dependency in stage.get("dependsOn", [])
                    for artifact in stage_artifacts.get((candidate_id, seed, dependency), [])
                ]
                source_metrics = stage_metrics.get((candidate_id, seed, stage.get("condition", {}).get("source", "")), [])
                skip_kind = None
                skip_reason = ""
                if candidate_id not in selected:
                    skip_kind = "candidate_filtered"
                    skip_reason = "Candidate was outside the frozen stage ranking budget"
                elif stage.get("condition") and not _condition_matches(stage["condition"], source_metrics):
                    skip_kind = "condition_false"
                    skip_reason = "Frozen workflow condition evaluated false"
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
                        config_values["timeout"] = max(1, int(maximum_seconds))
                    config = spec.config_model(**config_values)
                    parameters["config"] = config.model_dump(mode="json")
                    parameters_hash = _sha256_text(_canonical(parameters))
                    inputs = spec.input_model(complexes=[target_sequences + [sequence]])
                    started = time.monotonic()
                    try:
                        prediction = spec.function(inputs, config)
                    except Exception as error:
                        if "optional_tool_failure" not in stage.get("allowedSkips", []):
                            raise
                        skip(candidate_id, stage, model, seed, parents, "optional_tool_failure", f"Optional Proto tool failed: {type(error).__name__}")
                        continue
                    wall_seconds = time.monotonic() - started
                    stage_runtime[stage["id"]] = stage_runtime.get(stage["id"], 0.0) + wall_seconds
                    maximum_seconds = stage.get("budget", {}).get("maximumGpuSeconds")
                    if maximum_seconds and stage_runtime[stage["id"]] > maximum_seconds:
                        raise RuntimeError(f"Frozen GPU budget exceeded for stage {stage['id']}")
                    if getattr(prediction, "success", True) is False or not prediction.structures:
                        if "optional_tool_failure" not in stage.get("allowedSkips", []):
                            raise RuntimeError(f"Required Proto tool failed: {parameters['tool']}")
                        skip(candidate_id, stage, model, seed, parents, "optional_tool_failure", "Optional Proto tool returned no structure")
                        continue
                    structure = prediction.structures[0]
                    metrics = structure.metrics.model_dump(mode="json")
                    interface = float(metrics.get("protein_iptm", metrics.get("iptm", metrics.get("confidence_score", 0.0))))
                    fold = float(metrics.get("complex_plddt", metrics.get("avg_plddt", metrics.get("ptm", interface))))
                    candidate_state[candidate_id]["confidence"].append((interface, fold))
                    native_stage_metrics.append(metrics)
                    directory = output / "model-runs" / candidate_key / stage["id"] / model["id"] / str(seed)
                    structure_path = directory / "prediction.cif"
                    structure_hash = _write(structure_path, _structure_cif(structure))
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
                        "runtime": {"wallSeconds": wall_seconds},
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
                "generation": {
                    "model": "proto-language",
                    "version": bundle["proto"]["languageCommit"],
                    "artifactHash": bundle["programHash"],
                    "parametersHash": bundle["programHash"],
                },
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
                "generation": {
                    "model": "proto-language",
                    "version": bundle["proto"]["languageCommit"],
                    "artifactHash": bundle["programHash"],
                    "parametersHash": bundle["programHash"],
                },
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
