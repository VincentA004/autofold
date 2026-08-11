"""Compatibility tests for the trusted Boltz-2 evidence adapter."""

from __future__ import annotations

import unittest
import json
import tempfile
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

from autofold_worker.evidence_boltz2_v1 import _enrich_v4, _structure_cif


class StructureCifCompatibilityTest(unittest.TestCase):
    def test_reads_current_string_property(self) -> None:
        class CurrentStructure:
            structure_cif = "data_current\n#\n"

        self.assertEqual(_structure_cif(CurrentStructure()), "data_current\n#\n")

    def test_reads_legacy_callable(self) -> None:
        class LegacyStructure:
            def structure_cif(self) -> str:
                return "data_legacy\n#\n"

        self.assertEqual(_structure_cif(LegacyStructure()), "data_legacy\n#\n")

    def test_executes_a_frozen_proto_registry_graph_and_records_a_conditional_skip(self) -> None:
        class Model:
            model_fields = {"seed": object(), "timeout": object()}

            def __init__(self, **values: object) -> None:
                self.values = values

            def model_dump(self, mode: str) -> dict[str, object]:
                return self.values

        class Input:
            def __init__(self, **values: object) -> None:
                self.values = values

        class Metrics:
            def model_dump(self, mode: str) -> dict[str, float]:
                return {"iptm": 0.8, "ptm": 0.7}

        class Structure:
            structure_cif = "data_dynamic\n#\n"
            metrics = Metrics()

        spec = SimpleNamespace(
            category="structure_prediction",
            config_model=Model,
            input_model=Input,
            function=lambda inputs, config: SimpleNamespace(success=True, structures=[Structure()]),
        )

        class Registry:
            @staticmethod
            def get(key: str) -> object:
                self.assertEqual(key, "boltz2-prediction")
                return spec

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target.json"
            target.write_text(json.dumps({"chains": [{"sequence": "ACDEFG"}]}), encoding="utf-8")
            bundle = {
                "format": "autofold.trial-bundle.v4",
                "runId": "run_dynamic",
                "trialId": "trl_dynamic",
                "targetArtifactHash": "sha256:" + "a" * 64,
                "targetArtifactPath": str(target),
                "evidenceAdapter": {"sourceHash": "sha256:" + "b" * 64},
                "proto": {"languageCommit": "c" * 40, "toolsCommit": "d" * 40},
                "programHash": "sha256:" + "e" * 64,
                "pipelineHash": "sha256:" + "f" * 64,
                "modality": "short_peptide",
                "seeds": [7],
                "pipeline": {
                    "stages": [
                        {
                            "id": "primary",
                            "models": [{"id": "boltz2-prediction", "toolKey": "boltz2-prediction", "version": "d" * 40}],
                            "dependsOn": [],
                            "required": True,
                            "allowSkip": False,
                            "allowedSkips": [],
                            "budget": {"maximumGpuSeconds": 10},
                        },
                        {
                            "id": "resolve",
                            "models": [{"id": "boltz2-prediction", "toolKey": "boltz2-prediction", "version": "d" * 40}],
                            "dependsOn": ["primary"],
                            "condition": {"source": "primary", "metric": "iptm", "operator": "gt", "value": 0.9},
                            "candidateRouting": {"source": "primary", "metric": "iptm", "direction": "maximize", "maximumCandidates": 1},
                            "required": False,
                            "allowSkip": True,
                            "allowedSkips": ["condition_false", "candidate_filtered"],
                            "budget": {"maximumGpuSeconds": 10},
                        },
                    ]
                },
            }
            candidates = {
                "format": "autofold.candidate-set.v1",
                "candidates": [
                    {"id": "cand_one", "sequence": "ACDEFGHIK"},
                    {"id": "cand_two", "sequence": "LMNPQRSTV"},
                ],
            }
            enriched = _enrich_v4(bundle, candidates, root / "output", Registry)
            index = json.loads((root / "output" / "model-runs" / "index.json").read_text(encoding="utf-8"))
            self.assertEqual([entry["status"] for entry in index["entries"]], ["completed", "completed", "skipped", "skipped"])
            self.assertEqual([entry.get("kind") for entry in index["entries"][2:]], ["condition_false", "candidate_filtered"])
            self.assertEqual(len(enriched["candidates"][0]["evidence"]["predictors"]), 1)

    def test_records_cold_start_wall_time_without_reinterpreting_it_as_gpu_time(self) -> None:
        class Model:
            model_fields = {"timeout": object()}

            def __init__(self, **values: object) -> None:
                self.values = values

            def model_dump(self, mode: str) -> dict[str, object]:
                return self.values

        class Metrics:
            def model_dump(self, mode: str) -> dict[str, float]:
                return {"iptm": 0.8, "ptm": 0.7}

        spec = SimpleNamespace(
            category="structure_prediction",
            config_model=Model,
            input_model=lambda **values: values,
            function=lambda inputs, config: SimpleNamespace(
                success=True,
                structures=[SimpleNamespace(structure_cif="data_cold\n#\n", metrics=Metrics())],
            ),
        )

        class Registry:
            @staticmethod
            def get(key: str) -> object:
                return spec

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target.json"
            target.write_text(json.dumps({"chains": [{"sequence": "ACDEFG"}]}), encoding="utf-8")
            bundle = {
                "format": "autofold.trial-bundle.v4",
                "runId": "run_cold",
                "trialId": "trl_cold",
                "targetArtifactHash": "sha256:" + "a" * 64,
                "targetArtifactPath": str(target),
                "evidenceAdapter": {"sourceHash": "sha256:" + "b" * 64},
                "proto": {"languageCommit": "c" * 40, "toolsCommit": "d" * 40},
                "programHash": "sha256:" + "e" * 64,
                "pipelineHash": "sha256:" + "f" * 64,
                "modality": "short_peptide",
                "seeds": [7],
                "pipeline": {"stages": [{
                    "id": "primary",
                    "models": [{"id": "boltz2-prediction", "toolKey": "boltz2-prediction", "version": "d" * 40}],
                    "dependsOn": [],
                    "required": True,
                    "allowSkip": False,
                    "allowedSkips": [],
                    "budget": {"maximumGpuSeconds": 10},
                }]},
            }
            candidates = {"candidates": [{"id": "cand_one", "sequence": "ACDEFGHIK"}]}
            with patch("autofold_worker.evidence_boltz2_v1.time.monotonic", side_effect=[0.0, 20.0]):
                _enrich_v4(bundle, candidates, root / "output", Registry)
            artifact = next((root / "output" / "model-runs").glob("**/model-run.json"))
            self.assertEqual(json.loads(artifact.read_text())["runtime"]["wallSeconds"], 20.0)


if __name__ == "__main__":
    unittest.main()
