"""Exercise the optional bridge with native Proto and a deterministic fake CLI.

Run with the selected Proto interpreter; this test never invokes learned models.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import nullcontext

from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools.entities.structures import Structure

MODULE = Path(__file__).parents[1] / "skills/proto-discovery/scripts/model_generators.py"
if "model_generators" not in sys.modules:
    spec = importlib.util.spec_from_file_location("model_generators", MODULE)
    sys.modules[spec.name] = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sys.modules[spec.name])
bridge = sys.modules["model_generators"]


def cif():
    lines = []
    for i, (chain, residue) in enumerate((("A", "ALA"), ("G", "GLY")), 1):
        lines.append(f"ATOM  {i:5d}  CA  {residue} {chain}{1:4d}    {i * 4.:8.3f}{0.:8.3f}{0.:8.3f}  1.00 20.00           C  ")
    return Structure(structure="\n".join(lines) + "\nEND\n").structure_cif


class GeneratorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.design = self.root / "design.yaml"
        self.design.write_text("entities: []\n")

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, fail=False):
        path = self.root / "fake-boltzgen"
        path.write_text(f"#!{sys.executable}\n" +
                        "import pathlib,sys\n" +
                        "out=pathlib.Path(sys.argv[sys.argv.index('--output')+1])\n" +
                        "out.mkdir(parents=True)\n" +
                        "(out/'raw.json').write_text('{}')\n" +
                        ("sys.exit(7)\n" if fail else
                         "stage=out/'intermediate_designs_inverse_folded'\n"
                         "stage.mkdir()\n"
                         f"(stage/'candidate.cif').write_text({cif()!r})\n"))
        path.chmod(0o755)
        return path

    def generator(self, fail=False, protocol="peptide-anything"):
        return bridge.BoltzGenBinderGenerator(bridge.BoltzGenBinderConfig(
            design_spec=str(self.design), binder_chain="G", output_dir=str(self.root / "evidence"),
            executable=str(self.cli(fail)), cache_dir=str(self.cache), timeout_seconds=10,
            protocol=protocol))

    def test_native_selection_preserves_structure_and_all_cli_evidence(self):
        segment = Segment(length=1, sequence_type="protein")
        generator = self.generator()
        generator.assign(segment)
        def glycine(sequences, config):
            return [ConstraintOutput(score=0 if sequence.sequence == "G" else 1)
                    for (sequence,) in sequences]
        optimizer = RejectionSamplingOptimizer(constructs=[Construct([segment])], generators=[generator],
            constraints=[Constraint(inputs=[segment], function=glycine, threshold=0)],
            config=RejectionSamplingOptimizerConfig(num_samples=1, num_results=1, proposal_batch_size=1, track_proposals=True))
        Program([optimizer], num_results=1, compute=nullcontext()).run()
        self.assertEqual(segment.result_sequences[0].sequence, "G")
        self.assertIsNotNone(segment.result_sequences[0].structure)
        self.assertTrue((self.root / "evidence/call-001/native/raw.json").is_file())
        receipt = json.loads((self.root / "evidence/call-001/receipt.json").read_text())
        self.assertEqual(receipt["returned_designs"], 1)
        self.assertIn("not exposed", receipt["seed_control"])
        command = receipt["command"]
        self.assertEqual(command[command.index("--protocol") + 1], "peptide-anything")
        generator.sample()
        self.assertTrue((self.root / "evidence/call-002/receipt.json").is_file())

    def test_protein_protocol_preserves_selected_stage_and_structure(self):
        segment = Segment(length=1, sequence_type="protein")
        generator = self.generator(protocol="protein-anything")
        generator.assign(segment)
        generator.sample()
        self.assertIsNotNone(segment.proposal_sequences[0].structure)
        receipt = json.loads((self.root / "evidence/call-001/receipt.json").read_text())
        command = receipt["command"]
        self.assertEqual(command[command.index("--protocol") + 1], "protein-anything")
        self.assertEqual(command[command.index("--steps") + 1:], ["design", "inverse_folding"])

    def test_unsupported_protocol_fails_before_execution(self):
        with self.assertRaises(ValueError):
            self.generator(protocol="antibody-anything")
        self.assertFalse((self.root / "evidence").exists())

    def test_missing_binder_does_not_select_target(self):
        stage = self.root / "stage"
        stage.mkdir()
        (stage / "candidate.cif").write_text(cif())
        with self.assertRaisesRegex(ValueError, "absent"):
            bridge.read_designs(stage, "Z", 1)
        with self.assertRaisesRegex(ValueError, "length"):
            bridge.read_designs(stage, "G", 2)

    def test_failed_cli_retains_partial_output_and_error_receipt(self):
        generator = self.generator(fail=True)
        generator.assign(Segment(sequence="G", sequence_type="protein"))
        with self.assertRaises(subprocess.CalledProcessError):
            generator.sample()
        self.assertTrue((self.root / "evidence/call-001/native/raw.json").exists())
        self.assertIn("error", json.loads((self.root / "evidence/call-001/receipt.json").read_text()))


if __name__ == "__main__":
    unittest.main()
