"""Exercise scientist-facing discovery in a fresh process; no model inference."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "skills/proto-discovery/scripts"
INSPECT = SCRIPTS / "inspect_proto.py"


class InspectionTests(unittest.TestCase):
    def inspect(self, *args):
        result = subprocess.run(
            [sys.executable, str(INSPECT), *args],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return json.loads(result.stdout)

    def test_default_discovery_includes_bridges_and_keeps_native_alternatives(self):
        result = self.inspect("search", "--kind", "generator", "--limit", "50")
        keys = {item["key"] for item in result["items"]}
        self.assertTrue({"rfd4-binder", "boltzgen-binder", "rfantibody-binder", "antifold", "proteinmpnn", "esm2"} <= keys)
        self.assertEqual(len(keys), len(result["items"]))

    def test_bridge_schemas_are_inspectable_without_running_the_cli(self):
        rfd4 = self.inspect("describe", "generator", "rfd4-binder", "--schema")
        self.assertTrue({"design_spec", "binder_chain", "target_chain", "target_sequence"}
                        <= set(rfd4["config_schema"]["required"]))
        properties = rfd4["config_schema"]["properties"]
        self.assertEqual(properties["mode"]["default"], "generation")
        self.assertEqual(set(properties["mode"]["enum"]), {"generation", "guided_search"})
        self.assertIn("search_spec", properties)
        boltzgen = self.inspect("describe", "generator", "boltzgen-binder", "--schema")
        self.assertEqual(set(boltzgen["config_schema"]["properties"]["protocol"]["enum"]),
                         {"peptide-anything", "protein-anything"})

    def test_explicit_bundled_extension_remains_compatible_and_is_not_registered_twice(self):
        extension = str(SCRIPTS / "model_generators.py")
        result = self.inspect("--extension", extension, "--extension", extension,
                              "search", "rfd4", "--kind", "generator")
        self.assertEqual([item["key"] for item in result["items"]], ["rfd4-binder", "rfd4-redesign"])

    def test_prediction_tools_still_expose_native_configuration_and_inputs(self):
        for key in ("boltz2-prediction", "protenix-prediction", "esmfold2-prediction"):
            with self.subTest(key=key):
                result = self.inspect("describe", "tool", key, "--schema")
                self.assertIn("config_schema", result)
                self.assertIn("input", result)
                self.assertIn("output", result)

    def test_local_affinity_is_discoverable_with_explicit_runtime_and_evidence(self):
        result = self.inspect("describe", "tool", "prodigy-affinity", "--schema")
        config = result["config_schema"]
        self.assertIn("output_dir", config["required"])
        self.assertNotIn("python_executable", config["properties"])
        self.assertNotIn("device", config["properties"])
        self.assertNotIn('python_executable',result['config']['signature'])
        self.assertFalse(result["uses_gpu"])
        operator = self.inspect('describe','tool','prodigy-affinity','--schema','--operator')
        self.assertIn('python_executable',operator['config_schema']['properties'])

    def test_runtime_implementation_is_not_a_scientist_model_choice(self):
        result = self.inspect('search','bioir','--kind','tool')
        self.assertEqual(result['total_matches'],0)
        native = self.inspect('describe','tool','boltz2-prediction','--schema')
        self.assertIn('step_scale',native['config_schema']['properties'])

    def test_antibody_schemas_expose_actual_chain_and_runtime_requirements(self):
        rfa = self.inspect("describe", "generator", "rfantibody-binder", "--schema")
        self.assertIn("expected_fixed_chains", rfa["config_schema"]["required"])
        anti = self.inspect("describe", "generator", "antifold", "--schema")
        self.assertIn("mutable_positions", anti["config_schema"]["required"])
        self.assertNotIn("python_executable", anti["config_schema"]["properties"])

    def test_discovery_does_not_start_model_worker_processes(self):
        bootstrap = (
            "import runpy,sys\n"
            "from unittest.mock import patch\n"
            f"sys.argv=[{str(INSPECT)!r},'search','rfd4']\n"
            "with patch('subprocess.Popen', side_effect=AssertionError('worker launched')):\n"
            f" runpy.run_path({str(INSPECT)!r},run_name='__main__')\n"
        )
        result = subprocess.run([sys.executable, "-c", bootstrap], capture_output=True,
                                text=True, timeout=30, check=True)
        self.assertEqual(json.loads(result.stdout)["items"][0]["key"], "rfd4-binder")


if __name__ == "__main__":
    unittest.main()
