import z from "zod"
import { ResearchSkills } from "./research-skills"

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
    origin: z
      .object({
        jobId: z.string().startsWith("job_"),
        phase: z.string().trim().min(1).max(200),
      })
      .optional(),
    skills: z.array(ResearchSkills.Reference).max(30).default([]),
    hypothesis: z.string().trim().min(1),
    intent: z.enum(["optimize", "calibrate", "negative_control", "shadow_replay"]).default("optimize"),
    designAdapter: z.enum(["mock", "proto"]),
    programPath: z.string().trim().min(1).max(4_000),
    programHash: Digest,
    status: TrialStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  export type Trial = z.infer<typeof Trial>

  export const SkillReplayScore = z.object({
    lockedObjectiveUtility: z.number().finite(),
    areaUnderImprovementCurve: z.number().finite(),
    validDiverseYield: z.number().finite().nonnegative(),
    predictorDisagreement: z.number().finite().nonnegative(),
    failureRate: z.number().finite().min(0).max(1),
    computeCost: z.number().finite().nonnegative(),
  })
  export type SkillReplayScore = z.infer<typeof SkillReplayScore>

  export const SkillReplay = z.object({
    benchmarkId: z.string().trim().min(1).max(200),
    baselineVersionId: z.string().startsWith("skv_"),
    candidateVersionId: z.string().startsWith("skv_"),
    sameBudget: z.boolean(),
    baseline: SkillReplayScore,
    candidate: SkillReplayScore,
    campaignIds: z.array(z.string().startsWith("cmp_")).min(1),
    passed: z.boolean(),
    evaluatedAt: Timestamp,
  })
  export type SkillReplay = z.infer<typeof SkillReplay>

  export const SkillVersion = z.object({
    id: z.string().startsWith("skv_"),
    campaignId: z.string().startsWith("cmp_"),
    skillId: ResearchSkills.Reference.shape.id,
    version: z.number().int().positive(),
    parentVersionId: z.string().startsWith("skv_").optional(),
    path: z.string().trim().min(1).max(4_000),
    contentHash: Digest,
    capabilities: z.array(ResearchSkills.Capability).min(1).max(6),
    appliesToToolKeys: z.array(z.string().trim().min(1)).max(30),
    status: z.enum(["candidate", "active", "rejected", "superseded"]),
    source: z.enum(["bundled", "campaign_refinement"]),
    trajectoryRefs: z.array(z.string().trim().min(1).max(500)).max(100),
    createdBy: z.string().trim().min(1).max(200),
    origin: z.object({
      jobId: z.string().startsWith("job_"),
      phase: z.string().trim().min(1).max(200),
    }).optional(),
    replay: SkillReplay.optional(),
    createdAt: Timestamp,
  })
  export type SkillVersion = z.infer<typeof SkillVersion>

  export const SkillLibraryEntry = z.object({
    id: z.string().startsWith("slb_"),
    projectId: z.string().trim().min(1),
    skillId: ResearchSkills.Reference.shape.id,
    sourceVersionId: z.string().startsWith("skv_"),
    contentHash: Digest,
    promotedFromCampaignIds: z.array(z.string().startsWith("cmp_")).min(3),
    status: z.enum(["active", "superseded"]),
    createdAt: Timestamp,
  })
  export type SkillLibraryEntry = z.infer<typeof SkillLibraryEntry>

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

  export const JobPayload = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("autoresearch"),
      experimentId: z.string().startsWith("exp_"),
      sessionId: z.string().startsWith("ses_"),
      iterations: z.number().int().min(1).max(10),
      agent: z.enum(["biology", "ml", "task"]),
    }),
    z.object({
      kind: z.literal("knowledge_refresh"),
      campaignId: z.string().startsWith("cmp_"),
      sessionId: z.string().startsWith("ses_"),
      question: z.string().trim().min(1).max(2_000).optional(),
      maxSources: z.number().int().min(1).max(50),
      maxClaims: z.number().int().min(1).max(50),
      resumeProposalPath: z.string().trim().min(1).optional(),
      resumeChildSessionId: z.string().startsWith("ses_").optional(),
    }),
    z.object({
      kind: z.literal("campaign_loop"),
      campaignId: z.string().startsWith("cmp_"),
      sessionId: z.string().startsWith("ses_"),
      maxSteps: z.number().int().min(1).max(20),
    }),
    z.object({
      kind: z.literal("capability_refinement"),
      campaignId: z.string().startsWith("cmp_"),
      sessionId: z.string().startsWith("ses_"),
      skillId: ResearchSkills.Reference.shape.id,
      trajectoryRefs: z.array(z.string().regex(/^(exp|trl|evl|run|knw|clm|job)_[A-Za-z0-9_-]+$/)).min(1).max(100),
      replayExperimentId: z.string().startsWith("exp_").optional(),
      replayAgent: z.enum(["biology", "ml", "task"]).default("biology"),
      replayRepetitions: z.number().int().min(3).max(5).default(3),
    }),
    z.object({
      kind: z.literal("skill_shadow_replay"),
      campaignId: z.string().startsWith("cmp_"),
      experimentId: z.string().startsWith("exp_"),
      candidateVersionId: z.string().startsWith("skv_"),
      sessionId: z.string().startsWith("ses_"),
      agent: z.enum(["biology", "ml", "task"]),
      repetitions: z.number().int().min(3).max(5).default(3),
    }),
  ])
  export type JobPayload = z.infer<typeof JobPayload>

  export const JobStatus = z.enum(["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"])
  export type JobStatus = z.infer<typeof JobStatus>

  export const JobCheckpoint = z.object({
    phase: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()),
    completedAt: Timestamp,
  })
  export type JobCheckpoint = z.infer<typeof JobCheckpoint>

  export const Job = z
    .object({
      id: z.string().startsWith("job_"),
      projectId: z.string().trim().min(1),
      idempotencyKey: z.string().trim().min(1).max(500),
      payload: JobPayload,
      status: JobStatus,
      attempts: z.number().int().nonnegative(),
      maxAttempts: z.number().int().min(1).max(20),
      createdAt: Timestamp,
      updatedAt: Timestamp,
      startedAt: Timestamp.optional(),
      heartbeatAt: Timestamp.optional(),
      completedAt: Timestamp.optional(),
      nextAttemptAt: Timestamp.optional(),
      leaseId: z.string().trim().min(1).optional(),
      leaseExpiresAt: Timestamp.optional(),
      cancelRequestedAt: Timestamp.optional(),
      error: z.string().trim().min(1).max(4_000).optional(),
      result: z.record(z.string(), z.unknown()).optional(),
      checkpoints: z.record(z.string(), JobCheckpoint).default({}),
    })
    .superRefine((job, context) => {
      if (job.payload.kind !== "knowledge_refresh") return
      if (Boolean(job.payload.resumeProposalPath) === Boolean(job.payload.resumeChildSessionId)) return
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "resumeProposalPath and resumeChildSessionId must be provided together",
      })
    })
  export type Job = z.infer<typeof Job>

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
      decision: z.enum(["promoted", "rejected", "observed", "failed"]),
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

  export const LiteratureRecord = z.object({
    id: z.string().regex(/^lit_[A-Za-z0-9_-]+$/),
    campaignId: z.string().startsWith("cmp_"),
    database: z.string().trim().min(1),
    sourceId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1).optional(),
    excerpts: z.array(z.string().trim().min(1).max(4_000)).max(50).default([]),
    url: z.string().url().optional(),
    query: z.string().trim().min(1),
    contentHash: Digest,
    retrievedAt: Timestamp,
  })
  export type LiteratureRecord = z.infer<typeof LiteratureRecord>

  export const ClaimEvidence = z.object({
    literatureId: z.string().startsWith("lit_"),
    excerpt: z.string().trim().min(1).max(4_000).optional(),
  })
  export type ClaimEvidence = z.infer<typeof ClaimEvidence>

  export const KnowledgeClaim = z
    .object({
      id: z.string().regex(/^clm_[A-Za-z0-9_-]+$/),
      campaignId: z.string().startsWith("cmp_"),
      kind: z.enum(["mechanism", "design_rule", "assay_fact", "limitation", "hypothesis"]),
      statement: z.string().trim().min(1).max(8_000),
      stance: z.enum(["supports", "refutes", "context"]),
      confidence: z.number().finite().min(0).max(1),
      evidence: z.array(ClaimEvidence).min(1).max(100),
      status: z.enum(["proposed", "reviewed", "contested", "deprecated"]),
      generated: KnowledgeActor,
      reviewed: KnowledgeActor.optional(),
      createdAt: Timestamp,
    })
    .superRefine((claim, context) => {
      const ids = new Set(claim.evidence.map((evidence) => evidence.literatureId))
      if (ids.size !== claim.evidence.length) {
        context.addIssue({ code: "custom", path: ["evidence"], message: "Claim evidence records must be unique" })
      }
      if (claim.status !== "proposed" && !claim.reviewed) {
        context.addIssue({ code: "custom", path: ["reviewed"], message: "Resolved claims require a reviewer" })
      }
    })
  export type KnowledgeClaim = z.infer<typeof KnowledgeClaim>

  export const KnowledgeAlignment = z
    .object({
      id: z.string().regex(/^aln_[A-Za-z0-9_-]+$/),
      campaignId: z.string().startsWith("cmp_"),
      claimId: z.string().startsWith("clm_"),
      knowledgeId: z.string().startsWith("knw_"),
      relation: z.enum(["supports", "refutes", "context", "unresolved"]),
      rationale: z.string().trim().min(1).max(4_000),
      status: z.enum(["proposed", "reviewed", "contested", "deprecated"]),
      generated: KnowledgeActor,
      reviewed: KnowledgeActor.optional(),
      createdAt: Timestamp,
    })
    .superRefine((alignment, context) => {
      if (alignment.status !== "proposed" && !alignment.reviewed) {
        context.addIssue({ code: "custom", path: ["reviewed"], message: "Resolved alignments require a reviewer" })
      }
    })
  export type KnowledgeAlignment = z.infer<typeof KnowledgeAlignment>

  export const NextExperimentProposal = z
    .object({
      action: z.enum(["continue_experiment", "new_experiment", "stop_campaign"]),
      experimentId: z.string().startsWith("exp_").optional(),
      hypothesis: z.string().trim().min(1).max(2_000),
      rationale: z.string().trim().min(1).max(4_000),
      successCriterion: z.string().trim().min(1).max(2_000),
    })
    .superRefine((proposal, context) => {
      if (proposal.action === "continue_experiment" && !proposal.experimentId) {
        context.addIssue({
          code: "custom",
          path: ["experimentId"],
          message: "Continuing an experiment requires its exact ID",
        })
      }
      if (proposal.action !== "continue_experiment" && proposal.experimentId) {
        context.addIssue({
          code: "custom",
          path: ["experimentId"],
          message: "Only continue_experiment may reference an existing experiment",
        })
      }
    })
  export type NextExperimentProposal = z.infer<typeof NextExperimentProposal>

  export const KnowledgeCycle = z.object({
    id: z.string().regex(/^kcy_[A-Za-z0-9_-]+$/),
    campaignId: z.string().startsWith("cmp_"),
    trigger: z.enum(["manual", "run_completed", "scheduled", "literature_review"]),
    question: z.string().trim().min(1).max(2_000),
    inputs: z.object({
      knowledgeIds: z.array(z.string().startsWith("knw_")).max(1_000),
      claimIds: z.array(z.string().startsWith("clm_")).max(1_000),
      literatureIds: z.array(z.string().startsWith("lit_")).max(1_000),
    }),
    outputs: z.object({
      literatureIds: z.array(z.string().startsWith("lit_")).max(1_000),
      claimIds: z.array(z.string().startsWith("clm_")).max(1_000),
      alignmentIds: z.array(z.string().startsWith("aln_")).max(1_000),
      unresolvedQuestions: z.array(z.string().trim().min(1).max(2_000)).max(100),
    }),
    generated: KnowledgeActor,
    campaignSummary: z.string().trim().min(1).max(4_000).optional(),
    nextExperiment: NextExperimentProposal.optional(),
    createdAt: Timestamp,
    nextReviewAt: Timestamp,
  })
  export type KnowledgeCycle = z.infer<typeof KnowledgeCycle>

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
