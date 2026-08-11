"""Trusted capture of Proto generator outputs and provenance."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _digest_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _write(path: Path, content: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return _digest_text(content)


def _write_json(path: Path, value: Any) -> str:
    return _write(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def _json_safe(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        try:
            return _json_safe(value.model_dump(mode="json"))
        except (TypeError, ValueError):
            return _json_safe(value.model_dump())
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return repr(value)


def _parameters(generator: Any, bundle: dict[str, Any]) -> dict[str, Any]:
    config = _json_safe(getattr(generator, "config", {}))
    if isinstance(config, dict) and "target_structure" in config:
        config["target_structure"] = {"targetArtifactHash": bundle.get("targetArtifactHash")}
    spec = getattr(generator, "_spec", None)
    return {
        "generator": getattr(spec, "key", generator.__class__.__name__),
        "config": config,
    }


def _generator_inventory(program: Any, bundle: dict[str, Any]) -> dict[str, dict[str, Any]]:
    inventory: dict[str, dict[str, Any]] = {}
    for optimizer in getattr(program, "optimizers", []):
        for generator in getattr(optimizer, "generators", []):
            spec = getattr(generator, "_spec", None)
            key = getattr(spec, "key", generator.__class__.__name__)
            parameters = _parameters(generator, bundle)
            inventory[key] = {
                "id": key,
                "version": bundle["proto"]["languageCommit"],
                "toolsCalled": sorted(getattr(spec, "tools_called", [])),
                "parameters": parameters,
                "parametersHash": _digest_text(_canonical(parameters)),
            }
    return inventory


def _sequence_inventory(program: Any) -> dict[str, list[Any]]:
    inventory: dict[str, list[Any]] = {}
    for construct in getattr(program, "constructs", []):
        for segment in getattr(construct, "segments", []):
            for sequence in getattr(segment, "result_sequences", []):
                inventory.setdefault(str(getattr(sequence, "sequence", sequence)), []).append(sequence)
    return inventory


def _structure_cif(sequence: Any) -> str | None:
    structure = getattr(sequence, "structure", None)
    if structure is None:
        return None
    value = getattr(structure, "structure_cif", None)
    if callable(value):
        value = value()
    return value if isinstance(value, str) and value else None


def capture(
    bundle: dict[str, Any],
    candidate_set: dict[str, Any],
    program: Any,
    output: Path,
    wall_seconds: float = 0.0,
) -> dict[str, Any]:
    """Attach worker-observed generator provenance and persist generation artifacts."""
    generators = _generator_inventory(program, bundle)
    policy = bundle.get("pipeline", {}).get("generation")
    if policy:
        budget = policy["budget"]
        if len(candidate_set["candidates"]) > budget["maximumCandidates"]:
            raise ValueError("Proto generation exceeded its frozen candidate budget")
        # Proto owns the GPU request timeout. wall_seconds includes first-use environment and
        # checkpoint hydration, so it is provenance rather than a measurement of GPU seconds.
        declared = {item["id"]: item for item in policy["generators"]}
        if set(generators) != set(declared):
            raise ValueError(
                f"Observed Proto generators {sorted(generators)} do not match frozen generation policy {sorted(declared)}"
            )
        for key, generator in generators.items():
            expected = declared[key]
            if generator["version"] != expected["version"] or generator["toolsCalled"] != sorted(expected["toolsCalled"]):
                raise ValueError(f"Observed Proto generator {key} does not match its frozen registry declaration")
    sequences = _sequence_inventory(program)
    entries: list[dict[str, Any]] = []
    allocation_counts: dict[str, int] = {}
    allocations: dict[str, dict[str, Any]] = {}
    if policy:
        allocations = {
            item["id"]: item["allocation"]
            for item in policy["generators"]
            if item.get("allocation") is not None
        }
        allocation_counts = {key: 0 for key in allocations}

    for candidate in candidate_set["candidates"]:
        matches = sequences.get(candidate["sequence"], [])
        observed = next(
            (item for item in matches if getattr(item, "_generator_metadata", {})),
            matches[0] if matches else None,
        )
        metadata = _json_safe(getattr(observed, "_generator_metadata", {})) if observed is not None else {}
        generator_ids = sorted(key for key in metadata if key in generators)
        if not generator_ids:
            generator_ids = sorted(generators)
        if allocations:
            if len(generator_ids) != 1:
                raise ValueError(
                    "Portfolio candidates must identify exactly one frozen generator in their Proto metadata"
                )
            generator_id = generator_ids[0]
            allocation_counts[generator_id] += 1
            if allocation_counts[generator_id] > allocations[generator_id]["maximumCandidates"]:
                raise ValueError(
                    f"Proto generator {generator_id} exceeded its frozen candidate allocation"
                )
        selected = [generators[key] for key in generator_ids]
        model_id = "+".join(generator_ids) if generator_ids else "proto-program"
        parameter_identity = {
            "programHash": bundle["programHash"],
            "generators": [item["parametersHash"] for item in selected],
        }
        parameters_hash = _digest_text(_canonical(parameter_identity))
        candidate_key = hashlib.sha256(candidate["id"].encode("utf-8")).hexdigest()[:16]
        directory = output / "generation-runs" / candidate_key / str(candidate["seed"])
        sequence_hash = _digest_text(candidate["sequence"])
        outputs: dict[str, str] = {"sequenceHash": sequence_hash}
        entry_outputs: dict[str, str] = {}
        structure = _structure_cif(observed)
        if structure is not None:
            structure_path = directory / "generated-complex.cif"
            structure_hash = _write(structure_path, structure)
            outputs["structureHash"] = structure_hash
            entry_outputs = {
                "structurePath": str(structure_path.relative_to(output)),
                "structureHash": structure_hash,
            }
        artifact = {
            "format": "autofold.generation-run.v1",
            "candidateId": candidate["id"],
            "targetArtifactHash": bundle.get("targetArtifactHash"),
            "sequenceHash": sequence_hash,
            "generator": {
                "id": model_id,
                "version": bundle["proto"]["languageCommit"],
                "protoLanguageCommit": bundle["proto"]["languageCommit"],
                "protoToolsCommit": bundle["proto"]["toolsCommit"],
                "components": selected,
            },
            "programHash": bundle["programHash"],
            "parametersHash": parameters_hash,
            "seed": candidate["seed"],
            "metadata": metadata,
            "outputs": outputs,
        }
        artifact_path = directory / "generation-run.json"
        artifact_hash = _write_json(artifact_path, artifact)
        candidate["generation"] = {
            "model": model_id,
            "version": bundle["proto"]["languageCommit"],
            "artifactHash": artifact_hash,
            "parametersHash": parameters_hash,
        }
        entries.append(
            {
                "candidateId": candidate["id"],
                "seed": candidate["seed"],
                "modelId": model_id,
                "artifactPath": str(artifact_path.relative_to(output)),
                "artifactHash": artifact_hash,
                **entry_outputs,
            }
        )

    _write_json(
        output / "generation-runs" / "index.json",
        {
            "format": "autofold.generation-run-index.v1",
            "runId": bundle["runId"],
            "programHash": bundle["programHash"],
            "runtime": {"wallSeconds": wall_seconds},
            "entries": entries,
        },
    )
    return candidate_set
