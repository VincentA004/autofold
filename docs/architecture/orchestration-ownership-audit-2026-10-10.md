# Autofold orchestration ownership and persistence audit — 2026-10-10

Scope: source in `/Users/vincentallam/Developer/autofold`, principally `backend/engine/src/jobs`, `backend/science-core/src/research/job-service.ts`, storage, scientific admission, workspace editing and worker liveness. No historical research records, live models, GPU workers, server processes, SSH or campaign state were changed. All tests use temporary projects and the offline network preload. The main checkout already contained a broad migration and other uncommitted work; it was preserved.

## Result

The SQL transaction and job epoch compare-and-swap are sound building blocks. The fragile part is that operations formerly evaluated different subsets of authority. Claim checked ancestors; heartbeat/checkpoint/completion checked only the leaf. Scientific first launch knew the job ID but not the current caller epoch. Trial creation deduplicated origin identity without atomically validating the owner. Each surrounding controller tried to repair the missing pieces separately.

Three deterministic offline reproductions exposed that disagreement, even while all 25 existing job-service/store tests passed:

1. Parent lease 1 second, child lease 5 seconds, advance clock 1001 ms: child heartbeat, checkpoint and success all accepted after its parent lost authority.
2. Cancel an owner, then call `createTrial` with its origin: a new trial was admitted and consumed campaign capacity.
3. Reclaim a parent under another epoch, omit `parentLeaseId` during child enqueue: fresh child creation was accepted with no proof the caller owned the new parent epoch.

The fixture is `/private/tmp/autofold-ownership-repro-20261010.ts`. It records the pre-repair behavior; running it after the repair should fail at the first formerly accepted lifecycle commit.

## Authority and persistence map

| Boundary | Durable authority | Owner | Required invariant |
| --- | --- | --- | --- |
| Scientific identity, contracts, jobs, trials, runs and evaluations | Per-project research SQLite | `StorageResearchStore` and science-core service | Mutation runs once against a transaction snapshot; records validate before commit |
| Host job grant | Immutable payload, `host:lifecycle:start`, native start checkpoints | `PiJobController` | Identity, original deadline and budgets survive controller recovery |
| Current host authority | Job status, lease ID, expiry, cancel marker, complete ancestor chain | Research job service | Current leaf epoch and every ancestor are live; cancellation forbids new work |
| Pi transcript and provider accounting | Session SQLite and journal, independent session lease | Runtime/session store | A live job lease cannot steal a busy session or treat unknown model cost as zero |
| Scientist intent and pending evaluation | Job checkpoints plus fsynced scientist register | Scientist lane | Request/phase identity binds captured program before trial/run creation |
| Dispatch identity | Run/request/dispatch files plus research run record | Scientific execution | First launch requires current grant; ambiguous launch becomes recovery-required |
| Execution outcome | Verified original worker receipt/artifact manifest | Execution finalizer | Receipt inspection does not become permission for a new effect |
| Campaign consumption | Immutable completed-step receipts, unsettled child admissions and transcript deltas | Campaign controller | Admission and settled consumption are distinct; expiry permits closure, not renewed spend |
| Editable program files | Workspace adapter revision hash | Human workspace API | Unfinished owned intent keeps its original program bytes protected |

The filesystem, research SQLite and session SQLite do not form one transaction. This is why the durable intent/result protocol and receipt-only reconciliation are essential. Replacing them with a bare queue would weaken the current safety guarantees.

## State transitions

| From | Trigger | To | Accounting and attempts |
| --- | --- | --- | --- |
| absent | Valid enqueue, target and parent epoch checks | queued | Attempts 0; immutable payload/idempotency identity |
| queued/retry_wait due | Atomic eligible claim | running | Attempts +1; fresh epoch; original `startedAt` retained |
| interrupted | Ordinary or selected eligible claim | running | Same scientific attempt; recoveryCount +1 |
| recovery_required | Exact `reconcileJobId` claim only | running | Same scientific attempt; recoveryCount +1 |
| running | Valid heartbeat | running | Extend host liveness only; do not extend spending deadline |
| running | Valid same-data checkpoint | running | Immutable phase receipt; conflicting data rejected |
| running | Result plus observed accounting settled | succeeded | Release epoch; durable completion/result; clear recovery |
| running | Failure with attempts remaining | retry_wait | Bounded exponential delay, capped60s |
| running | Failure with no attempts remaining | failed | Durable error; release epoch |
| running | Shutdown/lease loss or supported crash recovery | interrupted | No invented success or scientific retry; immutable recovery receipt |
| running | Unknown execution/child/accounting or unsupported protocol | recovery_required | No ordinary dispatch; explicit original-effect recovery |
| any nonterminal | Cancel | cancelled | Release epoch; controller cancellation cascades descendants atomically |
| failed/cancelled | Explicit operator retry | queued | Reset attempts and cancellation; retain frozen payload, deadline/baselines/checkpoints |
| terminal | Late cancelled succeed/fail | same cancelled | Cancellation remains terminal; stale work gets no authority |

