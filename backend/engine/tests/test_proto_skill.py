"""Offline native wiring checks; predictor/MPNN results are CPU substitutes."""
from contextlib import nullcontext
from functools import partial
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from proto_language.core import Construct, Program, Segment
from proto_language.generator import ProteinMPNNGenerator, ProteinMPNNGeneratorConfig
from proto_language.optimizer import CyclingOptimizer, CyclingOptimizerConfig
from proto_tools import Chain, Structure

EXAMPLE = Path(__file__).resolve().parents[1] / "skills/proto-discovery/examples/target_aware_conditioning.py"
spec = importlib.util.spec_from_file_location("target_aware_conditioning", EXAMPLE)
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


def structure(target="MAK", binder="GG"):
    residues = {"M": "MET", "A": "ALA", "K": "LYS", "G": "GLY", "S": "SER"}
    lines = []
    atom = 0
    for chain, sequence in [("A", target), ("B", binder)]:
        for position, aa in enumerate(sequence, 1):
            atom += 1
            lines.append(
                f"ATOM  {atom:5d}  CA  {residues[aa]} {chain}{position:4d}    "
                f"{atom * 3.8:8.3f}{0.0:8.3f}{0.0:8.3f}  1.00 20.00           C"
            )
        lines.append("TER")
    return Structure(structure="\n".join(lines + ["END"]), structure_format="pdb")


class TargetAwareCyclingTests(unittest.TestCase):
    def test_native_cycles_preserve_target_and_only_update_binder(self):
        binder = Segment(sequence="GG", sequence_type="protein", label="binder")
        construct = Construct([binder])
        generator = ProteinMPNNGenerator(ProteinMPNNGeneratorConfig(output_chain_id="B"))
        generator.assign(binder)
        predictions, designs = [], []

        def predict(complexes, toolkit, config):
            self.assertEqual(toolkit, "boltz2")
            self.assertEqual(config, {"use_msa": False})
            self.assertEqual(len(complexes), 1)
            chains = complexes[0].chains
            self.assertEqual([(chain.id, chain.sequence) for chain in chains][:1], [("A", "MAK")])
            self.assertEqual(chains[1].id, "B")
            predictions.append(chains[1].sequence)
            return SimpleNamespace(success=True, structures=[structure(binder=chains[1].sequence)])

        def sample(inputs, config):
            request = inputs.inputs[0]
            self.assertEqual(request.structure.get_chain_sequence("A"), "MAK")
            self.assertEqual(request.chain_ids_to_redesign, ["B"])
            self.assertIsNotNone(request.fixed_positions)
            new_sequence = ["GS", "GA"][len(designs)]
            designs.append(new_sequence)
            design = SimpleNamespace(
                chains=[Chain(id="A", sequence="MAK"), Chain(id="B", sequence=new_sequence)],
                designed=[False, True],
                metrics=SimpleNamespace(perplexity=1.0, sequence_recovery=0.5),
            )
            return SimpleNamespace(design_sets=[SimpleNamespace(complexes=[design])])

        cycle = CyclingOptimizer(
            target_segment=binder, constructs=[construct], generators=[generator], constraints=[],
            config=CyclingOptimizerConfig(num_steps=2, num_results=1),
            conditioning_fn=partial(
                example.condition_on_target, target_sequence="MAK", structure_tool="boltz2",
                tool_config={"use_msa": False}, fixed_binder_positions=[1],
            ),
        )
        with patch.object(example, "predict_structures", predict), patch(
            "proto_language.generator.proteinmpnn_generator.run_proteinmpnn_sample", sample
        ):
            Program([cycle], num_results=1, seed=7, compute=nullcontext()).run()
        self.assertEqual(predictions, ["GG", "GS"])
        self.assertEqual(designs, ["GS", "GA"])
        self.assertEqual(binder.result_sequences[0].sequence, "GA")

    def test_changed_target_is_rejected_before_redesign(self):
        with patch.object(example, "predict_structures", return_value=SimpleNamespace(
            success=True, structures=[structure(target="MAM")]
        )):
            from proto_language.core import Sequence
            with self.assertRaisesRegex(ValueError, "mapping"):
                example.condition_on_target(
                    [Sequence(sequence="GG", sequence_type="protein")], target_sequence="MAK",
                    structure_tool="boltz2", tool_config={},
                )

    def test_failed_or_incomplete_prediction_is_not_a_conditioning_result(self):
        from proto_language.core import Sequence
        for result, error in [
            (SimpleNamespace(success=False, structures=[]), RuntimeError),
            (SimpleNamespace(success=True, structures=[]), ValueError),
        ]:
            with self.subTest(result=result), patch.object(example, "predict_structures", return_value=result):
                with self.assertRaises(error):
                    example.condition_on_target(
                        [Sequence(sequence="GG", sequence_type="protein")], target_sequence="MAK",
                        structure_tool="boltz2", tool_config={},
                    )


if __name__ == "__main__":
    unittest.main()
