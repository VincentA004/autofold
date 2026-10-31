# Scientist model menu

Choose the needed transformation before the model: new geometry, sequence redesign,
structure prediction or task-property assessment. Choose an optimizer separately from
what supplies proposals and measurements. This is a capability menu, not a mandatory
pipeline or a second routing system. Read only the selected model's live schema/source.

## Core: exposed through Proto

These five paths have run in Autofold campaigns on the 4090. That is evidence for
those inputs/settings, not readiness on the current interpreter or a model ranking.
Find executable/cache paths, versions and observed costs in campaign compute notes.

| Model | When useful | Executable entry point / limit |
| --- | --- | --- |
| [RFD4-Proteina](https://github.com/RosettaCommons/RFD4-Proteina) | New target-conditioned binder sequences and geometry | Generator `rfd4-binder`; generation only, without external reward-guided search |
| [BoltzGen](https://github.com/HannesStark/boltzgen) | Alternative peptide/minibinder starting families | Generator `boltzgen-binder`; design + inverse folding only; bridge protocols are `peptide-anything` / `protein-anything` |
| [ProteinMPNN](https://github.com/dauparas/ProteinMPNN) | Sequences for a credible backbone; selected mutable chains/positions | Generator `proteinmpnn`; `mpnn-mutation` is another registered composition whose selected backend/readiness needs inspection |
| [Boltz-2](https://github.com/jwohlwend/boltz/blob/main/docs/prediction.md) | Structural screening or conditioning of candidates/complexes | Tool `boltz2-prediction`; `predict_structures(..., "boltz2", config)` |
| [Protenix v2](https://github.com/bytedance/Protenix) | Early structural challenge of a shortlist/parents or an alternative state hypothesis | Tool `protenix-prediction`; `predict_structures(..., "protenix", config)`; select the actual v2 model in its config |

The [inspection helper](api.md) exposes both bundled generators without extra flags.
Copy/import `scripts/model_generators.py` into Programs using either bridge; registry
inspection alone does not register it in another Python process. See [generation](generative-design.md)
for native inputs, output-chain checks and capture. ProteinMPNN compatibility is not
measured function; prediction confidence is not affinity. Boltz's small-molecule
`boltz2-affinity` head is not a peptide/protein binder reward.

Additional native generators: `rfd4-redesign` consumes explicit parents through
cycling (partial geometry redesign or inverse folding); `complexa-binder` wraps
local Proteina-Complexa generation with an authored native search/reward policy.
Import/capture their modules as described in [generation](generative-design.md).

Native `alphafold2-prediction` supplies a local AF2-Multimer challenge to diffusion
predictors; use the forward-only runtime profile and supplied MSAs when available.
Native `ipsae-scoring` reports both ipSAE and pDockQ2 on a captured prediction.
Both are structural evidence, not calibrated affinity. See [local evaluation](local-evaluation.md).

## Antibody specialists: native proposal adapters

| Model | When useful | Current boundary |
| --- | --- | --- |
| [RFAntibody](https://github.com/RosettaCommons/RFantibody) | New target-facing CDR geometry/docking around a supplied antibody/VHH framework | Generator `rfantibody-binder`: antibody diffusion + CDR MPNN, one mutable H/L chain, fixed loop lengths and explicit fixed partners. Does not run RF2 assessment |
| [AntiFold](https://github.com/oxpig/AntiFold) | Regional sequence redesign on an existing antibody/nanobody structure, optionally with antigen context | Generator `antifold`: native residue probabilities supply proposals at explicit mutable sequence positions; accepts fixed or cycling conditioning. Does not generate a new backbone or measure affinity |

Both use `scripts/antibody_generators.py`, which inspection includes automatically;
copy/import it into authored Programs. They require independently installed isolated
interpreters and existing checkpoints; missing assets fail rather than auto-install.
See [antibody composition](generative-design.md#antibody-proposals) and campaign compute
notes for observed readiness. Availability does not establish feasibility for every
assembly. BoltzGen antibody/nanobody protocols remain outside our current bridge.

## Alternatives and selection

For protein–small-molecule work, native `boltz2-prediction` accepts ligand fragments
and `boltz2-affinity` provides ligand affinity estimates. Registry/schema support is
not verified local inference readiness. Read [small molecules](small-molecules.md)
before using their outputs or selecting proposals; the current BioIR Boltz bridge
is protein-only. Infrastructure must provision a compatible route.

For a local structural challenge, inspect native `esmfold2-prediction` with
`model_checkpoint="esmfold2-fast"`, `use_msa=False` and full PAE. Its released
runtime requires the [local compatibility profile](local-evaluation.md); the old
bundled installer is insufficient. Full ESMFold2 is a separate asset/readiness check.
For an explicit canonical protein complex, `prodigy-affinity` estimates pose-conditioned
DeltaG/Kd on CPU. Import/capture `scripts/local_affinity.py` in the Program, then call
it inside a native constraint or assessment. Keep partner IDs, coordinates and raw
features; lower estimated DeltaG does not establish stronger binding. See
[local evaluation](local-evaluation.md) for setup, composition and applicability.

Keep the full native registry available. Chai-1 is an alternative predictor;
RFdiffusion3/MPNN, PXDesign and FreeBindCraft are alternative design routes to inspect
when they could change a decision. Installed environments/assets are not equivalent
to verified campaign handoffs. Other antibody options include ImmuneBuilder structure
prediction, AbLang sequence priors and TAP developability profiling; no general
readiness claim is made here. Model/tool discovery can extend beyond this menu.

Use the [molecular-class guide](molecular-classes.md) for biological assumptions and
[handoff contract](molecular-contract.md) for chemistry support. Inspect input, config,
output and native conversion: registration alone can hide unsupported chemistry.
Check actual target/partner conditioning, fixed regions, size and output meanings.
Do not silently fall back to a scientifically different representation or model.

Reuse an applicable working model, recording consequential untested alternatives.
An end-to-end workflow inside every optimizer proposal can duplicate internal search
and cost. Preserve diverse families and test favorable edits in combination rather
than assuming additivity. Cross-model assessment can challenge assumptions but may
share error: compare paired changes and actual poses, keep each model's measurements
separate, and do not average confidence scores into a universal binding probability.
