# Proto capability and Autofold integration audit

Research date: October 11, 2026 (America/Chicago). Read-only audit; no production edits, library update, deployment, GPU work, inference, or new grant. Current upstream was retrieved into a separate temporary directory; the installed pinned checkouts were not fetched into or changed.

## Finding

**Autofold is using real Proto for candidate generation and native model invocation, but it is not using Proto's full design and optimization capabilities.** The largest gap is not the number of model cards. It is that Autofold's admission, candidate extraction, resource accounting, and post-generation evidence adapter reduce a rich native design program to a narrow sequence-generation lane plus a structure-prediction panel.

The new `native_tool_sequence_v1` is an effective simplification of a flat scoring panel. It is **not a replacement with native `Program` orchestration**: a Python iterator chooses invocation order, then Autofold creates the typed inputs/configs and calls each native `ToolRegistry` function. Actual native `Program.run()` already executes the authored generation program, separately. The two successful parity trials prove one fixed peptide's two-model frozen panel produces identical outputs under the two ordering paths. They do not prove multi-stage search, feedback optimization, arbitrary diagnostics, chemistry preservation, or every conditional DAG can be replaced.

A better architecture gives native Proto ownership of the **inner biological search**—constructs, generators, constraints, optimizers, state handoff, and model execution—while Autofold retains **outer experiments and durable execution**—authorization, aggregate resource limits, pinned runtime, independent final scoring, immutable evidence, receipt settlement, and scientist memory. Most of the capability needed for that architecture is already present in the installed language version.

## Version and evidence boundaries

| Component | Installed Autofold pin | Latest official main retrieved | Status |
| --- | --- | --- | --- |
| proto-language | `d3b7822f74ea64747cc751a3b2ab1aa6b799ac47` | `23de7a82b0789732a377ed8e79f73bcabbb8df4a`, committed October 10 at 23:42:01 UTC | Latest adds run/stage-level Modal dispatch and related compute-context changes |
| proto-tools | `47e34afa5ea240a3b406e323dc38aa5dc85f223e` | `43868eb1af64c694b9fd1b08559871e0969cac08`, committed October 10 at 23:35:31 UTC | Broader tool catalog, Modal infrastructure, mixed molecular/genomic model support, operational changes |

The exact gitlink in latest language is **`43868eb1af64c694b9fd1b08559871e0969cac08`**, the same tools commit retrieved. This verifies intended source pairing, not that the pair has passed our integration or live tests. Both repositories' GitHub Releases API returned an empty list; these are main commits, not stable release versions. Search-crawled GitHub pages displayed older submodule hashes; live API/source wins.

