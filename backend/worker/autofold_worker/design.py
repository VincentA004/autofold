from __future__ import annotations

import hashlib
from typing import Any

AMINO_ACIDS = "ACDEFGHIKLMNPQRSTVWY"
LENGTHS = {
    "linear_minibinder": 64,
    "short_peptide": 20,
    "cyclic_peptide": 24,
    "modified_peptide": 30,
}


def _sequence(key: bytes, length: int) -> str:
    output: list[str] = []
    counter = 0
    while len(output) < length:
        block = hashlib.sha256(key + counter.to_bytes(4, "big")).digest()
        output.extend(AMINO_ACIDS[byte % len(AMINO_ACIDS)] for byte in block)
        counter += 1
    return "".join(output[:length])


def generate(bundle: dict[str, Any]) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    seeds: list[int] = bundle["seeds"]
    length = LENGTHS[bundle["modality"]]
    program_hash = bundle["programHash"].encode("utf-8")
    for index in range(bundle["candidateBudget"]):
        seed = seeds[index % len(seeds)]
        key = program_hash + b":" + str(seed).encode("ascii") + b":" + str(index).encode("ascii")
        sequence = _sequence(key, length)
        identifier = hashlib.sha256(sequence.encode("ascii")).hexdigest()[:16]
        candidates.append({"id": f"pep_{identifier}", "sequence": sequence, "seed": seed})
    return {
        "format": "autofold.candidate-set.v1",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        "candidates": candidates,
    }

