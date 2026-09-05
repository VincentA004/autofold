"""Agent-facing trial object for Autofold's persistent Proto scientist.

The scientist returns one :class:`ProtoTrial` from ``build_trial(ctx)``.  The
object contains the scientific declaration, the executable native Proto
program, and any mutable diagnostic stages.  The frozen scoring pipeline is
never represented here; the trusted compiler appends it from the experiment
contract.

Legacy ``build_program(bundle)`` trials remain loadable while campaigns migrate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any, Literal, Mapping


TrialIntent = Literal["optimize", "calibrate", "negative_control", "shadow_replay"]
CalibrationClass = Literal["known_positive", "known_negative", "neutral"]


@dataclass(frozen=True)
class TrialContext:
    """Small immutable view of the frozen execution bundle.

    Paths deliberately remain runtime paths.  Model executables, caches,
    devices, and credentials are not exposed; registered adapters own them.
    ``__getitem__`` is retained as a migration convenience for helpers that
    still consume bundle-style keys.
    """

    experiment_id: str | None
    contract_hash: str | None
    target_artifact_hash: str | None
    target_artifact_path: Path | None
    target_structure_path: Path | None
    modality: str
    seeds: tuple[int, ...]
    candidate_budget: int
    submission_size: int
    intent: TrialIntent
    _bundle: Mapping[str, Any] = field(repr=False, compare=False)

    @classmethod
    def from_bundle(cls, bundle: Mapping[str, Any]) -> "TrialContext":
        return cls(
            experiment_id=_optional_string(bundle.get("experimentId")),
            contract_hash=_optional_string(bundle.get("contractHash")),
            target_artifact_hash=_optional_string(bundle.get("targetArtifactHash")),
            target_artifact_path=_optional_path(bundle.get("targetArtifactPath")),
            target_structure_path=_optional_path(bundle.get("targetStructurePath")),
            modality=str(bundle.get("modality", "short_peptide")),
            seeds=tuple(int(seed) for seed in bundle.get("seeds", ())),
            candidate_budget=_positive_int(bundle.get("candidateBudget"), "candidateBudget"),
            submission_size=_positive_int(bundle.get("submissionSize"), "submissionSize"),
            intent=_intent(bundle.get("intent", "optimize")),
            _bundle=dict(bundle),
        )

    def __getitem__(self, key: str) -> Any:
        return self._bundle[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self._bundle.get(key, default)


@dataclass(frozen=True)
class DiagnosticStage:
    """One agent-authored, non-authoritative model stage.

    Diagnostic stages may route, ablate, or compare predictors, but can never
    contribute to the locked score.  Tool implementations and runtime settings
    are resolved through the pinned Proto registry.
    """

    id: str
    tools: tuple[str, ...]
    configs: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    depends_on: tuple[str, ...] = ()
    selection: Literal["all", "first_available"] = "all"
    condition: Mapping[str, Any] | None = None
    candidate_routing: Mapping[str, Any] | None = None
    maximum_candidates: int | None = None
    maximum_gpu_seconds: int | None = None
    optional: bool = True
    capability: str = "structure_prediction"

    def __post_init__(self) -> None:
        if not self.id or not self.id.replace("_", "").replace("-", "").isalnum():
            raise ValueError("Diagnostic stage id must be an alphanumeric slug")
        if not self.tools or any(not tool for tool in self.tools):
            raise ValueError(f"Diagnostic stage {self.id} requires at least one tool")
        if len(set(self.tools)) != len(self.tools):
            raise ValueError(f"Diagnostic stage {self.id} tools must be unique")
        for name, value in (
            ("maximum_candidates", self.maximum_candidates),
            ("maximum_gpu_seconds", self.maximum_gpu_seconds),
        ):
            if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value <= 0):
                raise ValueError(f"{name} must be a positive integer")

    def autofold_plan(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "role": "diagnostic",
            "capability": self.capability,
            "tools": list(self.tools),
            "configs": {key: dict(value) for key, value in self.configs.items()},
            "selection": self.selection,
            "dependsOn": list(self.depends_on),
            **({"condition": dict(self.condition)} if self.condition is not None else {}),
            **(
                {"candidateRouting": dict(self.candidate_routing)}
                if self.candidate_routing is not None
                else {}
            ),
            **({"maximumCandidates": self.maximum_candidates} if self.maximum_candidates is not None else {}),
            **({"maximumGpuSeconds": self.maximum_gpu_seconds} if self.maximum_gpu_seconds is not None else {}),
            "optional": self.optional,
        }


@dataclass(frozen=True)
class ProtoTrial:
    """The single value authored by an Autofold scientist iteration."""

    program: Any
    hypothesis: str
    intent: TrialIntent = "optimize"
    diagnostics: tuple[DiagnosticStage, ...] = ()
    calibration_class: CalibrationClass | None = None
    replicate_of_trial_id: str | None = None

    def __post_init__(self) -> None:
        if not callable(getattr(self.program, "run", None)):
            raise TypeError("ProtoTrial.program must expose run()")
        if not isinstance(self.hypothesis, str) or not self.hypothesis.strip():
            raise ValueError("ProtoTrial requires a non-empty falsifiable hypothesis")
        _intent(self.intent)
        if self.calibration_class is not None and self.calibration_class not in {
            "known_positive", "known_negative", "neutral",
        }:
            raise ValueError(f"Unsupported calibration class: {self.calibration_class}")
        if self.intent == "optimize" and self.calibration_class is not None:
            raise ValueError("Optimize trials cannot declare a calibration class")
        identifiers = [stage.id for stage in self.diagnostics]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("ProtoTrial diagnostic stage ids must be unique")

    def autofold_declaration(self) -> dict[str, Any]:
        return {
            "intent": self.intent,
            **({"calibrationClass": self.calibration_class} if self.calibration_class is not None else {}),
            **(
                {"replicateOfTrialId": self.replicate_of_trial_id}
                if self.replicate_of_trial_id is not None
                else {}
            ),
        }

    def autofold_diagnostic_plan(self) -> list[dict[str, Any]]:
        return [stage.autofold_plan() for stage in self.diagnostics]


def load_authored_trial(module: ModuleType, bundle: Mapping[str, Any]) -> ProtoTrial:
    """Construct a new-style trial or adapt a legacy module without executing it."""

    build_trial = getattr(module, "build_trial", None)
    if callable(build_trial):
        trial = build_trial(TrialContext.from_bundle(bundle))
        if not isinstance(trial, ProtoTrial):
            raise TypeError("build_trial(ctx) must return autofold_worker.proto_trial.ProtoTrial")
        return trial

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


def _positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _optional_path(value: Any) -> Path | None:
    return Path(value) if isinstance(value, str) and value else None


def _intent(value: Any) -> TrialIntent:
    if value not in {"optimize", "calibrate", "negative_control", "shadow_replay"}:
        raise ValueError(f"Unsupported trial intent: {value}")
    return value


__all__ = [
    "CalibrationClass",
    "DiagnosticStage",
    "ProtoTrial",
    "TrialContext",
    "TrialIntent",
    "load_authored_trial",
]
