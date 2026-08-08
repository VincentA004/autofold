# Dynamic Proto workflow v1

Autofold does not own a second biological workflow engine. An agent authors one
immutable `trial.py` using Proto's existing primitives:

- `Program` composes generators, constraints, and optimizer stages;
- `ToolRegistry` discovers typed biological and structure-model tools;
- `ToolPool` or Proto's configured dispatch backend runs those tools locally or remotely.

The small Autofold-specific surface is a literal `AUTOFOLD_WORKFLOW` manifest in
the same file. It declares the trusted final-validation graph that must remain
outside agent-authored evidence:

```python
AUTOFOLD_WORKFLOW = {
    "format": "autofold.proto-workflow.v1",
    "id": "adaptive_validation",
    "maximumGpuSeconds": 1200,
    "generation": {
        "generators": ["rfdiffusion-mpnn-binder"],
        "maximumCandidates": 100,
        "maximumGpuSeconds": 300,
    },
    "stages": [
        {
            "id": "primary",
            "capability": "structure_prediction",
            "tools": ["boltz2-prediction"],
            "configs": {
                "boltz2-prediction": {
                    "use_msa": False,
                    "sampling_steps": 20,
                    "diffusion_samples": 1,
                },
            },
            "maximumCandidates": 100,
            "maximumGpuSeconds": 500,
        },
        {
            "id": "independent",
            "capability": "structure_prediction",
            "tools": ["chai1-prediction"],
            "dependsOn": ["primary"],
            "candidateRouting": {
                "source": "primary",
                "metric": "confidence_score",
                "direction": "maximize",
                "maximumCandidates": 20,
            },
            "maximumCandidates": 20,
            "maximumGpuSeconds": 400,
        },
        {
            "id": "resolve_disagreement",
            "capability": "structure_prediction",
            "tools": ["protenix-prediction"],
            "dependsOn": ["independent"],
            "condition": {
                "source": "independent",
                "metric": "predictor_disagreement",
                "operator": "gt",
                "value": 0.15,
            },
            "maximumCandidates": 10,
            "maximumGpuSeconds": 300,
            "optional": True,
        },
    ],
}
```

Before a trial is created, autoresearch statically extracts the literal without
executing `trial.py`. The compiler discovers the pinned live Proto registry,
checks generator and tool availability, topologically orders the validation graph,
enforces the experiment budget, resolves `first_available` routes, and pins
each selected component to its Proto repository commit.

Run startup repeats compilation. Trial Bundle v4 freezes the resulting policy.
The worker independently binds it back to the literal manifest, then the
trusted structure bridge invokes the selected `ToolRegistry` functions. Model
Run Index v2 records completed calls and legal conditional skips.

Generation remains inside the agent-authored Proto `Program`. The trusted worker
observes the completed program, checks its generator inventory against the frozen
`generation` policy, and emits Generation Run Index v1 with per-candidate sequence,
configuration, metadata, structure, and provenance hashes. See
[generation-run-index-v1.md](generation-run-index-v1.md).

The agent can rewrite the Proto `Program` and validation manifest between
trials. It cannot rewrite them after execution starts, fabricate evidence,
change the evaluator, or exceed the experiment budget.

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

The installed bridge accepts Proto `structure_prediction` tools with
the common typed structure interface. A real multi-model 4090 acceptance run is
complete for Boltz, Chai, and Protenix Tiny; full-model scientific calibration is
still required.

The bounded hardware probe runs two primary predictions and routes one survivor
through Chai and Protenix:

```text
PYTHONPATH=backend/worker python backend/worker/run_adaptive_acceptance.py \
  --proto-root /path/to/proto-language \
  --output /new/output/directory
```
