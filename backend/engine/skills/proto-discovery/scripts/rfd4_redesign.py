"""Parent-conditioned native RFD4 proposals for Proto CyclingOptimizer.

No model is loaded on import. Capture this module and model_generators.py with
the trial. A request is one observed parent complex, not a static target spec.
"""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Literal

import gemmi
import numpy as np
import yaml

from proto_language.core import GeneratorInputType
from proto_language.generator.generator_registry import generator
from proto_language.utils.base import ConfigField
from proto_tools import Structure

from model_generators import RFD4BinderConfig, RFD4BinderGenerator


@dataclass
class RFD4Parent:
    parent_id: str
    sequence: str
    structure: Structure
    evidence: str  # captured prediction/generated artifact, not an affinity claim


class RFD4RedesignConfig(RFD4BinderConfig):
    design_spec: str = ConfigField(default="", title="Unused static specification", description="Leave empty: conditioning is built from each supplied parent.")
    operation: Literal["partial_redesign", "inverse_folding"] = ConfigField(title="Parent operation", description="Partial redesign perturbs the parent; inverse folding fixes its backbone while redesigning identities/side chains.")
    partial_fraction: float = ConfigField(default=0.25, gt=0, le=1, title="Partial trajectory fraction", description="Fraction of the native 60-step trajectory tail. Not an angstrom displacement or diffusion time.")
    fixed_positions: list[int] = ConfigField(default_factory=list, title="Fixed binder identities", description="Observed binder sequence positions, 1-based. All target identities are fixed. No implicit framework or motif mask.")
    backbone_condition_positions: list[int] = ConfigField(default_factory=list, title="Binder backbone conditioning", description="Observed 1-based binder positions supplied in the target's relative coordinate group. Native partial redesign can drift; use Proto constraints for the geometric tolerance required by the objective. This does not freeze coordinates or identities.")
    target_hotspots: list[int] = ConfigField(default_factory=list, title="Target hotspots", description="Observed 1-based target positions to condition with native C_HOT. A design preference, not proof of contact or affinity.")


def normalized_parent(parent, config, length):
    """Normalize observed canonical residues; author gaps never become residues."""
    if not isinstance(parent, RFD4Parent) or not parent.parent_id or not parent.evidence:
        raise ValueError("Supply RFD4Parent with a parent ID and captured evidence reference")
    if not isinstance(parent.structure, Structure):
        raise ValueError("Parent needs a complete observed complex Structure")
    text = parent.structure.structure
    model = (gemmi.read_pdb_string(text) if parent.structure.structure_format == "pdb"
             else gemmi.make_structure_from_block(gemmi.cif.read_string(text).sole_block()))
    if len(model) != 1:
        raise ValueError("Parent must contain one structural model")
    expected = {config.target_chain: config.target_sequence, config.binder_chain: parent.sequence}
    if config.target_chain == config.binder_chain or len(parent.sequence) != length:
        raise ValueError("Parent binder length/chain contract mismatch")
    if set(c.name for c in model[0]) != set(expected) or len(model[0]) != 2:
        raise ValueError("Parent must have exactly the explicitly named binder and target chains")
    mapping = []
    for chain in model[0]:
        seq = ""
        for i, residue in enumerate(chain, 1):
            info = gemmi.find_tabulated_residue(residue.name)
            if not info.is_amino_acid() or info.one_letter_code not in "ACDEFGHIKLMNPQRSTVWY":
                raise ValueError("Parent contains unsupported chemistry or noncanonical residues")
            if any(residue.find_atom(atom, '*') is None for atom in ("N", "CA", "C", "O")):
                raise ValueError("Parent requires a complete N/CA/C/O backbone")
            if any(not np.isfinite([a.pos.x, a.pos.y, a.pos.z]).all() for a in residue):
                raise ValueError("Nonfinite parent coordinates")
            seq += info.one_letter_code
            mapping.append({"chain": chain.name, "position": i, "author": str(residue.seqid),
                            "source_label": residue.label_seq, "normalized_label": i})
            residue.seqid = gemmi.SeqId(i, " ")
            residue.label_seq = i
            residue.subchain = chain.name  # RFD4 selects label_asym_id, not auth_asym_id.
        if seq != expected[chain.name]:
            raise ValueError(f"Parent sequence/structure identity mismatch for chain {chain.name}")
    for positions, limit in [(config.fixed_positions,length),(config.backbone_condition_positions,length),
                             (config.target_hotspots,len(config.target_sequence))]:
        if len(set(positions)) != len(positions) or any(type(i) is not int or not 1 <= i <= limit for i in positions):
            raise ValueError("Condition positions must be unique 1-based sequence positions")
    model.setup_entities()
    return model.make_mmcif_document().as_string(), mapping


@generator(key="rfd4-redesign", label="RFD4 parent-conditioned redesign",
           config=RFD4RedesignConfig, uses_gpu=True, tools_called=[],
           supported_sequence_types=["protein"],
           description="Native partial redesign or inverse folding of explicit parent complexes through Proto CyclingOptimizer. Captures parent lineage, numbering map and masks. Generated geometry requires fresh independent assessment.")
