"""Native Proto proposal adapters for independently installed antibody models.

No model import/install occurs here. Capture this file with the authored Program.
Each Segment represents ONE mutable chain; other chains remain explicit context.
"""
import csv
import json
import os
from pathlib import Path
import subprocess

import numpy as np
from proto_language.core import Generator, GeneratorInputType, Sequence
from proto_language.generator.generator_registry import generator
from proto_language.utils.base import BaseConfig, ConfigField
from proto_tools import InverseFoldingStructureInput, Structure


ALPHABET = "ACDEFGHIKLMNPQRSTVWY"


def existing(value, description, *, directory=False):
    if not value:
        raise ValueError(f"Configure an installed {description}; this adapter does not install models")
    # Preserve a venv's executable symlink: resolving it to the base Python
    # silently changes sys.prefix and loses that environment's installed models.
    path = Path(value).absolute()
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError(f"Invalid {description}: {path}")
    return path


def capture(root, prefix):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    number = 1
    while (root / f"{prefix}-{number:03}").exists():
        number += 1
    result = root / f"{prefix}-{number:03}"
    result.mkdir()
    return result


def run(command, directory, name, timeout):
    # Isolated model interpreters are explicit; do not rely on the caller's PATH.
    with (directory / f"{name}.stdout.log").open("w") as out, \
            (directory / f"{name}.stderr.log").open("w") as err:
        subprocess.run(command, cwd=directory, stdout=out, stderr=err,
                       timeout=timeout, check=True)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def canonical(sequence):
    if not sequence or set(sequence) - set(ALPHABET):
        raise ValueError("Adapter requires a nonempty canonical protein sequence")
    return sequence


def chain_sequences(structure):
    """Observed canonical residues; author-numbering gaps are not extra residues."""
    import gemmi
    model = (gemmi.read_pdb_string(structure.structure) if structure.structure_format == "pdb"
             else gemmi.make_structure_from_block(gemmi.cif.read_string(structure.structure).sole_block()))
    result = {}
    for chain in model[0]:
        residues = [gemmi.find_tabulated_residue(r.name) for r in chain]
        sequence = "".join(r.one_letter_code for r in residues if r.is_amino_acid())
        if sequence:
            if chain.name in result:
                raise ValueError("Repeated chain identifiers require explicit remapping")
            result[chain.name] = canonical(sequence)
    return result


def fixed_framework(pdb_text, chain_id, loops):
    """Compare framework identity using native HLT pose-index annotations."""
    import re
    import gemmi
    labels = {int(match[1]) for match in re.finditer(
        r"^REMARK PDBinfo-LABEL:\s*(\d+)\s+([HL][123])\s*$", pdb_text, re.M)
        if match[2] in loops}
    if not labels:
        raise ValueError("Missing native HLT design-loop annotations")
    index, fixed = 0, []
    for chain in gemmi.read_pdb_string(pdb_text)[0]:
        for residue in chain:
            info = gemmi.find_tabulated_residue(residue.name)
            if not info.is_amino_acid():
                continue
            index += 1
            if chain.name == chain_id and index not in labels:
                fixed.append(info.one_letter_code)
    return canonical("".join(fixed))


class RFAntibodyConfig(BaseConfig):
    target_pdb: str = ConfigField(title='Target Pdb', description="Captured target PDB")
    framework_pdb: str = ConfigField(title='Framework Pdb', description="Captured HLT-annotated antibody/VHH framework PDB")
    output_chain_id: str = ConfigField(title='Output Chain Id', description="H or L: one mutable antibody chain per Segment")
    expected_fixed_chains: dict[str, str] = ConfigField(title='Expected Fixed Chains', description="Exact output IDs/sequences of all other chains, including target and fixed antibody partner")
    design_loops: str = ConfigField(title='Design Loops', description="Explicit loops on the output chain, with fixed lengths, e.g. H1:7,H2:6,H3:12")
    output_dir: str = ConfigField(title='Output Dir', description="Persistent trial output directory")
    repo_dir: str = ConfigField(title='Repo Dir', default_factory=lambda: os.environ.get("AUTOFOLD_RFANTIBODY_REPO", ""), description="Installed upstream checkout containing scripts/")
    python_executable: str = ConfigField(title='Python Executable', default_factory=lambda: os.environ.get("AUTOFOLD_RFANTIBODY_PYTHON", ""), description="Absolute isolated RFantibody Python executable")
    diffusion_weights: str = ConfigField(title='Diffusion Weights', description="Existing RFdiffusion antibody checkpoint")
    mpnn_weights: str = ConfigField(title='Mpnn Weights', description="Existing ProteinMPNN checkpoint for the upstream CDR wrapper")
    hotspots: list[str] = ConfigField(title='Hotspots', default_factory=list, description="Native target residue handles, e.g. T146")
    temperature: float = ConfigField(title='Temperature', default=0.1, ge=0.001, le=1.0, description="MPNN sampling temperature")
    timeout_seconds: int = ConfigField(title='Timeout Seconds', default=900, ge=1, description="Timeout for each awaited native stage; also bound the enclosing trial")


