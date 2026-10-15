from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

from .adapters import MockDesignAdapter, ProtoDesignAdapter
from .manifest import create, sha256, timestamp
from .protocol import ProtocolError, read_json, validate_bundle, validate_workflow_source, write_json


STAGE_STATE_FORMAT = "autofold.execution-stage.v1"


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Run an Autofold scientific trial bundle")
    value.add_argument("--bundle", required=True, type=Path)
    value.add_argument("--output", required=True, type=Path)
    value.add_argument("--evaluator-source", required=True, type=Path)
    value.add_argument("--evidence-adapter-source", type=Path)
    return value


def load_evaluator(source: Path) -> Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]:
    spec = importlib.util.spec_from_file_location("autofold_locked_evaluator", source)
    if spec is None or spec.loader is None:
        raise ProtocolError(f"Cannot load locked evaluator from {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    evaluate = getattr(module, "evaluate", None)
    if not callable(evaluate):
        raise ProtocolError("Locked evaluator must export evaluate(bundle, candidate_set)")
    return evaluate


def load_evidence_adapter(
    source: Path,
) -> Callable[[dict[str, Any], dict[str, Any], Path], dict[str, Any]]:
    spec = importlib.util.spec_from_file_location("autofold_trusted_evidence_adapter", source)
    if spec is None or spec.loader is None:
        raise ProtocolError(f"Cannot load trusted evidence adapter from {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    enrich = getattr(module, "enrich", None)
    if not callable(enrich):
        raise ProtocolError("Trusted evidence adapter must export enrich(bundle, candidate_set, output)")
    return enrich


def _stage_timeout(bundle: dict[str, Any], stage: str) -> int | None:
    """Return a conservative hard ceiling for an isolated scientific stage.

    Proto tools keep their frozen per-call GPU limits. This outer ceiling is a
    lifecycle backstop for deadlocked runtimes, not a reinterpretation of GPU
    time. Evidence may execute every model for every candidate and seed, so its
    ceiling includes that full declared upper bound plus cold-start allowance.
    """
    native = bundle.get("nativeExecution")
    if isinstance(native, dict):
        resources = native["resources"]
        return resources["maximumSearchWallSeconds"] if stage == "generation" else resources["reservedEvaluationWallSeconds"]
    pipeline = bundle.get("pipeline")
    if not isinstance(pipeline, dict):
        return None
    if stage == "generation":
        budget = pipeline.get("generation", {}).get("budget", {})
        maximum = budget.get("maximumGpuSeconds") if isinstance(budget, dict) else None
        return max(300, int(maximum) + 300) if isinstance(maximum, (int, float)) else None
    stages = pipeline.get("stages")
    if not isinstance(stages, list):
        return None
    per_candidate_seed = 0.0
    for item in stages:
        if not isinstance(item, dict):
            continue
        maximum = item.get("budget", {}).get("maximumGpuSeconds")
        models = item.get("models")
        if isinstance(maximum, (int, float)) and isinstance(models, list):
            per_candidate_seed += maximum * max(1, len(models))
    if per_candidate_seed <= 0:
        return None
    calls = max(1, int(bundle.get("candidateBudget", 1))) * max(1, len(bundle.get("seeds", [])))
    return max(600, int(per_candidate_seed * calls) + 600)


def _stage_state(output: Path, stage: str, status: str, **detail: Any) -> None:
    write_json(
        output / "execution-stage.json",
        {
            "format": STAGE_STATE_FORMAT,
            "stage": stage,
            "status": status,
            "updatedAt": timestamp(),
            **detail,
        },
    )


def _display_lock_stalled(stack_path: Path) -> bool:
    """Recognize the observed renderer deadlock, not generic slow GPU work.

    The stage's independent watchdog samples every 120 seconds. Require three
    complete consecutive samples blocked in the main-thread tqdm refresh path.
    """
    if not stack_path.is_file():
        return False
    with stack_path.open("rb") as stream:
        stream.seek(max(0, stack_path.stat().st_size - 65536))
        samples = stream.read().decode("utf-8", errors="replace").split("Timeout (0:02:00)!")[1:]
    if len(samples) < 3:
        return False
    def blocked(sample: str) -> bool:
        main = sample.rsplit("Thread ", 1)[-1]
        return all(text in main for text in (
            "tqdm/std.py", " in acquire", " in refresh", " in __iter__", " in run_chai1",
        ))
    return all(blocked(sample) for sample in samples[-3:])


def _terminate_stage(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        process.wait()


def _isolated_stage(
    stage: str,
    bundle: dict[str, Any],
    output: Path,
    runtime_bundle_path: Path,
    result_path: Path,
    *,
    candidate_set_path: Path | None = None,
    evidence_adapter_source: Path | None = None,
    aggregate_deadline: float | None = None,
) -> dict[str, Any]:
    stage_root = output / ".stages"
    stage_root.mkdir(parents=True, exist_ok=True)
    _stage_state(output, stage, "running", startedAt=timestamp())
    package_root = str(Path(__file__).resolve().parent.parent)
    environment = dict(os.environ)
    # Batch inference must never depend on terminal rendering or spinner locks.
    environment["PROTO_NO_SPINNER"] = "1"
    environment["TQDM_DISABLE"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["PYTHONPATH"] = os.pathsep.join(
        [package_root, environment["PYTHONPATH"]] if environment.get("PYTHONPATH") else [package_root]
    )
    command = [
        sys.executable,
        "-m",
        "autofold_worker.stage_runner",
        "--stage",
        stage,
        "--runtime-bundle",
        str(runtime_bundle_path),
        "--output",
        str(output),
        "--result",
        str(result_path),
    ]
    if candidate_set_path is not None:
        command.extend(["--candidate-set", str(candidate_set_path)])
    if evidence_adapter_source is not None:
        command.extend(["--evidence-adapter-source", str(evidence_adapter_source)])
    timeout = _stage_timeout(bundle, stage)
    if aggregate_deadline is not None:
        remaining = aggregate_deadline - time.monotonic()
        if remaining <= 0:
            message = "aggregate worker GPU allocation was exhausted before the next stage"
            _stage_state(output, stage, "timed_out", error=message)
            raise ProtocolError(message)
        aggregate_timeout = max(0.001, remaining)
        timeout = aggregate_timeout if timeout is None else min(timeout, aggregate_timeout)
    process = subprocess.Popen(command, env=environment, start_new_session=True)
    deadline = time.monotonic() + timeout if timeout is not None else None
    try:
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                code = process.wait(timeout=min(5.0, remaining) if remaining is not None else 5.0)
                break
            except subprocess.TimeoutExpired:
                if _display_lock_stalled(stage_root / f"{stage}-stack.log"):
                    _terminate_stage(process)
                    message = f"{stage} runtime stalled in terminal progress rendering (three consecutive stack samples)"
                    _stage_state(output, stage, "failed", error=message, errorType="ProgressRenderingStall")
                    raise ProtocolError(message)
    except subprocess.TimeoutExpired as error:
        _terminate_stage(process)
        message = f"{stage} stage exceeded its {timeout}-second lifecycle ceiling"
        _stage_state(output, stage, "timed_out", error=message)
        raise ProtocolError(message) from error
    if code != 0:
        failure_path = result_path.with_suffix(".error.json")
        failure = read_json(failure_path) if failure_path.is_file() else {}
        message = failure.get("error") or f"{stage} stage exited with code {code}"
        _stage_state(output, stage, "failed", error=message, errorType=failure.get("errorType"))
        raise ProtocolError(f"{stage} stage failed: {message}")
    result = read_json(result_path)
    _stage_state(output, stage, "completed", startedAt=read_json(output / "execution-stage.json").get("startedAt"))
    return result


def _worker_tree_hash(root: Path) -> str:
    files = sorted(
        [root / "run_worker.py", *(root / "autofold_worker").rglob("*.py")],
        key=lambda source: source.relative_to(root).as_posix(),
    )
    digest = hashlib.sha256()
    for source in files:
        relative = source.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def _validate_worker_tree(bundle: dict[str, Any]) -> None:
    identity = bundle.get("worker")
    if not isinstance(identity, dict):
        return
    root = Path(__file__).resolve().parent.parent
    observed = _worker_tree_hash(root)
    if observed != identity.get("sourceHash"):
        raise ProtocolError(
            f"Worker tree hash mismatch: expected {identity.get('sourceHash')}, received {observed}"
        )


def run(
    bundle_path: Path,
    output: Path,
    evaluator_source: Path,
    evidence_adapter_source: Path | None = None,
) -> None:
    started_at = timestamp()
    bundle = validate_bundle(read_json(bundle_path))
    _validate_worker_tree(bundle)
    # Bundle resources are portable: relative paths resolve beside bundle.json.
    # Keep the serialized bundle unchanged so its manifest hash is identical on
    # the authoring machine and a remote compute host.
    bundle_root = bundle_path.resolve().parent
    runtime_bundle = dict(bundle)
    for key in ("programPath", "targetArtifactPath", "targetStructurePath"):
        value = runtime_bundle.get(key)
        if isinstance(value, str) and not Path(value).is_absolute():
            resolved = (bundle_root / value).resolve()
            try:
                resolved.relative_to(bundle_root)
            except ValueError as error:
                raise ProtocolError(f"{key} escapes the portable bundle directory") from error
            runtime_bundle[key] = str(resolved)
    evaluator_hash = sha256(evaluator_source)
    expected_hash = bundle["evaluator"]["sourceHash"]
    if evaluator_hash != expected_hash:
        raise ProtocolError(f"Evaluator hash mismatch: expected {expected_hash}, received {evaluator_hash}")
    evaluate = load_evaluator(evaluator_source)
    program_path = Path(runtime_bundle["programPath"])
    program_hash = sha256(program_path)
    if program_hash != bundle["programHash"]:
        raise ProtocolError(f"Program hash mismatch: expected {bundle['programHash']}, received {program_hash}")
    validate_workflow_source(program_path, bundle)
    target_path = Path(runtime_bundle["targetArtifactPath"]) if runtime_bundle.get("targetArtifactPath") else None
    if target_path is not None:
        target_hash = sha256(target_path)
        if target_hash != bundle["targetArtifactHash"]:
            raise ProtocolError(
                f"Target artifact hash mismatch: expected {bundle['targetArtifactHash']}, received {target_hash}"
            )
    target_structure_path = (
        Path(runtime_bundle["targetStructurePath"]) if runtime_bundle.get("targetStructurePath") else None
    )
    if target_structure_path is not None:
        target_structure_hash = sha256(target_structure_path)
        target = read_json(target_path) if target_path is not None else {}
        expected_structure_hash = target.get("structure", {}).get("contentHash")
        if target_structure_hash != expected_structure_hash:
            raise ProtocolError(
                f"Target structure hash mismatch: expected {expected_structure_hash}, received {target_structure_hash}"
            )

    evidence_adapter_hash = None
    if bundle["format"] in {"autofold.trial-bundle.v3", "autofold.trial-bundle.v4"}:
        if evidence_adapter_source is None:
            raise ProtocolError("Trial bundle v3 requires a trusted evidence adapter source")
        evidence_adapter_hash = sha256(evidence_adapter_source)
        expected_adapter_hash = bundle["evidenceAdapter"]["sourceHash"]
        if evidence_adapter_hash != expected_adapter_hash:
            raise ProtocolError(
                f"Evidence adapter hash mismatch: expected {expected_adapter_hash}, received {evidence_adapter_hash}"
            )

    output.mkdir(parents=True, exist_ok=True)
    candidates_path = output / "candidates.json"
    result_path = output / "result.json"
    manifest_path = output / "manifest.json"

    stage_root = output / ".stages"
    stage_root.mkdir(parents=True, exist_ok=True)
    runtime_bundle_path = stage_root / "runtime-bundle.json"
    write_json(runtime_bundle_path, runtime_bundle)
    aggregate = bundle.get("nativeExecution", {}).get("resources", {}).get("maximumWorkerWallSeconds") if bundle.get("nativeExecution") else bundle.get("pipeline", {}).get("executionBudget", {}).get("maximumGpuSeconds")
    aggregate_deadline = time.monotonic() + float(aggregate) if isinstance(aggregate, (int, float)) else None
    if bundle["designAdapter"] == "mock":
        candidate_set = MockDesignAdapter().generate(runtime_bundle, output)
    else:
        candidate_set = _isolated_stage(
            "generation",
            bundle,
            output,
            runtime_bundle_path,
            stage_root / "generation-result.json",
            aggregate_deadline=aggregate_deadline,
        )
    # Persist the generated portfolio before validation. A validator failure
    # must not erase the successful empirical generation trajectory.
    write_json(candidates_path, candidate_set)
    if evidence_adapter_hash is not None and evidence_adapter_source is not None:
        candidate_set = _isolated_stage(
            "evidence",
            bundle,
            output,
            runtime_bundle_path,
            stage_root / "evidence-result.json",
            candidate_set_path=candidates_path,
            evidence_adapter_source=evidence_adapter_source,
            aggregate_deadline=aggregate_deadline,
        )
    write_json(candidates_path, candidate_set)
    result = evaluate(runtime_bundle, candidate_set)
    if evidence_adapter_hash is not None:
        result["evidenceAdapterHash"] = evidence_adapter_hash
    write_json(result_path, result)
    files = {"bundle": bundle_path, "program": program_path, "candidates": candidates_path, "result": result_path}
    if target_path is not None:
        files["target"] = target_path
    if target_structure_path is not None:
        files["target_structure"] = target_structure_path
    generation_runs_path = output / "generation-runs" / "index.json"
    if bundle["designAdapter"] == "proto":
        if not generation_runs_path.is_file():
            raise ProtocolError("Proto design adapter did not produce generation-runs/index.json")
        files["generation_runs"] = generation_runs_path
    model_runs_path = output / "model-runs" / "index.json"
    if evidence_adapter_hash is not None:
        if not model_runs_path.is_file():
            raise ProtocolError("Trusted evidence adapter did not produce model-runs/index.json")
        files["model_runs"] = model_runs_path
    manifest = create(
        bundle,
        evaluator_hash,
        started_at,
        timestamp(),
        files,
        evidence_adapter_hash,
    )
    write_json(manifest_path, manifest)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        run(args.bundle, args.output, args.evaluator_source, args.evidence_adapter_source)
    except (OSError, ProtocolError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0
