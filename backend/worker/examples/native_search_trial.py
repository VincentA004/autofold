"""Two native refinement stages. Authoring example; no run() during construction.

CPU sequence penalties demonstrate search semantics, not biological improvement.
The trusted host adds the independently frozen evaluator. New GPU work requires
its own grant; this example does not select a GPU model or perform an assay.
"""
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.constraint import protein_length_constraint, protein_repetitiveness_constraint
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import MCMCOptimizer, MCMCOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeSearch, NativeOutput


def build_trial(ctx):
    region = Segment(length=12, sequence_type="protein", label="binder")
    design = Construct([region], label="design")
    stages = []
    for seed in (2718, 3141):
        generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
        generator.assign(region)
        stages.append(MCMCOptimizer(constructs=[design], generators=[generator], constraints=[
            Constraint(inputs=[region], function=protein_length_constraint,
                function_config={"min_length": 12, "max_length": 12}, threshold=0.0, label="length_gate"),
            Constraint(inputs=[region], function=protein_repetitiveness_constraint,
                function_config={}, weight=1.0, label="repeat_penalty"),
        ], config=MCMCOptimizerConfig(num_results=1, num_steps=3, proposals_per_result=2, seed=seed, track_proposals=True)))
    return ProtoTrial(program=Program(optimizers=stages, num_results=1),
        hypothesis="Native two-stage mutation search can retain one length-valid design while exposing every repetition penalty; this does not predict binding improvement.",
        search=NativeSearch(maximum_candidates=1, maximum_proposals=32,
            maximum_sampling_calls=16, maximum_tool_calls=16, maximum_wall_seconds=30,
            outputs=(NativeOutput(construct="design"),), allowed_tools=("random-protein-sample",)))
