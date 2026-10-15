> Historical design for the preserved OpenScience implementation. See [README.md](README.md) for the active Pi backend and current migration boundaries.

# Autofold

Autofold is an agentic peptide-discovery system that improves both candidate molecules and the methods used to discover them. It combines reproducible computational experiments, fixed evaluation, campaign-scoped scientific memory, and bounded recursive improvement.

The canonical implementation and acceptance handoff is
[docs/current-state-2026-09-05.md](docs/current-state-2026-09-05.md). Dated
acceptance pages are historical snapshots; new experiment-level development
should follow the scientist-kernel documents linked there.

## Product model

```text
Project / workspace
└── Campaign
    ├── OKF knowledge graph
    └── Experiment
        ├── immutable objective, evaluator, and budget
        └── Trial
            ├── intent: optimize, calibrate, or negative_control
            ├── content-addressed experiment program (immutable once recorded)
            ├── execution runs
            ├── evaluation
            └── evidence and artifacts
```

## Improvement loops

- **Candidate optimization:** Proto searches for better peptide candidates inside one trial.
- **Experiment RSI:** the agent improves the Proto program across trials while a locked evaluator determines progress.
- **Campaign RSI:** the agent selects experiments and allocates resources toward the campaign objective.
- **Capability RSI:** evaluated research trajectories improve reusable skills and model-routing strategies.
- **Knowledge recursion:** verified claims and failures compound in the campaign's OKF graph.

Each loop has a bounded mutable object, a fixed promotion rule, a budget, provenance, and rollback. A loop cannot rewrite its own evaluator.

## System boundaries

- **Autofold backend:** campaign, experiment, trial, budget, evaluation, promotion, provenance, and knowledge control plane.
- **Skills:** research strategy, hypothesis generation, model selection, failure analysis, and reusable procedures.
- **Proto:** trial-level substrate for generators, constraints, optimizers, registry-based model discovery, and local or remote tool dispatch.
- **Model adapters:** pinned, typed access to RFdiffusion3, MPNNs, Boltz, Chai, Protenix, and future models.
- **Locked evaluator:** produces the authoritative comparable score; it is outside the agent-editable program.
- **OKF:** campaign-scoped claims, evidence, relationships, and accumulated scientific knowledge.

## Initial peptide workflow

```text
target preparation
→ RFdiffusion3 backbone generation
→ LigandMPNN / SolubleMPNN sequence design
→ deterministic quality gates
→ Boltz-2 cofold screening
→ Chai-1 independent validation
→ Protenix-v2 disagreement resolution
→ interface and developability scoring
→ diversity selection
→ fixed panel evaluation
→ OKF evidence update
```

BoltzGen and PXDesign are optional, competing Proto generation lanes alongside
RFdiffusion3/MPNN. The agent can select and compare them under a frozen budget;
predictor disagreement remains visible and is penalized rather than averaged
away.

## Core invariant

An agent may change the trial program, model combination, parameters, routing, and resource allocation. It may not change the experiment contract or authoritative evaluator. A changed contract starts a new experiment version.

Only `optimize` trials are promotion-eligible. Valid `calibrate` and
`negative_control` trials are scored by the same locked evaluator and recorded
as stable `observed` evidence, but can never replace the incumbent—even if their
numeric score is better. This separates learning about the evaluator from
optimizing against it.

The experiment score measures quality-adjusted discovery yield and diversity under a fixed compute budget, not the luckiest single candidate.

## Implemented vertical slice

The terminal research client runs the complete control-plane path for the deterministic mock and pinned Proto adapters: campaign creation and activation, frozen experiment contracts, immutable `trial.py` authoring, sandbox-authorized run launch, manifest-verified candidates, locked evaluation and promotion, and campaign-scoped OKF v0.2 concepts. Research state is authoritative; the readable bundle is published under `.autofold/campaigns/<campaign-id>/knowledge`.

The first scientific contract is also implemented: content-addressed Target Artifact v1 JSON plus verified PDB/mmCIF blobs, worker-owned model evidence, and the deterministic `peptide-panel@1` evaluator. Agent-editable Proto proposes sequences and validation topology but cannot author trusted evidence. The trusted structure bridge invokes frozen tools through proto-tools; deterministic CPU fixtures test provenance without claiming biological validity. See [docs/scientific-contract-v1.md](docs/scientific-contract-v1.md).

Start with `bun run research:cli -- help`. The current scientific acceptance loop is:

