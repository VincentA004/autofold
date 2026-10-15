# Backend consolidation: default OpenRouter validation — October 11, 2026

**GPU execution and managed scientist authoring/review passed; overall accounting acceptance failed.** The user instructed automatic OpenRouter provider selection. The fresh driver omitted every provider override, retained the default `deepseek/deepseek-v4.1-flash` model and existing account privacy settings, and OpenRouter selected **Decart**. The original provider-blocked attempt remains separately closed and preserved.

| Observation | Actual result |
| --- | --- |
| Successful model responses | 8, all same requested model, routed through Decart |
| GPU dispatches / trials / final evaluations | 1 / 1 / 1 |
| Frozen-panel result | Valid, 0.3445428214967251; matches the earlier fixture result |
| Native search | Two stages, two proposals, two sampling requests, four registered tool requests |
| Native search wall time | 71.676 seconds |
| Final panel | Boltz2 and Chai1, both completed |
| Scientist jobs / sessions | Two succeeded jobs sharing one persisted session |
| Evidence ledger / candidate archive | Both read by the compute-disabled closeout |
| Stop result / receipt reopen | Successful stop returned; original receipt reopened with zero new effects |
| OpenRouter-reported inference cost | $0.03439944 |
| SDK/session/job token-price estimate | $0.06990804 |
| Accounting difference | $0.03550860; original values preserved |
| Independent leases / pending effects | Zero; canonical operation axes settled |
| Shutdown | Original supervisor succeeded/exit0/manifest; no bound workers/GPU compute/local Bun/caffeinate |
| Source / worker / helper pins | Unchanged |
| Historical workspaces | 12 exactly preserved |
| Retry / replacement / deliberate crash | Zero |

The SDK's generic OpenAI-compatible adapter computes `usage.cost` using static model token prices and ignores OpenRouter's response `usage.cost`. Actual default-router provider prices/cache rates differed from that estimate. Every response had known OpenRouter usage and generation identity, while job/session totals correctly agreed with each other under the SDK's estimate. The original driver required provider/session/job totals to agree and therefore saved `settlement-audit.json` with `passed:false`, then exited 1. Successful GPU/scientist behavior does not turn that failed criterion into a pass. The follow-up authoring audit independently passed its declared checks; it does not change the original decision or rewrite original ledgers. GPU monetary cost remains unmetered.

The engineering fixture was copied byte-for-byte through real scientist tools, validated and evaluated once. It used the same frozen target, seeds, two native CPU/GPU search stages and independent final Boltz2/Chai1 scoring as the earlier engineering fixture. No model pin/fallback preference was sent. This establishes bounded live software behavior, not autonomous discovery, biological affinity, objective improvement, causal graph/skill benefit or all-model compatibility. Registered tool requests do not establish physical inference counts or cache origin.

Live context also exposed remaining size overhead: first `read_context` returned about 298 KB of tool-result JSON, `list_files` about 407 KB, and post-result context about 382 KB. These measurements are preserved in `authoring-closeout-audit.json`; compact views remain a separate improvement. No source was changed during the run.

Original workspace: `.autofold/backend-consolidation-default-validation-20261011`; project `prj_backend_consolidation_default_validation_20261011`; campaign `cmp_d42abaaaf5b84d5885bcb21f325b15de`; experiment `exp_5319762b3f4a43f19d7388c390f2ddcd`; first scientist job `job_f5e1924cac3d40718a864342d83adabd`; compute-disabled review job `job_4074b91b50094c30a8b6841053a46ffe`.

Original run `run_1565c74c190895d4f4baeb441519dda7606dffff938c2a60df53085c2fdd479c`; trial `trl_a8d2391392fa44778b9d8bedcddcca10`; evaluation `evl_3d0d630ec9bd42e4a9c73ad6bb514dfb`. Launch `2026-10-11T17:01:06.575Z`; original absolute deadline `2026-10-11T18:01:06.576Z`. Limits were one trial, 600 GPU seconds, 15 worker wall minutes, one overall hour and $2 recorded inference. No deadline reset/extension occurred, and unused authority is closed. The previous heartbeat remains paused.

The operator directory contains preparation, human grant, route-request audit, eight provider response identities/usage, exact fixture, original dispatch/verified receipt, succeeded job results, session/journal snapshots, immutable failed settlement audit, zero-effect reopen, separate authoring audit, shutdown proof, after/source/historical snapshots, final verification, engineering assessment and grant closeout. The source/worker pins match [the consolidation](../architecture/backend-consolidation-2026-10-11.md). [The first routing rejection](backend-consolidation-validation-2026-10-11.md) is preserved with unknown billing and zero GPU work; these grants and accounting records are not combined or resumed.
