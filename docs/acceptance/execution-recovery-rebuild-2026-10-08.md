# Execution recovery rebuild — October 8, 2026

The host orchestration and execution control plane was rebuilt on the main checkout at the user's explicit request. A lost controller lease now becomes a visible interruption, while unresolved execution or accounting becomes `recovery_required`. Recovery retains original identities, immutable checkpoints, attempt counts, grants and deadlines.

## Failure boundaries

| Scenario | Verified behavior |
| --- | --- |
| Controller process killed with SIGKILL | SQLite reopens the same job and its recognized lifecycle checkpoints; completed work is not repeated. |
| Heartbeat fails or an expired owner writes late | The controller detaches promptly, records the diagnosis and rejects heartbeat renewal and commits under stale authority. |
| Shutdown immediately after a native CPU receipt commits | Pi finishes its transcript and session lease cleanup with SQLite kept open; reopening consumes the existing result without another provider turn or worker launch. |
| Worker launched but acknowledgement lost | The real local supervisor returns the original receipt; the original run and job settle without relaunching. |
| SSH acknowledgement fails and remote identity is absent | The original local fence remains. The job holds before SDK initialization and cannot infer, launch or report completion. |
| Status connection temporarily unavailable | At most three read-only status attempts. Launch, upload, cancellation and provider calls gain no automatic retry. |
| Parent and child leases both expire | Explicit reconciliation recovers the exact owned jobs and saved results. Unknown child effects hold their parent. |
| Session lease still owned independently | The job holds as accounting recovery; it cannot declare failure or start another model call merely because the controller lease changed. |
| Original or ancestor deadline expires | Receipt inspection remains possible; a new remote launch or provider turn is rejected. Recovery does not reset the deadline. |
| Owner cancelled with an unresolved run | Replacement compute remains blocked in the same scope. Cancellation does not prove the prior run settled. |
| Original usage baseline missing | Accounting remains unknown and blocks campaign completion and continuation admission. |

The host writes `host:lifecycle:start` before effects with a protocol version, exact payload hash and absolute deadline. A recognized original Pi/campaign deadline checkpoint remains supported for migration. An arbitrary checkpoint does not authorize automatic resumption. Lease CAS also checks actual expiry. Recovery checkpoints retain the prior owner and precise reason; unknown costs remain unsettled.

Original owned queued/running runs reconcile through their immutable request and receipt identity before SDK/session initialization. Receipt-only job reconciliation disables first launch and does not stage a replacement program or create an absent scientist session. An unresolved tool outcome aborts the generic Pi runtime immediately and retains the pending call in its journal.

`POST /research/jobs/JOB_ID/reconcile`, `job reconcile JOB_ID` and the Jobs UI's **Reconcile original result** action expose this operation. Held discovery remains visible and blocks overlapping compute. Held optional knowledge/review jobs remain advisory in the controller and UI. Generic job cancellation and explicit failure retry remain separate operations.

## Validation

`npm run check:product` passed **536 tests**: 170 science core, 300 engine, 62 worker and 4 UI. Backend/UI typechecks and the production UI build passed. 2 existing optional tests were skipped. The backend source and worker fingerprints remained unchanged throughout the final aggregate check. The UI policy was completed before its final tests, typecheck and build; its exact file hashes are recorded separately.

The fault tests use real SQLite, an actual killed controller process, the installed Pi SDK, native Proto CPU fixtures, and real local Python worker/supervisor processes behind an injectable SSH command runner. Provider calls are scripted fixtures; the offline network guard blocks real inference. No live provider or GPU campaign was launched.

Backend source: `sha256:18b2796dbedfce052a487a2db86087e098f4951c6338af9b5b1fd5d0e6ecda45`. Worker source: `sha256:0164029d60ac557279981f09b9722ab8a81c0a2f5e6b9e5c601f7bd86f2f47dd`. Full logs, source manifests, preservation hashes and file hashes are in `.autofold/execution-recovery-rebuild-20261008/operator/verification.json` and its sibling evidence files.

## Preserved campaign and limits

Read-only canonical row and session hashes, original operator JSON and dispatch fences remained identical before and after validation. The old profile, contract bytes, provider route and driver pins still match. The original campaign is expired with unresolved effects, its heartbeat remains paused, and no historical job was claimed, initialized, retried, reconciled or relaunched. Its three verified results and unresolved fourth execution remain unchanged.

This is software recovery validation. The workstation's original SSH timeout cause remains unestablished, and these local fault tests do not establish network reliability on that host or long-duration GPU stability. The source identity changed; prior scientific results remain attributed to their original source. No reproducible scientific improvement or biological validation is claimed.

## Subsequent live check — October 9, 2026

The user subsequently requested actual GPU validation. The same rebuilt source completed one real BoltzGen → Boltz2/Chai1 trial, with a valid score, directly observed GPU activity, verified original receipt/closeout/accounting and complete resource shutdown. See [the live GPU validation](live-gpu-recovery-validation-2026-10-09.md) for the original identities, authoring repairs, cost and limits. This supersedes the earlier statement that this rebuilt source had only offline validation; it does not establish long-run reliability or alter the expired campaign.