```text
bun run research:cli -- status
bun run research:cli -- session create --title "Acceptance compute"
bun run research:cli -- campaign create --objective "Discover a selective peptide binder"
bun run research:cli -- campaign activate CMP_ID
bun run research:cli -- target add --file docs/target-artifact.example.json --structure target.cif
bun run research:cli -- experiment create CMP_ID --objective "Improve the locked peptide score" --target TARGET_HASH --evaluator peptide-panel
bun run research:cli -- experiment activate EXP_ID
bun run research:cli -- trial create EXP_ID --adapter proto --hypothesis "Test a peptide proposal strategy" --program backend/worker/tests/fixtures/proto_scientific_trial.py
bun run research:cli -- run start TRL_ID --session SES_ID
bun run research:cli -- run watch RUN_ID
bun run research:cli -- knowledge CMP_ID
```

Calibration and specificity checks use the same command with
`--intent calibrate` or `--intent negative_control`.

The trial fixture proposes deterministic sequences only. Production runs use the worker-owned Boltz adapter; the test suite substitutes a source-hashed deterministic evidence adapter so it can verify the full artifact and evaluator path without GPU inference.

Scientific runs may also cross the first remote-compute boundary: Autofold
stages the byte-identical frozen bundle and source-hashed worker to an explicit
SSH GPU profile, retrieves the resulting artifact tree, and verifies it locally
before recording any result or knowledge. Local execution remains the default.
See [docs/remote-compute-v1.md](docs/remote-compute-v1.md).

Campaign knowledge now also accepts content-addressed literature search records
from the existing PubMed, Europe PMC, OpenAlex, Semantic Scholar, Crossref,
bioRxiv, and arXiv connectors. Evidence-linked claims remain explicitly
proposed until reviewed; they are published as separate OKF source and claim
nodes and supplied to experiment RSI without being mislabeled as verified run
evidence.

The first knowledge-plane recursion is now explicit: every bounded review records
the experiment outcomes it consumed, new literature and claims, typed
claim-to-outcome alignments, unresolved questions, and a next-review watermark.
Frozen experiment contracts and trial configurations are projected alongside
results so the OKF graph is navigable end to end. See
[docs/knowledge-plane-v1.md](docs/knowledge-plane-v1.md).
The same refresh returns one compact campaign summary and one advisory next
experiment, keeping the operational loop to result, evidence, understanding,
and the next falsifiable test.

The bounded literature-RSI loop now creates a dynamic `literature-review`
child, restricts it to scientific search/fetch tools and one proposal artifact,
verifies every cited excerpt against the exact fetch transcript, and atomically
publishes its sources and proposed claims. See
[docs/literature-rsi-v1.md](docs/literature-rsi-v1.md).

Long-running autoresearch and knowledge refresh operations now use persisted,
leased background jobs instead of holding HTTP requests open. Jobs support
idempotent enqueue, heartbeat, bounded retry, restart recovery, cancellation,
and CLI inspection while scientific GPU work retains its separate `Run`
lifecycle. See [docs/durable-research-jobs-v1.md](docs/durable-research-jobs-v1.md).
Expensive phases are checkpointed: completed proposals, originating trials,
scientific runs, iteration outcomes, and committed knowledge cycles are reused
after restart rather than regenerated.

The campaign-level recursive controller is specified in
[docs/recursive-orchestration-v1.md](docs/recursive-orchestration-v1.md). A sole
active experiment resumes its persistent scientist directly; team planning and
typed supervisor moves are reserved for campaign boundaries. Each empirical
iteration records a deterministic trusted search event before context reload,
so literature review is no longer a mandatory execution barrier. Approval,
rejection, stop, or the explicit step cap still terminates a durable trajectory.

Injectable skills are domain knowledge, not miniature runtimes. They teach
specialists how biology and models behave so the agent can revise Proto
intelligently; commands, endpoints, credentials, containers, and model launch
logic remain exclusively in typed Proto adapters and the worker. Skills now
live as campaign-scoped immutable Markdown versions; specialist reports and
the resulting trials pin their exact IDs and content hashes. Same-budget replay
gates campaign activation, rollback preserves history, and only skills validated
across at least three campaigns can enter the project library. See
[docs/domain-knowledge-skills-v1.md](docs/domain-knowledge-skills-v1.md).

Capability refinement is now a durable campaign operation. The supervisor can
choose a typed `refine_skill` move, freeze exact trial/evaluation/knowledge
trajectories, and delegate one bounded `SKILL.md` revision to a dynamically
created child. The job checkpoints the evidence snapshot, authored proposal,
and immutable candidate, then stops at `awaiting_replay`; it cannot activate
the skill using self-authored evidence.

Trusted shadow replay now closes that loop. Parent and candidate skills author
three paired sets of Proto trials from one frozen context by default; every trial uses the explicit
non-promotable `shadow_replay` intent and the same locked evaluator and budget.
Within each pair, the two arms have independent mutable `trial.py` files, lab
notebooks, and scientist sessions. The immutable benchmark identity is versioned
(`shadow-v2`) so older shared-workspace runs cannot be treated as valid paired
evidence.
Utility, valid-diverse yield, failure, and cost are derived from persisted
evaluation records. The candidate is activated only through the deterministic
non-regression rule. Candidate authoring can enqueue this replay automatically,
so one `refine_skill` campaign move reaches an auditable activate/reject result.

