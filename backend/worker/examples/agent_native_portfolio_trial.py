"""Agent-native Autofold trial: one returned object, no workflow manifest."""

from __future__ import annotations

import json
from contextlib import nullcontext

import autofold_worker.proto_generators  # registers external generator lanes
from autofold_worker.proto_generators import BoltzGenBinderConfig, BoltzGenBinderGenerator
from autofold_worker.proto_portfolio import ProtoPortfolioLane, ProtoPortfolioProgram
from autofold_worker.proto_trial import ProtoTrial, TrialContext
from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools.entities.structures import Structure


def build_trial(ctx: TrialContext) -> ProtoTrial:
    if ctx.target_artifact_path is None or ctx.target_structure_path is None:
        raise ValueError("Binder generation requires the frozen target artifact and structure")
    target = json.loads(ctx.target_artifact_path.read_text(encoding="utf-8"))
    target_structure = Structure(structure=ctx.target_structure_path.read_text(encoding="utf-8"))
    hotspots = [residue["position"] for residue in target["bindingSite"]["residues"]]

    binder = Segment(length=15, sequence_type="protein", label="binder")
    generator = BoltzGenBinderGenerator(BoltzGenBinderConfig(
        target_structure=target_structure,
        target_chain=target["chains"][0]["id"],
        hotspots=hotspots,
        protocol="peptide-anything",
        scaffold="linear",
    ))
    generator.assign(binder)
    diversity = Constraint(
        inputs=[binder],
        function=protein_diversity_constraint,
        function_config=ProteinDiversityConfig(min_diversity=0.0),
    )
    optimizer = RejectionSamplingOptimizer(
        constructs=[Construct([binder], label="boltzgen-lane")],
        generators=[generator],
        constraints=[diversity],
        config=RejectionSamplingOptimizerConfig(
            num_samples=ctx.candidate_budget,
            num_results=ctx.candidate_budget,
            proposal_batch_size=min(3, ctx.candidate_budget),
        ),
    )
    program = Program(
        optimizers=[optimizer],
        num_results=ctx.candidate_budget,
        seed=ctx.seeds[0],
        compute=nullcontext(),
    )
    portfolio = ProtoPortfolioProgram([
        ProtoPortfolioLane(
            program=program,
            maximum_candidates=ctx.candidate_budget,
            maximum_gpu_seconds=3600,
        )
    ])
    return ProtoTrial(
        hypothesis=(
            "A full-budget BoltzGen linear-peptide lane will improve the locked "
            "panel score relative to the current incumbent under the unchanged contract."
        ),
        intent="optimize",
        program=portfolio,
    )
