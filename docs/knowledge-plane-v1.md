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
- a separately attributed reviewer may accept, contest or deprecate that interpretation without changing its experimental authority.

A citation never verifies an experimental result, and a model score never verifies a literature claim.

## Recursive refresh

A refresh becomes due when the campaign has no prior semantic reconciliation cycle, an open research question needs evidence, an outcome remains unconsumed, or the latest semantic review watermark has passed. Deterministic experiment closeout consumes its outcome but does not count as the first semantic review or reset that review's clock. A historical source-grounded cycle may count even when its trigger is `run_completed`. The bounded literature child receives the new outcomes and current graph, searches and fetches within explicit budgets, then submits one artifact. The backend validates exact excerpts and graph references before atomically recording the entire cycle.

The recursive execution loop commits deterministic trajectory knowledge before
the persistent scientist authors its next mutable Proto program intervention:

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

## Scoped retrieval and operator review

The scientist and bounded literature lane can query and read the authoritative campaign graph through `query_knowledge` and `read_knowledge`. Search covers all stored history with bounded pagination. Records expose lifecycle, source hashes, review actors, support/refute/context relations, superseded failures and exact target/contract applicability. Record snapshot hashes identify the current view; they do not attest truth.

```sh
npm run research:cli -- knowledge query CMP_ID --query "predictor disagreement"
npm run research:cli -- knowledge read CMP_ID --record CLM_ID
npm run research:cli -- knowledge review CMP_ID --record CLM_ID --status contested --reviewed-by human:operator --expected-hash sha256:HASH
npm run research:cli -- knowledge reconcile CMP_ID --claim CLM_ID --request-id RECONCILE_KEY --max-cost 2
npm run research:cli -- knowledge publish CMP_ID
npm run research:cli -- literature CMP_ID --request-id REVIEW_KEY --experiment EXP_ID
npm run research:cli -- job get JOB_ID
```

Operator reviews require the exact observed claim or alignment snapshot hash. The store checks the hash and campaign scope atomically, records reviewer and time, preserves the claim's original source evidence and confidence, and republishes the OKF projection. A competing review cannot silently overwrite another decision. `knowledge publish` repairs projections from authoritative state without inference or compute. Autonomous claim reconciliation runs as a separate bounded Pi `knowledge_review` job/session with its reviewer actor owned by the host. The queue freezes target/source hashes and contract identities; the reviewer reads a declared target/source contradiction graph and submits existing claim/alignment statuses, rationales and evidence IDs it read. The core checks source snapshots and all origin/ancestor leases, then atomically records the changes and an audit cycle. Reopening after commit reuses that audit and accepted proposal without another model call. The campaign's executable `request_review` move shares the knowledge-operation allowance and model budget. Unchanged contested claims do not repeatedly trigger review; new evidence can make them eligible again. Necessary graph/read limits yield explicit boundaries, and omitted optional context counts remain visible.

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

The transactional SQLite research store remains the source of truth so OKF files cannot bypass lifecycle validation, evaluator locks, atomic writes, or review authorization.

## Current boundary

This version implements event-triggered knowledge recursion through persisted,
leased jobs. It does not yet originate scheduled reviews on its own; a scheduler
can call the due-status and enqueue endpoints without changing this data model.
It also does not claim cryptographic attestation for model runs; run manifests
and locked evaluations remain explicit provenance until an attestation ABI is selected.
