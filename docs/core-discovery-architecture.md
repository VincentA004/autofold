# Discovery is the core loop

Autofold's primary product loop is a persistent scientist authoring and evaluating native Proto interventions under a frozen experiment contract. OKF and skills assist this loop.

```text
Persistent scientist: inspect → author → validate → execute → interpret → next intervention
                                     |                    |
                                 frozen contract      verified receipts
                                                          |
                                      +-------------------+------------------+
                                      |                                      |
                                  OKF assistance                        skill feedback
                             sources / reconciliation              immutable candidate guidance
                                      |                              protected paired replay
                                      +---------- advice/evidence -----------+
```

A campaign runs ordinary discovery without an initial literature cycle, review gate or between-batch OKF task. Literature and independent knowledge review run through separate explicitly admitted jobs. A due, open, blocked or failed research task never schedules a discovery interruption. Unexpected supervisor literature/review proposals remain recorded for separate processing and the campaign continues. Already owned research effects must still reconcile and retain their original charges before the owner can safely proceed.

All scientist questions are advisory. `empirical_test` records uncertainty for future measurements; `knowledge_lookup` records attributable lookup needs. Existing `prerequisiteBranchId` fields identify branch applicability without blocking validation or evaluation of that branch or its continuations. Historical untyped questions preserve their identity, status and assessment history without imposing an experiment dependency. Historical research-only yields are released without inventing an answer or altering a stop decision. Parent cancellation, deadlines, grant exhaustion, uncertain effects, source tampering and accounting failures remain hard boundaries.

Skills remain immutable guidance candidates until protected equal-budget paired replay supports an activation decision. They do not preempt the ordinary discovery allowance, and no candidate is manufactured merely to consume replay slots.

The literature assistant assesses one frozen question at a time through `assess_request`. The host supplies the request hash and revision, persists partial assessments across restart, and assembles the final `submit_review` atomically. Empirical questions remain visible in an experiment queue but are outside mandatory paper assessment coverage. Missing fields and incomplete coverage return precise paths and remaining request IDs. Original outcome reads and fetched-source checks still govern final acceptance.

The scientist can read immutable, hash-bound target JSON, structure bytes and a residue map inside its reference workspace. One-based sequence positions are separate from literal PDB residue identifiers. A map is declared only when an observed PDB chain exactly matches the frozen sequence; partial/unmatched chains and other structure formats remain unresolved. Target access does not imply a validated biological mechanism.

`read_context.budgets` distinguishes the current batch from the parent campaign. Parent residuals deduct immutable completed steps and reserve unsettled owned admissions; ordinary discovery and protected replay are shown separately. Displaying a parent residual does not enlarge the current job allowance.

Reviewer references are bare record IDs from read_knowledge; hashes belong in expectedHash. A target claim cannot support itself, and all cited sources must be read in the frozen scope. Validation now names the target, offending reference and correction for self-citation, malformed IDs or unread sources. Source-read, independence and atomic commit rules remain intact.

The prior empirical-routing repaired source passed **504 product tests** (163 science core, 275 engine, 62 worker and four UI), backend/UI typechecks and production UI build. Two existing optional tests remain skipped; the installed-Proto engine admission tests ran. Source `sha256:09476e2a3f6c58db16bcbfbfb75847399a1b7c0f120d90c2e3fb3d8a3bbd40e4` and the worker fingerprint stayed unchanged through the final check. The scientific contract, execution profile and provider route match the preserved campaign. No live provider request, remote scientific dispatch or historical campaign retry occurred. Verification: `.autofold/empirical-request-routing-repair-20261005/operator/verification.json`. Offline regressions reproduce the four-question submission failure and repaired restart, exercise empirical continuation after failed optional assistance, retain historical request recovery, reject scoped prerequisite bypasses, and check target-reference integrity and parent residual budgets.

The settled core-first campaign and its frozen receipts are preserved. This repair does not resume its grant or establish sustained recursive improvement. A new live campaign must use its own authorization, identities, deadline and source binding; it should start with ordinary discovery without a separate acceptance gate.

The later advisory-OKF change is verified separately in `.autofold/okf-advisory-20261005/operator/verification.json`. It removes branch and historical question gates and all new automatic literature/review dispatch from discovery. It preserves standalone research tooling and evidence checks. No new live campaign is part of this change.

The unchanged-source advisory repair passed **508 product tests** (163 science core, 279 engine, 62 worker and four UI), backend/UI typechecks and production UI build. Two existing optional tests remain skipped. Production source `sha256:a76a6a6ee214b13361589681bcdaeb6653df7b57104dcff2ac652d3cb8765e5b` and worker `sha256:0164029d60ac557279981f09b9722ab8a81c0a2f5e6b9e5c601f7bd86f2f47dd` remained unchanged through the final check; the contract, profile and provider route also match their before-check pins. The native CPU unanswered-branch test and separate research reconciliation/accounting integrations passed.


## Host ownership and execution recovery

The orchestration/execution control plane sits beneath the scientist, OKF and skill loops. It owns leases, cancellation, deadline authority, immutable dispatch identities, receipt recovery and original accounting. The Pi runtime owns a separate session lease and transcript journal; controller shutdown detaches job authority promptly while allowing that journal to finish safely.

A controller interruption is visible as `interrupted`. An unresolved run, child, session ownership or accounting baseline is `recovery_required`. Expired owners cannot renew or commit. Automatic recovery accepts only the recognized host lifecycle or original native deadline checkpoint and preserves the original attempt, payload and deadline. Arbitrary checkpoints remain held.

Explicit job reconciliation examines original effects without another provider turn, new SDK session, staging or first launch. A valid receipt can settle the same run and job; an absent identity remains unknown and blocks overlapping compute. Cancellation does not erase that boundary. Optional research stays advisory. The October 8 [rebuild validation](acceptance/execution-recovery-rebuild-2026-10-08.md) records real process/receipt fault tests and the full product checks; it does not certify live network reliability or scientific improvement.


## Shared orchestration authority and next design

The October 10 whole-layer audit consolidates ancestry/epoch checks and journals each provider request before invocation. Unknown usage prevents further spend and settlement; original receipt collection stays separate from new-work authority. Worker polling health, remote terminal-outcome checks and identical-receipt finalization now have offline regressions. A typed canonical operation coordinator, handler recovery ports, projection outbox and controller-independent worker supervision remain staged design work. See [the complete map and migration](orchestration-control-plane.md). Historical grants and receipts remain unchanged.
