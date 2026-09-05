# Knowledge Plane v1

Autofold's knowledge plane is a campaign-scoped, recursively refreshed scientific graph. The transactional research store is authoritative. The OKF bundle under `.autofold/campaigns/<campaign-id>/knowledge` is its portable, readable projection.

## Graph

```text
Campaign
├── Experiment contract (frozen objective, target, budget, evaluator)
│   └── Trial configuration (hypothesis, program path and content hash)
│       └── Run + locked evaluation
│           ├── Research outcome or failure
│           ├── Typed hypothesis outcome (supported/refuted/unresolved)
│           └── Search observation + generator/predictor diagnostics
├── Literature source
│   └── Literature claim
│       └── Evidence alignment ──> exact research outcome
└── Knowledge cycle
    ├── consumes: new outcomes + prior claims + prior sources
    ├── produces: sources + claims + typed alignments + open questions
    └── schedules: next review watermark
```

The layers remain distinct:

- a locked evaluator verifies a computational result;
- a literature claim is proposed from frozen source excerpts;
- an alignment interprets whether a claim supports, refutes, contextualizes, or leaves an experiment outcome unresolved;
- a reviewer may promote or contest that interpretation.

A citation never verifies an experimental result, and a model score never verifies a literature claim.

## Recursive refresh

A refresh becomes due when the campaign has no prior knowledge cycle, a new run outcome has not been consumed by a cycle, or the latest cycle's `nextReviewAt` watermark has passed. The bounded literature child receives the new outcomes and current graph, searches and fetches within explicit budgets, then submits one artifact. The backend validates exact excerpts and graph references before atomically recording the entire cycle.

The recursive execution loop commits deterministic trajectory knowledge before
the persistent scientist authors its next mutable `trial.py` delta:

```text
run one trial
  -> deterministically close the trajectory
  -> publish its score, generator diagnostics, and hypothesis outcome
  -> reload the campaign knowledge and unchanged contract hash
  -> let the scientist author and evaluate the next Proto delta
```

The proposal contains an action, hypothesis, rationale, and success criterion.
It cannot create an experiment, change a contract, or change an evaluator. A
`continue_experiment` proposal must name an exact experiment in the campaign.

Deterministic closeout—outcome, hypothesis state, diagnostics, search observation,
and an empirical knowledge cycle—is the experiment-loop synchronization barrier.
External literature retrieval is a separately scheduled campaign-plane action;
it is required when due at a campaign boundary but does not block every empirical
edit/evaluate step. Skill refinement likewise stays separate and replay-gated:
one trajectory may emit a persistent skill-feedback signal, but it cannot
activate its own methodological lesson. The next campaign observation includes
those signals alongside completed trajectories and failed authoring attempts;
promotion still requires an explicit refinement plus held-out shadow replay.

```text
bun run research:cli -- knowledge status CMP_ID
bun run research:cli -- knowledge refresh CMP_ID --session SES_ID
bun run research:cli -- knowledge alignments CMP_ID
bun run research:cli -- knowledge cycles CMP_ID
bun run research:cli -- alignment review CMP_ID ALN_ID --by REVIEWER
```

`knowledge refresh` is watermark-aware and exits without starting an agent when no refresh is due. `--force` permits a deliberate bounded review.
When due, it returns a durable job immediately; `job watch JOB_ID` follows the
review through persistence without holding an HTTP connection open.

## OKF projection

The bundle follows OKF v0.2's Markdown plus YAML model, lifecycle metadata, source links, generated/verified distinction, `stale_after`, progressive `index.md`, and chronological `log.md`. Autofold emits domain-specific concept types while retaining the required OKF `type` field.

| Directory | Meaning |
| --- | --- |
| `experiments/` | Frozen experiment contracts and evaluator configuration |
| `trials/` | Trial hypotheses and content-addressed programs |
| `concepts/` | Locked evaluation outcomes and terminal failures |
| `hypotheses/` | Competing hypotheses with falsification criteria and evidence-linked supported/refuted state |
| `search/` | Explored Proto fingerprints, portfolios, score deltas, and structured generator diagnostics |
| `sources/` | Immutable literature records and frozen excerpts |
| `claims/` | Evidence-linked literature claims |
| `alignments/` | Typed claim-to-outcome interpretations |
| `cycles/` | Durable recursion inputs, outputs, gaps, and next review |

Runtime JSON remains the transactional source of truth so OKF files cannot bypass lifecycle validation, evaluator locks, atomic writes, or review authorization.

## Current boundary

This version implements event-triggered knowledge recursion through persisted,
leased jobs. It does not yet originate scheduled reviews on its own; a scheduler
can call the due-status and enqueue endpoints without changing this data model.
It also does not claim cryptographic attestation for model runs; run manifests
and locked evaluations remain explicit provenance until an attestation ABI is selected.
