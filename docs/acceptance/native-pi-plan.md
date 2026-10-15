# Bounded native Pi acceptance preparation

The prepared lane uses a fresh isolated workspace at `/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance`, project `prj_native_pi_acceptance_20261003`. No legacy campaign, trial, incumbent, session or contract is imported or changed. Preparation has created the verified target copy, reference snapshot, review documents and a new isolated active campaign/experiment. Campaign: `cmp_58ecc812ab2b4adc8eedad72726714e9`; experiment: `exp_28c7fbc8d70042fa9cdb0ef0bcef3016`. The user approved the exact live scope on October 3 ("yes I approve"). The first pilot finished before GPU dispatch. The authorized v2 follow-up completed two autonomous native GPU evaluations in 500.50 seconds of combined worker wall time, at $0.41234756 recorded cumulative inference cost including v1. It rejected the second candidate and retained the baseline; formal acceptance remains incomplete because recovery repairs changed the bound source. The preserved result and subsequent software corrections are documented in [native-pi-result-2026-10-03.md](native-pi-result-2026-10-03.md). The original approval-review block was resolved by that explicit approval.

The exact host execution proposal is [native-pi.execution-config.sample.json](native-pi.execution-config.sample.json), the new frozen contract is [native-pi.contract.json](native-pi.contract.json), and the machine-readable pins, target paths and timing evidence are [native-pi.preparation.json](native-pi.preparation.json). The configuration contains host execution grants; selecting it in a live CLI/server is the authorization boundary. It contains no API key, SSH key, token or legacy environment file.

Contract hash: `sha256:6ed5d01436ca609822e27426656b94fe175b89518c079a993efd938db9cb78c1`.

Target identity: `sha256:050a1caffd2415d5b408c3670b3c41b372615d7622e36ab01a7b75b11eb0e388`. The exact legacy PD-L1 sequence, epitope A37/A39/A41 and PDB bytes were copied through `ResearchArtifacts.authorTarget`, then independently read through `ResearchArtifacts.readTarget` in the intended isolated workspace. Structure hash: `sha256:d7351a441c34cbb9c799798425295106f25beca45428f96d8d8a8f63c586e132`.

## Scientific lane and bounds

The scientist autonomously authors a native `build_trial(ctx)` program and any repairs using scoped immutable API source. The proposed initial generator is BoltzGen, one submitted short-peptide candidate per trial, with the supplied structure and epitope. No operator-authored trial or repair is supplied. The contract objective establishes the bounded lane; native prospective hypothesis, prediction, declaration and subsequent intervention belong to the scientist.

The frozen scoring ruler retains the September 15 MSA-free Boltz2 and Chai1 settings, including Chai1's default ESM signal and five internal diffusion samples. It uses one seed, `20260809`, and one submitted candidate. Two separate predictor receipts preserve a minimal model-disagreement measurement. This reduced panel provides no estimate of seed variance or panel diversity and cannot be compared numerically with the original three-candidate/two-seed incumbent.

| Allocation | Per trial | Two reserved evaluations |
| --- | ---: | ---: |
| Generation available after frozen scoring | 300 seconds | 600 seconds |
| Boltz2 scoring ceiling | 120 seconds | 240 seconds |
| Chai1 scoring ceiling | 180 seconds | 360 seconds |
| Aggregate worker GPU-wall ceiling | 600 seconds | 1,200 seconds |
| Submitted candidates | 1 | 2 |
| Host wall deadline | 15 minutes | 30 minutes plus bounded authoring |

The worker enforces aggregate GPU-wall accounting and stage caps, rather than metering instantaneous GPU utilization. Native compiler validation must fit the generation allocation and scoring graph within 600 seconds before admission. Diagnostics or additional GPU generators must consume the same residual allocation; they receive no extra authority. Failed admitted evaluations consume the two-evaluation allowance. A third dispatch is outside this proposal.

## Timing evidence and uncertainty

The September 15 native run `run_8d8f93ba75c846e4b451d91c0cac323a` returned three BoltzGen candidates. Its generation index records 2,587.835 seconds while a separate FreeBindCraft lane exhausted its frozen 2,400-second allocation without returning candidates. Subtraction leaves approximately 187.835 seconds for BoltzGen and other overhead. This is an estimate, not an isolated BoltzGen measurement or a physical minimum.

For seed `20260809`, the three measured Boltz2-plus-Chai1 candidate pairs took 128.894, 130.094 and 131.727 seconds. Across both seeds the range was 114.694–136.342 seconds. The entire original evidence stage took 696.044 seconds, exceeding a 600-second trial ceiling even before generation. The unchanged legacy contract allocates 7,200 GPU seconds per trial, or 14,400 for two trials.

