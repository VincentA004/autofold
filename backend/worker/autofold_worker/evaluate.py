from __future__ import annotations

import math
from collections import Counter
from typing import Any

HYDROPHOBIC = set("AILMFWVY")
POSITIVE = set("KR")
NEGATIVE = set("DE")


def _candidate_score(sequence: str) -> float:
    length = len(sequence)
    counts = Counter(sequence)
    hydrophobic_fraction = sum(counts[aa] for aa in HYDROPHOBIC) / length
    net_charge = sum(counts[aa] for aa in POSITIVE) - sum(counts[aa] for aa in NEGATIVE)
    entropy = -sum((count / length) * math.log(count / length) for count in counts.values())
    normalized_entropy = entropy / math.log(20)
    return (
        abs(hydrophobic_fraction - 0.35) * 0.45
        + min(abs(net_charge) / max(length, 1), 1.0) * 0.25
        + (1.0 - normalized_entropy) * 0.30
    )


def evaluate(bundle: dict[str, Any], candidate_set: dict[str, Any]) -> dict[str, Any]:
    candidates = candidate_set.get("candidates", [])
    scores = sorted(_candidate_score(candidate["sequence"]) for candidate in candidates)
    submission_size = min(bundle["submissionSize"], len(scores))
    valid = submission_size > 0
    score = sum(scores[:submission_size]) / submission_size if valid else None
    unique = len({candidate["sequence"] for candidate in candidates})
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
        "diagnostics": {
            "candidate_count": float(len(candidates)),
            "submission_count": float(submission_size),
            "unique_fraction": unique / len(candidates) if candidates else 0.0,
            "best_candidate_score": scores[0] if scores else 1.0,
        },
    }
