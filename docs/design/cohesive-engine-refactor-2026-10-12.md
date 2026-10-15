# Cohesive engine refactor regression record

This records the systematic implementation after the first failure-settlement and shared-authoring slices. The governing design is [cohesive-engine-design-2026-10-12.md](cohesive-engine-design-2026-10-12.md). Each production stage is gated before the next stage starts.

## Preservation and execution scope

The pre-refactor snapshot at `.autofold/cohesive-engine-refactor-20261012/operator/historical-before.json` covers 65 existing scientific workspace roots, 50,479 files and 61 logical SQLite databases. This includes both earlier live-validation roots. New test workspaces and dependency forks are isolated; the original worker trees, source profiles, journals, grants and receipts remain evidence.

Each implementation stage uses offline CPU regression fixtures. After the final gate and user-requested pause, the user resumed a new isolated bounded GPU validation of the adopted engine. The earlier bounded GPU validation remains a separate historical result. Its lost provider response still has unknown billing; this refactor neither resolves that bill nor reopens that grant.

## Stage 3: deterministic evidence closeout

Fresh verified terminal receipts commit run, evaluation, factual observation and deterministic incumbent changes in the existing transaction. Projection tasks use the existing operation outbox. New journal exports can be rebuilt from verified canonical observations. Fresh execution no longer constructs literature cycles, hypotheses, confidence or automatic questions just to record a receipt.

Scientist delivery, native feedback, acceptance and projection recovery consume the direct observation identity and commit hash. Historical v1 cycle and journal repair remains an explicit receipt-only path. Legacy compatibility fixtures instantiate separate historical snapshots, rather than exercising the retired fresh ingestion builder.

Regression gate: all 495 engine tests passed across the affected and remaining files, including cold reruns of the five corrected assertions for the new closeout contract; 220 core tests passed, one skipped. The skip is the existing real legacy SQLite snapshot fixture. Backend, workspace and plugin typechecks passed. CPU worker tests require macOS process-identity access to `sysctl kern.boottime`; sandbox-denied attempts are recorded separately from the permitted regression run.

## Stage 4: scoped decision memory

Discovery, refinement, campaign planning and frozen replay now consume one scoped decision packet. Evidence, interpretation and guidance have independent source revisions. Selection bounds raw receipt reads before I/O; verified canonical scores and diagnostics remain visible when raw artifacts are unavailable or not selected. Qualification, invalid outcomes, failures, contradictory interpretation and original question revisions remain explicit.

Full source manifests and question records remain expansion artifacts. Replay captures the original journal before its canonical snapshot, binds immutable expansion hashes and supplies only its assigned guide. Opening context bounds question, replication and reference previews. Admission records opening-packet exposure; manifest integrity checks do not claim that expanded source contents were delivered.

Read-only scientist and graph access creates no authority or model effects. Owner initialization explicitly promotes an ephemeral read scope, including concurrent read/init. Campaign observation uses one canonical snapshot and read-only policy projections.

Independent regression gate: 238 core tests passed, one existing legacy-snapshot fixture skipped. All 504 engine tests across 53 files are covered passing: the initial full run passed 502, then the complete 45-test jobs suite passed after two stale fixture callbacks were migrated from removed history aliases. Production needed no change for those callbacks. Backend typechecks passed. In the independent 105-run fixture, preparation verified 24 raw receipts in about 38 ms and delivered 42,026 bytes. All 65 baseline roots, 50,479 files and 61 logical databases match exactly.

## Stage 5: shared Pi session hosting and native context recovery

Discovery, replay, refinement, literature and knowledge review now use one session host for original identity, model selection, live request/tool gates, cancellation and cumulative allowance. Fresh bindings and baselines live beside existing controller progress. Historical scalar baselines remain read-only inputs; missing original provider-request attribution stays unknown. Receipt-only opening repairs the original SDK protocol without creating a session or replaying a scientific effect.

Pi native hooks retain argument mutations, blocks and final result/error overrides. Tool admission is charged durably before invocation, including parallel batches. Original normalized tool messages remain in Pi; large projections provide bounded session/entry/call/hash references and exact UTF-8 pages. Original artifacts and after-hook images survive native compaction and SQLite reopening.

Fresh generated host prompts receive native origin tags. Untagged historical messages remain exact human instructions. Chronological exact instructions and host/tool declarations are protected through native cuts, host transforms and final provider-payload conversion. In-place payload mutations cannot claim unseen evidence. Exposure confirms only the actual settled ordinary input; summaries, unknown usage, cards and blind same-batch reads do not confirm packet delivery. Fresh replay uses that same actual-input acknowledgement.

