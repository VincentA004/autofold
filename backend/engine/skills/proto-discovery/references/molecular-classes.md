# Molecular classes and design decisions

Read the relevant section, then check the [implemented handoff](molecular-contract.md).
Class describes design assumptions; explicit chains and chemistry identify the molecule.
These categories overlap: a folded binder can contain disulfides or be cyclized.
Declare the format, target construct/site and permitted changes in the campaign brief.
Model names and optimizer choices follow the hypothesis, not the class label alone.

## Small-molecule ligands

The design object is a chemical graph, not a protein sequence. Use the
[small-molecule guide](small-molecules.md) for identity, analog proposals, search and
assessment. Protein design generators and residue-level interface thresholds do not
transfer automatically. Preserve target construct/site and required cofactors.

## Linear peptides

Preserve terminal chemistry, required residues and partner identity. A peptide may
fold upon binding; low standalone structure confidence alone is not a rejection rule.
Choose sequence edits for a credible binding motif/pose, or compatible conditioned
generation when a different conformation or starting family is needed.

Assess the bound region and target-relative pose, flexibility and applicable interface
evidence. Whole-complex averages can hide errors in a short partner. Use a known motif
or measured analog only within its construct and conditions; neither a favorable pose
nor sequence similarity measures affinity. Advance on evidence relevant to the
campaign, keeping unmeasured binding and developability explicit.

## Cyclic or otherwise constrained peptides

Declare the actual closure and bond endpoints: head-to-tail closure, disulfides and
other crosslinks are different chemistry. Sequence letters alone do not specify it.
Preserve required bond-forming residues and modifications through proposals, prediction
and export; a linear fallback tests a different molecule.

Use only a generation/redesign path that can preserve the declared chemistry. Check
connectivity, local bond geometry and stereochemistry as well as fold/interface
recovery; geometric proximity alone does not encode a bond. An open-chain comparison
can test prediction sensitivity, but does not by itself establish cyclization improves
binding or stability. Keep intended chemistry alongside coordinates even when the
coordinate exporter omits bond records. Current support is limited; see the contract.

## Folded minibinders

A folded minibinder needs a credible standalone fold and target interface. Without
a credible starting family, sample distinct target-conditioned backbones/poses before
spending on local mutation. Different draws/sequences need not be structural diversity;
state the comparison without forcing unlike lengths into positional RMSD.

Test recovery of each proposed fold/interface rather than requiring new backbones
to reproduce an old parent's pose. Preserve representatives across families and make
early cross-model checks before expanding a branch. If none has credible recovery,
explore different geometry within budget or report the failed hypotheses. A published
binder is a control, not a mandatory geometry or automatic winner.

Assess standalone versus complex fold recovery separately from target-aligned pose
and contact-pair PAE. Consider exposed hydrophobic surfaces, aggregation and sequence
liabilities when consequential. Refine supported families using their own parents and
unchanged comparison definitions. See [promotion guidance](science.md#promotion-and-claims).

## Antibodies and VHHs

Declare the actual format: VHH, paired variable domains, Fab or another construct.
Preserve required chain pairing, framework/disulfides and fixed regions. Identify
mutable CDR/framework positions using an explicit numbering scheme and sequence map;
antibody numbering, sequence indices and coordinate residue IDs are not interchangeable.

Use format-compatible regional sequence design or conditioned generation. The shared
multi-chain prediction input does not establish antibody-specific generator readiness.
Evaluate binding-region geometry and interface evidence, domain/pairing integrity and
relevant surface/sequence liabilities. Global framework confidence can conceal a poor
binding loop. Avoid importing minibinder thresholds unchanged or equating antigen
binding with functional activity. No dedicated antibody workflow has been validated here.

For every class, target accessibility, omitted residues/glycans/cofactors and relevant
competing partners may change interpretation. Assess specificity when it is part of
the claim; a positive target prediction alone cannot establish it. Select investigations
from those uncertainties rather than applying one universal metric bundle.

Sources for folded-protein workflows: [BindCraft](https://www.nature.com/articles/s41586-025-09429-6),
[BoltzGen protocols](https://github.com/HannesStark/boltzgen#protocols).
