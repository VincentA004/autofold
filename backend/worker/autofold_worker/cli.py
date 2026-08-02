from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from typing import Any, Callable

from .adapters import MockDesignAdapter, ProtoDesignAdapter
from .manifest import create, sha256, timestamp
from .protocol import ProtocolError, read_json, validate_bundle, write_json


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Run an Autofold scientific trial bundle")
    value.add_argument("--bundle", required=True, type=Path)
    value.add_argument("--output", required=True, type=Path)
    value.add_argument("--evaluator-source", required=True, type=Path)
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


def run(bundle_path: Path, output: Path, evaluator_source: Path) -> None:
    started_at = timestamp()
    bundle = validate_bundle(read_json(bundle_path))
    evaluator_hash = sha256(evaluator_source)
    expected_hash = bundle["evaluator"]["sourceHash"]
    if evaluator_hash != expected_hash:
        raise ProtocolError(f"Evaluator hash mismatch: expected {expected_hash}, received {evaluator_hash}")
    evaluate = load_evaluator(evaluator_source)
    program_path = Path(bundle["programPath"])
    program_hash = sha256(program_path)
    if program_hash != bundle["programHash"]:
        raise ProtocolError(f"Program hash mismatch: expected {bundle['programHash']}, received {program_hash}")
    target_path = Path(bundle["targetArtifactPath"]) if bundle.get("targetArtifactPath") else None
    if target_path is not None:
        target_hash = sha256(target_path)
        if target_hash != bundle["targetArtifactHash"]:
            raise ProtocolError(
                f"Target artifact hash mismatch: expected {bundle['targetArtifactHash']}, received {target_hash}"
            )

    output.mkdir(parents=True, exist_ok=True)
    candidates_path = output / "candidates.json"
    result_path = output / "result.json"
    manifest_path = output / "manifest.json"

    adapter = MockDesignAdapter() if bundle["designAdapter"] == "mock" else ProtoDesignAdapter()
    candidate_set = adapter.generate(bundle)
    write_json(candidates_path, candidate_set)
    result = evaluate(bundle, candidate_set)
    write_json(result_path, result)
    files = {"bundle": bundle_path, "program": program_path, "candidates": candidates_path, "result": result_path}
    if target_path is not None:
        files["target"] = target_path
    manifest = create(
        bundle,
        evaluator_hash,
        started_at,
        timestamp(),
        files,
    )
    write_json(manifest_path, manifest)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        run(args.bundle, args.output, args.evaluator_source)
    except (OSError, ProtocolError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0
