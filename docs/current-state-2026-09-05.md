# Autofold current state — 2026-09-05

This is the canonical handoff snapshot for the agent-native discovery backend.
It separates implemented behavior, live computational evidence, and remaining
product gaps. Runtime acceptance is not biological validation.

## Canonical design documents

Read these in order:

1. [`../autofold.md`](../autofold.md) — product hierarchy, recursive loops, and
   scientific invariants.
2. [`scientist-kernel-v2.md`](scientist-kernel-v2.md) — minimal persistent-agent
   kernel and trusted state boundary.
3. [`scientist-loop-v1.md`](scientist-loop-v1.md) — executable hill-climb and
   stopping semantics.
4. [`scientific-contract-v1.md`](scientific-contract-v1.md) — frozen target,
   evidence, evaluator, and promotion contract.
5. [`peptide-pipeline-v2.md`](peptide-pipeline-v2.md) — generation and
   multi-predictor execution plane.
6. [`knowledge-plane-v1.md`](knowledge-plane-v1.md) — OKF projection,
   hypotheses, claims, and search observations.
7. [`recursive-orchestration-v1.md`](recursive-orchestration-v1.md) — campaign
   boundaries around the persistent experiment scientist.

`autoresearch-v1.md` is the operator/compatibility guide. New trials use
`build_trial(ctx) -> ProtoTrial`; `build_program`, `AUTOFOLD_TRIAL`, and
`AUTOFOLD_WORKFLOW` are migration surfaces only. The dated August acceptance
documents remain historical evidence rather than descriptions of the current
kernel.

## Implemented system

### Orchestration plane

- One persistent research-model session owns one mutable `trial.py` for a frozen
  experiment and can perform multiple sequential empirical evaluations in one
  turn.
- The scientist chooses its hypothesis, intent, generator or composite
  portfolio, native model configuration, diagnostic DAG, routing, and compute
  allocation. The harness does not impose a search-move enum or rank a fixed
  portfolio menu.
- Validation, evaluation, and evidence-linked stopping are tools inside the
  scientist turn. Actionable construction or registry errors return to the same
  session for repair.
- Durable jobs retain leases, cancellation, phase checkpoints, restart recovery,
  and exact run reconciliation.
- Campaign orchestration handles plane boundaries: literature alignment, skill
  refinement and replay, contract approval, budget, and campaign stop.
- All Autofold-originated inference is pinned by research-model policy to
  `openrouter/z-ai/glm-5.3-flash`; it does not inherit the interactive UI model.

### Execution plane

- New programs return one `ProtoTrial` from `build_trial(ctx)`.
- `ProtoPortfolioProgram` composes independently executable
  `ProtoPortfolioLane` objects. Candidate and GPU-second allocation are derived
  from the executable object graph and rechecked by the worker.
- The trusted compiler injects the frozen scoring pipeline. Agent-authored
  `DiagnosticStage` objects may probe disagreement or route candidates but
  cannot change the authoritative score.
- Registered generation lanes include BoltzGen, RFdiffusion3/ProteinMPNN,
  PXDesign, and FreeBindCraft when their isolated runtimes are ready.
- Trial Bundle v4, Generation Run Index v1, and Model Run Index v2 bind candidate,
  generator, configuration, replicate, model, seed, artifact, and runtime
  provenance.
- Local control with SSH execution on `workstation_4090` has completed real GPU
  generation and Boltz2/Chai1 validation. Protenix v2 also has independent
  runtime acceptance, although it was not part of the latest frozen scoring
  contract.

### Knowledge plane

- The transactional research store is authoritative. Campaign-scoped OKF v0.2
  Markdown is a readable projection.
- Every settled empirical trajectory can publish a typed hypothesis outcome,
  locked result or failure, search observation, generator/model diagnostics,
  knowledge-cycle provenance, and next scientific uncertainty.
- `events.jsonl` is the canonical experiment-local empirical feed.
  `scientist.json` is the total durable scientist-state register. `LAB.md`,
  `EVENTS.md`, frontier pages, and OKF pages are derived or interpretive views.
- Literature sources, proposed claims, run outcomes, and claim-to-outcome
  alignments remain distinct evidence types.
- Domain skills are immutable campaign versions initialized from five
  BioNeMo-derived version-1 capsules. Candidate revisions require paired,
  non-promotable shadow replay before activation.

## Latest full GPU recursion

- Campaign: `cmp_4c4cc98bfff64a659d0a4aa91c157277`
- Experiment: `exp_7ef2e862c35143268de04f0771b7327e`
- Durable job: `job_1660c0e83d3c434eae913991d2178f17`
- Frozen contract:
  `sha256:45ca51c48faf2063ec109119508cbfe743b40a1bfece8dc1f28eba9169b5c75a`
