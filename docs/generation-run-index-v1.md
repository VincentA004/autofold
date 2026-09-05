# Generation Run Index v1

Proto remains the experiment substrate: the agent writes `build_trial(ctx)`
and can change generators, optimizers, constraints, and routing between trials.
Autofold does not duplicate that biological workflow engine.

For a scientific run, the worker now observes the completed Proto `Program` and
persists one content-addressed `autofold.generation-run.v1` artifact per returned
candidate. Each artifact binds:

- candidate, target, sequence, seed, and immutable trial-program hashes;
- the Proto generator registry identity and pinned language/tools commits;
- underlying proto-tools called by the generator;
- normalized generator configuration and parameter hash;
- generator-emitted metadata such as RFdiffusion contigs and MPNN recovery;
- the generated complex structure when Proto retained one.

`generation-runs/index.json` records all artifact and optional structure paths and
hashes. Final candidates reference the exact generation artifact rather than using
the trial program hash as a placeholder.

Every new v4 run also freezes a `generationReplicateId` before launch. The
generation index binds that requested replicate to the realized candidate-set
hash, requested experiment seeds, worker-observed generator seeds, and one of
`deterministic`, `seeded`, `upstream_uncontrolled`, `mixed`, or `unknown`.
Consequently, a semantic Proto fingerprint identifies a configuration family,
not a cached scientific result: independently realized candidate sets remain
distinct statistical replicates even when their source and workflow are equal.

The index also carries trusted `generatorDiagnostics`. FreeBindCraft writes
per-filter rejection tables into an ephemeral tool directory, so the worker
observes that directory while the pinned generator runs and retains only typed
counters: rejected and accepted candidates, trajectory failures, and the exact
filter names and counts. The temporary files and host paths are deleted. These
counters are verified against the frozen generator portfolio, projected into
the campaign search landscape, and returned to the persistent scientist in
`latest-result.json`; they are diagnostics for choosing the next Proto delta,
not evaluator scores.

`maximumCandidates` limits returned candidates, not a generator's internal
proposal or rejection search. Agent-authored controls such as FreeBindCraft's
`max_trajectories` remain active under the independently frozen per-lane GPU
deadline, so the harness does not collapse a broad search into one attempt.

For new `ProtoTrial` programs, startup discovers the pinned live
`GeneratorRegistry`, derives the generators and lane budgets from the executable
`ProtoPortfolioProgram`, freezes them into Trial Bundle v4, and rejects any
mismatch between constructed and observed generators. Literal
`AUTOFOLD_WORKFLOW.generation` remains readable for legacy programs only.
Finalization independently re-hashes every file and checks the generator policy,
target, sequence, seed, program, and Proto commits.

The first production-shaped lane is
`rfdiffusion-mpnn-binder`, which records RFdiffusion3 backbone generation plus
ProteinMPNN/LigandMPNN inverse folding. Additional Proto generators can be added
without changing the artifact boundary.
