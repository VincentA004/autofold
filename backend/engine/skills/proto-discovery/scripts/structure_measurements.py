"""Geometry/PAE arithmetic for captured trials; coordinates and PAE are in Å.

Copy unchanged beside the trial program. Callers own sequence/atom correspondence,
chain identity, contact definition and mapping residues to predictor PAE tokens.
No structure parsing, model calls, score normalization or biological cutoffs.
"""
import numpy as np


def _coordinates(value):
    xyz = np.asarray(value, dtype=float)
    if xyz.ndim != 2 or xyz.shape[1] != 3 or len(xyz) == 0 or not np.isfinite(xyz).all():
        raise ValueError("Coordinates must be nonempty finite N x 3 arrays")
    return xyz


def _correspondence(mobile, reference):
    mobile, reference = _coordinates(mobile), _coordinates(reference)
    if mobile.shape != reference.shape:
        raise ValueError("Coordinates require explicit equal-length correspondence")
    return mobile, reference


def _fit(mobile, reference):
    mobile, reference = _correspondence(mobile, reference)
    mc, rc = mobile.mean(axis=0), reference.mean(axis=0)
    x, y = mobile - mc, reference - rc
    if min(np.linalg.matrix_rank(x), np.linalg.matrix_rank(y)) < 2:
        raise ValueError("Alignment needs at least three non-collinear matched points")
    u, _, vt = np.linalg.svd(x.T @ y)
    correction = np.eye(3)
    correction[-1, -1] = -1. if np.linalg.det(u @ vt) < 0 else 1.
    rotation = u @ correction @ vt  # Row vectors: mobile @ rotation + translation.
    return rotation, rc - mc @ rotation


def anchored_rmsd(mobile, reference, *, mobile_anchor, reference_anchor):
    """Fit matched anchors, then measure matched points WITHOUT refitting them.

    For complex pose RMSD: anchors = target CA; points = binder CA. All mobile
    points must share one coordinate frame, likewise all reference points.
    Missing residues require explicit correspondence, never length truncation.
    """
    mobile, reference = _correspondence(mobile, reference)
    rotation, translation = _fit(mobile_anchor, reference_anchor)
    delta = mobile @ rotation + translation - reference
    return float(np.sqrt(np.mean(np.sum(delta * delta, axis=1))))


def aligned_rmsd(mobile, reference):
    """Fit and measure the same matched points (internal fold, NOT binding pose)."""
    return anchored_rmsd(mobile, reference, mobile_anchor=mobile, reference_anchor=reference)


def _indices(value, *, name, upper):
    indices = np.asarray(value)
    if (indices.ndim != 1 or len(indices) == 0 or indices.dtype.kind not in "iu"
            or (indices < 0).any() or (indices >= upper).any()
            or len(np.unique(indices)) != len(indices)):
        raise ValueError(f"{name} must contain unique in-range integer indices")
    return indices.astype(np.intp)


def interface_pae(pae, *, target_indices, binder_indices, contact_pairs):
    """Mean of BOTH directed PAE entries per unique cross-chain contact pair.

    target_indices/binder_indices map caller-local residue indices to zero-based
    GLOBAL PAE token indices. contact_pairs contains local (target, binder) pairs;
    these are paired entries, NOT the Cartesian product of interface residues.
    Direction labels denote matrix indexing, not predictor-specific PAE semantics.
    Empty interfaces and invalid/missing data raise instead of yielding good scores.
    """
    matrix = np.asarray(pae, dtype=float)
    if (matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1] or matrix.size == 0
            or not np.isfinite(matrix).all() or (matrix < 0).any()):
        raise ValueError("PAE must be a nonempty finite nonnegative square matrix")
    target = _indices(target_indices, name="target_indices", upper=len(matrix))
    binder = _indices(binder_indices, name="binder_indices", upper=len(matrix))
    if np.intersect1d(target, binder).size:
        raise ValueError("Target and binder PAE indices must be disjoint")
    pairs = np.asarray(contact_pairs)
    if (pairs.ndim != 2 or pairs.shape[1] != 2 or len(pairs) == 0
            or pairs.dtype.kind not in "iu" or (pairs < 0).any()
            or (pairs[:, 0] >= len(target)).any() or (pairs[:, 1] >= len(binder)).any()
            or len(np.unique(pairs, axis=0)) != len(pairs)):
        raise ValueError("contact_pairs must contain unique in-range local integer pairs")
    ti, bi = target[pairs[:, 0]], binder[pairs[:, 1]]
    forward, reverse = matrix[ti, bi], matrix[bi, ti]
    return {
        "mean_pae_A": float((forward.mean() + reverse.mean()) / 2),
        "target_row_binder_col_mean_pae_A": float(forward.mean()),
        "binder_row_target_col_mean_pae_A": float(reverse.mean()),
        "contact_pair_count": len(pairs),
        "pae_entry_count": 2 * len(pairs),
    }
