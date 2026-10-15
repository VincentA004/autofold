# Native Proto model registry

Implemented October 10, 2026 in the main checkout. This is a scientific metadata projection of the existing native ToolRegistry and GeneratorRegistry. Proto continues to own model execution and composition. Autofold owns frozen experiment contracts, admission, provenance and evidence settlement. Procedural skills advise model selection; they do not redefine adapter capabilities or execution authority.

## Information and access

The worker's `proto_model_registry.py` extracts public Pydantic schemas, declared metric units/directions, categories, entity types, source links, toolkit license declarations and seed fields without calling model functions. Config defaults and examples are omitted. Tool keys/categories remain native identities; generators retain their tools-called references. Tool or generator cards cannot be attached to another native identity.

`ProtoModelRegistry.snapshot` validates and sorts cards, rejects duplicate kind/key identities and hashes the entire inventory plus native language/tools commits and worker hash. Snapshots are bounded to 512 cards and 4 MiB. Registration is separate from readiness: checkpoint asset availability, checkpoint license rights and measured hardware resource profiles remain explicitly unknown/unverified. The current pinned runtime metadata check found 133 total tools and 18 generators, with 92 scientific cards; some represent non-protein biology. These are registered definitions, not a claim that 92 inference models are installed or usable on the GPU.

`ScientificExecution.modelRegistry()` caches metadata per execution instance and checks native source pins. No Proto configuration produces an empty inventory with null provenance. `GET /research/model-registry` exposes the complete inventory under existing host/origin/authentication restrictions. The scientist receives a compact inventory, a read-only `MODEL_REGISTRY.json`, and bounded `read_model_card` pages with exact identity and registry hashes. Detailed schema disclosure is intentional: full metadata in this runtime is approximately 1.5 MB and would overwhelm ordinary model context.

## Pipeline compatibility

Native schema support and scoring-bridge preservation are different axes. Current structure-prediction scoring constructs protein sequences/complex sequences; it does not preserve explicit cyclic/disulfide bonds, modifications, glycans, supplied MSAs or templates. Schema presence alone is not evidence of chemistry fidelity. A generic covalent-bond field is not reported as proven disulfide support. Boltz-2's affinity head is identified as a small-molecule/protein prediction role; it is not presented as a calibrated peptide binding scorer.

An author can declare:

```python
DiagnosticStage(
    id="complex_check",
    tools=("boltz2-prediction",),
    configs={"boltz2-prediction": {"use_msa": False}},
    required_input_features=("complex_sequences",),
)
```

The declaration survives native inspection, compilation and the frozen diagnostic round trip. All selected adapters must preserve declared features; unknown support fails the requirement. `first_available` filters incompatible adapters before choosing one. The worker independently checks the same features before invoking any stage model function. A requirement for `cyclic_bonds` currently fails rather than silently falling back to linear sequence prediction.

Legacy plans without explicit requirements remain compatible, including their fingerprints and immutable scoring configuration. This is a capability declaration/gate, not automatic chemical-identity validation. A future chemistry-preserving lane still needs molecular identity, bond/stereochemistry round-trip tests and separately assessed execution support. Model assets, measured runtime/VRAM profiles, exact checkpoints, calibration and geometry-based agreement remain separate work.

## Procedural knowledge

Keep existing BioNeMo-derived capsule provenance intact. Additional candidates and test/license evidence are documented in [biology skill sources](../research/biology-skill-sources-2026-10-10.md). The first recommended adaptations concern experimental design, target constructs/epitopes, comparative evidence, and measurement units/uncertainty. The source research does not install or activate any new skill; adoption should preserve attribution and use existing controlled replay policy.

## Verification

Registry/compiler tests cover deterministic source-bound hashes, duplicate and identity rejection, bounded full-card/schema paging, unsupported/unknown adapter requirements, first-compatible selection and unchanged legacy plans. Worker tests cover default/example redaction, truthful missing asset/license/resource information, native-versus-adapter distinctions, diagnostic round trips and rejection before any model function or output creation. Integration checks inspect the actual pinned native runtime and expose read-only registry metadata through scientist and HTTP interfaces, with no new jobs, runs, trials or SDK sessions. Both backend typechecks passed. The offline suites passed 547 TypeScript tests and 79 worker tests, with two optional skips in total. The final registry/compiler checks passed 20 tests and native scientist/HTTP checks passed two. Six historical workspaces retained identical records/files (10 databases, 6,401 files). Exact source and log hashes are recorded in the [implementation audit](proto-model-registry-verification-2026-10-10.json). No protein inference, GPU validation or installation is part of this change.
