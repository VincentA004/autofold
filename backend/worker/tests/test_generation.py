from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from autofold_worker.generation import capture


class GenerationCaptureTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
