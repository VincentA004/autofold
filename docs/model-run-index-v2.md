# Model Run Index v2

Model Run Index v2 is the trusted artifact graph for a staged peptide pipeline.
Trial Bundle v4 freezes a content-hashed pipeline policy compiled from the
agent-authored Proto workflow. It contains DAG dependencies, conditions,
budgets, selected registry tools, pinned versions, and skip policy.

Every candidate, stage, model, and frozen seed has exactly one index decision:

- `completed` links a Model Run Artifact v2, native metrics, structure, runtime
  cost, parameters, and parent artifacts;
- `skipped` records a bounded reason and is legal only when the frozen stage
  policy permits it.

Model Run Artifact v2 adds:

- stage identity;
- model and adapter versions;
- parent artifact hashes;
- wall time, optional GPU time, and optional peak memory;
- native metrics and content-addressed outputs.

The verifier rejects undeclared models, missing decisions, illegal skips,
duplicate identities or artifacts, unfrozen seeds, cross-candidate parents,
parents outside declared dependencies, hash changes, metric changes, and candidate predictor
lists that omit completed evidence.

The deterministic CPU consensus fixture emits the topology:

```text
Boltz-2 primary screen
  -> Chai-1 independent validation
  -> Protenix disagreement resolution
```

Its synthetic metrics exercise provenance and verification only. The trusted
Proto structure bridge now dispatches tools selected by the compiled graph;
the next hardware increment is a real multi-model 4090 acceptance run.
