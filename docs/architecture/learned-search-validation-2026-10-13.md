# Learned search and feedback validation — October 13, 2026

The four requested improvements are implemented and the complete CPU regression passed. Two bounded GPU discovery trials then exercised authored Proto programs with learned Boltz2 calls inside MCMC search, followed by frozen evaluation. The separate engineering qualification passed, including actual memory delivery to the second decision, exact provider accounting, settlement, and terminal reopening without new effects. The follow-up candidate's locked score worsened. This establishes the execution and feedback mechanism, not scientific improvement.

## Changes and regression

| Change | Resulting behavior |
| --- | --- |
| Compact startup registry | Planning receives at most twelve relevant installed-model summaries; full registry and exact cards remain available. |
| Fresh decision memory | Startup and evaluation closeout share preparation and verification. The next decision can receive a bounded fresh packet automatically. Exposure requires actual delivery; incomplete delivery or preparation failure produces a gap. Canonical receipts remain unchanged. |
| Structured comparison | Verified frozen conditions and admitted design differences replace descriptive fingerprint comparisons. Unknown conditions remain unknown. Guide capability descriptions remain separate from paired replay and activation. Skill format errors provide an actionable example. |
| Generation seeds | An immutable authoring-slot seed propagates through trial, bundle, worker context, native Program, and generation artifact. Fixed evaluator seeds remain separate. Historical trials without this field retain their original behavior. |
| Local admission settlement | A narrowly identified rejection before HTTP dispatch settles as `not_dispatched`. Generic observer or transport failures retain uncertainty. |

Focused regression checks ran between changes. The complete repeat passed **546 engine, 249 core, 147 worker, and 7 UI tests**, plus workspace typechecks; one existing optional legacy SQLite test remained skipped. The first complete attempt had timing-dependent failures. Each affected isolated test and the complete repeat passed under the original deadlines with idle sleep inhibited. Both attempts are preserved; no production change was made to mask those transient failures.

The [full gate](/Users/vincentallam/Developer/autofold/.autofold/cohesive-engine-refactor-20261012/improvements-20261013/operator/gates/full/gate.json) records logs and hashes. Tested engine/core source identity is `sha256:bc7094905313f2e49233723518a525a4b4d5aa25dc3d2aa89b7c22894403f313`; worker identity is `sha256:10a2cc2466a32703f1f4b0fa45ece2802de5c165bdb9026e6b5d9b279780e6e0`. Production source stayed frozen through live execution and qualification.

## Live execution

The isolated run used the existing workstation_4090 host, pinned upstream Proto, and OpenRouter `deepseek/deepseek-v4.1-flash`. It retained the smaller authorization: two ordinary trials, one submitted candidate per trial, 600 seconds of compute reservation per trial, separate $2 reported-inference and $2 SDK-estimate ceilings, and no replay or skill activation. The retry inherited the original one-hour deadline; it did not restart the budget or authorization window. Reservations are not measured physical GPU seconds.

Each program used one MCMC step and one semigreedy residue mutation. A weight-one structural constraint evaluated the full, hash-verified 115-residue target plus a twelve-residue binder. Its search energy was `1 - Boltz2 ipTM`. Both trials recorded two completed learned requests with `cache_miss`, plus their separate frozen scoring panel. The four search requests were therefore inside optimization, rather than only final evaluation. Process ancestry and passive CUDA observations corroborated GPU work under both original run identities.

| Trial | Initial binder → selected binder | Native ipTM, initial → proposal | Locked score, lower is better |
| --- | --- | --- | --- |
| 1 | `GSWYELKFPQDR` → `GRWYELKFPQDR` | 0.907664 → 0.929966 | 0.30418219 |
| 2 | `GRWYELKFPQDR` → `GRWYELKFPQFR` | 0.887917 → 0.902380 | 0.31870735 |

The second declaration cited the first run and prospectively predicted a lower locked score. The audit bound its exact evaluation tool call to the immediately preceding settled inference request, whose effective input contained the fresh packet and first verified receipt. This proves attributable feedback delivery and use. The prediction failed: the score increased by 0.01452516.

