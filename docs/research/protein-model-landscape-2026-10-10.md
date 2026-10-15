# Protein and peptide model landscape for Autofold

Research date: 2026-10-10. Research only: no experiment inference, installs, model-weight downloads, dispatch, GPU work or production source changes were performed. All earlier inference grants are closed. Hardware context is one RTX 4090; historical per-trial generation/scoring cap was 600 GPU seconds, not a renewed authorization.

## Executive recommendation

The first reconstruction priority is chemical identity and evidence validity, followed by model choice. A sequence-only validator cannot substantiate a claim about a head-to-tail macrocycle, disulfide peptide, glycosylated target, or retained target geometry. Preserve molecular topology from generation through prediction and analysis. Do not call agreement between two scalar confidence scores structural agreement, and do not let sequence heuristics imply binding or measured developability.

For 12–16-residue cyclic PD-L1 peptides, retain topology-capable BoltzGen or evaluate RFpeptides/AfCycDesign as a dedicated alternative, and validate the exact cyclic molecule with native topology-aware complex predictors. For miniproteins, BoltzGen and PXDesign are credible generators, while ProteinMPNN/SolubleMPNN, optional LigandMPNN, and multiple refolding models fill distinct roles. ESMFold2 is a real current release and a promising additional evaluator; it is not imaginary or merely a third-party website. Benchmark it as a versioned alternative so historical scores remain comparable.

The historical 13 trials, 12 valid scores and approximately 10.5% best proxy improvement show operation and proxy optimization. They do not establish a binder discovery rate, physical affinity improvement, specificity, or experimental success. Seven ordinary trials plus six paired trials on one candidate per trial are especially vulnerable to best-of-run selection, generator–evaluator coupling, and inadequate seed replication.

See the [workflow reconstruction proposal](../design/science-workflow-reconstruction-2026-10-10.md) for implementation stages and acceptance criteria, and the [source audit](science-workflow-source-audit-2026-10-10.json) for audited file hashes.

## Evidence notation and provenance

**A:** directly inspected official code, documentation, license or model card. **B:** primary research paper/preprint, including experimental results that apply to that paper's tested molecules. **C:** reasoned workflow recommendation or inference from A/B; not an experimentally established performance claim. **U:** unresolved evidence, such as missing per-checkpoint weight terms or unverified hardware fit.

Repository `main`/`production` is mutable. Exact model/checkpoint names below are verified where available, but this research did not resolve every current upstream commit SHA. Record a commit SHA, package version, checkpoint SHA256, chemistry dictionary revision, precision/backend, MSA/template hashes, and seed schedule before a future run. Package version alone is insufficient. Historical execution snapshots pin BoltzGen commit `a3149cf18eeb58648d1abbb27539bd73f746cdda`. Its frozen configuration must be inspected separately; present upstream defaults do not describe the historical run.

## Separate the scientific jobs

| Job | Correct output | What it cannot establish alone |
|---|---|---|
| Sequence language model / embedding | Amino-acid logits, embeddings, masked-token likelihood, learned representation | Bound pose, cyclization chemistry, affinity, specificity |
| Inverse folding | Sequences compatible with a supplied backbone/context | Whether the backbone is realizable or binds |
| Backbone/binder generation | Candidate structures and/or sequences conditioned on target/hotspots | Independent confirmation of a successful design |
| Monomer prediction | Unbound fold hypothesis, structural confidence | Interaction affinity; short peptides may be disordered until binding |
| Complex prediction | Pose hypothesis, confidence/PAE/contact evidence | Binding equilibrium, kinetic residence time, activity, selectivity |
| Affinity prediction | Model-specific calibrated quantity in a supported chemical domain | General peptide Kd or clinical efficacy |
| Physical analysis | Geometry, energy, dynamics hypotheses under stated chemistry and force field | Proof of binding from a short relaxation or MD trajectory |
| Experimental validation | Identity/purity, binding/function and counterscreen observations | Generalization beyond tested constructs and assay conditions |

## Sequence models and folding models

### ESM-2 and original ESMFold

**A:** Meta's archived [official ESM repository](https://github.com/facebookresearch/esm) distributes ESM-2, `esmfold_v1` and inverse-folding `esm_if1_gvp4_t16_142M_UR50`. ESM-2 is a sequence language model, not a complex evaluator. Useful explicit checkpoint: `esm2_t33_650M_UR50D`. ESMFold v1 has a 3B language model plus approximately 690M folding parameters; v1 is recommended over v0. The repository permits colon-separated multichain input, but this does not make its interaction confidence a calibrated binder classifier. MSA-free; structure output is PDB with pLDDT. Chunking, CPU offload and batching are documented memory controls; no 4090 time guarantee was verified. Legacy Python/OpenFold dependency requirements and archived maintenance matter. [README](https://github.com/facebookresearch/esm/blob/main/README.md), [MIT license](https://github.com/facebookresearch/esm/blob/main/LICENSE).