@generator(key="rfantibody-binder", label="RFAntibody CDR geometry and sequence",
           config=RFAntibodyConfig, uses_gpu=True, tools_called=[],
           supported_sequence_types=["protein"],
           description="Framework/target-conditioned antibody CDR generation followed by CDR-only ProteinMPNN. One mutable H/L chain; fixed partners checked; captures native output. Requires an installed isolated runtime; no RF2 assessment is run.")
class RFAntibodyGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_empty_starting_sequence = True

    def __init__(self, config):
        super().__init__()
        self.config = config

    def _preserve_structure_after_sample(self):
        return True

    def _sample(self):
        import re
        cfg = self.config
        chain = cfg.output_chain_id
        loops = cfg.design_loops.split(",")
        if chain not in ("H", "L") or not loops or any(
                not re.fullmatch(chain + r"[123]:[1-9][0-9]*", loop) for loop in loops):
            raise ValueError("Specify fixed-length loops only on the one mutable H/L chain")
        if chain in cfg.expected_fixed_chains or not cfg.expected_fixed_chains:
            raise ValueError("Declare other output chains separately, including the target")
        for seq in cfg.expected_fixed_chains.values():
            canonical(seq)
        repo = existing(cfg.repo_dir, "RFantibody checkout", directory=True)
        python = existing(cfg.python_executable, "RFantibody Python")
        diffusion = existing(str(repo / "scripts/rfdiffusion_inference.py"), "RFantibody diffusion script")
        mpnn = existing(str(repo / "scripts/proteinmpnn_interface_design.py"), "CDR MPNN script")
        target = existing(cfg.target_pdb, "target PDB")
        framework = existing(cfg.framework_pdb, "HLT framework PDB")
        weights = existing(cfg.diffusion_weights, "antibody diffusion weights")
        mpnn_weights = existing(cfg.mpnn_weights, "CDR MPNN weights")
        for loop in loops:
            if not any(line.startswith("REMARK PDBinfo-LABEL:") and line.rstrip().endswith(loop[:2])
                       for line in framework.read_text().splitlines()):
                raise ValueError(f"Framework lacks HLT annotation for {loop[:2]}")
        loop_names = {loop[:2] for loop in loops}
        expected_framework = fixed_framework(framework.read_text(), chain, loop_names)
        count = self.segment.num_proposals
        seed = self._next_seed()
        directory = capture(cfg.output_dir, "rfantibody")
        (directory / "target.pdb").write_bytes(target.read_bytes())
        (directory / "framework.pdb").write_bytes(framework.read_bytes())
        backbone, designed = directory / "backbones", directory / "sequences"
        backbone.mkdir()
        command = [str(python), str(diffusion), "--config-name", "antibody",
                   f"antibody.target_pdb={directory / 'target.pdb'}",
                   f"antibody.framework_pdb={directory / 'framework.pdb'}",
                   f"inference.output_prefix={backbone / 'design'}",
                   f"inference.num_designs={count}", f"antibody.design_loops=[{cfg.design_loops}]",
                   f"inference.ckpt_override_path={weights}", "inference.write_trajectory=False"]
        if cfg.hotspots:
            command.append(f"ppi.hotspot_res=[{','.join(cfg.hotspots)}]")
        if seed is not None:
            command += ["inference.deterministic=True", f"inference.design_startnum={seed}"]
        sequence_command = [str(python), str(mpnn), "-pdbdir", str(backbone),
                            "-outpdbdir", str(designed), "-seqs_per_struct", "1",
                            "-loop_string", ",".join(loop[:2] for loop in loops),
                            "-temperature", str(cfg.temperature), "-checkpoint_path", str(mpnn_weights)]
        if seed is not None:
            sequence_command.append("-deterministic")
        request = {"commands": [command, sequence_command], "config": cfg.model_dump(mode="json"),
                   "seed": seed, "mpnn_seed_policy": "upstream deterministic mode uses its own fixed seed"}
        write_json(directory / "request.json", request)
        receipt = {"success": False}
        try:
            run(command, directory, "diffusion", cfg.timeout_seconds)
            if len(list(backbone.glob("*.pdb"))) != count:
                raise ValueError("Incomplete diffusion output; retained without replacement")
            run(sequence_command, directory, "mpnn", cfg.timeout_seconds)
            paths = sorted(designed.glob("*.pdb"))
            if len(paths) != count:
                raise ValueError("Incomplete CDR sequence output; retained without replacement")
            proposals = []
            for path in paths:
                structure = Structure(structure=path.read_text(), structure_format="pdb")
                chains = chain_sequences(structure)
                if set(chains) != {chain, *cfg.expected_fixed_chains} or any(
                        chains.get(key) != seq for key, seq in cfg.expected_fixed_chains.items()):
                    raise ValueError("Generated target/fixed partner identity mismatch")
                sequence = canonical(chains[chain])
                if len(sequence) != self.segment.sequence_length:
                    raise ValueError("Generated chain length differs from the assigned Segment")
                if fixed_framework(path.read_text(), chain, loop_names) != expected_framework:
                    raise ValueError("Generated sequence changed the fixed antibody framework")
                proposal = Sequence(sequence=sequence, sequence_type="protein", structure=structure)
                proposal._generator_metadata[self._spec.key] = {
                    "artifact": str(path), "request": str(directory / "request.json"),
                    "chain_sequences": chains, "output_chain_id": chain,
                    "structure_role": "generated geometry, not an independent prediction"}
                proposals.append(proposal)
            self.segment.proposal_sequences = proposals
            receipt.update(success=True, proposals=len(proposals))
        except Exception as exc:
            receipt["error"] = str(exc)
            raise
        finally:
            write_json(directory / "receipt.json", receipt)


