"""Trusted deterministic evidence adapter used only for integration tests."""

from __future__ import annotations

import hashlib
import json
import statistics
from pathlib import Path
from typing import Any

MODEL_VERSION = "fixture-1"
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


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _sequence_metrics(sequence: str) -> tuple[float, float, float]:
    length = len(sequence)
    hydrophobic = sum(residue in HYDROPHOBIC for residue in sequence) / length
    charge = abs(sequence.count("K") + sequence.count("R") - sequence.count("D") - sequence.count("E")) / length
    solubility = _clamp(1.0 - abs(hydrophobic - 0.35) * 1.5 - charge * 0.5)
    windows = [sum(residue in HYDROPHOBIC for residue in sequence[index : index + 5]) / 5 for index in range(max(1, length - 4))]
    aggregation = _clamp(max(windows) * 0.75 + max(0.0, hydrophobic - 0.45) * 0.5)
    longest_run = 1
    current_run = 1
    for index in range(1, length):
        current_run = current_run + 1 if sequence[index] == sequence[index - 1] else 1
        longest_run = max(longest_run, current_run)
    synthesis = _clamp(max(0, length - 30) / 100 + sequence.count("C") / length * 0.4 + longest_run / length * 0.2)
    return solubility, aggregation, synthesis


def _confidence(sequence: str, seed: int) -> tuple[float, float]:
    digest = hashlib.sha256(f"{sequence}:{seed}".encode("ascii")).digest()
    interface = 0.55 + digest[0] / 255 * 0.35
    fold = 0.60 + digest[1] / 255 * 0.30
    return interface, fold


def _agreement(values: list[tuple[float, float]]) -> float:
    if len(values) < 2:
        return 1.0
    return _clamp(1.0 - 2.0 * (statistics.pstdev(value[0] for value in values) + statistics.pstdev(value[1] for value in values)))


def enrich(bundle: dict[str, Any], candidate_set: dict[str, Any], output: Path) -> dict[str, Any]:
    if candidate_set.get("format") != "autofold.candidate-set.v1":
        raise ValueError("Evidence adapters require an unscored candidate-set.v1")
    adapter_hash = bundle["evidenceAdapter"]["sourceHash"]
    tools_commit = bundle["proto"]["toolsCommit"]
    parameters_hash = _sha256_text(_canonical({"adapter": "fixture", "version": MODEL_VERSION}))
    entries: list[dict[str, Any]] = []
    enriched: list[dict[str, Any]] = []

    for candidate in candidate_set["candidates"]:
        sequence = candidate["sequence"]
        candidate_key = hashlib.sha256(candidate["id"].encode("utf-8")).hexdigest()[:16]
        runs: list[tuple[dict[str, Any], str]] = []
        confidence: list[tuple[float, float]] = []
        for seed in bundle["seeds"]:
            interface, fold = _confidence(sequence, seed)
            confidence.append((interface, fold))
            directory = output / "model-runs" / candidate_key / str(seed)
            structure_content = f"data_fixture_{candidate_key}_{seed}\n#\n"
            structure_path = directory / "prediction.cif"
            structure_hash = _write(structure_path, structure_content)
            metrics = {"iptm": interface, "ptm": fold, "complex_plddt": fold, "confidence_score": (interface + fold) / 2}
            metrics_path = directory / "metrics.json"
            metrics_hash = _write_json(metrics_path, metrics)
            artifact = {
                "format": "autofold.model-run.v1",
                "candidateId": candidate["id"],
                "targetArtifactHash": bundle["targetArtifactHash"],
                "peptideSequenceHash": _sha256_text(sequence),
                "model": {
                    "id": "evidence-fixture",
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
            entry = {
                "candidateId": candidate["id"],
                "seed": seed,
                "artifactPath": str(artifact_path.relative_to(output)),
                "artifactHash": artifact_hash,
                "structurePath": str(structure_path.relative_to(output)),
                "structureHash": structure_hash,
                "metricsPath": str(metrics_path.relative_to(output)),
                "metricsHash": metrics_hash,
            }
            entries.append(entry)
            runs.append((artifact, artifact_hash))

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
