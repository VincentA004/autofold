---
id: skill_bionemo.backbone-generation
version: 1
title: Backbone generation reasoning
capabilities: [structural_biology, workflow_design, model_diagnostics]
applies_to: [rfdiffusion3-design, bindcraft-design, freebindcraft-design]
source:
  repository: NVIDIA-BioNeMo/bionemo-agent-toolkit
  commit: 23d4835
  paths: [nim-skills/rfdiffusion-nim/SKILL.md]
  license: Apache-2.0 and CC-BY-4.0; external models and data retain separate terms
  attribution: Adapted and modified from NVIDIA BioNeMo Agent Toolkit domain guidance.
---
# Backbone generation reasoning

## Guidance

- Treat generated backbones as target-conditioned geometric hypotheses, not sequences or validated binders.
- Judge geometric diversity, interface placement, constraint satisfaction, and downstream designability separately.
- Hotspot conditioning trades search breadth for local geometric focus and should be tested against less constrained controls.

## Failure modes

- Plausible geometry repeatedly yields sequences that do not refold independently.
- Excessive conditioning collapses structural diversity.
- Hotspot contacts appear while the wider interface lacks complementarity.

## Falsifying questions

- Does the backbone remain designable across multiple sequence families?
- Does relaxing a hotspot recover useful diversity without destroying interface geometry?
- Is failure localized to geometry rather than sequence policy or validation?
