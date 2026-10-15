# Native Proto GPU validation — corrected objective, October 11, 2026

**Passed.** One fresh native Proto trial completed on workstation_4090's RTX 4090, with canonical and physical settlement, original receipt re-verification and no new effects on reopening. The grant is closed. Both earlier failed attempts remain failed and preserved separately.

| Observation | Actual result |
| --- | --- |
| Final submitted binder | `IVYNPIFNKYFG` |
| Valid frozen-panel score | 0.3445428214967251 (minimize) |
| Original run wall time | 190.904 seconds |
| Native search wall time | 67.886 seconds |
| Native stages / history rows | 2 / 2 rows per stage |
| Internal proposals / sampling requests | 2 / 2 |
| Registered native requests | 4: two CPU mutation requests and two Boltz2 objective requests |
| Independent final panel | Boltz2 then Chai1, both completed, no skips |
| LLM inference / recorded inference cost | 0 calls / $0 |
| SDK session storage | Absent; no session initialization |
| Original dispatches / retries / replacements | 1 / 0 / 0 |
| Historical workspaces exactly preserved | 10 |
| Source/worker pins | Unchanged |
| Remote supervisor and worker/GPU/local processes | Terminal and stopped |

API request counts are not a physical inference census; native cache origin was unobserved. GPU monetary cost is unmetered. The 191-second run wall measurement is not a GPU-only timer.

## What ran

This operator-authored engineering fixture used real native Proto Program/MCMC execution, source-bound hard length constraints, a CPU repetition objective, then a GPU-backed interface-confidence objective. Two distinct configured instances of the same random-protein mutation generator shared a construct containing the binder and the frozen 115-residue PD-L1 target. Each stage made one mutation proposal. Only the binder region was submitted; the target stayed byte-identical in every retained result/proposal history. Structures, raw metrics, objectives, proposals, configured instance identities and both native histories were saved in the hash-bound native receipt.

The GPU objective uses the pinned Boltz constraint's selected `protein_iptm`/`iptm` branch through a weighted total penalty, retaining the selected component in metadata and rejecting missing interface evidence. Its low-cost prediction configuration was MSA-free, one recycle, 20 diffusion steps and one sample. The independently frozen final panel retained its original MSA-free Boltz2/Chai1 configurations, target, evaluator and scoring seed 20260809. Its score is separate from the internal search objective.

The host/Python exact-byte pipeline validation passed before remote launch and in the remote worker. Every completed final model receipt was hash-verified; the original run receipt reopened without execution or state changes. The native search receipt hash is `sha256:18dd5e55fd1d4adf193079f42c328730d041bf22aa2ddd6931dd29dbc6efbf13`. The original manifest hash is `sha256:2ea9b953822705507abe872ffce7dae48292802c8fe4350d2788fe1184e65d0d`.

## Actual search decision and scientific limits

The CPU stage changed the starting sequence `SVYNPIFNKYFG` to `IVYNPIFNKYFG`, with unchanged CPU penalty 0.5370370370370371. The GPU stage proposed `IVYNPIFNKYKG`. Its penalty 0.08231735229492188 was worse than the incumbent 0.07606422901153564; native MCMC rejected it and retained the incumbent. The GPU stage's final penalty remained 0.07606422901153564. No objective improvement was observed in this one-step check.

Final Boltz2 protein/interface confidence was 0.9322456121444702; final Chai1 interface confidence was 0.35732582211494446. Predictor confidence is not measured affinity or biological activity, and these predictors disagree. This is an engineering acceptance of native staged search, configured instances, rich evidence, explicit output selection, independent scoring and settlement. It does not establish better candidates, causal graph/skill benefit, autonomous science, biological validation, all-model compatibility, chemistry preservation or universal fault tolerance. No scientist LLM, OKF planning, skill refinement, shadow replay or guide activation ran in this fixture.

## Identity and closeout

Original run: `run_bc90597f818e730b2441b348f5cd0b79e48dfd0a8b58d26ffcbc4e360e76a8e5`.
Original trial: `trl_06647713b20846f6bfa54521e3438ca1`.
Authorized launch: `2026-10-11T15:48:24.826Z`; fixed original deadline: `2026-10-11T16:33:24.826Z`. Limits were one trial, 600 aggregate worker GPU-wall seconds, 15 worker wall minutes and 45 overall minutes; no reset or extension occurred. Unused authority is closed.

Source: `sha256:e5bd340486cfcb985a08b3725bb8f6082d93644518e052953dbf876e5fed6da9`.
Worker: `sha256:3ba8fd3f619cdd1bfc6e932760480e80112637a4c6a0cf91361574294679f8d1`.
Proto language/tools dependency pins were unchanged. The prior heartbeat remains paused.

Evidence: `.autofold/native-proto-gpu-validation-objective-20261011/operator/` contains preparation, the confirmed grant, portable-bundle preflight, original successful receipt, settlement audit, exact remote shutdown proof, source/historical snapshots, final verification and grant closeout. The native receipt and final model artifacts are bound by the original worker manifest. [The original serialization failure](native-proto-gpu-validation-2026-10-11.md) and [the objective-fixture failure](native-proto-gpu-validation-fixed-2026-10-11.md) retain their separate records and decisions.
