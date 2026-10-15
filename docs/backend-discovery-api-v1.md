# Backend discovery interface for frontend development

The host fixes workspace, project, execution profile and recipient credentials. Frontend requests select existing campaign/experiment IDs; they cannot rebind the host or alter a running experiment contract. Queue mutations return durable job IDs. A successful outer campaign job can contain a stopped, deferred or exhausted inner result; render both.

## Read-only graph evidence

- `GET /research/experiments/:experimentId/graph` returns the same bounded planning view used by the persistent scientist: `focusTargetId`, `snapshotHash`, `planningEvidence` (at most 12), `sourceRecords` (at most 24), `relations` (at most 60), `repeatedCandidates`, applicability/authority labels, issues and truncation.
- `POST .../graph/search` accepts bounded query, kinds and pagination.
- `POST .../graph/read` accepts a node ID and optional expected record hash.
- `POST .../graph/traverse` accepts a root ID, optional expected hash, up to four hops and at most forty nodes.

These operations read canonical project records, never create SDK sessions, enqueue work or invoke inference. Other-campaign results retain applicability labels; retrieval does not authorize cross-contract score comparison. A missing link or source remains an evidence gap. For the scientist, an unavailable graph is advisory and does not block independent execution.

## Native Proto model registry

`GET /research/model-registry` returns `autofold.proto-model-registry.v1`: native language/tool commits, worker source hash, deterministic content hash and scientific tool/generator cards. With no configured Proto runtime it returns an empty inventory with null provenance. Read-only discovery uses the pinned local registry and public schemas with GPU visibility disabled and offline model-hub settings; it does not initialize SDK sessions, invoke model functions, probe assets or dispatch scientific work.

Each card exposes its exact native key and category, role hints, public input/config/output schemas, metric declarations, seed fields, source links and toolkit license declarations. Schema defaults/examples are omitted. `nativeFeatures` indicates schema declarations; `bridgeFeatures` separately describes preservation by the current Autofold scoring bridge. Neither indicates model accuracy. Assets and measured resource profiles remain unknown, and checkpoint licenses remain unverified. Generic toolkit licensing does not certify a selected Protenix v2 checkpoint.

The scientist receives a compact inventory in `read_context.modelRegistry`, a read-only complete `MODEL_REGISTRY.json`, and `read_model_card` for progressive disclosure. The tool selects an exact `key` and `kind` (`tool` or `generator`), optionally a `section` (`card`, `inputSchema`, `configSchema`, `outputSchema`), and UTF-16 character `offset`/`limit` (default 12,000; maximum 24,000). Every page retains registry provenance/content hash.

Native `DiagnosticStage.required_input_features` becomes compiled `inputRequirements.features`. Required input preservation is checked by the compiler and again by the worker before model invocation. `first_available` selects the first registered adapter satisfying all declared requirements. Unsupported or unknown chemistry/MSA/template preservation fails explicit requirements. Existing plans without a declaration remain compatible; this change does not retrofit chemistry into historical sequence-only runs or alter a frozen scoring panel.

## Canonical state and evidence

Existing APIs remain: campaign status/loop, experiment history/context/workspace/autoresearch, jobs/status/cancel/reconcile, runs/artifacts, campaign knowledge and immutable skills/refine/replay/rollback. See `backend/engine/src/server.ts` for exact request validation and `frontend/workspace/src/research/client.ts` for the existing typed client. Job statuses include queued/running/succeeded/failed/cancelled/interrupted/recovery_required. Only original receipt reconciliation can settle unknown external effects; retry is not a safe replacement for reconcile. Reconcile resolves the selected job through its original recoverable ancestry and returns that selected job; callers need not manually select its expired parent first. Receipt-only campaign closeout accounts for already admitted terminal children before expiry and never authorizes another step. Missing original intent/accounting remains recovery_required.

Trials add optional `graphEvidenceUse`: cited IDs with retrieved record/snapshot hashes and retrieval time. This is host-recorded exposure/citation metadata, not proof that a graph improved a scientific decision. The full original session journal remains the audit source. Trial skill references identify exact active version/content hashes at authoring.

## Replay metrics

Historical replay records remain unchanged. New replay records declare `scoreSemantics.activationPolicy=paired_valid_v2` and expose `pairedEvidence`, valid/total evaluation counts and metric coverage. Utility averages only valid locked outcomes; invalid evaluations have null utility. AUI retains the field name for compatibility but declares `sum_of_valid_trial_utilities`, not a measured improvement curve. Missing disagreement and non-applicable one-candidate diversity are null, never rendered as measured zero. Compute cost is reserved GPU hours.

The new rule requires at least two valid, distinct-candidate paired gains, positive mean paired utility delta, and no validity or compute regression. Repeated candidate identities within/across pairs do not count as independent gains. Invalid recovery is reported separately. A rejection is a completed scientific decision: retain the active parent and continue ordinary discovery within its remaining grant. Cross-campaign library promotion still requires three independent campaign validations; one local activation is not a generalization claim.

## Backend release gate

Recovery and accounting are verified with actual local CPU workers and controller-kill regressions before scientific GPU admission. Scientific GPU validation independently checks immutable authoring, fixed-contract results, honest evidence use and any claimed refinement/continuation. Additional remote fault testing needs a specific transport question that local tests cannot answer; deliberate crashes are not the default scientific gate. These criteria convey no spending authority.

The October 9 unchanged-source harness acceptance failed at child-first recovery. Its original deadline and unused authority expired; monitoring remains paused. Later human-authorized recovery settled the original measurement and final accounting with zero new GPU/model calls. The valid locked score is 0.26050897359848024; the parent is outer succeeded / inner deferred at its expired deadline. Separate recovery audits do not turn the failed old acceptance into a pass or establish subsequent scientific continuation. See [the preserved acceptance](acceptance/backend-discovery-completion-2026-10-09.md) and [the recovery reassessment](acceptance/backend-recovery-reassessment-2026-10-10.md).


