---
id: skill_bionemo.binder-workflow-strategy
version: 1
title: Binder workflow strategy
capabilities: [workflow_design, experimental_design, evidence_reasoning]
applies_to: [rfdiffusion3-design, bindcraft-design, freebindcraft-design, proteinmpnn-sample, ligandmpnn-sample]
source:
  repository: NVIDIA-BioNeMo/bionemo-agent-toolkit
  commit: 23d4835
  paths:
    - workflows/generative_protein_binder_design/protein-binder-design/SKILL.md
    - workflows/generative_protein_binder_design/complexa-binder-design/SKILL.md
  license: Apache-2.0 and CC-BY-4.0; external models and data retain separate terms
  attribution: Adapted and modified from NVIDIA BioNeMo Agent Toolkit domain guidance.
---
# Binder workflow strategy

## Guidance

- Separate backbone generation, sequence design, independent complex validation, interface diagnosis, and diversity selection into inspectable stages.
- Preserve target numbering, hotspots, seeds, constraints, and lineage at every handoff.
- Change one falsifiable workflow assumption at a time under a frozen evaluator and budget.
- Retain negative controls and structurally or sequentially diverse families to reduce evaluator gaming.

## Failure modes

- Early filters remove diversity before an independent validator can challenge the routing heuristic.
- Several stages change together, making a score change impossible to attribute.
- A completed generation is treated as proof of binding rather than a proposal for validation.

## Falsifying questions

- Which single stage-specific hypothesis does the proposed workflow change test?
- Would the conclusion survive the same seeds, controls, evaluator, and compute budget?
- What observation would show that the chosen model order is wrong?