Independent regression gate: all 532 engine tests across 55 files are covered passing. The initial full run passed 530; the complete 58-test scientist suite and 126-test runtime suite passed after two test-only repairs. The scientist fixture now pages its original context rather than assuming inline delivery. The overflow fixture orders its retry timestamp after the native checkpoint, retaining and strengthening the exact one-compaction/one-retry proof. These repairs required no production changes. All workspace and final backend typechecks passed. The unchanged worker baseline passed 118 tests, one optional fixture skipped. All 65 original roots, 50,479 files and 61 logical databases still match exactly.

## Stage 6: explicit native execution and original request recovery

Fresh Proto trials declare host-inspected native search or fixed control. One common execution descriptor binds the native graph, explicit outputs, executing worker and resource ceilings for both CPU and scientific scoring runs. The frozen scoring pipeline contains independent evaluation only. Fresh execution rejects historical builders, extraction hooks, diagnostic DAGs and generator allocations; the replaced executor is an explicit compatibility adapter.

Candidate pool size is independent of final evaluator Top N. Reservations use the actual candidate/model/seed census. CPU search wall time, overall worker wall time and reserved learned compute have distinct fields: a 30-second CPU search plus 600 seconds of frozen scoring reservations fits a 900-second worker ceiling and a 600-second compute grant. These quantities do not establish measured physical GPU consumption. Fresh deadlines cannot be swallowed by ordinary native exception handling or extended by rounding a remaining fractional allowance.

Existing immutable requests recover their own program, bundle, worker, evaluator, target structure, runtime and remote profile. Host upgrades do not reconstruct or redirect those requests through current defaults. Current grants, cancellation, deadlines and original dispatch fences still govern a first launch; verified receipt reopening creates no replacement effect.

Independent regression gate: all 533 engine tests across 55 files are covered passing. The initial full run passed 524; the complete 12-test feedback suite passed after its construction double acquired the explicit native admission marker. Only that fixture and its explanatory comment changed; feedback assertions and production admission remained intact. The full core suite passed 242 tests, with the existing optional legacy SQLite snapshot fixture skipped. The full worker suite passed 136 tests without skips. All workspace and final backend typechecks passed. All 65 original roots, 50,479 files and 61 logical databases match exactly. Logs and source inventories are preserved under `operator/gates/stage6` in the isolated refactor workspace.

## Stage 7: native scoped lifecycle and portfolio ownership

Fresh workers now consume actual scoped Proto sampling/request APIs, native construction guards and a continuous hosted process fence. Native PortfolioProgram owns one canonical lane graph and rejects shared mutable optimizers, constructs, segments, generators and constraints. The former frame/global observation implementation and worker portfolio executor are explicit historical compatibility modules. Native optimizer settings and seeds remain intact.

Frozen measurements retain paired request and parent identities, actual cache origins and original input/configuration hashes. Their deadline covers the entire cold call and native result serialization. Before-call journals retain unresolved effects if terminal publication is lost. Captured JSON leaves the observation scope only after native histories and artifacts are materialized; the unobserved process fence remains closed until child exit.

Independent regression gate: the full engine suite passed all 537 tests across 56 files, with zero failures. The full core suite passed 242 tests with the existing optional legacy SQLite snapshot skipped. The full worker suite passed 144 tests without skips. All workspace typechecks and seven frontend client tests passed. All 43 actual V4 lifecycle conformance tests passed, and original/fork optimizer outputs match exactly across three seeds and two stages. The first root worker invocation omitted the fork from PYTHONPATH and failed to import its new APIs; the complete corrected invocation passed without source changes. All 252 source files in the cold-gate inventory remained unchanged. Logs and hashes are preserved under `operator/gates/stage7` in the isolated refactor workspace.

The user-requested pause was honored, then explicitly revoked before the fresh bounded GPU run below.

## Final bounded live GPU validation

The live run used the exact tested engine and worker, a separately verified V4 dependency checkout on `workstation_4090`, the original PD-L1 target bytes, two native search candidates, one seed, frozen Boltz2/Chai1 settings and evaluator Top-N one. The original authority allowed one GPU trial, 600 seconds of reserved learned compute and a 900-second absolute wall deadline. No provider calls or paid inference were allowed.

