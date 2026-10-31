# Native generation handoffs

Use the [model menu](models.md) for route choice and the [molecular contract](molecular-contract.md)
for supported representations. This reference owns execution details. Copy/import
the selected extension in the captured Program; imports load no weights. Assign its
generator to a compatible protein Segment and let the native optimizer own proposals
and selection. Inspect proposal/batch semantics before launching learned-model calls.

Native specifications and all referenced structures are trial inputs. Verify chain
roles and native residue numbering; output labels can differ from input labels.
Bridges preserve native outputs and fail on missing/partial or identity-inconsistent
results. Attached generated geometry is conditioning, not independent confirmation.
Refold selected hypotheses with full response/PAE capture before interpreting recovery.

## BoltzGen

`scripts/model_generators.py` registers `boltzgen-binder`. Supply native design YAML,
explicit output binder chain and fixed Segment length. Infrastructure supplies the CLI/cache.
File references resolve relative to the native YAML. The bridge reads the explicit
sequence-redesigned CIF stage, never substitutes another chain by length.

Select `protein-anything` for folded minibinders or `peptide-anything` when applicable.
Both run design + inverse folding only; standalone folding, complex prediction and
filtering remain explicit. The selected CLI exposes no model seed control, so the
Program seed alone does not control these samples. Capture all outputs/failures and
record this limitation. Other upstream protocols/chemistry need verified handoffs.

## RFD4-Proteina

The same module registers `rfd4-binder`. Supply one native YAML/JSON condition-spec
example, explicit output binder/target IDs and complete expected target sequence.
Infrastructure supplies the installed model bundle. Fixed binder length must
match the Segment. Native selectors use CIF label numbering; author numbering can
differ. Source: [RFD4-Proteina](https://github.com/RosettaCommons/RFD4-Proteina).

Program-derived CLI seeds advance per call; choose low/medium/high native recycle
effort for the scientific budget. These affect generation cost, not affinity.
`mode="generation"` is plain sampling. For native structural reward-guided beam
search, use `mode="guided_search"` with an explicit captured `search_spec`:
[local example](../examples/rfd4_local_search.yaml).

The local bridge supports interaction, clash, bond-length and hotspot metric providers,
interior checkpoints 1–59 in a 60-step schedule, and no external refolding oracle,
resume or final-checkpoint selection. Inspect actual provider output names/rewards.
Proto proposal count must be a multiple of native `beam_width`; replicates equal
proposals/beam width. Only final beams become proposals; completed scoring rollouts
and selected states remain captured. Count their compute separately. Internal rewards
shape proposals and are distinct from Proto selection and independent evaluation.

For explicit parent feedback, also copy/import `scripts/rfd4_redesign.py`.
`rfd4-redesign` is a STRUCTURE generator used through `CyclingOptimizer` with one
`RFD4Parent(parent_id, sequence, structure, evidence)` per proposal. Supply a complete
observed binder/target complex with matching sequence/IDs. The adapter normalizes
label/author numbering and captures the map, parent hash and consumed conditioning.

- `partial_redesign` uses `partial_fraction` of a 60-step trajectory's tail; this is
  not an angstrom displacement or diffusion-time value.
- `inverse_folding` preserves CA geometry while resampling identities/side chains.
- `fixed_positions` preserves binder identities. `backbone_condition_positions`
  supplies relative coordinates and can drift; express required geometric tolerances
  as Proto filters. `target_hotspots` expresses conditioning preferences, not proof
  of contacts. Each is a separate 1-based observed sequence mask.

The parent bridge rejects guided search because partial-schedule checkpoint semantics
are unvalidated. Fresh-generation guided search remains available. Cycling's filter
acceptance does not guarantee an improvement; re-predict children when measuring them.

## Proteina-Complexa

`scripts/complexa_generator.py` registers `complexa-binder`. Supply a fully composed,
resolved provisioned native configuration, captured target inputs, expected
target/output chains and a dataset/search budget yielding the Proto proposal count.
Edit scientific design/search settings; infrastructure owns checkpoint paths and
device configuration. Use `target_hotspots=[]` for no hotspot preference;
null omits a mask required by the protein checkpoint.

The bridge calls native `proteinfoundation.generate` directly with batch 1/one job;
it adds no multi-stage pipeline. Native configuration owns single-pass, best-of-n,
beam/FK/MCTS search, rewards and refinement. Generation is verified; advanced policies
need provisioned support; the current generation profile does not establish a
working GPU AF2 reward path.

Only native `final` samples become Proto proposals; retain `lookahead`,
`final_unrefined`, raw rewards and diagnostics. Returned structures use contiguous
numbering with an explicit map; original gapped PDBs remain captured. Check resolved
phase enablement before attributing an effect to refinement: parameters in a disabled
block do not mean it executed.

## Antibody proposals

Copy/import `scripts/antibody_generators.py` for `rfantibody-binder` and `antifold`.
Supply captured scientific inputs and use provisioned installation defaults.
Independent assessment remains explicit.

RFAntibody runs native antibody diffusion then CDR-only ProteinMPNN. Supply an
HLT-annotated framework, target, fixed-length loops on one mutable H/L chain and
expected fixed partners/Segment length. Framework and partner identities are checked;
RF2 assessment is not run. Paired antibodies retain the other chain as context;
separate H/L Segments are not jointly optimized.

AntiFold captures per-residue log probabilities and samples only explicit
`mutable_positions` with configured temperature and Program seeds. Native ANARCII
numbering and H/L/antigen sequence maps are retained. It accepts
`InverseFoldingStructureInput` through cycling; mutable/fixed positions and selected
chains must agree. Its `structure_path` alone does not satisfy first-stage native
Program inverse-folding initialization. Returned geometry remains conditioning.

Inspect selected schemas via [API inspection](api.md), then check a small actual
prediction→proposal→constraint handoff. Antibody numbering, sequence positions and
coordinate IDs require explicit mapping; native probability scores are not affinity.
