# Orchestration layer audit — October 10, 2026

Three GPT-6.1 Sol subagents audited ownership/persistence, execution/receipts and runtime/accounting/auxiliary handlers; root audited campaign grants, integrated the repairs and designed the replacement boundary. Main checkout only. No new Autofold provider request, GPU execution, SSH dispatch, historical session initialization, campaign mutation, commit, push or server restart occurred. The old monitor remains paused.

## Findings and delivery

The main defect pattern was inconsistent authority and durable handoff contracts: a leaf could commit after parent expiry; new admissions and launches did not all require the captured epoch; unclosed provider usage could appear measured zero; result and accounting records could disagree after interruption. Shared ownership inspection, atomic epoch-bound admission, immediate worker/model authorization, durable provider request accounting, terminal remote observation and idempotent scientific finalization now repair those reproduced gaps. Campaign closeout/continuation require all owned children accounted. Worker polling now backs off with visible degraded health; unfinished jobs protect pending draft identity.

See [the complete component map and replacement design](../orchestration-control-plane.md). Detailed audit reports map every ownership/persistence domain and crash window: [ownership](../architecture/orchestration-ownership-audit-2026-10-10.md), [execution](../architecture/orchestration-effects-audit-2026-10-10.md), [runtime](../architecture/orchestration-runtime-audit-2026-10-10.md).

## Final integrated verification

- **508 TypeScript tests passed**, 1 existing optional skip, zero failures, across science-core, engine and UI client.
- **62 worker tests passed**, one existing optional skip, zero failures.
- Both backend typechecks passed; whitespace diff check passed.
- Actual local CPU controller SIGKILL tests ran for parent-selected and child-selected original receipt recovery. Additional deterministic tests cover dead ancestry, captured epoch revocation, cancelled/expired trial admission, provider unknown usage, failed durable usage save, concurrent same-receipt finalization, remote timeout despite a manifest, and degraded HTTP health.
- Four historical workspace snapshots match exactly: the expired Oct8 project graph, completed GPU recovery validation, completed long-run assessment, and recovered October9 backend completion.
- Current worker source is unchanged; only 17 production TypeScript files changed. Before source `sha256:095ad9f9e559fff6afb7dfb7aab4373f4b572697e0e13202ee9513d04bb128a3`; after source `sha256:671b8005c78610b8750f04a4c05b3f01ab259761acadd9a03dc79973304f365a`.

The initial integrated run exposed older fixtures that supplied an existing managed job ID without owner authority, plus a test loaded while provider-boundary integration was changing. Fixtures now claim/pass exact original epochs instead of weakening the production checks. The final run used stable integrated source and passed. Both the initial diagnostic log and final logs are preserved in the new evidence workspace; original acceptance reports are untouched.

## Remaining gaps and acceptance limits

A local finite worker reproduction proves killing its remote supervisor controller can let it exceed the plan timeout while leaving a stale running receipt. This needs process supervision independent of that controller, not another recovery flag. The current generic handler recovery also lacks typed recovery ports for native commits made before final job results. Advisory operation JSON ownership, cancellation versus effect settlement, duplicated manual/automatic planning, hot whole-project ownership reads, original evaluator closure selection and unknown provider billing reconciliation remain explicit design work.

The proposed host operation coordinator owns canonical phase transitions, grant/epoch capabilities, typed handler inspect/recover/run methods and a durable projection outbox. SDK transcripts and JSON views become projections; verified scientific validators and original receipt lineage remain authoritative. Migration is staged and must prove each crash boundary locally. That redesign is documented but **not yet implemented**. This software audit is not a full-layer reliability certification, new GPU grant, biological result, or retroactive pass for the failed October9 acceptance.

Evidence: `.autofold/orchestration-layer-audit-20261010/operator/verification.json`, final test/typecheck/worker logs, before/after source fingerprints and exact historical snapshots. The original valid score 0.26050897359848024 and recorded inference $0.11776617 remain unchanged.