The CPU prerequisite first exposed validation-driver workspace initialization and declaration-text errors, plus an unavailable local macOS containment probe. Both rejected prerequisite workspaces were archived after read-only SQLite censuses proved zero trials/runs/effects. The driver was corrected without changing production admission, identity checks or budgets. Real Linux bubblewrap inspection and local CPU execution then verified an unchanged two-sequence control pool, zero native search requests and receipt-only reopening with zero effects. The exact prospective GPU program also passed contained construction against the frozen target before launch.

The original GPU run completed in 285.806 seconds. Native search observed four proposals, two sampling calls and two registered search calls. Both distinct candidates received Boltz2 and Chai1 scoring: four completed registered measurements with actual `cache_disabled` origins. Whole measurement wall times were 37.62, 42.65, 84.78 and 87.46 seconds, all within their respective 120/180-second ceilings. Their sum, 252.51 seconds, is invocation wall time rather than measured GPU consumption. The final pool remained two, evaluator submission remained one, and evaluation was valid. Native histories, metrics, structures and paired request evidence were retained.

All 15 functional receipt checks passed. Reopening the original request invoked zero model, inspection, transport or scientific work and preserved canonical state plus original intent/dispatch hashes. The original supervisor returned success/exit zero. The passive observer tracked stable boot/PID/start-time identities through descendant exit; its final snapshot found no surviving tracked processes or compute processes and the original idle baseline of 0% utilization/989 MiB. The observer was stopped by its exact original identity.

CUDA activity is corroborated by NVIDIA-reported process IDs belonging to the tracked trial ancestry and aggregate utilization reaching 100%. Per-process memory and SM utilization were unavailable on this WSL2 host. [NVIDIA documents limited NVML query support under WSL2](https://docs.nvidia.com/cuda/wsl-user-guide/index.html#features-not-yet-supported). The original strict driver result remains `passed: false`; the final qualified status is `completed_with_telemetry_limitation`, with `functionalPassed: true` and `strictPerPidSmVerified: false`. No exact physical GPU execution count or GPU-seconds claim is made, and no replacement trial was launched to alter that result.

All 65 historical roots, 50,479 files and 61 logical SQLite databases match the original snapshot after the run. The 6,755-file V1/V2 source/evidence snapshot and V3/V4 package identities remain unchanged, and all 252 cold-gate source files still match. The existing unknown provider bill remains unresolved. This run validates engineering integration, not biological improvement or discovery acceleration.

The final report is `.autofold/cohesive-engine-refactor-20261012/final-gpu-validation/operator/validation-summary.json`; raw model receipts, telemetry, canonical reopen proof, supervisor receipt and preservation proofs remain alongside it. Historical pause and preparation records are preserved.

## SDK boundary

Default SDK and `v2` imports now expose generated clients/types only. The historical launcher and combined client/server helper moved to explicit `legacy` exports; their old default and `server` export paths were removed. The example connects to an existing API server. Building compiles checked-in contracts, removing the dependency on the deleted backend CLI and the unused codegen package (44 obsolete lockfile entries retired).

SDK typecheck/build, frontend workspace/UI typechecks and plugin typecheck passed. Browser builds of both default entry points passed without importing the process launcher. Explicit client/legacy import checks passed without starting a process. Generated client contracts were retained.

## Reproducible Proto dependency seam

The original pinned upstream source had no scoped sampling/request lifecycle or native portfolio API. The adopted Autofold-maintained V4 fork is reproducible from original base commits using [versioned patch preparation](../../tooling/upstream/proto-lifecycle/v4/README.md). Original dependency sources and V1–V3 source/evidence remain unchanged.

The V4 fork passes 43 CPU conformance tests, exact clean-commit reproduction and original-versus-fork optimizer parity across three seeds and two native stages. Its language commit is `c8283f53bd22b99c5e5594eb8d4a6df775b87294`; its tools commit is `eb3898a9376287c0839252f3c8e8a13fd3019fa1`. Managed observation publication failures preserve the original native exception, cancel shared authority and prevent sibling portfolio lanes from starting. Scoped thread propagation, cache origins, retries and cancellation remain separate from physical inference or GPU measurements.

Engine and worker adoption followed the passed stage 6 gate. Full upstream pytest, Ruff and mypy suites were unavailable in the existing Python environment; the stated upstream checks ran through the actual fork's direct CPU conformance runner.

Stage 7 preservation check: all 65 baseline roots, 50,479 files and 61 logical databases match exactly. All 6,755 files in the V1/V2 source/evidence snapshot also match exactly; V3 package identities match its final manifest. See `.autofold/cohesive-engine-refactor-20261012/operator/historical-stage7-comparison.json`.
