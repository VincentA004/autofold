---
id: skill_bionemo.sequence-design
version: 1
title: Sequence design reasoning
capabilities: [structural_biology, developability, model_diagnostics]
applies_to: [proteinmpnn-sample, ligandmpnn-sample]
source:
  repository: NVIDIA-BioNeMo/bionemo-agent-toolkit
  commit: 23d4835
  paths: [nim-skills/proteinmpnn-nim/SKILL.md]
  license: Apache-2.0 and CC-BY-4.0; external models and data retain separate terms
  attribution: Adapted and modified from NVIDIA BioNeMo Agent Toolkit domain guidance.
---
# Sequence design reasoning

## Guidance

- Sequence likelihood conditioned on a backbone is distinct from independent fold, interface, selectivity, and developability evidence.
- Preserve exact parent backbone, residue constraints, sampling policy, and temperature with each sequence.
- Keep diverse sequence families when their diagnostics are comparable rather than selecting many near-duplicates.

## Failure modes

- Restrictive residue policies collapse diversity and hide uncertainty.
- High backbone-conditioned plausibility fails independent complex prediction.
- A sequence change is blamed when the parent geometry is the actual bottleneck.

## Falsifying questions

- Do multiple sequence families independently support the same backbone hypothesis?
- Does a controlled sampling-policy change improve valid diverse yield?
- Are failures consistent across independent validators?
