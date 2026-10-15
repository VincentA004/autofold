from __future__ import annotations

import hashlib
import importlib.util
import json
import math
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
from ..proto_trial import ProtoTrial, load_authored_trial
from ..native_search import describe_native, NativeSearchObserver, capture_native

AMINO_ACIDS = set("ACDEFGHIKLMNPQRSTVWY")
SCIENTIFIC_EVALUATOR = ("peptide-panel", "1")


def _commit(path: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=path,
            check=True,
            capture_output=True,
            text=True, timeout=20,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ProtocolError(f"Cannot verify pinned Proto repository at {path}") from error
    package = "proto_tools" if path.name == "proto-tools" else "proto_language"
    try:
        subprocess.run(["git", "diff", "--quiet", "HEAD", "--", package], cwd=path, check=True, timeout=20)
        untracked = subprocess.run(["git", "ls-files", "--others", "--", package], cwd=path, check=True, capture_output=True, text=True, timeout=20)
        if any(name.endswith(".py") for name in untracked.stdout.splitlines()):
            raise ProtocolError("Untracked executable code in pinned Proto package at " + str(path))
    except (OSError, subprocess.SubprocessError) as error:
        raise ProtocolError("Executing Proto package bytes differ from its pinned commit at " + str(path)) from error
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


def _run_with_hard_deadline(sample: Callable[[], None], key: str, seconds: int, *, legacy_gpu_allocation=False) -> None:
    if not hasattr(signal, "SIGALRM") or not callable(getattr(signal, "setitimer", None)):
        if legacy_gpu_allocation:
            sample()
            return
        raise ProtocolError("Native execution requires a supported hard process timer")
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds <= 0:
        raise ProtocolError("Native execution requires a finite remaining wall-time deadline")
    previous_handler = signal.getsignal(signal.SIGALRM)

    def expired(_signum: int, _frame: Any) -> None:
        _terminate_generator_children()
        message = f"Proto generator {key} exceeded its frozen GPU-time allocation" if legacy_gpu_allocation else f"Proto execution {key} exceeded its frozen wall-time deadline"
        if legacy_gpu_allocation:
            raise ProtocolError(message)
        from ..native_search import NativeExecutionStopped
        raise NativeExecutionStopped(message)

    signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, max(1, seconds) if legacy_gpu_allocation else seconds)
    started = time.monotonic()
    try:
        sample()
    finally:
        restore = previous_timer if legacy_gpu_allocation or previous_timer[0] == 0 else (max(1e-9, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])
        signal.setitimer(signal.ITIMER_REAL, *restore)
        signal.signal(signal.SIGALRM, previous_handler)



class ProtoDesignAdapter:
    def generate(self, bundle: dict[str, Any], output: Path) -> dict[str, Any]:
        if bundle.get("nativeExecution") is None:
            raise ProtocolError("Fresh Proto execution requires nativeExecution; original requests use their frozen worker")
        root = _prepare_runtime(bundle)
        return _generate_fresh(bundle, output, root)


def _prepare_runtime(bundle):
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

    return root


