"""Locked Autofold peptide panel evaluator v1.

The evaluator consumes model-produced, artifact-backed evidence on a fixed
0..1 scale. Lower scores are better. It intentionally contains no model calls,
network access, trainable state, or agent-editable configuration.
"""

from __future__ import annotations

import math
from typing import Any

FORMAT = "autofold.candidate-set.v2"
METRICS = (
    "interfaceConfidence",
    "foldConfidence",
    "predictorAgreement",
    "solubility",
    "aggregationRisk",
    "synthesisRisk",
)
WEIGHTS = {
    "interfaceConfidence": 0.30,
    "foldConfidence": 0.20,
    "predictorAgreement": 0.15,
    "solubility": 0.15,
    "aggregationRisk": 0.10,
    "synthesisRisk": 0.10,
}
LENGTHS = {
    "linear_minibinder": (40, 120),
    "short_peptide": (5, 40),
    "cyclic_peptide": (5, 60),
    "modified_peptide": (5, 80),
}
AMINO_ACIDS = set("ACDEFGHIKLMNPQRSTVWY")


def _finite_unit(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0.0 <= value <= 1.0


def _digest(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 71 and value.startswith("sha256:") and all(
        character in "0123456789abcdef" for character in value[7:]
    )


def _valid_candidate(candidate: Any, modality: str) -> bool:
    if (
        not isinstance(candidate, dict)
        or candidate.get("format") != "autofold.peptide-candidate.v1"
        or candidate.get("modality") != modality
        or not isinstance(candidate.get("id"), str)
        or not candidate["id"]
        or not isinstance(candidate.get("seed"), int)
        or isinstance(candidate.get("seed"), bool)
    ):
        return False
    sequence = candidate.get("sequence")
    minimum, maximum = LENGTHS[modality]
    if not isinstance(sequence, str) or not minimum <= len(sequence) <= maximum or not set(sequence).issubset(AMINO_ACIDS):
        return False
    generation = candidate.get("generation")
    if not isinstance(generation, dict) or not all(
        isinstance(generation.get(key), str) and generation[key] for key in ("model", "version")
    ):
        return False
    if not _digest(generation.get("artifactHash")) or not _digest(generation.get("parametersHash")):
        return False
    evidence = candidate.get("evidence")
    if not isinstance(evidence, dict) or not all(_finite_unit(evidence.get(metric)) for metric in METRICS):
        return False
    predictors = evidence.get("predictors")
    return isinstance(predictors, list) and bool(predictors) and all(
        isinstance(predictor, dict)
        and isinstance(predictor.get("model"), str)
        and bool(predictor["model"])
        and isinstance(predictor.get("version"), str)
        and bool(predictor["version"])
        and _digest(predictor.get("artifactHash"))
        for predictor in predictors
    )


def _candidate_loss(candidate: dict[str, Any]) -> float:
    evidence = candidate["evidence"]
    return (
        WEIGHTS["interfaceConfidence"] * (1.0 - evidence["interfaceConfidence"])
        + WEIGHTS["foldConfidence"] * (1.0 - evidence["foldConfidence"])
        + WEIGHTS["predictorAgreement"] * (1.0 - evidence["predictorAgreement"])
        + WEIGHTS["solubility"] * (1.0 - evidence["solubility"])
        + WEIGHTS["aggregationRisk"] * evidence["aggregationRisk"]
        + WEIGHTS["synthesisRisk"] * evidence["synthesisRisk"]
    )


def _eligible(candidate: dict[str, Any]) -> bool:
    evidence = candidate["evidence"]
    return (
        evidence["interfaceConfidence"] >= 0.20
        and evidence["foldConfidence"] >= 0.20
        and evidence["solubility"] >= 0.15
        and evidence["aggregationRisk"] <= 0.85
        and evidence["synthesisRisk"] <= 0.85
    )


def _sequence_distance(left: str, right: str) -> float:
    width = max(len(left), len(right))
    if width == 0:
        return 0.0
    overlap = min(len(left), len(right))
    mismatches = sum(left[index] != right[index] for index in range(overlap)) + abs(len(left) - len(right))
    return mismatches / width


def _panel_diversity(candidates: list[dict[str, Any]]) -> float:
    if len(candidates) < 2:
        return 0.0
    distances = [
        _sequence_distance(left["sequence"], right["sequence"])
        for index, left in enumerate(candidates)
        for right in candidates[index + 1 :]
    ]
    return sum(distances) / len(distances)


def _invalid(bundle: dict[str, Any], candidate_count: int = 0) -> dict[str, Any]:
    return _result(
        bundle,
        False,
        None,
        {
            "candidate_count": float(candidate_count),
            "eligible_count": 0.0,
            "submission_count": 0.0,
            "yield_fraction": 0.0,
            "unique_fraction": 0.0,
            "panel_diversity": 0.0,
            "best_candidate_loss": 1.0,
            "mean_candidate_loss": 1.0,
        },
    )


def _result(bundle: dict[str, Any], valid: bool, score: float | None, diagnostics: dict[str, float]) -> dict[str, Any]:
    return {
        "format": "autofold.evaluation-result.v1",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        "contractHash": bundle["contractHash"],
        "evaluatorHash": bundle["evaluator"]["sourceHash"],
        "designAdapter": bundle["designAdapter"],
        "programHash": bundle["programHash"],
        "valid": valid,
        "score": score,
        "diagnostics": diagnostics,
    }


def evaluate(bundle: dict[str, Any], candidate_set: dict[str, Any]) -> dict[str, Any]:
    candidates = candidate_set.get("candidates", []) if isinstance(candidate_set, dict) else []
    if (
        not isinstance(candidate_set, dict)
        or candidate_set.get("format") != FORMAT
        or candidate_set.get("targetArtifactHash") != bundle["targetArtifactHash"]
        or not isinstance(candidates, list)
        or any(not _valid_candidate(candidate, bundle["modality"]) for candidate in candidates)
        or len({candidate["id"] for candidate in candidates}) != len(candidates)
    ):
        return _invalid(bundle, len(candidates) if isinstance(candidates, list) else 0)

    eligible = [candidate for candidate in candidates if _eligible(candidate)]
    ranked = sorted(eligible, key=lambda candidate: (_candidate_loss(candidate), candidate["id"]))
    selected = ranked[: bundle["submissionSize"]]
    if not selected:
        return _invalid(bundle, len(candidates))

    losses = [_candidate_loss(candidate) for candidate in selected]
    diversity = _panel_diversity(selected)
    unique_fraction = len({candidate["sequence"] for candidate in selected}) / len(selected)
    yield_fraction = len(selected) / bundle["submissionSize"]
    mean_loss = sum(losses) / len(losses)
    score = (
        0.75 * mean_loss
        + 0.10 * (1.0 - diversity)
        + 0.10 * (1.0 - yield_fraction)
        + 0.05 * (1.0 - unique_fraction)
    )
    return _result(
        bundle,
        True,
        score,
        {
            "candidate_count": float(len(candidates)),
            "eligible_count": float(len(eligible)),
            "submission_count": float(len(selected)),
            "yield_fraction": yield_fraction,
            "unique_fraction": unique_fraction,
            "panel_diversity": diversity,
            "best_candidate_loss": min(losses),
            "mean_candidate_loss": mean_loss,
        },
    )
