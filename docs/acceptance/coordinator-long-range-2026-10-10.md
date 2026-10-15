# Coordinator long-range assessment — October 10, 2026

Status: **terminal and closed; coordinator execution/settlement verified, with a fixed-construction acceptance gap**. The scientist stopped at **2026-10-10T23:33:54.252Z**, about 1 hour 40 minutes after launch. The sole driver exited 0 at 23:33:55 UTC. No controller crash, restart, duplicate launch or monitor-authored scientific program occurred.

The user selected ceilings of six hours, fourteen trials (eight ordinary discovery plus six protected paired-replay slots), $10 recorded inference, twenty campaign boundaries, batch one and $2 per child. Launch authorization was **2026-10-10T21:53:27.029Z**; the unchanged original deadline was **2026-10-11T03:53:27.029Z** (October 10 22:53:27 America/Chicago). The run stopped early, completed nine boundaries, and left one ordinary slot unused. Closeout revokes all remaining authority without an extension, reset, quota filling or replacement work. All previous grants remain closed. The monitor is paused after final closeout.

Fresh workspace `.autofold/coordinator-long-range-20261010`; project `prj_coordinator_long_range_20261010`; campaign `cmp_976c7ddfdaa7402ca1f6ce98784d4f3f`; experiment `exp_d65e8df3c8414a1abeb47f3af4224ea3`; original parent `job_dee715bef3494b50a6a1501b51383d27`.

## Actual execution and scientific limits

**Thirteen original trials were admitted and executed: seven ordinary admissions (six optimize, one negative control) and six paired-replay admissions. Twelve produced valid evaluations; one negative control failed before scoring. Zero scored evaluations were invalid.** A failed execution with no score is not an invalid scientific measurement. Successful receipts sum to **2,889.241 seconds of run wall time**; this is not measured GPU utilization. Each allocation was one candidate, 600 GPU-budget seconds and fifteen worker wall minutes.

The target, MSA-free Boltz2/Chai1 evaluator, scoring seed 20260809 and recipients remained frozen. Lower locked score is better under this proxy. The best ordinary result was **0.2856429296731949**, sequence **SSVPELKHLSPS**, from the BoltzGen cyclic 12-mer. The baseline was 0.31903638496994974. The following are actual computational observations, not binding or biological validation.

| Order | Comparison | Returned sequence | Locked score | Outcome |
| --- | --- | --- | ---: | --- |
| 1 | BoltzGen linear baseline | SALAEALRALAA | 0.3190363850 | valid |
| 2 | PXDesign linear comparison | EASLERLKALAA | 0.3140863980 | valid |
| 3 | Replay 1: parent | SVYNPIFNKYFG | 0.3205865055 | valid |
| 4 | Replay 1: candidate | EASLERLKALAA | 0.3140863980 | valid |
| 5 | Replay 2: parent | EASLERLKALAA | 0.3140863980 | valid |
| 6 | Replay 2: candidate | EASLERLKALAA | 0.3140863980 | valid |
| 7 | Replay 3: parent | EASLERLKALAA | 0.3140863980 | valid |
| 8 | Replay 3: candidate | MGRFVGDVYLPI | 0.2906372058 | valid |
| 9 | PXDesign replicate | EASLERLKALAA | 0.3140863980 | valid |
| 10 | BoltzGen cyclic 12-mer | SSVPELKHLSPS | 0.2856429297 | valid |
| 11 | Fixed scrambled negative control | no scored candidate | unavailable | failed before scoring |
| 12 | BoltzGen hairpin 12-mer | CGIEFDGYVSSC | 0.3110452862 | valid |
| 13 | BoltzGen cyclic 16-mer | SKTGLVIEVDGVTVTM | 0.3333890535 | valid |

The scientist compared generator families, reproduced the same PXDesign sequence/score, compared scaffolds, and tested a longer cyclic peptide. It also identified a concern that improving aggregate scores tracked developability inputs while Chai1 interface confidence degraded. The attempted composition-matched scramble did not score, so evaluator separation remains untested. One candidate per trial, fixed scoring seed, small sample, uncontrolled upstream generator seeds, repeated candidate sets and no assays prevent claims of biological activity, reproducible method superiority or general scientific improvement.

## Fixed-construction gap and stopping honesty

Original negative-control trial `trl_bc4e0eadefdb41bc8b20b71c9abd64cc`, run `run_0bec38a433e41a91aecfb1050f45bf1a77c83942a283426262b4f4730f0212b4`, failed during generation with `ProtocolError: Fixed Proto construction changed after launch admission`. Its exact remote supervisor is terminal failed/exit 2, with no successful manifest and no score.

The host-admitted `pipeline.staticConstruction` contains `constraintSettings`, while `backend/worker/autofold_worker/adapters/proto.py::_inspect_static_construction` omits that key. `_validate_static_construction` compares the full dictionaries and rejects the admitted fixed construction. This is an admission/worker schema integration gap. The frozen source and original records were preserved; no retry or repair was made during this campaign. See operator `monitor-fixed-construction-failure-2026-10-10T23-16.json` and the original error artifacts. The subsequent generator-backed trial was the native scientist's next comparison, not a monitor-created replacement for the failed identity.

