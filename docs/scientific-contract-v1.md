# Autofold scientific contract v1

This first scientific contract makes the target, candidate evidence, and
promotion score explicit and content-addressed. It is an execution and
verification substrate, not yet evidence that Autofold designs real binders.

## Target Artifact v1

`autofold.target-artifact.v1` contains canonical protein chains, a non-empty
binding-site residue set, and an optional PDB or mmCIF content hash. The backend
rejects duplicate chains, unknown binding-site chains, duplicate residues, and
positions outside the declared sequence. It stores the canonical JSON at:

```text
.autofold/targets/<sha256>/target.json
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

All evidence values are finite and bounded to `[0, 1]`. Model adapters are
responsible for mapping native outputs to these locked semantics. An agent may
choose models and parameters, but it cannot edit evidence after adapter
normalization.

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

## Current boundary

The repository includes a deterministic Proto integration fixture proving that
target hashing, candidate evidence, evaluator sensitivity, replay, and manifest
verification work end to end. Its evidence values are explicitly synthetic.
The next milestone is a real model adapter that produces the same candidate
contract from pinned structure-prediction outputs.
