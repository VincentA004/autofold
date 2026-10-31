"""CPU-only native proposal recipe; no biological measurements or model downloads.

Illustrative premise: evidence motivates changing nominated positions while
preserving the rest. Replace the synthetic parent/positions with justified inputs.
Positions are 1-based. Filter scores encode violations, never predicted affinity.
"""
from contextlib import nullcontext
import json

from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools.transforms.masking import MaskingStrategy


def run_example(parent="ACDEFGHIK", mutable_positions=(4, 6), num_samples=12):
    mutable = set(mutable_positions)
    if not mutable or not mutable <= set(range(1, len(parent) + 1)):
        raise ValueError("Supply nonempty 1-based positions within the parent")

    def permitted_change(input_sequences, config):
        outputs = []
        for (sequence,) in input_sequences:
            changes = [i for i, (a, b) in enumerate(zip(parent, sequence.sequence), 1) if a != b]
            valid = len(sequence.sequence) == len(parent) and len(changes) == 1 and set(changes) <= mutable
            outputs.append(ConstraintOutput(
                score=0.0 if valid else 1.0,
                metadata={"changed_positions_1based": changes, "admissible": valid},
            ))
        return outputs

    segment = Segment(sequence=parent, sequence_type="protein", label="candidate")
    generator = RandomProteinGenerator(RandomProteinGeneratorConfig(
        masking_strategy=MaskingStrategy(
            num_mutations=1,
            fixed_positions=[i for i in range(1, len(parent) + 1) if i not in mutable],
        ),
    ))
    generator.assign(segment)
    gate = Constraint(inputs=[segment], function=permitted_change,
                      threshold=0.0, label="permitted_single_change")
    optimizer = RejectionSamplingOptimizer(
        constructs=[Construct([segment])], generators=[generator], constraints=[gate],
        config=RejectionSamplingOptimizerConfig(
            num_samples=num_samples, num_results=num_samples,
            proposal_batch_size=1, track_proposals=True,
        ),
    )
    program = Program([optimizer], num_results=num_samples, seed=7, compute=nullcontext())
    program.run()
    # Keep every passing proposal before deduplication; no ranking or affinity reward.
    return {
        "parent_reference": parent,
        "mutable_positions_1based": sorted(mutable),
        "proposal_budget": num_samples,
        "candidates_unranked": sorted({s.sequence for s in segment.result_sequences}),
        "biological_improvement": "unmeasured",
        "proposal_history": optimizer.history,
    }


if __name__ == "__main__":
    print(json.dumps(run_example(), indent=2))
