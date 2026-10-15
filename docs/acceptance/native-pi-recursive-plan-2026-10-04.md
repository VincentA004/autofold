# Recursive campaign preparation — October 4, 2026

## Final settlement — native gate failed

The run settled October 4 at 23:47:23 UTC after **two failed generation attempts**, with no scored evaluation or candidate panel. The gate job `job_0496ad4f1da640b1ad78ff7d0735d0f3` has outer status `succeeded` because it reached its two-trial iteration limit; the native acceptance report is `incomplete` and **not accepted**. The driver exited 2 and admitted no extended campaign job. Six additional ordinary and six reserved paired replay slots remain unused. Monitoring is paused.

| Trial | Outcome | Measured worker wall time |
| --- | --- | --- |
| `trl_6eda3f54561c42e698c91cc9f6ed5f6e` | BoltzGen rejected the binding specification: `Specified end 115,121,123,124,125 is higher than the length of the chain.` Generation failed before a locked scoring panel. | 12.250 s |
| `trl_b71f90e1f18144349efe9658d008810b` | Agent switched to the registered PxDesign lane, but execution failed because `pxdesign` was absent from the selected GPU environment. | 6.812 s |

Recorded completed-response inference was **$0.32459202** across 60 model turns and 83 tool calls in the persistent scientist session. This is an estimate, not an invoice. Total measured worker wall time was **19.062 seconds**, not measured GPU utilization or a GPU bill. There were zero valid scores and zero scored invalid evaluations; these were generation failures.

Read-only audit confirmed both original remote receipts terminal `failed`, exit 2, with matching run/bundle/worker identities. Local bundle/program bytes, agent tool authorship, durable original cost baselines/settlement and two admitted trials verified. Exactly one trusted failure closeout per run persisted before the next action. Source, worker, scientific contract, profile, driver and provider-route pins remained unchanged. All jobs and sessions are terminal, and scientist pending evaluation/operation are null. No remote effects remain unresolved.

The scientist consumed the first committed failure, recorded a prospective alternative and autonomously authored the second program. Its first failure feedback exposed a generic subprocess exit error rather than the actionable remote parser traceback; it described that failure as undiagnosed and changed generator lanes. Two deterministic failure closeouts, two search observations and two unresolved workflow hypotheses persisted. No independent knowledge synthesis/review, external source records, claims, immutable skill candidates, paired replay trials or guidance promotion occurred. Five bundled skill versions remain. Two native feedback checkpoints exist, but they do not establish learned procedural improvement. Compaction count was zero. The repaired knowledge/accounting infrastructure passed offline tests, but native recursive improvement remains unproven.

Before another authorized attempt, address the capability and diagnostic gaps: expose only generator lanes available in the selected host profile; validate the actual BoltzGen specification against its target mapping before consuming an empirical slot; and retain attributable remote failure logs in scientist-readable evidence. This diagnosis is not an authorization to install dependencies, alter the frozen profile, retry either failed run or launch a replacement campaign.

Evidence: `operator/settlement-audit.json`, `settlement-snapshot.json`, original `acceptance-summary.json` and its immutable acceptance report, `authorization.json`, `launch-fence.json`, route observations and both remote receipt/log observations. No successful scientific receipt exists to verify with the successful-result verifier; failed remote identities were independently compared with their original launch fences and local bundle hashes instead.

## GPU host software readiness — October 4, 2026

The required protein-workflow environments are provisioned on `workstation_4090`: BoltzGen, PXDesign preview, RFdiffusion3/ProteinMPNN generation and the fixed Boltz2/Chai1 scoring panel. PXDesign's isolated environment, checkpoints, AF2/MPNN weights and CCD files already existed; it was missing execution wiring and had dependency inconsistencies. The repair installs `immutabledict==4.2.1`, selects compatible `chex==0.1.87`, compiles missing TMalign from pinned official USalign source, and installs an env-local launcher that selects CUDA and existing tool weights. Proto now has `openpyxl==3.1.5` and supported `biotite==1.1.0`; ProteinMPNN uses compatible Chex with its existing JAX 0.5.3.

