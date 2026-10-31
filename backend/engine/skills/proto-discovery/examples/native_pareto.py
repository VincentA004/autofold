"""CPU-only native selection fixture; synthetic scores, no biological claims.

Usage: PROTO_PYTHON native_pareto.py
Four fixed sequences represent three tradeoffs and one dominated point. Native GA
owns evaluation and NSGA-II survivor selection. No model calls or discovery occur.
"""
from contextlib import nullcontext
import json
import math

from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment, Sequence
from proto_language.optimizer import GeneticAlgorithmOptimizer, GeneticAlgorithmOptimizerConfig


SYNTHETIC_LOSSES = {
    "AAAA": (0.1, 0.8),
    "CCCC": (0.8, 0.1),
    "GGGG": (0.5, 0.5),
    "TTTT": (0.9, 0.9),
}


def first_loss(input_sequences, config):
    return [ConstraintOutput(score=SYNTHETIC_LOSSES[seq.sequence][0],
                             metadata={"synthetic": True, "axis": "first"})
            for (seq,) in input_sequences]


def second_loss(input_sequences, config):
    return [ConstraintOutput(score=SYNTHETIC_LOSSES[seq.sequence][1],
                             metadata={"synthetic": True, "axis": "second"})
            for (seq,) in input_sequences]


def history_for_json(value):
    """Tag diagnostic rejection sentinels without changing native selection scores."""
    if isinstance(value, float) and not math.isfinite(value):
        return {"nonfinite": repr(value)}
    if isinstance(value, dict):
        return {key: history_for_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [history_for_json(item) for item in value]
    return value


def run_example(num_results=4, reject_sequences=()):
    evaluated = set()

    def eligible(input_sequences, config):
        evaluated.update(seq.sequence for (seq,) in input_sequences)
        return [ConstraintOutput(score=1.0 if seq.sequence in reject_sequences else 0.0,
                                 metadata={"synthetic": True})
                for (seq,) in input_sequences]

    segment = Segment(sequence="AAAA", sequence_type="protein", label="candidate")
    optimizer = GeneticAlgorithmOptimizer(
        constructs=[Construct([segment])], generators=[],
        constraints=[
            Constraint(inputs=[segment], function=eligible, threshold=0.0, label="eligible"),
            Constraint(inputs=[segment], function=first_loss, label="first_loss"),
            Constraint(inputs=[segment], function=second_loss, label="second_loss"),
        ],
        config=GeneticAlgorithmOptimizerConfig(
            num_generations=1, population_size=4, offspring_per_generation=4,
            num_results=num_results, crossover_rate=0.0, survivor_selection="nsga2",
            tracking_interval=1, track_proposals=True,
        ),
    )
    program = Program(optimizers=[optimizer], num_results=num_results, seed=7, compute=nullcontext())
    # Constructors initialize pools; seed after construction to preserve all inputs.
    segment.result_sequences = [Sequence(sequence=s, sequence_type="protein") for s in SYNTHETIC_LOSSES]
    program.run()
    return {
        "scope": "Synthetic native Pareto selection fixture, not peptide fitness.",
        "initial_objectives": SYNTHETIC_LOSSES,
        "evaluated_sequences": sorted(evaluated),
        "survivors": [{"sequence": seq.sequence, "losses": SYNTHETIC_LOSSES[seq.sequence],
                       "native_objectives": {label: seq._constraints_metadata[label]['weighted_score']
                                             for label in ('first_loss', 'second_loss')}}
                      for seq in segment.result_sequences],
        "native_history_snapshots": len(optimizer.history),
        "native_history_tagged": history_for_json(optimizer.history),
    }


if __name__ == "__main__":
    print(json.dumps(run_example(), indent=2, allow_nan=False))