- Author model on all four trajectories:
  `openrouter/z-ai/glm-5.3-flash`
- Worker: `workstation_4090`
- Coverage: four successive trials, six candidates per trial, two scoring
  predictors, and two frozen seeds; all 96 model decisions completed.

| Iteration | Program | Locked score | Decision |
| --- | --- | ---: | --- |
| 1 | BoltzGen disulfide hairpin | 0.2093853343 | rejected |
| 2 | intentional BoltzGen cyclic replicate | 0.2063861770 | rejected |
| 3 | RFdiffusion3 → ProteinMPNN diversity repair | 0.2362814212 | rejected globally; improved its family baseline |
| 4 | third BoltzGen cyclic draw | 0.1606164903 | promoted |

The best individual candidate was `TAGTLTFDGVTFTSS`, with candidate loss
`0.1517633511`. The promoted three-member panel also contains
`MSVTLTLPDGRVINL` and `KVTLTLPDGKTVLLG`.

The strongest scientific finding was not merely the new minimum. Three nominally
equivalent BoltzGen cyclic programs produced scores `0.1606`, `0.1718`, and
`0.2064` despite identical recorded generator seeds. BoltzGen upstream
stochasticity is therefore not controlled by the current provenance seed, and
single-draw topology rankings are not reliable. Replicate distributions must be
used until the upstream boundary is controlled.

The same run showed that independent RFdiffusion backbones restored panel
diversity and improved that generator family from `0.2991` to `0.2363`, while
remaining weak under Chai1. That is useful negative evidence for allocation,
not a global promotion.

The durable runtime evidence remains under:

```text
/Users/vincentallam/Developer/autofold/.autofold/
```

In particular, the experiment `LAB.md`, `events.jsonl`, immutable trial sources,
run artifacts, and campaign OKF bundle are not committed to Git.

## Verification at this snapshot

- 279 backend tests passed, including 231 research, compute, and
  session-routing tests.
- 31 worker tests passed.
- Backend TypeScript typecheck passed.

These checks were re-run after the documentation consolidation in this branch.

## Remaining gaps, in priority order

1. **Evaluator calibration.** No trusted known-positive/known-negative pair has
   been run under the active contract. Computational ranking is therefore
   uncalibrated against a meaningful control ordering.
2. **Stochastic replicate semantics.** BoltzGen must expose controllable upstream
   RNG or be treated explicitly as a distributional generator with replicate
   budgets and basin-level statistics.
3. **True simultaneous portfolio acceptance.** The executable composite exists
   and historical campaigns cover multiple families, but the latest autonomous
   job moved between single-family programs rather than executing a simultaneous
   multi-generator portfolio. PXDesign remains untested under this contract.
4. **Derived-view closeout.** Job-local `FRONTIER.md` and `lab-state.json` can
   retain the pre-final-evaluation snapshot. The canonical event log and
   experiment `LAB.md` are current, but every operator-facing view should receive
   a deterministic final closeout refresh.
5. **Fingerprint semantics.** Narrative/source details can make intentional
   same-workflow replicates appear semantically different even when the workflow
   fingerprint is identical. Configuration-family identity and empirical
   replicate identity need separate first-class fields throughout the benchmark.
6. **Knowledge result reporting.** Some completed job result summaries omit
   `knowledgeCycleId` and `searchObservationId` even when the durable event and OKF
   records contain them.
7. **Evidence use.** Only 25% of measured transitions in the current discovery
   benchmark cite exact prior evidence. The scientist prompt and benchmark should
   reward precise empirical lineage without constraining scientific choice.
8. **Skill replay throughput.** Predictor-disagreement feedback is recurring, but
   the relevant candidate skill is already awaiting shadow replay. Refinement
   must close or reject pending candidates instead of accumulating feedback.
9. **Campaign resource accounting.** One campaign-wide ledger should cover
   discovery, literature, refinement, replay, and GPU execution without minting
   fresh budget at plane transitions.
10. **Benchmark and biological validation.** The agentic loop still needs matched
    fixed, greedy, random, and literature-naive baselines, followed eventually by
    physical assay observations. Current results are computational evidence only.

## Next implementation slice

Close gaps 4–6 first because they make every later experiment easier to trust:
atomically refresh all derived views after final trajectory closeout, separate
configuration-family and replicate fingerprints, and return committed knowledge
IDs through every job/API result. Then run one bounded simultaneous portfolio
acceptance and one trusted calibration pair before expanding the campaign horizon.
