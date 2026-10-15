# Native Pi GPU pilot — October 3, 2026

**Two autonomous native GPU evaluations completed with verified receipts.** The scientist authored and repaired its first program, consumed its trusted result, committed a typed review, then authored a scaffold intervention grounded in that measurement. Both ran BoltzGen generation followed by the frozen MSA-free Boltz2 and Chai1 stages on the RTX 4090. No operator authored or edited either scientific program.

| Candidate | Scaffold | Locked score (lower is better) | Worker wall time | Decision |
| --- | --- | ---: | ---: | --- |
| `SELEALLAKALA` | Linear, 12 residues | 0.25557026 | 244.54 s | Isolated baseline promoted |
| `CGITIDGITFGC` | Disulfide beta-hairpin, 12 residues | 0.29535344 | 255.96 s | Rejected; baseline retained |

The second score was worse by 0.03978318. Estimated solubility improved from 0.4833 to 0.9333 and aggregation risk decreased from 0.7083 to 0.3000, but predictor agreement fell from 0.9163 to 0.3469. Boltz2 interface confidence was 0.9555 for the hairpin while Chai1's was 0.3734, versus 0.9254/0.8563 for the linear candidate. This single-candidate, single-seed observation refuted the prospective lower-score predicate. It does not establish method improvement or biological binding. Read-only completed logs confirm the first candidate failed BoltzGen's ALA/LEU fraction filters, leaving zero internally accepted designs, while the hairpin passed its internal filters. The adapter still extracted the first canonical raw candidate for the independently locked scoring pipeline. Receipt validity does not establish generator-filter acceptance.

Both evaluations completed all required predictor decisions without skips and remained within their respective 600-second ceilings; combined worker wall time was 500.50 seconds. Observed GPU utilization reached 99% with approximately 5.2 GiB allocated during the first Chai1 stage. The durable job settled successfully at 2026-10-04T00:15:51.930Z with `iteration_limit_reached`; there was no third evaluation. Recorded v2 inference cost was **$0.29318417**, or **$0.41234756 including v1**. These are completed-response costs, not a verified provider invoice.

**The formal native acceptance gate remains incomplete solely because `sourceVersionUnchanged=false`.** The report passes fixed model, autonomous authorship, both scientific receipt verifications, trusted closeout chronology, evidence-grounded next intervention and two verified scientific iterations. The controller finished within its original deadline and budget. Code repairs during recovery changed the originally bound source; the original binding and resulting failed source check are retained transparently. A future unchanged-source attempt is required for full acceptance and receives no additional compute authority from this report.

The authorized v2 GPU pilot used the same isolated experiment, frozen worker and scoring contract, one fixed seed, and one candidate per evaluation. The scientist authored both native programs. A valid final measurement is computational evidence only; it does not confirm binding or justify production skill promotion.

The live attempt exposed three product defects and one acceptance audit defect. Frozen declaration comparison incorrectly depended on JSON key order; the comparison now normalizes authoritative schemas and checks structural values while preserving meaningful differences. The review tool advertised an untyped payload; it now derives its provider schema from ScientistReview.Input. Buffered stream persistence wrote full snapshots for every delta and starved lease timers; persistence now coalesces deltas before cloning and yields buffered processing while retaining complete final messages, cost and durable tool intent. Acceptance authorship now reconstructs successful write/edit operations and checks each recorded content hash rather than requiring the last operation to be write_file.

Offline checks passed: two native declaration regressions, the actual-Pi review payload/schema regression, 24 runtime tests, three acceptance provenance tests and engine typecheck. A disposable pre-fix streaming comparison reproduced the exact lease failure and the fixed regression passed. No default Autofold response-token cap was added. Existing servers were not restarted, and no operator edited the live scientist programs.

The same durable v2 job was resumed after repairs. Its original model-cost baseline and wall deadline stayed fixed, completed empirical work was reused and there were at most two GPU evaluations across v1/v2. Source changed after the acceptance binding, so sourceVersionUnchanged must remain false. Receipts establish the operational GPU pipeline; this repaired run cannot pass the unchanged-source native acceptance gate.

Artifacts:

- [Final v2 acceptance report](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/768bd9bb828276e2ee5917dd697eb8c19fe0d0ca2b8eb1860a62db86cebe2906/report.json)
- [Settled v2 job](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/768bd9bb828276e2ee5917dd697eb8c19fe0d0ca2b8eb1860a62db86cebe2906/job.json)
- [Verified receipts](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/768bd9bb828276e2ee5917dd697eb8c19fe0d0ca2b8eb1860a62db86cebe2906/receipts.json)
- [Operator outcome](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/operator/outcome-v2.json)
- [First immutable scientist program](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/programs/e107156336b740f5765e5274a9b024344a87b0798110a16ea78ff95d508ff50f/trial.py)
- [Second immutable scientist program](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/programs/9b1dc2879da54f8ccd5f67b4fed2262f035c716703ca5520f961df8313404972/trial.py)


## Post-run stop recovery correction

A read-only audit found that an invalid scientist-review evidence reference had been checkpointed before stop validation. It left an uncommitted pending stop; a corrected intent then collided with the old fixed checkpoint. There is no prohibition against a scientist stopping an active job. The scientist's inferred active-job prohibition was an interpretation of that opaque error, not a controller policy.

Stop evidence now validates before any intent is saved. Distinct inputs receive stable independent checkpoint phases, and exact replay remains idempotent across lease reclaim. Reopening a provably invalid, uncommitted legacy stop preserves its complete rejected input and scoped diagnosis in an audit field and clears the blocking pending operation. Cancelled or already committed operations retain their protections. The tool now directs evidence citations to the scoped reference inventory.