## Original operation recovery and projections — October 10, 2026

`GET /research/jobs/:id/recovery-plan` reports the selected original job, recovered root, ordered original IDs, receipt-only mode and blockers without authoring or compute. `POST /research/jobs/:id/settle` uses that same planner and returns `{plan,job,outcomes}`. Existing `/reconcile` keeps its selected-job response. Queued, unadmitted work is not started by settlement. Cancellation and effect settlement are separate: a job may stay cancelled while its exact original receipt/accounting settles; new spending authority is never restored.

`GET /research/operations` reports canonical phase/revision/epoch, owner and independent effect/accounting/outcome/settlement axes plus outbox status. `POST /research/operations/:id/rebuild-projection` rebuilds auxiliary JSON from canonical state without repeating science. CLI equivalents are `job recovery-plan`, `job settle`, `operations`, and `operation rebuild-projection`. JSON-only historical operations remain readable for receipt verification; new work requires explicit migration. Newly managed cancelled identities cannot be reset through retry.

Typed recovery ports cover literature, independent review, refinement, shadow replay and campaigns. They verify original native commit identities and known accounting before reconstructing results. Missing receipts or usage remain unresolved. The campaign supervisor now advertises the actual discriminated `submit_move` input contract. See [the implemented coordinator and limits](architecture/operation-coordinator-implementation-2026-10-10.md).


## Host-owned evidence execution selection

For future compiled plans, the host selects `native_tool_sequence_v1` for unconditional topologically ordered panels and `legacy_dag_v1` for conditions or candidate ranking/routing. A host execution profile may explicitly select either backend through `evidenceExecution`; forcing native execution on an unsupported graph rejects before dispatch. Scientist declarations and frontend requests cannot change this host choice. Both paths call the same pinned native Proto tools and retain frozen scoring, budgets, source hashes and artifact provenance.

The selected backend is captured in the new pipeline hash. Historical captured policies that omit it retain legacy behavior and their original hashes; do not rebind existing receipts to the new default. The host compiles a frozen execution manifest and performs admission validation; it does not replace Proto's model/optimizer execution. Live flat-panel parity is recorded in [the comparison](acceptance/proto-execution-parity-2026-10-10.md); conditional/routed equivalence remains unproven.


## Native Proto search authoring (October 11)

`build_trial(ctx)` can return `ProtoTrial(program=<native Program>, search=NativeSearch(...), hypothesis=...)`. The scientist chooses native stages, configured generator instances, hard constraints, weighted objectives, conditioning and compatible optimizers. `NativeOutput` selects the exact final construct or region for the independently frozen protein evaluator. Final candidate limits are separate from proposal, sampling-call, registered-tool-request and wall-time ceilings; native optimizer settings are not rewritten to fit output quotas.

`read_model_card` accepts `tool`, `generator`, `constraint` and `optimizer`. Component inventory shares one pinned discovery process, and full cards expose native config/backward schemas and compatibility metadata. Inspection rejects native tool execution during module loading or construction, including attempted calls caught by authored code. Registry API requests are observed before cache/dispatch and counted as requests, not physical inference.

The pipeline identity includes the native construction projection. A hash-bound `native-search/receipt.json` records original identity, search counts, configured-instance events, histories and selected rich outputs. Original receipt reads verify this evidence and expose a compact summary to the scientist. Final scoring and coordinator recovery retain their existing contracts. Historical trials without `search` preserve legacy behavior. See [the integration architecture](architecture/native-proto-search-2026-10-11.md) for supported boundaries and the [CPU authoring example](../backend/worker/examples/native_search_trial.py).


## Managed discovery and decision evidence — October 11

Synchronous `Application.discover()` and queued autoresearch use the same managed job/scientist/session path. The synchronous response retains status/sessionId and adds the durable job identity/result; idempotency and explicit job limits apply. An existing owner is observed without stealing ownership. The old standalone discovery runtime/tool exports are retired; manual scientific CRUD ports remain available.

Scientist `read_context.decisionEvidence` exposes a compact verified observation card and read-only workspace paths `evidence/decisionEvidence.json` and `evidence/candidateArchive.json`. Missing receipt artifacts remain `unavailableReceipts`; access is evidence availability, not causal scientific benefit. Scoped store ownership/heartbeat transactions preserve ancestor fences and do not alter scientific contracts. See [the consolidation and verification limits](architecture/backend-consolidation-2026-10-11.md).


The host default model is `deepseek/deepseek-v4.1-flash` through OpenRouter. Future ordinary calls should omit provider selection overrides and let OpenRouter apply account routing/privacy policies, per the user's instruction. Frozen historical grant-specific routes remain historical. The [default-route validation](acceptance/backend-consolidation-default-validation-2026-10-11.md) passed live authoring/GPU execution but exposed a billing distinction: SDK/static token-price totals are estimates, whereas captured OpenRouter response usage is the reported provider cost. They must not be represented as interchangeable measurements.


## Scientist response length and continuation

The current Autofold Pi runtime does not accept a `streamOptions.maxTokens` override. Pi and the selected provider own response sizing and intrinsic limits. A provider `length` response is passed to Pi's native continuation/recovery lifecycle; it is not an Autofold job-limit signal. Partial tool calls never execute. Original time, actual/estimated inference budgets, explicit request bounds and authority checks continue to govern every ordinary and compaction request. Default request timeout follows the runtime time allowance unless explicitly configured. Terminal discovery `result.providerAccounting` contains the original reported receipt axis separately from the SDK-estimated `result.modelCostUsd`. Historical settled records are never implicitly rewritten.
