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

The mutable source follows a Karpathy-style lineage. Autofold copies the latest
attempted optimize trial—not merely the best-scoring incumbent—into the next
draft. The author receives both programs: the search head is the code to repair,
branch, or revert, while the incumbent remains the locked promotion baseline.
Rejected and failed trials therefore remain productive points in the program
lineage instead of disappearing after their score or exception is recorded.

Each live iteration reloads experiment history and campaign knowledge after the
preceding scientific run. The next child therefore receives a compact recent
trajectory containing promoted and rejected candidates, locked evaluation
diagnostics, predictor-level model evidence, and terminal run failures. A
durable contract-lock checkpoint pins the experiment ID and contract hash at
job start; every refreshed context must retain that exact hash, including after
process restart. Shadow replay remains the deliberate exception: it uses one
frozen context snapshot for paired comparability while enforcing the same lock.

Preflight parses the Python AST without importing or executing the proposal. It
requires `build_program(bundle)` and a literal `AUTOFOLD_WORKFLOW`, requires the source to derive work from both
`candidateBudget` and `submissionSize`, permits only a small standard-library
and Proto import set, blocks obvious dynamic execution and direct file calls, and
rejects attempts to author trusted `evidence` or `generation` fields. The
workflow compiler then resolves registry tools, DAG dependencies, conditions,
and budgets before a trial is recorded.

Each iteration also receives an evidence-derived, advisory search policy. The initial move set is
`exploit_incumbent_family`, `explore_generator`, `workflow_ablation`,
`investigate_predictor_disagreement`, and `reallocate_compute`. The policy
suggests a generator portfolio and per-generator candidate/GPU allocation. The
program author can select another registered composition when the trajectory
supports it; the trusted compiler records the actual portfolio, allocations,
program fingerprint, and workflow/config manifest. Multi-generator Proto programs must declare one
allocation and one assigned generator lane per generator; both the TypeScript
compiler and trusted worker reject budget drift or candidate attribution that
exceeds a lane's allocation.

The trusted preflight records an exact program hash, a formatting-insensitive
Python AST fingerprint, and a normalized workflow-DAG fingerprint. Exact or
semantically equivalent repeats stop before another GPU run. Scientific GPU
failures are published as evidence and do not by themselves terminate the
lineage: the next iteration reloads the failed workflow, exception, current
skills, and knowledge and can repair it or explore another arm. Plateau stopping
is considered only after the registered binder arms have evidence. Exhausting
the requested iteration budget is recorded separately from authoring failure.

## Command

```text
bun run research:cli -- autoresearch EXP_ID \
  --session SES_ID \
  --iterations 3 \
  --agent biology
```

The command returns a durable `job_...` record immediately. Use `job watch
JOB_ID` to follow it. Iterations are sequential and capped at ten. Rejected,
invalid, and failed scientific trials update the next search context. Authoring
or preflight failure remains terminal because no trusted executable trial was
created.

## Current limits

- The controller is a leased, persisted background job with heartbeat, bounded
  retry, cancellation, and restart recovery when the workspace is next opened.
  Proposals, trials, runs, iteration outcomes, and the frozen contract lock are
  checkpointed. Child-session creation remains the final at-least-once boundary.
- Production structure-model execution still requires each selected
  proto-tools CUDA environment and model weights.
- Proto generation calls are pinned by the immutable program, frozen generator
  declarations, explicit lane allocations, and worker-observed generation-run
  artifacts. Native generator subprocess receipts can still be made richer.
- Capability/skill refinement remains a separate loop. This controller consumes
  workflow knowledge and changes experiment programs and validation manifests.
