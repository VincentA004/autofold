# Autofold persistent scientist loop

Autofold's normal experiment recursion is one persistent GLM scientist,
one mutable `trial.py`, and a trusted execution boundary. The harness does not
choose a generator portfolio, rank prose strategies, or prescribe a workflow
permutation.

```text
latest trusted evidence + scientist notebook
                  ↓
       persistent scientist session
                  ↓ edits
       mutable trial.py → ProtoTrial
                  ↓
 contract assertion → AST/workflow preflight → immutable snapshot
                  ↓
        GPU execution → locked score
                  ↓
       trusted provenance/OKF evidence
                  ↓
      same scientist session continues
```

## Ownership

The scientist owns the hypothesis, falsification test, trial intent, Proto
program, generator/model composition, configuration, diagnostic DAG, routing,
and compute allocation. New source exports `build_trial(ctx) -> ProtoTrial`;
the returned object declares `optimize`, `calibrate`, `negative_control`, or
`shadow_replay`. Only optimize trials are promotion eligible.

The trusted harness owns the frozen experiment contract, target, evaluator,
evidence adapter, seeds, budget, submission rule, promotion decision, immutable
program snapshot, model artifacts, and locked score. Those constraints are
validated after every edit and cannot be changed from `trial.py`.

## Durable working state

Each autoresearch job uses one stable draft directory, while the scientist lab
belongs to the experiment so a new durable job does not reset its reasoning:

```text
.autofold/autoresearch/<experiment>/<job-or-session>/
  README.md         # operating guide and paths
  contract.json     # frozen contract and compute readiness
  FRONTIER.md       # deterministic empirical frontier view
  trial.py          # mutable scientist-owned program
  incumbent.py      # current locked comparison baseline
  lab-state.json    # small index, contract, and current failure
  latest-result.json # most recent settled result and diagnostics
  api/              # tested capability pages and examples
  skills.json       # active campaign skill references
.autofold/autoresearch/<experiment>/LAB.md
                    # mutable scientist-owned interpretation and next deltas
.autofold/autoresearch/<experiment>/EVENTS.md
                    # deterministic mirror of trusted completed trajectories
.autofold/autoresearch/<experiment>/scientist.json
                    # campaign-long scientist session identity and contract
```

The scientist session is resumed across validation repairs and empirical
iterations and durable jobs. It has read access for inspection and mutation
access to `trial.py` and its untrusted `LAB.md`. The initial prompt contains paths and invariants rather than an
inline encyclopedia. Full skills, artifacts, model catalogs, and evidence are
read on demand from the indexed state.

The scientist calls `autofold_validate_trial` after editing. Trusted AST,
contract, registry, workflow, allocation, and budget validation runs without
executing the draft; an exact compiler error returns as an ordinary tool result
to the same session for immediate repair. It then calls
`autofold_evaluate_trial`, which checkpoints the prepared proposal, snapshots
the exact source, launches or resumes the authorized worker run, applies the
locked evaluator and promotion rule, publishes trusted evidence, and returns
compact candidate/model diagnostics to the same session. There is no fixed total
authoring-attempt cap: changed drafts may continue until job cancellation or a
real resource boundary. Three identical program/error failures are treated as
stagnation. Program, semantic-AST, and workflow fingerprints remain provenance;
semantic reuse is not automatically rejected. Exact unchanged incumbent source
remains a no-op; prior non-incumbent workflows may be deliberately replicated.

Candidate allocation is executable search breadth. A lane allocated `N`
candidates is bounded to at most `N` optimizer samples/results, and the trusted
generation index records the authored and effective sample counts. GPU seconds
are a deadline, not a proxy for breadth: increasing time without requesting
additional samples does not explore more candidates. The scientist may put the
whole frozen candidate budget into one generator, split it unevenly, or compare
one candidate from several generators according to its current hypothesis.

Advisory specialist or student agents are outside the current empirical kernel.
They may later be added as optional readers without changing ownership of
`trial.py`, the frozen contract, or trusted execution.

The locked empirical packet returns directly to the scientist, which interprets
the run and updates `LAB.md` in the active tool turn. Trusted code then records
an idempotent search observation and `EVENTS.md` mirror without launching
another model. Literature and skill refinement are campaign-plane operations;
they do not interrupt every empirical step, and skill changes remain
replay-gated before activation.

Every iteration reloads experiment history, OKF knowledge, notebook cycles,
active campaign skills, run failures, candidates, locked scores, and predictor
diagnostics, then reasserts the original contract hash. A rejected or failed
program remains the mutable search head; the best comparable locked score
remains the independent incumbent.

## Command

```text
bun run research:cli -- autoresearch EXP_ID \
  --session SES_ID \
  --mode autonomous_discovery \
  --agent biology
```

The command creates a durable job with leases, cancellation, checkpoints, and
restart recovery. Autonomous mode defaults to a 100-trajectory authorization
and may stop earlier from evidence. `--iterations N` narrows that authorization;
`--mode single_intent` defaults to one. GPU runs remain exact-once through the
existing trial/run checkpoint boundary.

## Remaining simplification

Validation and empirical evaluation are inside the scientist tool loop. The
trusted outer job retains leases, exact-once checkpoints, cancellation, and the
authorized trajectory budget; it does not choose the scientist's program. A
sole active experiment bypasses campaign planning and receives the remaining
campaign trial budget, up to 100 trajectories, rather than one trajectory per
campaign step. Literature refresh and replay-gated skill refinement are
campaign-plane operations checked at the authorized discovery horizon or
another explicit plane boundary. Durable continuation then resumes the scientist
with refreshed knowledge or the replay-decided active skill.
