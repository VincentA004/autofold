# Native Proto scientific search

Implemented October 11, 2026 in the main checkout. The installed Proto language/tools pins remain unchanged. This implements the native-semantic integration work identified in the [capability audit](../research/proto-full-capability-audit-2026-10-11.md); it does not upgrade dependencies or reopen a GPU grant.

## Scientific ownership

The scientist authors `build_trial(ctx)` returning `ProtoTrial(program=..., search=NativeSearch(...), hypothesis=...)`, plus the existing prospective decision declaration for evaluation. `program` is a real native Proto Program, or independent native Programs in the thin portfolio wrapper. Proto owns generators, hard filters, weighted objectives, optimizer algorithms, shared constructs, staged result handoff, conditioning, logits and structures. Native energies remain search diagnostics. Autofold adds the independently frozen evaluator, preserves external effect identity, and settles its original receipts.

The author can select native rejection, MCMC, cycling, gradient, beam or population search, use registered objectives or source-visible custom constraints, and declare fresh generator instances of the same type in multiple stages. No native optimizer setting is rewritten to satisfy a final-candidate quota. Differentiable objectives still require a supported native backward/provider path; an API name is not proof of scientific suitability or installed assets.

This path is explicit and versioned as `autofold.native-search.v1`. Historical trials without `search` retain their old admission, allocation, extraction, scoring and receipt behavior. Fixed controls cannot opt into mutable native search. No historical acceptance decision or grant is rewritten.

## Authoring interface

Import `NativeSearch` and `NativeOutput` from `autofold_worker.proto_trial`. A search declaration has these independent ceilings:

| Field | Meaning |
| --- | --- |
| maximum_candidates | Unique final protein designs selected for independent evaluation |
| maximum_proposals | Sum of aligned proposal-pool sizes requested across generator sampling invocations; tied segments use their maximum pool size |
| maximum_sampling_calls | Generator sampling invocations, not optimizer steps |
| maximum_tool_calls | Registered native API requests, including cache lookups; not physical inference count |
| maximum_wall_seconds | Whole search wall time, including constraints, conditioning and setup |
| allowed_tools | Exact native tool keys admitted for the search |
| outputs | Explicit construct or segment selections, including independent portfolio lane |

An optimizer's native step/population/offspring settings remain authored settings in the frozen projection. Sampling-call and proposal ceilings are not renamed as gradient-step counters. Learned gradient calls share the registered API gate; tool-free analytic gradients remain bounded by frozen optimizer configuration and whole-search/worker wall time.

For example, `outputs=(NativeOutput(construct="design", segment="binder"),)` submits the selected binder region rather than its fixed partners. Omitting `segment` selects one concatenated native Construct; concatenation is not a multi-chain assembly. A one-segment Construct preserves that segment's original structures/logits and metadata. Duplicate final strings are one protein candidate, not independent evidence. Excess final outputs fail rather than silently truncating them.

The current locked evaluator accepts canonical protein-sequence outputs. Native internal designs and fixed partner inputs can be richer, but this change does not claim end-to-end chemistry, ligand, glycan, MSA or multichain final-evaluator support. Such designs need a separately specified contract and input-preserving evaluator.

The [two-stage CPU example](../../backend/worker/examples/native_search_trial.py) uses real native MCMC, a hard length gate and a soft repetition objective. It demonstrates authoring semantics, not binding efficacy or a default scientific intervention.

## Admission and execution

Read-only inspection derives stable lane/stage/generator/constraint instance IDs and an exact native object projection. It captures optimizer/generator/constraint settings, source-visible callables and closure configuration, original inputs, construct/segment relationships, external fixed partner inputs and explicit output selections. Host/worker target paths are normalized to frozen input identities. Inspection rejects registered native tool execution during module loading or construction, even if authored code catches the resulting error; it is construction inspection, not a search run. The projection is bounded to 256 KiB and included in the immutable pipeline/bundle identity. The worker reconstructs and compares it before executing any native search.

The host resolves unique generator implementation keys separately from configured component instances, validates their pinned registry declarations and admitted tool keys, and reserves search wall time plus diagnostics/frozen evaluation under the existing aggregate worker budget. The actual generator instances retain distinct configurations and provenance even when their keys repeat. Independent portfolios bypass the old one-type-per-lane policy only through this explicitly frozen native path. Legacy per-lane allocations are rejected rather than silently overridden; native portfolios use the declared aggregate search ceilings.

The generator observation wrapper preserves all positional and keyword conditioning arguments and records requested proposal pools, completion/failure and instance identities. It does not truncate pools, modify optimizer counters, or conflate output and search budgets. Resource violations latch and cannot be turned into success by a later caught exception.

The native public early-dispatch hook admits and records typed input/config hashes before cache lookup, preprocessing or pool dispatch. It falls through to Proto's original execution path. A scoped Python return observer captures the API result without re-entering the tool function; native caches/postprocessing execute once. Existing profiling contexts are rejected rather than overwritten. API request records explicitly mark cache origin as unobserved; cache hits and pool fan-out are not counted as independent physical executions.

