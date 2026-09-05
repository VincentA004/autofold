# Scientist Kernel v2

Autofold's experiment-level control loop follows four principles adapted from
pi-core: one long-lived agent lane, a small tool surface, append-only trusted
entries, and one total durable state register. Autofold keeps its own scientific
contract and execution plane; it does not embed or fork pi-core.

## Problem

A completed trial was previously represented simultaneously as a run,
evaluation, knowledge concept, knowledge cycle, search observation, job
checkpoint, `EVENTS.md` block, notebook packet, and supervisor observation.
Those views were individually useful, but no single experiment-local feed was
the obvious input to the next scientist turn. Derived prose could also disagree
with typed calibration state.

The scientist kernel makes one distinction:

- immutable research records and `events.jsonl` are trusted facts;
- OKF, Markdown, notebooks, summaries, and search maps are rebuildable views.

## Scientist lane

One frozen experiment owns one persistent scientist session and one mutable
`trial.py`.

```text
read state + new trusted events
edit trial.py
validate trial.py
evaluate trial.py through the frozen boundary
append one trusted trajectory event
derive compact knowledge
continue, stop, or request a new contract
```

The scientist has three empirical tools:

- `autofold_validate_trial`
- `autofold_evaluate_trial`
- `autofold_stop_discovery`

File read/edit tools remain ordinary agent capabilities. There is no required
search-move enum, harness-selected portfolio, or required specialist team in
the empirical loop.

One model turn may perform several empirical evaluations. After every settled
run, the trusted closeout is completed before the evaluator tool returns to the
scientist: the run is scored or failed, the knowledge cycle is committed, the
typed event is appended, and `scientist.json` is checkpointed. The same
scientist can therefore read the new event tail, revise `trial.py`, and launch
the next delta without returning to a one-shot campaign supervisor. The frozen
contract hash is reasserted and live experiment context is reloaded before each
later evaluation in the turn.

## Durable state

`scientist.json` is a total state register. Every atomic overwrite contains the
experiment, contract hash, session, iteration, mutable program path, empirical
memory revision, and one complete phase:

- `authoring`
- `evaluation_pending`
- `result_available`
- `stopped`

Recovery switches on this state. It does not infer the scientist's position
from missing files. Existing durable job checkpoints remain the effect boundary
for the remote GPU run: intent and run identity are persisted before uncertain
compute, then the settled result is recorded.

## Compounding empirical memory

`.autofold/autoresearch/<experiment>/events.jsonl` is append-only and contains
one idempotent event per persisted run. Each event binds:

- experiment contract and trial lineage;
- program and workflow fingerprints;
- hypothesis and trial intent;
- generator portfolio, allocations, candidates, models, and seeds;
- score, prior frontier, decision, and diagnostics;
- failure evidence;
- knowledge-cycle and search-observation provenance.

The scientist receives a deterministic projection containing the score
frontier, consecutive non-improvement, generator outcomes, repeated failure
signatures, and declared-hypothesis outcomes. This projection compounds without
replaying all raw artifacts into the model context.

`EVENTS.md` is regenerated from the JSONL log for humans. The campaign OKF adds
literature, claims, relationships, and cross-experiment concepts, but it cannot
rewrite an empirical event.

## Trust boundary

The agent owns scientific decisions in `trial.py`. The harness only enforces:

- frozen target, evaluator, seeds, scoring lane, promotion rule, and budget;
- registered model and generator implementations;
- valid Proto construction and bounded execution;
- immutable artifacts and complete provenance;
- non-promotable controls and calibration trials;
- new experiment contracts for changed scoring behavior.

A fresh experiment has no previous immutable run bundle. Construction
preflight therefore uses a content-addressed fixture derived only from the
frozen target and contract. This fixture is not a synthetic run, candidate, or
empirical event; it only lets Proto construction be checked before the first
real trajectory.

## Direct composite portfolios

`trial.py` exports one `build_trial(ctx) -> ProtoTrial` function. `ProtoTrial`
contains the hypothesis, trial intent, executable generation program, and
optional agent-authored diagnostic stages. The generation program may be a
`ProtoPortfolioProgram` containing independently
executable `ProtoPortfolioLane` objects. Every lane owns its own native Proto
Program, constructs, segments, generator, and optimizer plus explicit candidate
and GPU-second bounds. Construction preflight derives the generation plan from
that executable object graph. The scientist does not repeat generator identity
or allocations in a side manifest.

The trusted worker re-derives the same plan after launch, applies the frozen
bounds, runs lanes in isolation, and carries lane identity into every candidate
artifact before outputs are flattened. Shared Construct objects are rejected at
construction. The compiler mirrors the returned `DiagnosticStage` plan into the
immutable execution contract, verifies it again in the worker, and appends the
experiment's frozen scoring pipeline. Candidate extraction is automatic from
the executable Proto object graph. Legacy manifests and custom extraction
functions are accepted only for old trials.

## Scientist workspace

The hot-loop workspace is intentionally small: `README.md`, `contract.json`,
`FRONTIER.md`, `trial.py`, `LAB.md`, `events.jsonl`, `skills.json`, and compact
per-capability files under `api/`. Raw run artifacts and the campaign OKF remain
available by path and search on demand rather than being copied into every
prompt. After evaluation, `latest-result.json` gives the next edit direct score
delta, per-generator evidence, diagnostics, and provenance.

## Migration cut

Keep the research database, durable jobs, Proto compiler, execution worker,
model registry, locked evaluator, remote compute, and OKF publisher.

Remove the active experiment from search-policy tournaments and one-move
campaign supervision. Move generic skill refinement and literature synthesis
off the empirical critical path. Campaign orchestration remains only for
creating/approving contracts, allocating campaign budgets, and comparing
separate experiments.
