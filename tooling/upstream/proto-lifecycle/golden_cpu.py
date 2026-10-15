"""Native optimizer parity fixture runnable against either immutable dependency tree."""
from contextlib import nullcontext
import json
from proto_language.core import Construct, Program, Segment
from proto_language.constraint import ConstraintRegistry
from proto_language.generator import RandomNucleotideGenerator, RandomNucleotideGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig

results = []
for seed in (7, 17, 19):
    segment = Segment(sequence="ATGCATGCATGC", sequence_type="dna", label="design")
    construct = Construct([segment], label="construct")
    optimizers = []
    for count in (4, 3):
        generator = RandomNucleotideGenerator(RandomNucleotideGeneratorConfig())
        generator.assign(segment)
        constraint = ConstraintRegistry.create(key="gc-content", segments=[segment], config_dict={"min_gc": 20, "max_gc": 80})
        optimizers.append(RejectionSamplingOptimizer(constructs=[construct], generators=[generator], constraints=[constraint], config=RejectionSamplingOptimizerConfig(num_samples=count, num_results=2)))
    program = Program(optimizers, num_results=2, seed=seed, compute=nullcontext())
    program.run()
    results.append({"seed": seed, "sequences": [sequence.sequence for sequence in construct.joined_sequences], "scores": program.energy_scores, "settings": [optimizer.config.model_dump() for optimizer in optimizers]})
print(json.dumps(results, sort_keys=True, allow_nan=False))