**C:** use ESM-2 for representation, diversity, novelty or a clearly labeled sequence prior. Use ESMFold v1 as a cheap additional monomer hypothesis if already available, especially for miniproteins. A flexible 12-mer's low monomer confidence is not automatically a failure to bind; high confidence is not an affinity score. Neither ordinary sequence inputs nor monomer prediction encode macrocyclization or glycan state.

### ESM C / Cambrian

**A:** current checkpoint family includes `biohub/ESMC-300M`, `ESMC-600M`, `ESMC-6B`. It returns embeddings and masked-sequence logits and is distinct from ESM-2, ESM3 and ESMFold2. The [official ESMC-6B card](https://huggingface.co/biohub/ESMC-6B) describes 6B parameters, 80 layers and GPU-oriented deployment. Its displayed license metadata includes both `mit` and `other`; the [current official repository](https://github.com/Biohub/esm) says these models are MIT. This discrepancy should be captured rather than hidden. Inspect exact checkpoint license files and notices before an acquisition decision. Local inference is documented; all required artifacts must be cached for offline use.

**C:** smaller ESMC is more proportionate than 6B for auxiliary embeddings on a 4090. It still cannot establish peptide binding, and protein sequence likelihood does not cover noncanonical residues or topology without a specialized representation.

### ESM3

**A:** `biohub/esm3-sm-open-v1` is a multimodal masked generative model conditioned on sequence, structure and function tracks. Current [official ESM3 documentation](https://github.com/Biohub/esm/blob/main/_assets/ESM3_README.md) lists 1.4B small, 7B medium and 98B large variants; only small-open weights are publicly local there, larger variants are API offerings. The [current small-open card](https://huggingface.co/biohub/esm3-sm-open-v1) explicitly links MIT, unlike old noncommercial release summaries. Do not retroactively relabel an old gated artifact: preserve its downloaded license snapshot. It needs no MSA and can run locally once weights and structure/function codecs are cached. No reliable 4090 runtime/VRAM measurement was verified.

**C:** helpful exploratory generator/inpainting model for proteins, but not the first choice for a target-bound, explicitly cyclized 12–16mer. Function keywords and monomer structure tracks are not a calibrated PD-L1 affinity objective.

### ESMFold2 and ESMFold2-Fast — real as of this research date

**A:** [Biohub/ESMFold2 model card](https://huggingface.co/biohub/ESMFold2) confirms public all-atom structures, confidence/PAE/distograms, biomolecular complexes, modified amino acids, and optional MSA. Full checkpoint has approximately 7B total parameters and a September 2021 structure-training cutoff. The [Fast model card](https://huggingface.co/biohub/ESMFold2-Fast) confirms single-sequence-only Fast, also MIT. Fast is not simply full-model inference with MSA disabled. The [official repository](https://github.com/Biohub/esm) reports package `esm v3.4.post1` and Transformers support beginning 5.16.0. Code and model release claims are MIT; full-model card states predictions require experimental validation. [Primary preprint](https://www.biorxiv.org/content/10.64898/2026.06.03.729735).

**C/U:** this is a useful new comparison axis with a sequence-model foundation, but shares structural data priors with other PDB-trained models. No verified 24GB fit or seconds-per-PD-L1-candidate guarantee is supplied here. Approximate parameter storage arithmetic is not a peak-VRAM benchmark. Explicit macrocycle/disulfide support must be verified in the exact input builder; modified residues and all-atom capability alone do not prove arbitrary bond support.

**A:** [BoltzGen's ESMFold2 integration guide](https://github.com/HannesStark/boltzgen/blob/main/docs/esmfold2.md) says present polymer protocols use full ESMFold2 2021 interaction scoring, while Boltz2 structural checks remain. Default scoring is 20 loops, 200 diffusion steps and five samples with LM dropout 0.3, no homolog MSA or target coordinate template. Integration requires about 33GB extra disk and CUDA13-compatible driver, prepares a separate cached runtime, and supports offline reuse after caching. This is integration-specific evidence, not a universal ESMFold2 GPU requirement. Changing acceleration backend can change numerical predictions, so backend belongs in the evidence fingerprint.

## Complex prediction and affinity

### Boltz-2

**A:** [official repository](https://github.com/jwohlwend/boltz) releases code and weights under MIT. Boltz2 has separate structure and affinity checkpoints (`boltz2_aff.ckpt` is visible in [source](https://github.com/jwohlwend/boltz/blob/main/src/boltz/main.py)). It takes complex YAML and returns structures/confidence, optionally ligand affinity. [Prediction schema](https://github.com/jwohlwend/boltz/blob/main/docs/prediction.md) supports cyclic polymer flags, explicit bonds for canonical residues/CCD components, modifications and templates. Precomputed MSA enables offline use; `msa: empty` explicitly forces single-sequence, which upstream cautions can reduce accuracy. Optional remote MSA generation is not offline. No universal 4090 timing was verified.

The affinity head is for a **single small-molecule ligand**, not a protein chain; input parsing [rejects protein-chain affinity](https://github.com/jwohlwend/boltz/blob/main/src/boltz/data/parse/schema.py). Docs recommend staying near training ligand sizes, cautioning against substantially over 56 atoms; 128 is a parser limit, not validation. The value is log10 IC50 in micromolar conventions, not universal Kd. A 12–16mer converted to ligand SMILES is not thereby inside the affinity training domain. Do not call that a peptide affinity estimate without independent calibration.

### Chai-1

**A:** [official chai-lab](https://github.com/chaidiscovery/chai-lab) recommends package `chai_lab==0.6.1`; supports proteins, ligands, nucleic acids, modified residues and glycans. Default gives five samples with embeddings, no MSA/templates. Both can be provided; upstream recommends MSA for improved performance. Linux, CUDA and bfloat16 are required; recommended GPUs are A100/H100 80GB or L40S48GB, with smaller devices for small complexes and reported 4090 success. Code/weights are now Apache2 according to current release documentation and [license](https://github.com/chaidiscovery/chai-lab/blob/main/LICENSE). Offline use requires cached weights and any embeddings/chemical data. It is structure prediction, not a validated peptide affinity head. Verify exact covalent restraint syntax and adapter coverage before claiming cyclic evaluation.

**Chai native capability clarification (A):** official [advanced-input documentation in README](https://github.com/chaidiscovery/chai-lab#how-can-i-customize-the-inputs-to-the-model-further) explicitly supports constructing `AllAtomFeatureContext` with covalent bonds through `run_folding_on_context`. This is a credible adapter path for explicit topology; the ordinary sequence-only bridge does not exercise it. Validate the exact ring/bond representation and output closure rather than treating native support as proof the current adapter uses it.

### Protenix: pin v1; do not assume v2 weights are unrestricted

**A:** [current official README](https://github.com/bytedance/Protenix) identifies `protenix_base_default_v1.0.0` and `protenix_base_20250630_v1.0.0`, released 2026-02-05, both 368M; the former uses 2021-09-30 cutoff, latter 2025-06-30. They support MSA/RNA MSA/templates. Base v0.5.0 and Mini are older alternatives. The 2026-04-08 v2 is 464M. Crucially, its specific update says v2 weights are proprietary/confidential and cannot be reproduced/distributed/sublicensed/disclosed/transferred without written consent. The same README's generic license section says project code and parameters Apache2. These conflict; the version-specific restriction must not be ignored. [Code license](https://github.com/bytedance/Protenix/blob/main/LICENSE) does not resolve that v2 checkpoint restriction. Exclude v2 from the unrestricted local stack pending exact artifact terms.

**C/U:** v1 or Mini can be useful held-out complex evaluators, with local MSA cache. Prediction output is structure/confidence, not peptide Kd. Short cyclic model coverage and 4090 resource use require exact version-specific validation. MSA availability is not evidence of peptide evolutionary coupling: a de novo peptide generally has no homologous MSA.

### RoseTTAFold3 / RF3

**A:** [official RF3 documentation](https://github.com/RosettaCommons/foundry/blob/production/models/rf3/README.md) releases three checkpoint names: `rf3_foundry_01_24_latest_remapped.ckpt`, `rf3_foundry_01_24_preprint.ckpt`, `rf3_foundry_09_21_preprint.ckpt`. It is an all-atom predictor with atom geometry/chirality conditioning; JSON/CIF supports explicit molecular bonds. It outputs CIF plus confidence and ranking data. Precomputed MSA accepted; no on-the-fly MSA computation or externally prepaired MSA support in inspected docs. No-MSA is possible but early stopping can produce only metric files. Foundry code is [BSD3](https://github.com/RosettaCommons/foundry/blob/production/LICENSE.md); individual off-repository checkpoint terms were not separately verified (**U**). Do not conflate this with permission for all Rosetta/PyRosetta software. GPU/runtime fit on this 4090 remains unbenchmarked.

## Generators and inverse folding

### BoltzGen

**A/B:** model `boltzgen/boltzgen-1` has an [MIT model card](https://huggingface.co/boltzgen/boltzgen-1); [primary paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC12697729/) states release of weights/code/designs under MIT. Current [pyproject](https://github.com/HannesStark/boltzgen/blob/main/pyproject.toml) declares 0.3.2. [README](https://github.com/HannesStark/boltzgen) documents target structure/sequence/hotspots and cyclic `peptide-anything`; outputs ranked design CIF/metadata and refolded complexes. Present main defaults to SolubleMPNN with ESMFold2 scoring; earlier installation may differ. Generation, inverse folding, refolding, physical analysis and filtering are separate steps. MSA dependence is step-specific. Official performance graphic is A100-based, not a 4090 SLA. The paper's experimental binder success does not transfer to Autofold's restricted candidate count or its exact PD-L1 12–16mer chemistry.

### PXDesign

**A/B:** [official suite](https://github.com/bytedance/PXDesign) pairs PXDesign-d with Protenix and AF2-IG selection. Its PDL1 quick-start uses cropped structural target, hotspots, recommended precomputed target MSA and an 80-residue binder; this is evidence for miniproteins. [setup.py](https://github.com/bytedance/PXDesign/blob/main/setup.py) says 0.1.0 and Apache2. [Installer](https://github.com/bytedance/PXDesign/blob/main/install.sh) pins Protenix `v0.5.0+pxd`, so current Protenix v2 terms must not be projected onto that bundled dependency. Official README states project free for commercial use; exact downloaded PXDesign/checkpoint and external tool notices still need manifests. [Technical report](https://protenix.github.io/pxdesign/technical_report.pdf) includes a cyclic peptide benchmark with PD-L1 among targets. This is not equivalent to demonstrated wet-lab success for every cyclic target. Runtime plot is NVIDIA L20; Extended/Preview/Infer have materially different evaluation scope. No reliable 4090 timing established.

**C:** preserve candidate generation as distinct from full vendor pipeline. PXDesign's own AF2/Protenix filters are selection oracles and cannot also be described as wholly independent confirmation. A candidate surviving them can still be tested with topology-aware Boltz2/Chai1/ESMFold2, while acknowledging correlated priors.

### RFdiffusion, RFdiffusion3 and RFpeptides

**A/B:** [RFdiffusion](https://github.com/RosettaCommons/RFdiffusion) generates backbones conditioned on motifs, contigs and target hotspots; ordinary protein generation usually requires sequence design afterward. Original RFdiffusion and its cyclic extension are different configurations, not interchangeable linear outputs. [RFpeptides paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC12643943/) describes cyclic-offset RFdiffusion → ProteinMPNN → cyclic-aware AfCycDesign/RoseTTAFold validation, with experimental complex structures; code is in RFdiffusion and Zenodo 10.5281/zenodo.15264344. This is directly relevant to 12–16mer macrocycles. Code BSD license is visible, but separately hosted historical weight licensing is explicitly queried in [upstream issue](https://github.com/RosettaCommons/RFdiffusion/issues/135); resolve exact artifact terms before claiming unrestricted commercial stack.

**A:** [RFD3 official guide](https://github.com/RosettaCommons/foundry/blob/production/models/rfd3/README.md) is all-atom generation with complex atom/sequence/geometry constraints, locally available through Foundry. It supports fixed atoms and partially fixed sequence/structure; hydrogen-bond conditioning adds an HBPLUS dependency. `foundry install rfd3` selects a mutable registry checkpoint unless explicitly frozen. Foundry is BSD3; per-checkpoint license inspection remains **U** here. MSA is not a prerequisite for backbone design; later refolding has separate requirements. No verified 4090 latency or VRAM guarantee. Useful broader experimental option, but not a reason to replace a specialized cyclic pipeline without controls.

### ProteinMPNN, SolubleMPNN, LigandMPNN and ESM-IF1

**A:** [ProteinMPNN](https://github.com/dauparas/ProteinMPNN) maps backbones to sequences/log probabilities; canonical checkpoint `v_48_020`, soluble variants `v_48_010`/`v_48_020`. No MSA/templates required beyond supplied structure; code/weights MIT, local once cached. SolubleMPNN is trained on soluble proteins, not a measured solubility model. [LigandMPNN README](https://github.com/dauparas/LigandMPNN/blob/main/README.md) explicitly says code and parameters MIT, accepts atomic ligand/context, can use fixed sidechains and pack sidechains. [run.py](https://github.com/dauparas/LigandMPNN/blob/main/run.py) identifies `ligandmpnn_v_32_010_25.pt` and `proteinmpnn_v_48_020.pt`. Both are lightweight relative to diffusion cofolding; no unsupported GPU seconds claimed. ESM-IF1 adds another structural sequence prior, not direct target binding evidence.

**C:** canonical sequence redesign preserves a cyclic backbone only if downstream topology is preserved; FASTA alone does not. For cyclic peptides, evaluate whether training context covers rings and the actual bonds remain intact. Do not force protein-sized hydrophobic-patch or folded-core heuristics onto tiny macrocycles.

### BindCraft and AfCycDesign

**A:** [BindCraft](https://github.com/martinpacesa/BindCraft) combines AF2 gradient design, MPNN and PyRosetta. Project code MIT; PyRosetta needs a commercial license. Upstream recommends at least 32 GB GPU memory and hundreds or thousands of trajectories for difficult targets. This makes it a research comparator/miniprotein workflow, not a default fit for a 24 GB 4090 / 600-second cap. It is not independent of AF2-based validation. [AfCycDesign primary paper](https://www.nature.com/articles/s41467-025-59940-7.pdf) uses cyclic positional encoding for peptide folding/design, making ring-aware inference central. Use the exact [ColabDesign cyclic notebook](https://github.com/sokrypton/ColabDesign/blob/main/af/examples/af_cyc_design.ipynb), commit, AF2 parameter license and custom offset, not ordinary AF2 inference renamed cyclic.

**C/U:** PepMLM and DiffPepBuilder are relevant specialized leads ([PepMLM primary preprint](https://arxiv.org/abs/2310.03842), [DiffPepBuilder primary preprint](https://arxiv.org/abs/2405.00128)), but this audit did not validate their exact present artifact licenses/hardware. PepMLM is target-sequence-conditioned linear peptide generation, not chemistry-aware ring generation. Do not expand the production model roster merely because a paper has a compelling name. Emerging 2026 cyclic diffusion papers are exploratory until release, chemistry, benchmarking and licensing are verified.

## Missing scientific contracts in Autofold (source audit)

The source audit shows `evidence_pipeline_v3.py::_enrich_v4` constructing predictor input only as target sequences plus candidate sequence. Generator metadata specifies `cyclic:true` or explicit cysteine bonds, while generated complex structures are saved separately. Thus existing evidence validates a sequence representation, not demonstrably the generated chemical entity. Native Boltz2 has the needed cyclic/bond fields; the adapter must preserve them. Fixed Proto configs may carry global options but cannot supply candidate-specific ring/bond identity from sequence alone.

Required molecule schema: stable molecule fingerprint; chains and role; canonical sequence and residue numbering maps; atom identities; residue modifications/stereochemistry; cyclization class; atom-level covalent bonds; disulfide pairing; terminal caps; target construct, chain selection and residue crop; glycan entities/bonds; ligand/ion context; source structure checksum. Both generated and validator representations must serialize back to the same intended chemical graph. Validate graph/atom coverage before dispatch and fail closed if a predictor cannot represent requested chemistry. Unsupported means unsupported, not silently linearized.

The source audit also shows `_agreement` uses 1 minus twice the sum of confidence standard deviations, returning 1 with fewer than two predictors. That is score consistency, not pose/contact agreement; a missing evaluator must never be perfect agreement. Target-aligned interface RMSD, epitope overlap/contact-map Jaccard, backbone similarity, directional interface PAE/ipSAE and sample mode occupancy are better named structural evidence. Unrelated poses can share identical confidence values.

Sequence heuristics currently supply 35% of composite weights (0.15 solubility, 0.10 aggregation, 0.10 synthesis). Treat them as explicit cheap prioritization flags; hydrophobicity/charge/cysteine windows do not measure those properties. Improvement decomposition must report structural proxy contribution separately. Interface/fold confidence thresholds near 0.20 are operational cutoffs, not experimentally calibrated peptide-binding gates. Calibration row counts cannot certify calibration: require independently labeled, distinct molecule fingerprints, trusted assay/structure sources and target/chemistry stratification.

## What a valid evaluation campaign should measure

### Correlation and confidence

**C:** Models trained on overlapping PDB/AFDB structures, using AF-family losses/architectures or selected on one another's confidence can make correlated errors. Agreement increases confidence in a pose hypothesis, not independence of evidence. Hold out at least one evaluator from generator optimization, report results by evaluator rather than conceal disagreements in a mean, and retain all samples. Chai worsening while the composite improves is a meaningful tradeoff. Fixed target templates can reduce confounding but should be tested against free refolding; forced contacts/templates can manufacture the desired answer.

pLDDT describes local structure confidence, pTM global fold confidence, ipTM/interface PAE model confidence in interchain placement. None is Kd, IC50, off-target probability or functional inhibition. For short peptides, whole-complex averages are dominated by target residues; report binder and interface values separately. Length normalization and small-interface effects make protein/miniprotein thresholds nonportable. No scalar confidence consensus substitutes for identity/topology, pose or assay checks.

### Controls and seed strategy

**C:** define experimentally supported positive controls using the same target construct and chemistry where possible, experimentally established nonbinders, composition-matched sequence shuffles, topology-matched decoys and off-target complexes. A scramble is an unlabeled decoy unless experimentally tested. A failed static control signals that the validation contract or calibration needs repair; do not erase it or allow counted rows to rehabilitate it.

For a future authorized pilot, use a small prespecified set of molecule identities from both generators plus controls, fixed comparable resource budgets, generation seeds and distinct prediction seeds. Cache target MSAs/templates once with hashes. Report per-candidate distributions, median/lower-quantile confidence, pose clusters and seed reproducibility rather than best seed only. Identical seeds across different algorithms are reproducibility metadata, not equivalent random draws. Generation replicates and refold samples answer different questions. Aggregate by candidate, not by correlated samples; retain failures/timeouts and count total attempted candidates. Choose thresholds using controls, then freeze them for held-out candidates. A six-pair generator comparison is exploratory; avoid significance claims without independent candidate-level replication.

### PD-L1 target preparation and specificity

**B:** PD-L1 has N-glycosylation sites N35/N192/N200/N219 ([original primary study](https://www.nature.com/articles/ncomms12632)). Glycoforms differ by expression system and can affect interactions; [primary glycosylation/antibody study](https://pmc.ncbi.nlm.nih.gov/articles/PMC8158060/) demonstrates construct/glycosylation-dependent binding. Numbering is full-sequence numbering, not automatically crop/mmCIF index.

**C:** register biological assembly, extracellular construct, residue index map, missing residues, disulfides, target state and glycan provenance. Preserve both Ig domains when evaluating membrane-facing accessibility even if generation uses an IgV crop. A naked-domain pose near a glycan or membrane-facing surface can be inaccessible on cells. Evaluate relevant glycoform/steric states; do not invent a single definitive glycan. Document whether the experimental reagent is glycosylated and whether signal peptide/tag/membrane domains are present. Check clashes with full ectodomain/glycan context and distinguish PD-1-site competition from arbitrary PD-L1 binding.

Specificity needs matched off-targets, homologous surface comparisons and practical nuisance tests. Candidate priorities include PD-L2 or relevant B7-family comparators, plus unrelated proteins/proteinaceous assay components and serum-protein interactions; the choice should follow intended mechanism and experimental setting. Unforced pose/refolding scores on several off-targets are cheap triage, not proof of selectivity. Matched target/interface mutants and competition experiments can test the proposed epitope. A high-scoring on-target complex alone does not show specificity.

### Physical and developability gates

**C:** first check chemical identity, ring closure/disulfide geometry, chirality, bond lengths/angles, severe steric clashes and missing atoms. Then assess target-aligned epitope accessibility, buried interface area normalized for modality, unsatisfied polar atoms, hydrophobic exposure and predicted structural reproducibility. Apply relaxing/packing cautiously: evaluate starting and relaxed poses, retain topology and quantify movement. Relaxation repairing a clash does not prove binding.

For miniproteins, foldedness, core packing, exposed hydrophobic patches, expression and aggregation risks are relevant. For 12–16mers, synthesis/cyclization yield, chemical stability, proteolysis, solubility, aggregation, nonspecific membrane activity and conformational ensemble are more useful than a forced protein-core score. Short-peptide solubility and serum half-life cannot be inferred from a protein-trained soluble inverse-folding prior. D-residues, N-methylation or caps change graph and assay behavior; do not encode as ordinary L-amino-acid FASTA.

Use CPU geometry/graph checks and interpretable sequence flags immediately. Optional structural aggregation tools such as Aggrescan3D and stability tools require modality applicability and exact dependency/license review; antibody developability tools are not default peptide tools. OpenMM ([official docs](https://docs.openmm.org/latest/userguide/)) or GROMACS ([official docs](https://manual.gromacs.org/current/)) can support explicit-solvent MD under an appropriate force field, but brief stability is not affinity. MM/GBSA is at most a noisy relative triage hypothesis; free-energy methods need sampling, matched chemistry and uncertainty. Do not spend the 600-second generation/prediction budget on superficial MD and call it physical validation. Experimental identity/purity (including cyclization), binding assay with nuisance controls, orthogonal confirmation and functional PD-1/PD-L1 competition are the evidence transition.

## Concrete workflow alternatives (proposals, no execution authorized)

| Path | Generation and sequence | Evaluation | Fit and decision |
|---|---|---|---|
| A: repair current short-peptide path | Frozen installed BoltzGen and PXDesign outputs retained; topology recorded | Native cyclic/bond-aware Boltz2 plus verified Chai adapter; geometry and pose comparisons | Lowest migration burden. Repair missing contracts and controls before any new model or run. Historical scores stay historical |
| B: specialized macrocycle comparator | RFpeptides cyclic RFdiffusion + ProteinMPNN; AfCycDesign exact ring offset | Topology-aware independent cofolding; source-backbone vs refold pose; full-target/glycan sterics | Better modality match for 12–16mers; new dependencies/weights/licensing and seed pilot needed |
| C: miniprotein campaign | BoltzGen or PXDesign-d; SolubleMPNN, LigandMPNN if atomic context matters | Boltz2 and Chai1, plus ESMFold2-Fast/full or RF3/Protenix-v1 held-out evaluator | More direct published binder evidence. Longer sequences cost more, but folding/developability metrics are more applicable |
| D: expanded current BoltzGen | Frozen new upstream commit with SolubleMPNN/ESMFold2 ranking | Independent Chai/Boltz structure checks and topology contract | Current main is scientifically different; test separately, CUDA/driver/disk/VRAM preflight, never reuse incomparable old score cache |

A future 4090 pilot should first establish peak VRAM, cold-start and warm latency, exact crop/length/atom count, seeds/samples, numerical backend and failure modes for one topology-valid control. Runtime claims from A100/L20/H200 cannot be converted into a 4090 guarantee. Persistent model workers and target-cache reuse can save loading/search overhead, but their scientific inputs and artifacts must be hashed. Allocate the 600-second cap explicitly to generator and evaluators; if it cannot afford multiple valid refolds and controls, reduce generator diversity or move controls to a separate approved calibration campaign instead of quietly reducing validation. No amount of scheduler efficiency fixes an invalid chemical representation.

## Recommended reconstruction order

1. Create the molecular entity/topology schema, target manifest and adapter capability matrix; reject unsupported chemistry before prediction.
2. Preserve full per-sample structures and evidence provenance; distinguish score consistency from structural agreement and missing data.
3. Replace implicit composite claims with a vector of structural, chemistry, specificity and heuristic observations. Keep explainable ranking for exploration, with contribution breakdown.
4. Establish independent control identity and assay provenance; calibration must be target/modality-specific and leave held-out molecules for evaluation.
5. Reproduce current frozen evaluator behavior on controls under a newly authorized budget before comparing new versions.
6. Add ESMFold2 or specialized RFpeptides as explicit alternative campaigns; do not silently upgrade present BoltzGen or Protenix.
7. Select a chemically diverse, evidence-qualified experimental panel. Binding and developability claims begin with relevant experiments, not proxy improvement.

## Unresolved points to carry into planning

- Exact installed BoltzGen `a3149cf` defaults, runtime and checkpoint fingerprint were not inspected during this research; historical execution snapshots establish the accepted versions; current installed state needs a separate read-only inventory.
- Protenix v2's version-specific restricted statement conflicts with its generic Apache2 paragraph. Treat v2 as excluded until exact weight terms are resolved.
- ESMC-6B model card exposes mixed license metadata despite current repo MIT statements; archive the exact artifact license files/notices.
- Foundry and historical RFdiffusion have permissive code licenses, but this report does not certify every separately hosted checkpoint or HBPLUS/PyRosetta dependency.
- Native full/Fast ESMFold2 topology support for every requested ring/disulfide representation and the 4090 peak VRAM/latency remain unverified. All-atom output is not sufficient proof.
- No new 2026 model's published success rate is a valid forecast for Autofold's one-candidate-per-trial short-PD-L1 campaign.

## Additional deployment distinctions: AlphaFold and OpenFold

**A:** [OpenFold](https://github.com/aqlaboratory/openfold) is a trainable PyTorch reproduction of AlphaFold2. Its code is Apache2; official copyright notice distinguishes DeepMind's AF2 pretrained parameters as CC BY4.0 (replacing older noncommercial terms). Exact own-OpenFold checkpoints should retain their artifact notices. AF2/AF2-Multimer outputs are structures/confidence, not affinity. Standard deployment uses MSA/template features; precomputed features allow offline prediction. ColabDesign/AF2 gradient design is a distinct workload and specialized cyclic offsets are needed for AfCycDesign. No universal 4090 runtime is established.

**A:** [OpenFold3](https://github.com/aqlaboratory/openfold-3) is genuinely available, not merely announced. The current README says releases >=0.5.0 default to **OpenBind-0**, trained with a June2025 cutoff, while **OpenFold3-preview2** requires an older compatible release. It supports noncanonical protein/nucleic-acid chains and ligands, MSA pipelines, monomer templates and memory-constrained settings. Project code is Apache2 and README explicitly permits academic/commercial use; exact OpenBind-0 checkpoint terms/filename were not separately inspected (**U**). Therefore register it as a credible additional complex evaluator to investigate, not an already-certified deployed model. Pin release-to-weight compatibility; “OpenFold3” alone is ambiguous. Local cached inference is feasible in principle; chemistry/bond coverage, single-sequence performance and 4090 profile need benchmarking.

**A:** [AlphaFold3 code](https://github.com/google-deepmind/alphafold3) is Apache2, but local weights have [separate model-parameter terms](https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_TERMS_OF_USE.md) limiting use to noncommercial activities by/on behalf of eligible noncommercial organizations, restricting redistribution and output use. Current README provides direct Google downloads and a separate commercial Google Cloud route. Thus “publicly downloadable” is not “commercially permissive.” AF3 can be a research comparator only where those terms apply; do not import its outputs into commercial evidence/training pipelines by assuming code-license coverage. MSA/template data preparation and GPU inference are separate phases; cached features permit local inference without new search. All-atom structures do not establish peptide affinity, and available ligand/modification syntax must be faithfully used.

## Practical analysis tools, distinct from ML prediction

**A/C:** OpenMM current [official user guide](https://docs.openmm.org/latest/userguide/) is 8.6; GROMACS current [official manual](https://manual.gromacs.org/current/) is 2026.4. These are MD engines, not pretrained affinity oracles. Offline dynamics after complete system/force-field preparation is possible. Force-field identity, noncanonical/glycan parameters, protonation, water/ions, ring/disulfide bonds and equilibration protocol must be recorded. Their speed depends on atom count and settings; no short GPU allocation establishes converged binding free energy.

Rosetta/PyRosetta can relax/pack, report interface energy, buried unsatisfied polar atoms and shape/packing metrics, and support specialized cyclic peptide sampling. Their separate licensing must be resolved ([official download/licensing entry](https://rosettacommons.org/software/download/)); Foundry BSD code does not grant a blanket Rosetta commercial license. Exact Rosetta build/energy function and terminal/cyclic residue patches matter. A score in Rosetta energy units is not Kd.

Geometry libraries and CPU analysis (Biotite/Gemmi or a chemistry toolkit) can check residue mapping, chemical graph, clash distances, backbone geometry and target-aligned contact maps. Solvent-accessible surface calculations can quantify buried surface area. Chirality and covalent closure must be checked against intended chemistry, not simply guessed from PDB proximity. DockQ evaluates against a known experimental reference; without one, interface RMSD/contact overlap between predictions is consistency, not accuracy. Use explicit unknown/unsupported values for metrics not meaningful for a modality.

The most cost-effective reconstruction is these chemical/geometry/provenance checks plus properly labeled confidence distributions. Physics and extra neural models come after that contract, with independent validation and newly authorized compute.

## Sample cardinality and historical budget clarification

The source audit also shows only `prediction.structures[0]` is recorded, even though frozen Chai configuration requests five diffusion samples. Record actual returned cardinality and every returned sample; do not infer five archived structures from a configuration setting. Freeze representative-sample selection, distinguish generation seed from prediction seed, and never treat sibling diffusion samples as independent candidate identities. Historical panel allocated 120 seconds for Boltz and 180 seconds for Chai, leaving at most 300 seconds for generation under 600 total; expanded models cannot inherit that budget assumption. Present BoltzGen’s 33 GB is **disk download/runtime storage**, not a verified VRAM requirement. ESMFold2-Fast checkpoint existence is supported by its actual official HuggingFace model card, while Fast/full relative hardware fitness remains unbenchmarked here.
