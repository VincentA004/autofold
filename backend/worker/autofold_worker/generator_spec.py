"""Zero-inference validation of the exact inputs emitted by binder adapters.

This module uses only the standard library. Installed generator parsers run in
an isolated CPU subprocess; no generator CLI, weights, or inference is invoked.
It also runs as a standalone trusted source via python -c for remote preflight.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

AMINO_ACIDS = {"ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE", "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"}


def _positive(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value


def inspect_generator_specs(program: Any) -> dict[str, Any]:
    """Capture actual registered adapter inputs from a constructed native graph."""
    inputs = []
    seen = set()
    for optimizer in getattr(program, "optimizers", []):
        for generator in getattr(optimizer, "generators", []):
            key = getattr(getattr(generator, "_spec", None), "key", None)
            if key not in {"boltzgen-binder", "pxdesign-binder"} or id(generator) in seen:
                continue
            seen.add(id(generator))
            config = generator.config
            target = config.target_structure
            if isinstance(target, str):
                from proto_tools.entities.structures import Structure
                target = Structure(structure=target)
            with tempfile.TemporaryDirectory(prefix="afspec-inspect-") as temporary:
                path = Path(temporary) / "target.pdb"
                target.write_pdb(path)
                target_pdb = path.read_text(encoding="utf-8")
            # Exclude target_structure: its exact adapter PDB bytes are captured
            # separately. Runtime paths retain effective authored config values.
            fields = ("target_chain", "target_chains", "hotspots", "executable", "cache_dir", "protocol", "scaffold", "preset", "diffusion_steps", "dtype")
            explicit = getattr(config, "model_fields_set", None)
            inputs.append({"id": key, "config": {field: getattr(config, field) for field in fields if hasattr(config, field) and (field not in {"executable", "cache_dir"} or explicit is None or field in explicit)},
                "sequenceLength": generator.segment.sequence_length, "targetPdb": target_pdb})
    return {"generators": inputs}


def materialize_design_spec(generator_id: str, config: Any, length: int, root: Path, target_pdb: str) -> Path:
    """Render the same target and specification used by inference."""
    _positive(length, "Binder length")
    target_path = root / "target.pdb"
    target_path.write_text(target_pdb, encoding="utf-8")
    get = config.get if isinstance(config, dict) else lambda key, default=None: getattr(config, key, default)
    if generator_id == "boltzgen-binder":
        chain = get("target_chain", "A")
        entity = {"path": str(target_path), "include": [{"chain": {"id": chain}}], "structure_groups": "all"}
        if get("hotspots", []):
            entity["binding_types"] = [{"chain": {"id": chain, "binding": ",".join(map(str, get("hotspots")))}}]
        protein = {"id": "G", "sequence": f"{length}..{length}"}
        constraints = []
        scaffold = get("scaffold", "linear")
        if scaffold == "cyclic":
            protein["cyclic"] = True
        elif scaffold == "disulfide_beta_hairpin":
            if length < 8:
                raise ValueError("A disulfide beta-hairpin requires at least 8 residues")
            protein["sequence"] = f"C{length - 2}C"
            protein["secondary_structure"] = {"sheet": f"2..{length // 2 - 1},{length // 2 + 2}..{length - 1}"}
            constraints.append({"bond": {"atom1": ["G", 1, "SG"], "atom2": ["G", length, "SG"]}})
        elif scaffold != "linear":
            raise ValueError(f"Unknown BoltzGen scaffold: {scaffold}")
        specification = {"entities": [{"protein": protein}, {"file": entity}], **({"constraints": constraints} if constraints else {})}
    elif generator_id == "pxdesign-binder":
        chains = {chain: {**({"hotspots": get("hotspots")} if get("hotspots", []) else {})} for chain in get("target_chains", ["A"])}
        specification = {"target": {"file": str(target_path), "chains": chains}, "binder_length": length}
    else:
        raise ValueError(f"Unsupported generator spec: {generator_id}")
    path = root / "design.yaml"
    path.write_text(json.dumps(specification, indent=2) + "\n", encoding="utf-8")
    return path


def _pdb_residues(path: Path) -> dict[str, list[tuple[str, str, str]]]:
    chains: dict[str, list[tuple[str, str, str]]] = {}
    seen = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("ENDMDL"):
            break
        if not line.startswith(("ATOM  ", "HETATM")):
            continue
        if len(line) < 27:
            raise ValueError("Target PDB has a truncated atom record")
        chain, number, insertion, residue = line[21:22].strip(), line[22:26].strip(), line[26:27].strip(), line[17:20].strip()
        if line.startswith("HETATM") and residue not in AMINO_ACIDS:
            continue
        identity = (chain, number, insertion)
        if identity not in seen:
            seen.add(identity)
            chains.setdefault(chain, []).append((number, insertion, residue))
    return chains


def validate_materialized_spec(generator_id: str, path: Path) -> dict[str, Any]:
    """Strict validation of the narrow grammar emitted by our adapters.

    BoltzGen selection indices are 1-based positions in the parsed chain,
    not PDB author residue IDs. Both are reported to avoid silent remapping.
    PXDesign checks emitted fields and positive hotspot numbers without
    inventing the native converter's residue-number mapping.
    """
    specification = json.loads(path.read_text(encoding="utf-8"))
    if generator_id == "boltzgen-binder":
        protein, entity = specification["entities"][0]["protein"], specification["entities"][1]["file"]
        target = Path(entity["path"])
        selected = [entry["chain"]["id"] for entry in entity["include"]]
        hotspots = {entry["chain"]["id"]: entry["chain"]["binding"] for entry in entity.get("binding_types", [])}
        if "G" in selected:
            raise ValueError("BoltzGen binder chain G collides with selected target chain G")
        sequence = protein["sequence"]
        if not re.fullmatch(r"[ACDEFGHIKLMNPQRSTVWY0-9.]+", sequence):
            raise ValueError(f"BoltzGen generated protein sequence has unsupported characters: {sequence}")
    elif generator_id == "pxdesign-binder":
        target = Path(specification["target"]["file"])
        selected = list(specification["target"]["chains"])
        hotspots = {chain: values.get("hotspots", []) for chain, values in specification["target"]["chains"].items()}
        _positive(specification["binder_length"], "PXDesign binder_length")
    else:
        raise ValueError(f"Unsupported generator spec: {generator_id}")
    if not selected or len(set(selected)) != len(selected):
        raise ValueError("Generator requires distinct target chains")
    chains = _pdb_residues(target)
    mapping = {}
    for chain in selected:
        if chain not in chains or not chains[chain]:
            raise ValueError(f"Target chain {chain!r} is absent from the materialized PDB; available chains: {sorted(chains)}")
        residues = chains[chain]
        unknown = [f"{number}{insertion}:{name}" for number, insertion, name in residues if name not in AMINO_ACIDS]
        if unknown:
            raise ValueError(f"Target chain {chain} contains non-canonical residues (generator may parse X): {', '.join(unknown[:20])}")
        values = hotspots.get(chain, [])
        if generator_id == "boltzgen-binder":
            values = [int(item) for item in values.split(",")] if values else []
            invalid = [value for value in values if value < 1 or value > len(residues)]
        else:
            # PXDesign hotspot numbering is owned by its native converter;
            # do not infer positional bounds from PDB author residue IDs.
            invalid = [value for value in values if not isinstance(value, int) or isinstance(value, bool) or value < 1]
        if invalid:
            raise ValueError(f"{generator_id} target chain {chain} has {len(residues)} parsed residues; requested hotspots {invalid} are outside the materialized target residue mapping (PDB author IDs {residues[0][0]}{residues[0][1]}..{residues[-1][0]}{residues[-1][1]}). Check target chain and hotspot numbering; no automatic remapping is performed.")
        mapping[chain] = {"residueCount": len(residues), "authorResidueIds": [number + insertion for number, insertion, name in residues]}
    return {"generator": generator_id, "validator": "adapter-emitted-spec", "targetChains": mapping,
        "specHash": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(), "targetPdbHash": "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()}


def _native_boltzgen_validation(path: Path, config: dict[str, Any]) -> bool:
    """Use only the parser in the selected installed CLI environment.

    An inspection host without BoltzGen uses the strict emitted-spec validator.
    A configured CLI/cache must be usable; no install or download fallback.
    """
    configured = config.get("executable") or os.environ.get("AUTOFOLD_BOLTZGEN_EXECUTABLE")
    if not configured:
        return False
    executable = Path(shutil.which(configured) or configured)
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError(f"BoltzGen preflight executable is unavailable: {configured}")
    sibling_python = executable.parent / "python"
    with executable.open("rb") as handle:
        first_line = handle.readline(512).decode("utf-8", errors="replace").strip()
    interpreter = Path(first_line[2:].strip()) if first_line.startswith("#!/") and " " not in first_line[2:].strip() else sibling_python
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise ValueError(f"Cannot resolve selected BoltzGen parser interpreter for {executable}")
    cache = config.get("cache_dir") or os.environ.get("AUTOFOLD_BOLTZGEN_CACHE")
    if not cache:
        raise ValueError("BoltzGen native parser requires the selected existing molecule cache")
    cache_path = Path(cache)
    candidates = [candidate for candidate in [cache_path / "mols.zip", *sorted(cache_path.glob("datasets--boltzgen--inference-data/snapshots/*/mols.zip"))] if candidate.is_file()]
    if len(candidates) != 1:
        raise ValueError(f"BoltzGen native parser requires one existing canonical mols.zip in selected cache {cache_path}; found {len(candidates)}. Preflight never downloads cache artifacts.")
    source = """from pathlib import Path
