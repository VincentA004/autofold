from __future__ import annotations
import json
import unittest
from types import SimpleNamespace
from autofold_worker.proto_model_registry import tool_card, generator_card, assert_input_requirements
from autofold_worker.proto_trial import DiagnosticStage

class Input:
    SUPPORTED_ENTITY_TYPES = {"protein", "ligand"}
    @classmethod
    def model_json_schema(cls):
        return {"properties": {"complexes": {"type": "array"}, "msas": {}}, "$defs": {"Molecule": {"properties": {"cyclic": {"type": "boolean"}, "covalent_bonds": {"type": "array"}}}}}
class Config:
    @classmethod
    def model_json_schema(cls):
        return {"properties": {"seed": {"type": "integer", "default": 5}, "api_key": {"type": "string", "default": "fixture-private-key", "examples": ["fixture-private-key"]}}}
class Registry:
    calls = 0
    @classmethod
    def get_license(cls, key):
        return {"code": {"spdx": "MIT"}, "commercial_use": "yes"}
    @classmethod
    def get_links(cls, key):
        return {"github": "https://example.invalid/model"}

def spec(key="boltz2-prediction"):
    return SimpleNamespace(key=key, category="structure_prediction", uses_gpu=True, input_model=Input, config_model=Config, output_model=Input, metrics_model=SimpleNamespace(metric_spec={"iptm": {"type": "float", "description": "Interface confidence", "better_values_are": "higher"}}), function=lambda *_: (_ for _ in ()).throw(AssertionError("No inference allowed")))

class ModelRegistryTests(unittest.TestCase):
    def test_native_topology_and_adapter_fidelity_are_separate_without_inference(self):
        card=tool_card(spec(), Registry)
        self.assertTrue(card["nativeFeatures"]["cyclic_bonds"])
        self.assertIsNone(card["nativeFeatures"]["disulfide_bonds"])
        self.assertFalse(card["bridgeFeatures"]["cyclic_bonds"])
        self.assertFalse(card["bridgeFeatures"]["msa_artifacts"])
        self.assertTrue(card["bridgeFeatures"]["complex_sequences"])
        self.assertIsNone(card["resourceProfile"])
        self.assertEqual(card["assetReadiness"], "unknown")
        self.assertEqual(card["weightLicenseStatus"], "unverified")
        self.assertNotIn("fixture-private-key", json.dumps(card))
        self.assertEqual(card["seedFields"], ["seed"])
        self.assertIsNone(card["metrics"][0]["unit"])
        self.assertEqual(card["metrics"][0]["direction"], "higher")
    def test_required_chemistry_fails_before_model_dispatch(self):
        assert_input_requirements(spec(), ["complex_sequences"])
        for feature in ["cyclic_bonds", "disulfide_bonds", "glycans", "msa_artifacts", "structure_templates"]:
            with self.assertRaisesRegex(ValueError, "cannot preserve required inputs"):
                assert_input_requirements(spec(), [feature])
        with self.assertRaisesRegex(ValueError, "Invalid required"):
            assert_input_requirements(spec(), ["made_up_feature"])
    def test_generator_assets_and_checkpoint_identity_are_unknown(self):
        card=generator_card(SimpleNamespace(key="fixture-generator", uses_gpu=True, config_model=Config, tools_called=["fixture-tool"]))
        self.assertEqual(card["toolsCalled"], ["fixture-tool"])
        self.assertEqual(card["roles"], ["candidate_generation"])
        self.assertTrue(all(value is None for value in card["bridgeFeatures"].values()))
        self.assertNotIn("fixture-private-key", json.dumps(card))
    def test_rna_complex_schema_cannot_establish_protein_input_support(self):
        class RnaInput(Input):
            SUPPORTED_ENTITY_TYPES={"rna"}
        rna=spec("rna-predictor"); rna.input_model=RnaInput
        card=tool_card(rna, Registry)
        self.assertFalse(card["nativeFeatures"]["protein_sequences"])
        self.assertFalse(card["bridgeFeatures"]["complex_sequences"])
        with self.assertRaisesRegex(ValueError, "cannot preserve"):
            assert_input_requirements(rna,["complex_sequences"])

    def test_affinity_head_is_not_labeled_as_a_peptide_binding_scorer(self):
        card=tool_card(spec("boltz2-affinity"), Registry)
        self.assertEqual(card["roles"], ["small_molecule_affinity_prediction"])
        self.assertTrue(any("ligand input" in text for text in card["limitations"]))

    def test_protenix_variant_terms_are_not_certified_by_generic_tool_license(self):
        card=tool_card(spec("protenix-prediction"), Registry)
        self.assertEqual(card["weightLicenseStatus"], "unverified")
        self.assertTrue(any("v2" in text for text in card["limitations"]))
    def test_diagnostic_declaration_roundtrips_requirements_and_rejects_unknowns(self):
        stage=DiagnosticStage(id="probe", tools=("boltz2-prediction",), required_input_features=("cyclic_bonds",))
        self.assertEqual(stage.autofold_plan()["inputRequirements"], {"features": ["cyclic_bonds"]})
        self.assertNotIn("inputRequirements", DiagnosticStage(id="probe", tools=("boltz2-prediction",)).autofold_plan())
        for requirements in [("bogus",), ("cyclic_bonds", "cyclic_bonds")]:
            with self.assertRaisesRegex(ValueError, "unique supported"):
                DiagnosticStage(id="probe", tools=("boltz2-prediction",), required_input_features=requirements)

class WorkerRequirementGateTests(unittest.TestCase):
    def test_evidence_bridge_rejects_before_any_native_model_function(self):
        import tempfile
        from pathlib import Path
        from autofold_worker.evidence_pipeline_v3 import _enrich_v4
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            target=root/'target.json'; target.write_text(json.dumps({"chains": [{"sequence": "ACDE"}]}))
            bundle={"targetArtifactPath": str(target), "evidenceAdapter": {"sourceHash": "fixture"}, "proto": {"toolsCommit": "fixture"},
                    "pipeline": {"stages": [{"inputRequirements": {"features": ["cyclic_bonds"]}, "models": [{"id": "boltz2-prediction"}]}]}}
            registry=SimpleNamespace(get=lambda key: spec(key))
            with self.assertRaisesRegex(ValueError, "cannot preserve required inputs"):
                _enrich_v4(bundle, {"candidates": [{"id": "one", "sequence": "ACDE"}]}, root/'output', registry)
            self.assertFalse((root/'output').exists())

if __name__ == '__main__':
    unittest.main()
