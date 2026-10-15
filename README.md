# Autofold

Autofold's active backend uses Pi 1.0.1 for generic agent execution and a separate scientific core for contracts, research state, evaluation, and evidence. Development happens on `main` in `/Users/vincentallam/Developer/autofold`.

## Run the backend and CLI

```sh
npm ci --ignore-scripts
npm run research:cli -- --help
npm run demo:offline
npm run dev:backend
# In another terminal, for the Pi research UI at http://localhost:3000:
npm run dev:web
```

`demo:offline` executes the actual Pi agent loop, Python worker, frozen evaluator, and SQLite persistence with synthetic CPU fixtures. It makes no provider requests and establishes no biological evidence. It creates a disposable project directory and prints its location and receipt IDs.

Live agent turns use `OPENROUTER_API_KEY`. Model access goes through Pi's OpenRouter provider; the default is `deepseek/deepseek-v4.1-flash`, with verified OpenRouter metadata registered locally. Select another registered OpenRouter model with `--model`. Existing sessions and jobs retain their persisted model selection.

```sh
# Set OPENROUTER_API_KEY in your shell or secret manager.
npm run research:cli -- autoresearch EXP_ID --iterations 2 --request-id first-discovery
npm run research:cli -- worker
# A conversation has no compute grant unless --allow-compute is explicit.
npm run research:cli -- scientist message EXP_ID --request-id review-result --prompt "Review the saved evidence."
```

Use `campaign create/activate`, `target add`, and `experiment create/activate` to establish a frozen experiment before discovery. `experiment create` accepts a contract JSON file; `evaluators` prints installed evaluator identities and source hashes. The CLI help lists every command.

## Three self-improvement loops

The experimental layer changes Proto programs and scientific methods using verified same-contract outcomes. The OKF layer accumulates sources and outcomes, reconciles hypotheses and contradictions, and feeds scoped knowledge back into scientific decisions. The procedural layer revises immutable skill guidance when recurring evidence-backed method gaps justify a change, then evaluates it through independent paired shadow replays.

Pi supplies agent execution to all three layers. The scientific core owns measurement authority and frozen contracts; the OKF wiki is a projection of that core. Reviewed claims remain interpretations, and repeated citations cannot manufacture computational or biological validation. See [the delivery target](docs/pi-product-delivery.md) and [the knowledge plane](docs/knowledge-plane-v1.md).

## Package boundaries

- `backend/engine/src/runtime`: the actual Pi Agent loop, OpenRouter model configuration, serial typed tools, cancellation, limits, and a durable session journal. Pi sessions declare their runtime and cannot silently resume donor transcripts.
- `backend/engine/src/scientist`: one durable scientist per frozen experiment, named native programs, captured validation, prospective decisions, empirical memory and trusted research yields. Mutable files are confined to its experiment.
- `backend/engine/src/jobs`: independent durable worker claims, renewable leases, checkpoint recovery, cancellation and parent-child ownership. Only marked Pi jobs are eligible.
- `backend/engine/src/campaign`: direct scientist continuation, bounded campaign policy, residual resource accounting and exact human contract approvals.
- `backend/engine/src/knowledge` and `knowledge-review-controller`: bounded campaign graph retrieval and independent, snapshot-bound claim reconciliation with a durable audit cycle.
- `backend/engine/src/feedback`: verified trajectory and authoring feedback projected into bounded refinement decisions.
- `backend/engine/src/literature` and `skills`: verified source excerpts, atomic request assessments, immutable guidance, evidence-frozen refinement and independent paired shadow replay.
- `backend/engine/src/acceptance`: source-bound native acceptance reports with locally reverified worker receipts and outcome-to-next-action chronology.
- `backend/engine/src/discovery`: lower-level scientific port used by the offline demonstration and direct debugging.
- `backend/engine/src/execution`: immutable trial bundles, frozen-input admission, Python worker transport, durable evaluation request IDs, artifact/provenance verification, and reconciliation.
- `backend/science-core`: selectively extracted domain schemas, SQLite store, trusted research/job services, evidence, knowledge, workflow compiler, and artifact storage. It has no dependency on OpenScience sessions, tools, providers, or project globals.
- `backend/worker`: the preserved Python scientific execution boundary, Proto adapters, stage isolation, and locked evaluators.
- `frontend/workspace/src/research`: the default Pi research UI. Campaigns, frozen experiments, scientist messages, program edits, verified receipts, research questions, skills and durable jobs use the supported Pi API. Earlier SDK screens remain reference source and are not the active application.

