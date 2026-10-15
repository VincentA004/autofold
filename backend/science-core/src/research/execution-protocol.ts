import {canonicalValue as canonical} from '../util/canonical'
import z from "zod"

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export namespace ExecutionProtocol {
  export const NativeProtocol = z.enum(["native_search_v1", "native_fixed_control_v1"])
  export type NativeProtocol = z.infer<typeof NativeProtocol>
  export const WorkerIdentity = z.object({format: z.literal("autofold.worker-tree.v1"), sourceHash: Digest}).passthrough()
  /** Exact host-frozen inputs travel in the original bundle, never model-authored copies. */
  export const FrozenAsset = z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    contentHash: Digest,
    contentBase64: z.string().max(24 * 1024 * 1024),
    nativeBindings: z.array(z.string().startsWith('/').max(2048)).min(1).max(128),
  }).strict()
  export type FrozenAsset = z.infer<typeof FrozenAsset>
  const TrialBundleFields = {
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    intent: z.enum(["optimize", "calibrate", "negative_control", "shadow_replay"]).default("optimize"),
    contractHash: Digest,
    designAdapter: z.enum(["mock", "proto"]),
    programPath: z.string().trim().min(1),
    programHash: Digest,
    modality: z.enum(["linear_minibinder", "short_peptide", "cyclic_peptide", "modified_peptide"]),
    evaluator: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      sourceHash: Digest,
      direction: z.enum(["minimize", "maximize"]),
    }).passthrough(),
    proto: z
      .object({
        root: z.string().trim().min(1),
        languageCommit: z.string().regex(/^[a-f0-9]{40}$/),
        toolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
      }).passthrough()
      .optional(),
    seeds: z.array(z.number().int()).min(1),
    // Search construction RNG; `seeds` remains the frozen evaluator seed set.
    generationSeed: z.number().int().min(0).max(0xffff_ffff).optional(),
    candidateBudget: z.number().int().positive(),
    submissionSize: z.number().int().positive(),
    generationReplicateId: z.string().startsWith("grep_").optional(),
    // No default: absence belongs to original historical bundles only.
    nativeExecution: z.lazy(() => NativeExecution).optional(),
    frozenAssets: z.array(FrozenAsset).max(32).optional(),
    worker: WorkerIdentity.optional(),
  }
  export const TrialBundleV1 = z.object({ format: z.literal("autofold.trial-bundle.v1"), ...TrialBundleFields }).passthrough()
  export const TrialBundleV2 = z.object({
    format: z.literal("autofold.trial-bundle.v2"),
    ...TrialBundleFields,
    targetArtifactHash: Digest,
    targetArtifactPath: z.string().trim().min(1).optional(),
  }).passthrough()
  export const TrialBundleV3 = z
    .object({
      format: z.literal("autofold.trial-bundle.v3"),
      ...TrialBundleFields,
      targetArtifactHash: Digest,
      targetArtifactPath: z.string().trim().min(1),
      targetStructurePath: z.string().trim().min(1).optional(),
      evidenceAdapter: z.object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        sourceHash: Digest,
      }).passthrough(),
    }).passthrough()
    .refine((bundle) => bundle.designAdapter === "proto" && bundle.proto !== undefined, {
      message: "Trusted scientific bundles require the pinned Proto runtime",
      path: ["proto"],
    })
  export const SkipKind = z.enum(["condition_false", "candidate_filtered", "optional_tool_failure"])
  export const StageId = z.string().regex(/^[a-z][a-z0-9_-]*$/)
  export const ToolKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  export const Condition = z.object({source: StageId, metric: ToolKey,
    operator: z.enum(["lt", "lte", "gt", "gte"]), value: z.number().finite()}).passthrough()
  export const StageBudget = z.object({maximumCandidates: z.number().int().positive().optional(),
    maximumGpuSeconds: z.number().finite().positive().optional()}).passthrough()
  export const CandidateRouting = z.object({
    source: StageId,
    metric: ToolKey,
    direction: z.enum(["minimize", "maximize"]),
    maximumCandidates: z.number().int().positive(),
  }).passthrough()
  export const PipelineStage = z
    .object({
      id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      role: z.enum(["scoring", "diagnostic"]).default("scoring"),
      models: z
        .array(
          z.object({
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
            version: z.string().trim().min(1),
            toolKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
            config: z.record(z.string(), z.unknown()).optional(),
          }).passthrough(),
        )
        .min(1),
      dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).default([]),
      condition: Condition.optional(),
      candidateRouting: CandidateRouting.optional(),
      budget: StageBudget.optional(),
      required: z.boolean(),
      allowSkip: z.boolean(),
      allowedSkips: z.array(SkipKind).default([]),
    }).passthrough()
    .superRefine((stage, context) => {
      if (stage.required && stage.allowSkip) {
        context.addIssue({ code: "custom", path: ["allowSkip"], message: "Required pipeline stages cannot allow skips" })
      }
      if (stage.allowedSkips.length > 0 && !stage.allowSkip) {
        context.addIssue({ code: "custom", path: ["allowedSkips"], message: "A stage with typed skips must allow skips" })
      }
    })
  export const NativeSearch = z.object({
    format: z.literal("autofold.native-search.v1"),
    budget: z.object({
      maximumCandidates: z.number().int().positive().max(1000),
      maximumProposals: z.number().int().positive().max(1000000),
      maximumSamplingCalls: z.number().int().positive().max(100000),
      maximumToolCalls: z.number().int().positive().max(100000),
      maximumWallSeconds: z.number().int().positive(),
      allowedTools: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(256),
      outputs: z.array(z.object({construct: z.string().min(1), segment: z.string().min(1).nullable(), lane: z.number().int().nonnegative()}).strict()).min(1).max(64),
    }).strict(),
    projection: z.array(z.object({
      programSeed: z.unknown().optional(),
      name: z.string().nullable().optional(),
      lane: z.number().int().nonnegative(), externalInputs: z.array(z.record(z.string(), z.unknown())).max(256), numResults: z.number().int().positive().nullable(),
      stages: z.array(z.object({
        instanceId: z.string(), optimizer: z.string(), config: z.record(z.string(), z.unknown()),
        settings: z.record(z.string(), z.unknown()), targetSegment: z.string().nullable(), customLogging: z.record(z.string(), z.unknown()).nullable(),
        numResults: z.number().int().positive().nullable(), conditioning: z.record(z.string(), z.unknown()).nullable(),
        generators: z.array(z.object({instanceId: z.string(), key: z.string(), segments: z.array(z.string()), config: z.record(z.string(), z.unknown()), toolsCalled: z.array(z.string())}).strict()).max(64),
        constraints: z.array(z.record(z.string(), z.unknown())).max(256),
      }).strict()).min(1).max(64),
      constructs: z.array(z.record(z.string(), z.unknown())).min(1).max(256),
    }).strict()).min(1).max(64),
  }).strict().superRefine((value, ctx) => {
    if (new Set(value.budget.allowedTools).size !== value.budget.allowedTools.length)
      ctx.addIssue({code: "custom", message: "Native tool admission keys must be unique"})
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
      ctx.addIssue({code: "custom", message: "Native program projection exceeds 256 KiB"})
  })
  export type NativeSearch = z.infer<typeof NativeSearch>
  export const NativeOutput = z.object({construct: z.string().min(1), segment: z.string().min(1).nullable(), lane: z.number().int().nonnegative()}).strict()
  export const NativeFixedControl = z.object({maximumWallSeconds: z.number().int().positive(), outputs: z.array(NativeOutput).min(1).max(64)}).strict()
  export const InvocationReservation = z.object({stageId: z.string().min(1), maximumCandidates: z.number().int().positive(), seedCount: z.number().int().positive(), modelCount: z.number().int().positive(), maximumRequests: z.number().int().positive(), perRequestTimeoutSeconds: z.number().finite().positive(), reservedWallSeconds: z.number().finite().positive()}).strict()
  const NativeResources = z.object({maximumSearchWallSeconds: z.number().finite().positive(), maximumWorkerWallSeconds: z.number().finite().positive(), reservedEvaluationWallSeconds: z.number().finite().nonnegative(), maximumComputeReservationSeconds: z.number().finite().nonnegative(), reservedSearchComputeSeconds: z.number().finite().nonnegative(), reservedEvaluationComputeSeconds: z.number().finite().nonnegative(), invocationReservations: z.array(InvocationReservation).max(64)}).strict()
  export const NativeExecution = z.discriminatedUnion("protocol", [
    z.object({protocol: z.literal("native_search_v1"), descriptor: NativeSearch, outputs: z.array(NativeOutput).min(1).max(64), resources: NativeResources, observation: z.enum(["public_native_monitoring_v1", "scoped_native_lifecycle_v1"])}).strict(),
    z.object({protocol: z.literal("native_fixed_control_v1"), descriptor: z.lazy(() => StaticConstruction), outputs: z.array(NativeOutput).min(1).max(64), resources: NativeResources, observation: z.enum(["public_native_monitoring_v1", "scoped_native_lifecycle_v1"])}).strict(),
  ]).superRefine((value, context) => {
    const resources = value.resources
    if (resources.maximumSearchWallSeconds + resources.reservedEvaluationWallSeconds > resources.maximumWorkerWallSeconds)
      context.addIssue({code: "custom", message: "Native search and evaluation reservations exceed worker wall-time authority"})
    if (resources.reservedSearchComputeSeconds + resources.reservedEvaluationComputeSeconds > resources.maximumComputeReservationSeconds || resources.reservedSearchComputeSeconds > resources.maximumSearchWallSeconds || resources.reservedEvaluationComputeSeconds > resources.reservedEvaluationWallSeconds)
      context.addIssue({code: "custom", message: "Native declared compute reservations exceed authority or wall ceilings"})
    if (resources.invocationReservations.reduce((sum, item) => sum + item.reservedWallSeconds, 0) !== resources.reservedEvaluationWallSeconds)
      context.addIssue({code: "custom", message: "Native evaluation reservation total differs"})
    for (const item of resources.invocationReservations)
      if (item.maximumRequests !== item.maximumCandidates * item.seedCount * item.modelCount || item.reservedWallSeconds !== item.maximumRequests * item.perRequestTimeoutSeconds)
        context.addIssue({code: "custom", message: "Native evaluation invocation cardinality differs"})
    if (value.protocol === "native_search_v1" && (JSON.stringify(value.outputs) !== JSON.stringify(value.descriptor.budget.outputs) || resources.maximumSearchWallSeconds !== value.descriptor.budget.maximumWallSeconds))
      context.addIssue({code: "custom", message: "Native search outputs or wall authority differ from descriptor"})
    if (value.protocol === "native_fixed_control_v1" && (!value.descriptor.nativeProjection || JSON.stringify(value.outputs) !== JSON.stringify(value.descriptor.nativeProjection.budget.outputs) || resources.maximumSearchWallSeconds !== value.descriptor.nativeProjection.budget.maximumWallSeconds || resources.reservedSearchComputeSeconds !== 0))
      context.addIssue({code: "custom", message: "Native fixed outputs or zero-work authority differ from descriptor"})
  })
  export type NativeExecution = z.infer<typeof NativeExecution>
  export const GenerationPolicy = z.object({
    mode: z.literal("proto_program"),
    generators: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      version: z.string().trim().min(1),
      toolsCalled: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
      allocation: z.object({
        maximumCandidates: z.number().int().positive(),
        maximumGpuSeconds: z.number().finite().positive(),
      }).passthrough().optional(),
    }).passthrough()).min(1),
    budget: z.object({
      maximumCandidates: z.number().int().positive(),
      maximumGpuSeconds: z.number().finite().positive().optional(),
    }).passthrough(),
  }).passthrough().superRefine((generation, context) => {
    const ids = generation.generators.map((generator) => generator.id)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["generators"], message: "Generation policy IDs must be unique" })
    }
    const allocations = generation.generators.flatMap((generator) => generator.allocation ? [generator.allocation] : [])
    if (allocations.length && allocations.length !== generation.generators.length) {
      context.addIssue({ code: "custom", path: ["generators"], message: "Generator allocations must be all present or all absent" })
    }
    if (allocations.length) {
      const allocatedCandidates = allocations.reduce((total, allocation) => total + allocation.maximumCandidates, 0)
      if (allocatedCandidates !== generation.budget.maximumCandidates) {
        context.addIssue({ code: "custom", path: ["generators"], message: "Generator allocations must exhaust the candidate budget" })
      }
      const allocatedGpuSeconds = allocations.reduce((total, allocation) => total + allocation.maximumGpuSeconds, 0)
      if (generation.budget.maximumGpuSeconds !== undefined && allocatedGpuSeconds > generation.budget.maximumGpuSeconds) {
        context.addIssue({ code: "custom", path: ["generators"], message: "Generator allocations exceed the GPU budget" })
      }
    }
  })
  export const StaticConstruction = z.object({
    nativeProjection: NativeSearch.optional(),
    format: z.literal("autofold.static-construction.v1"),
    kind: z.literal("native"),
    optimizerCount: z.literal(1),
    constructCount: z.number().int().positive(),
    generatorCount: z.literal(0),
    proposalSources: z.tuple([z.literal("existing_results")]),
    fixedSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).min(1).max(1_000),
    programResultCount: z.number().int().positive(),
    optimizerSamples: z.tuple([z.object({
      numSamples: z.number().int().positive(),
      numResults: z.number().int().positive(),
      proposalBatchSize: z.number().int().positive(),
    }).passthrough()]),
  }).passthrough()
  export type StaticConstruction = z.infer<typeof StaticConstruction>
  export const ScoringPipeline = z
    .object({
      format: z.literal("autofold.scoring-pipeline.v1"),
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
      stages: z.array(PipelineStage).min(1).max(64),
    }).passthrough()
    .superRefine((pipeline, context) => {
      const ids = new Set(pipeline.stages.map((stage) => stage.id))
      if (ids.size !== pipeline.stages.length) {
        context.addIssue({ code: "custom", path: ["stages"], message: "Scoring stage IDs must be unique" })
      }
      for (const [index, stage] of pipeline.stages.entries()) {
        if (stage.role !== "scoring") {
          context.addIssue({ code: "custom", path: ["stages", index, "role"], message: "Frozen scoring pipelines contain only scoring stages" })
        }
        if (!stage.required || stage.allowSkip || stage.condition || stage.candidateRouting) {
          context.addIssue({
            code: "custom",
            path: ["stages", index],
            message: "Scoring stages must evaluate every submitted candidate",
          })
        }
        if (stage.dependsOn.some((dependency) => !ids.has(dependency))) {
          context.addIssue({ code: "custom", path: ["stages", index, "dependsOn"], message: "Scoring dependencies must remain inside the frozen scoring pipeline" })
        }
      }
    })
  export type ScoringPipeline = z.infer<typeof ScoringPipeline>

  export function hashScoringPipeline(raw: ScoringPipeline): string {
    const pipeline = ScoringPipeline.parse(raw)
    return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(pipeline))).digest("hex")}`
  }
  export const PipelinePolicy = z
    .object({
      id: z.string().trim().min(1),
      sourceHash: Digest.optional(),
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      generation: GenerationPolicy.optional(),
      nativeSearch: NativeSearch.optional(),
      executionBudget: z.object({
        semantics: z.literal("aggregate_worker_gpu_wall_v1"),
        maximumGpuSeconds: z.number().finite().positive(),
      }).passthrough().optional(),
      staticConstruction: StaticConstruction.optional(),
      // Compiler-owned mirror of the diagnostic graph returned by
      // build_trial(ctx). The remote worker re-derives and compares it before
      // execution; it is never used as an alternative source of scientific
      // decisions.
      authoredDiagnostics: z.array(z.record(z.string(), z.unknown())).max(64).default([]),
      executionBackend: z.enum(["legacy_dag_v1", "native_tool_sequence_v1"]).optional(),
      stages: z.array(PipelineStage).max(64),
    }).passthrough()
    .superRefine((policy, context) => {
      const stages = new Set(policy.stages.map((stage) => stage.id))
      if (policy.generation && policy.staticConstruction) {
        context.addIssue({ code: "custom", path: ["staticConstruction"], message: "Generated and fixed construction policies are mutually exclusive" })
      }
      if (stages.size !== policy.stages.length) {
        context.addIssue({ code: "custom", path: ["stages"], message: "Pipeline stage IDs must be unique" })
      }
      for (const [index, stage] of policy.stages.entries()) {
        const models = new Set(stage.models.map((model) => model.id))
        if (models.size !== stage.models.length) {
          context.addIssue({ code: "custom", path: ["stages", index, "models"], message: "Stage model IDs must be unique" })
        }
        for (const dependency of stage.dependsOn) {
          if (!stages.has(dependency) || dependency === stage.id) {
            context.addIssue({ code: "custom", path: ["stages", index, "dependsOn"], message: `Invalid stage dependency: ${dependency}` })
          }
        }
        if (new Set(stage.dependsOn).size !== stage.dependsOn.length) {
          context.addIssue({ code: "custom", path: ["stages", index, "dependsOn"], message: "Stage dependencies must be unique" })
        }
        if (stage.condition && !stage.dependsOn.includes(stage.condition.source)) {
          context.addIssue({ code: "custom", path: ["stages", index, "condition", "source"], message: "Condition source must be a direct dependency" })
        }
        if (stage.candidateRouting && !stage.dependsOn.includes(stage.candidateRouting.source)) {
          context.addIssue({ code: "custom", path: ["stages", index, "candidateRouting", "source"], message: "Candidate-routing source must be a direct dependency" })
        }
      }
      const visiting = new Set<string>()
      const visited = new Set<string>()
      const byId = new Map(policy.stages.map((stage) => [stage.id, stage]))
      const positions = new Map(policy.stages.map((stage, index) => [stage.id, index]))
      for (const [index, stage] of policy.stages.entries()) {
        if (stage.dependsOn.some((dependency) => (positions.get(dependency) ?? Number.POSITIVE_INFINITY) >= index)) {
          context.addIssue({ code: "custom", path: ["stages", index, "dependsOn"], message: "Frozen pipeline stages must be topologically ordered" })
        }
      }
      const visit = (id: string): boolean => {
        if (visiting.has(id)) return false
        if (visited.has(id)) return true
        visiting.add(id)
        for (const dependency of byId.get(id)?.dependsOn ?? []) if (!visit(dependency)) return false
        visiting.delete(id)
        visited.add(id)
        return true
      }
      if (policy.stages.some((stage) => !visit(stage.id))) {
        context.addIssue({ code: "custom", path: ["stages"], message: "Pipeline dependencies must be acyclic" })
      }
    })
  export type PipelinePolicy = z.infer<typeof PipelinePolicy>

  /** Bind future host plans to the simplest executor that preserves their behavior.
   * Do not apply this to loaded historical bundles: omitted backend means the
   * original DAG behavior, and is part of their captured identity.
   */
  export function bindEvidenceExecution(pipeline: PipelinePolicy, requested?: NonNullable<PipelinePolicy["executionBackend"]>): PipelinePolicy {
    const seen = new Set<string>()
    const ordered = pipeline.stages.every(stage => {
      const compatible = !stage.condition && !stage.candidateRouting && !seen.has(stage.id)
        && stage.dependsOn.every(parent => seen.has(parent))
      seen.add(stage.id)
      return compatible
    })
    const executionBackend = requested ?? (ordered ? "native_tool_sequence_v1" : "legacy_dag_v1")
    if (executionBackend === "native_tool_sequence_v1" && !ordered)
      throw new Error("Native Proto sequence requires ordered dependencies and cannot execute conditional or routed stages")
    return PipelinePolicy.parse({...pipeline, executionBackend})
  }




  /** Exact host bytes accompany new native policies; Python must not re-render scientific numbers. */
  export function canonicalPipelineJson(raw: PipelinePolicy): string {
    return JSON.stringify(canonical(PipelinePolicy.parse(raw)))
  }

  export function hashPipeline(raw: PipelinePolicy): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalPipelineJson(raw)).digest("hex")}`
  }

  export const TrialBundleV4 = z
    .object({
      format: z.literal("autofold.trial-bundle.v4"),
      ...TrialBundleFields,
      generationReplicateId: z.string().startsWith("grep_").optional(),
      targetArtifactHash: Digest,
      targetArtifactPath: z.string().trim().min(1),
      targetStructurePath: z.string().trim().min(1).optional(),
      evidenceAdapter: z.object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        sourceHash: Digest,
        scoringPipelineHash: Digest.optional(),
      }).passthrough(),
      pipeline: PipelinePolicy,
      pipelineHash: Digest,
      pipelineCanonicalJson: z.string().refine(value => Buffer.byteLength(value, "utf8") <= 1024 * 1024,
        "Canonical pipeline bytes exceed 1 MiB").optional(),
      worker: z.object({
        format: z.literal("autofold.worker-tree.v1"),
        sourceHash: Digest,
      }).passthrough().optional(),
    }).passthrough()
    .superRefine((bundle, context) => {
      if (bundle.designAdapter !== "proto" || bundle.proto === undefined) {
        context.addIssue({ code: "custom", path: ["proto"], message: "Trusted scientific bundles require the pinned Proto runtime" })
      }
      if (hashPipeline(bundle.pipeline) !== bundle.pipelineHash) {
        context.addIssue({ code: "custom", path: ["pipelineHash"], message: "Pipeline policy hash does not match its canonical content" })
      }
      if (bundle.pipelineCanonicalJson !== undefined && bundle.pipelineCanonicalJson !== canonicalPipelineJson(bundle.pipeline)) {
        context.addIssue({ code: "custom", path: ["pipelineCanonicalJson"], message: "Canonical pipeline bytes do not match the frozen policy" })
      }
    })
  export const TrialBundle = z.union([TrialBundleV1, TrialBundleV2, TrialBundleV3, TrialBundleV4]).superRefine((bundle, context) => {
    if (!bundle.nativeExecution) return
    if (bundle.designAdapter !== "proto" || !bundle.proto || !bundle.worker)
      context.addIssue({code: "custom", message: "Fresh native execution requires pinned Proto and worker identities"})
    const native = bundle.nativeExecution
    if (native.protocol === "native_fixed_control_v1" && !["calibrate", "negative_control"].includes(bundle.intent))
      context.addIssue({code: "custom", message: "Native fixed control requires calibration/control intent"})
    if (native.protocol === "native_search_v1" && native.descriptor.budget.maximumCandidates > bundle.candidateBudget)
      context.addIssue({code: "custom", message: "Native candidate pool exceeds frozen candidate budget"})
    if (bundle.format === "autofold.trial-bundle.v4") {
      if (bundle.pipeline.nativeSearch || bundle.pipeline.staticConstruction || bundle.pipeline.generation || bundle.pipeline.executionBudget)
        context.addIssue({code: "custom", message: "Fresh evaluation pipeline cannot duplicate native execution authority"})
      if (bundle.pipeline.executionBackend !== "native_tool_sequence_v1" || bundle.pipeline.authoredDiagnostics.length)
        context.addIssue({code: "custom", message: "Fresh native evaluation cannot admit a diagnostic DAG"})
    }
    const stages = bundle.format === "autofold.trial-bundle.v4" ? bundle.pipeline.stages : []
    const pool = native.protocol === "native_search_v1" ? native.descriptor.budget.maximumCandidates : native.descriptor.fixedSequences.length
    if (pool < bundle.submissionSize || pool > bundle.candidateBudget)
      context.addIssue({code: "custom", message: "Native evaluated pool must cover final selection within frozen candidate ceiling"})
    if (native.resources.invocationReservations.length !== stages.length || stages.some((stage, index) => {
      const reserved = native.resources.invocationReservations[index]
      return !reserved || reserved.stageId !== stage.id || reserved.maximumCandidates !== pool || reserved.seedCount !== bundle.seeds.length || reserved.modelCount !== stage.models.length || reserved.perRequestTimeoutSeconds !== stage.budget?.maximumGpuSeconds
    })) context.addIssue({code: "custom", message: "Native reservations differ from actual frozen evaluation census"})
  })
  export type TrialBundle = z.infer<typeof TrialBundle>

  export const Candidate = z.object({
    id: z.string().min(1),
    sequence: z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/),
    seed: z.number().int(),
  }).passthrough()
  export type Candidate = z.infer<typeof Candidate>

  export const CandidateSetV1 = z.object({
    format: z.literal("autofold.candidate-set.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    candidates: z.array(Candidate),
  }).passthrough()

  const UnitMetric = z.number().finite().min(0).max(1)
  export const PeptideCandidateArtifact = Candidate.extend({
    format: z.literal("autofold.peptide-candidate.v1"),
    modality: z.enum(["linear_minibinder", "short_peptide", "cyclic_peptide", "modified_peptide"]),
    generation: z.object({
      model: z.string().trim().min(1),
      version: z.string().trim().min(1),
      artifactHash: Digest,
      parametersHash: Digest,
    }).passthrough(),
    evidence: z.object({
      interfaceConfidence: UnitMetric,
      foldConfidence: UnitMetric,
      predictorAgreement: UnitMetric,
      solubility: UnitMetric,
      aggregationRisk: UnitMetric,
      synthesisRisk: UnitMetric,
      predictors: z
        .array(
          z.object({
            model: z.string().trim().min(1),
            version: z.string().trim().min(1),
            artifactHash: Digest,
          }).passthrough(),
        )
        .min(1),
    }).passthrough(),
  })
  export type PeptideCandidateArtifact = z.infer<typeof PeptideCandidateArtifact>

  export const CandidateSetV2 = z
    .object({
      format: z.literal("autofold.candidate-set.v2"),
      runId: z.string().startsWith("run_"),
      trialId: z.string().startsWith("trl_"),
      targetArtifactHash: Digest,
      candidates: z.array(PeptideCandidateArtifact),
    }).passthrough()
    .superRefine((candidateSet, context) => {
      const ids = new Set(candidateSet.candidates.map((candidate) => candidate.id))
      if (ids.size !== candidateSet.candidates.length) {
        context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate IDs must be unique" })
      }
    })

  export const CandidateSet = z.union([CandidateSetV1, CandidateSetV2])
  export type CandidateSet = z.infer<typeof CandidateSet>

  export const GenerationRunArtifactV1 = z.object({
    format: z.literal("autofold.generation-run.v1"),
    candidateId: z.string().trim().min(1),
    targetArtifactHash: Digest,
    sequenceHash: Digest,
    generator: z.object({
      id: z.string().trim().min(1),
      version: z.string().trim().min(1),
      protoLanguageCommit: z.string().regex(/^[a-f0-9]{40}$/),
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
      components: z.array(z.object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        toolsCalled: z.array(z.string().trim().min(1)),
        parameters: z.record(z.string(), z.unknown()),
        parametersHash: Digest,
      }).passthrough()),
    }).passthrough(),
    programHash: Digest,
    parametersHash: Digest,
    seed: z.number().int(),
    generationSeed: z.number().int().min(0).max(0xffff_ffff).optional(),
    metadata: z.record(z.string(), z.unknown()),
    outputs: z.object({ sequenceHash: Digest, structureHash: Digest.optional() }).passthrough(),
  }).passthrough()
  export type GenerationRunArtifactV1 = z.infer<typeof GenerationRunArtifactV1>

  export const GenerationSamplingV1 = z.object({
    generator: z.string().trim().min(1),
    allocatedCandidates: z.number().int().positive(),
    maximumGpuSeconds: z.number().int().positive(),
    candidateCap: z.number().int().positive().optional(),
    authoredSamples: z.number().int().positive().optional(),
    effectiveSamples: z.number().int().positive().optional(),
    authoredProposalBatchSize: z.number().int().positive().optional(),
    effectiveProposalBatchSize: z.number().int().positive().optional(),
    authoredResults: z.number().int().positive().optional(),
    effectiveResults: z.number().int().positive().optional(),
  }).passthrough()

  export const GenerationReplicateV1 = z.object({
    id: z.string().startsWith("grep_"),
    requestedSeeds: z.array(z.number().int()).min(1),
    realizedCandidateSetHash: Digest,
    stochasticity: z.enum(["deterministic", "seeded", "upstream_uncontrolled", "mixed", "unknown"]),
    observedGeneratorSeeds: z.array(z.object({
      generator: z.string().trim().min(1),
      seed: z.number().int(),
      control: z.enum(["controlled", "upstream_unavailable", "unknown"]),
    }).passthrough()).default([]),
  }).passthrough()
  export type GenerationReplicateV1 = z.infer<typeof GenerationReplicateV1>

  export const GeneratorDiagnosticsV1 = z.object({
    format: z.literal("autofold.generator-diagnostics.v1"),
    generator: z.literal("freebindcraft"),
    rejectedCandidates: z.number().int().nonnegative(),
    rejectionFilters: z.record(z.string().trim().min(1), z.number().int().nonnegative()),
    trajectoryFailures: z.number().int().nonnegative(),
    trajectoryFailureFilters: z.record(z.string().trim().min(1), z.number().int().nonnegative()),
    trajectoriesObserved: z.number().int().nonnegative(),
    acceptedCandidates: z.number().int().nonnegative(),
    sourceFiles: z.array(z.enum([
      "rejected_mpnn_full_stats.csv",
      "failure_csv.csv",
      "trajectory_stats.csv",
      "final_design_stats.csv",
    ])).min(1),
  }).passthrough()
  export type GeneratorDiagnosticsV1 = z.infer<typeof GeneratorDiagnosticsV1>

  const SafeObservedSeed = z.number().int().refine(Number.isSafeInteger, "Seed must be a safe integer")
  export const GenerationSeedRoleViewV1 = z.object({
    format: z.literal("autofold.generation-seed-roles.v1"),
    hostGenerationSeed: z.object({value: z.number().int().min(0).max(0xffff_ffff), source: z.literal("trial_bundle.generationSeed")}).strict(),
    effectiveProgramSeeds: z.array(z.object({lane: z.number().int().nonnegative(), value: SafeObservedSeed.nullable(),
      source: z.enum(["verified_native_projection.programSeed", "runtime_program.seed"])}).strict()),
    declaredPredictorSeeds: z.array(z.object({lane: z.number().int().nonnegative(), stage: z.string().nullable(),
      constraint: z.string().nullable(), function: z.string().nullable(), field: z.literal("predictor_seed"), value: SafeObservedSeed,
      source: z.literal("verified_native_projection.constraint.config")}).strict()),
    observedToolConfigSeeds: z.array(z.object({requestId: z.string().min(1), tool: z.string().min(1),
      role: z.enum(["predictor_tool", "generator_tool", "registered_tool"]),
      source: z.literal("verified_native_tool_call.config"), seed: SafeObservedSeed.nullable().optional(),
      seeds: z.array(SafeObservedSeed).optional()}).strict()),
    evaluatorSeeds: z.object({values: z.array(SafeObservedSeed), source: z.literal("trial_bundle.seeds")}).strict(),
  }).strict()
  export type GenerationSeedRoleViewV1 = z.infer<typeof GenerationSeedRoleViewV1>

  export const GenerationRunIndexV1 = z.object({
    format: z.literal("autofold.generation-run-index.v1"),
    runId: z.string().startsWith("run_"),
    programHash: Digest,
    runtime: z.object({ wallSeconds: z.number().finite().nonnegative() }).passthrough(),
    replicate: GenerationReplicateV1.optional(),
    sampling: z.array(GenerationSamplingV1).default([]),
    seedRoles: GenerationSeedRoleViewV1.optional(),
    nativeSearch: z.object({path: z.literal("native-search/receipt.json"), hash: Digest}).strict().optional(),
    portfolioFailures: z.array(z.object({
      lane: z.number().int().nonnegative(),
      generator: z.string().trim().min(1).optional(),
      errorType: z.string().trim().min(1).max(200),
      message: z.string().trim().min(1).max(4096),
    }).passthrough()).default([]),
    generatorDiagnostics: z.array(GeneratorDiagnosticsV1).default([]),
    entries: z.array(z.object({
      candidateId: z.string().trim().min(1),
      seed: z.number().int(),
      modelId: z.string().trim().min(1),
      artifactPath: z.string().trim().min(1),
      artifactHash: Digest,
      structurePath: z.string().trim().min(1).optional(),
      structureHash: Digest.optional(),
    }).passthrough().refine((entry) => Boolean(entry.structurePath) === Boolean(entry.structureHash), {
      message: "Generation structure path and hash must be declared together",
    })),
  }).passthrough()
  export type GenerationRunIndexV1 = z.infer<typeof GenerationRunIndexV1>

  export const ModelRunArtifactV1 = z.object({
    format: z.literal("autofold.model-run.v1"),
    candidateId: z.string().trim().min(1),
    targetArtifactHash: Digest,
    peptideSequenceHash: Digest,
    model: z.object({
      id: z.string().trim().min(1),
      version: z.string().trim().min(1),
      adapterSourceHash: Digest,
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
    }).passthrough(),
    parametersHash: Digest,
    seed: z.number().int(),
    outputs: z.object({
      structureHash: Digest,
      metricsHash: Digest,
    }).passthrough(),
    metrics: z.record(z.string(), z.unknown()),
  }).passthrough()
  export const ModelRunArtifactV2 = z.object({
    format: z.literal("autofold.model-run.v2"),
    candidateId: z.string().trim().min(1),
    targetArtifactHash: Digest,
    peptideSequenceHash: Digest,
    stage: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    model: z.object({
      id: z.string().trim().min(1),
      version: z.string().trim().min(1),
      adapterSourceHash: Digest,
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
    }).passthrough(),
    parametersHash: Digest,
    seed: z.number().int(),
    parentArtifactHashes: z.array(Digest),
    runtime: z.object({
      wallSeconds: z.number().finite().nonnegative(),
      gpuSeconds: z.number().finite().nonnegative().optional(),
      peakMemoryBytes: z.number().int().nonnegative().optional(),
      requestObservation: z.object({
        format: z.literal("autofold.native-request-observation.v1"),
        rootRequestId: z.string().min(1),
        entries: z.array(z.object({
          requestId: z.string().min(1), parentRequestId: z.string().min(1).nullable(), tool: ToolKey,
          inputHash: Digest, configHash: Digest,
          status: z.enum(["completed", "failed"]),
          cacheOrigin: z.enum(["unobserved", "cache_hit", "cache_partial", "cache_miss", "cache_disabled", "external_dispatch_backend"]),
          wallSeconds: z.number().finite().nonnegative(), outputSuccess: z.boolean().optional(), errorType: z.string().min(1).optional(),
        }).strict()).min(1),
      }).strict().optional(),
    }).passthrough(),
    outputs: z.object({ structureHash: Digest, metricsHash: Digest }).passthrough(),
    metrics: z.record(z.string(), z.unknown()),
  }).passthrough()
  export const ModelRunArtifact = z.union([ModelRunArtifactV1, ModelRunArtifactV2])
  export type ModelRunArtifact = z.infer<typeof ModelRunArtifact>

  export const ModelRunIndexV1 = z.object({
    format: z.literal("autofold.model-run-index.v1"),
    runId: z.string().startsWith("run_"),
    entries: z.array(
      z.object({
        candidateId: z.string().trim().min(1),
        seed: z.number().int(),
        artifactPath: z.string().trim().min(1),
        artifactHash: Digest,
        structurePath: z.string().trim().min(1),
        structureHash: Digest,
        metricsPath: z.string().trim().min(1),
        metricsHash: Digest,
      }).passthrough(),
    ),
  }).passthrough()
  const CompletedModelRunEntryV2 = z.object({
    status: z.literal("completed"),
    candidateId: z.string().trim().min(1),
    stage: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    seed: z.number().int(),
    parentArtifactHashes: z.array(Digest),
    artifactPath: z.string().trim().min(1),
    artifactHash: Digest,
    structurePath: z.string().trim().min(1),
    structureHash: Digest,
    metricsPath: z.string().trim().min(1),
    metricsHash: Digest,
  }).passthrough()
  const SkippedModelRunEntryV2 = z.object({
    status: z.literal("skipped"),
    kind: SkipKind.optional(),
    candidateId: z.string().trim().min(1),
    stage: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    seed: z.number().int(),
    parentArtifactHashes: z.array(Digest),
    reason: z.string().trim().min(1).max(2_000),
  }).passthrough()
  export const ModelRunIndexV2 = z.object({
    format: z.literal("autofold.model-run-index.v2"),
    runId: z.string().startsWith("run_"),
    pipelineHash: Digest,
    entries: z.array(z.discriminatedUnion("status", [CompletedModelRunEntryV2, SkippedModelRunEntryV2])),
  }).passthrough()
  export const ModelRunIndex = z.union([ModelRunIndexV1, ModelRunIndexV2])
  export type ModelRunIndex = z.infer<typeof ModelRunIndex>

  export const EvaluationResult = z.object({
    format: z.literal("autofold.evaluation-result.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    contractHash: Digest,
    evaluatorHash: Digest,
    evidenceAdapterHash: Digest.optional(),
    designAdapter: z.enum(["mock", "proto"]),
    programHash: Digest,
    valid: z.boolean(),
    score: z.number().finite().nullable(),
    diagnostics: z.record(z.string(), z.number().finite()),
  }).passthrough()
  export type EvaluationResult = z.infer<typeof EvaluationResult>

  export const RunManifest = z.object({
    format: z.literal("autofold.run-manifest.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    workerVersion: z.string().min(1),
    pythonVersion: z.string().min(1),
    evaluatorHash: Digest,
    evidenceAdapterHash: Digest.optional(),
    designAdapter: z.enum(["mock", "proto"]),
    programHash: Digest,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    files: z.record(z.string(), Digest),
  }).passthrough()
  export type RunManifest = z.infer<typeof RunManifest>
}
