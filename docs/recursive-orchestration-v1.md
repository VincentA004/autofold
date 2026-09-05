# Recursive orchestration v1

The orchestration plane separates active experiment recursion from campaign
boundaries. A sole active frozen experiment resumes its persistent
[scientist loop v1](scientist-loop-v1.md) directly. Planner, specialist, and
supervisor synthesis is reserved for selecting between experiments, requesting
contract changes, reviews, skill lifecycle operations, approvals, and stop.

```text
active experiment observation ──> persistent scientist ──> trial.py ──> trusted execution
             ^                                                        |
             └──────── locked result + deterministic OKF event ───────┘

campaign boundary ──> optional team/supervisor analysis ──> typed boundary move
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

At a campaign boundary the supervisor may emit exactly one of:

- `iterate_experiment`: run autonomous discovery on an active experiment. Each
  fresh cycle owns its intent and program strategy; explicit `single_intent`
  mode remains available for an operator-requested replay/control;
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
OKF. Active experiment recursion does not wait for this review. This preserves
the boundary between retrieved evidence and analytical opinion.

## Research-agent model policy

Autofold research agents do not inherit the interactive OpenScience session's
model. Every Autofold-originated inference is pinned to the dated, reproducible
OpenRouter model `z-ai/glm-5.3-flash`, including delegated agents,
titles, summaries, and compaction. Stale environment overrides, configured
agent models, and cross-model provider fallbacks cannot replace it.

Autofold agents may take as many productive tool steps as the task requires;
reasoning depth is not constrained by a fixed step count. Durable research jobs
default to one attempt, so a failed job requires an explicit retry instead of
silently replaying billable child calls. A cumulative job-cost budget, rather
than a step or per-response token ceiling, is the intended spend control.

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
4. **Implemented:** durable campaign-loop job that grants a sole active
   experiment its remaining campaign trial budget (up to 100 trajectories) in
   one persistent-scientist loop instead of bouncing through one move per
   trial. It re-observes at plane boundaries and automatically prioritizes due
   literature, repeated-evidence skill refinement, pending shadow replay,
   contract approval, and stop. A campaign-wide GPU-time ledger is still next.
5. **Implemented:** fresh per-iteration evidence reload, scientist-authored
   trial intent and generator allocation, semantic program/workflow provenance,
   and durable contract locking.
6. **Implemented:** durable same-step author repair, campaign-visible attempt
   deltas, acquisition-landscape snapshots, validator-completeness summaries,
   and automatic replay-gated skill-feedback signals.
7. Trajectory dataset plus fixed-baseline replay evaluator.
8. **Implemented with a conservative evidence gate:** an autonomous discovery
   job schedules at most one refinement per affected skill after the same
   feedback recurs in at least two independent runs. Pending candidates/jobs
   suppress duplicates, and every candidate automatically enters three-repeat
   parent-versus-candidate shadow replay before promotion. A campaign-wide
   compute ledger is still required to express one global spend ceiling across
   discovery and these replay jobs.
9. **Implemented:** persistent-scientist inner loop with one mutable `trial.py`,
   dynamic per-cycle intent, fresh skill/evidence reload, and no required
   tournament or harness acquisition policy.

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

Every boundary-level campaign step gets a fresh child session with only one writable
`move.json`. It uses Autofold's research-agent model policy, receives the
canonical campaign observation, selects the experiment specialist (`biology`,
`ml`, or `task`) for executable iteration, and cannot directly call research
mutation or compute tools. The policy compiler remains the sole bridge from
proposal to execution.
