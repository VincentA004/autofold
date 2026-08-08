# 4090 execution acceptance — 2026-08-08

This snapshot records runtime acceptance, not biological validation.

## Accepted paths

- The trusted Trial Bundle v4 path completed RFdiffusion3 → ProteinMPNN →
  Generation Run Index v1 → Boltz evidence → locked evaluation. The generation
  artifact and generated structure were content-addressed in the final manifest.
- Chai completed with ESM embeddings enabled and `low_memory=True` after WSL was
  raised from its default 8 GB allocation to 12 GB RAM plus 16 GB swap.
- Protenix package `2.0.0` completed with `model_name=protenix-v2`. The checkpoint
  SHA-256 was `8f931f9774a396b67033d0e58628e1834f4a1448165e04254b40a780b0c0d599`.
- BoltzGen `0.3.2` at commit `a3149cf18eeb58648d1abbb27539bd73f746cdda`
  completed its five-stage peptide-binder pipeline for one design. The strict
  refolding filter rejected that one sample; this is a model outcome, not an
  execution failure.
- PXDesign at commit `f788441313c84c3074fe9596ac2433f96b15c763`
  completed its seeded 400-step preview pipeline: diffusion, ProteinMPNN sequence
  design, AF2 complex validation, AF2 monomer validation, and ranking. Autofold's
  adapter recovered the expected 80-residue binder sequence.

## Environment repairs

- PXDesign's installer needed CUDA 12.1 rather than its invalid CUDA 12.4 / Torch
  2.3.1 combination, `deepspeed==0.15.4`, CUDA 12.1 development libraries, and
  GCC/G++ 12 for its JIT extension.
- The isolated PXDesign invocation exports the environment's CUDA include/library
  paths and selects its Conda GCC/G++ binaries. The Proto adapter applies these
  settings automatically when given an absolute PXDesign executable.
- PXDesign's `infer` mode is backbone-only (`xpb` placeholder residues). The Proto
  adapter therefore invokes `pipeline`, defaulting to the bounded `preview`
  preset, so proposals always contain a real ProteinMPNN-designed sequence.

## Reproducibility caveat

PXDesign accepts a frozen seed through its hidden pipeline configuration. The
current BoltzGen CLI does not expose seed control, so Autofold records
`seedControl: upstream_cli_unavailable`. Until that is patched upstream, compare
BoltzGen using frozen replicate counts and score distributions rather than
claiming bit-for-bit replay.

## Deliberately deferred scientific boundary

The current sequence-only developability fields remain provisional heuristics.
Replace them with versioned structural tools (SAP, SASA, interface and geometry
metrics) and store physical binding, solubility, aggregation, stability,
cytotoxicity, and hemolysis measurements as distinct experimental observations.
