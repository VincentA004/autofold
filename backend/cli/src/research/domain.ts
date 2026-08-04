import z from "zod"

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Timestamp = z.string().datetime()

export namespace ResearchDomain {
  export const CampaignStatus = z.enum(["draft", "active", "paused", "completed", "archived"])
  export type CampaignStatus = z.infer<typeof CampaignStatus>

  export const ExperimentStatus = z.enum(["draft", "active", "paused", "completed", "failed", "archived"])
  export type ExperimentStatus = z.infer<typeof ExperimentStatus>

  export const TrialStatus = z.enum([
    "proposed",
    "queued",
    "running",
    "evaluating",
    "succeeded",
    "failed",
    "cancelled",
  ])
  export type TrialStatus = z.infer<typeof TrialStatus>

  export const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const Budget = z.object({
    maximumCandidates: z.number().int().positive().max(1_000_000),
    gpuHours: z.number().nonnegative().max(1_000_000),
    wallTimeMinutes: z.number().int().positive().max(60 * 24 * 30),
  })
  export type Budget = z.infer<typeof Budget>

  export const Evaluator = z.object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
    sourceHash: Digest,
    containerHash: Digest.optional(),
    evidenceAdapter: z
      .object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        sourceHash: Digest,
      })
      .optional(),
    direction: z.enum(["minimize", "maximize"]),
    fixedSeeds: z.array(z.number().int()).min(1).max(1_024),
    submissionSize: z.number().int().positive(),
  })
  export type Evaluator = z.infer<typeof Evaluator>

  export const ExperimentContract = z
    .object({
      version: z.literal(1),
      objective: z.string().trim().min(1),
      targetArtifactHash: Digest,
      modality: z.enum(["linear_minibinder", "short_peptide", "cyclic_peptide", "modified_peptide"]),
      budget: Budget,
      evaluator: Evaluator,
    })
    .superRefine((value, context) => {
      if (value.evaluator.submissionSize > value.budget.maximumCandidates) {
        context.addIssue({
          code: "custom",
          path: ["evaluator", "submissionSize"],
          message: "Submission size cannot exceed the candidate budget",
        })
      }
    })
  export type ExperimentContract = z.infer<typeof ExperimentContract>

  export const Campaign = z.object({
    id: z.string().startsWith("cmp_"),
    projectId: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    status: CampaignStatus,
    knowledgeCatalogId: z.string().trim().min(1),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  export type Campaign = z.infer<typeof Campaign>

  export const Experiment = z.object({
    id: z.string().startsWith("exp_"),
    campaignId: z.string().startsWith("cmp_"),
    status: ExperimentStatus,
    contract: ExperimentContract,
    contractHash: Digest,
    incumbentTrialId: z.string().startsWith("trl_").optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  export type Experiment = z.infer<typeof Experiment>

  export const Trial = z.object({
    id: z.string().startsWith("trl_"),
    experimentId: z.string().startsWith("exp_"),
    parentTrialId: z.string().startsWith("trl_").optional(),
    hypothesis: z.string().trim().min(1),
    designAdapter: z.enum(["mock", "proto"]),
    programPath: z.string().trim().min(1).max(4_000),
    programHash: Digest,
    status: TrialStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  export type Trial = z.infer<typeof Trial>

  export const Evaluation = z.object({
    id: z.string().startsWith("evl_"),
    trialId: z.string().startsWith("trl_"),
    contractHash: Digest,
    evaluatorHash: Digest,
    valid: z.boolean(),
    score: z.number().finite().nullable(),
    diagnostics: z.record(z.string(), z.number().finite()),
    evaluatedAt: Timestamp,
  })
  export type Evaluation = z.infer<typeof Evaluation>

  export const Run = z.object({
    id: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    status: RunStatus,
    bundlePath: z.string().trim().min(1),
    outputPath: z.string().trim().min(1),
    jobId: z.string().optional(),
    manifestHash: Digest.optional(),
    error: z.string().optional(),
    createdAt: Timestamp,
    startedAt: Timestamp.optional(),
    completedAt: Timestamp.optional(),
  })
  export type Run = z.infer<typeof Run>

  export const KnowledgeSource = z.object({
    id: z.string().trim().min(1),
    resource: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    author: z.string().trim().min(1).optional(),
    last_modified: z.string().date().optional(),
  })
  export type KnowledgeSource = z.infer<typeof KnowledgeSource>

  export const KnowledgeActor = z.object({
    by: z.string().trim().min(1),
    at: Timestamp,
  })
  export type KnowledgeActor = z.infer<typeof KnowledgeActor>

  export const KnowledgeConcept = z
    .object({
      id: z.string().regex(/^knw_[A-Za-z0-9_-]+$/),
      campaignId: z.string().startsWith("cmp_"),
      experimentId: z.string().startsWith("exp_"),
      trialId: z.string().startsWith("trl_"),
      evaluationId: z.string().startsWith("evl_").optional(),
      runId: z.string().startsWith("run_").optional(),
      type: z.enum(["Research Evaluation", "Research Failure"]),
      title: z.string().trim().min(1),
      description: z.string().trim().min(1),
      tags: z.array(z.string().trim().min(1)),
      sources: z.array(KnowledgeSource).min(1),
      generated: KnowledgeActor,
      verified: z.array(KnowledgeActor).min(1).optional(),
      status: z.enum(["draft", "stable", "deprecated"]),
      score: z.number().finite().nullable(),
      decision: z.enum(["promoted", "rejected", "failed"]),
      error: z.string().trim().min(1).max(4_000).optional(),
      diagnostics: z.record(z.string(), z.number().finite()),
      provenance: z.object({
        contractHash: Digest,
        targetArtifactHash: Digest.optional(),
        evaluatorHash: Digest,
        programHash: Digest,
        manifestHash: Digest.optional(),
      }),
      createdAt: Timestamp,
    })
    .superRefine((concept, context) => {
      if (concept.type === "Research Evaluation" && (!concept.evaluationId || concept.decision === "failed")) {
        context.addIssue({ code: "custom", message: "Evaluation knowledge requires an evaluation and decision" })
      }
      if (concept.type === "Research Failure" && (concept.evaluationId || concept.decision !== "failed" || !concept.error)) {
        context.addIssue({ code: "custom", message: "Failure knowledge requires an error and failed decision" })
      }
    })
  export type KnowledgeConcept = z.infer<typeof KnowledgeConcept>

  const trialTransitions: Record<TrialStatus, ReadonlySet<TrialStatus>> = {
    proposed: new Set(["queued", "cancelled"]),
    queued: new Set(["running", "cancelled", "failed"]),
    running: new Set(["evaluating", "failed", "cancelled"]),
    evaluating: new Set(["succeeded", "failed", "cancelled"]),
    succeeded: new Set(),
    failed: new Set(),
    cancelled: new Set(),
  }

  export function canTransitionTrial(from: TrialStatus, to: TrialStatus): boolean {
    return trialTransitions[from].has(to)
  }

  export function transitionTrial(trial: Trial, to: TrialStatus, now = new Date().toISOString()): Trial {
    if (!canTransitionTrial(trial.status, to)) {
      throw new Error(`Illegal trial transition: ${trial.status} -> ${to}`)
    }
    return Trial.parse({ ...trial, status: to, updatedAt: now })
  }

  export function hashContract(input: ExperimentContract): string {
    const contract = ExperimentContract.parse(input)
    const hash = new Bun.CryptoHasher("sha256")
    hash.update(JSON.stringify(stable(contract)))
    return `sha256:${hash.digest("hex")}`
  }

  export function assertContractIntegrity(experiment: Experiment): void {
    const actual = hashContract(experiment.contract)
    if (actual !== experiment.contractHash) {
      throw new Error(`Experiment contract hash mismatch: expected ${experiment.contractHash}, received ${actual}`)
    }
  }

  export function comparable(a: Evaluation, b: Evaluation): boolean {
    return a.contractHash === b.contractHash && a.evaluatorHash === b.evaluatorHash
  }

  export function shouldPromote(input: {
    candidate: Evaluation
    incumbent?: Evaluation
    direction: Evaluator["direction"]
  }): boolean {
    const { candidate, incumbent, direction } = input
    if (!candidate.valid || candidate.score === null) return false
    if (!incumbent) return true
    if (!incumbent.valid || incumbent.score === null) return true
    if (!comparable(candidate, incumbent)) return false
    return direction === "minimize" ? candidate.score < incumbent.score : candidate.score > incumbent.score
  }

  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    )
  }
}