def _generate_fresh(bundle, output, root):
    """Execute one admitted native program; copy every result before scope exit."""
    from types import SimpleNamespace
    from ..native_search import NativeOutput, NativeSearch
    from ..program_inspection import pin_native_entrypoints, describe_fixed
    from ..protocol import validate_native_execution
    from ..cli import _validate_worker_tree
    validate_native_execution(bundle)
    _validate_worker_tree(bundle)
    pin_native_entrypoints()
    for name, expected in (("proto_language", root / "proto_language"), ("proto_tools", root / "proto-tools" / "proto_tools")):
        imported = __import__(name)
        if Path(imported.__file__).resolve().parent != expected.resolve():
            raise ProtocolError("Native execution imported an unbound package origin: " + name)
    from ..native_lifecycle import native_api
    native_api(root)
    authority = bundle["nativeExecution"]
    started = time.monotonic()
    limit = authority["resources"]["maximumSearchWallSeconds"]
    constructed = []
    def construct():
        with NativeSearchObserver(SimpleNamespace(optimizers=[]), NativeSearch(1,1,1,1,int(limit),(NativeOutput("construction"),)), output, forbid_work=True, fail_closed=True, forbid_run=True) as guard:
            module = _load_program(Path(bundle["programPath"]))
            trial = load_authored_trial(module, bundle)
            if authority["protocol"] == "native_search_v1":
                if trial.search is None:
                    raise ProtocolError("Reconstructed native execution protocol differs")
                observed = describe_native(trial.program, trial.search, bundle)
                search = trial.search
            else:
                if trial.fixed_control is None:
                    raise ProtocolError("Reconstructed native execution protocol differs")
                observed = describe_fixed(trial.program, trial.fixed_control, bundle)
                search = trial.fixed_control.observer_budget(bundle["candidateBudget"])
            from ..protocol import _same_json
            if not _same_json(observed, authority["descriptor"]) or not _same_json([__import__("dataclasses").asdict(o) for o in search.outputs], authority["outputs"]):
                raise ProtocolError("Native program changed after launch admission")
            _validate_native_compute(bundle, observed, fixed=authority["protocol"] == "native_fixed_control_v1")
            guard.verify()
            constructed.append((trial, search))
    _run_with_hard_deadline(construct, "native construction wall deadline", limit)
    trial, search = constructed[0]
    program = trial.program
    fixed = authority["protocol"] == "native_fixed_control_v1"
    diagnostic_generators = {g["key"] for lane in (authority["descriptor"].get("nativeProjection") or authority["descriptor"])["projection"] for stage in lane["stages"] for g in stage["generators"]}
    results = []
    def execute_and_copy():
        with NativeSearchObserver(program, search, output, forbid_work=fixed, fail_closed=True,
                                  capture_seed_evidence="generationSeed" in bundle) as observer:
            with GeneratorDiagnosticsCapture(output, enabled="freebindcraft" in diagnostic_generators) as diagnostics:
                program.run()
            program._autofold_generator_diagnostics = diagnostics.summary()
            raw = capture_native(program, search, authority["descriptor"]["nativeProjection"] if fixed else authority["descriptor"], observer, bundle, output)
            if fixed and raw != authority["descriptor"]["fixedSequences"]:
                raise ProtocolError("Fixed Proto candidates changed during construction execution")
            result = capture(bundle, _normalize(raw, bundle), program, output, time.monotonic() - started)
            # Capture may call structure serializers or native metadata getters.
            # All of those execute under the same authority, before publication.
            result = json.loads(json.dumps(result, allow_nan=False))
            observer.verify()
            _refresh_native_receipt(output, observer, bundle, time.monotonic() - started)
            results.append(result)
    remaining = limit - (time.monotonic() - started)
    if remaining <= 0:
        raise ProtocolError("Native construction exhausted its search wall authority")
    _run_with_hard_deadline(execute_and_copy, "native execution wall deadline", remaining)
    return results[0]


def _validate_native_compute(bundle, admitted, *, fixed):
    """Check reservations against pinned registry capabilities, without execution."""
    from proto_tools import ToolRegistry
    from proto_language.generator import GeneratorRegistry
    from ..protocol import _same_json
    resources = bundle["nativeExecution"]["resources"]
    native = admitted["nativeProjection"] if fixed else admitted
    generator_keys = {g["key"] for lane in native["projection"] for stage in lane["stages"] for g in stage["generators"]}
    uses_gpu = any(GeneratorRegistry.get(key).uses_gpu for key in generator_keys) or any(ToolRegistry.get(key).uses_gpu for key in native["budget"]["allowedTools"])
    search = resources["maximumSearchWallSeconds"] if uses_gpu and not fixed else 0
    candidates = len(admitted["fixedSequences"]) if fixed else native["budget"]["maximumCandidates"]
    evaluation = sum(candidates * len(bundle["seeds"]) * stage["budget"]["maximumGpuSeconds"] * sum(ToolRegistry.get(model.get("toolKey", model["id"])).uses_gpu for model in stage["models"]) for stage in bundle.get("pipeline", {}).get("stages", []))
    if not _same_json(resources["reservedSearchComputeSeconds"], search) or not _same_json(resources["reservedEvaluationComputeSeconds"], evaluation):
        raise ProtocolError("Native compute reservations differ from pinned registry capabilities")


def _refresh_native_receipt(output, observer, bundle, wall_seconds):
    """Publish pure receipt bytes after all native result getters have finished."""
    from ..protocol import write_json
    path = output / "native-search" / "receipt.json"
    receipt = json.loads(path.read_text())
    receipt.update(counts=observer.counts, calls=observer.calls, samplings=observer.samplings, wallSeconds=wall_seconds)
    write_json(path, receipt)
    reference = {"path": "native-search/receipt.json", "hash": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}
    index_path = output / "generation-runs" / "index.json"
    index = json.loads(index_path.read_text())
    index["nativeSearch"] = reference
    write_json(index_path, index)

