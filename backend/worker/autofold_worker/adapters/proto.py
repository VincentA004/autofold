from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from ..protocol import ProtocolError

AMINO_ACIDS = set("ACDEFGHIKLMNPQRSTVWY")


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
        candidates.append(
            {
                "id": item.get("id", f"pep_{identifier}") if isinstance(item, dict) else f"pep_{identifier}",
                "sequence": sequence,
                "seed": item.get("seed", seeds[index % len(seeds)]) if isinstance(item, dict) else seeds[index % len(seeds)],
            }
        )
    return {
        "format": "autofold.candidate-set.v1",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        "candidates": candidates,
    }


class ProtoDesignAdapter:
    def generate(self, bundle: dict[str, Any]) -> dict[str, Any]:
        proto = bundle.get("proto")
        if not isinstance(proto, dict):
            raise ProtocolError("Proto adapter requires pinned Proto runtime metadata")
        root = Path(proto["root"]).resolve()
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
        build_program = getattr(module, "build_program", None)
        if not callable(build_program):
            raise ProtocolError("Proto trial.py must export build_program(bundle)")
        program = build_program(bundle)
        if not callable(getattr(program, "run", None)):
            raise ProtocolError("build_program(bundle) must return a Proto Program")
        program.run()

        extract = getattr(module, "extract_candidates", None)
        if callable(extract):
            raw = extract(program, bundle)
        else:
            raw = [
                sequence.sequence
                for construct in program.constructs
                for sequence in construct.joined_sequences
            ]
        return _normalize(raw, bundle)
