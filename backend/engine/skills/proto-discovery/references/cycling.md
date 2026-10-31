# Target-aware cycling

Check the [molecular handoff contract](molecular-contract.md) before adapting this
two-chain example to constrained chemistry or antibody assemblies.

Use cycling when the hypothesis is that prediction-conditioned redesign will help
the objective. Compare it with an appropriate simpler procedure under comparable
resources. Generic Protein Hunter predicts each candidate alone in the inspected
installation; it does not automatically measure or preserve target binding.

## The intended handoff

```text
Fixed target + current binder as separate identified chains
  -> predict the complex
  -> verify returned target/binder chain identities and sequences
  -> inverse-fold only the binder, preserving target and fixed binder positions
  -> retain only the binder sequence as the mutable design
  -> assess the new sequence with target-aware threshold filters
  -> repeat; assess final outputs under the campaign's comparison procedure
```

The bundled [conditioning example](../examples/target_aware_conditioning.py) uses
the actual `Complex`, `Chain`, `predict_structures` and
`InverseFoldingStructureInput` interfaces. It checks chain sequence identity and
returns one conditioning item per input candidate. It is a small adaptation point,
not a complete binder-discovery protocol. It preserves target sequence, not fixed
target coordinates; templates, target conformations, modifications, epitopes and
other requirements need explicit supported inputs. Its metadata-only checks do
not demonstrate that a selected predictor preserves those features.
Direct predictor calls inside custom conditioning use their supplied tool config;
record the predictor's seed policy explicitly rather than assuming the program
seed controls an arbitrary Python callback.

Structural feedback can also live inside population search. Where installed,
`MPNNMutationGenerator` with config field `structure_source="proposal_structure"`
uses each proposal's attached structure instead of one fixed backbone.
A scoring constraint can attach fresh predicted complexes for subsequent mutations.
Inspect GA structure-preservation settings and test that handoff. After crossover,
an inherited parent structure is conditioning, not a prediction of the new child;
re-predict the child before scoring/selection. Preserve target context and binder-only
mutation. This is an optional native composition, not a recommendation to nest two
optimizers or always enable structural feedback.

Example composition after inspecting installed APIs:

```python
from functools import partial
from proto_language.generator import ProteinMPNNGenerator, ProteinMPNNGeneratorConfig
from proto_language.optimizer import CyclingOptimizer, CyclingOptimizerConfig
from target_aware_conditioning import condition_on_target

# binder, construct, target_sequence and target_aware_filters are task-specific.
# Import the conditioning example from a copied file beside your program.
generator = ProteinMPNNGenerator(ProteinMPNNGeneratorConfig(output_chain_id="B"))
generator.assign(binder)
optimizer = CyclingOptimizer(
    target_segment=binder,
    constructs=[construct],
    generators=[generator],
    constraints=target_aware_filters,
    config=CyclingOptimizerConfig(num_steps=2, num_results=1),
    conditioning_fn=partial(
        condition_on_target,
        target_sequence=target_sequence,
        structure_tool="boltz2",
        tool_config={"use_msa": False},  # illustrative; choose the task's MSA policy
    ),
)
```

Supply either `conditioning_fn` or a built-in `pipeline`, not both. Use an explicit
starting binder pool so cycle initialization does not run inverse folding without
its structure. `target_aware_filters` must actually assess the proposed binder
with the fixed target and must have native threshold semantics; monomer pLDDT
alone does not answer the interface question. Choose thresholds for the task rather
than treating illustrative values as universal binding criteria.

## Verify before an expensive trial

- Confirm the predictor accepts the actual target/binder assembly and returns the
  expected chain mapping. Reject or explicitly remap chain changes using observed
  sequences; never silently concatenate the chains.
- Confirm inverse-folding inputs select only the binder (`chains_to_redesign`),
  preserve required positions, and return the binder alone (`output_chain_id`).
  Their names/numbering vary by adapter; inspect the live schema.
- Check one prediction-to-redesign-to-filter path, including file/artifact handling.
  A construction test with CPU substitutes proves wiring only, not model quality.
- Re-predict redesigned proposals when measuring them. The structure inherited from
  inverse-folding conditioning describes the generating input, not an independently
  predicted structure of the new sequence. Preserve that distinction in reports.

Cycling accepts filter-passing proposals; it does not inherently retain the best
weighted score at every step. Inspect trajectory distributions and failures. Avoid
confusing agreement between coupled predictors/generators with independent evidence.
Final comparison should retain the chosen evaluation settings; additional predictors
or configurations outside the optimization loop can test robustness where appropriate.
