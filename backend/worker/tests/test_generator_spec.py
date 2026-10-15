from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from autofold_worker.generator_spec import inspect_generator_specs, materialize_design_spec, preflight, run_generator_command, validate_materialized_spec


def pdb(numbers=(1, 2, 3), chain="A", residue="ALA"):
    return "".join(f"ATOM  {index:5d}  CA  {residue:3s} {chain}{number:4d}    {0:8.3f}{0:8.3f}{0:8.3f}  1.00 20.00           C\n" for index, number in enumerate(numbers, 1)) + "END\n"


class GeneratorSpecTests(unittest.TestCase):
    def test_exact_boltzgen_hotspots_reject_before_any_subprocess(self):
        request = {"generators": [{"id": "boltzgen-binder", "sequenceLength": 12, "targetPdb": pdb(), "config": {"target_chain": "A", "hotspots": [1, 4]}}]}
        with patch("autofold_worker.generator_spec.subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, r"requested hotspots \[4\].*outside"):
                preflight(request)
            run.assert_not_called()

    def test_reports_chain_positions_and_author_numbering_without_remapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = materialize_design_spec("boltzgen-binder", {"target_chain": "A", "hotspots": [1, 3]}, 12, Path(temporary), pdb((101, 103, 104)))
            specification = json.loads(path.read_text())
            self.assertEqual(specification["entities"][1]["file"]["binding_types"][0]["chain"]["binding"], "1,3")
            result = validate_materialized_spec("boltzgen-binder", path)
            self.assertEqual(result["targetChains"]["A"], {"residueCount": 3, "authorResidueIds": ["101", "103", "104"]})
            self.assertRegex(result["targetPdbHash"], r"^sha256:[a-f0-9]{64}$")

    def test_chain_and_noncanonical_residue_failures_are_actionable(self):
        for target, config, expected in [(pdb(), {"target_chain": "B"}, "absent"), (pdb(residue="UNK"), {}, "non-canonical.*X")]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as temporary:
                path = materialize_design_spec("boltzgen-binder", config, 12, Path(temporary), target)
                with self.assertRaisesRegex(ValueError, expected):
                    validate_materialized_spec("boltzgen-binder", path)

    def test_scaffold_validation_and_exact_native_serialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "at least 8"):
                materialize_design_spec("boltzgen-binder", {"scaffold": "disulfide_beta_hairpin"}, 7, root, pdb())
            path = materialize_design_spec("boltzgen-binder", {"scaffold": "disulfide_beta_hairpin"}, 12, root, pdb())
            spec = json.loads(path.read_text())
            self.assertEqual(spec["entities"][0]["protein"]["sequence"], "C10C")
            self.assertEqual(spec["constraints"][0]["bond"]["atom2"], ["G", 12, "SG"])

    def test_inspection_captures_materialized_target_and_skips_runtime_defaults(self):
        class Target:
            def write_pdb(self, path):
                path.write_text(pdb())
        config = SimpleNamespace(target_structure=Target(), target_chain="A", hotspots=[2], executable="boltzgen", cache_dir="", model_fields_set={"target_structure", "target_chain", "hotspots"})
        generator = SimpleNamespace(_spec=SimpleNamespace(key="boltzgen-binder"), config=config, segment=SimpleNamespace(sequence_length=12))
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])], run=lambda: self.fail("inspection must never run"))
        captured = inspect_generator_specs(program)["generators"][0]
        self.assertEqual(captured["targetPdb"], pdb())
        self.assertNotIn("executable", captured["config"])
        self.assertNotIn("cache_dir", captured["config"])
        self.assertEqual(captured["sequenceLength"], 12)

    def test_installed_native_generator_identity_is_captured_without_fake_spec(self):
        try:
            from autofold_worker.proto_generators import BoltzGenBinderConfig, BoltzGenBinderGenerator
            from proto_language.core import Segment
        except ModuleNotFoundError as error:
            self.skipTest(f"Native Proto environment unavailable: {error}")
        generator = BoltzGenBinderGenerator(BoltzGenBinderConfig(target_structure=pdb(), target_chain="A", hotspots=[4]))
        generator.assign(Segment(length=12, sequence_type="protein"))
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])])
        request = inspect_generator_specs(program)
        self.assertEqual([item["id"] for item in request["generators"]], ["boltzgen-binder"])
        with self.assertRaisesRegex(ValueError, r"requested hotspots \[4\].*outside"):
            preflight(request)

    def test_portfolio_inspection_captures_each_independent_lane(self):
        from autofold_worker.proto_portfolio import ProtoPortfolioProgram
        class Target:
            def write_pdb(self, path):
                path.write_text(pdb())
        lanes = []
        for key in ["boltzgen-binder", "pxdesign-binder"]:
            generator = SimpleNamespace(_spec=SimpleNamespace(key=key), config=SimpleNamespace(target_structure=Target()), segment=SimpleNamespace(sequence_length=12))
            lanes.append(SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])], constructs=[], run=lambda: self.fail("inspection must never run")))
        portfolio = ProtoPortfolioProgram(lanes)
        self.assertEqual([item["id"] for item in inspect_generator_specs(portfolio)["generators"]], ["boltzgen-binder", "pxdesign-binder"])

    def test_failed_generator_retains_real_bounded_parser_traceback(self):
        command = [sys.executable, "-c", "import sys; print('x'*20000); print('Traceback: Specified end 125 is higher than length of chain', file=sys.stderr); sys.exit(3)"]
        with self.assertRaises(RuntimeError) as observed:
            run_generator_command(command)
        self.assertIn("Specified end 125", str(observed.exception))
        self.assertIn("exited 3", str(observed.exception))
        self.assertLess(len(str(observed.exception)), 8200)

    def test_native_parser_uses_selected_cli_interpreter_and_existing_cache_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "boltzgen"
            executable.write_text(f"#!{sys.executable}\n")
            executable.chmod(0o700)
            (root / "mols.zip").write_bytes(b"fixture")
            request = {"generators": [{"id": "boltzgen-binder", "config": {"executable": str(executable), "cache_dir": str(root)}, "sequenceLength": 12, "targetPdb": pdb()}]}
            with patch("autofold_worker.generator_spec.run_generator_command") as run:
                result = preflight(request)
            argv = run.call_args.args[0]
            self.assertEqual(argv[0], sys.executable)
            self.assertIn("YamlDesignParser", argv[2])
            self.assertNotIn("get_artifact_path", argv[2])
            self.assertNotIn(".run(", argv[2])
            self.assertEqual(run.call_args.kwargs["env"]["CUDA_VISIBLE_DEVICES"], "")
            self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")
            self.assertIn("YamlDesignParser", result["checks"][0]["validator"])

    def test_native_pxdesign_parser_uses_sibling_interpreter_and_author_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "autofold-pxdesign"
            executable.write_text("#!/usr/bin/env bash\n")
            executable.chmod(0o700)
            (root / "python").symlink_to(sys.executable)
            request = {"generators": [{"id": "pxdesign-binder", "config": {"executable": str(executable), "target_chains": ["A"], "hotspots": [101]}, "sequenceLength": 12, "targetPdb": pdb((101, 103, 104))}]}
            native_metadata = {"nativeTargetChains": {"B": {"residueCount": 3}}, "nativeHotspots": {"B": [1]}}
            with patch("autofold_worker.generator_spec.run_generator_command", return_value="AUTOFOLD_PX_SPEC=" + json.dumps(native_metadata)) as run:
                result = preflight(request)
            argv = run.call_args.args[0]
            self.assertEqual(argv[0], str(root / "python"))
            self.assertIn("parse_yaml_to_json", argv[2])
            self.assertIn("convert_to_bioassembly_dict", argv[2])
            self.assertNotIn("download_inference_cache", argv[2])
            self.assertNotIn("InferenceRunner", argv[2])
            self.assertEqual(run.call_args.kwargs["env"]["CUDA_VISIBLE_DEVICES"], "")
            self.assertEqual(result["checks"][0]["nativeHotspots"], {"B": [1]})
            self.assertIn("convert_to_bioassembly_dict", result["checks"][0]["validator"])
            self.assertEqual(result["checks"][0]["targetChains"]["A"]["authorResidueIds"], ["101", "103", "104"])

    def test_configured_pxdesign_parser_missing_executable_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = {"generators": [{"id": "pxdesign-binder", "config": {"executable": str(Path(temporary) / "missing")}, "sequenceLength": 12, "targetPdb": pdb()}]}
            with patch("autofold_worker.generator_spec.run_generator_command") as run:
                with self.assertRaisesRegex(ValueError, "PXDesign.*unavailable"):
                    preflight(request)
                run.assert_not_called()

    def test_pxdesign_renders_actual_chains_and_rejects_missing_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = materialize_design_spec("pxdesign-binder", {"target_chains": ["A"], "hotspots": [2]}, 12, Path(temporary), pdb())
            self.assertEqual(json.loads(path.read_text())["target"]["chains"], {"A": {"hotspots": [2]}})
            self.assertEqual(validate_materialized_spec("pxdesign-binder", path)["targetChains"]["A"]["residueCount"], 3)
            path = materialize_design_spec("pxdesign-binder", {"target_chains": ["B"]}, 12, Path(temporary), pdb())
            with self.assertRaisesRegex(ValueError, "absent"):
                validate_materialized_spec("pxdesign-binder", path)

    def test_standalone_cli_requires_no_proto_or_generator_imports(self):
        from autofold_worker import generator_spec
        request = {"generators": [{"id": "boltzgen-binder", "config": {}, "sequenceLength": 12, "targetPdb": pdb()}]}
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        result = subprocess.run([sys.executable, str(Path(generator_spec.__file__)), "--request-base64", encoded], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["checks"][0]["generator"], "boltzgen-binder")
    def test_stdin_cli_avoids_argument_limits_for_materialized_targets(self):
        from autofold_worker import generator_spec
        target = pdb() + ("REMARK " + "x" * 1000 + "\n") * 200
        request = {"generators": [{"id": "boltzgen-binder", "config": {}, "sequenceLength": 12, "targetPdb": target}]}
        result = subprocess.run([sys.executable, str(Path(generator_spec.__file__)), "--request-stdin"], input=json.dumps(request), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["format"], "autofold.generator-spec-preflight.v1")


if __name__ == "__main__":
    unittest.main()
