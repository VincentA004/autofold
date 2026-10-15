# Scoped native Proto lifecycle fork

This is an implemented Autofold-maintained dependency patch. Original dependency checkouts and V1–V3 source/evidence remain unchanged. The backend contains no vendored Proto executor.

`manifest.json` binds the original commits, reviewed patch bytes, reproducible clean fork commits, package digests and conformance fixture. `prepare.py` uses only local Git sources, refuses an existing destination, and installs nothing.

```sh
python3 tooling/upstream/proto-lifecycle/v4/prepare.py \
  --source /absolute/path/to/original/proto-language \
  --destination /absolute/path/to/fresh/source
PYTHONPATH=/absolute/path/to/fresh/source:/absolute/path/to/fresh/source/proto-tools \
  PYTHONDONTWRITEBYTECODE=1 CUDA_VISIBLE_DEVICES='' HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /absolute/path/to/existing/proto/python -B \
  /absolute/path/to/fresh/source/tests/language_tests/test_execution_lifecycle.py
```

Run the fixture inside the reproduced source tree: its subprocess tests deliberately resolve that source identity. The portable fixture is included to review/hash the patch; it has no `--root` option.

Actual public APIs are `proto_language.core.execution_observer.sampling_observation_scope` / `SamplingObserver`, `proto_tools.utils.execution_observer.request_observation_scope` / `RequestObserver`, shared `ExecutionControl`, and native `PortfolioProgram` / `PortfolioLane`. Sampling and request API versions are 1. `SCOPED_PROGRAM_GUARD_API_VERSION=1` guards Program.run/run_stage and Portfolio.run before any native state mutation. Construction scopes set `allow_program_execution=False`; entering them does not cancel control until an actual forbidden call.

Both observation scopes expose `HOSTED_PROCESS_FENCE_API_VERSION=1`. Disposable hosted workers use `require_scoped_calls=True, keep_unobserved_closed=True`. This irreversibly closes unobserved calls until process exit, including gaps between explicit scopes and after pure result publication. Later explicit managed scopes remain permitted. Raw threads cannot escape the fence; copied native contexts share one authority and expire on scope exit. Ordinary upstream unobserved/default execution keeps its original behavior.

Native PortfolioProgram has one immutable canonical lane tuple and a derived programs view. Its validate method checks actual Programs, optimizer instances, constructs, segments, generators and mutable constraint objects for cross-lane sharing before inspection and execution. It retains ordinary lane failures; BaseException cancellation/publication uncertainty stops siblings. Optimizer settings and native seeds remain unchanged.

Callbacks pair opaque tokens with exact sample/request and parent identities. Request origins report the actual cache branch; they are registered API observations, never physical inference counts. Native cache, retry, preprocessing, output handling and the configured registry backend execute once. Native-created model-request threads copy contexts. Cancellation remains cooperative at boundaries; a host process deadline is still required for blocking kernels.

Throwing failed callbacks preserve the exact original native exception/cancellation and cause while retaining callback loss as notes/objects and cancelling managed control. Completed publication loss raises ObservationPublicationError(BaseException). Forty-three CPU conformance tests cover these boundaries, concurrency, delayed raw threads, cache/retry parity and native portfolio identity. Three-seed/two-stage native CPU golden outputs match the original. No provider, GPU or network trials are claimed by this evidence. Full upstream pytest/Ruff/mypy tools are unavailable in the existing runtime; no install was performed.
