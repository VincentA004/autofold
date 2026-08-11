import z from "zod"

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export namespace ExecutionProtocol {
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
    }),
    proto: z
      .object({
        root: z.string().trim().min(1),
        languageCommit: z.string().regex(/^[a-f0-9]{40}$/),
        toolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .optional(),
    seeds: z.array(z.number().int()).min(1),
    candidateBudget: z.number().int().positive(),
    submissionSize: z.number().int().positive(),
  }
  export const TrialBundleV1 = z.object({ format: z.literal("autofold.trial-bundle.v1"), ...TrialBundleFields })
  export const TrialBundleV2 = z.object({
    format: z.literal("autofold.trial-bundle.v2"),
    ...TrialBundleFields,
    targetArtifactHash: Digest,
    targetArtifactPath: z.string().trim().min(1).optional(),
  })
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
      }),
    })
    .refine((bundle) => bundle.designAdapter === "proto" && bundle.proto !== undefined, {
      message: "Trusted scientific bundles require the pinned Proto runtime",
      path: ["proto"],
    })
  export const SkipKind = z.enum(["condition_false", "candidate_filtered", "optional_tool_failure"])
  export const CandidateRouting = z.object({
    source: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    metric: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    direction: z.enum(["minimize", "maximize"]),
    maximumCandidates: z.number().int().positive(),
  })
  export const PipelineStage = z
    .object({
      id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
      models: z
        .array(
          z.object({
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
            version: z.string().trim().min(1),
            toolKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
            config: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .min(1),
      dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).default([]),
      condition: z
        .object({
          source: z.string().regex(/^[a-z][a-z0-9_-]*$/),
          metric: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
          operator: z.enum(["lt", "lte", "gt", "gte"]),
          value: z.number().finite(),
        })
        .optional(),
      candidateRouting: CandidateRouting.optional(),
      budget: z
        .object({
          maximumCandidates: z.number().int().positive().optional(),
          maximumGpuSeconds: z.number().finite().positive().optional(),
        })
        .optional(),
      required: z.boolean(),
      allowSkip: z.boolean(),
      allowedSkips: z.array(SkipKind).default([]),
    })
    .superRefine((stage, context) => {
      if (stage.required && stage.allowSkip) {
        context.addIssue({ code: "custom", path: ["allowSkip"], message: "Required pipeline stages cannot allow skips" })
      }
      if (stage.allowedSkips.length > 0 && !stage.allowSkip) {
        context.addIssue({ code: "custom", path: ["allowedSkips"], message: "A stage with typed skips must allow skips" })
      }
    })
  export const GenerationPolicy = z.object({
    mode: z.literal("proto_program"),
    generators: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      version: z.string().trim().min(1),
      toolsCalled: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
      allocation: z.object({
        maximumCandidates: z.number().int().positive(),
        maximumGpuSeconds: z.number().finite().positive(),
      }).optional(),
    })).min(1),
    budget: z.object({
      maximumCandidates: z.number().int().positive(),
      maximumGpuSeconds: z.number().finite().positive().optional(),
    }),
  }).superRefine((generation, context) => {
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
  export const PipelinePolicy = z
    .object({
      id: z.string().trim().min(1),
      sourceHash: Digest.optional(),
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      generation: GenerationPolicy.optional(),
      stages: z.array(PipelineStage).max(64),
    })
    .superRefine((policy, context) => {
      const stages = new Set(policy.stages.map((stage) => stage.id))
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

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
    }
    return value
  }

  export function hashPipeline(raw: PipelinePolicy): string {
    const pipeline = PipelinePolicy.parse(raw)
    return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(pipeline))).digest("hex")}`
  }

  export const TrialBundleV4 = z
    .object({
      format: z.literal("autofold.trial-bundle.v4"),
      ...TrialBundleFields,
      targetArtifactHash: Digest,
      targetArtifactPath: z.string().trim().min(1),
      targetStructurePath: z.string().trim().min(1).optional(),
      evidenceAdapter: z.object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        sourceHash: Digest,
      }),
      pipeline: PipelinePolicy,
      pipelineHash: Digest,
    })
    .superRefine((bundle, context) => {
      if (bundle.designAdapter !== "proto" || bundle.proto === undefined) {
        context.addIssue({ code: "custom", path: ["proto"], message: "Trusted scientific bundles require the pinned Proto runtime" })
      }
      if (hashPipeline(bundle.pipeline) !== bundle.pipelineHash) {
        context.addIssue({ code: "custom", path: ["pipelineHash"], message: "Pipeline policy hash does not match its canonical content" })
      }
    })
  export const TrialBundle = z.union([TrialBundleV1, TrialBundleV2, TrialBundleV3, TrialBundleV4])
  export type TrialBundle = z.infer<typeof TrialBundle>

  export const Candidate = z.object({
    id: z.string().min(1),
    sequence: z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/),
    seed: z.number().int(),
  })
  export type Candidate = z.infer<typeof Candidate>

  export const CandidateSetV1 = z.object({
    format: z.literal("autofold.candidate-set.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    candidates: z.array(Candidate),
  })

  const UnitMetric = z.number().finite().min(0).max(1)
  export const PeptideCandidateArtifact = Candidate.extend({
    format: z.literal("autofold.peptide-candidate.v1"),
    modality: z.enum(["linear_minibinder", "short_peptide", "cyclic_peptide", "modified_peptide"]),
    generation: z.object({
      model: z.string().trim().min(1),
      version: z.string().trim().min(1),
      artifactHash: Digest,
      parametersHash: Digest,
    }),
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
          }),
        )
        .min(1),
    }),
  })
  export type PeptideCandidateArtifact = z.infer<typeof PeptideCandidateArtifact>

  export const CandidateSetV2 = z
    .object({
      format: z.literal("autofold.candidate-set.v2"),
      runId: z.string().startsWith("run_"),
      trialId: z.string().startsWith("trl_"),
      targetArtifactHash: Digest,
      candidates: z.array(PeptideCandidateArtifact),
    })
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
      })),
    }),
    programHash: Digest,
    parametersHash: Digest,
    seed: z.number().int(),
    metadata: z.record(z.string(), z.unknown()),
    outputs: z.object({ sequenceHash: Digest, structureHash: Digest.optional() }),
  })
  export type GenerationRunArtifactV1 = z.infer<typeof GenerationRunArtifactV1>

  export const GenerationRunIndexV1 = z.object({
    format: z.literal("autofold.generation-run-index.v1"),
    runId: z.string().startsWith("run_"),
    programHash: Digest,
    runtime: z.object({ wallSeconds: z.number().finite().nonnegative() }),
    entries: z.array(z.object({
      candidateId: z.string().trim().min(1),
      seed: z.number().int(),
      modelId: z.string().trim().min(1),
      artifactPath: z.string().trim().min(1),
      artifactHash: Digest,
      structurePath: z.string().trim().min(1).optional(),
      structureHash: Digest.optional(),
    }).refine((entry) => Boolean(entry.structurePath) === Boolean(entry.structureHash), {
      message: "Generation structure path and hash must be declared together",
    })),
  })
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
    }),
    parametersHash: Digest,
    seed: z.number().int(),
    outputs: z.object({
      structureHash: Digest,
      metricsHash: Digest,
    }),
    metrics: z.record(z.string(), z.unknown()),
  })
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
    }),
    parametersHash: Digest,
    seed: z.number().int(),
    parentArtifactHashes: z.array(Digest),
    runtime: z.object({
      wallSeconds: z.number().finite().nonnegative(),
      gpuSeconds: z.number().finite().nonnegative().optional(),
      peakMemoryBytes: z.number().int().nonnegative().optional(),
    }),
    outputs: z.object({ structureHash: Digest, metricsHash: Digest }),
    metrics: z.record(z.string(), z.unknown()),
  })
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
      }),
    ),
  })
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
  })
  const SkippedModelRunEntryV2 = z.object({
    status: z.literal("skipped"),
    kind: SkipKind.optional(),
    candidateId: z.string().trim().min(1),
    stage: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    seed: z.number().int(),
    parentArtifactHashes: z.array(Digest),
    reason: z.string().trim().min(1).max(2_000),
  })
  export const ModelRunIndexV2 = z.object({
    format: z.literal("autofold.model-run-index.v2"),
    runId: z.string().startsWith("run_"),
    pipelineHash: Digest,
    entries: z.array(z.discriminatedUnion("status", [CompletedModelRunEntryV2, SkippedModelRunEntryV2])),
  })
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
  })
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
  })
  export type RunManifest = z.infer<typeof RunManifest>
}
