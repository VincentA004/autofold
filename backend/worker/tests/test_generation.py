from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from autofold_worker.generation import capture
from autofold_worker.generator_diagnostics import GeneratorDiagnosticsCapture
from autofold_worker.proto_portfolio import ProtoPortfolioLane, ProtoPortfolioProgram


class GenerationCaptureTest(unittest.TestCase):
    def test_captures_transient_freebindcraft_filter_diagnostics(self) -> None:
        previous = os.environ.get("TMPDIR")
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with GeneratorDiagnosticsCapture(output, enabled=True) as diagnostics:
                run = Path(os.environ["TMPDIR"]) / "bindcraft_test" / "designs"
                run.mkdir(parents=True)
                (run / "rejected_mpnn_full_stats.csv").write_text(
                    "Design,Sequence,Surface_Hydrophobicity,n_InterfaceResidues,pLDDT\n"
                    "one,AAAA,1,1,0\n"
                    "two,CCCC,1,0,1\n",
                    encoding="utf-8",
                )
                (run / "failure_csv.csv").write_text(
                    "Trajectory_final_pLDDT,Trajectory_InterfaceResidues\n2,1\n",
                    encoding="utf-8",
                )
                diagnostics.scan()
            summary = diagnostics.summary()

            self.assertFalse(diagnostics.root.exists())
            self.assertEqual(os.environ.get("TMPDIR"), previous)
            self.assertEqual(summary[0]["generator"], "freebindcraft")
            self.assertEqual(summary[0]["rejectedCandidates"], 2)
            self.assertEqual(summary[0]["rejectionFilters"], {
                "Surface_Hydrophobicity": 2,
                "n_InterfaceResidues": 1,
                "pLDDT": 1,
            })
            self.assertEqual(summary[0]["trajectoryFailures"], 3)

    def test_records_observed_generator_components_and_structure(self) -> None:
        class Config:
            def model_dump(self, mode: str) -> dict[str, object]:
                self.assert_mode(mode)
                return {"target_structure": "/host/target.pdb", "hotspots": ["A7"]}

            @staticmethod
            def assert_mode(mode: str) -> None:
                if mode != "json":
                    raise AssertionError(mode)

        sequence = SimpleNamespace(
            sequence="ACDEFGHIK",
            _generator_metadata={"rfdiffusion-mpnn-binder": {"contig": "A1-20,/0,9"}},
            structure=SimpleNamespace(structure_cif="data_generated\n#\n"),
        )
        generator = SimpleNamespace(
            _spec=SimpleNamespace(
                key="rfdiffusion-mpnn-binder",
                tools_called=["rfdiffusion3-design", "proteinmpnn-sample"],
            ),
            config=Config(),
        )
        program = SimpleNamespace(
            optimizers=[SimpleNamespace(generators=[generator])],
            constructs=[SimpleNamespace(segments=[SimpleNamespace(result_sequences=[sequence])])],
        )
        bundle = {
            "runId": "run_generation",
            "generationReplicateId": "grep_generation",
            "seeds": [7],
            "programHash": "sha256:" + "a" * 64,
            "targetArtifactHash": "sha256:" + "b" * 64,
            "proto": {"languageCommit": "c" * 40, "toolsCommit": "d" * 40},
            "pipeline": {
                "generation": {
                    "budget": {"maximumCandidates": 1, "maximumGpuSeconds": 10},
                    "generators": [
                        {
                            "id": "rfdiffusion-mpnn-binder",
                            "version": "c" * 40,
                            "toolsCalled": ["rfdiffusion3-design", "proteinmpnn-sample"],
                        }
                    ]
                }
            },
        }
        candidates = {
            "format": "autofold.candidate-set.v1",
            "candidates": [{"id": "pep_one", "sequence": "ACDEFGHIK", "seed": 7}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            captured = capture(bundle, candidates, program, output)
            index = json.loads((output / "generation-runs" / "index.json").read_text())
            entry = index["entries"][0]
            artifact_path = output / entry["artifactPath"]
            artifact = json.loads(artifact_path.read_text())
            artifact_hash = "sha256:" + hashlib.sha256(artifact_path.read_bytes()).hexdigest()

            self.assertEqual(entry["modelId"], "rfdiffusion-mpnn-binder")
            self.assertEqual(index["replicate"]["id"], "grep_generation")
            self.assertEqual(index["replicate"]["requestedSeeds"], [7])
            self.assertEqual(index["replicate"]["stochasticity"], "unknown")
            self.assertEqual(index["generatorDiagnostics"], [])
            self.assertTrue(index["replicate"]["realizedCandidateSetHash"].startswith("sha256:"))
            self.assertEqual(entry["artifactHash"], artifact_hash)
            self.assertEqual(captured["candidates"][0]["generation"]["artifactHash"], artifact_hash)
            self.assertEqual(artifact["generator"]["components"][0]["toolsCalled"], ["proteinmpnn-sample", "rfdiffusion3-design"])
            self.assertEqual(
                artifact["generator"]["components"][0]["parameters"]["config"]["target_structure"],
                {"targetArtifactHash": bundle["targetArtifactHash"]},
            )
            self.assertEqual(artifact["metadata"]["rfdiffusion-mpnn-binder"]["contig"], "A1-20,/0,9")
            self.assertTrue((output / entry["structurePath"]).is_file())

    def test_rejects_observed_generator_outside_frozen_policy(self) -> None:
        generator = SimpleNamespace(
            _spec=SimpleNamespace(key="unexpected-generator", tools_called=[]),
            config={},
        )
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])], constructs=[])
        bundle = {
            "runId": "run_generation",
            "programHash": "sha256:" + "a" * 64,
            "targetArtifactHash": "sha256:" + "b" * 64,
            "proto": {"languageCommit": "c" * 40, "toolsCommit": "d" * 40},
            "pipeline": {
                "generation": {
                    "budget": {"maximumCandidates": 1, "maximumGpuSeconds": 10},
                    "generators": [{"id": "declared-generator", "version": "c" * 40, "toolsCalled": []}]
                }
            },
        }
        candidates = {"candidates": []}
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "do not match frozen generation policy"):
                capture(bundle, candidates, program, Path(temporary))

    def test_enforces_candidate_allocation_for_generator_portfolios(self) -> None:
        def generator(key: str) -> SimpleNamespace:
            return SimpleNamespace(_spec=SimpleNamespace(key=key, tools_called=[]), config={})

        first = generator("generator-one")
        second = generator("generator-two")
        sequences = [
            SimpleNamespace(sequence="AAAA", _generator_metadata={"generator-one": {}}),
            SimpleNamespace(sequence="CCCC", _generator_metadata={"generator-one": {}}),
        ]
        program = SimpleNamespace(
            optimizers=[SimpleNamespace(generators=[first]), SimpleNamespace(generators=[second])],
            constructs=[SimpleNamespace(segments=[SimpleNamespace(result_sequences=sequences)])],
        )
        bundle = {
            "runId": "run_portfolio",
            "programHash": "sha256:" + "a" * 64,
            "targetArtifactHash": "sha256:" + "b" * 64,
            "proto": {"languageCommit": "c" * 40, "toolsCommit": "d" * 40},
            "pipeline": {
                "generation": {
                    "budget": {"maximumCandidates": 2, "maximumGpuSeconds": 20},
                    "generators": [
                        {
                            "id": "generator-one",
                            "version": "c" * 40,
                            "toolsCalled": [],
                            "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 10},
                        },
                        {
                            "id": "generator-two",
                            "version": "c" * 40,
                            "toolsCalled": [],
                            "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 10},
                        },
                    ],
                }
            },
        }
        candidates = {
            "candidates": [
                {"id": "one", "sequence": "AAAA", "seed": 1},
                {"id": "two", "sequence": "CCCC", "seed": 2},
            ]
        }
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "exceeded its frozen candidate allocation"):
                capture(bundle, candidates, program, Path(temporary))

    def test_uses_composite_lane_identity_instead_of_flattened_generator_metadata(self) -> None:
        def lane(key: str, sequence: str) -> ProtoPortfolioLane:
            generator = SimpleNamespace(
                _spec=SimpleNamespace(key=key, tools_called=[]),
                _autofold_generator_id=key,
                config={},
            )
            observed = SimpleNamespace(
                sequence=sequence,
                # Reproduce the ambiguous merged metadata that previously
                # made heterogeneous GPU portfolios terminally fail.
                _generator_metadata={"generator-one": {}, "generator-two": {}},
                structure=None,
            )
            program = SimpleNamespace(
                optimizers=[SimpleNamespace(generators=[generator])],
                constructs=[SimpleNamespace(segments=[SimpleNamespace(result_sequences=[observed])])],
                run=lambda: None,
            )
            return ProtoPortfolioLane(program, maximum_candidates=1, maximum_gpu_seconds=10)

        program = ProtoPortfolioProgram([lane("generator-one", "AAAA"), lane("generator-two", "CCCC")])
        bundle = {
            "runId": "run_direct_portfolio",
            "programHash": "sha256:" + "a" * 64,
            "targetArtifactHash": "sha256:" + "b" * 64,
            "proto": {"languageCommit": "c" * 40, "toolsCommit": "d" * 40},
            "pipeline": {
                "generation": {
                    "budget": {"maximumCandidates": 2, "maximumGpuSeconds": 20},
                    "generators": [
                        {
                            "id": "generator-one", "version": "c" * 40, "toolsCalled": [],
                            "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 10},
                        },
                        {
                            "id": "generator-two", "version": "c" * 40, "toolsCalled": [],
                            "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 10},
                        },
                    ],
                }
            },
        }
        candidates = {"candidates": [
            {"id": "one", "sequence": "AAAA", "seed": 1},
            {"id": "two", "sequence": "CCCC", "seed": 2},
        ]}
        with tempfile.TemporaryDirectory() as temporary:
            captured = capture(bundle, candidates, program, Path(temporary))
        self.assertEqual(
            [candidate["generation"]["model"] for candidate in captured["candidates"]],
            ["generator-one", "generator-two"],
        )


if __name__ == "__main__":
    unittest.main()