class AntiFoldConfig(BaseConfig):
    output_chain_id: str = ConfigField(title='Output Chain Id', description="One mutable antibody H/L chain; actual structure chain ID")
    heavy_chain_id: str = ConfigField(title='Heavy Chain Id', description="Explicit heavy/nanobody chain ID")
    light_chain_id: str | None = ConfigField(title='Light Chain Id', default=None, description="Paired light chain, if present")
    antigen_chain_id: str | None = ConfigField(title='Antigen Chain Id', default=None, description="Optional antigen context chain")
    mutable_positions: list[int] = ConfigField(title='Mutable Positions', description="Nonempty 1-based sequence indices on output_chain_id, not IMGT/author numbers; everything else stays fixed")
    structure_path: str | None = ConfigField(title='Structure Path', default=None, description="Fixed PDB/CIF conditioning input; omit to use each proposal's attached structure or native cycling structure_inputs")
    output_dir: str = ConfigField(title='Output Dir', description="Persistent trial output directory")
    python_executable: str = ConfigField(title='Python Executable', default_factory=lambda: os.environ.get("AUTOFOLD_ANTIFOLD_PYTHON", ""), description="Absolute isolated Python with antifold installed")
    model_weights: str = ConfigField(title='Model Weights', description="Existing AntiFold weights; never download implicitly")
    temperature: float = ConfigField(title='Temperature', default=0.2, ge=0.001, le=1.0, description="Temperature for independent per-position sampling of native AntiFold log probabilities")
    device: str = ConfigField(title='Device', default="cuda", description="Device in the isolated model environment")
    timeout_seconds: int = ConfigField(title='Timeout Seconds', default=600, ge=1, description="Timeout per native probability call; also bound the enclosing trial")


@generator(key="antifold", label="AntiFold structure-conditioned antibody proposals",
           config=AntiFoldConfig, uses_gpu=True, tools_called=[],
           supported_sequence_types=["protein"],
           description="Sample a single antibody chain at explicit sequence positions from captured AntiFold per-residue probabilities. Fixed partner chains retained as context. Accepts fixed or cycling structures. Requires an isolated installed runtime; no affinity scoring.")
