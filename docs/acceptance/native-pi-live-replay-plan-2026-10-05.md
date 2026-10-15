# Native Pi live replay campaign — October 5, 2026

The user authorized a fresh live run to test the native replay admission and campaign scheduling fixes. Production runs from the main checkout. This run starts directly with ordinary discovery; it has no separate acceptance gate and does not resume an older campaign.

Status: settled with a deferred result; launched 2026-10-05T14:56:43.969Z. Absolute deadline 2026-10-05T20:56:43.969Z (3:56:43 p.m. Chicago October 5). The campaign can stop earlier at a scientific, budget or failure boundary. No retries or deadline extensions are authorized.

- Workspace: `/Users/vincentallam/Developer/autofold/.autofold/native-pi-live-replay-20261005`
- Project: `prj_native_pi_live_replay_20261005`
- Campaign: `cmp_b04b10e31cea47b0b8b19727da61f0fa`
- Experiment: `exp_769d3903400d48a6abe0b67590b32ac9`
- Campaign job: `job_fab47e491e9f4512a98a2e2543527f5e`
- Driver: `/private/tmp/autofold-live-replay-campaign-20261005.ts`; tool session 96123 under caffeinate.
- Limits: eight ordinary discovery plus six reserved independent paired replay trials, $10 recorded completed-response inference, six hours, twenty campaign boundaries, four knowledge refreshes, batches of two and at most $2 per child. Each trial retains 600 GPU seconds and fifteen wall minutes. These are ceilings, not required quotas.

The exact production source passed 486 tests, backend/UI typechecks and the production UI build, with two documented skips. Installed-Proto tests exercised native replay admission, evidence diagnostics and readiness ordering without provider calls or GPU model execution. The current source fingerprint still matches those checks. Fresh host path/git readiness passed BoltzGen and PXDesign with zero inference, dispatch or research-storage access. The 31 software audit artifacts were reverified. The previous provisioned run was read-only audited as terminal, with zero unresolved effects and $0.18486177 persisted inference.

Frozen source: `sha256:12437591ff6d891b39b31e5a381081ab57bcc3170eae1cb1ba10b154c153701a`. Worker: `sha256:0164029d60ac557279981f09b9722ab8a81c0a2f5e6b9e5c601f7bd86f2f47dd`. Canonical contract: `sha256:2d621d31642ea3a965d960bc90473127b56dbccc53befe93aca17a444eceb73b`. Execution profile: `sha256:74627987783029d08d0b8e619c578870bb13eb0359a416abe8de6cb9c6a7980b`. Driver: `sha256:4a29200d8c0111ad45645aa1f92ac24dd735dbda4888043d57e0e9715f2931f5`. The original target bytes, scoring panel and fixed seed are unchanged. OpenRouter `z-ai/glm-5.3-flash` uses Z.AI FP8 only, without fallback or automatic retry. Host ordinary output cap remains unset.

This campaign tests evidence-driven scientific continuation before procedural refinement, original-receipt knowledge reconciliation and review, immutable skill candidates, and independent equal-budget paired replay. Candidate activation requires replay evidence. A completed job or improved single score does not establish recursive method improvement or biological validity; the fixed scoring seed and unavailable upstream generator seed limit causal claims. Optional registered models and PX extended external-MSA dependencies are not fully certified. Near-native-limit compaction is enabled but may not be exercised.

Operator evidence is in `operator/preparation.json`, `human-grant.json`, `driver-verification.json`, `launch-readiness.json`, `launch-fence.json`, `authorization.json`, `stage.json`, `route-latest.json` and `monitor-latest.json`. The active heartbeat observes durable state and stays quiet during normal progress. Refinement/replay session alias mismatches can make the generic aggregate cost null; direct persisted operation sessions and immutable accounting govern settlement. No sessions are initialized while auditing.

On settlement, verify receipt provenance and frozen pins, preserve `operator/settlement-audit.json`, report actual scores, costs, knowledge/review and skill/replay outcomes, then pause monitoring. Unknown remote effects must be reconciled under their existing receipt identities, without replacement dispatches.

## Settlement — 15:04:56 UTC

The campaign stopped before scientific authoring or GPU admission. Outer job status is succeeded, but its result is deferred at `child_job_requires_attention`: independent `knowledge_review` job `job_729e1821c39942678b9fb56cae558936` failed with `Reviewer ended limit_reached without accepted reconciliation`. All fourteen trial slots remain unused (eight discovery, six reserved replay). There are no trials, runs, valid/invalid scores, GPU receipts, scientific continuations, skill candidates, replay pairs or compactions. This run does not verify the native replay repairs or recursive improvement.

Recorded completed-response inference totaled **$0.03546202**: literature $0.01571908 and independent reviewer $0.01974294, reconciled to direct persisted session usage and the campaign result. Literature produced four source-attributed records, five proposed claims and one knowledge cycle; independent reconciliation committed no decisions. Retrieved text and proposed interpretations remain unreviewed and establish no biological result.

The reviewer read the frozen source graph, then made four rejected submissions within fifteen tool calls/seven turns. Its first submission cited each target claim as evidence for itself alongside bare literature IDs, violating the self-citation rule. Subsequent submissions guessed campaign-prefixed, hash-suffixed and `literature:` formats. All received the same generic citation error. This exposed an ambiguity in reviewer tool guidance and corrective feedback, before any scientist or replay authoring. Next offline work is an explicit bare-record citation contract, target/ref-specific errors and a regression reproducing the observed failures, while retaining the source-read and self-citation checks. Monitoring does not authorize this source change or another retry.

Read-only settlement verified 56 durable blobs, 31 software audit artifacts, frozen source/worker/profile/contract/route/driver bindings, terminal jobs, zero pending tools and zero active leases. No scientific dispatch occurred, so there are no remote receipts to verify or reconcile. Driver exited 3 after recording the deferred boundary. Full evidence is in `operator/settlement-audit.json` and `operator/reviewer-tool-evidence.json`. Monitoring is paused after this report; no retry, replacement dispatch, budget extension or source edit was performed.

### Reviewer termination clarification

Direct persisted session inspection records `Maximum run duration reached`. The reviewer reached its five-minute duration ceiling after seven turns and fifteen tool calls; fifteen was observed usage, not its configured call ceiling. The four rejected citations and deferred campaign boundary are unchanged. Subsequent architecture/diagnostic repair is documented in ../core-discovery-architecture.md; the old terminal campaign was not retried.
