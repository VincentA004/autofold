# Remote compute v1

Autofold can execute a frozen research run on an SSH-accessible GPU host while
the local control plane remains authoritative. The boundary is deliberately
narrow:

```text
local immutable bundle + inputs + source-hashed worker
  -> SSH staging
  -> remote worker and model execution
  -> artifact retrieval
  -> local schema, identity, commit, and content-hash verification
  -> locked evaluation recorded in campaign knowledge
```

The same `bundle.json` bytes run locally and remotely. Program, target, and
structure paths are relative to that bundle. The Proto checkout path is a host
setting, while the language and proto-tools commits remain frozen in the
bundle and are verified by the worker before execution.

## Configuration

Local execution remains the default. To select an SSH alias:

```text
AUTOFOLD_RESEARCH_COMPUTE=ssh:workstation_4090
AUTOFOLD_RESEARCH_REMOTE_ROOT=/home/vincent/.autofold-runtime
AUTOFOLD_RESEARCH_REMOTE_PYTHON=/home/vincent/autofold-env/bin/python
AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT=/home/vincent/proto-language
```

The Python environment and Proto repositories must already be installed on the
host. Autofold verifies the pinned Proto commits; it does not silently update
them. The SSH alias must use non-interactive authentication.

Each run is staged into
`<remote-root>/runs/<run-id>`. The remote directory must not already exist.
After the compute job succeeds, Autofold retrieves only its `output` tree,
rejects symbolic links and unsupported file types, and then applies the same
deep verification used for a local run. Remote outputs never become campaign
knowledge merely because the SSH process exited successfully.

## Current boundary

- SSH aliases and scheduler-free hosts are supported.
- The remote environment is provisioned out of band.
- Remote run directories are retained for audit and require explicit cleanup.
- Slurm/PBS staging, resumable transfers, host health checks, environment
  manifests, and product UI configuration are later increments.
