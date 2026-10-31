# Campaign records and document links

The campaign is the portable archive unit. Pi uses ordinary read/write/edit/bash;
a future frontend projects these same files into a graph. No claim registry,
graph database, custom links or additional research controller.

## Layout and identity

```text
campaign.md                             current objective and limits
notebook/index.md                       current direction and navigation
notebook/investigations/<stable>.md      evolving evidence and interpretation
sources/<provider>/<capture>/           preserved retrieval and artifacts
programs/<working-bundle>/              editable authoring workspace
output/trials/t-<id>/
  brief.md                              quoted campaign brief at launch
  plan.md                               frozen prospective scientific reasoning
  trial.json                            captured execution specification
  program/                              exact executed source bundle
  inputs/                               exact declared runtime data
  execution.json                        process receipt and final artifact hashes
  stdout.log, stderr.log, output/        captured execution evidence
  assessment.md                         initial interpretation after inspection
  assessment.json                       create-once assessment hash and commit time
```

A campaign-relative path is the stable identity; change titles rather than rename
cited records. The assessment commit adds read-only files, Pi edit guards and hash
checks; unrestricted Bash is not sandboxed. Other captured records are preserved
by convention. Re-fetching or re-executing creates a new capture/trial. Existing
E/F/Q pages and older trials remain readable in their recorded layout; do not
migrate, repair or delete frozen records to satisfy the new layout.

## Mutable notebook

Keep a substantial investigation together, with one title and these sections:

```markdown
# Reporter response in destination B

## Evidence
Scoped reported observations or computed results, with exact file links and
passage/table/measurement locators. Distinguish source reports, model predictions,
author interpretation and synthetic fixtures.

## Interpretation
Current claim, reasoning, applicability assumptions, contrary evidence and
meaningful unresolved alternatives.

## Next decision
What to investigate or do next, why, and what outcome would change that choice.

## Changes
- YYYY-MM-DD: Consequential earlier claim, correction, reason and evidence links.
```

Evidence and Interpretation are required for a consequential conclusion. Record
meaningful corrections in Changes; ordinary wording edits need no history entry.
Keep index/findings/questions short and linked instead of duplicating the evidence.
Split pages only for size or actual reuse. A finding can depend on many sources and
trials; one trial can inform several findings. No separate finding object is needed.

Preserve quantities, context, comparator, uncertainty and knowledge status that
matter to the decision. "Not described" is not "not performed"; unavailable data
are not evidence of absence. Reported biological replicates are distinct from
independent replication. Shared-data reanalyses and fitted-model agreement do not
create independent experiments. A quotation proves attribution, not scientific truth
or the validity of your inference. Scope synthetic results to their fixture.

## Trial lifecycle and scientific records

Allocate a permanent trial address first, using the existing runner:

```sh
python3 /absolute/path/to/scripts/run_trial.py --campaign /absolute/campaign --prepare
```

Write `plan.md` directly in the returned trial directory before executing. It must
stand alone: question/hypothesis, decision-bearing evidence with short qualified
anchors and locators, chosen model/measurement/constraints/search and why they fit,
a consequential alternative, and outcomes that would change the decision. Keep
this proportional; a diagnostic can have a short plan. Notebook links under
`## Notebook navigation` point explicitly to current mutable understanding; they
cannot supply missing historical reasoning. Cite original sources/prior artifacts
in the plan itself. Do not link future outputs before they exist.

Then execute the editable source bundle using that prepared address:

```sh
python3 /absolute/path/to/scripts/run_trial.py --campaign /absolute/campaign \
  --trial output/trials/t-ID --program programs/screen \
  --input target.json=inputs/target.json --intent 'Test the hypothesis' --timeout 300 -- \
  /path/to/python program/main.py
```

The command runs in the trial root, with `program/`, `inputs/`, `output/`.
Input destinations are relative to inputs/, without an extra inputs/ prefix.
`trial.json` schema 2 records command/cwd, intent, evaluation label if supplied,
program origin, captured file hashes, known environment and timeout. `--input` is
for actual program data, including a previous output when consumed. Evidence cited
to justify a choice is not automatically a runtime input: link the preserved
campaign source or prior trial directly, without copying it into a context mirror.
A file can serve both roles. Mutable runtime inputs are copied and hashed.

The brief is a quoted verbatim launch snapshot; its original relative links are
text inside a fence, not active evidence references. Captured program documentation
is likewise original source; canonical scientific citations belong in plan.md and
assessment.md. Programs must retain relevant model identities/settings, all relevant
evaluated candidates including failures/rejections, predictions and requested matrices.
The runner inventories saved outputs and logs, not unpersisted model responses.

