from __future__ import annotations

import hashlib
import importlib.util
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

from ..protocol import ProtocolError
from ..generation import capture
from ..generator_diagnostics import GeneratorDiagnosticsCapture
from ..proto_portfolio import ProtoPortfolioProgram
from ..proto_trial import ProtoTrial, load_authored_trial

AMINO_ACIDS = set("ACDEFGHIKLMNPQRSTVWY")
SCIENTIFIC_EVALUATOR = ("peptide-panel", "1")


def _commit(path: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=path,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ProtocolError(f"Cannot verify pinned Proto repository at {path}") from error
    return completed.stdout.strip()


def _load_program(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("autofold_trial_program", path)
    if spec is None or spec.loader is None:
        raise ProtocolError(f"Cannot load trial program from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _normalize(raw: Any, bundle: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, list):
        raw = list(raw)
    candidates: list[dict[str, Any]] = []
    seeds: list[int] = bundle["seeds"]
    for index, item in enumerate(raw[: bundle["candidateBudget"]]):
        sequence = item.get("sequence") if isinstance(item, dict) else item
        if not isinstance(sequence, str) or not sequence or not set(sequence).issubset(AMINO_ACIDS):
            raise ProtocolError("Proto trial returned a non-canonical protein sequence")
        identifier = hashlib.sha256(sequence.encode("ascii")).hexdigest()[:16]
        candidate = {
            "id": item.get("id", f"pep_{identifier}") if isinstance(item, dict) else f"pep_{identifier}",
            "sequence": sequence,
            "seed": item.get("seed", seeds[index % len(seeds)]) if isinstance(item, dict) else seeds[index % len(seeds)],
        }
        evaluator = bundle["evaluator"]
        scientific = (evaluator["id"], evaluator["version"]) == SCIENTIFIC_EVALUATOR
        trusted_evidence = bundle["format"] in {"autofold.trial-bundle.v3", "autofold.trial-bundle.v4"}
        if scientific and trusted_evidence:
            if isinstance(item, dict) and ("generation" in item or "evidence" in item):
                raise ProtocolError("Trial programs may not provide trusted generation or evaluator evidence")
        elif scientific:
            if not isinstance(item, dict) or not isinstance(item.get("generation"), dict) or not isinstance(item.get("evidence"), dict):
                raise ProtocolError("Peptide panel v1 requires generation and evidence for every candidate")
            candidate.update(
                {
                    "format": "autofold.peptide-candidate.v1",
                    "modality": item.get("modality", bundle["modality"]),
                    "generation": item["generation"],
                    "evidence": item["evidence"],
                }
            )
        candidates.append(candidate)
    scientific = (bundle["evaluator"]["id"], bundle["evaluator"]["version"]) == SCIENTIFIC_EVALUATOR
    trusted_evidence = bundle["format"] in {"autofold.trial-bundle.v3", "autofold.trial-bundle.v4"}
    return {
        "format": "autofold.candidate-set.v2" if scientific and not trusted_evidence else "autofold.candidate-set.v1",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        **({"targetArtifactHash": bundle["targetArtifactHash"]} if scientific and not trusted_evidence else {}),
        "candidates": candidates,
    }


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


def _descendant_pids(parent: int) -> list[int]:
    children_file = Path(f"/proc/{parent}/task/{parent}/children")
    try:
        children = [int(value) for value in children_file.read_text().split()]
    except (OSError, ValueError):
        return []
    descendants: list[int] = []
    for child in children:
        descendants.extend(_descendant_pids(child))
        descendants.append(child)
    return descendants


def _terminate_generator_children() -> None:
    own_group = os.getpgrp()
    killed_groups: set[int] = set()
    for pid in _descendant_pids(os.getpid()):
        try:
            group = os.getpgid(pid)
            if group != own_group and group not in killed_groups:
                os.killpg(group, signal.SIGTERM)
                killed_groups.add(group)
            elif group == own_group:
                os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue


def _run_with_hard_deadline(sample: Callable[[], None], key: str, seconds: int) -> None:
    if not hasattr(signal, "SIGALRM") or not hasattr(signal, "setitimer"):
        sample()
        return
    previous_handler = signal.getsignal(signal.SIGALRM)

    def expired(_signum: int, _frame: Any) -> None:
        _terminate_generator_children()
        raise ProtocolError(f"Proto generator {key} exceeded its frozen GPU-time allocation")

    signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, max(1, seconds))
    try:
        sample()
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous_handler)


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


class ProtoDesignAdapter:
    def generate(self, bundle: dict[str, Any], output: Path) -> dict[str, Any]:
        proto = bundle.get("proto")
        if not isinstance(proto, dict):
            raise ProtocolError("Proto adapter requires pinned Proto runtime metadata")
        # Checkout location is host-specific runtime configuration. Scientific
        # identity remains frozen by the two commits below.
        root = Path(os.environ.get("AUTOFOLD_PROTO_ROOT", proto["root"])).resolve()
        language_commit = _commit(root)
        tools_commit = _commit(root / "proto-tools")
        if language_commit != proto["languageCommit"]:
            raise ProtocolError(
                f"Proto language commit mismatch: expected {proto['languageCommit']}, received {language_commit}"
            )
        if tools_commit != proto["toolsCommit"]:
            raise ProtocolError(
                f"Proto tools commit mismatch: expected {proto['toolsCommit']}, received {tools_commit}"
            )
        sys.path.insert(0, str(root / "proto-tools"))
        sys.path.insert(0, str(root))

        module = _load_program(Path(bundle["programPath"]))
        try:
            trial = load_authored_trial(module, bundle)
        except (TypeError, ValueError) as error:
            raise ProtocolError(str(error)) from error
        program = trial.program
        _validate_diagnostic_plan(trial, bundle)
        _validate_composite_plan(program, bundle)
        _apply_trusted_generation_bounds(program, bundle)
        started = time.monotonic()
        generation = bundle.get("pipeline", {}).get("generation", {})
        diagnostic_generators = {
            item.get("id")
            for item in generation.get("generators", [])
            if isinstance(item, dict)
        }
        with GeneratorDiagnosticsCapture(output, enabled="freebindcraft" in diagnostic_generators) as diagnostics:
            program.run()
        program._autofold_generator_diagnostics = diagnostics.summary()
        wall_seconds = time.monotonic() - started

        # New-style trials expose candidates through the native Proto object
        # graph.  Legacy extraction hooks remain readable for frozen historical
        # programs, but are unnecessary for build_trial(ctx).
        extract = getattr(module, "extract_candidates", None)
        if callable(extract):
            raw = extract(program, bundle)
        else:
            raw = _native_candidates(program)
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