Scientific data and conversation data have distinct owners: the scientific SQLite store owns experiment outcomes; the Pi journal owns conversation/tool boundaries. Worker receipts must pass frozen identity, content hash, and provenance checks before they can change the scientific incumbent. A lost or uncertain dispatch is reconciled rather than automatically executed again. If a local process crashes after dispatch intent is durable and no worker manifest can be recovered, the request stays unresolved and requires operator investigation; local worker reattachment is not implemented yet. Mock and CPU heuristic receipts remain explicitly labelled as infrastructure evidence.

## Data and execution configuration

New projects use `WORKSPACE/.autofold/research/<project>.sqlite`; Pi transcripts use `WORKSPACE/.autofold/pi/<project>/sessions.sqlite`. `--workspace` selects the project directory. `--project` and `--data-dir` explicitly select an existing scientific store. Starting the new backend does not migrate legacy state or resume old jobs.

Inspect existing data without writes:

```sh
npm run research:cli -- legacy inspect --database /absolute/path/to/project.sqlite
```

The scientific store retains the original `metadata`/`records`/`blobs` SQLite layout and checkpoint encoding. Compatibility was verified on a temporary snapshot of the existing database, including byte-identical rows/blobs after a no-op write. Existing donor sessions and pending job payloads require an explicit runtime migration; `ses_` IDs alone do not make a transcript a Pi transcript.

Proto execution is disabled by default. A host-selected `--execution-config FILE` (or `AUTOFOLD_EXECUTION_CONFIG`) provides executable paths, exact Proto language/tools commits, and execution caps. Those grants cannot come from model tool arguments or HTTP bodies. For a controlled local CPU Proto worker, the shape is:

```json
{
  "proto": {
    "root": "/absolute/path/to/proto-language",
    "python": "/absolute/path/to/proto/environment/bin/python",
    "languageCommit": "<40-character commit>",
    "toolsCommit": "<40-character commit>"
  },
  "authorization": {
    "localProto": true,
    "maximumGpuSeconds": 0,
    "maximumCandidates": 8,
    "maximumWallTimeMinutes": 2
  }
}
```

Authored Proto programs are executable Python: select a controlled worker account when enabling them. Local and SSH transports are implemented. A remote profile adds `remote: {host, root, python, protoRoot, protoHome, boltzgenExecutable, boltzgenCache}` and explicit `authorization.remote: true`. Remote readiness verifies pinned runtime commits; staging freezes the worker and inputs. A host-side fsynced launch attempt prevents repetition even if the remote receipt disappears. Existing receipts can be reconciled and are reverified locally. A missing receipt after a launch attempt remains unresolved. The remote worker environment has an explicit allowlist; see `backend/worker/REMOTE_ENVIRONMENT.md`. Process timeout/cancellation is supervision of a trusted worker, not an OS sandbox for hostile Python.

Campaign recursion can yield to bounded literature review, resume the same scientist after a trusted assessment, and chain capability refinement into at least three paired shadow replays. Every arm gets independent program/session provenance and the same frozen budget. Fixture receipts cannot establish production skill activation or project-library promotion. Only optimize trials can change an incumbent.

