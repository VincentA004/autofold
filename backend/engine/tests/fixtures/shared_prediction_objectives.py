# Test-only native constraint adapter extracted from the pilot; no model execution in tests.
# Original source SHA256: 4ff4bbe0c412bd033296b40829c18d24370373a71b1af1163e77cf9eb936b1c1
"""Shared-prediction Boltz2 interface objectives for the native GA search.

Two scoring constraints read one trial-local prediction cache keyed by the
(target sequence, binder sequence) pair. The first objective evaluated on a
batch dispatches Boltz2 once for all uncached proposals; the second reads the
same metrics. This keeps a two-axis Pareto objective honest: ipTM and interface
pLDDT are two readings of *one* model call, not two independent measurements.

The module deliberately owns only the prediction cache and the raw-metric
extraction. Candidate proposal and survivor selection stay with the native
optimizer that consumes these ``ConstraintOutput`` records.
"""

from __future__ import annotations

import threading
from pathlib import Path

from prediction_capture import predict_captured
from typing import Any, Callable

from proto_language.core import ConstraintOutput, Sequence

_LOCK = threading.Lock()

# Trial-local measurement store keyed by (target_sequence, binder_sequence).
_CACHE: dict[tuple[str, str], dict[str, Any]] = {}

_CONFIG: dict[str, Any] = {
    "tool": "boltz2",
    "tool_config": None,
    "target_chain_id": "A",
    "binder_chain_id": "B",
    "predictor_seed": None,
}

_DISPATCHES: list[dict[str, Any]] = []


def configure(
    *,
    tool_config: Any,
    predictor_seed: int,
    capture_dir: Path,
    tool: str = "boltz2",
    target_chain_id: str = "A",
    binder_chain_id: str = "B",
) -> None:
    """Point the module at one explicit predictor configuration and clear state."""
    with _LOCK:
        _CACHE.clear()
        _DISPATCHES.clear()
        _CONFIG.update(
            {
                "capture_dir": Path(capture_dir),
                "tool": tool,
                "tool_config": tool_config,
                "target_chain_id": target_chain_id,
                "binder_chain_id": binder_chain_id,
                "predictor_seed": predictor_seed,
            }
        )


def report() -> dict[str, Any]:
    """Return the observed prediction accounting for this process."""
    with _LOCK:
        n_complexes = sum(int(d.get("n_complexes", 0)) for d in _DISPATCHES)
        return {
            "unique_prediction_calls": len(_DISPATCHES),
            "structure_prediction_requests": n_complexes,
            "cache_entries": len(_CACHE),
            "predictor_tool": _CONFIG["tool"],
            "predictor_seed": _CONFIG["predictor_seed"],
            "dispatches": [dict(d) for d in _DISPATCHES],
        }


def _records(input_sequences: list[tuple[Sequence, ...]]) -> list[dict[str, Any]]:
    """Return cached prediction records, dispatching Boltz2 for cache misses."""
    from proto_tools import Chain, Complex

    keys: list[tuple[str, str]] = [(target.sequence, binder.sequence) for (target, binder) in input_sequences]
    missing: list[tuple[str, str]] = list(dict.fromkeys(k for k in keys if k not in _CACHE))
    if missing:
        complexes = [
            Complex(
                chains=[
                    Chain(id=_CONFIG["target_chain_id"], sequence=target_seq, entity_type="protein"),
                    Chain(id=_CONFIG["binder_chain_id"], sequence=binder_seq, entity_type="protein"),
                ]
            )
            for (target_seq, binder_seq) in missing
        ]
        output, capture = predict_captured(
            complexes, _CONFIG["tool"], _CONFIG["tool_config"], capture_dir=_CONFIG["capture_dir"]
        )
        errors = [str(e) for e in (getattr(output, "errors", None) or [])]
        dispatch = {
            "capture_path": str(capture),
            "n_complexes": len(complexes),
            "binder_sequences": [binder for (_target, binder) in missing],
            "requested_chains": [_CONFIG["target_chain_id"], _CONFIG["binder_chain_id"]],
            "success": bool(getattr(output, "success", False)),
            "errors": errors,
            "execution_time": getattr(output, "execution_time", None),
            "predictor_seed": _CONFIG["predictor_seed"],
        }
        _DISPATCHES.append(dispatch)
        if not getattr(output, "success", False):
            raise RuntimeError(f"{_CONFIG['tool']} search prediction failed: {errors}")
        structures = list(output.structures)
        if len(structures) != len(missing):
            raise RuntimeError(f"expected {len(missing)} predicted structures, received {len(structures)}")
        for key, structure in zip(missing, structures):
            observed_chains = structure.get_chain_sequences()
            expected = {
                _CONFIG["target_chain_id"]: key[0],
                _CONFIG["binder_chain_id"]: key[1],
            }
            dispatch.setdefault("chain_checks", []).append(observed_chains == expected)
            if observed_chains != expected:
                raise RuntimeError(
                    "predicted chains differ from the requested target/binder mapping; "
                    f"observed={observed_chains} expected={expected}"
                )
            _CACHE[key] = {
                "capture_path": str(capture),
                "metrics": dict(structure.metrics.items()),
                "structure": structure,
                "structure_format": getattr(structure, "structure_format", None),
            }
        if not all(dispatch.get("chain_checks", [True])):
            raise RuntimeError("one or more predicted complexes changed chain identity")

    return [_CACHE[key] for key in keys]


def _objective(
    input_sequences: list[tuple[Sequence, ...]],
    metric_key: str,
    transform: Callable[[float], float],
) -> list[ConstraintOutput]:
    records = _records(input_sequences)
    results: list[ConstraintOutput] = []
    for record in records:
        metrics = record["metrics"]
        raw = metrics.get(metric_key)
        score = 1.0 if raw is None else transform(float(raw))
        score = max(0.0, min(1.0, score))
        results.append(
            ConstraintOutput(
                score=score,
                metadata={
                    "prediction_capture": record.get("capture_path"),
                    "objective_metric": metric_key,
                    "objective_direction": "lower_is_better",
                    f"raw_{metric_key}": raw,
                    "iptm": metrics.get("iptm"),
                    "complex_iplddt": metrics.get("complex_iplddt"),
                    "avg_pae": metrics.get("avg_pae"),
                    "ptm": metrics.get("ptm"),
                    "complex_plddt": metrics.get("complex_plddt"),
                    "structure_tool": _CONFIG["tool"],
                    "predictor_seed": _CONFIG["predictor_seed"],
                    "source": "shared_boltz2_prediction",
                },
                # Keep the predicted target/binder complex on the binder proposal so
                # the native artifacts retain the geometry each objective scored.
                structures=(None, record.get("structure")),
            )
        )
    return results


def iptm_loss(input_sequences: list[tuple[Sequence, ...]], config: Any) -> list[ConstraintOutput]:
    """Pareto axis 1: lower is better, ``1 - ipTM``."""
    return _objective(input_sequences, "iptm", lambda value: 1.0 - value)


def iplddt_loss(input_sequences: list[tuple[Sequence, ...]], config: Any) -> list[ConstraintOutput]:
    """Pareto axis 2: lower is better, ``1 - interface pLDDT`` (Boltz2 ``complex_iplddt``)."""
    return _objective(input_sequences, "complex_iplddt", lambda value: 1.0 - value)


for _function in (iptm_loss, iplddt_loss):
    _function._constraint_supported_sequence_types = ["protein"]
    _function._constraint_num_input_sequences_per_tuple = 2
