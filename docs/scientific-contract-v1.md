# Autofold scientific contract v1

This first scientific contract makes the target, candidate evidence, and
promotion score explicit and content-addressed. It is an execution and
verification substrate, not yet evidence that Autofold designs real binders.

## Target Artifact v1

`autofold.target-artifact.v1` contains canonical protein chains, a non-empty
binding-site residue set, and an optional PDB or mmCIF content hash. When a
structure is declared, the backend requires its bytes, verifies that hash, and
stores the immutable blob beside the target JSON. The backend
rejects duplicate chains, unknown binding-site chains, duplicate residues, and
positions outside the declared sequence. It stores the canonical JSON at:

```text
.autofold/targets/<sha256>/target.json
.autofold/targets/<sha256>/structure.cif  # or structure.pdb
```

The hash of that exact file is frozen into the experiment contract and copied
into every scientific run bundle and manifest.

## Peptide Candidate Artifact v1

Scientific candidate sets use `autofold.candidate-set.v2`. Every candidate has:

- canonical sequence, modality, and seed;
- generator identity, version, parameter hash, and output artifact hash;
- interface confidence, fold confidence, predictor agreement, and solubility;
- aggregation and synthesis risk;
- one or more versioned predictor artifact hashes.

All evidence values are finite and bounded to `[0, 1]`. Trial Bundle v4 is the
current scientific path. Agent-editable Proto returns only unscored candidates,
while a source-hashed, worker-owned evidence adapter executes the frozen scoring
pipeline and maps native outputs to these locked semantics. A trial that tries
to provide its own generation provenance or evaluator evidence is rejected.
The adapter identity, version, and source hash are frozen in the experiment
contract, so changing normalization or model integration starts a new experiment.

Each current native model invocation produces `autofold.model-run.v2` with the
frozen target hash, peptide sequence hash, stage, model and adapter versions,
proto-tools commit, parameters hash, seed, metrics, runtime cost, parent links,
and output hashes. Model Run Index v2 links every required completed or legal
skipped decision to its artifacts. Finalization verifies all hashes, coverage,
dependencies, skip reasons, and candidate predictor references. Model Run v1
remains readable for older Trial Bundle v3 lineage.

## Locked peptide panel v1

`peptide-panel@1` is deterministic, network-free, and lower-is-better. It first
applies fixed eligibility gates, then ranks eligible candidates using:

```text
candidate loss =
  0.30 × (1 - interface confidence)
  0.20 × (1 - fold confidence)
  0.15 × (1 - predictor agreement)
  0.15 × (1 - solubility)
  0.10 × aggregation risk
  0.10 × synthesis risk
```

The submitted panel score is:

```text
0.75 × mean candidate loss
+ 0.10 × diversity penalty
+ 0.10 × missing-yield penalty
+ 0.05 × duplicate penalty
```

This deliberately rewards a reproducible panel rather than one lucky peptide.
Changing weights, gates, or evidence normalization requires a new evaluator
version and therefore a new experiment contract.

## Current implementation boundary

The active experiment freezes its scoring pipeline and evidence-adapter source
hash. The accepted production path dispatches registered Boltz2 and Chai1 tools
through proto-tools for every candidate and frozen seed; other contracts may pin
a different complete scoring lane. Protenix v2 can be composed as a diagnostic
or frozen into a new scoring contract. The deterministic fixture adapter
exercises the identical trust and artifact path in CPU-only tests; its values
and structures are explicitly synthetic.

Actual model inference requires isolated GPU environments, pinned weights, and
CUDA compute. The local acceptance suite does not pretend a CPU fixture is
biological validation. Boltz, Chai with ESM enabled, and Protenix v2 have passed
runtime acceptance on the 4090; experimental assay ingestion and biological
calibration remain later contract versions.
