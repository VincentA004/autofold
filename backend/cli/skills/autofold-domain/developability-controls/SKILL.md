---
id: skill_bionemo.developability-controls
version: 1
title: Developability and control reasoning
capabilities: [developability, experimental_design, evidence_reasoning]
applies_to: [boltz2-prediction, chai1-prediction, protenix-prediction]
source:
  repository: NVIDIA-BioNeMo/bionemo-agent-toolkit
  commit: 23d4835
  paths: [workflows/generative_protein_binder_design/protein-binder-design/SKILL.md]
  license: Apache-2.0 and CC-BY-4.0; external models and data retain separate terms
  attribution: Adapted and modified from NVIDIA BioNeMo Agent Toolkit domain guidance.
---
# Developability and control reasoning

## Guidance

- Evaluate aggregation, exposed hydrophobicity, charge distribution, sequence liabilities, and apo stability separately from predicted binding.
- Use apo-versus-holo comparisons, negative controls, and unrelated-target controls to test dependence on implausible stabilization or nonspecific interfaces.
- Treat heuristic developability metrics as routing evidence until stronger computational tools or assays replace them.

## Failure modes

- A strong predicted complex masks an unstable unbound candidate.
- Selection favors nonspecific hydrophobic interfaces.
- Heuristic thresholds are mistaken for assay-backed truth.

## Falsifying questions

- Does the candidate remain plausible in the unbound state?
- Do negative and unrelated-target controls separate specific from nonspecific interaction?
- Which stronger measurement would overturn the current heuristic conclusion?