The HTTP server binds to `127.0.0.1`. Configure allowed browser origins with `--cors`, and optional bearer authentication with `AUTOFOLD_API_TOKEN`. API and provider keys are supplied by the host and are not persisted in Pi sessions. Direct debugging runs default to 12 turns, 24 tools, five minutes and $2. Durable scientist jobs default to 16 turns and 32 tools per bounded continuation, with cumulative model-cost accounting and a separate overall deadline derived from authorized evaluations and authoring time. Responses have a 4,096-token cap. Cost is checked at response/tool boundaries; one in-flight request may cross the dollar cap. Limits are operator settings, not a guarantee of provider billing. Discovery HTTP requests enqueue promptly; closing a browser does not cancel its job. Use the job cancel API or CLI to stop owned work. Cancellation cascades to child jobs; atomically checked parent leases prevent children escaping a cancelled campaign.

## Check the migration

```sh
npm run check:product
npm run check:discovery
npm run demo:offline
```

The component checks exercise the Pi loop, cancellation, concurrent session leases, interrupted tools, durable request reuse, tamper rejection and scientific SQLite recovery. `check:discovery` additionally requires the [behavioral recovery suite](docs/acceptance/behavioral-recovery-suite.md): a real public server, Pi HTTP/SSE against loopback, native CPU work and external controller faults. Missing native prerequisites block that qualification. Portable component tests alone may skip optional native fixtures and do not qualify discovery. These offline fixtures make no paid provider or GPU calls; historical live acceptance evidence is recorded separately.

Software verification on 2026-10-03 includes the complete core/engine/worker suites, actual two-iteration native CPU Proto fixtures, closeout and restart recovery, bounded campaign/refinement/replay tests, typechecks and the production UI build. Browser acceptance uses the actual temporary HTTP backend and SQLite, real synthetic Python receipts and offline inference. It caught and fixed a native browser fetch-binding bug; message enqueue/cancel, revision-checked program saves, verified receipt viewing and evidence-bound refinement queueing pass. These are software checks. Live native GPU acceptance is recorded separately in `docs/acceptance/`; it must not be inferred from fixtures.

For repeatable isolated browser checks, run `bun run tooling/script/pi-ui-acceptance.ts`. It prints a loopback URL and temporary workspace; it neither attaches to nor restarts existing app servers. Browser-created jobs remain queued and never invoke a provider automatically.

Run native acceptance against an explicit frozen scientific experiment and reviewed host profile:

```sh
npm run research:cli -- acceptance native EXP_ID --workspace /absolute/project \
  --execution-config /absolute/profile.json --request-id bounded-native-v1 \
  --iterations 2 --max-cost 1.8 --model deepseek/deepseek-v4.1-flash
```

The command archives source hashes, profile identity, contract, session/journal, exact receipts and trusted closeout chronology under the project’s `.autofold/acceptance/`. A two-iteration command succeeds only with `fullTwoIterationAcceptancePassed`. Fixture runs are always labelled `fixture_only` and cannot pass native acceptance. A computational acceptance result establishes neither sustained method improvement nor biological validation.

An optional legacy compatibility check uses a disposable copy of a supplied SQLite snapshot:

```sh
AUTOFOLD_LEGACY_COMPATIBILITY_FIXTURE=/absolute/path/to/snapshot.sqlite npm run test --workspace @autofold/science-core
```

## Preserved implementation

The latest old implementation remains intact at `/Users/vincentallam/.codex/worktrees/443e/autofold`, on `codex/archive/pre-pi-library-20261003T163959Z`. It is a reference library, not a runtime dependency of this backend.

Verified source archives, binary patches, saved Git state, a history bundle, and the removed old backend directory are in `/Users/vincentallam/Developer/autofold-archives/20261003T163959Z`. The previous primary checkout changes are additionally preserved at `codex/archive/pre-pi-primary-20261003T163959Z` (the archive manifest contains the stash identity).

Earlier documents in `docs/` and `autofold.md` describe the preserved implementation. This README describes the active backend. The migration is uncommitted on `main`; no remote branches have been changed.
