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
    "stages": [
        {
            "id": "primary",
            "capability": "structure_prediction",
            "tools": ["boltz2-prediction"],
            "maximumCandidates": 100,
            "maximumGpuSeconds": 500,
        },
        {
            "id": "independent",
            "capability": "structure_prediction",
            "tools": ["chai1-prediction"],
            "dependsOn": ["primary"],
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
checks tool availability and categories, topologically orders the graph,
enforces the experiment budget, resolves `first_available` routes, and pins
each selected tool to the proto-tools Git commit.

Run startup repeats compilation. Trial Bundle v4 freezes the resulting policy.
The worker independently binds it back to the literal manifest, then the
trusted structure bridge invokes the selected `ToolRegistry` functions. Model
Run Index v2 records completed calls and legal conditional skips.

The agent can rewrite the Proto `Program` and validation manifest between
trials. It cannot rewrite them after execution starts, fabricate evidence,
change the evaluator, or exceed the experiment budget.

Workflow-composition skills remain advisory inputs to the authoring agent. They
can teach generation strategies, model selection, disagreement handling, and
budget allocation. Successful trajectories can refine those skills and the
next manifest; the evidence bridge and evaluator remain trusted runtime
components.

The installed bridge currently accepts Proto `structure_prediction` tools with
the common typed structure interface. A real multi-model 4090 acceptance run is
still needed to calibrate native metrics and runtime budgets.
