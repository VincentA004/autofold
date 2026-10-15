"""Invocation order only; native Proto owns model dispatch and execution.

The direct sequence path has no condition evaluator or candidate-routing DAG.
Ordered dependencies are retained solely as original artifact provenance.
Conditional historical plans retain their existing scheduler until equivalent
native composition has been demonstrated. Both paths share the same recorder.
"""
from __future__ import annotations
from typing import Any, Callable, Iterator


def validate_native_sequence(stages: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for stage in stages:
        if stage.get("condition") is not None or stage.get("candidateRouting") is not None:
            raise ValueError("Native Proto sequence cannot execute conditional or routed stages")
        if any(parent not in seen for parent in stage.get("dependsOn", [])):
            raise ValueError("Native Proto sequence requires dependencies in frozen execution order")
        if stage["id"] in seen:
            raise ValueError("Native Proto sequence stage identities must be unique")
        seen.add(stage["id"])


def native_sequence(bundle: dict[str, Any], candidates: list[dict[str, Any]]) -> Iterator[tuple[Any, ...]]:
    stages = bundle["pipeline"]["stages"]
    validate_native_sequence(stages)  # Whole plan checked before the first tool call.
    for seed in bundle["seeds"]:
        for stage in stages:
            for candidate in candidates:
                yield seed, stage, candidate, None, ""


from .compatibility.evidence_dag import legacy_dag
