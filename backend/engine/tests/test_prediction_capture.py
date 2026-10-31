"""Native response capture and preselection retention; no scientific inference."""
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from proto_language.core import Constraint, Construct, Program, Segment, Sequence
from proto_language.optimizer import GeneticAlgorithmOptimizer, GeneticAlgorithmOptimizerConfig
from proto_tools import Boltz2Config, Chain, Complex, Structure
from proto_tools.tools.structure_prediction.shared_data_models import StructurePredictionOutput
from proto_tools.utils.tool_io import Metrics

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / 'backend/engine/skills/proto-discovery/examples/prediction_capture.py'
spec = importlib.util.spec_from_file_location('prediction_capture', HELPER)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
sys.modules['prediction_capture'] = capture
OBJECTIVES = Path(__file__).resolve().parent / 'fixtures/shared_prediction_objectives.py'
spec = importlib.util.spec_from_file_location('capture_test_objectives', OBJECTIVES)
objectives = importlib.util.module_from_spec(spec)
spec.loader.exec_module(objectives)

PAE = [[0.0, 1.25], [3.5, 0.0]]


def response(complexes, tool, config):
    """Return real native data objects containing synthetic coordinates/metrics."""
    codes = {'A': 'ALA', 'C': 'CYS', 'G': 'GLY', 'T': 'THR'}
    structures = []
    for molecular_input in complexes:
        lines = []
        for chain in molecular_input.chains:
            for index, aa in enumerate(chain.sequence, 1):
                serial = len(lines) + 1
                lines.append(f'ATOM  {serial:5d}  CA  {codes[aa]} {chain.id}{index:4d}    '
                             f'{float(serial):8.3f}{0.:8.3f}{0.:8.3f}  1.00 20.00           C  ')
        sequence = molecular_input.chains[-1].sequence
        structures.append(Structure(structure='\n'.join(lines) + '\nEND\n', metrics={
            'iptm': {'AAAA': 0.9, 'CCCC': 0.8, 'GGGG': 0.2}.get(sequence, 0.5),
            'complex_iplddt': 0.8, 'pae': PAE, 'extra_backend_metric': [1.0, 2.0],
        }))
    return StructurePredictionOutput(structures=structures, success=True)


