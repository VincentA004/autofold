# PD-L1 closed-loop checkpoint — 2026-08-09

This checkpoint is computational workflow evidence, not biological validation.

## Frozen campaign

- Campaign: `cmp_4c4cc98bfff64a659d0a4aa91c157277`
- Experiment: `exp_c50b378dd4904d89a6bc07bde9607cd7`
- Target artifact: `sha256:050a1caffd2415d5b408c3670b3c41b372615d7622e36ab01a7b75b11eb0e388`
- Contract: one candidate, one submission, one GPU-hour, 120 wall minutes, seed `20260809`
- Locked evaluator: peptide panel v1, minimize score
- Frozen site: PD-L1 target residues 37, 39, and 41. These began as acceptance residues; their biological interpretation remains proposed rather than experimentally established.

## Successful iterations and execution calibration

| Iteration | Generator and scaffold | Candidate | Score | Aggregation risk | Solubility | Predictor agreement |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Baseline | RFdiffusion3/ProteinMPNN, linear 30-mer | `ALERLLADPELLARLRAAGYSLEEAVALVA` | 0.42260 | 0.8417 | 0.5417 | 0.3104 |
| Knowledge-driven | BoltzGen, 14-mer disulfide β-hairpin | `CGVKLVDGKLIVTC` | 0.37076 | 0.4500 | 0.8464 | 0.1847 |
| Route correction + new sample | BoltzGen hairpin; Protenix mini ESM resolution | `CGVLEIDGVKFELC` | 0.27096 | 0.4500 | 0.8107 | 0.8209 |
| Exact-sequence replay | Fixed iteration-2 hairpin; corrected predictor route | `CGVKLVDGKLIVTC` | 0.25027 | 0.4500 | 0.8464 | 0.6646 |
| Negative control | Composition-matched scrambled hairpin; corrected predictor route | `CKVGTLDVIGVKLC` | 0.30314 | 0.4500 | 0.8464 | 0.5163 |

The second iteration met its locked score threshold of 0.40. Its manifest is
`sha256:9654983c1ff71e4a3e8ea1dabe3df75f98d5031e0d272f088bd8886847b8c375`.
The exact replay is the current incumbent; its run is
`run_24bf45fc44074037b0d621df3dbcd549` and its manifest is
`sha256:a6e0a043f3d3c12b2714e8a4a35f2bad078baf949dfa7a05201cce18b459bea0`.

The low agreement was traced to model routing rather than the hairpin. Protenix
v2 without an MSA or sequence embeddings was a persistent outlier on both the
linear baseline and the hairpin. A full 10-cycle/200-step diagnostic improved
its hairpin ipTM only from 0.069 to 0.269. Protenix mini ESM instead produced
ipTM 0.869 and pLDDT 0.940 on the exact replay, alongside Boltz ipTM 0.910 and
Chai ipTM 0.604. The old sequence's score improved from 0.37076 to 0.25027 with
no sequence change, isolating the effect of the corrected execution route.

This remains computational ranking evidence. It cannot be interpreted as
affinity, specificity, efficacy, or safety without negative controls, stronger
structural analyses, and physical assays.

The control plane now distinguishes optimization from observation. Trial intent
is frozen as `optimize`, `calibrate`, or `negative_control`; only optimization
trials can be promoted. Valid controls still traverse the identical predictor
panel, locked evaluator, artifact verification, and OKF publication path, but
their decision is recorded as `observed`. The first specificity check is the
composition-matched scrambled sequence `CKVGTLDVIGVKLC`, parented to the exact
replay incumbent and frozen in `trial-5-scrambled-control.py`.

That control completed as `run_4067413e00b7494ca17c8ca6f25e2cbb` with
manifest `sha256:e6b3b29fee03a59f4ed60330a02d74a8d50f8eb57d665762af6ef1fe6fcb4a37`.
Its score was 0.30314, 0.05287 worse than the incumbent under the minimize-score
evaluator. Boltz remained nearly unchanged (ipTM 0.9098), while Chai fell from
0.6036 to 0.3827 and Protenix fell from 0.8691 to 0.6528. The panel therefore
shows some sequence-specific separation, driven by the independent predictors,
but Boltz's failure to separate these sequences means this single control is not
strong evidence of biological specificity. OKF records it as stable `observed`
evidence; the incumbent remains unchanged.

Knowledge cycle `kcy_65241c7ce8ab4bae943b14d5fa703831` consumed the
observed control and four excerpt-verified sources. It records the score gap as
initial, not conclusive, specificity evidence and identifies Boltz's high
control ipTM as the main panel limitation. Its next falsifiable experiment is a
single Gly substitution at the incumbent residue predicted to contact PD-L1
Y56 or Q66. A locked score at or above 0.30 would support contact-driven
specificity; a score at or below 0.26 would instead suggest the panel is driven
primarily by scaffold geometry. All four resulting claims and their run
alignments remain `proposed` pending independent review.

## Recursive knowledge result

Three durable knowledge cycles consumed all current run outcomes. The first used
12 verified sources to propose a disulfide β-hairpin. The second used six new
sources to compare that successful result with experimental and structural
literature. Each source excerpt was checked against the original fetched record
before the cycle was ingested. Claims and run-to-literature alignments remain
`proposed` until independently reviewed.

The third cycle consumed the corrected-route run, one safe execution failure,
and the exact replay. It added four excerpt-verified sources and recommends one
hotspot-directed residue change under the unchanged corrected panel, with score
≤ 0.23 and best-candidate loss ≤ 0.19. It also surfaced specificity as the main
uncertainty and recommends an explicit negative control.

The review agent incorrectly described prior runs as MSA-augmented even though
their frozen configs set `use_msa=false`. That proposed claim and its alignment
were marked `contested`. Literature-review context now includes verified
candidate sequences, frozen pipeline configuration, and native per-model metrics
so future cycles do not infer execution facts from aggregate scores.

## Infrastructure findings retained in provenance

- SSH alias resolution, raw-host trust, and sandbox network policy caused early transport-only failures.
- BoltzGen rejected Proto's compact mmCIF conversion because it omitted required entity tables. Passing the target through BoltzGen's supported PDB parser fixed the boundary without changing the target bytes or experiment contract.
- Long literature turns can outlive the client request. Knowledge refresh now supports resuming an existing proposal and re-verifies it against the originating child session before persistence.
- BoltzGen's current CLI reports that upstream seed control is unavailable; the same frozen seed generated a different hairpin in the route-correction run. Fixed-sequence Proto replay now provides a deterministic calibration lane with normal generation provenance.
- Model-native evidence is now passed to both autoresearch and literature-review agents. A collapsed agreement value remains part of the locked evaluator, but agents can see which predictor caused it before changing a peptide hypothesis.
