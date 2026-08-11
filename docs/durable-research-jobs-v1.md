# Durable research jobs v1

Autofold runs long control-plane operations outside the HTTP request that
created them. Autoresearch and campaign knowledge refresh are persisted in the
same atomic project store as campaigns, experiments, trials, runs, and claims.

```text
queued -> running -> succeeded
             |  \-> retry_wait -> running
             |  \-> failed
             \----> cancelled
```

Each claim has a unique lease, expiry, heartbeat, attempt count, and bounded
retry budget. An expired lease is recovered when the workspace is next opened.
An idempotency key returns the original job for an identical payload and rejects
reuse with a different payload. Late results cannot overwrite cancellation.

Long operations also carry immutable phase checkpoints. Autoresearch records
the initial experiment contract lock, each completed agent proposal, scientific
run identity, and iteration outcome. It reloads evidence and campaign knowledge
between iterations but rejects any refreshed context whose contract hash differs
from the durable lock.
Trials carry the originating job and iteration identity, so replay reuses the
same trial and reconciles its existing run instead of submitting another GPU
job. Literature refresh records the completed child proposal; knowledge-cycle
ingestion is idempotent by that child identity.

```text
bun run research:cli -- jobs
bun run research:cli -- job get JOB_ID
bun run research:cli -- job watch JOB_ID
bun run research:cli -- job cancel JOB_ID
bun run research:cli -- job retry JOB_ID
```

The current store is a schema-validated, lock-protected, atomic project record.
It deliberately remains the single source of truth. SQLite becomes useful when
multiple server processes must claim jobs concurrently, query large histories,
or migrate records independently; adopting it before those requirements would
create two persistence models without improving correctness.

Scientific GPU execution keeps its separate durable `Run` lifecycle. A research
job orchestrates the recursive control loop; a run records one immutable worker
submission and its verified artifacts.

## Boundary

Domain commits and scientific run submission are replay-safe. The remaining
at-least-once boundary is child-agent creation: the process can stop after a
session is created but before its completed proposal is checkpointed. Closing
that last gap requires deterministic child-session creation keys in the donor
harness. It does not duplicate locked evaluations or GPU runs.
