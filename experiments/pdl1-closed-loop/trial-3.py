"""Execution calibration: reroute the resolution vote to MSA-free Protenix ESM."""

from __future__ import annotations

import json
import os
from pathlib import Path

from autofold_worker.proto_generators import BoltzGenBinderConfig, BoltzGenBinderGenerator
from proto_language import StructureBasedConstraintConfig, structure_iptm_constraint
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools.entities.structures import Structure
from proto_tools.tools.structure_prediction.boltz2 import Boltz2Config


AUTOFOLD_WORKFLOW = {
    "format": "autofold.proto-workflow.v1",
    "id": "pdl1_hairpin_protenix_esm_calibration",
    "maximumGpuSeconds": 3600,
    "generation": {
        "generators": ["boltzgen-binder"],
        "maximumCandidates": 1,
        "maximumGpuSeconds": 1700,
    },
    "stages": [
        {
            "id": "primary",
            "capability": "structure_prediction",
            "tools": ["boltz2-prediction"],
            "configs": {
                "boltz2-prediction": {
                    "use_msa": False,
                    "recycling_steps": 1,
                    "sampling_steps": 20,
                    "diffusion_samples": 1,
                }
            },
            "maximumCandidates": 1,
            "maximumGpuSeconds": 500,
        },
        {
            "id": "independent",
            "capability": "structure_prediction",
            "tools": ["chai1-prediction"],
            "configs": {
                "chai1-prediction": {
                    "use_msa": False,
                    "use_esm_embeddings": True,
                    "low_memory": True,
                    "num_trunk_recycles": 1,
                    "num_diffn_timesteps": 20,
                    "num_diffn_samples": 1,
                    "num_trunk_samples": 1,
                }
            },
            "dependsOn": ["primary"],
            "candidateRouting": {
                "source": "primary",
                "metric": "confidence_score",
                "direction": "maximize",
                "maximumCandidates": 1,
            },
            "maximumCandidates": 1,
            "maximumGpuSeconds": 500,
        },
        {
            "id": "resolution",
            "capability": "structure_prediction",
            "tools": ["protenix-prediction"],
            "configs": {
                "protenix-prediction": {
                    "model_name": "protenix_mini_esm_v0.5.0",
                    "use_msa": False,
                    "num_diffusion_samples": 5,
                    "num_diffusion_steps": 5,
                    "num_pairformer_cycles": 4,
                }
            },
            "dependsOn": ["independent"],
            "candidateRouting": {
                "source": "independent",
                "metric": "confidence_score",
                "direction": "maximize",
                "maximumCandidates": 1,
            },
            "maximumCandidates": 1,
            "maximumGpuSeconds": 900,
            "optional": True,
        },
    ],
}


def build_program(bundle):
    if not bundle.get("targetStructurePath"):
        raise ValueError("BoltzGen generation requires a frozen target structure")
    target = json.loads(Path(bundle["targetArtifactPath"]).read_text(encoding="utf-8"))
    target_structure = Structure(structure=Path(bundle["targetStructurePath"]).read_text(encoding="utf-8"))
    target_chain = target["chains"][0]["id"]
    hotspots = [residue["position"] for residue in target["bindingSite"]["residues"]]
    binder = Segment(length=14, sequence_type="protein", label="disulfide-beta-hairpin")
    receptors = [
        Segment(sequence=chain["sequence"], sequence_type="protein", label=f"target_{chain['id']}")
        for chain in target["chains"]
    ]
    construct = Construct([binder, *receptors], label="hairpin-complex")
    generator = BoltzGenBinderGenerator(
        BoltzGenBinderConfig(
            target_structure=target_structure,
            target_chain=target_chain,
            hotspots=hotspots,
            executable=os.environ["AUTOFOLD_BOLTZGEN_EXECUTABLE"],
            cache_dir=os.environ["AUTOFOLD_BOLTZGEN_CACHE"],
            protocol="peptide-anything",
            scaffold="disulfide_beta_hairpin",
        )
    )
    generator.assign(binder)
    rank = Constraint(
        inputs=[binder, *receptors],
        function=structure_iptm_constraint,
        function_config=StructureBasedConstraintConfig(
            structure_tool="boltz2",
            boltz2_config=Boltz2Config(
                use_msa=False,
                recycling_steps=1,
                sampling_steps=20,
                diffusion_samples=1,
            ),
        ),
        label="generation_boltz2_iptm",
        weight=1.0,
    )
    optimizer = RejectionSamplingOptimizer(
        constructs=[construct],
        generators=[generator],
        constraints=[rank],
        config=RejectionSamplingOptimizerConfig(num_samples=1, num_results=1, proposal_batch_size=1),
    )
    return Program(optimizers=[optimizer], num_results=1, seed=bundle["seeds"][0])


def extract_candidates(program, bundle):  # noqa: ARG001
    binder = program.constructs[0].segments[0]
    return [{"sequence": sequence.sequence} for sequence in binder.result_sequences]
