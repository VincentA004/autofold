"""Trusted Boltz-2 evidence adapter v1 for Autofold peptide panels."""

from __future__ import annotations

import hashlib
import json
import statistics
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


def enrich(bundle: dict[str, Any], candidate_set: dict[str, Any], output: Path) -> dict[str, Any]:
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
