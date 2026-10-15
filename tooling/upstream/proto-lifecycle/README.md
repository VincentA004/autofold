# Scoped Proto lifecycle fork

The current reviewed hardening revision is [v2](v2/README.md). The original
recipe and evidence below remain preserved for exact version recovery.

This directory contains an implemented and CPU-tested local dependency patch.
It is an Autofold-maintained fork, not an API already present in upstream Proto.
No library source is vendored into the backend. Original checkouts, worker trees,
GPU profiles, scientific receipts and provider billing remain unchanged.

`manifest.json` binds original commits, patch bytes, reproducible fork commits,
executable package digests and the conformance fixture. `prepare.py` clones only
local sources into a fresh destination, verifies both bases, applies the reviewed
patches, commits with reproducible metadata and checks the originals again. It
refuses an existing destination. It installs nothing and performs no network,
provider or GPU operations.

```sh
python3 tooling/upstream/proto-lifecycle/prepare.py \
  --source /absolute/path/to/original/proto-language \
  --destination /absolute/path/to/fresh/local/source
PYTHONDONTWRITEBYTECODE=1 /absolute/path/to/existing/proto/python \
  tooling/upstream/proto-lifecycle/test_lifecycle.py \
  --root /absolute/path/to/fresh/local/source
```

The native public APIs are:

- `proto_language.core.execution_observer.sampling_observation_scope` and
  `SamplingObserver`, with `SCOPED_SAMPLING_API_VERSION = 1`.
- `proto_tools.utils.execution_observer.request_observation_scope` and
  `RequestObserver`, with `SCOPED_REQUEST_API_VERSION = 1`.
- Shared `ExecutionControl` with explicit cancellation or a finite monotonic
  deadline; `ExecutionCancelled` derives from `BaseException` so capture mode,
  ordinary retries and portfolio lane failure handling cannot absorb it.
- `proto_language.core.PortfolioProgram` / `PortfolioLane`, executing independent
  native Program lanes serially, preserving optimizer settings and seeds,
  retaining ordinary lane failures and propagating cancellation immediately.

Each admitted lifecycle carries exact object/request identity, parent identity
and an opaque token paired with one completion or escaping failure. Sampling
completion follows the entire original base orchestration, including tied
segments and stale metadata cleanup. A request completion carries the final
public output; a captured `success=False` output is still a completed request.
Request origin describes the actual registry branch (full/partial/missing/disabled
cache or external backend), never physical inference counts or billing.

The registry keeps its original backend, cache, dedup, preprocessing, retry and
postprocessing path. Observation does not redispatch or replace methods. Native
ToolPool partitions already copy contexts; paired MMseqs threads now do so too.
Other native threads only pump I/O, heartbeat or progress, or run standalone
internals encompassed by the parent registered request.

Fresh hosted execution must opt into `require_scoped_calls=True` on both scopes,
share one `ExecutionControl`, and supply thread-safe authoritative admission and
receipt callbacks. Unpropagated thread calls then fail before normalization or
sampling; copied contexts share authority and expire when their owner exits.
Ordinary unobserved upstream use retains its existing behavior. Cancellation is
cooperative at effect boundaries; the host must retain a process deadline for an
already-running blocking kernel. Custom generators must preserve the public base
`sample()` method and implement `_sample()`.

Worker adoption is a separate gated change. It must require these actual API
versions and new source identities, preserve original request semantics, select
native portfolios explicitly, and retain historical frame/portfolio compatibility
only for old pinned sources. CPU conformance covers native ToolPool and MMseqs
thread paths using offline fixtures, concurrent token pairing, cancelled/expired
scopes, cache/dedup/preprocess/retry parity, failed output capture, tied segments,
real optimizer results and portfolio failures. `golden_cpu.py` also compares the
original and patched native two-stage optimizer results/settings across seeds.
