from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FORMATS = {
    "bundles": {"autofold.trial-bundle.v1", "autofold.trial-bundle.v2", "autofold.trial-bundle.v3"},
    "candidates": "autofold.candidate-set.v1",
    "evaluation": "autofold.evaluation-result.v1",
    "manifest": "autofold.run-manifest.v1",
}


class ProtocolError(ValueError):
    pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProtocolError(f"Cannot read JSON from {path}: {error}") from error
    if not isinstance(value, dict):
        raise ProtocolError(f"Expected an object in {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def require_string(value: dict[str, Any], key: str, prefix: str | None = None) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ProtocolError(f"{key} must be a non-empty string")
    if prefix and not item.startswith(prefix):
        raise ProtocolError(f"{key} must start with {prefix}")
    return item


def validate_bundle(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("format") not in FORMATS["bundles"]:
        raise ProtocolError("Unsupported trial bundle format")
    require_string(value, "runId", "run_")
    require_string(value, "trialId", "trl_")
    require_string(value, "contractHash", "sha256:")
    if value["format"] in {"autofold.trial-bundle.v2", "autofold.trial-bundle.v3"}:
        require_string(value, "targetArtifactHash", "sha256:")
        if "targetArtifactPath" in value:
            require_string(value, "targetArtifactPath")
    if value["format"] == "autofold.trial-bundle.v3":
        if value.get("designAdapter") != "proto" or not isinstance(value.get("proto"), dict):
            raise ProtocolError("Scientific bundle v3 requires the pinned Proto runtime")
        require_string(value, "targetArtifactPath")
        if "targetStructurePath" in value:
            require_string(value, "targetStructurePath")
        adapter = value.get("evidenceAdapter")
        if not isinstance(adapter, dict):
            raise ProtocolError("Scientific bundle v3 requires an evidence adapter")
        require_string(adapter, "id")
        require_string(adapter, "version")
        require_string(adapter, "sourceHash", "sha256:")
    if value.get("designAdapter") not in {"mock", "proto"}:
        raise ProtocolError("Unsupported design adapter")
    require_string(value, "programPath")
    require_string(value, "programHash", "sha256:")
    if value.get("modality") not in {
        "linear_minibinder",
        "short_peptide",
        "cyclic_peptide",
        "modified_peptide",
    }:
        raise ProtocolError("Unsupported modality")
    evaluator = value.get("evaluator")
    if not isinstance(evaluator, dict):
        raise ProtocolError("evaluator must be an object")
    require_string(evaluator, "id")
    require_string(evaluator, "version")
    require_string(evaluator, "sourceHash", "sha256:")
    if evaluator.get("direction") not in {"minimize", "maximize"}:
        raise ProtocolError("Unsupported evaluator direction")
    if value["designAdapter"] == "proto":
        proto = value.get("proto")
        if not isinstance(proto, dict):
            raise ProtocolError("Proto adapter requires proto runtime metadata")
        require_string(proto, "root")
        require_string(proto, "languageCommit")
        require_string(proto, "toolsCommit")
    seeds = value.get("seeds")
    if not isinstance(seeds, list) or not seeds or not all(isinstance(seed, int) for seed in seeds):
        raise ProtocolError("seeds must be a non-empty integer array")
    for key in ("candidateBudget", "submissionSize"):
        if not isinstance(value.get(key), int) or value[key] <= 0:
            raise ProtocolError(f"{key} must be a positive integer")
    return value