`interrupt` can detach an expired but still matching epoch; it cannot mutate a superseding owner. This exception is necessary to record uncertainty after losing lease time. It is not a renewed lease.

Legacy runtime recovery is deliberately separate: its resumable-checkpoint retry convention must not be interpreted as Pi grant authority. Unknown foreign jobs are neither claimed nor silently rewritten by the Pi worker.

## Concrete fixes and evidence

### P1: leaf lifecycle accepted work after ancestor authority loss — repaired

Pre-repair locations: `job-service.ts` `ancestorsLive` at323-336 versus own-only `assertLease` at413-416; `jobs/lease.ts` own-only polling at51-54. Fresh claim was fenced but the already-running leaf could keep writing and mark success.

Repair: `ResearchJobService.inspectAncestry` and `inspectOwnership` now centralize snapshot authority at `job-service.ts:35-65`. Heartbeat, checkpoint, succeed and fail all call the shared predicate inside their transaction. `Service.checkOwnership` returns the record and predicate result in one read. `JobLease.check` uses that result at `jobs/lease.ts:51`, causing outstanding host work to abort on dead ancestry. Missing, foreign, cyclic, excessively deep, terminal, cancellation-marked and expired ancestors fail closed.

Recovery can explicitly adopt a reclaimed live ancestor epoch. Existing child identity is not permanently tied to the old parent epoch, because doing that would make legitimate crash recovery impossible. New child creation does require the caller's exact current parent epoch.

Tests: core longer-child-than-parent lifecycle rejection, missing/cyclic/terminal/cancellation ancestry, stale epoch; engine outstanding-work polling interruption. The host runtime now invokes `authorizeModelRequest` before creating durable provider-dispatch intent and again after the journal write immediately before provider transport. Job-bound runtime creation preserves any configured host callback, then checks current leaf/ancestor ownership and the exact original grant deadline. A deterministic callback expires the parent at this boundary and proves zero provider calls, zero model turns, no model-request ledger, and an interrupted leaf instead of spending. Existing actual parent-selected and child-selected native CPU SIGKILL receipt recovery tests remained enabled and passed.

### P1: fresh child creation lacked proof of current parent epoch — repaired

Pre-repair enqueue checked parent equality only when the optional `parentLeaseId` was provided. A detached controller could omit the epoch after another controller reclaimed the parent.

Repair: new Pi child creation requires nonempty exact `parentLeaseId` and shared parent ownership validation at `job-service.ts:108-115`. Existing identical idempotent enqueue remains a read of its original job before this gate; it does not create a new effect. All production campaign child paths already supplied exact epochs; generic test handlers were updated to do so.

Tests reject missing and stale parent epoch; they also verify original child settlement is possible after authorized ancestry recovery.

### P1: trial admission had a read/check-to-write ownership race — repaired by effects agent

Pre-repair `ScientistLane.executeIntent` checked cancellation, then separately called `ResearchService.createTrial`; trial creation at `service.ts:1121` enforced scientific scope, deduplication and capacity but no job lease. Cancellation could win between the read and transaction, yet new trial admission still consume a slot.

The effects agent added a host-only exact-epoch authority argument to new managed trial admission and reused the shared snapshot ownership predicate inside the same research transaction. Deadline and scope checks apply before new work. Existing matching origin remains idempotent recovery, including after cancellation; it returns the original record and consumes no new capacity.

Tests in `job-service.test.ts` reject missing owner, stale epoch, past original deadline and cancellation, and ensure exactly one original trial remains after receipt-identity replay.

### P2: unresolved ownership did not protect pending draft identity — repaired

`workspace.ts:57` previously blocked edits for queued/running/retry_wait but allowed interrupted and recovery_required jobs. A user could change the draft path referenced by unresolved original intent; a repeated `evaluate_trial` request then rejects the changed draft hash at `scientist/index.ts:642-643`. The actual authored execution program is separately content-addressed at `.autofold/programs/<hash>/trial.py` (`programs.ts:158`) and the run has immutable bundle inputs. This is an authoring/intent consistency gap, not corruption of verified execution inputs or proof receipt recovery would fail.

Repair adds both unfinished recovery statuses to the existing transactional edit fence. HTTP regression verifies editing is rejected and original bytes preserved for both states; explicit cancellation releases authoring for a new draft.

### P1 availability: one store exception permanently stopped the worker — repaired

`runWorker` previously let an admission/store exception escape. `server.ts:195` logged the rejected worker promise once and kept serving healthy HTTP traffic, leaving the queue unprocessed indefinitely.

Repair: admission polling has abortable exponential failure backoff capped30s. `workerState` exposes running/degraded/stopped, consecutive failures, compact error, last failure/success and scheduled next poll. Success clears degradation. This changes poll liveness only: it does not reset a job, manufacture results, repeat a scientific attempt or relaunch a process.

