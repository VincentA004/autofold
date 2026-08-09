# PD-L1 closed-loop checkpoint — 2026-08-09

This checkpoint is computational workflow evidence, not biological validation.

## Frozen campaign

- Campaign: `cmp_4c4cc98bfff64a659d0a4aa91c157277`
- Experiment: `exp_c50b378dd4904d89a6bc07bde9607cd7`
- Target artifact: `sha256:050a1caffd2415d5b408c3670b3c41b372615d7622e36ab01a7b75b11eb0e388`
- Contract: one candidate, one submission, one GPU-hour, 120 wall minutes, seed `20260809`
- Locked evaluator: peptide panel v1, minimize score
- Frozen site: PD-L1 target residues 37, 39, and 41. These began as acceptance residues; their biological interpretation remains proposed rather than experimentally established.

## Two successful iterations

| Iteration | Generator and scaffold | Candidate | Score | Aggregation risk | Solubility | Predictor agreement |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Baseline | RFdiffusion3/ProteinMPNN, linear 30-mer | `ALERLLADPELLARLRAAGYSLEEAVALVA` | 0.42260 | 0.8417 | 0.5417 | 0.3104 |
| Knowledge-driven | BoltzGen, 14-mer disulfide β-hairpin | `CGVKLVDGKLIVTC` | 0.37076 | 0.4500 | 0.8464 | 0.1847 |

The second iteration met its locked score threshold of 0.40 and became the
incumbent. Boltz, Chai with ESM, and Protenix v2 all completed. Its manifest is
`sha256:9654983c1ff71e4a3e8ea1dabe3df75f98d5031e0d272f088bd8886847b8c375`.

The result supports the computational usefulness of a constrained scaffold,
but the lower cross-predictor agreement is an unresolved warning. It cannot be
interpreted as affinity, specificity, efficacy, or safety without stronger
structural analyses and physical assays.

## Recursive knowledge result

Two durable knowledge cycles consumed all current run outcomes. The first used
12 verified sources to propose a disulfide β-hairpin. The second used six new
sources to compare that successful result with experimental and structural
literature. Each source excerpt was checked against the original fetched record
before the cycle was ingested. Claims and run-to-literature alignments remain
`proposed` until independently reviewed.

The current next-experiment proposal keeps the locked experiment and tests one
AAP-guided β-strand side-chain redesign of the 14-mer scaffold. Its success
criterion is score ≤ 0.35 and best-candidate loss ≤ 0.34. A concurrent increase
in predictor agreement would support improved scaffold definition; continued
disagreement would redirect investigation toward target plasticity or model
handling of constrained peptides.

## Infrastructure findings retained in provenance

- SSH alias resolution, raw-host trust, and sandbox network policy caused early transport-only failures.
- BoltzGen rejected Proto's compact mmCIF conversion because it omitted required entity tables. Passing the target through BoltzGen's supported PDB parser fixed the boundary without changing the target bytes or experiment contract.
- Long literature turns can outlive the client request. Knowledge refresh now supports resuming an existing proposal and re-verifies it against the originating child session before persistence.
