from __future__ import annotations

import hashlib
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import __version__


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def create(
    bundle: dict[str, Any],
    evaluator_hash: str,
    started_at: str,
    completed_at: str,
    files: dict[str, Path],
    evidence_adapter_hash: str | None = None,
) -> dict[str, Any]:
    manifest = {
        "format": "autofold.run-manifest.v1",
        "runId": bundle["runId"],
        "trialId": bundle["trialId"],
        "workerVersion": __version__,
        "pythonVersion": platform.python_version(),
        "evaluatorHash": evaluator_hash,
        "designAdapter": bundle["designAdapter"],
        "programHash": bundle["programHash"],
        "startedAt": started_at,
        "completedAt": completed_at,
        "files": {label: sha256(path) for label, path in sorted(files.items())},
    }
    if evidence_adapter_hash is not None:
        manifest["evidenceAdapterHash"] = evidence_adapter_hash
    return manifest
