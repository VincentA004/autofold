# Choose search from the available feedback

The scientist chooses successive trials; Proto searches within an authored procedure;
a model may also search internally. These are separate decisions, not mandatory
nested loops. Proto's autoregressive beam search is different from RFD4's trajectory
beam search. Model sampling, MCMC acceptance and gradient-softmax temperatures also
have different meanings.

Inspect the selected optimizer's signature/schema before construction:

| Optimizer | Useful feedback/design space | Controls and boundaries |
| --- | --- | --- |
| Rejection sampling | Independent proposals from a useful prior; screening | `num_samples`, `num_results`, `proposal_batch_size`; no feedback refinement between samples |
| MCMC | Scored local edits of existing candidates | Steps, proposals/trajectory, annealing; worse intermediate moves may be accepted |
| Genetic algorithm | Population diversity, useful recombination or multiobjective selection | Population/offspring size, mutation/crossover, survivor strategy; final result count is not population size |
| Cycling | Current predictions provide next-proposal conditioning | One target Segment/generator; `conditioning_fn` or built-in pipeline; constraints are threshold filters, so acceptance does not guarantee improvement |
| Gradient | Supported differentiable objectives and logits | Compatible providers/representation, learning rate and relaxation; arbitrary black-box calls cannot be backpropagated through |
| Beam search | Autoregressive partial-sequence generation | Compatible autoregressive generator, one target Segment, extension/beam/branch sizes; starts from its prompt rather than refining prior-stage survivors |

Choose by useful feedback, proposal locality and affordable diversity. Sequence
mutation, backbone redesign and prediction-conditioned proposals explore different
neighborhoods. Target-aware scoring does not itself make proposals target-conditioned.
A diagnostic or standalone assessment may need no optimizer.

## Match proposal and selection contracts

- Mutation generally needs a starting sequence. Mutable positions/rate define locality.
- Autoregressive sampling uses a prompt/prior and can replace existing sequences;
  inspect continuation semantics before composing stages.
- Inverse folding needs a credible compatible backbone, explicit mutable chains and
  fixed positions. Sampling temperature changes diversity, not guaranteed quality.
- `STARTING_SEQUENCE`, `STRUCTURE`, `PROMPT` and `LOGITS` are different input contracts;
  check the generator's actual `_sample` signature and initialization requirements.

Use [scoring](scoring.md) for filters, scalar preferences and Pareto selection.
NSGA-II does not imply crossover is useful: native GA can disable recombination when
unjustified. Conversely, scalar fitness can use population search. Multiple returned
metrics do not automatically create multiple objectives.

Fixed-backbone redesign tests sequence changes within a geometry. Prediction feedback
can supply new geometry and reinforce prediction error; resolve important contradictory
states before using them as conditioning. Population search can use attached structures
where supported; [cycling](cycling.md) describes that handoff without nesting a second
optimizer inside every genetic step. Choose complexity only when its feedback is useful.

## Allocate and account for work

Estimate cost from comparable receipts or one representative path. Allocate proposals,
controls, repeats and alternatives to decisions they could change. A small pool can
probe score variation without demonstrating an algorithm's advantage. Compare
consequential strategies under common assessment/resources rather than running all.

Use cheap filters before expensive calls where supported. Batching changes memory
and throughput, not sample independence. Track proposals, model invocations, failed
attempts, survivors and measured time separately; a stage/step can contain many calls.
Several objectives can share one prediction as described in [scoring](scoring.md).

For multistage Programs, share the intended Segment/Construct objects and use fresh
per-stage generator/constraint instances where required. Verify actual evaluated
coverage after constructors initialize/resize pools. Program seeds organize native
RNG streams but may not control external callbacks, models or hardware; record the
actual seed support. Keep algorithmic acceptance distinct from the campaign's
[promotion decision](science.md#promotion-and-claims).
