"""Small native Proto search: DNA GC constraints, CPU only, no model downloads."""
from contextlib import nullcontext
import json

from proto_language.core import Construct, Program, Segment
from proto_language.constraint import ConstraintRegistry
from proto_language.generator import RandomNucleotideGenerator, RandomNucleotideGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig


def main():
    segment = Segment(sequence="ATGCATGCATGC", sequence_type="dna", label="design")
    construct = Construct([segment], label="construct")
    generator = RandomNucleotideGenerator(RandomNucleotideGeneratorConfig())
    generator.assign(segment)
    constraint = ConstraintRegistry.create(
        key="gc-content", segments=[segment], config_dict={"min_gc": 20, "max_gc": 80}
    )
    optimizer = RejectionSamplingOptimizer(
        constructs=[construct], generators=[generator], constraints=[constraint],
        config=RejectionSamplingOptimizerConfig(num_samples=4, num_results=2),
    )
    program = Program([optimizer], num_results=2, seed=7, compute=nullcontext())
    program.run()
    print(json.dumps({"sequences": [s.sequence for s in construct.joined_sequences]}))


if __name__ == "__main__":
    main()
