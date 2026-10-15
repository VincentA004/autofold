# Autofold science workflow reconstruction proposal

The next workflow should establish whether its measurements discriminate useful PD-L1 candidates before optimizing those measurements. The completed coordinator campaign demonstrated reliable ordinary continuation, receipt settlement and shutdown for its admitted jobs. Its best computational proxy improved by roughly 10.5%, but the fixed scrambled control failed before scoring, some structural confidence deteriorated, and sequence heuristics contributed to the objective. These results support further engineering and scientific calibration, not a binding claim.

This proposal preserves the operation coordinator, immutable trial snapshots, frozen scoring contracts, receipts, provider accounting and canonical evidence. It changes the scientific inputs, measurement semantics and experiment design in a new versioned experiment. All previous grants remain closed. Model installation, target changes, execution-profile changes, contract activation and new GPU work are separate future actions.

## Scientific scope and success criteria

Choose one primary objective: computational binder discovery against a precisely defined PD-L1 construct, with experimental binding and specificity as the eventual success criteria. Decide separately whether the product is a 12–16 residue cyclic peptide or a folded miniprotein. A model performing well on 60–100 residue binders is not automatically established for a 12 residue cyclic peptide.

Record the desired binding site and whether occupation of that site is expected to inhibit a particular interaction. Predicted binding away from the relevant site is a different outcome. Distinguish target binding, competition with PD-1, stability, solubility, manufacturability and selectivity. Do not collapse these into an unexplained scalar.

A successful computational milestone is a diverse shortlist with chemically faithful inputs, reproducible interface evidence, stronger discrimination than matched controls, and explicit uncertainty. A physical milestone requires the relevant binding and functional assays. Neither low model loss nor agreement between predictors establishes those physical outcomes.

## Gaps found in the existing implementation

| Gap | Source evidence | Consequence | Proposed replacement |
| --- | --- | --- | --- |
| Candidate chemistry is reduced to sequence during prediction | `backend/worker/autofold_worker/evidence_pipeline_v3.py::_enrich_v4` constructs `complexes=[target_sequences + [sequence]]`; `generator_spec.py` can specify cyclic peptides and disulfide bonds | A generated cyclic or disulfide candidate is not explicitly represented as that chemistry to the predictor | A typed molecular entity and covalent topology contract, checked against each model adapter |
| Target prediction input is reduced to chain sequences | Same bridge reads only `target["chains"][...]["sequence"]` | Structural context, residue mappings, modifications and glycans are not passed through this input construction | Target preparation artifact plus model-specific structure, MSA, glycan and template handling |
| Agreement is similarity of confidence numbers | `_agreement` computes a standard-deviation penalty on interface and fold confidence; fewer than two observations return 1 | Two different poses can receive similar confidence; a single observation can look fully agreed | Separate confidence consistency from target-aligned pose and interface-contact consistency |
| Missing model metrics have substitutions | The bridge falls back among ipTM, generic confidence, pTM and pLDDT fields | Metrics with different meanings can be substituted into the same objective | Per-model metric schema, documented units and nullable unsupported values; no silent substitution |
| Only the first returned prediction is recorded | The bridge uses `prediction.structures[0]`; the frozen Chai configuration requests five diffusion samples | Any additional structures returned by the adapter are not preserved in these model-run receipts | Sample-level provenance, frozen selection rules and ensemble variability, with actual returned cardinality recorded |
| Developability scores are sequence heuristics | `_sequence_metrics` uses hydrophobic fraction, charge, short windows, length and cysteine content | Optimization may improve formula values without improving experimental developability | Clearly typed heuristics plus structural measurements and, eventually, assays |
| Fixed negative control reconstruction fails | Host inspection includes constraint settings; worker static inspection omits them and compares entire dictionaries | A scientific control can fail without providing a measurement | Shared semantic construction schema and host-to-worker round-trip tests before GPU dispatch |
| Calibration support counts observations | `EvaluatorCalibration.audit` requires at least two recorded positives and negatives, without itself establishing independent molecular identities or label provenance | Repeated rows do not establish independent calibration | Reference-label provenance, canonical chemical identity, generator/RNG independence and descriptive uncertainty |
| Model inputs and predictions do not define a complete chemical identity | Candidate schema requires sequence, seed and modality; generation metadata is separate | Cyclic sequence rotations, different bond topologies or stereochemistry can be conflated or missed by sequence-only uniqueness | Canonical molecule hash plus entity/topology hash, separate from program and model parameter hashes |

