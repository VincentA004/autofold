# Change 4 validation

Change: separate the persistent authoring-slot generation seed from frozen evaluator scoring seeds.

## Passing gates

- `npm run typecheck:backend` — science-core and engine TypeScript checks passed.
- `bun test backend/science-core/src/research/service.test.ts backend/science-core/src/research/programs.test.ts backend/science-core/src/research/generation-seed.test.ts` — 35 passed.
- `bun test backend/engine/src/execution/native-search.test.ts` — 3 passed, including separate generation-seed provenance and mismatch rejection.
- `bun test backend/engine/src/scientist/scientist.test.ts -t 'validated native declarations survive schema key reordering at execution admission'` — 1 passed. The synthetic validation and final preflight use the same seed; the bundle keeps evaluator seeds `[7, 11]`.
- `bun test backend/engine/src/scientist/scientist.test.ts -t 'same persistent scientist performs two real CPU evaluations'` — 1 passed. Validation/revalidation after draft edits retains the slot seed, the next request gets another seed, and reopening reuses the saved seed and receipt.
- `bun test backend/engine/src/skills/skills.test.ts -t 'three real paired workers use independent programs/sessions'` — 1 passed. Six new arm slots have six distinct persisted generation seeds; evaluator seeds remain experiment-fixed.
- `PYTHONPATH=backend/worker PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 CUDA_VISIBLE_DEVICES='' .autofold/envs/proto/bin/python -m unittest backend.worker.tests.test_proto_trial backend.worker.tests.test_generation.GenerationCaptureTest.test_records_observed_generator_components_and_structure` — 6 passed. Legacy contexts/artifacts remain seed-field absent; explicit generation seed is recorded independently from the actual program seed.
- The same offline Python environment running `-m unittest backend.worker.tests.test_generation` with the approved unsandboxed CPU test launch — 6 passed.
- `git diff --check` on changed Change 4 files — passed.

No GPU, model-provider, or network calls were made.