import sys
from boltzgen.data.parse.schema import YamlDesignParser
from boltzgen.data.mol import load_canonicals
spec_path, mol_dir = map(Path, sys.argv[1:])
mols = load_canonicals(moldir=mol_dir)
YamlDesignParser(mol_dir=mol_dir).parse_yaml(spec_path, mols, mol_dir)
"""
    environment = {**os.environ, "CUDA_VISIBLE_DEVICES": "", "PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    run_generator_command([str(interpreter), "-c", source, str(path), str(candidates[0])], timeout=15, env=environment)
    return True


def _native_pxdesign_validation(path: Path, config: dict[str, Any]) -> dict[str, Any] | None:
    """Parse YAML and the exact PDB using the selected PXDesign CPU converter.

    PXDesign's PDB converter strictly maps author chain/residue IDs to its
    internal IDs. Its check-input CLI alone does not perform this validation.
    No inference runner, cache downloader, weights, or generated binder runs.
    """
    configured = config.get("executable") or os.environ.get("AUTOFOLD_PXDESIGN_EXECUTABLE")
    if not configured:
        return None
    executable = Path(shutil.which(configured) or configured)
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError(f"PXDesign preflight executable is unavailable: {configured}")
    with executable.open("rb") as handle:
        first_line = handle.readline(512).decode("utf-8", errors="replace").strip()
    # Host launchers may be shell wrappers; a sibling Python binds their
    # selected environment without executing the design command.
    sibling_python = executable.parent / "python"
    shebang = first_line[2:].strip() if first_line.startswith("#!/") else ""
    interpreter = Path(shebang) if "python" in Path(shebang).name and " " not in shebang else sibling_python
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise ValueError(f"Cannot resolve selected PXDesign parser interpreter for {executable}; place the configured launcher in the selected environment's bin directory")
    source = """import importlib.util, json, os, sys
