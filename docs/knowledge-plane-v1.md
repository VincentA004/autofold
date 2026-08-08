# Knowledge Plane v1

Autofold's knowledge plane is a campaign-scoped, recursively refreshed scientific graph. The transactional research store is authoritative. The OKF bundle under `.autofold/campaigns/<campaign-id>/knowledge` is its portable, readable projection.

## Graph

```text
Campaign
├── Experiment contract (frozen objective, target, budget, evaluator)
│   └── Trial configuration (hypothesis, program path and content hash)
│       └── Run + locked evaluation
│           └── Research outcome or failure
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

```text
bun run research:cli -- knowledge status CMP_ID
bun run research:cli -- knowledge refresh CMP_ID --session SES_ID
bun run research:cli -- knowledge alignments CMP_ID
bun run research:cli -- knowledge cycles CMP_ID
bun run research:cli -- alignment review CMP_ID ALN_ID --by REVIEWER
```

`knowledge refresh` is watermark-aware and exits without starting an agent when no refresh is due. `--force` permits a deliberate bounded review.

## OKF projection

The bundle follows OKF v0.2's Markdown plus YAML model, lifecycle metadata, source links, generated/verified distinction, `stale_after`, progressive `index.md`, and chronological `log.md`. Autofold emits domain-specific concept types while retaining the required OKF `type` field.

| Directory | Meaning |
| --- | --- |
| `experiments/` | Frozen experiment contracts and evaluator configuration |
| `trials/` | Trial hypotheses and content-addressed programs |
| `concepts/` | Locked evaluation outcomes and terminal failures |
| `sources/` | Immutable literature records and frozen excerpts |
| `claims/` | Evidence-linked literature claims |
| `alignments/` | Typed claim-to-outcome interpretations |
| `cycles/` | Durable recursion inputs, outputs, gaps, and next review |

Runtime JSON remains the transactional source of truth so OKF files cannot bypass lifecycle validation, evaluator locks, atomic writes, or review authorization.

## Current boundary

This version implements event-triggered and scheduled knowledge recursion. It does not yet continuously poll in a background daemon. A scheduler can call the due-status endpoint without changing this data model. It also does not claim cryptographic attestation for model runs; run manifests and locked evaluations remain explicit provenance until an attestation ABI is selected.