Primary immutable references: [installed language](https://github.com/evo-design/proto-language/tree/d3b7822f74ea64747cc751a3b2ab1aa6b799ac47), [latest language](https://github.com/evo-design/proto-language/tree/23de7a82b0789732a377ed8e79f73bcabbb8df4a), [installed tools](https://github.com/evo-design/proto-tools/tree/47e34afa5ea240a3b406e323dc38aa5dc85f223e), [latest tools](https://github.com/evo-design/proto-tools/tree/43868eb1af64c694b9fd1b08559871e0969cac08).

Coverage and reproducibility:

- Official documentation [index](https://proto.evodesign.org/docs/llms.txt) and full text were retrieved. The full text contains **313 source-page entries**. Relevant concept, guide, optimizer, example, and runtime documentation was reviewed alongside implementation. Some core concept/entity pages are short placeholders; source was necessary to establish behavior.
- Source inspection focused on all seven core language abstractions, all six optimizer families, generator conditioning and tied segments, model-backed structure constraints, compiled scorer providers, mutation/MPNN composition, Program persistence/export, tool registry routing/cache/validation, ToolPool, DeviceManager, ToolInstance, shared molecular/structure/MSA entities, and model-selection/runtime notes. Selected model wrappers and representative design examples were inspected. This is a capability audit, not a claim that every line of all 170 tool operations or all notebooks was read or executed.
- Static AST inventories found **81 constraint registrations, 16 native generator registrations, 6 optimizer registrations**, and **170 tool registrations** in latest source, including 10 testing operations. Installed tools source contains **143 registrations**, also including 10 testing operations. Counts are static source declarations, not a runtime registry or proof of installed assets. Autofold adds its own generator adapters and projects a curated scientific model-card subset; its earlier 92-card inventory is not the total upstream toolkit.
- Temporary evidence directory: `/private/tmp/autofold-proto-latest-audit/`; includes isolated source snapshots, documentation corpus/index, exact latest language tree/gitlink, release responses, and static component inventories. API responses also saved as `/private/tmp/proto-language-latest-commit.json` and `/private/tmp/proto-tools-latest-commit.json`.
- Autofold production audit used `/Users/vincentallam/Developer/autofold`, not the Codex worktree. No new capability tests were executed for this audit. The existing parity acceptance report is the live evidence available for the flat executor change.

## What native Proto actually expresses

### Biological state and composition

`Sequence` holds type (`dna`, `rna`, `protein`, or ligand SMILES), string, optional logits, optional structure, user metadata, and distinct namespaced constraint/generator metadata. `Segment` holds original input plus proposal and surviving-result pools. `Construct` joins aligned segment result pools position-wise. Native generators can be tied to multiple equivalent segments to enforce shared designs, for example symmetric protomers. Native constraints accept tuples of input segments, allowing a designed chain to be scored jointly with fixed partners. [Sequence source](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/sequence.py#L71), [Construct source](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/construct.py#L33), [Generator source](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/generator.py#L57).

**Important limitation:** a language `Construct` concatenates homogeneous sequence types; it is not by itself the complete typed biomolecular `Complex`. Tool-layer `Complex`/`Chain`/`Fragment` objects preserve molecular entities, chain IDs and CCD modifications. MSAs have typed per-chain and paired representations. Structures have coordinates, metrics and residue/chain selection facilities. Do not model a multi-chain assembly by accidentally concatenating chain strings. [Complex source](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/proto_tools/entities/complex.py), [prediction input source](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/proto_tools/tools/structure_prediction/shared_data_models.py#L86).

The inspected shared Chain/Complex wrapper exposes CCD residue modifications and ligand fragments, but no generic bond/cyclic/disulfide field was found. Underlying model documentation can claim chemistry that its Proto wrapper does not expose. The ESMFold2 README describes broader covalent capability, while the wrapper input described here exposes chains/modifications/MSAs. Chemistry support must be established field-by-field through the selected wrapper and runner, not inferred from a model's headline capability.

### Real native search and optimizer staging

`Program` executes multiple optimizer stages on **the same Construct objects by identity**, retaining results for subsequent stages. Each stage must use fresh generator and constraint instances; **the generator type/key may repeat**. Native input validation checks starting sequences, prompts, structures and stage availability. Stage execution is inspectable through `run_stage` and stage results. [Program source](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/program.py#L69), [multi-stage guide](https://proto.evodesign.org/docs/language/guides/examples/multi-stage-optimization).

| Native optimizer | Useful behavior | Caveat |
| --- | --- | --- |
| Rejection sampling | Batch proposals, threshold filters, retain lowest-energy top K, optional early stopping; can evaluate existing result pools | Requires a useful prior; final result count differs from total proposals |
| MCMC | Refine existing designs with scored mutations and annealed acceptance; multiple trajectories/proposals | May accept a worse intermediate proposal; final monotonic hill climbing is not guaranteed |
| Gradient | Optimize logits through differentiable objectives; schedules for loss weights, temperature and continuous/discrete relaxation | Only supported differentiable providers; logits and optimizer handoff matter |
| Cycling | Repeated conditioning → generation → filter acceptance; built-in Protein Hunter predicts structure then inverse-folds | Constraints are filter-only, not general soft rankers; not all cycles improve energy |
| Genetic algorithm | Population, crossover, mutations, elitist/generational replacement; optional NSGA-II Pareto survivor selection | Population and offspring budgets differ from final retained candidates |
| Beam search | Score partial sequences and extend promising prefixes | Not a continuation of previous stage result pools in the same way as MCMC |

All six are implemented in `proto_language/optimizer/`; official references: [rejection](https://proto.evodesign.org/docs/language/optimizers/rejection-sampling), [MCMC](https://proto.evodesign.org/docs/language/optimizers/mcmc), [gradient](https://proto.evodesign.org/docs/language/optimizers/gradient), [cycling](https://proto.evodesign.org/docs/language/optimizers/cycling), [genetic algorithm](https://proto.evodesign.org/docs/language/optimizers/genetic-algorithm), [beam search](https://proto.evodesign.org/docs/language/optimizers/beam-search).

The language can express a genuine search/refine loop **inside a single experiment trial**. The scientist's outer cycle of generating a new Python program and inspecting a frozen final score is a different loop; it should choose and revise native search programs rather than substitute for their inner optimization.

### Model-backed constraints and staged validation

Native `Constraint` supports a threshold hard filter or weighted soft energy, typed input slots, metadata, per-input predicted structures, and per-input logits. `Optimizer.score_energy()` runs filters first, passes a mask to later checks, and then evaluates soft scores only for survivors. Rejected proposals retain an explicit rejection label. That already implements a useful cheap-to-expensive validation cascade. [Constraint source](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/constraint.py#L106), [optimizer scoring](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/optimizer.py#L244).

Built-in protein constraints cover confidence (pLDDT, pTM, ipTM, PAE and interface variants), explicit geometry/contact objectives, structural similarity, ensemble comparisons, symmetry, MPNN sequence compatibility, sequence naturalness, diversity, domains, novelty, and specific interaction objectives. The existence of a constraint does not establish that it measures the biological property of interest. Confidence remains computational structure evidence, not a binding assay.

Proto's own **constraint compiler** groups compatible learned objectives into shared model/backend calls and gradients. Installed and latest source include ESMFold, Protenix, AF2 binder and Malinois providers. This is valuable native optimization infrastructure; it is distinct from Autofold's admission/manifest compiler and should not be deleted as duplicate machinery. [native compiler](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/optimizer/constraint_compiler/compiler.py), [batching note](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/notes/batching.md).

### Conditioning and model composition

Generators declare starting-sequence, prompt, structure or logits input contracts. Inverse-folding generators consume native structures; mutation generators can choose edits using MPNN probabilities and structural context. Cycling feeds a native conditioning function's output into the generator each round. `ConstraintOutput` can attach structures/logits to proposal sequences so later design steps consume them. [MPNN mutation implementation](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/generator/mpnn_mutation_generator.py), [cycling implementation](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/optimizer/cycling_optimizer.py#L371).

This is materially richer than choosing a generator name and evaluating its final string with Boltz2/Chai1. Native examples show symmetric proteins, feedback inverse folding, multi-stage logit refinement, epitope-targeted design workflows and joint regulatory constructs. Examples demonstrate expressibility; most were not executed in this audit and their biological outcomes should not be generalized.

### Tool execution, caches and compute

ToolRegistry provides typed input/config/output classes, executable functions, schemas, examples, detailed docs, citations, licenses and access metadata. Calls validate before dispatch and support isolated environments, persistence, device selection and dispatch backends. `ToolPool` keeps workers warm and splits eligible list inputs across CPU/GPU workers. DeviceManager allocates devices and evicts persistent workers by policy. ToolInstance also supports explicit persistence scopes. [registry](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/proto_tools/tools/tool_registry.py), [pool](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/proto_tools/utils/tool_pool.py#L267), [persistence guide](https://proto.evodesign.org/docs/tools/guides/tool-persistence), [device guide](https://proto.evodesign.org/docs/tools/guides/device-management).

Program/Optimizer-scoped ToolCache deduplicates/cache-keys eligible deterministic work. Seeded stochastic calls follow whole-call caching rules; unseeded stochastic calls skip caching. Native grouped constraints and warm workers can avoid repeated predictions and checkpoint loads. This is an efficiency opportunity, not a measured Autofold speedup. Use immutable configuration/input fingerprints and mark reuse honestly rather than count cache hits as independent scientific replicates. [cache](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/proto_tools/utils/tool_cache.py#L74).

Latest `Program.run(device="modal")` and `run_stage(..., device="modal")` can configure on-demand remote deployment; compute context is now resolved at run time. This is a capability to evaluate separately, **not authorization to change Autofold recipients, install software, deploy, or replace durable execution**. [latest dispatch implementation](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/program.py#L433).

### Persistence is not receipt recovery

Native Program `serialize_state()` stores segment result sequences and handoff logits/structures. `restore_state()` can set current stage. Metadata is deliberately excluded for reevaluation. The format does not store a complete in-progress optimizer transaction, RNG state, leased ownership tree, tool dispatch identity, remote effect receipt, billing, or exactly-once settlement. `run()` resets stage tracking and can restore initial search state; rerunning it is not a receipt-only recovery operation. [state source](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/proto_language/core/program.py#L621).

Native history and export facilities can preserve sequence/constraint/construct/step tables, FASTA and assets. They should be captured as immutable scientific artifacts. Autofold's supervisor receipts/coordinator are still required to establish whether the original external effect completed and to avoid duplicate work after a controller crash.

## Current Autofold use and restrictions

| Area | Current integration | Assessment |
| --- | --- | --- |
| Native authored program | `ProtoTrial.program.run()` invokes actual Program or thin independent-program portfolio | Real native use, currently narrowed by allocation/extraction |
| Multi-stage search | Native types accepted, generation declarations often derived from trial allocations | Repeated generator types and inner proposals are artificially constrained |
| Ordered final scoring | `native_tool_sequence_v1` yields stage/candidate/seed tuples; recorder invokes native functions | Good flat-panel simplification; still Autofold orchestration |
| Conditional/ranked diagnostics | Autofold condition/routing iterator remains | Some cases map to native masks/selection; generic replacement not demonstrated |
| Biology representation | Final candidate schema is an amino-acid string | Sequence scope deliberate; unsuitable for full designs without a versioned representation |
| Chemistry/MSA/templates | Current scoring bridge supplies target/candidate strings, no explicit features | Registry correctly separates native declarations from bridge preservation |
| Model repertoire | Model cards project native metadata; evidence executor only structure_prediction | Registry breadth exceeds executable diagnostic composition breadth |
| Constraints | Native program can score/filter internally; host inspects configured constraints | Not a complete admitted call inventory; learned constraint outputs/history mostly not exported |
| Budget | Aggregate worker bound plus generator output/sample wrapper | Hard limits needed, but final-candidate cap currently also restricts native search depth |
| Results | Final generator metadata and attached CIF can be captured | Partial preservation; stage histories/logits/constraint metadata are not the default evidence projection |
| Persistence | Autofold durable jobs/receipts plus native program runtime | Keep durable plane; native handoff helps at explicit stage boundaries only |
| Procedural knowledge | BioNeMo-derived skills plus registry | Add native Proto composition patterns and capability checks; skills alone cannot fix bridge restrictions |

### Concrete integration gaps, with production references

1. **Type-key identity blocks native stage reuse.** `_apply_trusted_generation_bounds` records generator keys across all optimizers and rejects a repeated key, even for distinct valid native objects. Program requires fresh instances, not different generator classes. The documented two-stage random-nucleotide example is a minimal counterexample to this admission design. Reference: [adapters/proto.py](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/adapters/proto.py:272); `proto_portfolio.py:89` also permits one registered key per lane and unique keys across lanes.

2. **Final output quota also budgets proposal events.** `_wrap_generator_allocation` decrements `remaining_candidates` on every generated proposal pool. `_bound_optimizer_samples` clamps rejection-sampling sample counts to candidate cap. With one allocated final candidate, a one-trajectory MCMC/cycling search can exhaust the allocation on its first proposal even though it always returns at most one final design. Native pool/step/proposal counters must be distinct from output count. Reference: [allocation wrapper](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/adapters/proto.py:171), [sampling clamp](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/adapters/proto.py:217).

3. **Conditioning input is erased by the wrapper signature.** `bounded_sample()` accepts no positional or keyword inputs and invokes `original()` with none. Native `Generator.sample(*args, **kwargs)` and CyclingOptimizer pass structures/prompts to `_sample`. Such calls will fail under the current wrapper. This is a source-confirmed incompatibility; no new runtime reproduction was launched. Same allocation-wrapper reference, native generator `sample` and cycling lines above.

4. **Candidate extraction conflates molecule parts and designs.** `_native_candidates` collects every segment's results and then joined constructs as deduplicated strings. A two-segment design may emit both isolated parts and concatenated whole as separate scoring candidates. Multi-chain partners, fixed segments, tie relationships and chemistry are not represented. For the existing one-segment peptide scope it is usually redundant but benign; full-native programs need explicit selection of final design objects. Reference: [candidate extraction](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/adapters/proto.py:436).

5. **Provenance is partially recovered by string lookup.** `generation.capture()` preserves final generator metadata and attached structures, so it is wrong to say all metadata is discarded. However `_sequence_inventory` indexes segment results only; joined outputs can lose their native metadata/structure mapping. Generator inventory is keyed by type, overwriting another instance of that type. Inner constraint scores, rejected proposals, logits and stage histories are not captured through native exports. Reference: [generation.py](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/generation.py:59), `:120` capture.

6. **Evidence diagnostics are category- and input-shape-limited.** The executor accepts only structure_prediction tools, constructs `complexes=[target_sequences + [sequence]]`, and expects `.structures[0].metrics`. Native sequence scores, embeddings, inverse folding, docking, structural alignment/scoring and dynamics cannot simply be selected as a DiagnosticStage through this interface. The registry can advertise them without making them dispatchable through this adapter. Reference: [evidence_pipeline_v3.py](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/evidence_pipeline_v3.py:143), `:202` input and `:205` call.

7. **Read-only inspection is not full call admission.** `program_inspection.py` reports configured constraint functions and parameters; `generator_spec.py` specially validates the two custom binder adapters. The compiled generation inventory describes generators' declared tools, not every dynamic conditioning/custom constraint call. A wider native execution path needs one shared admitted call recorder/resource gate across generators, constraints, compiled providers, conditioning functions and final validators. This is a design requirement, not a claim the current narrow frozen experiments escaped aggregate worker limits. References: [inspection](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/program_inspection.py:9), [generator preflight](/Users/vincentallam/Developer/autofold/backend/worker/autofold_worker/generator_spec.py:32), [compiler](/Users/vincentallam/Developer/autofold/backend/science-core/src/research/workflow.ts:412).

8. **Native allocations are automatically described only by portfolio wrapper.** `describeTrial` extracts `autofold_generation_plan()` for ProtoPortfolioProgram. Engine prepare additionally derives generation from persisted `trial.generators` and `generatorAllocations`, so ordinary native programs can work; they are not universally refused. But native stage identity, optimizer settings and learned call requirements are not a rich automatic allocation graph. References: [describeTrial](/Users/vincentallam/Developer/autofold/backend/science-core/src/research/workflow.ts:650), [engine prepare](/Users/vincentallam/Developer/autofold/backend/engine/src/execution/index.ts:319).

9. **Independent portfolios are a valid narrow extension, not proof Program is missing staging.** Native Program enforces shared constructs across optimizers. Independent model portfolios have different constructs/budgets/failure axes; the small outer wrapper still has a purpose. Remove its one-key limitation and keep it thin instead of pretending independent trials and sequential refinements are the same composition.

## Latest versus installed: what changes materially

The installed language already has multi-stage Program, six optimizer families, gradients, cycling, tied generators, native constraint compilation, typed molecular entities, ToolPool/persistence/cache and inter-stage state serialization. Those are the immediate underused capabilities; a library update is not required to discover them.

Latest language differences are relatively small: explicit Modal dispatch/runtime compute resolution, typed-chain preservation in cycling, Evo generator seed/config corrections, and related tests/docs. Latest tools differences are broader: 27 additional static operations (SpliceAI2, Genomic Intelligence, Primer3, gLM2, Minerva, CodonFM, Rfam and Vina), deployment/remote routing infrastructure, mixed-model interfaces, updated environment/access/error handling, and the latest Chai checkpoint staging fix. Much of this breadth is outside the current peptide experiment.

The current source also includes tool-level retries of certain transport faults and partial-batch handling. These are not LLM/provider retries; resource and no-duplicate guarantees must account for native retries before adopting wider remote dispatch. A latest-source upgrade should be a separately tested dependency change, not bundled invisibly with an architectural rewrite. [tool error policy](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/notes/error-handling.md).

## Proposed architecture, in priority order

### 1. Preserve native program semantics while retaining explicit limits

Introduce stable **program/lane/stage/component-instance IDs**. Registry type key identifies implementation; instance ID identifies a particular configured use. Pin the complete native construction projection (generator/constraint configs, optimizer kind/settings, segment/construct ownership, stage order and input contracts). Permit repeated generator types with fresh native instances.

Separate limits for final submitted designs, retained trajectories, proposal/offspring events, optimizer steps, admitted tool calls, aggregate compute and wall time. Do not silently substitute one for another. If authored search exceeds declared limits, fail preflight or expose the accepted effective limits explicitly. Preserve `_sample` arguments when any enforcement wrapper is still required; prefer public execution boundaries over mutation of private optimizer counters.

**First tests:** same-type two-stage native Program; multi-step one-result MCMC; conditioned cycling; tied segments; mixed generators on separate segments; stage-budget exhaustion with no extra call; preflight projection equals remote reconstruction. These can largely be CPU/mock tests before spending GPU.

### 2. Make final designs structured artifacts

Version a design artifact containing final construct/result identity, selected designed chains/segments, entity types, native generator/constraint provenance, molecular features, structures/logits as immutable references, and explicit target/partner relationships. Derive candidate identity from canonical molecular meaning, not the plain sequence alone. Preserve the old single-peptide candidate format for historical compatibility.

Harvest specified final constructs/design outputs, never all segment strings by default. Export native Program history/constraint tables and assets, hash them, and show the scientist rejected/surviving proposals and per-property failures. Define exactly when an output is a joined sequence versus distinct molecular chains.

**Tests:** fixed+variable two-segment extraction; multichain/tied outputs; joined-result metadata; identical strings with distinct modifications; structure/logit round trips; legacy receipt reopening unchanged.

### 3. Use real native Programs for scientific search and feedback

Let scientists compose native generators and hard/soft constraints, then select rejection, MCMC, cycling, gradient or population search according to feedback and available inputs. Keep native energies as optimization diagnostics. Final evaluation remains independently frozen by experiment contract.

For the current protein scope, a prospective pattern is: target-conditioned generation → cheap biological gates → structure-aware local refinement/feedback → independent final panel. The choice of generator and physical checks must fit the design object; short peptides, antibodies, ordinary folded proteins and small molecules are not interchangeable. Do not claim improvement until a controlled equal-budget study shows it.

Use native `run_stage` only at explicit captured boundaries. Outer durable receipts must say whether a stage's original tool effects completed before any continuation. Do not recover by rerunning `Program.run()`.

### 4. Make tools interchangeable through typed native IO, not one generic structure bridge

Use native registry Input/Config/Output objects and schema-specific adapters for permitted call classes. A capability checker should establish current wrapper-supported molecular features, current bridge preservation, selected assets/version/license/hardware readiness and the scientific quantity measured. Registry entries are evidence about APIs, not admission or scientific suitability.

Create one audited native tool invocation path shared across generators, constraints, conditioning and diagnostics. Record call identity, canonical typed input/config hash, budget debit, start/completion/failure, output/artifact references and cache origin. Evaluate compatibility with ToolPool and dispatch backends rather than layering a second unmanaged scheduler. New recipients/model installations need their own explicit scoped grant.

### 5. Replace remaining DAG cases by semantic class, not blanket deletion

Native threshold masks cover cheap-to-expensive per-proposal gates. Rejection/GA survivor selection covers top-K/Pareto ranking. Native optimizer stages cover search-to-refinement handoff. Cycling covers prediction-to-redesign feedback. Explicit Python/native stage code can express adaptive choices, but it is not an automatic generic DAG engine and must be admitted and traced.

The immutable final scoring panel remains a small trusted evaluator operation. It may continue using direct typed native calls; forcing a full optimization Program around a two-model terminal panel would add complexity without science benefit. Generic conditions, nullable metrics, typed skips, provenance and required final coverage must have equivalence tests before deleting the old conditional scheduler.

### 6. Put procedural knowledge next to executable capabilities

Adapt upstream [write-program guidance](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/.claude/skills/write-program/SKILL.md), [biological design-loop note](https://github.com/evo-design/proto-language/blob/23de7a82b0789732a377ed8e79f73bcabbb8df4a/notes/biological-design-loop.md), and [model-selection guide](https://github.com/evo-design/proto-tools/blob/43868eb1af64c694b9fd1b08559871e0969cac08/notes/model-taste.md) into versioned procedural skills with runnable local composition examples. Preserve relevant BioNeMo skills; complementary Proto knowledge is needed to teach native staged programs, model-conditioned feedback and explicit object semantics.

Do not let a skill's recommendation imply an installed model or scientifically valid metric. Read_model_card/read_context should expose constraint and optimizer choices alongside tools/generators, with readiness and measured cost separated from upstream documentation. A preflight compiler validates choices; skills teach why to choose them.

## Migration acceptance criteria

1. Existing frozen receipts and old contracts reopen without new jobs, runs, trials or inference; no rewritten historical decisions.
2. New native plans preserve authored constructs, constraints, conditioning arguments and optimizer semantics; same-type stages and multi-step searches pass meaningful CPU tests.
3. Every native learned call, including hidden compiler/conditioning calls, is recorded, admitted and bounded; no installation or remote recipient expansion via defaults.
4. Structured final candidates preserve molecular identity and only intended final designs reach final scoring; explicit feature incompatibility fails before dispatch.
5. Inner-loop histories, failures, per-property metrics and stage handoff assets are immutable and available to the scientist.
6. Cache reuse is labeled and cannot manufacture independent replicates; final frozen evaluator seed/config/input identity remains exact.
7. Parent-first original-receipt recovery and expired-lease behavior remain tested independently of Proto state serialization; ambiguous identity remains held.
8. Conditional-DAG removal proceeds by demonstrated equivalence for gates/ranking/feedback/skip/provenance semantics. Flat parity alone is insufficient.
9. After CPU acceptance, a fresh separately authorized finite GPU pilot tests one native multi-stage/search workflow against an equal-budget baseline. Score, valid yield, unique designs, compute, uncertainty and physical/canonical shutdown are reported. No promise of biological superiority or general fault tolerance.

## Direct answer

The user's suspicion is supported. Proto is substantially more expressive than Autofold currently exposes. We should deepen native **design state and optimization**, not merely rename a loop over model calls. The highest-value near-term work is fixing native-semantic admission/budget boundaries and structured result preservation, then letting scientists choose real native optimization programs using registry-backed procedural knowledge. The durable coordinator and frozen experiment evaluator remain necessary.