class AntiFoldGenerator(Generator):
    input_type = GeneratorInputType.STRUCTURE

    def __init__(self, config):
        super().__init__()
        self.config = config

    def _sample(self, structure_inputs=None):
        cfg = self.config
        python = existing(cfg.python_executable, "AntiFold Python")
        weights = existing(cfg.model_weights, "AntiFold weights")
        if cfg.output_chain_id not in (cfg.heavy_chain_id, cfg.light_chain_id):
            raise ValueError("Only the declared heavy or light antibody chain can be redesigned")
        roles = [c for c in (cfg.heavy_chain_id, cfg.light_chain_id, cfg.antigen_chain_id) if c]
        if len(set(roles)) != len(roles):
            raise ValueError("Heavy, light and antigen chain IDs must be distinct")
        mutable = set(cfg.mutable_positions)
        if (not mutable or len(mutable) != len(cfg.mutable_positions)
                or min(mutable) < 1 or max(mutable) > self.segment.sequence_length):
            raise ValueError("Mutable positions must be unique in-range 1-based sequence indices")
        if structure_inputs is None:
            structures = ([Structure(structure=existing(cfg.structure_path, "conditioning structure").read_text())]
                          if cfg.structure_path else [p.structure for p in self.segment.proposal_sequences])
        else:
            values = structure_inputs if isinstance(structure_inputs, list) else [structure_inputs]
            for value in values:
                if isinstance(value, InverseFoldingStructureInput):
                    if value.chains_to_redesign is not None and value.chain_ids_to_redesign != [cfg.output_chain_id]:
                        raise ValueError("Cycling input must select the one mutable antibody chain")
                    if value.fixed_positions is not None and mutable.intersection(
                            value.fixed_positions.chains.get(cfg.output_chain_id, [])):
                        raise ValueError("Mutable positions conflict with the cycling input's fixed positions")
            structures = [v.structure if isinstance(v, InverseFoldingStructureInput) else v for v in values]
        if len(structures) not in (1, self.segment.num_proposals) or any(s is None for s in structures):
            raise ValueError("Supply one conditioning structure or one per proposal")
        seed = self._next_seed()
        rng = np.random.default_rng(seed)
        proposals = []
        for index, structure in enumerate(structures):
            chains = chain_sequences(structure)
            if set(chains) != set(roles):
                raise ValueError("Declare every protein chain as heavy, light or the single antigen context chain")
            parent = canonical(chains[cfg.output_chain_id])
            if len(parent) != self.segment.sequence_length:
                raise ValueError("Conditioning chain length differs from the assigned Segment")
            directory = capture(cfg.output_dir, "antifold")
            # Preserve the original input too; native PDB conversion may change numbering.
            (directory / f"conditioning.{structure.structure_format}").write_text(structure.structure)
            pdb = directory / "input.pdb"
            pdb.write_text(structure.structure_pdb)
            native = directory / "native"
            # Upstream collates CUDA tensors in DataLoader workers. A fork after
            # loading the model cannot initialize CUDA; use a fresh spawn context.
            bootstrap = ("import multiprocessing as mp, runpy; "
                         "mp.set_start_method('spawn', force=True); "
                         "runpy.run_module('antifold.main', run_name='__main__')")
            command = [str(python), "-c", bootstrap, "--pdb_file", str(pdb),
                       "--out_dir", str(native), "--model_path", str(weights),
                       "--device", cfg.device, "--num_seq_per_target", "0", "--num_threads", "1"]
            if cfg.light_chain_id:
                command += ["--heavy_chain", cfg.heavy_chain_id, "--light_chain", cfg.light_chain_id]
            else:
                command += ["--nanobody_chain", cfg.heavy_chain_id]
            if cfg.antigen_chain_id:
                command += ["--antigen_chain", cfg.antigen_chain_id]
            if seed is not None:
                command += ["--seed", str(seed)]
            write_json(directory / "request.json", {"command": command, "config": cfg.model_dump(mode="json"),
                                                     "seed": seed, "chain_sequences": chains})
            receipt = {"success": False}
            try:
                run(command, directory, "probabilities", cfg.timeout_seconds)
                paths = list(native.glob("*.csv"))
                if len(paths) != 1:
                    raise ValueError("Expected one native AntiFold probability CSV")
                with paths[0].open() as handle:
                    rows = list(csv.DictReader(handle))
                selected = [row for row in rows if row["pdb_chain"] == cfg.output_chain_id]
                if "".join(row["pdb_res"] for row in selected) != parent:
                    raise ValueError("AntiFold output sequence/residue mapping differs from conditioning")
                for role in roles:
                    if "".join(r["pdb_res"] for r in rows if r["pdb_chain"] == role) != chains[role]:
                        raise ValueError("AntiFold context chain mapping differs from input")
                logprobs = np.array([[float(row[aa]) for aa in ALPHABET] for row in selected])
                if not np.isfinite(logprobs).all():
                    raise ValueError("Nonfinite native AntiFold probabilities")
                count = self.segment.num_proposals if len(structures) == 1 else 1
                records = []
                for _ in range(count):
                    result = list(parent)
                    for position in sorted(mutable):
                        scores = logprobs[position - 1] / cfg.temperature
                        probabilities = np.exp(scores - scores.max())
                        result[position - 1] = ALPHABET[rng.choice(20, p=probabilities / probabilities.sum())]
                    sequence = "".join(result)
                    proposal = Sequence(sequence=sequence, sequence_type="protein", structure=structure)
                    proposal._generator_metadata[self._spec.key] = {
                        "artifact": str(paths[0]), "request": str(directory / "request.json"),
                        "output_chain_id": cfg.output_chain_id, "mutable_positions": sorted(mutable),
                        "parent_sequence": parent, "structure_role": "conditioning only; re-predict the new sequence"}
                    proposals.append(proposal)
                    records.append({"sequence": sequence, "parent_sequence": parent})
                write_json(directory / "proposals.json", records)
                receipt.update(success=True, proposals=count)
            except Exception as exc:
                receipt["error"] = str(exc)
                raise
            finally:
                write_json(directory / "receipt.json", receipt)
        self.segment.proposal_sequences = proposals
