"""Deterministic Proto fixture exercising Peptide Candidate Artifact v1.

Evidence values are synthetic integration fixtures, not biological predictions.
Real model adapters must replace these values in production trials.
"""

import hashlib
from contextlib import nullcontext

from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig


def _digest(label):
    return "sha256:" + hashlib.sha256(label.encode("utf-8")).hexdigest()


def build_program(bundle):
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


def extract_candidates(program, bundle):
    sequences = [
        sequence.sequence
        for construct in program.constructs
        for sequence in construct.joined_sequences
    ]
    output = []
    for index, sequence in enumerate(sequences):
        quality = 0.82 - index * 0.04
        output.append(
            {
                "sequence": sequence,
                "seed": bundle["seeds"][index % len(bundle["seeds"])],
                "generation": {
                    "model": "integration-fixture-generator",
                    "version": "1",
                    "artifactHash": _digest("generation:" + sequence),
                    "parametersHash": _digest("parameters:v1"),
                },
                "evidence": {
                    "interfaceConfidence": quality,
                    "foldConfidence": quality - 0.03,
                    "predictorAgreement": quality - 0.08,
                    "solubility": 0.72,
                    "aggregationRisk": 0.18 + index * 0.03,
                    "synthesisRisk": 0.12 + index * 0.02,
                    "predictors": [
                        {
                            "model": "integration-fixture-predictor",
                            "version": "1",
                            "artifactHash": _digest("prediction:" + sequence),
                        }
                    ],
                },
            }
        )
    return output