class RFD4RedesignGenerator(RFD4BinderGenerator):
    input_type = GeneratorInputType.STRUCTURE
    allows_empty_starting_sequence = False

    def _native_overrides(self):
        if self.config.operation == "inverse_folding":
            return ["generation=inverse_folding", "generation.args.nsteps=60"]
        return ["generation.args.nsteps=60",
                f"generation.args.partial_trajectory_fraction_steps={self.config.partial_fraction}"]

    def _validate_proposal(self, structure, sequence):
        if any(sequence[i-1] != self._parent.sequence[i-1] for i in self.config.fixed_positions):
            raise ValueError("Native output changed a fixed binder identity")
        # Inverse folding fixes CA coordinates. Compare pairwise geometry because
        # native serialization may re-center or rotate the entire complex.
        if self.config.operation == "inverse_folding":
            def ca(s):
                m = (gemmi.read_pdb_string(s.structure) if s.structure_format == "pdb" else
                     gemmi.make_structure_from_block(gemmi.cif.read_string(s.structure).sole_block()))
                return np.array([[r.find_atom('CA', '*').pos.x, r.find_atom('CA', '*').pos.y, r.find_atom('CA', '*').pos.z]
                                 for name in (self.config.target_chain, self.config.binder_chain)
                                 for r in m[0][name]])
            a, b = ca(self._parent.structure), ca(structure)
            if a.shape != b.shape:
                raise ValueError("Output CA count differs from the complete parent complex")
            da = np.linalg.norm(a[:, None] - a[None, :], axis=-1)
            db = np.linalg.norm(b[:, None] - b[None, :], axis=-1)
            if a.shape != b.shape or not np.allclose(da, db, atol=0.05, rtol=0):
                raise ValueError("Native output changed fixed parent CA geometry")

    def _sample(self, conditioning_data):
        if len(conditioning_data) != self.segment.num_proposals:
            raise ValueError("Supply one parent request per Proto proposal")
        if self.config.design_spec or self.config.mode != "generation" or self.config.search_spec:
            raise ValueError("Parent redesign uses explicit parents and plain native sampling; guided partial search is not validated")
        if self.config.operation == "partial_redesign" and round(60 * self.config.partial_fraction) < 1:
            raise ValueError("Partial fraction rounds to zero native steps")
        original = self.config
        proposals = []
        try:
            for parent in conditioning_data:
                text, mapping = normalized_parent(parent, original, self.segment.sequence_length)
                root = Path(original.output_dir).resolve()
                root.mkdir(parents=True, exist_ok=True)
                index = 1
                while (root / f"parent-{index:03}").exists(): index += 1
                directory = root / f"parent-{index:03}"
                directory.mkdir()
                (directory / "parent.cif").write_text(text)
                (directory / "parent-source.txt").write_text(parent.structure.structure)
                b, t = original.binder_chain, original.target_chain
                identities = [{"select": f"sel('{t}')"}]
                identities += [{"select": f"sel('{b}/*/{i}')"} for i in original.fixed_positions]
                spec = {"parent_redesign": {"input": str(directory / "parent.cif"),
                    "contig": f"{t}1-{len(original.target_sequence)},/0,{b}1-{len(parent.sequence)}",
                    "conditions": {"C_SEQ": {True: identities},
                        "C_CRDGRP": {1: [{"select": f"sel('{t}/*/*/[N,CA,C,O]')"}]}}}}
                conditions = spec['parent_redesign']['conditions']
                conditions['C_CRDGRP'][1] += [{"select": f"sel('{b}/*/{i}/[N,CA,C,O]')"}
                                             for i in original.backbone_condition_positions]
                if original.target_hotspots:
                    conditions['C_HOT'] = {True: [{"select": f"sel('{t}/*/{i}')"}
                                                for i in original.target_hotspots]}
                (directory / "conditioning.yaml").write_text(yaml.safe_dump(spec))
                lineage = {"parent_id": parent.parent_id, "sequence": parent.sequence,
                           "evidence": parent.evidence, "geometry_role": "conditioning; generated output is not independent prediction",
                           "parent_sha256": hashlib.sha256(text.encode()).hexdigest(),
                           "numbering": mapping, "config": original.model_dump(mode="json")}
                (directory / "parent.json").write_text(json.dumps(lineage, indent=2) + "\n")
                self._parent = parent
                self.config = original.model_copy(update={"design_spec": str(directory / "conditioning.yaml"),
                                                          "output_dir": str(directory)})
                self.segment.proposal_sequences = [self.segment.proposal_sequences[0]]
                super()._sample()
                for child in self.segment.proposal_sequences:
                    child._generator_metadata[self._spec.key].update(
                        parent_id=parent.parent_id, parent_record=str(directory / "parent.json"),
                        operation=original.operation, geometry_role="generated")
                proposals.extend(self.segment.proposal_sequences)
            self.segment.proposal_sequences = proposals
        finally:
            self.config = original