Use `.autofold/host-software-readiness-20261004/execution-config.json` for a future authorized run. It selects both external generators without changing the historical frozen profile, target, evaluator, seed or scientific ceilings. Verify readiness with:

```sh
bun run tooling/script/execution-preflight.ts \
  --execution-config .autofold/host-software-readiness-20261004/execution-config.json \
  --require-generator boltzgen-binder --require-generator pxdesign-binder
```

Deep imports, dependency checks, compilers, 26 hashed PXDesign assets and 22 archive CRC checks passed. Tiny GPU tensor/kernel checks passed in all six required model environments. The fixed Chai environment preserves the upstream Triton workaround: its TorchScript/direct-Triton path passes, while unused `torch.compile` fails an AttrsDescriptor import; both the failure and successful native-path checks are retained. Boltz2's documented Triton metadata mismatch is also retained, with compiled CUDA arithmetic passing. These runtime checks do not load protein models or score candidates.

The native PXDesign converter is now checked automatically before trial admission. It uses author residue IDs, whereas BoltzGen uses parsed-chain positions. Both original failed programs still reject their out-of-range hotspots before consuming a slot; separate valid BoltzGen and PXDesign input controls pass. No remapping or operator-authored scientific program was substituted. The final product suite passed **481 tests** (160 science-core, 255 engine, 62 worker, 4 UI), backend/UI typechecks and build. One optional legacy test and one system-Python native test were skipped; all 14 worker spec tests pass under installed Proto. Source/worker fingerprints stayed unchanged during final verification.

Evidence and installed versions/hashes: `.autofold/host-software-readiness-20261004/operator/verification-audit.json`. No campaign LLM inference, protein model execution, scientific trial, restart or replacement job occurred. Monitoring remains paused. The optional registered model catalog is not wholly installed or certified. PXDesign extended can require an external MSA service for uncached targets; that service was not exercised. A fresh authorized native gate remains necessary to establish model execution and time-budget fit.

## Zero-inference readiness repair — October 4, 2026

This earlier checkpoint used the historical profile without PXDesign. The new software profile above governs future readiness; the failed campaign remains unchanged.

The selected host runtime and frozen Proto checkout pins are checked before native scientific agent inference. Scientist context separates registered, available, unavailable and unverified generator lanes. Selected external executable overrides are checked again for every captured generator instance before trial admission. Missing optional PxDesign does not disable BoltzGen.

The validator uses the same exact target PDB and spec renderer as execution. It validates the actual native graph, including programs whose workflow metadata omits generation. BoltzGen additionally runs its installed native parser with existing canonical molecule assets, CPU/offline settings and a bounded timeout. No generator, weights, scoring model or Pi request runs. Hotspots are checked against native parsed-chain positions; comma lists remain valid and no remapping is invented. Raw target/spec bytes stay internal; public inspection returns a compact hash report. Generator failures retain bounded real stderr.

The final source was checked against three unchanged archived agent programs on `workstation_4090`: the original invalid BoltzGen hotspots were rejected before admission, the original PxDesign program was rejected as unavailable, and a previously accepted BoltzGen program passed its installed native parser. These checks consumed **zero model inference, zero scientific dispatches and zero new trial slots**. Explicitly requiring PxDesign in the readiness CLI also failed before inference. Other model-backed registered lanes remain unverified by path-only inventory.

Run host readiness before authoring with:

```sh
bun run tooling/script/execution-preflight.ts \
  --execution-config .autofold/native-pi-acceptance/execution-config.json \
  --require-generator boltzgen-binder
```

