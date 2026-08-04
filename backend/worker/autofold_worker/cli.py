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


def run(
    bundle_path: Path,
    output: Path,
    evaluator_source: Path,
    evidence_adapter_source: Path | None = None,
) -> None:
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
    target_structure_path = Path(bundle["targetStructurePath"]) if bundle.get("targetStructurePath") else None
    if target_structure_path is not None:
        target_structure_hash = sha256(target_structure_path)
        target = read_json(target_path) if target_path is not None else {}
        expected_structure_hash = target.get("structure", {}).get("contentHash")
        if target_structure_hash != expected_structure_hash:
            raise ProtocolError(
                f"Target structure hash mismatch: expected {expected_structure_hash}, received {target_structure_hash}"
            )

    evidence_adapter_hash = None
    enrich = None
    if bundle["format"] == "autofold.trial-bundle.v3":
        if evidence_adapter_source is None:
            raise ProtocolError("Trial bundle v3 requires a trusted evidence adapter source")
        evidence_adapter_hash = sha256(evidence_adapter_source)
        expected_adapter_hash = bundle["evidenceAdapter"]["sourceHash"]
        if evidence_adapter_hash != expected_adapter_hash:
            raise ProtocolError(
                f"Evidence adapter hash mismatch: expected {expected_adapter_hash}, received {evidence_adapter_hash}"
            )
        enrich = load_evidence_adapter(evidence_adapter_source)

    output.mkdir(parents=True, exist_ok=True)
    candidates_path = output / "candidates.json"
    result_path = output / "result.json"
    manifest_path = output / "manifest.json"

    adapter = MockDesignAdapter() if bundle["designAdapter"] == "mock" else ProtoDesignAdapter()
    candidate_set = adapter.generate(bundle)
    if enrich is not None:
        candidate_set = enrich(bundle, candidate_set, output)
    write_json(candidates_path, candidate_set)
    result = evaluate(bundle, candidate_set)
    if evidence_adapter_hash is not None:
        result["evidenceAdapterHash"] = evidence_adapter_hash
    write_json(result_path, result)
    files = {"bundle": bundle_path, "program": program_path, "candidates": candidates_path, "result": result_path}
    if target_path is not None:
        files["target"] = target_path
    if target_structure_path is not None:
        files["target_structure"] = target_structure_path
    model_runs_path = output / "model-runs" / "index.json"
    if enrich is not None:
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
