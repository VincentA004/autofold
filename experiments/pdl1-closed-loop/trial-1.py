"""Bounded PD-L1 baseline: RFdiffusion3/ProteinMPNN plus three-model validation."""

from __future__ import annotations

import json
from pathlib import Path

from proto_language import StructureBasedConstraintConfig, structure_iptm_constraint
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.generator import RFdiffusionMPNNBinderGenerator, RFdiffusionMPNNBinderGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools import ProteinMPNNSampleConfig, RFdiffusion3Config
from proto_tools.entities.structures import Structure
from proto_tools.tools.structure_prediction.boltz2 import Boltz2Config


AUTOFOLD_WORKFLOW = {
    "format": "autofold.proto-workflow.v1",
    "id": "pdl1_closed_loop_baseline",
    "maximumGpuSeconds": 3600,
    "generation": {
        "generators": ["rfdiffusion-mpnn-binder"],
        "maximumCandidates": 1,
        "maximumGpuSeconds": 1800,
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
            "maximumGpuSeconds": 600,
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
            "maximumGpuSeconds": 600,
        },
        {
            "id": "resolution",
            "capability": "structure_prediction",
            "tools": ["protenix-prediction"],
            "configs": {
                "protenix-prediction": {
                    "model_name": "protenix-v2",
                    "use_msa": False,
                    "num_diffusion_samples": 1,
                    "num_diffusion_steps": 5,
                    "num_pairformer_cycles": 2,
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
            "maximumGpuSeconds": 600,
            "optional": True,
        },
    ],
}


def build_program(bundle):
    if not bundle.get("targetStructurePath"):
        raise ValueError("RFdiffusion3 generation requires a frozen target structure")
    target = json.loads(Path(bundle["targetArtifactPath"]).read_text(encoding="utf-8"))
    target_structure = Structure(structure=Path(bundle["targetStructurePath"]).read_text(encoding="utf-8"))
    target_chains = [chain["id"] for chain in target["chains"]]
    hotspots = [f"{residue['chainId']}{residue['position']}" for residue in target["bindingSite"]["residues"]]
    binder = Segment(length=30, sequence_type="protein", label="binder")
    receptors = [
        Segment(sequence=chain["sequence"], sequence_type="protein", label=f"target_{chain['id']}")
        for chain in target["chains"]
    ]
    construct = Construct([binder, *receptors], label="binder-complex")
    generator = RFdiffusionMPNNBinderGenerator(
        RFdiffusionMPNNBinderGeneratorConfig(
            target_structure=target_structure,
            target_chains=target_chains,
            hotspots=hotspots,
            inverse_folding="proteinmpnn",
            rfdiffusion3_config=RFdiffusion3Config(
                diffusion_batch_size=1,
                n_batches=1,
                num_timesteps=50,
                low_memory_mode=True,
            ),
            proteinmpnn_config=ProteinMPNNSampleConfig(num_sequences_per_structure=1, batch_size=1),
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
        config=RejectionSamplingOptimizerConfig(
            num_samples=1,
            num_results=1,
            proposal_batch_size=1,
        ),
    )
    return Program(optimizers=[optimizer], num_results=1, seed=bundle["seeds"][0])


def extract_candidates(program, bundle):  # noqa: ARG001
    binder = program.constructs[0].segments[0]
    return [{"sequence": sequence.sequence} for sequence in binder.result_sequences]
