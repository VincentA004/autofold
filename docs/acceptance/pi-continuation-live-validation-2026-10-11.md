# Pi continuation live validation — October 11, 2026

Status: **two-iteration native software acceptance passed; canonical and physical effects settled; grant closed**.

The human approved a fresh GPU/LLM validation with at most two trials, one hour, $2 reported inference and no Autofold output-token cap. The separately enforced SDK estimate ceiling was also $2; each trial admitted one final candidate, at most 600 aggregate worker GPU-budget seconds and fifteen worker wall minutes. OpenRouter selected the upstream provider for `deepseek/deepseek-v4.1-flash`. Previously approved model data categories were retained, with a fresh offline 37,690-byte first-request preview. Preparation/preview made no external model request or scientific dispatch. No earlier grant was resumed.

The sole driver launched at `2026-10-12T01:59:34.916Z`, with original deadline `2026-10-12T02:59:34.916Z` (October 11, 9:59:34 PM America/Chicago). It exited zero at `2026-10-12T02:13:32.213Z`. The grant closed after independent shutdown and preservation verification. No extension, retry, replacement dispatch or deliberate crash occurred.

Fresh workspace: `.autofold/pi-continuation-live-validation-20261011`; project `prj_pi_continuation_live_validation_20261011`; campaign `cmp_f5bbe966f4df4915882c1e775f991a01`; experiment `exp_2893275755894fc1b09839900941d0f3`; original parent `job_241c84c114c540ed99d6fb2779317e52`. Scientist session `ses_scientist_504c4bc4ae875557a50a1868f007229245ae2c572a9618968a9948ea13e79dd8` is completed with no pending tools or active independent lease.

## Actual authoring and execution

The scientist authored both programs using Pi write/edit tools. No operator-supplied scientific program was used. Both executed through `native_tool_sequence_v1`: Proto owned generation, constraints and rejection-sampling optimization; the independent frozen PD-L1 evaluator used MSA-free Boltz2 and Chai1 with scoring seed `20260809`.

| Trial | Native search | Selected 16-mer | Valid locked score, minimize | Original run wall seconds |
| --- | --- | --- | ---: | ---: |
| Baseline | Four random-protein proposals; Boltz2 ipTM selection | `GQLPPGAFWASPRLTA` | 0.3161185532808304 | 191.732 |
| Intervention | Four random-protein proposals; equal-weight Boltz2/Chai1 ipTM selection | `SRSVTTRLTVFVHADQ` | 0.31568595990538595 | 358.306 |

Both trials and exact original supervisors succeeded with exit zero and manifests present. There were two distinct authored pipelines, two distinct final canonical sequences, two successful ordinary GPU executions, two valid results and zero invalid results/replay trials. All successful original receipts were independently reverified, including program, model artifact, evaluator, contract and worker provenance.

The intervention references the original baseline run/evaluation/knowledge/search observation, preserves the frozen target, scoring panel, scoring seed and panel size, and changes the selection rule. Its optimizer seed remained unchanged. Native search took 58.9415 seconds and two tool calls for the baseline, then 226.3513 seconds and three tool calls for the intervention. Search wall allocation increased from 240 to 290 seconds, and realized generator seed identity remains unobserved (`stochasticity: unknown`). Equal-compute causal comparison is therefore not established.

The score decreased by 0.0004325934, below the scientist's prospective 0.02 improvement threshold. Predictor agreement decreased from 0.52866 to 0.45378; interface confidence also decreased, while solubility improved. This is not evidence supporting the declared meaningful selection-rule improvement. Two single-candidate fixed-scoring-seed results, uncontrolled generator stochasticity and no assays establish neither general method superiority nor biological validation. No third trial or post-intervention model turn was authorized after the two-evaluation allowance was used.

## Pi lifecycle, repair and billing

There were 42 complete OpenRouter responses, all routed to DigitalOcean. Exact original generation/provider/cost IDs reconcile across response evidence, session ledger, parent result and acceptance report. **Reported inference: $0.125880447; separate SDK estimate: $0.184367172; unknown billing requests: zero.** Both ceilings were respected. These remain distinct accounting axes.

Autofold supplied no `maxTokens` override. The driver preserved Pi's native serialized output sizing, with no substituted cap. The longest completed response used 6,684 output tokens; no response ended with `length`, so native truncation recovery was not triggered live. Scripted offline regressions remain the evidence for reasoning-only compaction/continuation and partial-tool rejection. Model/provider intrinsic limits still apply.

Fifty-nine tools completed: `read_context` 1, `list_files` 1, `read` 33, `search_files` 5, `write` 3, `validate_trial` 3, `evaluate_trial` 2, `review_result` 3, `read_knowledge` 4 and `edit` 4. Four recoverable errors concerned review citations/arguments, a malformed knowledge identity and an exact-text edit mismatch. Pi received feedback, corrected its work and continued; the original errors remain archived. Three program validations passed. Trusted closeout for the first evaluation preceded the second scientific action, and the final evaluation's closeout settled before termination. All autonomous authoring/provenance/chronology acceptance checks passed.

The terminal original-job reopen used throwing model, credential and effect hooks. It made no inference attempt and changed no original job/run/trial/request/session/operation/outbox/launch identity. This was a zero-effect terminal reopen; no live crash or nonterminal receipt recovery was injected or invented.

## Evidence use and remaining limits

Trusted context exposed ten graph nodes, four edges, zero issues and five pinned procedural skill identities. There were no explicit graph retrieval/traversal calls, no `Trial.graphEvidenceUse` entries and no explicit skill-file read/refinement/replay/activation. Declarations cited pinned skill identities, and the later decision did explicitly use current empirical knowledge. Neither exposure nor citation establishes causal graph/skill benefit; there was no graph-off control. No automatic advisory research/review or extra recipient/service was used.

No compaction occurred. Maximum observed prompt size was 285,788 tokens after API/resource retrieval; improved targeted-reading guidance has not solved context overhead. This remains an efficiency concern even though the bounded live gate passed.

The independent archive audit verified 208 exact record digests/byte lengths, including three fragmented records. Jobs, runs, scientist authority, pending tools and independent operation/accounting axes are terminal/settled. Shutdown evidence verifies both receipt-bound supervisors terminal, zero original worker processes, zero GPU compute processes, and zero local Bun/caffeinate. GPU memory residency alone was not treated as live computation. All twenty-three prior workspaces and frozen production/worker/profile/contract/driver/tool pins remained unchanged. Earlier failed acceptance decisions remain preserved. The existing monitor stays paused; no fresh stale monitor was created. All unused time, request and cost authority is closed.

Production source: `sha256:480dfd046b414d28cf8e8d1c6b6e607b7d872c55599a0c1a65375c36b31fdf71`; worker: `sha256:e73a9af0088822fdbe05605e4494ce3bbd269986613758eb670b8d629ed7940f`.

Authoritative evidence: workspace `operator/settlement-audit.json`, `native-acceptance-report.json`, `authoring-closeout-audit.json`, both `verified-receipt-RUN.json`, `terminal-durable-observation.json`, `shutdown-evidence.json`, `engineering-assessment.json`, `final-verification.json` and `grant-closeout.json`.