class PredictionCaptureTests(unittest.TestCase):
    def request(self):
        return [Complex(chains=[Chain(id='A', sequence='A', entity_type='protein'),
                                Chain(id='B', sequence='AAAA', entity_type='protein')])]

    def test_capture_duration_survives_backward_system_clock_adjustment(self):
        wall_clock = [1000.0]
        def predict(*args):
            wall_clock[0] -= 5.0
            return response(*args)
        with tempfile.TemporaryDirectory() as directory, patch.object(
                capture.time, 'time', side_effect=lambda: wall_clock[0]):
            result, saved = capture.predict_captured(
                self.request(), 'boltz2', {'include_pae_matrix':True},
                capture_dir=directory, predictor=predict)
            self.assertTrue(result.success)
            self.assertGreaterEqual(json.loads((saved/'capture.json').read_text())['wall_seconds'],0)

    def test_every_prediction_survives_native_selection_and_cache_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Boltz2Config(seed=7, include_pae_matrix=True)
            objectives.configure(tool_config=config, predictor_seed=7, capture_dir=Path(temporary))
            target = Segment(sequence='A', sequence_type='protein', label='target')
            binder = Segment(sequence='AAAA', sequence_type='protein', label='binder')
            binder.result_sequences = [Sequence(sequence=s, sequence_type='protein') for s in ('AAAA', 'CCCC', 'GGGG')]
            target.result_sequences = [Sequence(sequence='A', sequence_type='protein') for _ in range(3)]
            optimizer = GeneticAlgorithmOptimizer(
                constructs=[Construct([target, binder])], generators=[], constraints=[
                    Constraint(inputs=[target, binder], function=objectives.iptm_loss, label='iptm'),
                    Constraint(inputs=[target, binder], function=objectives.iplddt_loss, label='iplddt'),
                ], config=GeneticAlgorithmOptimizerConfig(
                    num_generations=1, population_size=3, num_results=1,
                    crossover_rate=0, survivor_selection='nsga2',
                ),
            )
            with patch('proto_tools.predict_structures', side_effect=response) as predictor:
                program = Program([optimizer], num_results=1, compute=nullcontext(), seed=9)
                binder.result_sequences = [Sequence(sequence=s, sequence_type='protein') for s in ('AAAA', 'CCCC', 'GGGG')]
                target.result_sequences = [Sequence(sequence='A', sequence_type='protein') for _ in range(3)]
                program.run()
            self.assertEqual(predictor.call_count, 1)  # Both objectives share evidence.
            self.assertEqual(len(binder.result_sequences), 1)
            saved = list(Path(temporary).glob('*/response.json'))
            self.assertEqual(len(saved), 1)
            records = json.loads(saved[0].read_text())['structures']
            self.assertEqual(len(records), 3)  # Includes every discarded design.
            self.assertTrue(all(r['metrics']['pae'] == PAE for r in records))
            self.assertTrue(all(r['metrics']['extra_backend_metric'] == [1., 2.] for r in records))
            request = json.loads(saved[0].with_name('request.json').read_text())
            self.assertEqual(request['config']['seed'], 7)
            self.assertEqual(len(request['complexes']), 3)
            for index, record in enumerate(records):
                self.assertEqual(saved[0].with_name(f'structure_{index}.pdb').read_text(), record['structure'])
            # A new configuration starts a new cache namespace and durable capture.
            config = config.model_copy(update={'seed': 8})
            objectives.configure(tool_config=config, predictor_seed=8, capture_dir=Path(temporary))
            with patch('proto_tools.predict_structures', side_effect=response) as predictor:
                objectives._records([(Sequence(sequence='A', sequence_type='protein'),
                                      Sequence(sequence='AAAA', sequence_type='protein'))])
            self.assertEqual(predictor.call_count, 1)
            self.assertEqual(len(list(Path(temporary).glob('*/request.json'))), 2)

    def test_partial_failed_output_is_captured_before_caller_handles_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            partial = response(self.request(), 'boltz2', None)
            partial.success = False
            partial.errors = ['second item failed']
            output, directory = capture.predict_captured(
                self.request() * 2, 'boltz2', Boltz2Config(include_pae_matrix=True),
                capture_dir=temporary, predictor=lambda *_: partial,
            )
            self.assertFalse(output.success)
            raw = json.loads((directory / 'response.json').read_text())
            self.assertEqual(raw['structures'][0]['metrics']['pae'], PAE)
            self.assertEqual(raw['errors'], ['second item failed'])

    def test_missing_or_nonfinite_requested_pae_is_retained_and_raises(self):
        for pae in (None, [[float('nan')]], [[1.0, 2.0]]):
            with self.subTest(pae=pae), tempfile.TemporaryDirectory() as temporary:
                output = response(self.request(), 'boltz2', None)
                if pae is None:
                    output.structures[0].metrics = Metrics(**{
                        k: v for k, v in output.structures[0].metrics.items() if k != 'pae'
                    })
                else:
                    output.structures[0].metrics['pae'] = pae
                with self.assertRaisesRegex(ValueError, 'requested PAE'):
                    capture.predict_captured(self.request(), 'boltz2', Boltz2Config(include_pae_matrix=True),
                                             capture_dir=temporary, predictor=lambda *_: output)
                self.assertEqual(len(list(Path(temporary).glob('*/response.json'))), 1)
                saved = json.loads(next(Path(temporary).glob('*/capture.json')).read_text())
                self.assertTrue(saved['validation_errors'])

    def test_exception_retains_request_without_claiming_a_prediction(self):
        with tempfile.TemporaryDirectory() as temporary:
            def crash(*_):
                raise RuntimeError('synthetic invocation failure')
            with self.assertRaisesRegex(RuntimeError, 'synthetic invocation failure'):
                capture.predict_captured(self.request(), 'boltz2', Boltz2Config(seed=11),
                                         capture_dir=temporary, predictor=crash)
            self.assertEqual(len(list(Path(temporary).glob('*/request.json'))), 1)
            self.assertEqual(len(list(Path(temporary).glob('*/error.json'))), 1)
            self.assertFalse(list(Path(temporary).glob('*/response.json')))


if __name__ == '__main__':
    unittest.main()
