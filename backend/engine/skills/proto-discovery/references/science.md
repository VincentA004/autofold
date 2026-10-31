# Choose evidence that can change the decision

## Endpoint, evidence and fitness

Separate the biological endpoint, what can be observed now, and the fitness used
inside search. Optimize an applicable endpoint measurement when available. Otherwise
nominate bounded hypotheses and filter for their stated computational properties;
unmeasured biology can remain explicit. Calibration is useful when it changes the
next action, not as a prerequisite for every design.

For a decisive measurement, identify its property, units/direction, applicability,
assumptions connecting it to the goal, and a way it could improve while the goal fails.
Interface confidence, sequence likelihood, contacts and docking/energy estimates do
not automatically measure affinity, specificity or function. Global averages can hide
a small partner's failure. Correlated confidence terms are not independent evidence.
Even Proto's `boltz2-binding-strength` aggregates confidence penalties; inspect the
quantity behind a persuasive model/constraint name.

Separate admissibility, preferences and unresolved properties. Multiple objectives
should preserve meaningful tradeoffs, not every available metric. Use the
[molecular guidance](molecular-classes.md), [representation contract](molecular-contract.md)
and [scoring semantics](scoring.md); there is no universal binder score or cutoff.

## Choose an investigation when fitness is questionable

Name plausible explanations, including one challenging the favored interpretation.
Choose a bounded test whose outcomes lead to different actions. Reuse adequate
artifacts before new predictions; another model/metric needs a decision it can change.

For residue-level hypotheses, inspect relevant [backbone geometry](https://pubmed.ncbi.nlm.nih.gov/12557186/),
packing, polar partners and unbound exposure before choosing substitutions. Gly's
absent side chain does not establish a cavity; adding hydrophobic atoms can improve
burial while introducing strain or solubility liabilities.

| Observation | Distinguish | Useful next test |
| --- | --- | --- |
| Score improves, outputs look implausible | Improvement, proxy exploitation, representation failure | Inspect relevant geometry/chemistry/context and counterexamples |
| Predictors disagree | Input differences, alternative states, applicability | Verify comparable inputs and examine actual predicted states |
| Known binder folds but misses its bound pose | Docking uncertainty, missing context, protocol mismatch | Check chain maps/conditioning and a bounded parent-only protocol |
| Candidate wins inconsistently | Sampling variation, condition dependence | Paired repeats with controls and the full outcome distribution |
| Negative control loses badly | Relevant discrimination, easy confound | Match nuisance properties and use a more discriminating comparison |
| Search stalls | Poor proposals, lost diversity, insensitive fitness, local optimum | Inspect pool diversity and measurement resolution before changing strategy |

Controls should match nuisance properties relevant to the claim. A shuffled or
unfoldable sequence is not an experimentally verified nonbinder. Retain failure
denominators and confounds. Identical seeds probe reproducibility/cache behavior;
changed seeds probe sampling variation, not systematic model error alone. A supplied
complex template or binding-contact restraint makes pose recovery conditioned
self-consistency, not independent docking evidence.

Ask whether available observations distinguish the proposed outcomes. Assumed
statistical models and conditional sensitivity analyses do not recover missing
experimental information. An unknown property need not block a scoped supported
choice; no diagnostic is mandatory for every score or trial.

## Promotion and claims

Use [shared measurements](structure-measurements.md) with explicit correspondence.
Distinguish internal fold recovery, target-aligned pose and contact-pair PAE. Compare
a new family's prediction with its own proposed fold/interface; displacement from an
unrelated parent is not by itself failure. A different credible state is a hypothesis
requiring interpretation, not an automatic winner or loser.

Screen economically, then challenge a few diverse survivors and their parents with
another applicable predictor before expanding a claimed improvement. Compare paired
changes within each procedure using unchanged definitions/settings; preserve each
model's values rather than averaging differently calibrated confidence scores. Keep
advancement provisional when secondary evidence is unavailable. Small gains may
justify a few paired seed variations; retain useful tradeoffs/families.
A cutoff crossing is a policy decision, not mechanistic corroboration; interpret
its margin against observed variation.

Separate edits before attributing a combination's gain; test combinations in context.
Pose-conditioned geometry and cross-model agreement support computational hypotheses,
not calibrated binding probabilities. Low confidence is an observation; calling it
under-confidence needs calibration. An absent warning is not a measured property.

Separate candidate quality, repeatability and method superiority. Method comparisons
need common assessment, comparable resources and suitable repeats/controls. An
assessment used repeatedly to revise policy becomes development evidence; another
seed or related predictor is not automatically an untouched final test. Preserve
conflicting panels and changed definitions. Stop when the deliverable/budget is met
or more of the same cannot distinguish useful next actions; report justified
non-promotion as well as supported advancement.

Use the [record contract](../../scientific-research/references/notebook-contract.md)
for qualified evidence, captured analyses and corrections. Execution completion and
scientific success remain separate.
