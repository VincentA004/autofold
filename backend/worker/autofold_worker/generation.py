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
    native = getattr(program, "_autofold_native_projection", None)
    if native:
        grouped = {}
        for lane in native["projection"]:
            for stage in lane["stages"]:
                for component in stage["generators"]:
                    grouped.setdefault(component["key"], []).append(component)
        for key, components in grouped.items():
            parameters = {"generator": key, "instances": components}
            inventory[key] = {"id": key, "version": bundle["proto"]["languageCommit"],
                "toolsCalled": sorted(set(tool for c in components for tool in c["toolsCalled"])),
                "parameters": parameters, "parametersHash": _digest_text(_canonical(parameters))}
        return inventory
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


def _sequence_inventory(program: Any) -> dict[str, list[tuple[Any, str | None]]]:
    """Index generated sequence objects with a trusted portfolio-lane origin.

    Native Proto metadata remains useful generator diagnostics, but it is not
    the authority for lane identity. A composite portfolio owns independent
    Program objects, so the runtime can derive exactly one generator from each
    lane before flattening their constructs.
    """
    inventory: dict[str, list[tuple[Any, str | None]]] = {}
    selected = getattr(program, "_autofold_selected_sequences", None)
    if selected is not None:
        for sequence, _origin in selected:
            inventory.setdefault(sequence.sequence, []).append((sequence, None))
        return inventory
    from .compatibility.proto_portfolio_v1 import ProtoPortfolioProgram, _lane_generator
    lanes = (
        [(lane.program, _lane_generator(lane.program)) for lane in program.lanes]
        if isinstance(program, ProtoPortfolioProgram)
        else [(program, None)]
    )
    for lane, generator in lanes:
        for construct in getattr(lane, "constructs", []):
            for segment in getattr(construct, "segments", []):
                for sequence in getattr(segment, "result_sequences", []):
                    key = str(getattr(sequence, "sequence", sequence))
                    inventory.setdefault(key, []).append((sequence, generator))
    return inventory


def _sampling_inventory(program: Any) -> list[dict[str, Any]]:
    """Expose the agent-authored request and trusted effective lane breadth."""
    sampling: dict[str, dict[str, Any]] = {}
    for optimizer in getattr(program, "optimizers", []):
        for generator in getattr(optimizer, "generators", []):
            observed = getattr(generator, "_autofold_sampling", None)
            if isinstance(observed, dict) and isinstance(observed.get("generator"), str):
                sampling[observed["generator"]] = _json_safe(observed)
    return [sampling[key] for key in sorted(sampling)]


def _seed_role_view(bundle: dict[str, Any], program: Any) -> dict[str, Any] | None:
    """Return additive seed provenance only for a host-bound generation slot."""
    if "generationSeed" not in bundle:
        return None
    observed = getattr(program, "_autofold_native_seed_roles", None)
    if isinstance(observed, dict):
        return observed

    # Non-native/older trusted paths still get the host/evaluator bindings, but no
    # observed generator or predictor values are fabricated when the receipt lacks them.
    try:
        from .native_search import lanes
        native_lanes = lanes(program)
    except (ImportError, AttributeError, TypeError):
        native_lanes = [program]
    program_seeds = []
    for lane_index, lane in enumerate(native_lanes):
        seed = getattr(lane, "seed", None)
        if seed is None or type(seed) is int and abs(seed) <= 2**53 - 1:
            program_seeds.append({"lane": lane_index, "value": seed,
                "source": "runtime_program.seed"})
    evaluator_seeds = bundle.get("seeds", [])
    return {
        "format": "autofold.generation-seed-roles.v1",
        "hostGenerationSeed": {"value": bundle["generationSeed"], "source": "trial_bundle.generationSeed"},
        "effectiveProgramSeeds": program_seeds,
        "declaredPredictorSeeds": [],
        "observedToolConfigSeeds": [],
        "evaluatorSeeds": {"values": evaluator_seeds, "source": "trial_bundle.seeds"},
    }


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
        matched = next(
            (item for item in matches if getattr(item[0], "_generator_metadata", {})),
            matches[0] if matches else None,
        )
        observed, trusted_generator = matched if matched is not None else (None, None)
        metadata = _json_safe(getattr(observed, "_generator_metadata", {})) if observed is not None else {}
        generator_ids = [trusted_generator] if trusted_generator in generators else sorted(key for key in metadata if key in generators)
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
            **({"generationSeed": bundle["generationSeed"]} if "generationSeed" in bundle else {}),
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

    realized_identity = sorted(
        [
            {
                "generator": entry["modelId"],
                "seed": entry["seed"],
                "sequence": next(
                    candidate["sequence"]
                    for candidate in candidate_set["candidates"]
                    if candidate["id"] == entry["candidateId"]
                ),
            }
            for entry in entries
        ],
        key=lambda item: (item["generator"], item["seed"], item["sequence"]),
    )
    candidate_set_hash = _digest_text(_canonical(realized_identity))
    observed_generator_seeds: list[dict[str, Any]] = []
    controls: set[str] = set()
    for candidate in candidate_set["candidates"]:
        # Generation metadata is attached to the per-candidate artifact rather
        # than candidates.json. Read it from the same observed Proto sequence.
        matches = sequences.get(candidate["sequence"], [])
        matched = next((item for item in matches if getattr(item[0], "_generator_metadata", {})), None)
        observed = matched[0] if matched is not None else None
        metadata = _json_safe(getattr(observed, "_generator_metadata", {})) if observed is not None else {}
        for generator, details in metadata.items():
            if not isinstance(details, dict) or not isinstance(details.get("seed"), int):
                continue
            seed_control = details.get("seedControl")
            control = "upstream_unavailable" if seed_control == "upstream_cli_unavailable" else "controlled"
            controls.add(control)
            observed_generator_seeds.append({"generator": generator, "seed": details["seed"], "control": control})
    if not generators:
        stochasticity = "deterministic"
    elif controls == {"controlled"}:
        stochasticity = "seeded"
    elif controls == {"upstream_unavailable"}:
        stochasticity = "upstream_uncontrolled"
    elif len(controls) > 1:
        stochasticity = "mixed"
    else:
        stochasticity = "unknown"

    seed_roles = _seed_role_view(bundle, program)
    _write_json(
        output / "generation-runs" / "index.json",
        {
            "format": "autofold.generation-run-index.v1",
            "runId": bundle["runId"],
            "programHash": bundle["programHash"],
            "runtime": {"wallSeconds": wall_seconds},
            **(
                {
                    "replicate": {
                        "id": bundle["generationReplicateId"],
                        "requestedSeeds": bundle["seeds"],
                        "realizedCandidateSetHash": candidate_set_hash,
                        "stochasticity": stochasticity,
                        "observedGeneratorSeeds": sorted(
                            observed_generator_seeds,
                            key=lambda item: (item["generator"], item["seed"], item["control"]),
                        ),
                    }
                }
                if bundle.get("generationReplicateId")
                else {}
            ),
            "sampling": _sampling_inventory(program),
            **({"seedRoles": seed_roles} if seed_roles is not None else {}),
            **({"nativeSearch": program._autofold_native_receipt} if hasattr(program, "_autofold_native_receipt") else {}),
            "portfolioFailures": _json_safe(getattr(program, "lane_failures", [])),
            "generatorDiagnostics": _json_safe(getattr(program, "_autofold_generator_diagnostics", [])),
            "entries": entries,
        },
    )
    return candidate_set
