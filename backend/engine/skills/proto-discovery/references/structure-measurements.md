# Shared structure measurements

Copy [structure_measurements.py](../scripts/structure_measurements.py) unchanged
into the authored program bundle before capture; import it beside the trial code.
Use these functions for RMSD and contact-pair PAE in constraints and assessments.
They require NumPy; no predictor, parser or scoring policy is attached.

```python
from structure_measurements import aligned_rmsd, anchored_rmsd, interface_pae

fold_rmsd_A = aligned_rmsd(predicted_binder_ca, reference_binder_ca)
pose_rmsd_A = anchored_rmsd(
    predicted_binder_ca, reference_binder_ca,
    mobile_anchor=predicted_target_ca, reference_anchor=reference_target_ca,
)
interface = interface_pae(
    pae, target_indices=target_pae_tokens, binder_indices=binder_pae_tokens,
    contact_pairs=local_residue_pairs,
)
```

Provide explicitly matched atoms in identical order. Preserve chain/sequence
identity and map missing residues, insertion codes and author numbering; never
truncate to the shorter chain. Pose RMSD fits only the target; fitting the binder
separately erases displacement. Compare candidate poses across predictors this way
when claiming structural agreement. Large shifts can also reflect real alternatives;
resolve or qualify them rather than automatically declaring a biological failure.

PAE token maps are zero-based global matrix positions, not author residue numbers.
For a verified target-first, one-token-per-residue protein prediction, binder tokens
start at the full predicted target length. Other orders, missing coordinates or
tokenization need their actual mapping; coordinate counts alone do not establish it.
Contact pairs index the supplied local residue maps. Deduplicate atom contacts to
residue pairs and retain the atom selection, distance cutoff, pairs and token maps.
The helper averages both directed entries per pair, preserving counts/directional
means; it does not average a Cartesian block or assume PAE symmetry.

Retain those definitions, coordinate/response references and raw Å values with the
assessment. Invalid inputs/empty interfaces raise; record missing evidence, never
substitute zero. A verified calculation establishes arithmetic, not binding affinity.
