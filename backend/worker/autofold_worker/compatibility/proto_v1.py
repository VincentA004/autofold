"""Historical generator allocations and routed diagnostics.

Only absent-marker immutable legacy bundles enter this compatibility adapter.
Fresh native programs retain their authored optimizer and generator settings.
"""
from __future__ import annotations
import time
from pathlib import Path
from typing import Any, Callable
from ..protocol import ProtocolError
from ..proto_trial import ProtoTrial
from ..proto_portfolio import ProtoPortfolioProgram

def _run_with_hard_deadline(*args):
    from ..adapters.proto import _run_with_hard_deadline as run
    return run(*args, legacy_gpu_allocation=True)

def _clamp_timeout(value: Any, cap: int) -> int:
    return cap if value is None else min(cap, max(1, int(value)))


def _set_generator_timeout(generator: Any, key: str, cap: int) -> None:
    """Apply a cooperative timeout to every supported GPU binder lane."""
    if key == "freebindcraft":
        design_config = getattr(generator, "design_config", None)
        if design_config is None or not callable(getattr(design_config, "model_copy", None)):
            raise ProtocolError("FreeBindCraft generator does not expose a mutable typed design_config")
        bounded = design_config.model_copy(
            update={"timeout": _clamp_timeout(getattr(design_config, "timeout", None), cap)}
        )
        generator.design_config = bounded
        config = getattr(generator, "config", None)
        if config is not None and callable(getattr(config, "model_copy", None)):
            generator.config = config.model_copy(update={"design_config": bounded})
        return

    if key == "rfdiffusion-mpnn-binder":
        config = getattr(generator, "config", None)
        if config is None or not callable(getattr(config, "model_copy", None)):
            raise ProtocolError("RFdiffusion/ProteinMPNN generator does not expose a mutable typed config")
        # RFdiffusion and inverse folding execute sequentially. Divide the
        # remaining lane budget so their request deadlines cannot each consume
        # the full frozen allocation.
        component_cap = max(1, cap // 2)
        updates: dict[str, Any] = {}
        for field in ("rfdiffusion3_config", "proteinmpnn_config", "ligandmpnn_config"):
            nested = getattr(config, field, None)
            if nested is None:
                continue
            if not callable(getattr(nested, "model_copy", None)):
                raise ProtocolError(f"RFdiffusion/ProteinMPNN {field} is not a mutable typed config")
            updates[field] = nested.model_copy(
                update={"timeout": _clamp_timeout(getattr(nested, "timeout", None), component_cap)}
            )
        if not updates:
            raise ProtocolError("RFdiffusion/ProteinMPNN generator exposes no bounded tool configs")
        generator.config = config.model_copy(update=updates)
        return

    if key in {"boltzgen-binder", "pxdesign-binder"}:
        # Worker-owned plugins consume this trusted value directly in
        # subprocess.run(timeout=...). It cannot be raised by trial.py.
        generator._autofold_timeout = cap


def _wrap_generator_allocation(generator: Any, key: str, allocation: dict[str, Any]) -> None:
    original: Callable[[], None] | None = getattr(generator, "_sample", None)
    if not callable(original):
        raise ProtocolError(f"Proto generator {key} does not expose the expected _sample hook")
    remaining_candidates = max(1, int(allocation["maximumCandidates"]))
    remaining_seconds = float(max(1, int(allocation["maximumGpuSeconds"])))

    def bounded_sample() -> None:
        nonlocal remaining_candidates, remaining_seconds
        if remaining_candidates <= 0:
            raise ProtocolError(f"Proto generator {key} exhausted its frozen candidate allocation")
        if remaining_seconds <= 0:
            raise ProtocolError(f"Proto generator {key} exhausted its frozen GPU-time allocation")
        segment = getattr(generator, "segment", None)
        proposals = getattr(segment, "proposal_sequences", None)
        if not isinstance(proposals, list):
            raise ProtocolError(f"Proto generator {key} has no assigned proposal pool")
        if len(proposals) > remaining_candidates:
            segment.proposal_sequences = proposals[:remaining_candidates]
        requested = len(segment.proposal_sequences)
        if requested <= 0:
            raise ProtocolError(f"Proto generator {key} requested no candidates")
        _set_generator_timeout(generator, key, max(1, int(remaining_seconds)))
        started = time.monotonic()
        try:
            _run_with_hard_deadline(original, key, max(1, int(remaining_seconds)))
        finally:
            remaining_seconds -= time.monotonic() - started
            remaining_candidates -= requested
        if remaining_seconds < 0:
            raise ProtocolError(f"Proto generator {key} exceeded its frozen GPU-time allocation")

    generator._sample = bounded_sample
    generator._autofold_generator_id = key


def _bound_optimizer_samples(optimizer: Any, candidate_cap: int) -> dict[str, int] | None:
    """Keep optimizer bookkeeping consistent with a frozen lane allocation.

    Clamping only the generator proposal list leaves RejectionSamplingOptimizer
    expecting its agent-authored batch size. Proto then indexes past the trusted
    one-candidate proposal pool after an otherwise successful generator call.
    Bound both layers so the runtime restriction is an executable configuration,
    not a post-hoc truncation.
    """
    if not hasattr(optimizer, "num_samples") or not hasattr(optimizer, "proposal_batch_size"):
        return None
    authored_samples = max(1, int(optimizer.num_samples))
    authored_batch = max(1, int(optimizer.proposal_batch_size))
    authored_results = getattr(optimizer, "num_results", None)
    num_samples = min(candidate_cap, authored_samples)
    proposal_batch_size = min(num_samples, authored_batch)
    optimizer.num_samples = num_samples
    optimizer.proposal_batch_size = proposal_batch_size
    if hasattr(optimizer, "num_steps"):
        optimizer.num_steps = num_samples
    num_results = getattr(optimizer, "num_results", None)
    if num_results is not None:
        optimizer.num_results = min(max(1, int(num_results)), num_samples)
    config = getattr(optimizer, "config", None)
    if config is not None and callable(getattr(config, "model_copy", None)):
        updates: dict[str, Any] = {
            "num_samples": num_samples,
            "proposal_batch_size": proposal_batch_size,
        }
        if getattr(optimizer, "num_results", None) is not None:
            updates["num_results"] = optimizer.num_results
        optimizer.config = config.model_copy(update=updates)
    return {
        "candidateCap": candidate_cap,
        "authoredSamples": authored_samples,
        "effectiveSamples": num_samples,
        "authoredProposalBatchSize": authored_batch,
        "effectiveProposalBatchSize": proposal_batch_size,
        **(
            {
                "authoredResults": max(1, int(authored_results)),
                "effectiveResults": max(1, int(optimizer.num_results)),
            }
            if authored_results is not None
            else {}
        ),
    }


def _apply_trusted_generation_bounds(program: Any, bundle: dict[str, Any]) -> None:
    """Enforce each frozen portfolio allocation before a generator executes."""
    generation = bundle.get("pipeline", {}).get("generation")
    if not isinstance(generation, dict):
        return
    declared = {
        item.get("id"): item.get("allocation") or generation.get("budget")
        for item in generation.get("generators", [])
        if isinstance(item, dict)
    }
    observed: set[str] = set()
    objects: set[int] = set()
    for optimizer in getattr(program, "optimizers", []):
        candidate_caps: list[int] = []
        for generator in getattr(optimizer, "generators", []):
            identity = id(generator)
            if identity in objects:
                raise ProtocolError("A Proto generator object cannot be reused across frozen portfolio lanes")
            objects.add(identity)
            spec = getattr(generator, "_spec", None)
            key = getattr(spec, "key", generator.__class__.__name__)
            allocation = declared.get(key)
            if not isinstance(allocation, dict):
                raise ProtocolError(f"Proto generator {key} has no frozen generation allocation")
            if key in observed:
                raise ProtocolError(f"Proto generator {key} is declared more than once in the executable program")
            observed.add(key)
            candidate_caps.append(max(1, int(allocation["maximumCandidates"])))
            # maximumCandidates limits returned scientific candidates, not a
            # generator's internal search breadth. In particular,
            # FreeBindCraft may need many rejected trajectories to produce one
            # accepted design. Its authored max_trajectories remains free under
            # the independently enforced lane GPU deadline and output cap.
            _wrap_generator_allocation(generator, key, allocation)
        if candidate_caps:
            sampling = _bound_optimizer_samples(optimizer, min(candidate_caps))
            for generator in getattr(optimizer, "generators", []):
                key = getattr(getattr(generator, "_spec", None), "key", generator.__class__.__name__)
                allocation = declared[key]
                generator._autofold_sampling = {
                    "generator": key,
                    "allocatedCandidates": max(1, int(allocation["maximumCandidates"])),
                    "maximumGpuSeconds": max(1, int(allocation["maximumGpuSeconds"])),
                    **(sampling or {}),
                }
    if observed != set(declared):
        missing = sorted(set(declared) - observed)
        raise ProtocolError(f"Frozen generation policy generators are absent from the Proto program: {missing}")


def _validate_composite_plan(program: Any, bundle: dict[str, Any]) -> None:
    """Bind a direct composite Program to the policy compiled before launch."""
    if not isinstance(program, ProtoPortfolioProgram):
        return
    try:
        authored = program.autofold_generation_plan()
    except (TypeError, ValueError) as error:
        raise ProtocolError(f"Invalid direct Proto portfolio: {error}") from error
    generation = bundle.get("pipeline", {}).get("generation")
    if not isinstance(generation, dict):
        raise ProtocolError("Direct Proto portfolio requires a compiled generation policy")
    frozen = {
        "generators": [item["id"] for item in generation.get("generators", [])],
        "allocations": [
            {
                "generator": item["id"],
                "maximumCandidates": item["allocation"]["maximumCandidates"],
                "maximumGpuSeconds": item["allocation"]["maximumGpuSeconds"],
            }
            for item in generation.get("generators", [])
        ],
        "maximumCandidates": generation.get("budget", {}).get("maximumCandidates"),
        "maximumGpuSeconds": generation.get("budget", {}).get("maximumGpuSeconds"),
    }
    if authored != frozen:
        raise ProtocolError("Direct Proto portfolio changed after its generation policy was compiled")


def _validate_diagnostic_plan(trial: ProtoTrial, bundle: dict[str, Any]) -> None:
    """Reassert the diagnostic graph derived during construction preflight.

    The TypeScript compiler stores the normalized authoring graph as trusted
    policy metadata.  It is not a second scientist-authored manifest; it is the
    compiled description against which the remote reconstruction is checked.
    """
    authored = trial.autofold_diagnostic_plan()
    frozen = bundle.get("pipeline", {}).get("authoredDiagnostics", [])
    if authored != frozen:
        raise ProtocolError("ProtoTrial diagnostic graph changed after its pipeline was compiled")



class HistoricalProtoDesignAdapter:
    """Compatibility fixtures only; original requests use their own frozen worker."""
    def generate(self, bundle, output):
        from ..adapters.proto import (_prepare_runtime, _load_program,
                                     _run_with_hard_deadline, _normalize)
        from ..generation import capture
        from ..generator_diagnostics import GeneratorDiagnosticsCapture
        from ..native_search import describe_native, capture_native
        from .native_monitor_v1 import NativeSearchObserver
        from ..proto_trial import load_authored_trial
        root = _prepare_runtime(bundle)
        module = _load_program(Path(bundle["programPath"]))
        try:
            trial = load_authored_trial(module, bundle)
        except (TypeError, ValueError) as error:
            raise ProtocolError(str(error)) from error
        program = trial.program
        _validate_diagnostic_plan(trial, bundle)
        if bundle.get("pipeline", {}).get("nativeSearch") is None:
            _validate_composite_plan(program, bundle)
        frozen_static_sequences = _validate_static_construction(program, bundle)
        native_policy = bundle.get("pipeline", {}).get("nativeSearch")
        if native_policy is not None:
            if trial.search is None or describe_native(program, trial.search, bundle) != native_policy:
                raise ProtocolError("Native program changed after launch admission")
            if callable(getattr(module, "extract_candidates", None)):
                raise ProtocolError("Native search uses explicit output selectors, not legacy extraction hooks")
        elif trial.search is not None:
            raise ProtocolError("Native search requires a frozen admission policy")
        else:
            _apply_trusted_generation_bounds(program, bundle)
        started = time.monotonic()
        generation = bundle.get("pipeline", {}).get("generation", {})
        diagnostic_generators = {
            item.get("id")
            for item in generation.get("generators", [])
            if isinstance(item, dict)
        }
        with GeneratorDiagnosticsCapture(output, enabled="freebindcraft" in diagnostic_generators) as diagnostics:
            if native_policy is not None:
                from functools import partial
                with NativeSearchObserver(program, trial.search, output) as observer:
                    _run_with_hard_deadline(partial(program.run), "native-search", trial.search.maximum_wall_seconds)
                    observer.verify()
                raw_native = capture_native(program, trial.search, native_policy, observer, bundle, output)
            else:
                program.run()
        program._autofold_generator_diagnostics = diagnostics.summary()
        wall_seconds = time.monotonic() - started

        # New-style trials expose candidates through the native Proto object
        # graph.  Legacy extraction hooks remain readable for frozen historical
        # programs, but are unnecessary for build_trial(ctx).
        extract = getattr(module, "extract_candidates", None)
        if native_policy is not None:
            raw = raw_native
        elif callable(extract):
            raw = extract(program, bundle)
        else:
            raw = _native_candidates(program)
        if frozen_static_sequences is not None and (
            len(raw) != len(frozen_static_sequences) or set(raw) != set(frozen_static_sequences)
        ):
            raise ProtocolError("Fixed Proto candidates changed during construction execution")
        return capture(bundle, _normalize(raw, bundle), program, output, wall_seconds)



def _native_candidates(program: Any) -> list[str]:
    """Harvest generated sequences without agent-authored extraction boilerplate."""
    candidates: list[str] = []
    seen: set[str] = set()
    for construct in getattr(program, "constructs", []):
        observed: list[Any] = []
        for segment in getattr(construct, "segments", []):
            observed.extend(getattr(segment, "result_sequences", []))
        observed.extend(getattr(construct, "joined_sequences", []))
        for item in observed:
            sequence = getattr(item, "sequence", item)
            if isinstance(sequence, str) and sequence and sequence not in seen:
                seen.add(sequence)
                candidates.append(sequence)
    return candidates



def _inspect_static_construction(program: Any, *, semantic: bool = False) -> dict[str, Any]:
    from ..program_inspection import inspect_static_construction
    return inspect_static_construction(program, semantic=semantic)


def _validate_static_construction(program: Any, bundle: dict[str, Any]) -> list[str] | None:
    frozen = bundle.get("pipeline", {}).get("staticConstruction")
    if frozen is None:
        return None
    observed = _inspect_static_construction(program, semantic=frozen.get("semantics") == "native_object_v2")
    if observed != frozen:
        raise ProtocolError("Fixed Proto construction changed after launch admission")
    return list(frozen["fixedSequences"])

