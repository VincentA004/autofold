# Cohesive engine: first implementation slice

This implements failure settlement and shared discovery/replay authoring from the [engine design](cohesive-engine-design-2026-10-12.md). It preserves the existing operation kernel, Pi runtime and frozen Proto execution boundary.

## Implemented boundaries

| Boundary | Result |
| --- | --- |
| Operation settlement | Typed success, failure and cancellation evidence; scientific effects and provider accounting settle independently. Unknown original billing remains unknown. |
| No-dispatch proof | A durable write-ahead marker and an atomic ownership census prove absence of scientific effects. Prepared original requests require their original terminal receipts. |
| Native job recovery | Verified failed/cancelled recovery closes the native job without converting it to success, resetting its grant or repeating work. |
| Shared program admission | Discovery and replay use one captured-source inspection, fingerprint and scientific-methodology kernel. Discovery adds its current branch/guidance policy. |
| Replay authoring | Independent Pi sessions use isolated native read/write/edit workspaces, frozen evidence, one assigned guide, `validate_trial` and file-based `submit_trial`. |
| Original execution evidence | An immutable terminal transport observation is published before the run projection. Read-only failure verification checks original request, dispatch, bundle, worker and evaluator bindings. |

The whole-program `submit_shadow_program` interface, duplicate replay reference reader and success-only auxiliary settlement shortcuts are removed. Historical replay protocols remain receipt-only; they cannot silently continue with new tools or workspaces.

An authoring failure after earlier successful replay arms settles against those original receipts while leaving the candidate guide unevaluated. A checkpoint interruption after accepted work remains recoverable. Terminal projection rebuilds preserve failure and uncertainty. Explicit offline fixture provenance cannot be inferred merely from an injected model stream.

## Code

- [Operation kernel](../../backend/science-core/src/research/operation-service.ts) and [native jobs](../../backend/science-core/src/research/job-service.ts).
- [Auxiliary state](../../backend/engine/src/operations/auxiliary-state.ts), [original accounting recovery](../../backend/engine/src/operations/auxiliary-recovery.ts) and [typed job recovery](../../backend/engine/src/jobs/index.ts).
- [Shared admission](../../backend/engine/src/scientist/admission.ts), [native workspace](../../backend/engine/src/scientist/workspace.ts) and [skill controllers](../../backend/engine/src/skills/controllers.ts).
- [Execution receipts](../../backend/engine/src/execution/index.ts) and [bounded live validation driver](../../tooling/script/cohesive-engine-live-validation.ts).

## Verification

The full backend suite passed 214 science-core tests (one skip) and 491 engine tests. The CPU worker suite passed 118 tests with one skip. Backend typechecks and the targeted original-receipt, campaign and native-admission checks passed.

Historical preservation compares file SHA256 values and logical SQLite contents across 63 original evidence roots, 47,149 files and 56 databases. Both prelaunch and final comparisons passed with no changed original roots. No historical grants, programs, sessions or knowledge were resumed or copied into the fresh validation context; only the verified frozen target files were copied.

The live driver is prepared under `.autofold/cohesive-engine-validation-20261012/operator`. It pins the source, worker, driver, profile, contract, authorization, offline logs and target bytes. The smaller grant permits at most eight trials: two discovery trials and six protected replay arms, with separate $2 reported-inference and SDK-estimate ceilings, one candidate and 600 GPU seconds per trial. Replay requires a fresh supported refinement opportunity. Native file authorship, exact provider receipts, original execution receipts, effect-free reopen and physical worker shutdown are audited separately.

The user explicitly approved private worker/program/target bytes going to the existing `workstation_4090` GPU host and fresh prompts/tool context going to OpenRouter after automatic approval review requested that specific consent.

The first fresh live attempt used 24 model turns reading internals and created no draft, trial or GPU dispatch. Its original billing is fully known: $0.098266156 reported inference and $0.097164168 SDK estimate. Original receipt-only reopen produced no new effects, and the read-only physical shutdown audit passed. This attempt is preserved as an authoring failure in the validation report, even though its managed jobs settled successfully.

That result identified a missing discovery asset: replay supplied a native template, while discovery did not. Discovery and replay now both expose a read-only `NATIVE_TEMPLATE.py` from the same utility and share early-draft/validation guidance. Six focused workspace/API tests, four installed native construction/admission tests and a typecheck pass. The fresh retry retained the original 22:08:35.952Z deadline and the remaining inference ceilings; it did not resume the closed first grant.

The retry authored and executed one native discovery trial successfully. Read-only verification confirmed native Pi file authorship, the exact worker identity, complete required Boltz2/Chai1 evidence, a valid finite locked score and unchanged original state. Worker wall time was 136.271 seconds. The following model request lost its original provider response and usage evidence. The engine held both the discovery continuation and its parent job as `recovery_required`; the original request remains `unknown`, with no upstream request ID or fabricated zero-cost settlement. Further paid inference stopped. The retry's physical shutdown audit passed.

Across both paid attempts, the 36 known responses report $0.127951966 inference, plus one unresolved original request. This is a known subtotal, not a settled total or proof of the complete reported-inference ceiling. The unresolved request, session ledger and held managed jobs are retained under `.autofold/cohesive-engine-validation-20261012-retry1/operator`.

The replay validation completed with an explicitly controlled, operator-authored Pi fixture and a separate session database, with zero further paid inference. All six native replay arms succeeded, producing seven distinct realized candidate sets across discovery and replay. Every original receipt contains complete required Boltz2/Chai1 evidence and the frozen worker identity. The audit verifies each prepared program against its admitted file, exact guide application and native Pi write/edit-to-submit journal chain. The actual paired policy rejected the operator candidate because its gain/nonregression requirements were not met; no activation was forced.

The replay operation settled its effects and explicit fixture accounting independently of the original unknown paid request. Original held jobs, operations and paid session ledgers stayed unchanged. Receipt-only reopening caused zero model or GPU work. Final read-only physical verification confirmed seven terminal original worker receipts and no owned processes remaining. All seven original launches respect the aggregate eight-trial ceiling, one-candidate/600-second GPU/15-minute wall limits and original global deadline. Discovery used a valid shorter deadline; the initial overly strict aggregate diagnostic is retained alongside the corrected ceiling audit. No replacement launches occurred.

The consolidated engineering result and exact evidence hashes are saved in [validation-summary.json](../../.autofold/cohesive-engine-validation-20261012-retry1/operator/validation-summary.json). These controlled checks establish execution and settlement behavior; they do not establish autonomous replay quality, scientific improvement or biological confirmation. The complete paid-inference total and its ceiling remain unproved while the original provider request is unresolved.

The memory packet consolidation and trajectory observation/closeout redesign remain later design slices.
