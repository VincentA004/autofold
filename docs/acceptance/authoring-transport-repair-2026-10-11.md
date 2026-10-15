# Offline authoring and transport repair — October 11, 2026

The closed trimmed-architecture campaign failed before any GPU dispatch. Its launcher copied only part of the transport interface and dropped exact generator-spec preflight. Separate scientist drafts omitted a constraint, guessed an invalid config import and supplied an incomplete decision plan. The original acceptance remains failed; its driver, auditors, journals, costs and closed grant are preserved.

The backend now accepts an absolute `execution.authorization.deadlineMs`, applies deadline enforcement centrally and freezes the earliest host/job/operation deadline in immutable process intent. The transport decorator forwards optional exact-spec and capability methods, preserves the original receiver, and retains additional methods without hand-copying an interface. It checks authority immediately before and after first-launch authorization, while permitting original receipt observation after expiry. Future launchers must pass the original full transport directly and supply the original deadline through authorization. The historical broken driver remains frozen and must not be reused.

The scientist receives a read-only `DECISION_PLAN.schema.json` generated from the actual admission schema, a compact `read_context.authoring` pointer and complete-read instructions. Guidance distinguishes validation from evaluation, documents the constraint requirement for RejectionSamplingOptimizer and points to pinned module/config schemas. Typed missing transport and host-capability failures return `category=host_configuration` with host/override guidance; authored code or declaration errors retain program repair feedback. Strict admission, evidence checks and authoring limits are unchanged. JSON Schema does not represent all semantic refinements; admission still enforces unique/selected alternatives, evidence scope and compute bounds.

Use the backend grant rather than reconstructing a transport:

```ts
const app = new Application({
  workspace,
  execution: {
    ...hostExecution,
    transport: originalTransport,
    authorization: {
      ...hostExecution.authorization,
      deadlineMs: Math.min(originalGrant.deadlineMs,
        hostExecution.authorization?.deadlineMs ?? originalGrant.deadlineMs),
    },
  },
})
```

Offline verification: **567 distinct tests passed, one skipped**, plus backend and SDK typechecks. The tests cover frozen/private-receiver transports, exact remote generator-spec inspection using a local parser fixture, late-launch expiry, immutable deadline/terminal receipt reopening, scientist schema/feedback and native CPU authoring/evaluation. The new schema test initially truncated a paginated read; its corrected full-read regression passed and both logs are retained.

All **14 prior workspaces** matched exact before/after snapshots. Worker bytes and historical driver/auditor pins are unchanged. There were zero new paid inference calls, GPU runs or production campaign jobs/runs/trials, and no new grant or old campaign resumption. Monitoring remains paused.

These tests establish the interface and validation repair, not successful autonomous authoring or live scientific improvement. A fresh short LLM/GPU validation remains necessary before claiming long-range acceptance. The separate static SDK estimate versus actual OpenRouter billing gap remains open.

Evidence: `.autofold/authoring-transport-repair-20261011/operator/verification.json`, source-change hashes, exact historical snapshots and retained test/typecheck logs.
