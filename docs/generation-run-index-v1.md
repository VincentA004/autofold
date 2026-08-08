# Generation Run Index v1

Proto remains the experiment substrate: the agent writes `build_program(bundle)`
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

When `AUTOFOLD_WORKFLOW.generation` is present, startup discovers the pinned live
`GeneratorRegistry`, freezes the allowed generators and budget into Trial Bundle
v4, and the worker rejects any mismatch between declared and observed generators.
Finalization independently re-hashes every file and checks the generator policy,
target, sequence, seed, program, and Proto commits.

The first production-shaped lane is
`rfdiffusion-mpnn-binder`, which records RFdiffusion3 backbone generation plus
ProteinMPNN/LigandMPNN inverse folding. Additional Proto generators can be added
without changing the artifact boundary.
