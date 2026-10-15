# Behavioral recovery acceptance

This suite tests the outcome a discovery operator needs: after the controller disappears while a scientific worker is running, the original result is recovered once and the authorized campaign continues automatically. It must do so without resetting costs, losing evidence or requiring an operator to enqueue another job.

Run `npm run test:behavior` from the repository root. `npm run check:discovery` runs backend regressions followed by the native workflow qualification; `check:product` also requires it. `check:backend` alone covers portable components, the provider wire fixture and checker controls, and does not establish discovery readiness.

The current native profile exercises the macOS controller with its real sandbox and a provisioned CPU Python and pinned Proto checkout. Defaults use the locally provisioned `.autofold/envs/proto` environment and the existing pinned checkout; `AUTOFOLD_TEST_PROTO_PYTHON` and `AUTOFOLD_TEST_PROTO_ROOT` select another provisioned local runtime. Missing prerequisites or unsupported native security checks fail qualification. They do not skip to success. Porting this qualification to a Linux controller requires equivalent native containment checks.

The worker regression suite also imports Proto and its Python dependencies. Set both runtime variables when running the combined gate; the worker script uses the selected interpreter and places that checkout ahead of editable installations on `PYTHONPATH`. For this checkout:

```sh
AUTOFOLD_TEST_PROTO_PYTHON="$PWD/.autofold/envs/proto/bin/python" \
AUTOFOLD_TEST_PROTO_ROOT="$PWD/.autofold/cohesive-engine-refactor-20261012/upstream-proto/v4/source" \
npm run check:discovery
```

The runner retains a new directory beneath `.autofold/behavioral-suite-20261014` on each attempt, including failed and blocked attempts. It records source, configuration and test hashes before and after, the test process exit status, JUnit results, named scenario reports and links to the raw evidence. It also hashes the actual native source, Python executable, installed Pi packages and their resolved dependencies before and after; a clean commit ID alone does not establish which bytes ran. Python site-packages outside that source tree and system libraries remain environmental dependencies. An old passing log, a test count or a skipped scenario cannot qualify a new source revision. Historical live-run evidence is preserved separately.

Execution is staged: the native/provider/checker prerequisites must pass before the normal public workflow runs, and that baseline must pass before fault injection starts. A failed prerequisite produces explicit blocked reports for unrun scenarios. Positive workflows also remain under observation after completion to catch unwanted extra work.

## Boundaries exercised

- The unchanged production server entrypoint starts its default job worker in a subprocess. Campaign and experiment setup and observations use public HTTP routes.
- Pi uses its actual provider serialization and SSE parsing against a loopback provider with fake credentials. The scripted scientist sees only provider messages, tool schemas and returned tool feedback. It cannot read canonical storage or a harness phase map.
- Native Proto runs a literal CPU program through the scientific execution path. The program journals actual computation entry and exit independently of controller storage. This proves native computation, rather than merely inspecting an authored program.
- Faults affect the owned controller process: external kill and restart, or suspension beyond its default lease. The independent CPU worker can finish during the outage.
- The harness never calls reconcile, retry or settlement endpoints, edits databases, or schedules the next discovery. Ordinary product supervision must recover and continue.

## Required outcomes

`recovery.baseline-completes` first requires two real native results through the normal public workflow. `recovery.restart-continues` and `recovery.suspension-continues` each require the original execution to appear exactly once, retain its manifest bytes and public result, and be followed by a distinct execution after recovery. Completion must be observed publicly, and retained request costs must match the independent provider invoices. A campaign closed with one result when two were requested fails.

`recovery.partial-batch-continues` interrupts the first trial within a two-trial child batch and requires three total results. Recovering a completed child batch does not establish that a partly finished child can resume. The first two results must belong to the same original child. Its payload, accounting baseline, saved allowance and absolute deadline must survive unchanged.

`recovery.cancel-holds` cancels the original terminal root while its automatic continuation is executing. The original successful result must remain intact, and the admitted second effect must have a truthful terminal outcome and an observed physical exit. Frozen inputs and copies of the independently observed partial outputs must survive. Public operation revocation must cover the entire continuation lineage, and the responsive controller must authorize no further inference or execution despite unused authority.

`recovery.unknown-billing-holds` supplies one genuinely unknown invoice through the real provider wire path. The public request must retain its upstream identity, unknown charge and positive SDK estimate. An explicit accounting hold must prevent another request, trial or execution while the controller remains responsive. Its proof distinguishes the allowance before that request from the unknown reported-dollar balance afterward.

After the first factual recovery, an unchanged accounting hold must also retain its original recovery count and checkpoint set through at least six seconds of public observation. Read-only observation may continue; identical evidence must not repeatedly acquire another recovery lease. Mandatory focused wake tests cover verified saved-session billing updates, scope changes, deadline expiry and cancellation, along with active worker receipts and unrelated queues. Controlled interleavings also deliver scope, deadline and receipt changes during the handoff from factual reconciliation to cached observation. A fact arriving in that window must remain observable. These tests run as prerequisites before the public workflows and cannot be omitted or skipped. They do not establish automatic polling of upstream provider metadata; the existing verified receipt-settlement port supplies the changed billing fact in the component test.

The independent oracle hashes the manifest, its scientific files and linked generation records, using the manifest captured before recovery as the original anchor. Its corrupt trace controls cover duplicate execution, missing result files and manifests, changed artifact bytes, partial completion, lost billing, reset costs and inference or execution after unknown billing. These controls test the checker itself; they do not substitute for the native workflow scenarios.

Receipt-only recovery remains a factual operation without new inference. Automatic continuation belongs to ordinary worker supervision and must retain the campaign's original authority, absolute deadline and remaining budget. First admission saves cumulative model, turn and tool ceilings; a restart uses the smaller of the saved and current limits. An unfinished historical job without those ceilings cannot receive a replacement grant. Factual terminal observation remains possible without granting new work. Exhaustion, cancellation, unresolved effects and unknown billing must hold further work. Focused production regressions cover these negative boundaries alongside the public workflow tests.

This qualification exercises `runWorker` through the default server. The CLI worker uses the same supervisor. Direct `runOnce` and `reconcile` calls retain their narrower behavior. Historical frozen GPU operator scripts that drive those calls are outside this qualification; adapting and testing their entrypoint and budget policy is required before reusing them for live discovery. This work also does not qualify their aggregate request allowance or reported-dollar enforcement inside a single Pi prompt. Saved SDK ceilings and the reported-billing checks at recovery do not establish those separate live budget controls.

## Scope

A passing report qualifies the offline recovery slice. It does not authorize live trials or demonstrate real-model authoring competence, GPU integration or biological improvement. Live GPU and paid model trials remain on hold while this redesign is implemented and reviewed. Broader discovery acceptance still needs its own named behavior scenarios for draft repair, admission, context pressure, memory-informed followups and scientific stop conditions.
