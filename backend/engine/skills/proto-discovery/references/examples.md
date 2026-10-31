# Native composition examples

## A small complete CPU trial

The Autofold repository includes `examples/hello_proto.py`: a `Segment` and
`Construct`, random nucleotide generator, GC-content constraint and rejection
sampling optimizer inside a native `Program`. It runs without model downloads.
Locate it relative to the Autofold repository, not an unrelated research workspace.
Use it to check imports and composition, not as a protein discovery method.

For proposal work without an endpoint predictor, run
[`hypothesis_proposals.py`](../examples/hypothesis_proposals.py): native protein
mutation and threshold filtering preserve specified positions and retain a bounded,
unranked pool. The illustrative sequence/positions supply no biological evidence;
choose real inputs and model conditioning from the trial hypothesis. This CPU example
shows mechanics, not binding or model readiness.

The ordinary wiring is:

```python
generator.assign(design_segment)
optimizer = OptimizerClass(
    constructs=[construct],
    generators=[generator],
    constraints=constraints,
    config=OptimizerConfig(...),
)
program = Program(optimizers=[optimizer], num_results=desired_survivors, seed=seed)
program.run()
```

This is a shape, not executable copy/paste: choose actual classes, required target
segments, inputs and fields from the installed schema. Native source examples are
discoverable from the module path reported by the inspection helper.

For design trials the native optimizer owns proposal, scoring and selection. Custom
model calls belong inside compatible generators, constraints or conditioning hooks.
Direct calibration/assessment calls may surround the Program. Keep actual native
history, objective metadata and model artifacts so this dependency can be inspected.

## Trial choices from an objective

| Trial purpose | Example procedure | Readout |
| --- | --- | --- |
| Generate | Target-conditioned candidates + compatible native search | Valid/diverse pool, generator failure rate and task measurements |
| Screen | Read a previous candidate pool; cheap checks then selected model tools | Surviving identities, rejected identities/reasons, full denominators |
| Refine | Seed native MCMC or target-aware cycling with selected candidates | Changes to relevant measurements, new identities and resources used |
| Diagnose | Compare a hypothesized failure mechanism or control input | Evidence that supports or challenges that explanation |
| Replicate | Repeat a captured method under recorded seed/config variations | Variation and reproducibility, not merely another best score |
| Compare | Run alternative generators/optimizers under common evaluation | Method utility versus variability and consumed resources |

Routine filters can stay within one program. A new screening question chosen after
inspecting an earlier run can be another trial consuming its artifacts. Pi decides
the investigation; one Proto run can include many native model calls and search
steps. A separate optimizer is not necessary for every analysis or validation call.

## Multistage protein search

One program might initialize sequences using inverse folding and rejection
sampling, then refine the shared design objects with mutation/MCMC, followed by
additional direct predictor calls for a shortlist. Another might use target-aware
cycling instead. Choose stages because their handoffs and feedback fit the task,
not because every available optimizer must appear. Beam search's prompt restart
semantics and gradient compatibility make arbitrary stage concatenation invalid.

For target-aware conditioning, copy the focused Python example from this skill's
`examples/` directory beside the authored program and adapt its model settings and
filters to the task. It does not supply biological acceptance thresholds.

The `examples/native_pareto.py` CPU fixture exercises native NSGA-II with two synthetic
objective tables. It illustrates score plumbing and tradeoffs only; it is not a
biological fitness function or a candidate-generation workflow. See scoring for use.
