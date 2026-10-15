# Subsystem boundary refactor — October 11, 2026

Status: implemented and verified offline in the main checkout. This change performs no paid inference, GPU work, remote dispatch or historical-grant resumption. Existing acceptance decisions remain historical.

## Ownership in the implemented code

| Responsibility | Owner and boundary |
| --- | --- |
| Reasoning, repair, agent/tool loop, semantic compaction and native session tree | Installed Pi SDK through `engine/src/runtime`. The host records original external-effect boundaries and explicitly granted resource limits. It does not add a second science reasoning loop. |
| Generic file reading, writing, multi-edit matching and file mutation serialization | Pi's native tool factories with injected Autofold filesystem operations. `scientist/workspace.ts` defines experiment scope, immutable references, file bounds and symlink checks. Native factories own the queue; Autofold does not wrap it in another mutation queue. |
| Progressive procedural resources | Pi's `ResourceLoader`, supplied only approved immutable campaign skill versions by `scientist/resources.ts`. A session uses the actual scientific workspace. Cards enter the prompt; complete guidance is read on demand through verified file tools. Candidate/inactive versions and ambient operator resources are not discovered. |
| Biological programming, model composition, constraints, objectives and optimizers | Native Proto Program and model implementations. `science-core/research/workflow.ts` retains policy/schema translation for frozen protocols, but no longer launches Python. `execution/proto-inspection.ts` owns native discovery, construction-only inspection and config subprocess integration. |
| Scientific declarations and methodological admission | `scientist/admission.ts`, with an inspection-only execution port. Existing prospective plans, citation scope, comparator validity, repeated-candidate honesty and paired activation policy remain enforced. Validation errors return to the same Pi scientist for repair. |
| Frozen target copies and residue identifiers | `scientist/target-references.ts`. Exact bytes/hash verification is independent of editing and request dispatch. Unmatched PDB numbering remains unresolved. |
| Context, graph access, receipt-derived candidate evidence and published views | `scientist/context.ts` with narrow retrieval/capability ports. Graph references are advisory; this component cannot claim jobs, submit trials, dispatch workers or settle effects. |
| Resource visibility | Pure `scientist/budgets.ts` projects original grants, completed steps and unsettled admissions. The job host and execution boundary remain the admission authority. |
| Original evaluation intent, immutable request identity and trusted closeout | Existing scientist lifecycle and execution coordinator. `ScientistLane` remains the public facade; extraction does not add another lifecycle or replace original receipts. Atomic persistence and evidence projection helpers are shared. |

The scientist facade shrank from **992 to 647 lines**; the scientific policy module from **781 to 658 lines**. Those are responsibility reductions, not a claim that equivalent percentages of the whole backend were dead code. Old implementations were moved or replaced, rather than left behind under new wrappers.

The essential system prompt now states scope, owners and scientific invariants. Detailed Proto declarations, model schemas, decision-plan structure and target references are loaded progressively. Full procedural bodies are no longer duplicated into every `read_context` response. Legacy `read_file`, `write_file` and `edit_file` names delegate to the same native implementation so old transcripts remain usable. New authoring uses `read`, `write` and `edit` (multi-edit schema).

## Verification

- Complete offline backend/client suite: **576 passed, 1 optional skip, zero failures**. Two additional runtime-boundary tests and one native scientist CPU integration test passed; the four-test native tool/resource check passed after final wiring/type-only changes.
- Worker suite: **103 passed**. Backend and SDK typechecks passed.
- Actual installed Pi SDK scripted integration: approved skill cards appear without complete bodies, the scientist reads a body using the confined native tool, unactivated candidate guidance is absent, and altered immutable snapshots are rejected.
- In one real Pi agent loop, an offline scripted scientist writes an invalid draft, validates, repairs with native multi-edit, validates successfully, commits exactly one original CPU fixture receipt, reads verified evidence and records a supported stop. Seven scripted model turns, zero paid provider calls, zero pending tools and no extra evaluation.
- Native Pi multi-edits preserve BOM/CRLF; legacy aliases use the same behavior; invalid edits leave original bytes intact. Across independent tool instances, simultaneous edits to one file serialize and both changes survive. Aborted writes and scope/contract/symlink violations are rejected.
- Session creation, inspection and data-only recovery load no scientific resources and call no model. Existing original-request recovery, closeout ordering, cancellation, unknown receipts/billing and strict paired-policy regressions pass.
- Architecture checks keep Pi imports in the runtime, subprocess integration out of the scientific domain, and dispatch out of advisory context and admission.
- All **17 prior workspaces** match exact before/after logical SQLite records and file hashes. Worker source is unchanged. No host or model environment was modified.

Source pin: `sha256:3e80982fb01fb4f8c7e413d361b42dd79e77946840009aa1030101aac9ef6bcf`. Worker pin: `sha256:35ceb7814aa0979426dbd1c31d14118124c4c2b19705868f6d3c84e94bcb02ec`. Exact source snapshots, changed-file inventory and test logs: `.autofold/subsystem-boundary-refactor-20261011/operator/verification.json`.

## Retained boundaries and open gaps

The SDK's native session tree remains authoritative inside the existing audited SQLite persistence bridge. Kernel, graph, context and UI records remain projections; this refactor does not migrate stored sessions, simplify away independent leases or equate process exit with canonical settlement.

Historical compatibility DAG handlers remain available for their frozen contracts. The fresh native Proto authoring path is not replaced by a new workflow language. New relaxed/versioned scientific protocol profiles would be a separate explicit change; existing evidence/admission/paired-study rules have not been silently weakened.

The OpenRouter actual-usage versus SDK static-estimate mismatch remains open. Costs must retain their actual/estimated/unknown semantics. No new provider client was introduced to conceal the gap.

This offline evidence verifies integration and preservation. It does not establish learned-model authoring quality, GPU throughput, biological improvement or live fault tolerance of the changed source. No paid validation is included in this implementation.


## Whole-architecture audit clarification — October 11, 2026

The subsequent [whole-harness audit](whole-harness-audit-2026-10-11.md) found that the ownership statements above describe the intended split more strongly than the current implementation supports. Pi computes summaries, but both native auto-compaction and Autofold's host cut/chunk policy remain live. Portable kernel fields are projections; the same scientist.json also retains authoritative request, pending, stop and research registers that cannot yet be reconstructed solely from canonical checkpoints. Database claims/hypotheses/review decisions and the original scientific journal are canonical, while graph retrieval packets and exported views are derivative.

This clarification preserves the implementation's test counts and historical outcomes. The audit reproduced additional admission, cancellation, run-identity and derivative-publication bugs and records their repair criteria; those fixes have not been implemented by the read-only audit. All eighteen prior workspaces and production fingerprints remained unchanged.
