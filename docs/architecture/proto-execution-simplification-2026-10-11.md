# Proto execution simplification

The authoring surface now emits native `build_trial(ctx) -> ProtoTrial` templates. New templates no longer emit the legacy `build_program` and `AUTOFOLD_WORKFLOW` representations. Existing readers remain so original captured programs and receipts can still be verified.

The host shares one bounded registry discovery per immutable execution instance. Admission still rechecks selected runtime paths, capabilities and authorization. Native program inspection captures any compatibility metadata in the same subprocess and uses the worker's shared object inspector. Condition and stage budget schemas have one definition.

Fixed calibration/control declarations use a versioned executable-settings descriptor (`native_object_v2`). Function configuration, role, threshold, input lengths, proposal source, fixed sequences and sample/result ceilings are compared before execution. Descriptive text and optional synthetic CPU probes are advisory and excluded from execution fidelity. Older fixed inventories retain their original shape; old failed trials are not rewritten.

## Execution ownership

Proto owns the native program, optimizer, generator and model functions. Autofold owns trial admission, target and evaluator freezing, ceilings, immutable bundles, provenance, receipt verification and canonical settlement. These responsibilities remain necessary when a native model is called directly.

`native_tool_sequence_v1` is a host-selected alternative for unconditional panels. It directly invokes the pinned Proto tool functions in the frozen order, sharing the same configuration, seed injection, timeout enforcement, structure/metric recording and locked scoring isolation as the existing executor. Ordered dependencies preserve artifact provenance. All conditions, candidate ranking/routing, duplicate stage IDs and out-of-order dependencies are refused before a model call. This is not a new Proto `Program` scheduler.

`legacy_dag_v1` retains historical conditional and candidate-routing behavior. It is selected automatically for conditional or candidate-routing plans. Future unconditional ordered plans now select the direct native sequence by default after the live comparison passed; captured bundles remain unchanged. Both paths use the same native scientific tools; the comparison isolates the outer scheduling layer. A successful fixed-input flat-panel comparison cannot establish that the whole conditional DAG can be deleted. Independent portfolio lanes also remain: the pinned native `Program` requires its optimizers to share constructs, while Autofold's portfolio can hold independently constructed programs.

## Validation and live comparison

Backend typechecks passed. The full worker suite passed 84 tests with one optional skip. A full backend pass exposed two CPU fixture compatibility failures after template migration; their corrected execution/scientist tests passed all 66 cases. The prior full pass and corrected checks are preserved separately, rather than relabeling the failed log as a clean full-suite run. The shared inspector/templates tests passed 18 cases. CPU parity covers two candidates, two seeds, dependent stages, equivalent model configurations, outputs and artifact lineage. Unsupported graphs are refused before any model/output effects.

The exact fixed native program was executed locally with no generator or model tools and yielded only `SVYNPIFNKYFG`; the worker static descriptor matched the host descriptor. This is an engineering reference from a previously observed candidate, with unknown biological activity.

The human authorized two fresh GPU trials, at most one hour, $2 recorded inference and 600 GPU seconds per trial. The intended comparison uses identical fixed sequence, target, evaluator, MSA-free Boltz2/Chai1 parameters and scoring seed 20260809, with no inference or SDK session initialization. Each path gets one original request, no replacement work and no deliberate fault. The original one-hour deadline is recorded once at launch. All previous grants remain closed.

Fresh workspace: `.autofold/proto-execution-parity-20261011`. The original two GPU trials both succeeded with score **0.32058650553226475**, identical native metrics and parameter hashes, intact artifact lineage and no new effects on receipt re-verification. The first prelaunch driver deadline mismatch is preserved; supported original first-launch continuation completed the same approved pair without resetting the deadline or creating replacement work. Recorded inference is $0; all original resources stopped, prior evidence is unchanged and the grant is closed. See [the exact comparison and scope](../acceptance/proto-execution-parity-2026-10-10.md).


Post-closeout release verification passed **633 tests with two optional skips** (189 scientific core, 361 engine, 83 worker passes), plus both backend typechecks. The combined run retains an initial new-selector fixture failure; a separate full scientific-core rerun passed after completing its required commit/config/budget fields. The complete engine section passed with zero failures. Two host source files changed after the live grant closed, selecting the already tested native path; worker source is unchanged. Both original receipts reopened without new effects after this change, and the six historical workspaces remain unchanged. Release source fingerprint: `sha256:d7991b0661dd74167ffb24120881b7eb86fc44e3b6c5f09a4bc9d411e4b31813`. Evidence: `operator/post-closeout-release-audit.json`.
