"""Deterministic CPU fixture for the staged multi-model evidence contract."""

from __future__ import annotations

import hashlib
import json
import statistics
from pathlib import Path
from typing import Any

HYDROPHOBIC = set("AILMFWVY")


def _hash(content: str) -> str:
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


def _canonical(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def _write(path: Path, content: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return _hash(content)


def _write_json(path: Path, value: Any) -> str:
    return _write(path, _canonical(value))


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _confidence(sequence: str, model: str, seed: int) -> tuple[float, float]:
    digest = hashlib.sha256(f"{sequence}:{model}:{seed}".encode("ascii")).digest()
    return 0.45 + digest[0] / 255 * 0.45, 0.50 + digest[1] / 255 * 0.40


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


def enrich(bundle: dict[str, Any], candidate_set: dict[str, Any], output: Path) -> dict[str, Any]:
    if bundle.get("format") != "autofold.trial-bundle.v4":
        raise ValueError("Consensus fixture requires trial-bundle.v4")
    if candidate_set.get("format") != "autofold.candidate-set.v1":
        raise ValueError("Consensus evidence requires an unscored candidate-set.v1")
    adapter_hash = bundle["evidenceAdapter"]["sourceHash"]
    tools_commit = bundle["proto"]["toolsCommit"]
    entries: list[dict[str, Any]] = []
    enriched: list[dict[str, Any]] = []

    for candidate in candidate_set["candidates"]:
        sequence = candidate["sequence"]
        candidate_key = hashlib.sha256(candidate["id"].encode("utf-8")).hexdigest()[:16]
        predictors: list[dict[str, str]] = []
        confidence: list[tuple[float, float]] = []
        for seed in bundle["seeds"]:
            stage_artifacts: dict[str, list[str]] = {}
            for stage in bundle["pipeline"]["stages"]:
                parents = [artifact for dependency in stage.get("dependsOn", []) for artifact in stage_artifacts[dependency]]
                stage_hashes: list[str] = []
                for model in stage["models"]:
                    model_id = model["id"]
                    version = model["version"]
                    interface, fold = _confidence(sequence, model_id, seed)
                    confidence.append((interface, fold))
                    parameters = {"fixture": "consensus-v2", "stage": stage["id"], "model": model_id, "seed": seed}
                    parameters_hash = _hash(_canonical(parameters))
                    directory = output / "model-runs" / candidate_key / stage["id"] / model_id / str(seed)
                    structure_path = directory / "prediction.cif"
                    structure_hash = _write(structure_path, f"data_{candidate_key}_{stage['id']}_{model_id}_{seed}\n#\n")
                    metrics = {
                        "interface_confidence": interface,
                        "fold_confidence": fold,
                        "confidence_score": (interface + fold) / 2,
                    }
                    metrics_path = directory / "metrics.json"
                    metrics_hash = _write_json(metrics_path, metrics)
                    runtime = {
                        "wallSeconds": round(1.0 + interface, 6),
                        "gpuSeconds": round(0.5 + fold, 6),
                        "peakMemoryBytes": 1024 + int(interface * 1024),
                    }
                    artifact = {
                        "format": "autofold.model-run.v2",
                        "candidateId": candidate["id"],
                        "targetArtifactHash": bundle["targetArtifactHash"],
                        "peptideSequenceHash": _hash(sequence),
                        "stage": stage["id"],
                        "model": {
                            "id": model_id,
                            "version": version,
                            "adapterSourceHash": adapter_hash,
                            "protoToolsCommit": tools_commit,
                        },
                        "parametersHash": parameters_hash,
                        "seed": seed,
                        "parentArtifactHashes": parents,
                        "runtime": runtime,
                        "outputs": {"structureHash": structure_hash, "metricsHash": metrics_hash},
                        "metrics": metrics,
                    }
                    artifact_path = directory / "model-run.json"
                    artifact_hash = _write_json(artifact_path, artifact)
                    entries.append(
                        {
                            "status": "completed",
                            "candidateId": candidate["id"],
                            "stage": stage["id"],
                            "modelId": model_id,
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
                    predictors.append({"model": model_id, "version": version, "artifactHash": artifact_hash})
                stage_artifacts[stage["id"]] = stage_hashes

        solubility, aggregation, synthesis = _sequence_metrics(sequence)
        enriched.append(
            {
                "format": "autofold.peptide-candidate.v1",
                **candidate,
                "modality": bundle["modality"],
                "generation": candidate.get("generation", {
                    "model": "proto-language",
                    "version": bundle["proto"]["languageCommit"],
                    "artifactHash": bundle["programHash"],
                    "parametersHash": bundle["programHash"],
                }),
                "evidence": {
                    "interfaceConfidence": sum(value[0] for value in confidence) / len(confidence),
                    "foldConfidence": sum(value[1] for value in confidence) / len(confidence),
                    "predictorAgreement": _agreement(confidence),
                    "solubility": solubility,
                    "aggregationRisk": aggregation,
                    "synthesisRisk": synthesis,
                    "predictors": predictors,
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
