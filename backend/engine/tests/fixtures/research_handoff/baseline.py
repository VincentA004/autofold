"""Baseline method: select from the library using head u, pending calibration.

This is a native Proto screening trial, not a biological design method. The
applicability of u to destination cell B is an unverified starting assumption.
"""
from contextlib import nullcontext
import json
from pathlib import Path
from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment, Sequence
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from toolbox import LIBRARY, predict_response

HEAD = 'u'


def response_loss(input_sequences, config):
    return [ConstraintOutput(score=1.0-predict_response(seq.sequence, HEAD),
                             metadata={'head': HEAD, 'synthetic': True})
            for (seq,) in input_sequences]


response_loss._constraint_supported_sequence_types = {'dna'}
response_loss._constraint_num_input_sequences_per_tuple = 1


def main():
    segment = Segment(sequence=LIBRARY[0], sequence_type='dna', label='design')
    segment.result_sequences = [Sequence(sequence=s, sequence_type='dna') for s in LIBRARY]
    construct = Construct([segment], label='candidate')
    constraint = Constraint(inputs=[segment], function=response_loss, label='response_loss')
    optimizer = RejectionSamplingOptimizer(
        constructs=[construct], generators=[], constraints=[constraint],
        config=RejectionSamplingOptimizerConfig(num_samples=len(LIBRARY), num_results=1,
                                                tracking_interval=1, track_proposals=True))
    program = Program([optimizer], num_results=1, seed=7, compute=nullcontext())
    program.run()
    result = {'scope': 'synthetic fixture only', 'head': HEAD,
              'selected': [s.sequence for s in segment.result_sequences],
              'responses': {s: predict_response(s, HEAD) for s in LIBRARY},
              'history_snapshots': len(optimizer.history)}
    Path('output').mkdir(exist_ok=True)
    Path('output/result.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