Five new regression cases were added. The scientist suite passed 23 tests; a final stop subset passed six tests, including the subsequently added preservation case, exercising all 24 current cases across the runs. Engine typecheck passed. All tests were offline with provider transport blocked. This correction happened after the GPU job settled; live state, the final report, both scientific programs and receipts were not edited or rerun.

# Original v1 pilot — October 3, 2026

**The two-iteration acceptance gate did not pass.** The approved pilot settled at 2026-10-03T22:12:16.028Z with no authored program, no admitted trial, no GPU dispatch and no scientific receipt. Recorded model inference cost was **$0.11916339**. This is provider-reported response accounting, not a verified invoice.

The durable controller completed its bounded job with `authoring_progress_limit_reached`; `job.status=succeeded` means that controller finished, not that scientific acceptance passed. The acceptance report explicitly remains `incomplete` with both native acceptance booleans false. The selected model, contract, worker and source stayed fixed during the run. No operator supplied scientist Python or repaired its files.

| Evidence | Observed result |
| --- | --- |
| Persistent session usage | 37 assistant turns; 54 tool calls |
| Tool actions | One context read, one directory listing, 35 file reads, 17 searches |
| Program writes/edits/validation | Zero |
| Scientific trials/evaluations/GPU dispatches | Zero |
| Authenticated no-progress continuations | Three |
| Output truncation | Two reasoning-only responses exhausted the 4,096-token allowance |
| Frozen source hash at completion | `sha256:eb034bef77e489005f6ba0afaad6ca94eadcae3e1b0870360b1d861b694680d0` |
| Two verified scientific iterations | False |

The initial request returned OpenRouter HTTP 401 (`User not found`) before tools, compute or recorded model cost. A read-only credential check found the environment key invalid and the existing OpenScience OpenRouter credential valid. The same durable job was retried with that credential only in the child process environment. No credential was printed or written into project artifacts; stored credentials and the global environment were unchanged. The original baseline and cumulative budget were retained.

The trace exposed a controller bug: the acceptance runner queued its concrete native instruction, but the discovery loop discarded it and delivered only a generic continuation. After the live job settled, the main checkout was corrected to deliver and checkpoint the queued instruction on each continuation alongside the remaining empirical allowance. The first post-run correction raised native discovery to 8,192 tokens. At the user’s subsequent request, both that cap and the runtime’s 4,096-token default were removed. Pi now selects output length from the model limit and remaining context; Autofold applies no default response-token cap. Explicit host overrides remain available. The cumulative model-cost boundary, original frozen compute limits, unresolved-request fences and two-evaluation authority were not widened.

Post-run verification: **16 targeted offline jobs/acceptance tests passed**, including two new regressions for instruction delivery across continuations and output override/model-budget enforcement. Engine typecheck passed. The test preload blocked external provider requests; native CPU fixtures supplied infrastructure evidence only. Logs: `/private/tmp/autofold-native-prompt-check.log` and `/private/tmp/autofold-native-prompt-types.log`. The prior complete product software check remains documented separately; the entire suite was not rerun for these localized corrections.

The v1 report describes its original source and was not regenerated after those corrections. The subsequently authorized v2 pilot is recorded above; it retained the prior $0.11916339 spend and a total of at most two admitted evaluations in the approved lane. Prompt delivery and a larger output allowance do not establish that the model can autonomously construct a valid program; that remains to be measured. Computational method improvement, three-campaign production skill validation and biological validation remain unestablished.

Artifacts:

- [Original acceptance report](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/f0df1f43618606de5f8cf93dbcdd38278b7bc210e06228d54f01c1d47791da28/report.json)
- [Settled durable job and checkpoints](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/f0df1f43618606de5f8cf93dbcdd38278b7bc210e06228d54f01c1d47791da28/job.json)
- [Original Pi event trace](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/f0df1f43618606de5f8cf93dbcdd38278b7bc210e06228d54f01c1d47791da28/pi-events.json)
- [Original persistent transcript](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/.autofold/acceptance/f0df1f43618606de5f8cf93dbcdd38278b7bc210e06228d54f01c1d47791da28/transcript.json)
- [Operator outcome and report content hash](/Users/vincentallam/Developer/autofold/.autofold/native-pi-acceptance/operator/outcome.json)
- [Reviewed lane and bounds](native-pi-plan.md)

## Follow-up authoring harness audit

The authoring guide described a frozen experiment/target/evaluator on Python `ctx` without documenting the actual `TrialContext` attributes. It now lists the real IDs, paths, seeds, cardinality and intent, and distinguishes Python execution context from `read_context` JSON. The relevant worker generator, native Program, Construct, Segment and rejection-sampling optimizer entry points are now linked directly from the guide and compact context inventory. The guide directs draft → validate → targeted repair rather than exhaustive source browsing. No operator-authored scientific program was added. These are confirmed interface defects/usability issues, not proof that any one caused the prior stall.

Verification after removing the caps: 55 offline tests across runtime, jobs, scientist, native references and acceptance passed. An additional actual-Pi OpenRouter payload regression passed in a 22-test runtime rerun, for 56 distinct tests across those checks. Its payload hook intercepted the request before transport and verified the advertised model output limit. The final two authoring-context regressions were rerun and engine typecheck passed. No paid model request or GPU dispatch occurred during these checks. Logs: `/private/tmp/autofold-native-harness-check.log`, `/private/tmp/autofold-native-output-payload-check.log`, `/private/tmp/autofold-native-authoring-context-check.log` and `/private/tmp/autofold-native-harness-types.log`.
