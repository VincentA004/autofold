# Backend consolidation — October 11, 2026

The reviewed 26-file consolidation is applied to the main checkout. Synchronous discovery and queued autoresearch now share one managed scientist, job ownership and session accounting. Native Proto inspection and unconditional evidence execution use shared implementations. Conditional/routed execution and historical receipts keep their compatibility paths.

## Changes

- `Application.discover()` enqueues and executes the managed discovery job rather than creating a second runtime/tool loop. It preserves the response shape and supports idempotency, explicit limits and runtime overrides. A job owned by another worker is observed without stealing ownership. The offline demo uses an injected scientist fixture.
- `DecisionEvidence` now supplies a compact scientist context card plus `evidence/decisionEvidence.json` and `evidence/candidateArchive.json`. Summaries use verified receipt artifacts; missing receipts remain explicit gaps.
- Indexed scoped SQLite reads/transactions serve ownership checks and heartbeats. Ancestors are read in the same snapshot, scoped writes cannot mutate them or unrelated records, and broad scientific transactions keep their full-state path. An unchanged running heartbeat no longer rebuilds lifecycle receipts. Scoped writes defer whole-store blob collection to full transactions.
- Native object discovery/extraction/config validation lives in the Python inspection module. TypeScript invokes the structured worker CLI and validates returned admission metadata rather than embedding duplicate Python programs.
- Knowledge CRUD/review/reconciliation moved into a dedicated service behind the existing facade. Trial and synthesis transactions remain in their existing owners.
- The current evidence paths share recorder helpers; conditional/routed scheduling is isolated under `compatibility/evidence_dag.py`. The historical Boltz v1 adapter remains byte-identical.
- Default authoring emits explicit native search/output declarations. Portfolio wrapping remains an explicit option. Canonical JSON projection has one shared TypeScript implementation with unchanged wire rendering.
- The SDK v1/v2 server launchers share process plumbing. Generated protocol clients remain because the UI still consumes v2; this change does not migrate that protocol. An unused campaign-policy stub was removed.

## Verification and limits

Main-checkout checks passed: **555 TypeScript tests**, **100 worker tests**, backend and SDK typechecks. Two optional tests were skipped across the suites. The scoped-store regression checks unrelated corrupt blobs, ancestor ownership and write fencing; managed discovery tests check synchronous/queued session identity, idempotency and failures. Recorded log paths are `/private/tmp/autofold-consolidation-main-tests.log`, `/private/tmp/autofold-consolidation-main-worker-corrected.log` and `/private/tmp/autofold-consolidation-main-types.log`.

Production host fingerprint: `sha256:fc7db9a15d733fcd63925639013ca66cf598211705c0c2c1db5091fb41857516`. Worker fingerprint: `sha256:e0294d9753ffb49f1082094b73a90c1650cea6116ba53a23f715ae58fafa3c53`.

The first live validation was blocked by provider privacy routing before a completed LLM response or GPU dispatch. See [the preserved validation](../acceptance/backend-consolidation-validation-2026-10-11.md). Offline checks establish implementation behavior, not live GPU/LLM acceptance, all-model compatibility or scientific improvement. The compatibility DAG, protocol migration and broad scientific transactions remain deliberate boundaries; there is no claim that all backend duplication has been removed.


The [fresh default-router follow-up](../acceptance/backend-consolidation-default-validation-2026-10-11.md) subsequently passed GPU execution, managed authoring and verified decision-evidence reading at unchanged source. Its overall acceptance failed actual-versus-estimated billing equality; the generic SDK adapter estimates static prices instead of preserving OpenRouter usage.cost. Live context/reference inventories also remain large. All original effects settled and resources stopped. No further GPU/LLM work or receipt rewrite was used to address those findings.
