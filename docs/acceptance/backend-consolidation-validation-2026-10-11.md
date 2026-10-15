# Backend consolidation validation — October 11, 2026

**Live acceptance incomplete: provider privacy routing blocked the attempt.** The reviewed source consolidation is applied and offline tests passed, but no live protein-model work ran. Unused one-shot authority is closed, physical shutdown is verified, and the original job remains held for unknown model accounting.

| Observation | Actual result |
| --- | --- |
| TypeScript / worker tests | 555 / 100 passed; two optional skips total |
| Backend / SDK typechecks | Passed |
| OpenRouter model | `deepseek/deepseek-v4.1-flash` |
| Pinned provider | Official `deepseek`, fallback disabled, retries disabled |
| Attempted requests / completed model responses | 1 / 0 |
| GPU dispatches / trials / runs / evaluations | 0 / 0 / 0 / 0 |
| Provider billing | Unknown: no authoritative usage receipt |
| Canonical job | `recovery_required`, `accounting_unresolved` |
| Physical effects | Driver stopped; no remote workers/GPU compute; remote root absent |
| Historical workspaces | 11 exactly preserved |
| Source / worker / frozen helper pins | Unchanged |
| Retry / replacement / crash injection | 0 / 0 / 0 |

OpenRouter returned HTTP 404 with `paid-model-training-violation-by-account`: the account privacy guardrail excluded the only requested endpoint. No account/privacy setting was changed. SDK synthetic zero cost is not authoritative billing; the backend preserved the rejected request as unknown. The error establishes a routing rejection and does not demonstrate a successful LLM or GPU regression check.

Original workspace: `.autofold/backend-consolidation-validation-20261011`; project `prj_backend_consolidation_validation_20261011`; campaign `cmp_1186802c27df4417b7d9636f04a59a04`; experiment `exp_be4e0f759c084e1b833e4567137ba301`; job `job_0e2093b05d6e4ff990acbcd08ff230df`; scientist session `ses_scientist_3da2aaee9f6591242ff6b39e0948444f633d5b9fa00224f06aa554b369496745`.

Launch was authorized at `2026-10-11T16:48:06.824Z`, with original absolute deadline `2026-10-11T17:48:06.824Z`. The driver exited 1 at `16:48:10.945Z`. The one-trial / 600 GPU-second / one-hour / $2 recorded-inference ceiling was not reset or extended. Closing unused authority does not settle the original unknown accounting.

The intended engineering fixture preserves two native CPU/GPU search stages, target, seeds and independent Boltz2/Chai1 final panel, followed by a compute-disabled scientist decision-evidence review. Neither stage nor that review executed in this attempt. No autonomous discovery, optimization gain or biological result is claimed.

Evidence in the workspace's `operator/` includes `preparation.json`, `offline-verification.json`, `launch-fence.json`, `provider-response-1.json`, `discovery-result.json`, `driver-failure.json`, `driver-exit.json`, `held-state-audit.json`, distinct post-failure host observation, `shutdown-evidence.json`, exact source/historical after snapshots, `final-verification.json` and `grant-closeout.json`. No successful receipt or settlement audit was fabricated. A fresh privacy-compatible LLM recipient requires separate human authorization; the failed original identity will not be restarted.

See [the implementation scope](../architecture/backend-consolidation-2026-10-11.md).
