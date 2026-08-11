# Recursive orchestration v1

The orchestration plane is Autofold's central product, not a collection of
fixed biology agents. One campaign supervisor repeatedly observes the durable
research state, composes the smallest useful specialist context, proposes one
typed move, and submits that move to trusted policy and execution layers.

```text
campaign objective + budget
        |
        v
state observation ──> team planner ──> parallel specialists ──> synthesis ──> typed move
        ^                                         |
        |                                         v
OKF graph <── verified outcome <── durable job <── policy compiler
```

## Separation of authority

- The **agent** chooses hypotheses, skills, model routes, Proto topology, and
  what uncertainty to reduce next.
- The **policy compiler** validates identifiers, freshness, budgets, duplicate
  work, experiment locks, and approval boundaries.
- The **execution plane** runs immutable programs and models.
- The **locked evaluator** alone decides experiment-level promotion.
- The **knowledge plane** records outcomes, failures, literature, conflicts,
  and decision provenance for the next observation.

An agent may propose a move but cannot directly mutate a contract, score, job,
or stable claim.

## Initial move language

The first supervisor should emit exactly one of:

- `iterate_experiment`: run bounded autoresearch on an active experiment, with
  an optional typed search policy and generator portfolio;
- `refresh_knowledge`: align new outcomes with current literature;
- `request_experiment`: propose a new frozen contract for approval;
- `request_review`: escalate contested or high-impact claims;
- `stop`: terminate with an explicit reason and unresolved questions.

This language is intentionally small. Proto remains the dynamic language inside
an experiment; the move language controls recursion between experiments.

## Context injection

Specialists are created dynamically from a capability profile rather than a
fixed agent roster. The supervisor selects only the relevant skills, tool
permissions, model class, token/compute budget, state slice, and required output
schema. Every child receives exact provenance references and a single writable
proposal artifact. The resulting trajectory records why that context was
selected and whether the move improved the locked objective or information
state.

The implemented engine currently selects one to four `biology`, `ml`, or `task`
children and assigns explicit capabilities: structural biology, model
diagnostics, developability, experimental design, workflow design, or evidence
reasoning. Each child receives a focused slice of campaign state and writes one
bounded report. Reports may reference only exact campaign provenance IDs and
remain analysis—not verified evidence. A separate synthesis child sees the
reports and authors the move.

Capability labels are resolved through a trusted domain-knowledge registry.
Knowledge capsules contain biological/model semantics, handoffs, diagnostics,
failure modes, and falsifying questions only. Runtime instructions are excluded
because all model invocation, ordering, resources, credentials, and receipts
belong to Proto and the execution plane. See
[domain-knowledge-skills-v1.md](domain-knowledge-skills-v1.md).

External literature retrieval remains an explicit `refresh_knowledge` move. It
uses the evidence-verifying literature child and commits sources and claims to
OKF. The next supervisor step then plans specialists over the updated knowledge
graph. This preserves the boundary between retrieved evidence and analytical
opinion.

## Research-agent model policy

Autofold research agents do not inherit the interactive OpenScience session's
model. The default route is the dated, reproducible OpenRouter model
`deepseek/deepseek-v4-flash-0731`. An operator may deliberately replace it with
`AUTOFOLD_RESEARCH_MODEL=provider:model`, but changing the donor UI model has no
effect on campaign planners, specialists, literature review, Proto authors, or
the campaign supervisor.

Autofold agents may take as many productive tool steps as the task requires;
reasoning depth is not constrained by a fixed step count. Durable research jobs
default to one attempt, so a failed job requires an explicit retry instead of
silently replaying billable child calls. Each Autofold model response also has
an 8,000-token output ceiling independent of the donor runtime's interactive
output setting. A cumulative job-cost budget, rather than a step ceiling, is the
intended spend control.

## Recursive levels

1. **Candidate search:** Proto optimizes molecules within one trial.
2. **Experiment RSI:** autoresearch changes the Proto program across locked
   evaluations.
3. **Campaign RSI:** the supervisor chooses the next experiment or knowledge
   action under the campaign budget.
4. **Capability RSI:** evaluated trajectories propose changes to reusable
   skills and routing policies; a held-out replay benchmark gates promotion.

The first three may run online. Capability changes are promoted offline and
cannot rewrite the evaluator that judged them.

## Baseline gate

The recursive system must beat reproducible baselines under the same target,
seeds, candidates, GPU hours, and wall time: fixed pipeline, greedy incumbent,
random valid route, and literature-naive autoresearch. Report best locked score,
area under improvement curve, valid/diverse yield, predictor disagreement,
failure rate, and compute cost. A more elaborate agent is not an improvement
unless it wins this gate across held-out campaign replays.

## Implementation sequence

1. **Implemented:** typed campaign observation and move schemas.
2. **Implemented:** deterministic policy compiler, dry-run explanations, and
   one-move durable execution.
3. **Implemented:** dynamic supervisor child that writes one move artifact.
4. **Implemented:** durable campaign-loop job that executes one move, observes
   its result, and repeats within an explicit step budget. Compute is still
   bounded by each frozen experiment contract and move iteration count; a
   campaign-wide compute ledger is next.
5. **Implemented:** fresh per-iteration evidence reload, typed search moves,
   explicit generator allocations, semantic program/workflow fingerprints, and
   plateau/equivalence stopping under the durable contract lock.
6. Trajectory dataset plus fixed-baseline replay evaluator.
7. Skill/routing refinement proposals gated by held-out replay.

The current control boundary is usable from the terminal:

```text
bun run research:cli -- orchestration observe CMP_ID
bun run research:cli -- move compile CMP_ID --file move.json
bun run research:cli -- move execute CMP_ID --file move.json --session SES_ID
bun run research:cli -- campaign loop CMP_ID --session SES_ID --steps 3
```

The move executor can enqueue bounded experiment iteration or knowledge refresh.
New experiment contracts remain approval-gated; review and stop moves are
authorized records but do not yet have dedicated execution adapters.

Every campaign step gets a fresh child session with only one writable
`move.json`. It uses Autofold's research-agent model policy, receives the
canonical campaign observation, selects the experiment specialist (`biology`,
`ml`, or `task`) for executable iteration, and cannot directly call research
mutation or compute tools. The policy compiler remains the sole bridge from
proposal to execution.
