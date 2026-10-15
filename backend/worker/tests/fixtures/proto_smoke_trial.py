"""Small deterministic CPU-only Proto program used by Autofold integration tests."""

from contextlib import nullcontext

from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import (
    ProteinDiversityConfig,
)
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import (
    RejectionSamplingOptimizer,
    RejectionSamplingOptimizerConfig,
)


def _build_program(bundle):
    """Express one cheap peptide design loop as a real Proto Program."""
    result_count = min(bundle["submissionSize"], bundle["candidateBudget"])
    peptide = Segment(length=24, sequence_type="protein", label="designed-peptide")
    construct = Construct([peptide], label="candidate")

    generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
    generator.assign(peptide)
    diversity = Constraint(
        inputs=[peptide],
        function=protein_diversity_constraint,
        function_config=ProteinDiversityConfig(min_diversity=0.4),
    )
    optimizer = RejectionSamplingOptimizer(
        constructs=[construct],
        generators=[generator],
        constraints=[diversity],
        config=RejectionSamplingOptimizerConfig(
            num_samples=bundle["candidateBudget"],
            num_results=result_count,
            proposal_batch_size=min(4, bundle["candidateBudget"]),
        ),
    )
    return Program(
        optimizers=[optimizer],
        num_results=result_count,
        seed=bundle["seeds"][0],
        compute=nullcontext(),
    )



def build_trial(ctx):
    from autofold_worker.proto_trial import ProtoTrial, NativeSearch, NativeOutput
    return ProtoTrial(program=_build_program(ctx), hypothesis="Bounded native CPU diversity search preserves original optimizer settings",
        search=NativeSearch(maximum_candidates=ctx.candidate_budget, maximum_proposals=ctx.candidate_budget*4,
            maximum_sampling_calls=ctx.candidate_budget*4, maximum_tool_calls=ctx.candidate_budget*4,
            maximum_wall_seconds=30, outputs=(NativeOutput("candidate"),), allowed_tools=("random-protein-sample",)))