**42 unique provider calls** reconciled to **$0.13292463 reported inference** and **$0.133656264 SDK estimate**. Original pre-dispatch reservations were checked separately against both ceilings under their published-price assumptions. Native Pi/SDK output sizing and default provider routing were retained. All jobs, operations, sessions, and runs settled. Both worker exits and physical shutdown were verified; the passive observer was then stopped. Receipt-only reopening caused no new inference, authoring, dispatch, or scientific effect.

## Preserved operator failures and qualification

The first launch failed before any provider or GPU work because default campaign-charter creation copied a 2,463-character objective into a field limited to 2,000. A fresh retry used a shorter campaign summary while retaining the full experiment contract and original deadline.

After both retry trials succeeded, the frozen original operator audit failed on its hardcoded 120-residue assumption. The actual frozen target is 115 residues; both programs and the evaluator used those original bytes. No target or contract was replaced.

The original drivers, errors, held-state audits, receipts, and reports remain unchanged. A new audit-only verifier derives target length from the verified artifact, reads initial native scores from Proto's scored initial proposal row, and handles the final dispatch observation's verified bookkeeping field explicitly. Actual receipt fixtures and negative cases passed before execution. The new verifier denied inference, credential retrieval, inspection, and transport actions; it corrected verifier assumptions without waiving scientific acceptance conditions.

The [qualified report](/Users/vincentallam/Developer/autofold/.autofold/cohesive-engine-refactor-20261012/learned-search-validation-20261013-retry1/operator/qualification-01/qualified-report.json) passed independently. It explicitly records that the original operator report failed and remains authoritative as that historical attempt. Original historical preservation checks passed for 65 roots, 50,479 files, and 61 SQLite databases, plus the prior completed discovery campaign's 2,734 files and two databases.

## Weak points exposed

1. **Search proxy versus evaluation.** Native ipTM improved in both steps, yet the second locked score worsened. The first frozen Boltz and Chai ipTM values also differed substantially. The evaluation shares Boltz2 with search and adds Chai; it is not a wholly independent held-out panel. None of these predictions establishes binding affinity.
2. **Seed coupling.** Host generation seeds also fan out into structural predictor seeds. The same intermediate binder scored differently across trials under different derived tool seeds. These two ordinary trajectories do not isolate mutation quality or estimate predictor variance. Separate mutation and predictor seed controls, then compare under matched seeds or explicit replicates.
3. **Incomplete seed summaries.** Raw verified bundles and native artifacts contain the correct generation seeds, while some generation indexes and memory summaries still expose evaluator seeds and unknown generation stochasticity. Future projections should name evaluator, generation, and derived tool seeds separately without rewriting historical records.
4. **Evidence size and joins.** Native receipts contain repeated structure data and large function descriptors. Request receipts have hashes but no direct per-call metric-to-history-row join. Reduce duplicated payloads using verified content references and add explicit attribution before claiming detailed call-level score provenance.
5. **Operator robustness.** Long objective handling and assumptions in acceptance fixtures caused avoidable audit failures. Derive campaign summaries and fixture expectations from validated contracts and actual receipt schemas.

This run covers ordinary discovery and feedback. Paired replay, skill activation, and demonstrated method improvement were outside its bounded scope. Their CPU regression passed, but this live run supplies no new claim about them.

## Memory replacement research

The GPT-6 Luna high research assessment recommends [Hindsight behind a provider-neutral retrieval adapter](/Users/vincentallam/Developer/autofold/docs/architecture/hindsight-memory-assessment-2026-10-13.md). It can supply semantic, graph, keyword, and temporal recall over immutable source exports. Autofold should retain authority over evidence, exact identities, frozen replay inputs, packet delivery, permissions, and billing. Start with synthetic shadow indexing and recall comparisons; no Hindsight service, global Pi integration, or data transfer was introduced in this implementation.
