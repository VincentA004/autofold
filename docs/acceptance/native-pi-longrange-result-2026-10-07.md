# Native Pi long-range campaign — October 7, 2026

Status: **settled with incomplete procedural validation**. All eight ordinary discovery trials succeeded. Five of six reserved replay trials executed and succeeded; the sixth was authored and admitted as a proposed trial, but never dispatched. The parent job is terminal `succeeded` with inner result `deferred` at `paired_shadow_replay_requires_attention`; its replay child failed with `ResearchConflictError`. No skill was activated. The grant is closed without retry or extension.

The fresh authorization ran from `2026-10-08T00:53:52.515Z` to terminal settlement at `2026-10-08T02:36:39.430Z`: about 1 hour 43 minutes within the six-hour ceiling. The original deadline was `2026-10-08T06:53:52.515Z`; it was not reset. Four ordinary batches of two ran before refinement. The campaign completed five boundary steps. The allowance was fourteen trials, eight discovery plus six reserved paired replay, $10 recorded completed-response inference, zero automatic online knowledge/review operations and one candidate / 600 GPU-budget seconds / fifteen wall minutes per trial. There was no separate acceptance gate.

## Discovery and empirical continuation

The scientist independently authored native Proto programs, inspected prior receipt-bound outcomes, compared generators/scaffolds, replicated conditions and retained a cyclic incumbent. Lower locked score is better:

| Trial | Intervention | Valid locked score |
| --- | --- | ---: |
| 1 | BoltzGen linear, 20 aa | 0.3374677014 |
| 2 | PXDesign preview linear, 20 aa | 0.3249103454 |
| 3 | BoltzGen cyclic, 20 aa | 0.2220054738 |
| 4 | BoltzGen disulfide beta-hairpin, 20 aa | 0.2384790121 |
| 5 | BoltzGen cyclic replicate | 0.2622717585 |
| 6 | PXDesign linear repeat | 0.3249103454 |
| 7 | BoltzGen linear replicate | 0.2567620327 |
| 8 | BoltzGen cyclic replicate | 0.2208230935 |

The best observed discovery draw was **0.2208230935**, versus the initial draw 0.3374677014. This is a best-of-draws computational result, not a causal method effect. BoltzGen cyclic draws were 0.2220054738, 0.2622717585 and 0.2208230935; linear draws were 0.3374677014 and 0.2567620327. Their spread prevents attributing small one-draw generator/scaffold margins to a reliable improvement. PXDesign repeated the identical candidate and score; two matching fixed-context executions establish observed repeatability, not universal determinism or zero population variance. The previous two-trial run used 12-aa designs; this run used 20-aa designs, so its scores are not a direct comparison to that historical protocol.

Seven scientist interpretations and eight deterministic receipt closeouts committed. These are the scientist's own assessments and durable summaries, not independent reviews. No literature/review jobs, research requests or reviewed claims were produced. Online OKF remained separate and nonblocking. Wiki/advisory lookup under unresolved questions was not exercised. Compaction count was zero; near-native-limit compaction remains untested by this run.

## Procedural feedback and incomplete replay

The refinement agent proposed immutable version 2 of `skill_bionemo.predictor-interpretation`, hash `sha256:abfc21bfaffebf70fd8c5a23b0e80408a6e9aa3a004e3736a98b6c31b4bf9d38`. It used original trajectory references to add within-condition replication, best-of-N, panel diagnostic and locked-score versus candidate-loss guidance. The candidate and parent hashes remain intact. Some candidate wording overgeneralizes deterministic behavior from two identical PXDesign outputs; it is not accepted scientific knowledge.

Each replay arm had a distinct persistent session and immutable program, the same frozen contract, one-candidate budget, 600 GPU-budget seconds and fifteen-minute ceiling. Paired arms were independently authored and did not receive the other arm's result. Five original receipts verified; the third candidate arm has no run or receipt.

| Pair | Parent score | Candidate score | Outcome |
| --- | ---: | ---: | --- |
| 1 | 0.3376344215 | 0.3093752954 | Candidate lower |
| 2 | 0.3478761646 | 0.3656560831 | Candidate higher |
| 3 | 0.2734176709 | — | Candidate not dispatched |

Two pairs completed, with mixed outcomes; the third is incomplete. No replay assessment or activation committed, and the original skill remains active. There is no established procedural improvement or cross-campaign promotion.

## Failure diagnosis

