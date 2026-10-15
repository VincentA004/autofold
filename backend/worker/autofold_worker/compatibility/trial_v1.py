"""Immutable historical builder adaptation, outside fresh native authoring."""
from __future__ import annotations

def load_legacy_trial(module, bundle):
    from ..proto_trial import ProtoTrial, _intent
    build_program = getattr(module, "build_program", None)
    if not callable(build_program):
        raise TypeError("Proto trial.py must export build_trial(ctx)")
    program = build_program(dict(bundle))
    declaration = getattr(module, "AUTOFOLD_TRIAL", {})
    if not isinstance(declaration, dict):
        raise TypeError("Legacy AUTOFOLD_TRIAL must be a dictionary")
    hypothesis = (getattr(module, "__doc__", None) or "Legacy Proto trial").strip()
    return ProtoTrial(
        program=program,
        hypothesis=hypothesis,
        intent=_intent(declaration.get("intent", bundle.get("intent", "optimize"))),
        calibration_class=declaration.get("calibrationClass"),
        replicate_of_trial_id=declaration.get("replicateOfTrialId"),
    )

