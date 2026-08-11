"""Composition-matched scrambled negative control for the PD-L1 predictor panel."""

from __future__ import annotations

import json
from pathlib import Path

from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig


AUTOFOLD_WORKFLOW = {
    "format": "autofold.proto-workflow.v1",
    "id": "pdl1_composition_matched_scrambled_negative_control",
    "maximumGpuSeconds": 3600,
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
    result_count = min(bundle["submissionSize"], bundle["candidateBudget"], 1)
    target = json.loads(Path(bundle["targetArtifactPath"]).read_text(encoding="utf-8"))
    # Same length, terminal cysteines, and residue composition as CGVKLVDGKLIVTC,
    # with a deterministic shuffled interior to test sequence-specific signal.
    binder = Segment(sequence="CKVGTLDVIGVKLC", sequence_type="protein", label="scrambled-negative-control")
    receptors = [
        Segment(sequence=chain["sequence"], sequence_type="protein", label=f"target_{chain['id']}")
        for chain in target["chains"]
    ]
    construct = Construct([binder, *receptors], label="scrambled-control-complex")
    existing_result = Constraint(
        inputs=[binder],
        function=protein_diversity_constraint,
        function_config=ProteinDiversityConfig(min_diversity=0.0),
        label="control_sequence_passthrough",
    )
    control = RejectionSamplingOptimizer(
        constructs=[construct],
        generators=[],
        constraints=[existing_result],
        config=RejectionSamplingOptimizerConfig(
            num_samples=result_count,
            num_results=result_count,
            proposal_batch_size=result_count,
            proposal_source="existing_results",
        ),
    )
    return Program(optimizers=[control], num_results=result_count, seed=bundle["seeds"][0])


def extract_candidates(program, bundle):  # noqa: ARG001
    binder = program.constructs[0].segments[0]
    return [{"sequence": sequence.sequence} for sequence in binder.result_sequences]
