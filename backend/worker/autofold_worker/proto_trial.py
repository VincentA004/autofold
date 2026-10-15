"""Agent-facing trial object for Autofold's persistent Proto scientist.

The scientist returns one :class:`ProtoTrial` from ``build_trial(ctx)``.  The
object contains the scientific declaration, the executable native Proto
program, and one explicit NativeSearch or NativeFixedControl. The frozen scoring pipeline is
never represented here; the trusted compiler appends it from the experiment
contract.

Absent-marker historical builders are isolated in the compatibility package.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import copy
import base64
import hashlib
from pathlib import Path
from types import ModuleType
from typing import Any, Literal, Mapping
from .native_search import NativeSearch, NativeOutput, NativeFixedControl


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

    @property
    def generation_seed(self) -> int:
        if "generationSeed" in self._bundle:
            return _generation_seed(self._bundle["generationSeed"])
        return self.seeds[0] if self.seeds else 0

    @classmethod
    def from_bundle(cls, bundle: Mapping[str, Any]) -> "TrialContext":
        seeds = tuple(int(seed) for seed in bundle.get("seeds", ()))
        if "generationSeed" in bundle:
            _generation_seed(bundle["generationSeed"])
        return cls(
            experiment_id=_optional_string(bundle.get("experimentId")),
            contract_hash=_optional_string(bundle.get("contractHash")),
            target_artifact_hash=_optional_string(bundle.get("targetArtifactHash")),
            target_artifact_path=_optional_path(bundle.get("targetArtifactPath")),
            target_structure_path=_optional_path(bundle.get("targetStructurePath")),
            modality=str(bundle.get("modality", "short_peptide")),
            seeds=seeds,
            candidate_budget=_positive_int(bundle.get("candidateBudget"), "candidateBudget"),
            submission_size=_positive_int(bundle.get("submissionSize"), "submissionSize"),
            intent=_intent(bundle.get("intent", "optimize")),
            _bundle=copy.deepcopy(dict(bundle)) if bundle.get("freshNative") is True or bundle.get("nativeExecution") is not None else dict(bundle),
        )

    def __getitem__(self, key: str) -> Any:
        return self._bundle[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self._bundle.get(key, default)

    def read_asset(self, asset_id: str) -> bytes:
        """Read exact host-frozen bundle bytes without copying them into trial source."""
        assets = self._bundle.get("frozenAssets", ())
        matches = [asset for asset in assets if asset.get("id") == asset_id]
        if len(matches) != 1:
            raise ValueError(f"Frozen asset identity is absent or ambiguous: {asset_id}")
        asset = matches[0]
        data = base64.b64decode(asset["contentBase64"], validate=True)
        if base64.b64encode(data).decode("ascii") != asset["contentBase64"] or "sha256:" + hashlib.sha256(data).hexdigest() != asset["contentHash"]:
            raise ValueError(f"Frozen asset bytes changed: {asset_id}")
        return data


@dataclass(frozen=True)
class DiagnosticStage:
    """Historical agent-authored, non-authoritative model stage.

    Diagnostic stages may route, ablate, or compare predictors, but can never
    contribute to the locked score. Fresh trials use native constraints instead.
    Tool implementations and runtime settings
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
    required_input_features: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.id or not self.id.replace("_", "").replace("-", "").isalnum():
            raise ValueError("Diagnostic stage id must be an alphanumeric slug")
        if not self.tools or any(not tool for tool in self.tools):
            raise ValueError(f"Diagnostic stage {self.id} requires at least one tool")
        if len(set(self.tools)) != len(self.tools):
            raise ValueError(f"Diagnostic stage {self.id} tools must be unique")
        from autofold_worker.proto_model_registry import FEATURES
        if len(set(self.required_input_features)) != len(self.required_input_features) or any(item not in FEATURES for item in self.required_input_features):
            raise ValueError("required_input_features must contain unique supported feature names")
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
            **({"inputRequirements": {"features": list(self.required_input_features)}} if self.required_input_features else {}),
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
    decision_plan: Mapping[str, Any] | None = None
    prediction: Mapping[str, Any] | None = None
    evidence_refs: tuple[str, ...] = ()
    search: NativeSearch | None = None
    fixed_control: NativeFixedControl | None = None

    def __post_init__(self) -> None:
        if not callable(getattr(self.program, "run", None)):
            raise TypeError("ProtoTrial.program must expose run()")
        if not isinstance(self.hypothesis, str) or not self.hypothesis.strip():
            raise ValueError("ProtoTrial requires a non-empty falsifiable hypothesis")
        if self.search is not None and not isinstance(self.search, NativeSearch):
            raise TypeError("ProtoTrial.search must be NativeSearch")
        if self.fixed_control is not None and not isinstance(self.fixed_control, NativeFixedControl):
            raise TypeError("ProtoTrial.fixed_control must be NativeFixedControl")
        if self.search is not None and self.fixed_control is not None:
            raise ValueError("A native trial declares one execution protocol")
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
            **({"decisionPlan": dict(self.decision_plan)} if self.decision_plan is not None else {}),
            **({"evidenceRefs": list(self.evidence_refs)} if self.evidence_refs else {}),
            **({"prediction": dict(self.prediction)} if self.prediction is not None else {}),
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

    fresh = bundle.get("freshNative") is True or bundle.get("nativeExecution") is not None
    if fresh:
        for name in ("AUTOFOLD_WORKFLOW", "AUTOFOLD_TRIAL", "build_program", "extract_candidates"):
            if hasattr(module, name):
                raise TypeError("Fresh native trials cannot declare legacy " + name)
    build_trial = getattr(module, "build_trial", None)
    if callable(build_trial):
        trial = build_trial(TrialContext.from_bundle(bundle))
        if not isinstance(trial, ProtoTrial):
            raise TypeError("build_trial(ctx) must return autofold_worker.proto_trial.ProtoTrial")
        if fresh:
            from .program_inspection import assert_native_entrypoints
            assert_native_entrypoints(trial.program)
            if trial.diagnostics:
                raise ValueError("Fresh trials express diagnostic computation in native Proto constraints")
            if trial.search is None and trial.fixed_control is None:
                raise ValueError("Fresh native trials require NativeSearch or NativeFixedControl")
            if trial.fixed_control is not None and trial.intent not in {"calibrate", "negative_control"}:
                raise ValueError("NativeFixedControl requires calibrate or negative_control intent")
        return trial

    if fresh:
        raise TypeError("Fresh Proto trial.py must export build_trial(ctx)")

    from .compatibility.trial_v1 import load_legacy_trial
    return load_legacy_trial(module, bundle)


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


def _generation_seed(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 0xFFFFFFFF:
        raise ValueError("generationSeed must be an unsigned 32-bit integer")
    return value


__all__ = [
    "NativeSearch",
    "NativeOutput",
    "NativeFixedControl",
    "CalibrationClass",
    "DiagnosticStage",
    "ProtoTrial",
    "TrialContext",
    "TrialIntent",
    "load_authored_trial",
]
