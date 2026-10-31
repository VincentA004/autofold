# Protein–small-molecule trials

Use the existing trial and notebook contracts. Distinguish hit discovery from
improving an active series; choose the next experiment from the unresolved question.
A known ligand, complex structure and comparable measured analogs are useful starting
evidence when available, not a required target-specific workflow.

## Identity and proposals

Follow the [molecular contract](molecular-contract.md). Record candidate/parent IDs,
original and canonical isomeric SMILES, stereochemistry, formal charge, protonation/
tautomer choices and source links. Unspecified stereochemistry is uncertainty, not
a chosen isomer. Keep different chemical states explicit; canonicalization is not
pH preparation. Preserve required partners, waters/metals/cofactors or qualify their
omission. Covalent ligands need a verified bond-capable handoff.

For analog optimization, state the interaction or liability an edit tests. Use
measured structure–activity relationships, meaningful substitutions or reaction-based
enumeration; preserve required scaffold/pharmacophore features with actual checks.
Similarity does not guarantee similar activity. Retain diverse hypotheses rather
than only adding size, lipophilicity or contacts to improve a proxy. RDKit parsing,
valence checks and deduplication establish usable graphs, not synthesis feasibility.

## Compose Proto without assuming chemical search support

Represent ligands as SMILES, never protein residues. ProteinMPNN/LigandMPNN redesign
proteins; LigandMPNN does not generate small-molecule ligands. Import/capture
`scripts/ligand_proposals.py`: native generator `ligand-analogs` applies named,
single-reactant/product reaction SMARTS around `fixed_core_smarts`. Its config
controls size, charge preservation and enumeration limits; inspect the live schema.
It requires an operator-applied opt-in patch; other generators still reject ligands.
Existing stereocenters and neighbors must be explicit in the fixed core. Enumeration
captures include failures and unchanged/rejected products; no admissible edit fails
visibly. Graph-valid edits do not establish synthetic accessibility.

Use rejection sampling for independent analogs, MCMC for parent-conditioned edits,
or population/Pareto selection for justified tradeoffs. Native selection can also
screen a preseeded library without generation. Keep crossover disabled; SMILES
character splicing is not chemical recombination. Verify variable-length handoffs
for the selected optimizer. Pose-conditioned cycling and differentiable affinity
remain unverified. Do not describe protein-only searches as ligand optimization.

## Measurements and promotion

Boltz-2 has separate affinity outputs: `affinity_probability_binary` for binder/decoy
screening; `affinity_pred_value` for comparing active analogs, lower favorable, in
`log10(IC50 in µM)`. Neither is measured Kd. Upstream cautions against ligands much
larger than 56 atoms; its 128-atom parser limit is not validated scope.

Capture requests, complete responses and native coordinates. For native Boltz,
the [worker evidence writer](../examples/boltz_native_capture.py) also retains
processed molecules and the actual CCD references supplied by infrastructure.
An empty generated-molecule table need not mean a CCD ligand is absent.
The installed affinity
adapter drops structure-confidence metrics and supplies no PAE; obtain needed pose
evidence separately and identify its source. The protein-only interface helpers
cannot interpret ligand atom tokens. Check atom correspondence, stereochemistry,
strain/clashes and target-relative pose; use symmetry-aware ligand RMSD where
appropriate. Template/pocket-conditioned recovery is not independent docking.

Keep pose plausibility, predicted potency and relevant chemical-property tradeoffs
separate. RDKit logP/QED are not measured solubility, permeability or synthesizability.
Use campaign-specific constraints or Pareto preferences rather than a universal
drug-likeness cutoff or an unjustified composite. Compare parent/child under common
settings, retaining variation and failures; challenge decisive gains with applicable
controls or another method. Keep assay endpoint, construct, units and conditions
with measured analogs; do not pool IC50/Ki/Kd as interchangeable labels. Inspect
discordant analogs before expanding a branch. Stop within budget and qualify
computational nominations without claiming demonstrated biological improvement.

Read only the selected tool's [live schema](api.md). Runtime provisioning is an
infrastructure responsibility; current protein-only BioIR support and CPU chemistry
checks do not establish ligand inference readiness.

Sources: [Boltz prediction/affinity](https://github.com/jwohlwend/boltz/blob/main/docs/prediction.md),
[RDKit chemistry](https://www.rdkit.org/docs/GettingStartedInPython.html),
[logP](https://www.rdkit.org/docs/source/rdkit.Chem.Crippen.html),
[QED](https://www.rdkit.org/docs/source/rdkit.Chem.QED.html).