from pathlib import Path
package = importlib.util.find_spec("pxdesign")
if package is None or package.origin is None:
    raise RuntimeError("Selected PXDesign interpreter has no pxdesign package")
repo = Path(package.origin).resolve().parent.parent
os.environ.setdefault("PROTENIX_DATA_ROOT_DIR", str(repo / "release_data" / "ccd_cache"))
os.environ.setdefault("TOOL_WEIGHTS_ROOT", str(repo / "tool_weights"))
cache = Path(os.environ["PROTENIX_DATA_ROOT_DIR"])
if not any((cache / name).is_file() for name in ["components.cif", "components.v20240608.cif"]):
    raise RuntimeError(f"Selected PXDesign existing CCD cache is unavailable: {cache}; preflight never downloads artifacts")
from pxdesign.utils.inputs import parse_yaml_to_json
from pxdesign.utils.infer import convert_to_bioassembly_dict
spec_path = Path(sys.argv[1])
tasks = parse_yaml_to_json(str(spec_path), None)
if len(tasks) != 1:
    raise ValueError("Adapter PXDesign specification must contain exactly one task")
task = tasks[0]
bioassembly = convert_to_bioassembly_dict(task, str(spec_path.parent))
array = bioassembly["atom_array"]
selected = task["condition"]["filter"]["chain_id"]
available = set(map(str, array.chain_id))
if not selected or any(chain not in available for chain in selected):
    raise ValueError(f"PXDesign selected target chains {selected} are absent after native conversion; available: {sorted(available)}")
