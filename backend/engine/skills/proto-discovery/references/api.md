# Inspect only the selected API

Use `PROTO_PYTHON` when supplied. The repository's `.autofold/envs/proto/bin/python`
is provisioned by infrastructure. Report import or readiness failures for repair;
keep installation, environment selection and compatibility patches outside trials.

Resolve skill-relative files from the absolute skill path advertised by Pi:

```sh
"$PROTO_PYTHON" /absolute/skill/scripts/inspect_proto.py environment
"$PROTO_PYTHON" /absolute/skill/scripts/inspect_proto.py search rfd4 --kind generator
"$PROTO_PYTHON" /absolute/skill/scripts/inspect_proto.py describe generator rfd4-redesign --schema
"$PROTO_PYTHON" /absolute/skill/scripts/inspect_proto.py describe optimizer cycling --schema
"$PROTO_PYTHON" /absolute/skill/scripts/inspect_proto.py describe tool protenix-prediction --schema
```

`environment` reports installed module paths and `Program.run`. Search returns bounded
metadata (`total_matches`, default 8 results, `--limit` at most 50). Narrow a truncated
query; an absent displayed item is not proof of absence. `describe --schema` returns
config fields plus implementation/input/output symbols, signatures and source paths.
Installation fields with provisioned defaults are omitted; the operator view retains
them. Scientific model/version and sampling fields remain explicit.
For an unresolved input/output contract, inspect its exact class:

```python
from proto_tools import ToolRegistry
spec = ToolRegistry.get("protenix-prediction")
print(spec.input_model.model_json_schema())
print(spec.output_model.model_json_schema())
```

The helper imports `model_generators.py`, `rfd4_redesign.py`, `complexa_generator.py`,
`antibody_generators.py`, `local_affinity.py` and `ligand_proposals.py`; no inference or installation runs.
Use `--extension` for another local registration. Authored Programs must still capture
and import their selected bridge: registry inspection is a separate Python process.
Native registries are `GeneratorRegistry`, `ConstraintRegistry`, `OptimizerRegistry`
from `proto_language.generator`, `.constraint`, `.optimizer`, and `ToolRegistry`
from `proto_tools`.

Start from a relevant [wiring example](examples.md) and selected schema. Read source
when a consequential semantic or unsupported field is unresolved, using targeted
ranges in the returned file/configured checkout. Use the provided model interfaces;
avoid recursive environment scans or reading the full catalog before authoring.
Construct the exact Program in the intended interpreter before a GPU launch.

Registry keys, dispatcher aliases and import symbols differ: `boltz2-prediction`
uses `predict_structures(..., "boltz2", config)`. Inspect chain selection, chemistry,
seeds, MSAs/templates and output units only for the selected handoff. Runtime/device,
worker batching and installed-path fields use infrastructure defaults.
Declared `tools_called` metadata does not count observed model invocations.
Registration/import proves neither assets nor model readiness.

## Execution and upstream references

Infrastructure owns local/remote placement and runtime selection behind scientific
model calls. Installed signatures govern scientific protocol differences.

- [Language source](https://github.com/evo-design/proto-language)
- [Tool source](https://github.com/evo-design/proto-tools)
- [Native cycling](https://proto.evodesign.org/docs/language/optimizers/cycling)
