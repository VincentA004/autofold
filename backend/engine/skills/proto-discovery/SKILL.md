---
name: proto-discovery
description: Plan, author and revise biological discovery trials with Proto, choosing molecular changes, models, measurements and search from the objective and prior evidence.
---

# Proto discovery

Read campaign.md and the relevant notebook evidence, including failures. Choose the
next trial by the decision it can change; one trial may generate, screen, refine,
diagnose or compare methods. Keep campaign findings in the notebook.

## Decide before authoring

- **Question:** What uncertainty matters now? Which plausible result would change
  the next action? Research when external evidence could resolve it.
- **Design space:** What molecule, partners, chemistry and regions can change?
  Check the [molecular class](references/molecular-classes.md) and
  [implemented handoff](references/molecular-contract.md).
- **Evidence:** Separate the biological endpoint, observable measurements and search
  fitness. Use [science](references/science.md) to choose controls, challenge proxies
  and define promotion before refinement.
- **Procedure:** Choose transformation/conditioning from the [model menu](references/models.md),
  starting with its small active toolbox and using alternatives for a consequential
  uncertainty. Then choose compatible [search](references/parameters.md) and
  [selection](references/scoring.md); allocate proposals, repeats and challenges accordingly.

Record consequential choices proportionally in the trial plan: why this procedure,
what result changes the next action, and its budget/comparator. Adapt to results:
refine supported families, investigate contradictory evidence, explore another family
when justified, or stop at the deliverable/budget. Unmeasured biology can remain
explicit while bounded hypothesis-driven design proceeds.

## Execute and learn

For generation/refinement, use a native `Program` whose generators, constraints and
optimizer own proposals, evaluation and selection. Tools may implement those parts,
conditioning hooks or standalone assessment. A nominal Program around manual search
does not supply those semantics.

Inspect the selected API and construct the exact program before expensive calls.
Retain raw measurements, units and complete prediction responses/PAE before selection,
including failures and rejected candidates. Generated or inherited geometry is
conditioning, not an independent prediction of a new child.

Follow the [record contract](../scientific-research/references/notebook-contract.md)
for plans, captures, immutable assessments and notebook corrections.

Load details only for the current operation:

| Need | Reference |
| --- | --- |
| Schema, callable or bridge imports | [API](references/api.md) |
| Protein–small-molecule discovery or analog optimization | [Small molecules](references/small-molecules.md) |
| RFD4, Complexa, BoltzGen or antibody generation | [Generation](references/generative-design.md) |
| Prediction-conditioned sequence feedback | [Cycling](references/cycling.md) |
| Prediction protocols, interface scores or PRODIGY | [Evaluation](references/local-evaluation.md) |
| RMSD and PAE correspondence/arithmetic | [Measurements](references/structure-measurements.md) |
| Preflight, captures and native compatibility | [Validation](references/validation.md) |
| Wiring examples | [Examples](references/examples.md) |
| Bounded investigator/reviewer advice | [Delegation](references/delegation.md) |
