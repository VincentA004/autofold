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

Start with `bun run research:cli -- help`. A typical terminal loop is:

```text
bun run research:cli -- status
bun run research:cli -- session create --title "Acceptance compute"
bun run research:cli -- campaign create --objective "Discover a selective peptide binder"
bun run research:cli -- campaign activate CMP_ID
bun run research:cli -- experiment create CMP_ID --objective "Improve the locked peptide score" --target sha256:...
bun run research:cli -- experiment activate EXP_ID
bun run research:cli -- template proto > trial.py
bun run research:cli -- trial create EXP_ID --adapter proto --hypothesis "Increasing diversity improves yield" --program trial.py
bun run research:cli -- run start TRL_ID --session SES_ID
bun run research:cli -- run watch RUN_ID
bun run research:cli -- knowledge CMP_ID
```
