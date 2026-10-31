# Encode justified measurements in native Proto

Use [science](science.md) to justify a measurement, then choose how it controls
selection. Optimizer compatibility and score plumbing do not establish biological
validity. Use [shared geometry/PAE arithmetic](structure-measurements.md) with explicit
correspondence.

## Native constraint contract

A discrete function has signature `(input_sequences, config) -> list[ConstraintOutput]`,
one output per input tuple. Return finite scores and metadata with raw values, units,
settings/seeds and capture references. Current discrete scoring normally expects
[0,1]; inspect support before returning unbounded losses. Choose direction explicitly
(e.g. `1-confidence`). Invalid chemistry or missing evidence must not obtain favorable
fitness; preserve invocation failures separately from candidate rejection.

Use a registered constraint if its actual meaning/inputs fit. A small custom
constraint may call a predictor, aggregate repeats or calculate geometry while native
optimizers retain evaluation/selection ownership. Predictor seeds in callbacks may
need explicit settings independent of the Program seed.

| Intent | Native expression | Consequence |
| --- | --- | --- |
| Admissibility | `Constraint(..., threshold=...)` | Threshold applies to returned score; omit `weight`. The installed API rejects threshold + weight. |
| Scalar preference | Scoring constraint without threshold | Compatible optimizer minimizes the score |
| Deliberate scalar tradeoffs | Several weighted scoring constraints | Additive energy; units/scales and exchange rates need justification |
| Preserve competing preferences | Separate scoring constraints; GA `survivor_selection="nsga2"` | Nondominated fronts/crowding rather than one weighted scalar |
| Prediction-conditioned cycling | Threshold filters plus conditioning | Passing does not guarantee improvement over the previous candidate |

For example, after defining the actual functions:

```python
admissible = Constraint(inputs=[binder], function=validity, threshold=0.0)
preference = Constraint(inputs=[binder], function=loss, weight=1.0)
```

## Pareto semantics and native handoff

Each NSGA-II scoring constraint supplies one lower-is-better objective component;
several metrics inside one constraint still make one objective. Labels must be unique.
The inspected implementation reads per-constraint `weighted_score`/`score`, rejects
missing/nonfinite components and flagged fallbacks, and excludes filters from the
objective vector.

Dominance means no worse in every component and better in at least one. The frontier
is a tradeoff set, not a unique biological winner. Positive rescaling leaves dominance
unchanged; native crowding normalizes objective ranges, so weights are not scalar
exchange rates, although tie-breaks can change ordering. Negative weights can reverse
preferences. Retain vectors/eligibility and justify shortlist choice separately.
Finite populations may omit nondominated points or contain duplicate sequences;
inspect observed unique candidates rather than assuming a complete frontier.

When seeding existing results, restore the full `segment.result_sequences` after
optimizer/Program construction and immediately before `.run()`; constructors can
resize pools. Verify evaluated coverage against the intended inputs. Histories may
contain infinite rejection sentinels: retain them explicitly as diagnostics, never
invent finite fitness or discard the export. [native_pareto.py](../examples/native_pareto.py)
provides `history_for_json` and a CPU synthetic wiring example, not a biological
objective. Exercise rejected and passing proposals; see the installed
[filter/NSGA-II compatibility check](validation.md#native-compatibility-checks).

## Reuse, capture and comparison

Several objectives can share one prediction keyed by complete molecular input,
model/version, settings and seeds. Derive separate outputs from the same evidence;
reuse is not independent replication. Test invalidation when relevant inputs change;
no global scoring service is needed.

Persist full responses before selection, including failures/partial outputs and
actual requested PAE matrices. Histories can omit discarded predictions; follow the
[capture recipe](validation.md#a-trial-as-files). Keep campaign comparison separate
from search fitness and preserve changed objective definitions as separate panels.

For applicable canonical complexes, [PRODIGY](local-evaluation.md) can provide a
separate pose-conditioned DeltaG estimate. Preserve kcal/mol and assumptions; combining
it with confidence needs justified scaling. Contact-derived scores on the same pose
are not independent validation, and adding a Pareto component does not calibrate it.
