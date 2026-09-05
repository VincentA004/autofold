"""Bounded live verification of generator-search feedback.

FreeBindCraft may reject several internal trajectories while returning at most
one candidate. A one-candidate RFdiffusion lane keeps the frozen evaluator
runnable when that exploratory lane accepts nothing.
"""

from __future__ import annotations

import json
from contextlib import nullcontext

import autofold_worker.proto_generators  # register Autofold generator plugins
from autofold_worker.proto_portfolio import ProtoPortfolioLane, ProtoPortfolioProgram
from autofold_worker.proto_trial import ProtoTrial, TrialContext
from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.generator import RFdiffusionMPNNBinderGenerator, RFdiffusionMPNNBinderGeneratorConfig
from proto_language.generator.freebindcraft_generator import FreeBindCraftGenerator, FreeBindCraftGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools import ProteinMPNNSampleConfig, RFdiffusion3Config
from proto_tools.entities.structures import Structure


def _lane(ctx: TrialContext, generator, binder: Segment, seconds: int) -> ProtoPortfolioLane:
    optimizer = RejectionSamplingOptimizer(
        constructs=[Construct([binder], label=f"lane_{binder.label}")],
        generators=[generator],
        constraints=[Constraint(
            inputs=[binder],
            function=protein_diversity_constraint,
            function_config=ProteinDiversityConfig(min_diversity=0.0),
        )],
        config=RejectionSamplingOptimizerConfig(num_samples=1, num_results=1, proposal_batch_size=1),
    )
    return ProtoPortfolioLane(
        program=Program(optimizers=[optimizer], num_results=1, seed=ctx.seeds[0], compute=nullcontext()),
        maximum_candidates=1,
        maximum_gpu_seconds=seconds,
    )


def build_trial(ctx: TrialContext) -> ProtoTrial:
    if ctx.target_artifact_path is None or ctx.target_structure_path is None:
        raise ValueError("Binder generation requires the frozen target artifact and structure")
    target = json.loads(ctx.target_artifact_path.read_text(encoding="utf-8"))
    structure = Structure(structure=ctx.target_structure_path.read_text(encoding="utf-8"))
    chain = target["chains"][0]["id"]
    hotspots = [residue["position"] for residue in target["bindingSite"]["residues"]]

    freebindcraft_binder = Segment(length=15, sequence_type="protein", label="freebindcraft")
    freebindcraft = FreeBindCraftGenerator(FreeBindCraftGeneratorConfig(
        target_structure=structure,
        target_chain=chain,
        target_hotspot_residues=",".join(str(position) for position in hotspots),
        design_config={
            "max_trajectories": 12,
            "filter_overrides": {
                "iptm": 0.2,
                "ptm": 0.4,
                "pae_inter": 10.0,
                "plddt": 0.6,
                "res_plddt": 0.5,
            },
        },
    ))
    freebindcraft.assign(freebindcraft_binder)

    rfdiffusion_binder = Segment(length=15, sequence_type="protein", label="rfdiffusion")
    rfdiffusion = RFdiffusionMPNNBinderGenerator(RFdiffusionMPNNBinderGeneratorConfig(
        target_structure=structure,
        target_chains=[chain],
        hotspots=[f"{chain}{position}" for position in hotspots],
        inverse_folding="proteinmpnn",
        rfdiffusion3_config=RFdiffusion3Config(
            diffusion_batch_size=1,
            n_batches=1,
            num_timesteps=30,
            low_memory_mode=True,
        ),
        proteinmpnn_config=ProteinMPNNSampleConfig(num_sequences_per_structure=1, batch_size=1),
    ))
    rfdiffusion.assign(rfdiffusion_binder)

    return ProtoTrial(
        hypothesis=(
            "A 12-trajectory FreeBindCraft search will reveal durable dominant rejection filters and, "
            "if it accepts a design, improve the frozen locked objective relative to the RFdiffusion control lane."
        ),
        intent="optimize",
        program=ProtoPortfolioProgram([
            _lane(ctx, freebindcraft, freebindcraft_binder, 900),
            _lane(ctx, rfdiffusion, rfdiffusion_binder, 900),
        ]),
    )