These are source-level findings. They do not retroactively change any previous score, receipt, acceptance outcome or grant. The original failed control remains failed. Existing advisory instructions already caution that derived controls are not known nonbinders and computational calibration is not physical binding; the new design should enforce those distinctions in typed evidence.

The current panel assigns 0.30 interface-confidence, 0.20 fold-confidence, 0.15 confidence-agreement and 0.35 total sequence-heuristic weight. Its eligibility floors of 0.20 interface/fold confidence are engineering policy, not established PD-L1 binding thresholds. A new objective needs calibration instead of carrying these constants forward as scientific truth.

## Chemical and target representation

Introduce a versioned `MolecularCandidate` with:

- Entity sequence and residue numbering; residue chemistry including supported modifications and stereochemistry.
- Explicit head-to-tail, disulfide or other covalent bonds with atom-level endpoints.
- Canonical molecular identity and topology hash. For cyclic molecules, equivalent starting positions must not create artificial uniqueness.
- Intended modality and allowed topology, generated structure hash, target identity and binding-site mapping.
- Generator/model/checkpoint/configuration identity, actual seed-control mode, generation attempt and output identity.

Introduce a `PreparedTarget` artifact with exact construct, chain and residue mapping, observed structure, unresolved residues, alternate conformations, glycosylation/modifications, provenance, MSA/template policy, and site selection. Decide explicitly whether the relevant target is glycosylated and membrane-associated or an assay-specific soluble construct. Do not infer physiological accessibility from an arbitrary cropped structure.

Every model adapter should publish capabilities: supported entities, covalent bonds, modifications, input structures/templates, MSAs, native confidence fields and units. A required stage must reject unsupported candidate chemistry before dispatch. A diagnostic stage may mark it unsupported with a typed reason. Native Boltz-2 and Chai expose routes for explicit bonds, but the present sequence-only adapter does not exercise them. It must never silently score a cyclic candidate as a linear molecule.

Extend model-run identity with an explicit prediction sample axis. Preserve every returned sample, record the adapter’s actual sample cardinality, and freeze the rule for selecting representative predictions. Do not confuse five configured diffusion samples with five independently recorded or validated predictions.

Store the exact materialized model input and its content hash in the model receipt. Comparing output provenance is not enough if the input chemistry differs across models. Templates and design-site restraints should be recorded as conditioning; restrained predictions cannot serve as unqualified independent evidence that the unrestrained peptide finds the same interface.

## Model roles and workflow alternatives

Use the [model landscape report](../research/protein-model-landscape-2026-10-10.md) to select exact releases and licenses. No model name alone guarantees suitability, local availability or runtime fit. An ESM sequence embedding used by Chai is not an ESMFold structural prediction.

For short cyclic peptides, use a chemistry-capable generation lane, initially the already integrated BoltzGen path if its topology support passes the new adapter tests. Compare constrained linear and cyclic interventions under separate chemical identities. RFpeptides (cyclic RFdiffusion → ProteinMPNN → AfCycDesign) is a directly relevant macrocycle comparator because it explicitly preserves ring-aware representations. Evaluate its exact release, dependencies, weight terms and local hardware fit before adopting it. Other peptide-specialist generators should remain experimental until weights, chemistry handling and evidence are verified. Do not make PXDesign or an ESM monomer-fold threshold mandatory for this modality solely because they are useful on folded proteins.

