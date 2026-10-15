"""Conditional/routed frozen plans retained until native semantic parity is proven."""
from typing import Any, Callable, Iterator

def legacy_dag(bundle: dict[str, Any], candidates: list[dict[str, Any]],
               stage_metrics: dict[tuple[str, int, str], list[dict[str, Any]]],
               metric_value: Callable[..., Any], condition_matches: Callable[..., bool]) -> Iterator[tuple[Any, ...]]:
    for seed in bundle["seeds"]:
        for stage in bundle["pipeline"]["stages"]:
            selected = {candidate["id"] for candidate in candidates}
            routing = stage.get("candidateRouting")
            if routing:
                scored = []
                for candidate in candidates:
                    value = metric_value(routing["metric"], stage_metrics.get((candidate["id"], seed, routing["source"]), []))
                    if value is not None:
                        scored.append((value, candidate["id"]))
                reverse = routing["direction"] == "maximize"
                scored.sort(key=lambda item: ((-item[0]) if reverse else item[0], item[1]))
                selected = {candidate_id for _, candidate_id in scored[:routing["maximumCandidates"]]}
            for candidate in candidates:
                if candidate["id"] not in selected:
                    yield seed, stage, candidate, "candidate_filtered", "Candidate was outside the frozen stage ranking budget"
                elif stage.get("condition") and not condition_matches(stage["condition"], stage_metrics.get((candidate["id"], seed, stage["condition"]["source"]), [])):
                    yield seed, stage, candidate, "condition_false", "Frozen workflow condition evaluated false"
                else:
                    yield seed, stage, candidate, None, ""
