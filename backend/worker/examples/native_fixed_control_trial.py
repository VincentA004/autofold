"""Native fixed CPU control; the host adds the independent frozen measurement."""
from contextlib import nullcontext
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.constraint import protein_length_constraint
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_trial import NativeFixedControl, NativeOutput, ProtoTrial

def build_trial(ctx):
    region = Segment(sequence="ACDEFGHIKLMN", sequence_type="protein", label="binder")
    design = Construct([region], label="control")
    optimizer = RejectionSamplingOptimizer(constructs=[design], generators=[], constraints=[
        Constraint(inputs=[region], function=protein_length_constraint,
                   function_config={"min_length":12,"max_length":12}, threshold=0.0),
    ], config=RejectionSamplingOptimizerConfig(proposal_source="existing_results", num_samples=1, num_results=1, proposal_batch_size=1))
    return ProtoTrial(program=Program([optimizer], num_results=1, compute=nullcontext()),
        hypothesis="The locked measurement can characterize this unchanged control without claiming improvement.",
        intent="negative_control", fixed_control=NativeFixedControl(maximum_wall_seconds=10, outputs=(NativeOutput("control"),)))