A warm one-candidate lane therefore has an estimated reference workload around 317–320 seconds per trial using the conservative residual-generation estimate plus measured predictor pair. The 600-second ceiling is a plausible bounded pilot, not a demonstrated upper bound. Cold-start imports, different candidate behavior or slow hardware could exhaust it. No successful two-iteration run has yet established that this lane completes within 1,200 seconds. The actual scientific minimum remains unmeasured.

The September 16 continuation dispatched no additional GPU measurement and stalled on authoring/navigation. The new scoped references address its denied external-source access: exact tracked `.py`/`.md` Proto language/tools package, README, documentation and examples are copied read-only from the pinned repositories. Snapshots verify both HEADs and each committed Git blob, record file hashes, reject symlinks/dirty files and exclude untracked files, hidden directories and credential filenames. Bounds are 512 KiB per file, 16 MiB total and 1,600 files. The current snapshot has 818 files, 8,384,105 bytes, content hash `sha256:dd1bc1fcdc96c27567c2e4e803cf073a6c2aa520bcd05720dad70ff86267598b`. These API copies are never executed.

## Read-only host readiness

On October 3, read-only SSH to `workstation_4090` resolved `gpu-4090-wsl.tail12a852.ts.net`, user `vincent`. The selected remote Python is 3.12.3. Both remote and local clean tracked repositories match language commit `d3b7822f74ea64747cc751a3b2ab1aa6b799ac47` and tools commit `47e34afa5ea240a3b406e323dc38aa5dc85f223e`. Local inspection Python is 3.12.5 and resolves both packages from the pinned local checkout.

The remote BoltzGen executable and five checkpoint files were present in the configured cache. Boltz2 confidence/affinity checkpoints were present under `.proto/proto_model_cache/boltz2`. Chai1's six component `.pt` files and 5.68 GB traced ESM2 checkpoint were present under its environment's `site-packages/downloads` directory. The RTX 4090 reported 24,564 MiB total, 947 MiB used, zero utilization and no active compute processes.

These checks inspected file presence and sizes; they did not hash or load model checkpoints, download anything or run inference. GPU availability is a point-in-time observation. The new remote runtime root is `/home/vincent/.autofold-native-pi-acceptance`; readiness/staging happens through the execution transport before launch.

The prepared worker hash is `sha256:1852502ec4d529499bc1b79483e424401fdcbbe74586e698075da78a4d57bc98`. The acceptance runner freezes and checks source, worker, contract, profile and selected model across continuation. Changes after that binding require a separately reviewed acceptance identity.

## Model budget and live procedure

The proposed fixed scientist model is `openrouter/z-ai/glm-5.3-flash`, with a $1.80 cumulative runtime threshold and $0.20 reserve against the intended $2 total inference ceiling. Runtime cost is reconciled after each provider response, so $1.80 is a boundary for further requests rather than a guaranteed invoice cap. A strict $2 provider bill requires a provider hard-spend control or a verified pre-request worst-case cost bound. Authentication stays in the provider's host-selected credential mechanism and is never embedded in this profile or sent to the remote worker.

The new campaign/experiment and exact host profile are recorded in `native-pi.preparation.json` and the isolated workspace’s `setup.json`. The exact scope was explicitly approved and its first live attempt has settled; the gate remains unpassed. Keep the old campaign untouched. No campaign supervisor, literature refresh or skill replay is included in this two-evaluation proposal.

The native acceptance CLI performs the scientist loop and records its original transcript, journal, program hashes, bundles, verified receipts, cycles, search observations and scientist events. From the main checkout, the reviewed invocation is:

```sh
npm run research:cli -- acceptance native EXPERIMENT_ID \
  --workspace /Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance \
  --project prj_native_pi_acceptance_20261003 \
  --execution-config /Users/vincentallam/Developer/autofold/docs/acceptance/native-pi.execution-config.sample.json \
  --request-id native-pi-two-iterations-20261003-v1 \
  --iterations 2 --max-cost 1.8 --model z-ai/glm-5.3-flash
```

`EXPERIMENT_ID` is `exp_28c7fbc8d70042fa9cdb0ef0bcef3016`; its frozen contract hash matches the hash above. Preparation itself made no live invocation; the approved pilot subsequently ran with the identical isolated workspace execution configuration.

Full acceptance requires two verified native scientific receipts in one persistent scientist session, unchanged source/worker/profile/model/contract, autonomous program authoring, durable trusted closeout before another action, and a second prospective intervention grounded in the first receipt's persisted evidence. A justified evidence-grounded stop is preserved transparently, but does not pass the full two-iteration gate. Errors, timeouts, stop/yield and receipts remain reviewable; no operator patches the scientist's Python to manufacture completion. This establishes computational/software behavior, not biological binding or method improvement.

Offline preparation checks passed: target and structure verification in the intended workspace, contract/scoring canonical hashes and schema, strict execution-config parsing without dispatch, four targeted reference/scientist tests (42 assertions, including two actual native CPU evaluations), and engine typecheck. The subsequent live result is incomplete and preserved separately; the two-iteration scientific gate remains outstanding.
