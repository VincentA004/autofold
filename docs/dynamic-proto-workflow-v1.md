# Dynamic Proto workflow v1

Autofold does not own a second biological workflow engine. An agent authors one
mutable `trial.py`; every evaluation snapshots its exact bytes immutably. New
source returns one `ProtoTrial` from `build_trial(ctx)` using Proto's existing
primitives:

- `Program` composes generators, constraints, and optimizer stages;
- `ToolRegistry` discovers typed biological and structure-model tools;
- `ToolPool` or Proto's configured dispatch backend runs those tools locally or remotely;
- `ProtoPortfolioProgram` composes independent bounded `ProtoPortfolioLane`
  programs;
- `DiagnosticStage` declares optional agent-authored validation or routing
  stages that cannot affect the frozen score.

The Autofold-specific authoring surface is one returned object. The scientist
does not repeat generator identity or allocation in a side manifest; trusted
construction derives them from the executable Proto object graph. The frozen
scoring graph remains outside agent-authored evidence and is injected from the
experiment contract.

```python
def build_trial(ctx: TrialContext) -> ProtoTrial:
    lane_a = ProtoPortfolioLane(
        program=build_boltzgen_program(ctx),
        maximum_candidates=4,
        maximum_gpu_seconds=1800,
    )
    lane_b = ProtoPortfolioLane(
        program=build_rfdiffusion_program(ctx),
        maximum_candidates=2,
        maximum_gpu_seconds=1800,
    )
    return ProtoTrial(
        hypothesis="A mixed generator portfolio improves valid diverse yield.",
        intent="optimize",
        program=ProtoPortfolioProgram([lane_a, lane_b]),
        diagnostics=(
            DiagnosticStage(
                id="independent_probe",
                tools=("protenix-prediction",),
                maximum_candidates=2,
                maximum_gpu_seconds=600,
            ),
        ),
    )
```

Before a trial is created, trusted construction imports the draft in a bounded
environment, calls `build_trial(ctx)` with fixture paths derived only from the
frozen contract, and validates the returned object. The compiler discovers the
pinned live Proto registry, checks generator and tool availability,
topologically orders diagnostics plus the injected scoring graph, enforces the
experiment budget, resolves `first_available` routes, and pins each selected
component to its Proto repository commit.

For a score-comparable experiment, the contract also stores a
`scoringPipelineHash`. Every `role: "scoring"` stage must match that exact
model/config/dependency lane, be required, and evaluate every submitted
candidate without routing or conditional skips. `role: "diagnostic"` stages
may be added, removed, routed, or reconfigured by the scientist; their model
artifacts and disagreement signals enter the recursive context, but the
evidence adapter excludes them from the locked evaluator inputs. Scoring stages
may not depend on diagnostic stages, while diagnostics may depend on scoring
outputs.

Run startup repeats construction and compilation. Trial Bundle v4 freezes the
resulting policy. The worker independently derives the generation and diagnostic
plans from the returned object, then the trusted structure bridge invokes the
selected `ToolRegistry` functions. Model Run Index v2 records completed calls
and legal conditional skips.

Generation remains inside the agent-authored Proto program or portfolio. The
trusted worker observes the completed object graph, checks its generator
inventory and allocations against the frozen generation policy, and emits
Generation Run Index v1 with per-candidate lane, sequence, configuration,
metadata, structure, replicate, and provenance hashes. See
[generation-run-index-v1.md](generation-run-index-v1.md).

The agent can rewrite the Proto program and diagnostic graph between trials. It
cannot rewrite a snapshotted trial after execution starts, author scoring stages,
fabricate evidence, change the evaluator, or exceed the experiment budget.

Execution is stage-first. For each frozen seed, a `candidateRouting` clause
ranks the preceding stage's native metrics with a deterministic candidate-ID
tie break, executes only the declared top-k survivors, and records every other
candidate as `candidate_filtered`. Conditions and optional tool failures use
separate typed skip reasons, so routing cannot silently hide model failures.

Per-tool `configs` are validated by each registered Proto Pydantic config model
before a trial is recorded and frozen into the pipeline. Autofold reserves
`seed`/`seeds`, `timeout`, and `device` so agent-authored settings cannot bypass
the experiment runtime policy.

Workflow-composition skills remain advisory inputs to the authoring agent. They
can teach generation strategies, model selection, disagreement handling, and
budget allocation. Successful trajectories can refine those skills and the
next manifest; the evidence bridge and evaluator remain trusted runtime
components.

The installed bridge accepts Proto `structure_prediction` tools with the common
typed structure interface. Real 4090 acceptance runs now cover Boltz, Chai with
ESM embeddings enabled, and Protenix v2. These prove execution and artifact
integrity, not biological calibration. The pinned runtime snapshot and repaired
environment constraints are recorded in
[4090 execution acceptance](gpu-acceptance-2026-08-08.md).

Autofold also registers `boltzgen-binder` and `pxdesign-binder` as optional Proto
generators when their isolated CLIs and model caches are configured. This keeps
them as competing, agent-selectable generation lanes rather than hard-coding a
single peptide pipeline. The PXDesign adapter forwards the frozen Proto seed.
BoltzGen's current upstream CLI exposes no seed option, so its artifact metadata
records `seedControl: upstream_cli_unavailable`; promotion experiments should use
replicate distributions until that upstream boundary is patched.

The bounded hardware probe runs two primary predictions and routes one survivor
through Chai and Protenix:

```text
PYTHONPATH=backend/worker python backend/worker/run_adaptive_acceptance.py \
  --proto-root /path/to/proto-language \
  --output /new/output/directory \
  --chai-esm \
  --protenix-model protenix-v2
```

The complete generation-to-evidence artifact path has a separate bounded probe:

```text
PYTHONPATH=backend/worker python backend/worker/run_generation_acceptance.py \
  --proto-root /path/to/proto-language \
  --target-structure /path/to/target.pdb \
  --output /new/output/directory
```