For folded miniproteins, compare a small generation portfolio: BoltzGen, an RFdiffusion3 → ProteinMPNN/SolubleMPNN lane, and PXDesign or BindCraft where their local profile fits. Prefer a few well-measured lanes over a wide collection of uncalibrated methods. Inverse folding creates sequence alternatives for a designed backbone; it does not prove target binding.

ESMFold or a suitable ESMFold2 variant can provide a foldability screen for a folded binder, or an additional complex-prediction diagnostic if that exact model supports the required chemistry. A flexible short peptide may become ordered on binding; low isolated-peptide fold confidence alone should not reject it. Model agreement should compare predicted interfaces and configurations rather than only scalar confidence.

Use a calibrated two-model complex panel for every shortlisted candidate. Add a third model to finalists, disagreements and a sampled set of rejected candidates. The latter prevents a screening cascade from hiding systematic false negatives. Multiple model families remain correlated through training data and prediction assumptions; agreement is a diagnostic, not a measured probability of binding.

A generator that uses a predictor internally for optimization has already exposed its designs to that predictor. Record that coupling. Preserve at least one evaluation model or configuration outside the optimization loop and avoid calling it statistically independent without evidence.

## Measurement and selection

Retain native model outputs with model-specific names and units. Add target-aligned structural comparisons, interface residue/contact maps, clash counts, bond-closure geometry, buried surface area and relevant side-chain/epitope contacts where reliably computable. A ground-truth metric such as DockQ is appropriate for calibration complexes with known structures; between two predictions, report pose/contact consistency without labeling it experimental accuracy.

Separate evidence into five axes:

1. Chemical validity and supported representation: a prerequisite, not a weighted benefit.
2. Target/interface plausibility: site, contact geometry, uncertainty and robust predictions.
3. Reproducibility: across prediction seeds/configurations and, separately, generation replicates.
4. Developability/manufacturability: descriptive sequence flags, structural measurements and empirical observations kept distinct.
5. Specificity: planned comparison targets and experimentally relevant controls; not inferred from the target-only score.

Use eligibility rules and a Pareto shortlist before a tie-breaking score. Preserve candidates with different strengths rather than letting a heuristic solubility improvement compensate for absent interface evidence. Freeze the comparable evaluation panel within each experiment. Changing chemistry support, target preparation or scientific objective creates a new contract and comparison cohort, not a silent upgrade of the previous hill-climbing score.

## Calibration and experiment design

Start with a modest, source-backed reference panel matching the intended construct and modality. Record assay provenance, construct, conditions and uncertainty for any known-positive or known-negative label. A shuffled candidate is an assumption-testing control, not a verified negative; failure to bind must not be invented. Add length/composition-matched shuffles, unrelated-sequence controls, alternate-site/target controls and validated references where available, each with its actual label authority.

Use independent molecule identities for calibration discrimination and repeated evaluations of the same molecule for prediction variability. Keep these two axes separate. Identical sequence/seed/configuration outputs do not become independent evidence because they have different run IDs.

Pre-register a small generator comparison, the reference panel, required evaluators, a diversity criterion, a repeat plan and stopping decisions. Record distributions and failure rates rather than a single best sample. If reference discrimination fails, suspend score optimization and investigate target representation, model capability or evaluator semantics. If calibration is merely absent, describe discovery as exploratory instead of labeling proxy improvements as binding gains.

The former fourteen-trial grant is closed and the former per-trial 600-second budget is a historical envelope. This proposal does not assume every new model panel will fit that envelope. Benchmark exact model and target configurations before selecting a new compute grant. Use serial GPU stages on the 4090, record wall time and peak VRAM, and reserve execution capacity for controls and repeats rather than consuming it all on generated proposals.

## Implementation sequence and acceptance

### Stage one semantic correctness without GPU work

Repair static construction parity using a shared semantic schema for sequences, constraints, optimizer parameters and sampling bounds. Descriptive documentation and optional probes must not introduce an unstable admission/worker comparison. Test unchanged programs across compiler and worker; mutation of sequence, chemical topology, constraint parameters or sampling bounds must fail.

