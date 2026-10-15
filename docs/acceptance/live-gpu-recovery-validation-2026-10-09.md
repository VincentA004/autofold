# Live GPU recovery validation — October 9, 2026

**Passed one actual native GPU trial on workstation_4090.** BoltzGen generated one 15-residue PD-L1 short-peptide candidate. The frozen MSA-free Boltz2 and Chai1 panel completed both predictions and returned a valid locked score of **0.2659632009** (lower better). Live telemetry observed the RTX 4090 at **99% utilization**, with 5,363 MiB GPU memory in use during the sampled scoring window.

The original run executed for **270.473 wall seconds** (about 4 minutes 30 seconds), including **142.517 seconds** for generation. These are wall times; the trial reserved a maximum 600 GPU-budget seconds, divided into 300 generation, 120 Boltz2 and 180 Chai1 seconds. Total driver/job elapsed time also includes scientist authoring and validation.

Recorded inference was **$0.19307044**, reconciling exactly among the original scientist session, job settlement and 36 upstream response records. Every response identifies OpenRouter model `z-ai/glm-5.3-flash` and provider **Z.AI**. Routing remained `provider.only=[z-ai/fp8]`, `allow_fallbacks=false`, `require_parameters=true`; no automatic provider retry ran. These are recorded inference estimates, not an invoice guarantee.

## Live path and remaining friction

The scientist inspected the frozen target and native API, authored and repaired its own program, validated it, admitted the single trial and invoked the real remote worker. There were **7 validation calls**, including **6 rejected drafts**, before admission. Errors included a missing inspectable workflow, an invalid literal/schema declaration and a redundant native workflow. Standard validation feedback led to repairs; no operator program or replacement trial was supplied. The remaining authoring friction is visible in the saved Pi journal and is separate from the successful worker/job settlement.

An independent read-only audit reconstructed the final program bytes from actual model `write_file`/`edit_file` events and matched the frozen trial hash. The existing execution/provenance verifier reverified every receipt and artifact, including the generated candidate and both prediction structures. The trusted knowledge cycle, search observation and scientist-memory event committed before the evaluation tool returned. The job, run and original session are settled, with no pending tools or active session leases.

SSH initially required a Tailscale authentication check. After the user completed it, current host readiness verified idle GPU compute, pinned host paths and Proto commits, and authoritative absence of the previous fenced run. This directly establishes the access blocker for this validation attempt; it does not retroactively establish the cause of the earlier campaign interruption.

The post-run supervisor reports the same original run succeeded with exit code 0 and the expected bundle/worker hashes. No receipt-bound remote process, GPU compute allocation, local driver or caffeinate inhibitor remained. Source, worker, contract, profile, route and driver pins stayed unchanged. The fresh grant is **closed** without a deadline extension or replacement dispatch. No recurring monitor was enabled.

## Identity and evidence

| Binding | Value |
| --- | --- |
| Project | `prj_gpu_recovery_validation_20261009` |
| Campaign | `cmp_28f2dbe47ef948a3972cdec1c84f75fe` |
| Experiment | `exp_13780f4b74634837b83a4777a798dae7` |
| Job | `job_9bab80dd04874edbb801bc2fc2a16878` |
| Original run | `run_d19461bd37b7d41e795bfaa7a469259f1b036c4dfc772394f5a283ce6e2f6152` |
| Source | `sha256:18b2796dbedfce052a487a2db86087e098f4951c6338af9b5b1fd5d0e6ecda45` |
| Worker | `sha256:0164029d60ac557279981f09b9722ab8a81c0a2f5e6b9e5c601f7bd86f2f47dd` |
| Frozen contract | `sha256:2d621d31642ea3a965d960bc90473127b56dbccc53befe93aca17a444eceb73b` |
| Native program | `sha256:35de3e820039b5ec4f651cbed5f85becd9490dd160053dfd0a6fb601df99ebb4` |
| Bundle | `sha256:ecd4d0a6653e49433a8c3cf12ba7603e591256fa562df98adeef85d4f4539de2` |
| Verified manifest | `sha256:a258991eb9b5f21bd740dfa8dce51ba851ace3f8be88f19b018555a36f49d906` |

Evidence workspace: `.autofold/gpu-recovery-validation-20261009/operator/`. `settlement-audit.json` is the independent receipt/provenance/accounting audit; `live-result.json` is the original driver result; `gpu-active-window.json` contains direct hardware measurements; `shutdown-evidence.json` and `grant-closeout.json` bind resource shutdown and authority closure. `verification-manifest.json` hashes the evidence files. The original expired campaign's canonical records, sessions, operator evidence and dispatch fences remain byte/logically hash-identical; it was neither resumed nor reconciled.

This establishes the rebuilt scientist → real GPU worker → frozen scoring → verified receipt → canonical job/session settlement path for one live trial. It does not establish a long-duration reliability result, cross-project graph benefit, independently replicated method improvement or biological validation. The scoring seed is fixed and the upstream generator seed remains uncontrolled. The earlier 536-test [offline rebuild verification](execution-recovery-rebuild-2026-10-08.md) remains a separate software check.