Regression injects one pre-claim SQLite failure, observes degraded status and attempts0, then confirms the same job completes with attempts1 and no duplicate identity. Root integrates worker state into status/health.

## Automatic worker versus explicit recovery

- Ordinary `runOnce` recovers expired recognized jobs, preserving grants, and uses FIFO plus ancestor eligibility. Because parents are created before their children, a recoverable campaign parent is normally reclaimed first; direct selected-child `runOnce` under an inactive ancestor safely declines a claim.
- Explicit `reconcile(selectedJobId)` at `jobs/index.ts:516` walks ancestry and recovers the highest recoverable ancestor first, then returns the originally selected job. An active ancestor stays under its existing controller. Missing or foreign ancestry and cycles are rejected.
- Explicit root recovery settles children before invoking the campaign handler and enables `recovery_required` only for the exact selected original identity. The operation cannot authorize another model turn, staging or first dispatch.
- A cancelled or succeeded ancestor is not a recovery target. Leaf effect continuation remains blocked; already-existing execution receipts can still be inspected through the execution reconciliation API.
- Ordinary worker recovery may continue the original grant if time/budget remains and all old effects settle. It is not equivalent to receipt-only recovery.
- An expired-deadline campaign whose child remains interrupted/recovery_required can safely enter `child_unresolved` instead of autonomously recursively collecting all receipts. This is a remaining operational limitation, not permission to renew a grant. Do not erase the hold to make the queue appear healthy.

## Recommended architecture beyond these repairs

Keep the current evidence/grant protocol and introduce a typed host coordinator around it. The shared snapshot predicate is its first small component, not the entire redesign.

1. `OwnershipCoordinator.inspect(snapshot, handle)` returns authority/blocker details, with one typed `JobHandle {projectId,jobId,leaseId}` rather than optional owner strings threaded differently by each caller.
2. Separate capabilities by operation: new-effect admission requires live ancestry, exact epoch and original grant; host checkpoint requires live ownership; original receipt reconciliation consumes immutable effect identity and grants no new effect; detach requires only still-matching epoch.
3. `RecoveryCoordinator.plan(selectedJobId)` produces an explicit root-first ownership tree, original session/effect identities and blockers. `apply(plan)` invokes only receipt collectors and journal replay before any grant continuation. Both unattended worker and explicit API use the same planner with different continuation policy.
4. `EffectLedger` owns typed intent/admitted/launched/outcome_unknown/receipt_verified/settled phases. Job status describes controller liveness; effect status describes the external world's uncertainty. A cancellation request must not imply the external effect disappeared.
5. The runtime callback now fences model dispatch and compaction with current host authority. Preserve this callback when constructing every specialist runtime; cancellation polling remains a backstop for already-running work.
6. Store immutable grant and checkpoint events independently of hot lease headers. Add indexed direct reads and transactional CAS for claim, heartbeat and authority inspections rather than loading/validating the entire scientific project for every 250ms poll.
7. API recovery results should include `selectedJobId`, actual recovered root, original outstanding effects and typed blockers. Returning the unchanged record with HTTP200 is safe but operationally opaque.

Migration can be incremental: retain existing tables/files and decode existing checkpoints into typed compatibility adapters; add typed command/authority interfaces first; centralize recovery policy; then optimize hot persistence without moving historical records during normal startup.

## Remaining limitations and tests to add

Storage correctness already has cross-process one-owner claims, writer serialization, crash rollback, immutable blob, schema and migration tests. Performance remains unmeasured: `StorageResearchStore.read` takes an exclusive in-process lock, initializes through `BEGIN IMMEDIATE`, and parses the whole state; `persist` still traverses every record/blob even when only one lease header changes. Large histories or slow fsync work can delay heartbeat authority. Workspace writes deliberately await filesystem work while holding the transaction to keep their edit check atomic. No claim is made that this occurred in the observed campaign.

Add load/latency tests with growing histories, process suspension between admission and dispatch, independent ancestor cancellation immediately before every model/effect boundary, nested recovery trees beyond one campaign/child pair, stale recovery plans after another epoch wins, and cancellation plus receipt arriving at the same time. Use an injected clock and deterministic barriers so tests prove authority outcomes rather than depend on scheduling luck.

Validation at audit time: initial25 core/store tests passed while the three holes reproduced. After ownership repair,27 core/store tests passed. Focused workspace/worker/ancestor regression3/3 passed. First engine run overlapped an effects-agent API edit and had two transient native-fixture failures; both native SIGKILL selection tests and the ancestor polling regression passed. Stable-source rerun:33 core/store/workspace tests passed; the two previously failing native fixtures passed2/2 (~43s); engine typecheck passed. Final full integrated results are reported separately by the root.

Post-audit boundary extension: focused ancestor-polling, transient-admission and immediate provider-boundary regression tests passed3/3 with the offline preload. The provider-boundary test observed zero dispatched requests and turns. Runtime specialist/campaign wiring is owned by the other agents.
