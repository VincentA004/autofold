"""Exercise the installed native Pareto selection with known synthetic tradeoffs."""
import importlib.util
import json
import math
from pathlib import Path
import unittest

EXAMPLE = Path(__file__).resolve().parents[1] / 'skills/proto-discovery/examples/native_pareto.py'
spec = importlib.util.spec_from_file_location('native_pareto_example', EXAMPLE)
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


class NativeScoringTests(unittest.TestCase):
    def test_smaller_survivor_pool_evaluates_every_input_and_exports_rejection_history(self):
        result = example.run_example(num_results=2, reject_sequences={"TTTT"})
        self.assertEqual(set(result['evaluated_sequences']), set(example.SYNTHETIC_LOSSES))
        self.assertEqual(len(result['survivors']), 2)
        self.assertTrue(all(row['sequence'] != 'TTTT' for row in result['survivors']))
        encoded = json.dumps(result, allow_nan=False)
        self.assertIn('"nonfinite": "inf"', encoded)
        self.assertEqual(json.loads(encoded)['evaluated_sequences'], result['evaluated_sequences'])

    def test_history_export_preserves_nonfinite_identity_without_mutating_scores(self):
        original = {'rejected': (float('inf'), float('-inf'), float('nan')), 'finite': 0.25}
        exported = example.history_for_json(original)
        self.assertEqual(exported['rejected'], [
            {'nonfinite': 'inf'}, {'nonfinite': '-inf'}, {'nonfinite': 'nan'}])
        self.assertEqual(exported['finite'], 0.25)
        self.assertTrue(math.isinf(original['rejected'][0]))
        self.assertTrue(math.isnan(original['rejected'][2]))
        json.dumps(exported, allow_nan=False)

    def test_native_selection_excludes_dominated_point_and_keeps_objectives_separate(self):
        result = example.run_example()
        self.assertTrue(result['survivors'])
        for survivor in result['survivors']:
            self.assertNotEqual(survivor['sequence'], 'TTTT')
            self.assertEqual(set(survivor['native_objectives']), {'first_loss', 'second_loss'})
            self.assertEqual(tuple(survivor['native_objectives'].values()), tuple(survivor['losses']))
        # A known tradeoff is not dominance: each extreme is worse on one axis.
        rows = [s['native_objectives'] for s in result['survivors']]
        self.assertTrue(any(r['first_loss'] < r['second_loss'] for r in rows))
        self.assertTrue(any(r['first_loss'] > r['second_loss'] for r in rows))


if __name__ == '__main__':
    unittest.main()
