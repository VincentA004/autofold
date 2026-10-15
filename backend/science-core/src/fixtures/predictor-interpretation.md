---
id: skill_bionemo.predictor-interpretation
version: 1
title: Independent predictor interpretation
capabilities: [model_diagnostics, evidence_reasoning, structural_biology]
applies_to: [boltz2-prediction, chai1-prediction, protenix-prediction]
source:
  repository: NVIDIA-BioNeMo/bionemo-agent-toolkit
  commit: 23d4835
  paths: [nim-skills/boltz2-nim/SKILL.md]
  license: Apache-2.0 and CC-BY-4.0; external models and data retain separate terms
  attribution: Adapted and modified from NVIDIA BioNeMo Agent Toolkit domain guidance.
---
# Independent predictor interpretation

## Guidance

- Keep global fold confidence, interface confidence, pose agreement, geometry, and affinity estimates as separate evidence fields.
- Predictor confidence and estimated affinity are computational evidence, not physical binding measurements.
- Preserve disagreement between predictors; persistent disagreement can reveal a candidate weakness or configuration-specific failure.
- Compare identical canonical target-candidate identities across validators.

## Failure modes

- One strong confidence field is collapsed into an opaque aggregate score.
- Correlated predictors are treated as independent experimental confirmation.
- A globally plausible structure hides a weak or inconsistent interface.

## Falsifying questions

- Do independent predictors agree on pose and interface rather than merely global fold?
- Does the candidate remain plausible after removing the most favorable predictor?
- Can configuration checks distinguish biological disagreement from a routing failure?
