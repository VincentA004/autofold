# Autofold bounded autoresearch v1

Autoresearch v1 is the first executable experiment-level RSI loop. Its only
agent-editable object is a proposed Proto `trial.py`; the target, experiment
contract, evidence adapter, evaluator, seeds, and budget remain frozen.

## Iteration

```text
fresh verified experiment context
→ child biology/ML/task session
→ one scoped draft trial.py
→ static source and workflow-manifest preflight
→ compile against the pinned Proto registry
→ immutable program hash and trial
→ sandboxed scientific run
→ trusted model evidence
→ locked score and promotion decision
→ refreshed context for the next child
```

The child receives the incumbent source, recent evaluations and diagnostics,
verified campaign OKF concepts, a small set of incumbent candidates, and a
compact catalog of relevant tools in the pinned Proto registry. Its filesystem
rules deny all mutations except the assigned draft. Child sessions and draft
files remain available for audit.

Preflight parses the Python AST without importing or executing the proposal. It
requires `build_program(bundle)` and a literal `AUTOFOLD_WORKFLOW`, requires the source to derive work from both
`candidateBudget` and `submissionSize`, permits only a small standard-library
and Proto import set, blocks obvious dynamic execution and direct file calls, and
rejects attempts to author trusted `evidence` or `generation` fields. The
workflow compiler then resolves registry tools, DAG dependencies, conditions,
and budgets before a trial is recorded.

## Command

```text
bun run research:cli -- autoresearch EXP_ID \
  --session SES_ID \
  --iterations 3 \
  --agent biology
```

Iterations are sequential and capped at ten. Rejected but valid trials do not
stop the loop: the next child sees the rejection and continues from the actual
incumbent. Authoring, preflight, or run failure stops the loop and is returned
as a structured iteration result.

## Current limits

- The local HTTP request remains open while the bounded loop runs; completed
  trials and child sessions make a stopped client resumable, but the controller
  itself is not yet a durable background job.
- Production structure-model execution still requires each selected
  proto-tools CUDA environment and model weights.
- Proto generation-tool calls are pinned indirectly by the immutable program
  hash. A future execution-receipt contract should preserve their native
  generation artifacts as deeply as predictor model-run artifacts are preserved
  today.
- Capability/skill refinement remains a separate loop. This controller consumes
  workflow knowledge and changes experiment programs and validation manifests.