Add chemical/entity and target-preparation schemas, model capability declarations and materialized-input artifacts. CPU fixtures should cover linear, head-to-tail cyclic and disulfide candidates, residue mapping, target glycan declarations, unsupported chemistry, wrong bond endpoints and canonical identity. Require input fidelity through the entire generator-to-validator path.

Version metric normalization and separate numeric confidence consistency from geometric agreement. Tests should demonstrate that similar confidence with different interfaces is not geometric agreement, a missing predictor yields unknown agreement, and pLDDT, pTM and ipTM cannot substitute silently. Strengthen calibration identity and label-provenance checks while preserving historical labels and decisions.

### Stage two a bounded model smoke assessment

After a new explicit compute authorization, benchmark the selected models on representative target/candidate inputs. Verify checkpoint/license identity, actual chemistry support, native output artifacts, peak VRAM, wall time, timeout behavior and complete accounting. Include the exact cyclic/disulfide representation if that is the selected modality. This stage establishes execution and representation; it does not establish improved scientific predictions.

### Stage three calibration before optimization

Run the frozen source-backed reference and control panel. Evaluate discrimination, uncertainty, chemistry fidelity, pose consistency and failure rate. Identify whether a simple baseline performs similarly. Keep descriptive small-sample results distinct from a calibrated binding probability. Establish acceptance thresholds prospectively rather than adopting benchmark thresholds from unrelated binder lengths or modalities.

### Stage four comparative discovery

Compare a limited generation portfolio at equal budgets using independent candidates, supported seeds/replicates, a frozen evaluation panel, a held-out diagnostic and a diverse shortlist. Distinguish better valid yield, better measurement-supported candidates and cheaper execution. Refine scientific guides only on independent comparisons; reject unsupported improvements and retain the parent guide when appropriate.

### Stage five physical evidence

Select a diverse panel with controls for synthesis or expression. Use assays matching the claimed outcome: binding affinity and kinetics, competition/function where relevant, specificity, solubility/aggregation and stability. Enter those observations with versioned assay metadata and uncertainty as a separate evidence type. They can then calibrate the next computational contract.

## Decision to make after research

The most useful first decision is the intended binder modality and available assay path. With a strict short-peptide objective, prioritize chemistry preservation and peptide-specific validation. With flexibility to design folded miniproteins, the broader generator ecosystem and ESM foldability screens become more applicable. Do not select a modality merely because a particular model receives favorable aggregate scores.

The proposed first milestone is a reliable, chemically faithful reference/control workflow. More GPU discovery becomes informative after that milestone. The completed operation-coordinator run remains valuable engineering evidence, while the unresolved scientific assumptions remain explicit.

## Evidence

- [Model landscape report](../research/protein-model-landscape-2026-10-10.md)
- [Source audit and file hashes](../research/science-workflow-source-audit-2026-10-10.json)
- [Completed coordinator campaign](../acceptance/coordinator-long-range-2026-10-10.md)
- [Current workflow contract](../dynamic-proto-workflow-v1.md)
- [Generation provenance](../generation-run-index-v1.md)
- [Model-run provenance](../model-run-index-v2.md)
- Source: `backend/worker/autofold_worker/evidence_pipeline_v3.py`, `generator_spec.py`, `peptide_panel_v1.py`, `adapters/proto.py`; `backend/science-core/src/research/execution-protocol.ts`, `workflow.ts`, `evaluator-calibration.ts`, `scientific-inquiry.ts`.
- [Boltz input format and chemistry support](https://github.com/jwohlwend/boltz/blob/main/docs/prediction.md)
- [ESM model documentation](https://github.com/Biohub/esm)
- [PD-L1 glycosylation and antibody binding study](https://pmc.ncbi.nlm.nih.gov/articles/PMC8158060/)

Prepared October 10, 2026. Proposed new contracts and scientific gates have not been implemented or GPU-validated by this research task.
