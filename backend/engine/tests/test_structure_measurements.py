"""Analytic geometry and asymmetric PAE fixtures; no model calls or downloads."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np

HELPER = Path(__file__).resolve().parents[1] / "skills/proto-discovery/scripts/structure_measurements.py"
spec = importlib.util.spec_from_file_location("structure_measurements", HELPER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

TARGET = np.array([[0., 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3]])
ROTATION = np.array([[0., -1, 0], [1, 0, 0], [0, 0, 1]])


class RmsdTests(unittest.TestCase):
    def test_rigid_transform_recovers_zero(self):
        self.assertLess(m.aligned_rmsd(TARGET @ ROTATION + [3, 7, 11], TARGET), 1e-12)

    def test_anchor_fit_preserves_pose_displacement_hidden_by_binder_fit(self):
        binder = TARGET + [5, 6, 7]
        shifted = binder + [3, 4, 0]
        mobile_target = TARGET @ ROTATION + [3, 7, 11]
        mobile_binder = shifted @ ROTATION + [3, 7, 11]
        self.assertLess(m.aligned_rmsd(mobile_binder, binder), 1e-12)
        self.assertAlmostEqual(m.anchored_rmsd(mobile_binder, binder,
            mobile_anchor=mobile_target, reference_anchor=TARGET), 5.)

    def test_reflection_is_not_a_rotation(self):
        mirror = TARGET * [-1, 1, 1]
        self.assertGreater(m.aligned_rmsd(mirror, TARGET), .1)

    def test_rms_is_root_mean_squared_distance_not_mean_distance(self):
        reference = np.array([[0., 0, 4], [0, 0, 8]])
        mobile = reference + [[0, 0, 0], [3, 4, 0]]
        self.assertAlmostEqual(m.anchored_rmsd(mobile, reference,
            mobile_anchor=TARGET, reference_anchor=TARGET), np.sqrt(25. / 2))

    def test_explicit_gapped_correspondence(self):
        # Author numbering has a gap and an insertion; only explicit matches count.
        mobile_by_id = dict(zip([5, 6, 56, '56A'], TARGET @ ROTATION + 12))
        reference_by_id = dict(zip([5, 6, 56, '56A'], TARGET))
        keys = [5, 6, 56, '56A']
        self.assertLess(m.aligned_rmsd([mobile_by_id[k] for k in keys],
                                      [reference_by_id[k] for k in keys]), 1e-12)

    def test_invalid_correspondence_or_coordinates_raise(self):
        for bad in ([], [[0, 1]], [[np.nan, 1, 2]], TARGET[:3], np.full((4, 3), np.inf)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                m.aligned_rmsd(bad, TARGET)

    def test_degenerate_anchors_raise(self):
        for anchor in ([[0, 0, 0]], [[0, 0, 0], [1, 1, 1]],
                       [[0, 0, 0], [1, 1, 1], [2, 2, 2]]):
            with self.subTest(anchor=anchor), self.assertRaises(ValueError):
                m.anchored_rmsd(TARGET, TARGET, mobile_anchor=anchor, reference_anchor=anchor)


class InterfacePaeTests(unittest.TestCase):
    def setUp(self):
        # All unselected entries (including target-target) are 99. Pair means 2, 6.
        self.pae = np.full((6, 6), 99.)
        self.pae[0, 4], self.pae[4, 0] = 1., 3.
        self.pae[2, 5], self.pae[5, 2] = 5., 7.
        self.args = dict(target_indices=[0, 1, 2, 3], binder_indices=[4, 5],
                         contact_pairs=[(0, 0), (2, 1)])

    def test_global_offset_paired_not_cartesian_and_both_directions(self):
        result = m.interface_pae(self.pae, **self.args)
        self.assertEqual(result, dict(mean_pae_A=4., target_row_binder_col_mean_pae_A=3.,
            binder_row_target_col_mean_pae_A=5., contact_pair_count=2, pae_entry_count=4))

    def test_reordered_noncontiguous_token_maps(self):
        # Includes an unrelated token/chain; never infer offsets from chain length.
        result = m.interface_pae(self.pae, target_indices=[2, 0], binder_indices=[5, 4],
                                 contact_pairs=[(1, 1), (0, 0)])
        self.assertEqual(result['mean_pae_A'], 4.)

    def test_swapping_partners_swaps_directions_and_preserves_mean(self):
        result = m.interface_pae(self.pae, target_indices=[4, 5], binder_indices=[0, 1, 2, 3],
                                 contact_pairs=[(0, 0), (1, 2)])
        self.assertEqual(result['mean_pae_A'], 4.)
        self.assertEqual(result['target_row_binder_col_mean_pae_A'], 5.)

    def test_invalid_matrix_raises(self):
        for matrix in (None, [], [[1, 2]], [[np.nan]], [[np.inf]], [[-1.]]):
            with self.subTest(matrix=matrix), self.assertRaises(ValueError):
                m.interface_pae(matrix, **self.args)

    def test_empty_duplicate_out_of_range_or_noninteger_pairs_raise(self):
        for pairs in ([], [(0, 0), (0, 0)], [(4, 0)], [(0, 2)], [(-1, 0)],
                      [(0., 0.)], [(True, False)], [(0,)], [(0, 0, 0)]):
            with self.subTest(pairs=pairs), self.assertRaises(ValueError):
                m.interface_pae(self.pae, **{**self.args, 'contact_pairs': pairs})

    def test_ambiguous_or_invalid_token_maps_raise(self):
        for update in (dict(target_indices=[]), dict(binder_indices=[0, 5]),
                       dict(binder_indices=[4, 4]), dict(binder_indices=[4, 6]),
                       dict(binder_indices=[4., 5.]), dict(target_indices=[-1, 1])):
            with self.subTest(update=update), self.assertRaises(ValueError):
                m.interface_pae(self.pae, **{**self.args, **update})


if __name__ == '__main__':
    unittest.main()