Evidence is in `.autofold/preflight-readiness-20261004/operator/verification-audit.json` and its hash-bound reports. The frozen scientific contract, target, evaluator, scoring seed and execution profile are unchanged. The source/worker repairs require a fresh source-bound acceptance gate for any future authorized run; parser success does not establish scientific or recursive acceptance. The previous campaign stays terminal and monitoring stays paused.

Final repair verification: Main now includes automatic host readiness before scientific agent inference, selected generator availability checks and exact design-spec validation before trial admission, plus bounded actionable generator stderr. The final product check passed **478 tests** (160 science-core, 254 engine, 60 worker, 4 UI), one optional legacy skip and one system-Python native skip, backend/UI typechecks and the production UI build. All 12 design-spec worker tests also passed under the installed Proto interpreter, covering the native test skipped by system Python. Source and worker fingerprints stayed unchanged through verification. The typed knowledge handoff, receipt-bound reconciliation and failed-child accounting repairs remain in place.

## Preserved preparation and launch record

The following records describe the preparation and initial launch. The terminal settlement above governs current status.


The knowledge handoff and failed-child accounting repairs are implemented in the main checkout. The user approved launch of the recommended fresh six-hour campaign, which started October 4 at 23:33:30.183 UTC. The scientist was active in the two-trial unchanged-source native gate, which subsequently failed as recorded above. Campaign `cmp_01d293a2569349fa8ebc6dfe1bffb822`, experiment `exp_a1b2535450624dcab7721be7bd162f52`, gate job `job_0496ad4f1da640b1ad78ff7d0735d0f3`. The absolute deadline is October 5 at 05:33:30.183 UTC (12:33 AM Chicago). The previous campaign remains settled under its expired authorization and will not be resumed or extended.

## What changed

The literature agent receives the complete typed `submit_review` schema. Trusted result closeouts project canonical internal questions whose origin is checked against persisted measurements and cycles. Internal reconciliation can use zero external sources, but must read original evidence and commit a revision-bound assessment through the host. The host freezes original measurement/outcome hashes and verifies scope, contracts and cancellation before atomic ingestion. External literature questions still require applicable fetched sources. One persisted corrective continuation follows a plain prose completion within the same cumulative turn, tool, cost and deadline limits.

Generic closeout questions remain visible to the scientist. They do not force a literature interruption after every new receipt. The first semantic reconciliation, explicit research dependencies and scheduled semantic reviews still require the knowledge path. Routine deterministic closeout does not count as an independent review.

All child kinds now have original durable usage baselines and immutable per-lease settlements. Failed or cancelled children charge completed-response inference and actual admitted trials. Recovery and continuation re-audit child ledgers without double counting or refreshing consumed grants. Refinement and every paired replay arm use their actual session identities. Missing or reset accounting fails closed; inspection creates no session. Read-only verification recovered the previous failed literature child's exact $0.00451251 cost without altering historical records.

## Verification

`npm run check:product` passed **459 tests**: 160 science-core, 246 engine, 49 worker and 4 UI client. One optional legacy test was skipped. Backend and UI typechecks and the production UI build passed. Production source stayed unchanged before and after this successful check.

The new integration test executes six real CPU mock-worker receipts, reconciles original results through the actual typed Pi literature tool, and resumes two discovery batches on the same scientist session. It verifies durable answered questions before continuation, one semantic refresh, visible subsequent questions, aggregate cost accounting and no duplicate dispatch after parent replay. Scripted agents and CPU fixture scores establish infrastructure behavior only.

The separate operator driver passed TypeScript checking and read-only preflight. Installed Pi direct and simple adapter mock-transport checks passed with zero real provider calls. Host ordinary response maxTokens remains unset. Pi's simple adapter supplies native model output metadata (943717), while the selected endpoint advertises 131072 completion tokens; neither is an application 4096-token cap. The host route is OpenRouter `z-ai/glm-5.3-flash`, pinned to `z-ai/fp8`, with fallback disabled and required parameters enabled.

