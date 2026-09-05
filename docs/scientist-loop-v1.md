# Scientist loop v1

The experiment-level control spine is intentionally small:

1. Resume one GLM scientist session and its mutable `trial.py`.
2. Refresh the compact trusted lab-state index and assert the frozen contract.
3. Let the scientist inspect the direction-normalized hill-climb state and
   either edit any registered Proto composition or make an evidence-linked
   scientific stop decision.
4. Call `autofold_validate_trial`; repair safety, registry, allocation, or
   contract errors in the same session.
5. Call `autofold_evaluate_trial` to snapshot and execute the exact source, then
   receive the locked comparable result in the same session.
6. Interpret the result and update the scientist-owned `LAB.md` in that turn.
7. Checkpoint the iteration and deterministically append its trusted search
   observation and event mirror before the next context reload. Literature and
   skill refinement are optional operations, not iteration barriers.

The search state records only promotion-eligible optimize trials. It normalizes
score deltas so positive always means improvement, excludes controls and shadow
replays from the frontier, counts consecutive non-improving trials, tracks
generator-family coverage, and detects repeated semantic programs/workflows.
This state informs the scientist; it does not replace scientific judgment with
a fixed acquisition formula. The scientist may call
`autofold_stop_discovery` for a plateau, repeated-equivalent basin,
breakthrough, insufficient evidence, or a required contract change. Reaching a
requested iteration count is recorded separately as `iteration_limit_reached`,
not as false budget exhaustion.

The same decision packet carries an evaluator-calibration audit. The returned
`ProtoTrial` may declare `calibration_class` as `known_positive`,
`known_negative`, or `neutral`, plus the exact `replicate_of_trial_id`. These
non-promotable trials traverse the identical frozen scoring contract. The audit
reports pairwise ordering accuracy and the worst-case class separation margin;
one matched pair is preliminary and two independently recorded pairs per class
are required for supported calibration. This measures whether the objective is
useful before a long hill climb without turning computational separation into a
binding claim.

Autonomous discovery is a continuous durable loop, not a one-trial campaign
move. The API/CLI authorizes up to 100 trajectories by default, or the smaller
remaining campaign trial budget when one is declared. After every trajectory
the same scientist session reloads fresh execution and knowledge state and
chooses the next delta. The campaign plane interrupts only for an initial or
scheduled literature refresh, approval-required contract changes, a trusted
budget boundary, or the scientist's explicit stop. Deterministic trajectory
closeout already exposes every new result to the next iteration. Replay-gated
skill evolution runs after the authorized discovery horizon, so method learning
cannot repeatedly fragment or consume molecule-search authorization.
The unused trajectory authorization is carried explicitly through knowledge
refresh, capability refinement, shadow replay, and the resumed campaign job;
crossing a plane boundary can neither mint a fresh search budget nor discard
the remaining one. Each closeout also returns the stored `SearchObservation`
as its structured trajectory packet, linking execution, score delta,
generator/model provenance, and the knowledge-cycle ID.

The scientist records interpretations in `LAB.md`; trusted measurements remain
append-only database/OKF facts. The catalog includes a compute readiness probe,
and preflight rejects generator lanes that the active local or SSH profile
cannot execute. Exact validator checkpoint artifacts are rechecked at launch.
Structure predictors must set `use_msa: false` unless a future experiment
contract provides a content-addressed frozen MSA artifact. An implicit live
MMseqs2 query is mutable, unbounded external evidence and can block before GPU
execution, so it is not a comparable pipeline component.
`LAB.md`, `EVENTS.md`, and the scientist session identity are experiment-scoped
across durable jobs. Candidate allocation caps the candidates returned by a
lane; generator-native controls determine its internal search breadth and remain
agent-authored. GPU seconds bound lane execution time. Each generation artifact
records authored and effective output counts plus generator diagnostics so the
next iteration can distinguish internal search behavior from output allocation.
Each successful search observation also persists its parent trial, semantic and
workflow fingerprints, allocations, candidate sequences, model IDs, prior best
score, and direction-normalized score delta.

Proposal checkpoints also record the pinned scientist provider/model. Job
cancellation is propagated into both an active authoring prompt and a running
compute job, so a cancelled discovery job cannot keep spending author-model or
GPU budget in the background.

The tournament/acquisition layer is not part of this active loop. Deliberation
happens in the persistent scientist's reasoning; it is not a required typed
artifact or a harness scoring formula. Advisory student agents are deliberately
outside the current kernel and can be added later without changing the frozen
trial or trusted evaluation boundary.

Scientific freedom ends only at trusted boundaries: the scientist cannot mutate
the experiment target, evaluator, evidence adapter, seeds, budget, submission
size, or promotion rule. A requested change creates a separate experiment and
an approval boundary so within-experiment scores remain comparable.

The backend publishes a deterministic discovery benchmark beside the frontier.
It reports direction-normalized improvement, exact prior-evidence citations,
non-equivalent executable deltas, generator coverage, single-generator versus
portfolio observational baselines, and evaluator calibration. This benchmark
audits whether recursion happened; it never chooses the scientist's next move.
