# Refactor checkpoint — 2026-10-15

This is a preservation checkpoint before reconsidering or rebuilding the architecture. It is not a release or a claim of readiness for autonomous discovery. No rebuild is included in this checkpoint.

## Preserved implementation

The working tree replaces the legacy OpenScience CLI backend with the science-core and engine packages, integrates Pi sessions and native Proto execution, and includes the accumulated worker, SDK, UI, documentation and behavioral-test changes. Existing deletions are intentional parts of that working tree and are preserved as-is.

## Latest live result

The isolated `prj_full_gpu_discovery_20261014` campaign completed four of 24 requested GPU trials: two baselines and two memory-informed followups. All four original remote worker receipts report successful exits. A read-only observation on 2026-10-15 at 16:00:44 UTC found no processes belonging to that run and no GPU compute processes. The local controller was also absent.

Fifth-slot authoring reached its model-turn limit without another GPU dispatch. The parent job completed at 2026-10-15T03:47:12.266Z with a `deferred` / `runtime_limit_reached` result and 20 remaining trajectories, while its durable job status was `succeeded`. No automatic continuation was created. The observer last wrote at 2026-10-15T07:41:56.158Z. The controller did not leave a final driver-exit or full acceptance audit; its disappearance is not attributed to a cause by this checkpoint.

The run made 221 settled model calls, including 79 summarization calls and 55 completed context-compaction events. New SDK-estimated cost was $2.008088616 and reported inference cost was $1.3698919804. Including previous attempts, the respective cumulative costs were $4.864821084 and $3.20094040836. Neither $10 ceiling nor the 512-fresh-request allowance was exhausted. The absolute authorization expired at 2026-10-15T14:42:32.748Z; no restart or new spending is included here.

## Known gaps

- Custom context restoration retains large current scientific messages around a 48,000-token input ceiling. Recent compactions left only 378 tokens of calculated continuation headroom, causing repeated reads and summarization.
- The persistent session carries authoring-gate history into discovery. Phase instruction lifetime and resulting confusion require investigation.
- Automatic campaign continuation explicitly excludes runtime-limit outcomes, even with unused campaign trajectories and global authorization.
- Handler completion, deferred scientific outcomes and observer completion use different terminal conditions. Incomplete campaigns need a truthful, durable closeout.
- Earlier offline recovery qualification did not establish sustained, token-efficient live discovery. Do not interpret historical passing tests as full live acceptance.

## Evidence locations

The committed independent status observation is:

`.autofold/cohesive-engine-refactor-20261012/full-gpu-discovery-20261014-launch-final/operator/independent-status-20261015T1601Z.json`

The frozen operator source is committed at:

`.autofold/live-gpu-full-20261014/driver-src/driver.ts`

`.autofold/live-gpu-full-20261014/driver-src/supervision.ts`

Full raw evidence remains locally in the ignored `.autofold/` tree, including the campaign root above, earlier failed attempts, provider receipts, session databases, GPU artifacts and offline qualification outputs. Those raw files have not been deleted, rewritten, or mass-added to Git. The small committed observation is a status snapshot, not a substitute for raw evidence or a passing acceptance report.

## Checkpoint verification

No fresh inference, GPU work or full test rerun was performed merely to create this checkpoint. Candidate credential-pattern matches were inspected and were offline-test placeholders. `git diff --check` reported an existing extra blank line at EOF in `backend/worker/autofold_worker/adapters/proto.py`; it is preserved as-is.