The scientist's final `stop_discovery` reason was `exhausted_host_grants`, but canonical parent accounting retains **one ordinary slot**. Its rationale therefore overstates quota exhaustion. The recorded stop is honored, the discrepancy is preserved, and the unused slot is closed. No result or stop reason was rewritten. One advisory research request records the unresolved static-control/evaluator question; zero research jobs or claims were dispatched automatically.

## Graph, skills and paired decision

Five successful `read_context` calls exposed current-project graph planning evidence, source records, source hashes and repeated candidate identities; all five graph snapshots reported zero issues. There were **zero explicit graph-traversal tool calls**. Four ordinary trials captured **37 graph citations with record/snapshot hashes**. Later generator, repeatability, scaffold/length and advisory decisions cite same-project results. This is observed evidence use; availability and citation do not establish a causal graph benefit without a graph-off control. No historical project was imported.

Skills were supplied through native context and shadow-arm prompts; there were zero explicit `SKILL.md` file reads. Read-only reference tools were called 29 times in isolated shadow sessions. The scientist used immutable v1 guides; refinement was proposed after two ordinary admissions, before ordinary exhaustion.

One interpretation-guide candidate `skv_4008cbe2f80447a89583ee2d384ad639` received three equal-budget parent/candidate comparisons, six original GPU receipts and six independent authoring sessions. Both arms reserved 0.5 GPU-hours in aggregate. All scores were valid; absent one-candidate diversity and disagreement diagnostics remained null. **The strict `paired_valid_v2` policy rejected the guide** with `insufficient_independent_valid_pairs`: one independent valid improved pair and two excluded repeated-candidate pairs. A nominal aggregate improvement did not override candidate uniqueness. The final auditor independently recomputed this exact decision.

Five subsequent ordinary admissions continued under the retained parent guide `skv_a6aac3156c9c412293478c0422ba4897`. No new guide activated. The candidate rejection is a correct policy outcome, not a scientific superiority result.

## Accounting, settlement and preservation

**$0.90681185 recorded inference**, 106 complete actual Z.AI-only responses, eight persisted sessions and 106 settled model requests reconcile to the parent and child aggregates. No recorded request or provider-response billing is unknown; no aborted/dispatched request remains. Model was OpenRouter `z-ai/glm-5.3-flash`, route `provider.only=[z-ai/fp8]`, `allow_fallbacks=false`, `require_parameters=true`, with no provider retries. Recorded usage is not an invoice guarantee. The parent payload's campaign session ID has no persisted SDK session; none was initialized or assigned an invented zero cost. The verified parent cost is its native child aggregate.

All eleven native jobs are outer succeeded; the parent's inner result is stopped/`scientist_stopped`. The one failed scientific run remains failed. All thirteen operation records have settled accounting/settlement axes, and all 38 outbox effects are acknowledged. Eight sessions are completed, native and independent leases are absent, pending tools and scientist operations are clear. No compaction events were recorded.

The driver verified all twelve successful original receipts. The pinned final authoring auditor reverified all twelve, checked ordinary write/edit/evaluate reconstruction, trusted scientific closeout before tool return, isolated `submit_shadow_program` authoring, frozen panel/scoring seeds and strict paired-policy recomputation: **passed, zero issues**. Reopening an original terminal receipt left model requests/jobs/trials/runs unchanged at 106/11/13/13. This is terminal zero-work receipt evidence; no live interruption was tested and no fault-recovery evidence was invented.

The pinned shutdown audit verified all thirteen exact original supervisors terminal, zero receipt-bound remote processes, zero GPU compute processes and zero local driver/caffeinate processes. Physical shutdown and canonical settlement were separately verified. All six prior workspaces match their exact before-snapshots. Production source, worker, route, profile, contract, driver and auditor pins match launch preparation. No commits, pushes, host software edits or server restarts occurred.

Frozen source `sha256:eae26febf1859fb9df60a8941e5c535c089e7eb96c0d53eeaa0c784e6e95a5e0`; worker `sha256:ac5ac96ff3d775cd3b6d82d91ca51e3ca6a34ee995d708e116f6e39254774a90`. The prior 539 TypeScript/71 worker passes and backend typechecks are preserved; no production edits or extra test run were needed for this evidence closeout.

## Acceptance and evidence

Coordinator ordinary continuation, early refinement, isolated paired replay, rejection under uniqueness policy, receipt/accounting settlement and shutdown are live verified. **Full fixed-construction authoring acceptance remains incomplete**, and evaluator separation is unresolved. The stop's quota explanation is also inaccurate. These gaps prevent an unconditional end-to-end acceptance claim even though canonical settlement and authoring/provenance audits passed.

Evidence in `.autofold/coordinator-long-range-20261010/operator`: `settlement-audit.json`, `verified-receipt-RUN.json` for each successful run, `authoring-closeout-audit.json`, `shutdown-evidence.json`, `canonical-after.json`, `engineering-scientific-assessment.json`, `final-verification.json`, `historical-after.json`, `historical-preservation-final.json`, `source-after.json`, `source-preservation-final.json`, `grant-closeout.json` and the distinct fixed-construction failure observation. Original launch, provider-response, session, trial and run evidence remains unchanged. No unresolved canonical effects remain; the advisory question and engineering limitations remain explicitly open.