Implicit remote MSA configuration and new execution-recipient overrides are rejected at the registered tool boundary. Original runtime pins, worker aggregate deadlines and durable effect receipts remain authoritative. This is a trusted scientific execution boundary, not a security sandbox for arbitrary adversarial Python or a complete census of internal subprocess/model work. Opaque helper side effects must not be represented as observed registered tool calls.

## Scientific evidence and recovery

`native-search/receipt.json` contains original run/program identity, admitted projection, resource counts, generator instance events, registered API request records, per-stage native histories/energies, result pools and selected outputs with metadata, structures and logits. Nonfinite diagnostic values are preserved explicitly as strings; they cannot manufacture a valid final score. Evidence is bounded to 32 MiB and fails explicitly rather than silently truncating scientific state. Native stages only retain history at the intervals configured by the author; proposal capture requires the native tracking options.

The generation index binds this receipt's hash. Candidate generation provenance groups repeated types with their full configured instance list. The host verifies the receipt on every original run read: admission identity, counters, executed instance references, tool declarations, time and exact submitted sequence correspondence. Missing or tampered evidence fails verification. It returns a compact verified search summary and a scoped readable evidence path to the scientist; objective components remain available in the full receipt.

Native optimizer state is scientific handoff data, not a leased external-effect transaction. Existing supervisor/coordinator original-receipt recovery remains responsible for canonical settlement. Recovery never invokes `Program.run()` to reconstruct a completed effect.

## Discovery and procedural knowledge

The existing model registry now includes native constraint and optimizer cards in addition to tools and generators. Full cards preserve config/backward schemas, tool dependencies, constraint modes and optimizer compatibility metadata. Generator and component discovery share one interpreter inventory call. `read_model_card` supports all four component kinds. The planning view is compact; registration, assets, checkpoint rights, hardware fit and scientific calibration remain distinct.

Scientist guidance teaches native search composition, explicit final region selection, separate work/output budgets and objective-versus-evaluator authority. Pinned API references include constraints, MCMC, cycling, gradients and population search. Existing BioNeMo-derived skills and their activation policy remain intact.

## Validation boundary

Offline tests cover same-type staged generators, conditioning arguments, unchanged optimizer settings, budget exhaustion before extra effects, exact output selection, fixed partners, registry/recipient gates, complete histories/provenance, native receipt tampering and unchanged scoring identity. The pinned CPU worker reconstructs and executes the example, captures its scientific receipt and rejects a changed admitted configuration. A separate analytic gradient smoke check uses no learned model/GPU and verifies backward-source and logit/history capture.

The [verification record](native-proto-search-verification-2026-10-11.json) records 650 passing tests, two optional skips, both passing backend typechecks and source/log identities. Three earlier timeout failures passed in a complete unchanged-source rerun with system sleep prevented; the earlier failure log is retained. No real GPU execution, LLM/provider inference, dependency installation, new recipients or campaign continuation was performed for this change. Learned-model combinations and broader evaluator modalities require a future finite, explicitly authorized acceptance run.


## First live boundary check and portable policy bytes

The [first GPU-validation attempt](../acceptance/native-proto-gpu-validation-2026-10-11.md) failed before model execution because native small-number settings exposed an ECMAScript/Python JSON rendering mismatch. After the original run was terminal and its grant closed, new native bundles gained `pipelineCanonicalJson`: the exact host canonical bytes whose hash is the existing `pipelineHash`. The worker verifies complete semantic correspondence before hashing those bytes, rejects duplicate/nonfinite/oversized input, and retains the old verification path for historical bundles. The original failed worker capture remains unchanged. This fix passed 349 offline checks and both backend typechecks; a successful live GPU validation is still outstanding.


The [subsequent fresh check](../acceptance/native-proto-gpu-validation-fixed-2026-10-11.md) confirmed portable bundle admission and a completed native Boltz2 request, but an operator fixture selected `iptm` when the pinned constraint had selected `protein_iptm`. Schema membership does not guarantee a component is produced for every complex. Test objective/metric branches before GPU use, preserve the selected raw component, and reject missing evidence. The corrected fixture passed full staged execution with mocked model outputs. Complete native GPU receipt and independent final-scoring acceptance remain outstanding.


## Corrected live GPU acceptance

The [corrected fixture passed](../acceptance/native-proto-gpu-validation-objective-2026-10-11.md) the full native GPU path: staged search and rich native receipt, explicit binder output, independent frozen Boltz2/Chai1 final scoring, original receipt re-verification, canonical settlement and physical shutdown. The valid final score was 0.3445428214967251; the GPU optimizer rejected a worse proposal and retained its incumbent, so this check establishes functioning search semantics rather than objective improvement. Source pins and all ten earlier workspaces were unchanged, the grant is closed, and no LLM inference ran. The two earlier failed attempts remain failed and preserved. Broader models/modalities and autonomous scientific benefit remain unvalidated by this engineering fixture.
