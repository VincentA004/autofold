# Domain knowledge skills v1

Autofold skills and execution adapters are different objects.

```text
domain knowledge skill                 execution plane
----------------------                 ---------------
biology and model semantics            typed Proto registry component
handoff and diagnostic reasoning       frozen input/config schemas
failure modes and hypotheses           credentials and endpoint policy
falsifying questions                   GPU/storage/time admission
attribution and version                immutable execution receipt
```

A domain skill is read-only context injected into a dynamically planned
specialist. It cannot contain installation commands, shell or container
instructions, endpoints, credential variables, model-server lifecycle, or
direct invocation code. It cannot grant tools, mutate a contract, create
evidence, report a trusted score, or promote a trial.

Execution knowledge belongs in the Proto component and worker adapter:
versioned request and output schemas, pinned model identity, seeds, resource
limits, credential handles, retry rules, artifact normalization, and receipts.
The agent may use domain knowledge to modify the Proto graph, including model
selection, ordering, routing, conditions, and parameters permitted by the
frozen contract. It never receives the authority or secrets needed to execute
those models directly.

## Selection and provenance

The research-team planner selects capabilities such as structural biology,
model diagnostics, developability, experimental design, workflow design, and
evidence reasoning. The trusted registry deterministically injects matching
knowledge capsules and records their IDs and versions beside the specialist
report. The language model does not load arbitrary skill paths by name.

The initial five capsules adapt NVIDIA BioNeMo Agent Toolkit binder-design
guidance at commit `23d4835`: workflow strategy, backbone generation, sequence
design, predictor interpretation, and developability controls. Each is a
standalone `SKILL.md` with source paths, license, attribution, capabilities,
applicable Proto tool keys, guidance, failure modes, and falsifying questions.
Operational NIM, container, setup, and invocation material is intentionally
excluded.

## Skill refinement boundary

Capability RSI may propose changes to domain knowledge from successful and
failed trajectories. Autofold copies bundled version 1 into
`.autofold/campaigns/<campaign-id>/skills/<skill-id>/versions/`; every new
candidate gets a new immutable Markdown path, content hash, parent version, and
trajectory references. Trials pin the exact skill version IDs and hashes used
by their specialist analysis.

A candidate becomes active only when same-budget replay against its parent has
no regression in locked objective utility, area under the improvement curve,
valid diverse yield, failure rate, or compute cost, and improves at least one of
those measures. Failed candidates remain auditable. Rollback reactivates a
previously accepted version without altering either Markdown file. Promotion
to the project library additionally requires a passing replay spanning at least
three campaigns. Skill refinement cannot change Proto execution code, tool
identities, credentials, budgets, or the evaluator that judges the replay.

The lifecycle is exposed through the research API and terminal commands:

```text
skill initialize CMP_ID
skills CMP_ID
skill propose CMP_ID SKILL_ID --parent SKV_ID --file SKILL.md --by ACTOR
skill evaluate CMP_ID SKV_ID --file replay.json
skill rollback CMP_ID SKV_ID
skill promote-library CMP_ID SKV_ID
```

## Autonomous candidate authoring

The campaign supervisor may now select a typed `refine_skill` move when a
visible experiment, trial, evaluation, run, knowledge, claim, or job trajectory
suggests a reusable reasoning failure. That move queues a leased
`capability_refinement` job rather than editing a skill inline.

The job freezes the active parent Markdown, exact referenced trajectories,
recent experiment histories, locked evaluations, and checkpointed specialist
analysis. It creates one child session with permission to write exactly one
candidate `SKILL.md`. The candidate must preserve attribution and the app's
frontmatter contract, advance the version, stay concise, and pass the domain
knowledge/runtime-separation validator. Trajectory, proposal, and immutable
candidate are separate restart-safe checkpoints; job-phase origin makes
proposal storage idempotent.

Successful authoring returns `awaiting_replay`. It does not activate the
candidate. This is intentional: the authoring agent cannot manufacture its own
evaluation or promotion evidence. Queue it directly with:

```text
skill refine CMP_ID SKILL_ID --session SES_ID --trajectories TRL_ID,EVL_ID
```

## Trusted shadow replay

`skill_shadow_replay` now closes the promotion boundary. It serializes one
experiment context before either arm runs, including the contract, target,
incumbent program, evidence, model diagnostics, and Proto tool catalog. Parent
and candidate receive byte-identical context plus their own exact skill
Markdown. Each authors one Proto proposal and executes it as a
`shadow_replay` trial. These trials are scored by the normal locked evaluator
but are never eligible to replace the experiment incumbent.

The replay service normalizes the locked score to utility according to the
contract direction, derives valid-diverse yield from evaluator-owned
submission/diversity diagnostics, derives failure from evaluation validity,
and holds compute cost equal to the frozen GPU budget. It does not accept
scores from the authoring agent. The existing non-regression rule then
activates or rejects the candidate. Prepared context, both proposals, run IDs,
completed iterations, and final decision are independently checkpointed.

Direct replay is available with:

```text
skill replay CMP_ID SKV_ID --experiment EXP_ID --session SES_ID --agent biology
```

Adding `--experiment EXP_ID` to `skill refine` chains the candidate-authoring
job to a shadow-replay job automatically. A campaign supervisor `refine_skill`
move always supplies the active replay experiment, so the autonomous path is:

```text
visible failed/successful trajectories
→ immutable candidate SKILL.md
→ frozen parent/candidate Proto proposals
→ non-promotable locked evaluations
→ derived replay metrics
→ activate or reject
```

Only one candidate per campaign skill may remain pending. A second refinement
is rejected until the first candidate's replay activates or rejects it, while
retries with the original idempotency key continue returning the same job.

Campaign promotion now requires three paired repetitions by default and permits
up to five. Each repetition independently authors parent and candidate Proto
programs from the same serialized context. Aggregate replay uses mean locked
utility, cumulative utility area, total valid-diverse yield, mean predictor
disagreement, empirical failure rate, and equal cumulative budget. Every arm
has its own proposal/run/result checkpoints. Cross-campaign validation remains
required before project-library promotion.