The sixth replay program passed native authoring preflight and was saved as trial `trl_b56fe557cbd8452c8a18531fdd37e2b7`, prepared request/run identity `run_997c69a8b5fd1f6e836c5f4f3840749c4e6e9124128f9ae6095f0db7e8717315`. The durable failure stores only `ResearchConflictError`, losing its structured code/message. Read-only execution of the exact frozen resource summarizer reproduces the strict `beginRun` rejection: after thirteen 600-second allocations, remaining hours are `0.16666666666666652`, below the required `0.16666666666666666`. The difference is approximately 5e-13 seconds. The intended fourteen-trial/8400-second budget had exactly 600 seconds left; floating-point hour arithmetic rejected it.

This code-path attribution is an offline reproduction, not an original captured exception code. The prepared bundle/request exists locally, but there is no durable run, local remote-launch fence, remote directory or remote receipt for that identity. No remote effect is pending. The guard ran before dispatch. Preserve it without retrying, resetting or repairing this terminal run. The next offline repair should use exact or normalized integer-second allocation arithmetic, exercise final-slot and real-overrun boundaries, retain structured conflict codes, and report admitted versus executed counts explicitly. No production implementation changed during settlement.

## Accounting, pins and shutdown

Recorded inference was **$0.58647846**, matching all 86 completed provider response usage records, exclusively Z.AI. Discovery used $0.41567658, refinement $0.00674617 and all six replay-authoring sessions $0.16405571, including the undispatched arm. Failed child costs settled once from original durable baselines. These are recorded estimates, not invoices. Aggregate monitor null-cost/missing-session flags came from payload aliases; actual operation-bound session costs reconcile to the parent result.

Thirteen verified valid executions, zero invalid scored executions and one admitted unexecuted trial are distinct counts. Measured completed execution wall totals **3125.437 seconds**; this is not GPU utilization or GPU billing. Full frozen allocations reserve 7800 GPU-budget seconds across the thirteen executions, although measured execution was shorter.

All successful receipts passed the existing provenance verifier. Source, worker, canonical contract, profile, route, driver, catalog and software/report pins were preserved; all 31 bound historical software artifacts and six skill versions were reverified. The source previously passed 508 product tests, backend/UI typechecks and production build with two documented optional skips; no tests or inference were rerun during settlement.

Remote shutdown inspection found no receipt-bound worker processes or GPU compute processes. GPU utilization was zero; 995 MiB display memory remained, which is not campaign compute. All thirteen remote receipts are `succeeded`, exit code zero and match their local bundle/worker identities. The local driver and sleep inhibitor exited; tool session 19344 ended with code 3, reflecting the deferred inner result. All jobs and sessions are terminal, no live leases or pending tools remain, and the scientist has no pending execution operation.

Evidence: `.autofold/native-pi-longrange-20261007/operator/settlement-audit.json`, preserved `settlement-audit.initial.json`, `admission-diagnosis.json`, `remote-shutdown.json`, `local-shutdown.json`, `unexecuted-effect-reconciliation.json`, `software-artifact-reverification.json` and `grant-closeout.json`. Monitoring is paused after this report. No new model calls, scientific dispatches, retries, source/host edits, commits or pushes occurred during settlement.

## Identity and limitations

Workspace: `/Users/vincentallam/Developer/autofold/.autofold/native-pi-longrange-20261007`; project `prj_native_pi_longrange_20261007`; campaign `cmp_a245128742e14d0091e331159fd82485`; experiment `exp_ee24ba0e0e5c4069a71ad134419ae3a2`; parent job `job_bce9fef9118e406997367d2ca52dbb92`.

Source `sha256:a76a6a6ee214b13361589681bcdaeb6653df7b57104dcff2ac652d3cb8765e5b`; worker `sha256:0164029d60ac557279981f09b9722ab8a81c0a2f5e6b9e5c601f7bd86f2f47dd`; canonical contract `sha256:2d621d31642ea3a965d960bc90473127b56dbccc53befe93aca17a444eceb73b`. Profile and route remain as recorded in launch preparation. OpenRouter `z-ai/glm-5.3-flash` used only `z-ai/fp8`, fallback disabled, parameter compatibility required and SDK retries disabled. Ordinary host maxTokens remained unset. No extra MSA destination or provider recipient was added.

The fixed-seed, single-candidate PD-L1 short-peptide protocol measures computational proxies under a frozen MSA-free Boltz2/Chai1 panel. Upstream generator seed control is unavailable, populations are tiny, predictors are correlated, controls and held-out scoring seeds were absent, and no physical binding assay ran. This establishes sustained autonomous computational continuation and one proposed skill refinement, with incomplete validation. It does not establish full recursive product completion, reproducible method improvement, universal binder workflow quality or biological discovery. Optional models and PXDesign extended external MSA remain uncertified. Cadence/evolution policies, independent online knowledge improvement and long-context compaction remain future work.
