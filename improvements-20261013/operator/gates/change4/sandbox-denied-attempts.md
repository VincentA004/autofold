# Change 4 sandbox-denied attempts

These initial checks were attempted in the default sandbox. Failures were environmental and occurred before the relevant assertions; the succeeding reruns are recorded separately in `validation.md`.

- Scientist CPU integration reached the worker supervisor, but `sysctl -n kern.boottime` returned `Operation not permitted`; the run ended with an unresolved receipt. After the parent authorized the CPU test launch requiring this read, the focused native declaration and two-evaluation tests passed.
- The Python multiprocessing socket test `test_long_run_path_allows_child_multiprocessing_socket` failed at Unix socket bind with `PermissionError: [Errno 1] Operation not permitted`. The offline worker generation suite then passed under the authorized unsandboxed test launch.
- A whole-checkout `git diff --check` reported an extra blank line at EOF in `backend/worker/autofold_worker/adapters/proto.py:287`, a separate concurrently edited file. No change was made there; the scoped Change 4 diff check passed.