summary = {"nativeTargetChains": {chain: {"residueCount": len(set(map(int, array[array.chain_id == chain].res_id)))} for chain in selected}, "nativeHotspots": task.get("hotspot", {})}
print("AUTOFOLD_PX_SPEC=" + json.dumps(summary, sort_keys=True))
"""
    environment = {**os.environ, "CUDA_VISIBLE_DEVICES": "", "PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    output = run_generator_command([str(interpreter), "-c", source, str(path)], timeout=15, env=environment)
    marker = "AUTOFOLD_PX_SPEC="
    summary = next((line[len(marker):] for line in reversed(output.splitlines()) if line.startswith(marker)), None)
    if summary is None:
        raise RuntimeError("PXDesign native parser returned no target-validation metadata")
    return json.loads(summary)


def run_generator_command(command: list[str], *, timeout: float | None = None, env: dict[str, str] | None = None) -> str:
    """Keep a bounded real traceback even after temporary outputs disappear."""
    def tail(handle: Any, maximum: int) -> str:
        handle.seek(0, os.SEEK_END)
        handle.seek(max(0, handle.tell() - maximum))
        return handle.read().decode("utf-8", errors="replace").strip()

    with tempfile.TemporaryFile(mode="w+b") as stdout, tempfile.TemporaryFile(mode="w+b") as stderr:
        timed_out = False
        try:
            completed = subprocess.run(command, check=False, stdout=stdout, stderr=stderr, timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            timed_out = True
        if timed_out or completed.returncode:
            error_output = tail(stderr, 6000)
            standard_output = tail(stdout, 2000 if error_output else 8000)
            detail = "\n".join(output for output in [standard_output, error_output] if output) or "Generator emitted no diagnostic output"
            status = f"exceeded {timeout}-second timeout" if timed_out else f"exited {completed.returncode}"
            raise RuntimeError(f"{Path(command[0]).name} {status}: {detail}")
        return tail(stdout, 8000)


def preflight(request: dict[str, Any]) -> dict[str, Any]:
    checks = []
    for item in request["generators"]:
        with tempfile.TemporaryDirectory(prefix="afspec-") as temporary:
            path = materialize_design_spec(item["id"], item["config"], item["sequenceLength"], Path(temporary), item["targetPdb"])
            check = validate_materialized_spec(item["id"], path)
            if item["id"] == "boltzgen-binder" and _native_boltzgen_validation(path, item["config"]):
                check["validator"] = "boltzgen.data.parse.schema.YamlDesignParser"
            if item["id"] == "pxdesign-binder":
                native = _native_pxdesign_validation(path, item["config"])
                if native is not None:
                    check.update(native)
                    check["validator"] = "pxdesign.utils.inputs.parse_yaml_to_json+pxdesign.utils.infer.convert_to_bioassembly_dict"
            checks.append(check)
    return {"format": "autofold.generator-spec-preflight.v1", "checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser()
    request_flags = parser.add_mutually_exclusive_group(required=True)
    request_flags.add_argument("--request-base64")
    request_flags.add_argument("--request-stdin", action="store_true")
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.request_stdin else json.loads(base64.b64decode(args.request_base64, validate=True))
        print(json.dumps(preflight(request)))
        return 0
    except (OSError, ValueError, TypeError, KeyError, RuntimeError) as error:
        print(f"Generator design spec preflight failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
