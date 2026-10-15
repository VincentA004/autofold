"""Artifact/metric recording for current evidence execution; historical bridges stay frozen."""
from __future__ import annotations
import hashlib
import json
import statistics
from pathlib import Path
from typing import Any
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


def _generation(candidate: dict[str, Any], bundle: dict[str, Any]) -> dict[str, str]:
    observed = candidate.get("generation")
    if isinstance(observed, dict) and all(
        isinstance(observed.get(key), str) and observed[key]
        for key in ("model", "version", "artifactHash", "parametersHash")
    ):
        return observed
    return {
        "model": "proto-language",
        "version": bundle["proto"]["languageCommit"],
        "artifactHash": bundle["programHash"],
        "parametersHash": bundle["programHash"],
    }


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