| Frozen item | Identity |
| --- | --- |
| Production source | `sha256:a271f32dbaa30db96d45ae056f1f26384abb557f5371880b117a5e02b0476d78` |
| Worker | `sha256:1852502ec4d529499bc1b79483e424401fdcbbe74586e698075da78a4d57bc98` |
| Scientific contract | `sha256:2d621d31642ea3a965d960bc90473127b56dbccc53befe93aca17a444eceb73b` |
| Execution profile | `sha256:12613ea5bc296e936942425d70b8f37bc80982c615365b2de7d1e056dab879d6` |
| Provider route callback | `sha256:312c98c7fdc05fded5ed89fac23314b6953fd2121bd3496f22e7afce89758a38` |

The contract fingerprint is its canonical domain hash; preparation separately pins the contract file bytes. No scientific target, scoring rule, evaluator or scoring seed changed in this repair.

## Concrete fresh-run plan

The user approved the recommended plan; the smaller alternative is preserved as preparation context:

| Plan | Host duration ceiling | Recorded inference allowance | GPU trials including gate |
| --- | --- | --- | --- |
| Recommended | 6 hours | $10 ($1.80 gate, $8.20 campaign) | 14: 8 ordinary, 6 reserved replay |
| Smaller | 3 hours | $5 ($1 gate, $4 campaign) | 10: 4 ordinary, 6 reserved replay |

The unchanged-source two-trial native gate counts against the ordinary allowance. Only a passing, fully settled gate admits the campaign. Discovery batches are two, with at most 20 boundary steps and four knowledge refreshes. Each child receives at most $2 and the remaining parent allowance. Per-trial limits remain 600 GPU seconds and 15 wall minutes. These are recorded completed-response inference guards; an in-flight provider response can cross its remaining allowance, and estimates are not invoices.

The fresh deadline is anchored once at launch within the selected duration. An exclusive launch fence prevents another driver from relaunching the same workspace. No retries, replacement dispatches, operator-authored trial programs, source/profile/route edits, contract changes, budget extensions, commits, pushes or server restarts are authorized by monitoring. Uncertain remote effects must reconcile their existing identities.

Scientific continuation must follow actual empirical feedback. Independent literature review must preserve original-source attribution and remaining gaps. Repeated method evidence may justify an immutable skill candidate and equal-budget independent baseline/candidate replay. Unused replay slots are acceptable if evidence does not justify refinement. A successful job, a lower score or completed quotas do not establish the full three-layer product.

Compaction is enabled near the selected native context limit. It has offline coverage; the prior short run did not exercise it. Single scoring seed and unavailable upstream generator seed control still limit causal and reproducibility claims. No biological validation is established.

## Evidence and launch status

Prepared workspace: `/Users/vincentallam/Developer/autofold/.autofold/native-pi-recursive-20261004`, project `prj_native_pi_recursive_20261004`. Campaign, experiment and gate job IDs are recorded above; a later campaign-loop job is created only after a passing, settled native gate. `operator/preparation.json`, `product-check.log`, `preflight.json`, `prior-settled-snapshot.json` and archived driver/route sources preserve the preparation.

The driver `/private/tmp/autofold-recursive-campaign-20261004.ts` accepts `--preflight-only`, or an explicit fresh human-selected grant with `--grant`. There is no default spending grant. The heartbeat was active during the run and is now paused after verified failure settlement. The caffeinate-inhibited driver is tool session 23723, with log `/private/tmp/autofold-recursive-campaign-20261004.log`. `operator/fresh-human-grant.json`, `launch-fence.json`, `authorization.json`, `gate-job.json`, `route-latest.json` and `heartbeat.json` preserve actual launch authority and observation.

The previous campaign's final receipts and failed knowledge child remain preserved in [the discovery settlement](native-pi-discovery-plan-2026-10-03.md). Fresh repaired-source acceptance and a complete native recursive knowledge/procedural cycle remain outstanding.
