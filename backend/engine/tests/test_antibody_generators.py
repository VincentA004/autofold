"""Native composition against deterministic stand-in CLIs, not biological inference."""
from contextlib import nullcontext
import csv
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment
from proto_language.optimizer import (CyclingOptimizer, CyclingOptimizerConfig,
    GeneticAlgorithmOptimizer, GeneticAlgorithmOptimizerConfig,
    RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig)
from proto_tools import InverseFoldingStructureInput, Structure


SOURCE = Path(__file__).parents[1] / "skills/proto-discovery/scripts/antibody_generators.py"
NAME = "autofold_antibody_generators"
if NAME not in sys.modules:
    spec = importlib.util.spec_from_file_location(NAME, SOURCE)
    sys.modules[NAME] = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sys.modules[NAME])
bridge = sys.modules[NAME]


def pdb(heavy="AG", target="MAK", light="G"):
    residues = dict(zip("MAGSCK", ("MET", "ALA", "GLY", "SER", "CYS", "LYS")))
    lines, number = [], 0
    for chain, seq in (("H", heavy), ("L", light), ("T", target)):
        for pos, aa in enumerate(seq, 1):
            number += 1
            lines.append(f"ATOM  {number:5d}  CA  {residues[aa]} {chain}{pos:4d}    "
                         f"{number * 3.:8.3f}{0.:8.3f}{0.:8.3f}  1.00 20.00           C")
        lines.append("TER")
    return "\n".join(lines + ["REMARK PDBinfo-LABEL:    1 H1", "END", ""])


class AntibodyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.framework = self.root / "framework.pdb"
        self.framework.write_text(pdb())
        self.weights = self.root / "weights.pt"
        self.weights.write_text("FAKE")
        self.scripts = self.root / "repo/scripts"
        self.scripts.mkdir(parents=True)
        self.diffusion = self.scripts / "rfdiffusion_inference.py"
        self.diffusion.write_text(
            "import pathlib,sys\n"
            "args=dict(arg.split('=',1) for arg in sys.argv[1:] if '=' in arg)\n"
            "prefix=args['inference.output_prefix']\n"
            "for i in range(int(args['inference.num_designs'])):\n"
            f" pathlib.Path(prefix+'_'+str(i)+'.pdb').write_text({pdb()!r})\n")
        self.mpnn = self.scripts / "proteinmpnn_interface_design.py"
        self.mpnn.write_text(
            "import pathlib,sys\n"
            "a=sys.argv; src=pathlib.Path(a[a.index('-pdbdir')+1]); out=pathlib.Path(a[a.index('-outpdbdir')+1]); out.mkdir()\n"
            "for p in src.glob('*.pdb'): (out/p.name).write_text(p.read_text())\n")
        # Run a fake module with the real isolated-process interface.
        self.fake_python = self.root / "fake-antifold-python"
        rows = []
        for chain, seq in (("H", "AG"), ("L", "G"), ("T", "MAK")):
            for pos, aa in enumerate(seq, 1):
                rows.append({"pdb_chain": chain, "pdb_res": aa, "pdb_posins": str(pos),
                             **{a: 0.0 if a == "C" else -1000.0 for a in bridge.ALPHABET}})
        self.rows = rows
        self.fake_python.write_text(f"#!{sys.executable}\n" +
            "import csv,json,pathlib,sys\n"
            "a=sys.argv; out=pathlib.Path(a[a.index('--out_dir')+1]); out.mkdir()\n"
            f"rows={rows!r}\n"
            "with (out/'input.csv').open('w') as f:\n"
            " w=csv.DictWriter(f,fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)\n")
        self.fake_python.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def rfa(self, **updates):
        values = dict(target_pdb=str(self.framework), framework_pdb=str(self.framework),
                      output_chain_id="H", expected_fixed_chains={"L": "G", "T": "MAK"},
                      design_loops="H1:1", output_dir=str(self.root / "rfa"),
                      repo_dir=str(self.scripts.parent), python_executable=sys.executable,
                      diffusion_weights=str(self.weights), mpnn_weights=str(self.weights))
        return bridge.RFAntibodyGenerator(bridge.RFAntibodyConfig(**(values | updates)))

    def anti(self, **updates):
        values = dict(output_chain_id="H", heavy_chain_id="H", light_chain_id="L", antigen_chain_id="T",
                      mutable_positions=[2], structure_path=str(self.framework), output_dir=str(self.root / "anti"),
                      python_executable=str(self.fake_python), model_weights=str(self.weights))
        return bridge.AntiFoldGenerator(bridge.AntiFoldConfig(**(values | updates)))

    def test_native_generation_cycling_and_pareto_compose_on_the_same_segment(self):
        segment = Segment(sequence="AG", sequence_type="protein", label="heavy")
        construct = Construct([segment])
        rfa = self.rfa()
        anti = self.anti(structure_path=None)
        rfa.assign(segment)
        anti.assign(segment)
        def admissible(sequences, config):
            return [ConstraintOutput(score=0 if len(s.sequence) == 2 else 1) for (s,) in sequences]
        generate = RejectionSamplingOptimizer(constructs=[construct], generators=[rfa],
            constraints=[Constraint(inputs=[segment], function=admissible, threshold=0)],
            config=RejectionSamplingOptimizerConfig(num_samples=1, num_results=1, proposal_batch_size=1))
        observed = []
        def conditioning(sequences):
            observed.extend(s.sequence for s in sequences)
            return [InverseFoldingStructureInput(structure=s.structure, chains_to_redesign=["H"])
                    for s in sequences]
        cycle = CyclingOptimizer(target_segment=segment, constructs=[construct], generators=[anti],
            constraints=[Constraint(inputs=[segment], function=admissible, threshold=0)], conditioning_fn=conditioning,
            config=CyclingOptimizerConfig(num_steps=1, num_results=1))
        def assess(sequences, config):
            results = []
            for (s,) in sequences:
                # Assessment consumes the NEW sequence, with fixed partners from
                # the attached input, rather than treating that input as a new prediction.
                self.assertEqual(s.sequence, "AC")
                self.assertEqual(s.structure.get_chain_sequences()["T"], "MAK")
                results.append(ConstraintOutput(score=0.2, metadata={"synthetic": True}))
            return results
        select = GeneticAlgorithmOptimizer(constructs=[construct], generators=[],
            constraints=[Constraint(inputs=[segment], function=assess, label="synthetic_axis")],
            config=GeneticAlgorithmOptimizerConfig(num_generations=1, population_size=2,
                offspring_per_generation=1, num_results=1, crossover_rate=0.0, survivor_selection="nsga2"))
        Program([generate, cycle, select], num_results=1, seed=17, compute=nullcontext()).run()
        self.assertEqual(observed, ["AG"])
        self.assertEqual(segment.result_sequences[0].sequence, "AC")
        self.assertTrue(list((self.root / "rfa").glob("*/receipt.json")))
        self.assertTrue(list((self.root / "anti").glob("*/native/input.csv")))

    def test_antifold_preserves_all_fixed_positions_and_records_native_probability_input(self):
        segment = Segment(sequence="AG", sequence_type="protein")
        generator = self.anti()
        generator.assign(segment)
        segment.proposal_sequences = segment.result_sequences
        generator.sample()
        proposal = segment.proposal_sequences[0]
        self.assertEqual(proposal.sequence, "AC")
        self.assertEqual(proposal.sequence[0], "A")
        self.assertEqual(proposal.structure.get_chain_sequences()["L"], "G")
        self.assertTrue(Path(proposal._generator_metadata["antifold"]["artifact"]).is_file())

    def test_first_stage_antifold_needs_native_structural_handoff(self):
        def valid_length(sequences, config):
            return [ConstraintOutput(score=0.0 if len(seq.sequence) == 2 else 1.0)
                    for (seq,) in sequences]

        segment = Segment(sequence="AG", sequence_type="protein")
        generator = self.anti()  # A valid structure_path is insufficient for Program preflight.
        generator.assign(segment)
        wrong = RejectionSamplingOptimizer(constructs=[Construct([segment])], generators=[generator],
            constraints=[Constraint(inputs=[segment], function=valid_length, threshold=0.0)],
            config=RejectionSamplingOptimizerConfig(
                num_samples=1, num_results=1, proposal_batch_size=1))
        with self.assertRaisesRegex(ValueError, "STRUCTURE"):
            Program([wrong], num_results=1, compute=nullcontext())
        self.assertFalse((self.root / "anti").exists())

        segment = Segment(sequence="AG", sequence_type="protein")
        generator = self.anti(structure_path=None)
        generator.assign(segment)
        structure = Structure(structure=self.framework.read_text(), structure_format="pdb")
        cycle = CyclingOptimizer(target_segment=segment, constructs=[Construct([segment])],
            generators=[generator],
            constraints=[Constraint(inputs=[segment], function=valid_length, threshold=0.0)],
            conditioning_fn=lambda sequences: [InverseFoldingStructureInput(
                structure=structure, chains_to_redesign=["H"]) for _ in sequences],
            config=CyclingOptimizerConfig(num_steps=1, num_results=1))
        Program([cycle], num_results=1, seed=17, compute=nullcontext()).run()
        self.assertEqual(segment.result_sequences[0].sequence, "AC")
        self.assertEqual(segment.result_sequences[0].structure.get_chain_sequences()["L"], "G")
        self.assertEqual(segment.result_sequences[0].structure.get_chain_sequences()["T"], "MAK")

    def test_wrong_target_or_fixed_partner_is_rejected_with_raw_outputs_retained(self):
        generator = self.rfa(expected_fixed_chains={"L": "G", "T": "MAG"})
        generator.assign(Segment(length=2, sequence_type="protein"))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            generator.sample()
        self.assertTrue(list((self.root / "rfa").glob("*/sequences/*.pdb")))
        receipt = json.loads(next((self.root / "rfa").glob("*/receipt.json")).read_text())
        self.assertFalse(receipt["success"])

    def test_rfa_will_not_design_a_second_chain_or_silently_resize_the_segment(self):
        for updates in ({"design_loops": "L1:1"}, {"design_loops": "H1:1-3"}):
            generator = self.rfa(**updates)
            generator.assign(Segment(length=2, sequence_type="protein"))
            with self.assertRaisesRegex(ValueError, "one mutable"):
                generator.sample()
        generator = self.rfa()
        generator.assign(Segment(length=3, sequence_type="protein"))
        with self.assertRaisesRegex(ValueError, "length"):
            generator.sample()

    def test_missing_runtime_fails_without_attempting_install_or_launch(self):
        generator = self.anti(python_executable="")
        generator.assign(Segment(sequence="AG", sequence_type="protein"))
        with self.assertRaisesRegex(ValueError, "does not install"):
            generator.sample()
        self.assertFalse((self.root / "anti").exists())

    def test_python_symlink_preserves_the_selected_virtual_environment(self):
        link = self.root / "venv/bin/python"
        link.parent.mkdir(parents=True)
        link.symlink_to(sys.executable)
        self.assertEqual(bridge.existing(str(link), "Python"), link)

    def test_cycling_fixed_positions_and_chain_selection_cannot_be_silently_ignored(self):
        structure = Structure(structure=pdb())
        for request in [
            InverseFoldingStructureInput(structure=structure, chains_to_redesign=["L"]),
            InverseFoldingStructureInput(structure=structure, chains_to_redesign=["H"], fixed_positions={"H": [2]}),
        ]:
            generator = self.anti(structure_path=None)
            generator.assign(Segment(sequence="AG", sequence_type="protein"))
            with self.assertRaises(ValueError):
                generator.sample(structure_inputs=[request])
        generator = self.anti(structure_path=None)
        generator.assign(Segment(sequence="AG", sequence_type="protein"))
        generator.sample(structure_inputs=[InverseFoldingStructureInput(
            structure=structure, chains_to_redesign=["H"], fixed_positions={"T": [1]})])
        self.assertEqual(generator.segment.proposal_sequences[0].sequence, "AC")

    def test_antifold_rejects_mapping_errors_and_nonfinite_outputs(self):
        original = self.fake_python.read_text()
        for old, new in (("'pdb_res': 'G'", "'pdb_res': 'S'"),
                         ("'C': 0.0", "'C': float('nan')")):
            self.fake_python.write_text(original.replace(old, new))
            generator = self.anti()
            generator.assign(Segment(sequence="AG", sequence_type="protein"))
            with self.assertRaises(ValueError):
                generator.sample()
        self.assertTrue(list((self.root / "anti").glob("*/native/input.csv")))

    def test_failed_diffusion_retains_partial_files_and_failure_receipt(self):
        self.diffusion.write_text(self.diffusion.read_text() + "raise SystemExit(7)\n")
        generator = self.rfa()
        generator.assign(Segment(length=2, sequence_type="protein"))
        with self.assertRaises(subprocess.CalledProcessError):
            generator.sample()
        self.assertTrue(list((self.root / "rfa").glob("*/backbones/*.pdb")))
        self.assertIn("error", json.loads(next((self.root / "rfa").glob("*/receipt.json")).read_text()))

    def test_rfantibody_cannot_silently_mutate_the_fixed_framework(self):
        self.mpnn.write_text(self.mpnn.read_text().replace(
            "p.read_text()", "p.read_text().replace('GLY H   2', 'SER H   2')"))
        generator = self.rfa()
        generator.assign(Segment(length=2, sequence_type="protein"))
        with self.assertRaisesRegex(ValueError, "fixed antibody framework"):
            generator.sample()

    def test_author_numbering_gaps_are_not_molecular_sequence_changes(self):
        structure = Structure(structure=pdb().replace('ALA T   2', 'ALA T   4').replace('LYS T   3', 'LYS T   5'))
        self.assertEqual(bridge.chain_sequences(structure), {"H": "AG", "L": "G", "T": "MAK"})

    def test_antifold_bootstrap_sets_spawn_before_entering_the_model_module(self):
        generator = self.anti()
        generator.assign(Segment(sequence="AG", sequence_type="protein"))
        generator.sample()
        request = json.loads(next((self.root / "anti").glob("*/request.json")).read_text())
        package = self.root / "stand-in/antifold"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("")
        (package / "main.py").write_text(
            "import multiprocessing as mp\n"
            "assert mp.get_start_method() == 'spawn'\n"
            "print('SPAWN_READY')\n")
        result = subprocess.run([sys.executable, *request["command"][1:3]],
            env={**os.environ, "PYTHONPATH": str(package.parent)},
            capture_output=True, text=True, timeout=20, check=True)
        self.assertIn("SPAWN_READY", result.stdout)


if __name__ == "__main__":
    unittest.main()
