# Autofold

Autofold is an agentic peptide-discovery system that improves both candidate molecules and the methods used to discover them. It combines reproducible computational experiments, fixed evaluation, campaign-scoped scientific memory, and bounded recursive improvement.

## Product model

```text
Project / workspace
└── Campaign
    ├── OKF knowledge graph
    └── Experiment
        ├── immutable objective, evaluator, and budget
        └── Trial
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
- **Proto:** trial-level biological execution substrate for generators, constraints, predictors, optimizers, and artifacts.
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

BoltzGen becomes a competing generation lane after the initial evaluator is stable, especially for short, cyclic, disulfide-rich, and modified peptides. Predictor disagreement remains visible and is penalized rather than averaged away.

## Core invariant

An agent may change the trial program, model combination, parameters, routing, and resource allocation. It may not change the experiment contract or authoritative evaluator. A changed contract starts a new experiment version.

The experiment score measures quality-adjusted discovery yield and diversity under a fixed compute budget, not the luckiest single candidate.

## Implemented vertical slice

The terminal research client runs the complete control-plane path for the deterministic mock and pinned Proto adapters: campaign creation and activation, frozen experiment contracts, immutable `trial.py` authoring, sandbox-authorized run launch, manifest-verified candidates, locked evaluation and promotion, and campaign-scoped OKF v0.2 concepts. Research state is authoritative; the readable bundle is published under `.autofold/campaigns/<campaign-id>/knowledge`.

The first scientific contract is also implemented: content-addressed Target Artifact v1 JSON plus verified PDB/mmCIF blobs, worker-owned Model Run Artifact v1 evidence, and the deterministic `peptide-panel@1` evaluator. Agent-editable Proto proposes sequences but cannot author trusted evidence. The first production adapter is pinned to Boltz 2.2.1 through proto-tools; a deterministic CPU fixture tests the same provenance path without claiming biological validity. See [docs/scientific-contract-v1.md](docs/scientific-contract-v1.md).

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

The bounded literature-RSI loop now creates a dynamic `literature-review`
child, restricts it to scientific search/fetch tools and one proposal artifact,
verifies every cited excerpt against the exact fetch transcript, and atomically
publishes its sources and proposed claims. See
[docs/literature-rsi-v1.md](docs/literature-rsi-v1.md).

The complete budgeted generation and consensus-validation route is specified in
[docs/peptide-pipeline-v2.md](docs/peptide-pipeline-v2.md). Trial Bundle v4 and
[Model Run Index v2](docs/model-run-index-v2.md) now represent and verify staged
Boltz/Chai/Protenix evidence. The trusted GPU consensus adapter is the next
execution increment.

## Bounded autoresearch v1

The first experiment-RSI controller is implemented through the existing child-session harness. Each iteration creates a biology, ML, or general child agent; injects the frozen contract, target, incumbent program, verified candidates, recent evaluations, campaign OKF concepts, and a compact pinned Proto tool catalog; then grants write access to exactly one mutable draft `trial.py`. The draft is preserved under `.autofold/autoresearch`, statically preflighted without importing it, frozen by content hash, executed, and promoted or rejected by the locked evaluator. A rejected trial does not stop the loop; the next iteration still starts from the current incumbent.

```text
bun run research:cli -- autoresearch EXP_ID --session SES_ID --iterations 3
```

The command is deliberately bounded to ten sequential iterations. It stops on authoring, preflight, or scientific execution failure and returns the child session, draft, trial, run, score, and promotion decision for every completed attempt. Existing scientific experiments created before evidence-adapter pinning must be recreated before using this loop.
