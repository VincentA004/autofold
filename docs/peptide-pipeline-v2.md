# Peptide pipeline v2 boundary

The production peptide workflow is a budgeted cascade, not a fixed instruction
to run every model over every candidate. The agent may revise routes and
thresholds between trials, while the experiment contract freezes the available
models, maximum budget, required validation coverage, and locked promotion
score.

```text
campaign literature + prior run knowledge
  -> target and binding-site preparation
  -> one or more generation lanes
     - RFdiffusion3 -> ProteinMPNN/SolubleMPNN
     - BindCraft/FreeBindCraft
     - BoltzGen/direct peptide generation
  -> deterministic sequence and geometry gates
  -> Boltz-2 primary cofold screen
  -> Chai-1 independent validation for survivors
  -> Protenix-v2 for disagreement or high-value candidates
  -> developability, aggregation, synthesis, and diversity gates
  -> fixed panel score
  -> trial decision and campaign OKF update
```

## Control boundaries

- The dynamic parent agent chooses hypotheses and authors a Proto trial.
- Proto expresses generation, optimization, routing, and model calls.
- Proto-tools supplies pinned typed model implementations and GPU dispatch.
- The trusted worker captures native outputs and model provenance.
- The evaluator applies frozen gates and computes the comparable score.
- The knowledge plane stores literature claims separately from computational
  evidence and experimental outcomes.

The 4090 is only a worker host for these model calls. Replacing it with another
GPU host or cluster does not change the campaign, trial, or knowledge model.

## Required next artifact revision

Model Run Index v1 assumes one predictor per candidate and seed. The full
pipeline requires Model Run Index v2 with identity
`candidate × stage × model × seed`, explicit routed/skipped status, native
metrics, parameters, runtime cost, and parent artifact links. Candidate evidence
must declare the exact set of required validators, and the verifier must reject
missing required coverage while allowing budget-policy skips.

This index and a multi-predictor evidence adapter are the next execution-layer
increment. Until then, the current Boltz-only scientific adapter is an accepted
vertical slice, not the complete peptide pipeline.