The complete budgeted generation and consensus-validation route is specified in
[docs/peptide-pipeline-v2.md](docs/peptide-pipeline-v2.md). Trial Bundle v4,
[Generation Run Index v1](docs/generation-run-index-v1.md), and
[Model Run Index v2](docs/model-run-index-v2.md) preserve the exact Proto
generator, configuration, sequence, optional generated complex, and downstream
model lineage for every candidate. [Dynamic Proto workflow v1](docs/dynamic-proto-workflow-v1.md)
lets the autoresearch agent compose the graph from the pinned Proto registry;
each run freezes the resolved topology before trusted execution.

Comparable experiments can additionally freeze an evidence-adapter
`scoringPipelineHash`. Proto stages are explicitly `scoring` or `diagnostic`:
the former must evaluate every candidate with the exact frozen model/config
lane and alone feeds the locked evaluator; the latter remains agent-composable
for routing, ablations, predictor disagreement, and information gain. Thus the
scientist can search model-composition space without moving the score ruler.

## Persistent scientist autoresearch

Normal recursive discovery uses the minimal loop described in
[docs/scientist-kernel-v2.md](docs/scientist-kernel-v2.md). One persistent GLM
scientist owns one mutable `trial.py` across repairs and empirical iterations.
It chooses the hypothesis, trial intent, generator/model composition,
configuration, workflow DAG, routing, and compute allocation from the live
registered capabilities. The tournament/acquisition layer is bypassed on this
active-experiment path and no longer ranks or narrows those decisions.

Each iteration refreshes experiment evidence, OKF knowledge, notebook cycles,
and active campaign skills, then reasserts the frozen contract hash. The
scientist reads this compact state from disk and edits `trial.py` directly with
normal file tools. New trials expose one `build_trial(ctx) -> ProtoTrial`
function: the returned object owns the executable Proto generation program,
hypothesis, intent, and any diagnostic stages. Trusted code constructs and
validates that object, injects the frozen scoring stages, snapshots the exact
source immutably, executes it, and applies the locked evaluator. The old
`build_program`, `AUTOFOLD_TRIAL`, and `AUTOFOLD_WORKFLOW` surfaces remain only
as migration compatibility for existing lineage.
Within one persistent model turn the scientist may evaluate several successive
programs. Every tool result is returned only after its run, knowledge closeout,
typed event append, and state checkpoint are durable, so the next edit is based
on the immediately preceding empirical result.

Generator portfolios are executable Proto composites rather than duplicated
manifests. `ProtoPortfolioProgram` runs independent `ProtoPortfolioLane`
programs, derives their allocations during construction preflight, and attaches
trusted lane provenance before candidates are merged. The frozen scoring lane
is always injected by the compiler. `DiagnosticStage` objects in `ProtoTrial`
let the scientist add routing, ablations, or disagreement probes without
changing the score ruler.

The canonical experiment feed is now the append-only typed
`events.jsonl`. `scientist.json` is one total durable state register for the
long-lived lane. `EVENTS.md`, OKF pages, notebook prose, search landscapes, and
compact prompt packets are derived views and cannot override the immutable run,
evaluation, contract, or event records.

```text
bun run research:cli -- autoresearch EXP_ID --session SES_ID --mode autonomous_discovery
```

Autonomous mode now authorizes up to 100 trajectories by default and keeps the
same scientist running until it makes an evidence-linked stop or reaches the
authorized/campaign trial budget. `--iterations N` remains an explicit smaller
authorization, and `single_intent` remains a one-purpose compatibility mode.
The campaign loop no longer returns after every trial: it grants the remaining
campaign trial budget in one scientist loop, but interrupts at real plane
boundaries for due literature alignment, repeated-evidence skill refinement,
shadow replay, contract approval, or stop. Generator allocations are enforced
by the compiler and worker.
Fingerprints are provenance rather than a harness search policy; only an exact
unchanged no-op is rejected by default. Existing scientific experiments created
before evidence-adapter pinning must be recreated before using this loop.

New runs distinguish source/workflow equivalence from empirical replication.
The worker records a preassigned generation-replicate ID, realized candidate-set
hash, requested and observed seeds, stochasticity classification, and generation
wall time in the campaign search landscape. The scientist also receives a
matched positive/negative evaluator audit and can author non-promotable
calibration trials directly in `trial.py`. Ordinary deterministic knowledge
closeout and skill replay do not interrupt the active search horizon.
