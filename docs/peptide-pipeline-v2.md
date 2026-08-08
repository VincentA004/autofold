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

## Implemented artifact revision

Model Run Index v1 assumed one predictor per candidate and seed. Trial Bundle
v4 and Model Run Index v2 now use identity
`candidate × stage × model × seed`, explicit routed/skipped status, native
metrics, parameters, runtime cost, and parent artifact links. Candidate evidence
declares the exact completed validators, and the verifier rejects missing
required coverage while allowing only policy-authorized skips. See
[model-run-index-v2.md](model-run-index-v2.md).

The deterministic Boltz/Chai/Protenix fixture tests the topology without making
biological claims. The trusted GPU consensus adapter and its budgeted routing
policy are the next execution-layer increment. Until then, the production
Boltz-only adapter remains a vertical slice, not the complete peptide pipeline.