Before launch, the plan, brief, program, inputs and execution specification become
fixed. At local process completion, failure or interruption, retain logs, partial
outputs and the terminal execution receipt with artifact hashes. Execution completion
means process exit zero, not scientific success. A prepared trial has not executed;
a running/stale receipt needs inspection before replacement. Never resume or rerun
a used trial address. Detached remote jobs are not finalized by local process exit.

After inspecting the evidence, draft an assessment outside captured trials:
observations with important measurements and precise artifact links, interpretation,
limitations, and next decision proposed then. Distinguish planned from observed.
Author relative links for the final trial-root location, then commit the exact bytes:

```sh
python3 /absolute/path/to/scripts/run_trial.py --campaign /absolute/campaign \
  --trial output/trials/t-ID --assess programs/assessments/t-ID.md
python3 /absolute/path/to/scripts/run_trial.py --campaign /absolute/campaign --verify-assessments
```

The first command exclusively creates read-only `assessment.md` and `assessment.json`
after terminal execution; a second commit fails. Pi blocks direct writes/edits to
these paths and checks integrity after mutating tools and at handoff. The runner
also checks before preparing/executing further trials. A mismatch, incomplete commit
or legacy assessment without a receipt requires operator review; do not silently
adopt or reseal it. Run verification before handoff. No historical campaigns are
automatically migrated. These checks detect ordinary changes, not deliberate rewriting
of both evidence and its receipts by an unrestricted shell user.

Execution finished and assessment recorded are separate milestones: an absent
assessment means pending, not a conclusion supplied by the runner. Preserve the
assessment after writing; subsequent reinterpretation belongs in the current
notebook with a dated correction citing the original assessment and correcting
evidence. An incorrect historical assessment stays identifiable as such.

Consequential post-hoc calculations retain their own code, parameters, input refs
and results, normally as a small analysis trial; no repeat of expensive prediction
is required. Uncaptured exploratory numbers remain provisional. Do not attribute
later analysis to the original procedure. Working programs are not permanent proof.

There is no automatic whole-notebook snapshot or complete edit history. The frozen
plan preserves the reasoning used for execution; the assessment preserves the first
interpretation. Notebook citation is not a historical notebook version. Neither a
snapshot nor a plan proves which documents the model actually read.

## Link contract and frontend projection

Use inline `[readable label](relative-path)` links resolved from the containing file.
Use angle brackets or URL-encoded spaces when necessary. Prefer a file plus written
passage/table/row locator to guessed heading anchors. Link actual files for evidence.
HTTP(S) URLs identify originals but do not replace a saved consequential capture.
No wiki links, reference-style links, absolute local paths or custom URI schemes.
Every relied-on target must exist inside the campaign. Metadata absolute origin
paths are descriptive, not portable references. Do not silently substitute working
files for missing captured artifacts.

For example, from notebook/investigations/response.md:

```markdown
[Source](../../sources/example/source.json): abstract capture.
[Passage](../../sources/example/text.txt): lines 3–4.
[Initial assessment](../../output/trials/t-ID/assessment.md).
[Predictions](../../output/trials/t-ID/output/predictions.csv): candidate X.
```

From a trial-root plan or assessment, the campaign root is `../../../`; another
trial is `../t-OTHER/...`; that trial's own artifacts are `output/...` or `program/...`.
Construct and check links at their permanent location rather than moving a working
rationale whose relative paths change. Export the campaign to preserve cross-trial
and source references; a standalone trial folder is not a self-contained archive.

The future frontend derives notebook, source and trial nodes from canonical paths;
first headings supply notebook titles. Group artifact links under their source/trial
node while preserving exact file, locator, link label and originating section.
Notebook citations are `cites`; trial manifest inputs are `uses`; plan evidence links
are `cites`; Notebook navigation links are `related to current notebook`, never a
frozen historical page. Backlinks are derived, not separately authored. Support,
contradiction, independence and causality remain scoped prose, not facts inferred
from edge counts. Hide navigation nodes if useful; never invent evidence nodes for
missing targets. Old context snapshots retain their explicit historical view and
must not silently resolve against current files.

## Native navigation and verification

Read index → investigation → cited source/trial → exact artifact as needed. `rg`
finds candidate backlinks; read matching sections. A fresh scientist should recover
the current decision, evidence, uncertainty, prior mistake and next test without
conversation history or loading the entire campaign.

Before handoff or execution, compare consequential saved assertions against exact
source passages/artifacts. Check contradictory summaries, strengthened qualifiers,
invented uncertainty, context, comparable measurements and planned-versus-observed
confusion. Correct demonstrated problems, not every defensible inference. Research
alone requires no trial. A completed review is not a fidelity certificate.

Use the [native link check](link-verification.md) on relevant notebook pages, plan,
assessment and handoff, rooted at the campaign. Check the saved documents again
after execution/assessment. Repair mutable/pre-launch records; report missing
historical dependencies without editing frozen trials. Path checks and source
comparison answer different questions; report their outcomes separately.
