# Structural and pose-conditioned assessment

Use provisioned model interfaces and scientific settings. Infrastructure selects
runtimes, workers, installation paths and devices, and captures resolved execution.
Call Boltz2 as `predict_structures(complexes, "boltz2", config)`; runtime names are
not extra predictors. Report unavailable support rather than modifying environments.

## Prediction protocols

For each predictor, choose the model/version, partners, MSAs/templates, sampling
effort and seed policy. Request full PAE and use `examples/prediction_capture.py`
before scoring/selection. Compare candidate and parent under a consistent protocol;
execution receipts retain infrastructure identity.

AF2 uses `predict_structures(..., "alphafold2", config)`; multiple protein chains
select multimer. Supplied per-chain MSAs are consumed with `use_msa=False`, which
disables homology search. Record binder query-only versus target homology depth.

ESMFold2 uses `predict_structures(..., "esmfold2", config)` with
`model_checkpoint="esmfold2-fast"`, `use_msa=False` and explicit sampling settings.
Fast is single-sequence. The provisioned path supports one diffusion sample per
call; repeat explicit seeds to retain each prediction. Unsupported `early_exit=True`
fails. Full ESMFold2 requires its own provisioned checkpoint and readiness.

## Interface-quality scores

Native `ipsae-scoring` already computes ipSAE, pDockQ2, LIS and directional pair
breakdowns; do not duplicate their arithmetic. Use `examples/interface_capture.py`
with explicit `(chain, 1-based sequence position, identity)` keys for every PAE row.
The helper validates/reorders both axes into coordinate order and retains source,
mapping, settings and raw response. The predictor's documented token order must
justify those keys: square dimensions alone cannot establish alignment. Canonical
protein-only chains and explicit pLDDT B-factor semantics are required. These
correlated interface-quality estimates do not supply calibrated Kd or independent
experimental confirmation. Preserve each predictor separately; an empty interface
or cross-model disagreement should prompt inspection, not score averaging.

## PRODIGY

Copy/capture and import `scripts/local_affinity.py` beside the authored Program.
Use the provisioned scorer:

```python
from local_affinity import ProdigyInput, ProdigyConfig, run_prodigy
result = run_prodigy(
    ProdigyInput(structure=structure, target_chains=["T"], binder_chains=["B"]),
    ProdigyConfig(output_dir="output/prodigy"),
)
loss = result.prodigy_delta_g_kcal_mol  # lower is favorable, conditional on this pose
```

Call within a native constraint; return separate raw measurements/units/capture links
in metadata. Inspect raw-score support before returning unbounded kcal/mol. Reuse one
capture per pose rather than recomputing per objective. The tool retains coordinates,
native contact/NIS features, request, command, outputs and errors in unique directories.
Kd is in molar units; temperature changes its conversion, not a validated temperature model.

Applicability: one canonical protein-only structural model, complete backbone,
two explicit disjoint partner groups covering all chains, and inter-partner contacts.
The adapter does not validate bond topology or cyclic chemistry. Check target fold,
disulfides, interface geometry and monomer plausibility separately. Pose errors and
interface size can drive favorable estimates. Challenge candidate/parent changes
across poses/models; two hit/nonhit controls cannot calibrate mutation ranking or
absolute Kd. Keep structural confidence, this regression and experimental evidence distinct.
