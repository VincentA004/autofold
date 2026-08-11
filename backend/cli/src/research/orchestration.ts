import z from "zod"
import { Instance } from "@/project/instance"
import { ResearchDomain } from "./domain"
import { ResearchJobs } from "./job-service"
import { Research } from "./service"
import { ResearchSearchPolicy } from "./search-policy"

const ACTIVE_JOB_STATES = new Set<ResearchDomain.JobStatus>(["queued", "running", "retry_wait"])

export namespace ResearchOrchestration {
  export const Observation = z.object({
    version: z.literal(1),
    observedAt: z.string().datetime(),
    campaign: ResearchDomain.Campaign,
    experiments: z.array(
      z.object({
        id: z.string().startsWith("exp_"),
        status: ResearchDomain.ExperimentStatus,
        objective: z.string(),
        contractHash: z.string().startsWith("sha256:"),
        budget: ResearchDomain.ExperimentContract.shape.budget,
        evaluator: ResearchDomain.ExperimentContract.shape.evaluator.pick({
          direction: true,
          fixedSeeds: true,
          submissionSize: true,
        }),
        incumbentTrialId: z.string().startsWith("trl_").optional(),
        incumbentScore: z.number().finite().nullable(),
        trialCount: z.number().int().nonnegative(),
        succeededRuns: z.number().int().nonnegative(),
        failedRuns: z.number().int().nonnegative(),
        recentEvaluations: z.array(
          z.object({
            trialId: z.string().startsWith("trl_"),
            valid: z.boolean(),
            score: z.number().finite().nullable(),
            diagnostics: z.record(z.string(), z.number().finite()),
          }),
        ).max(10),
      }),
    ),
    knowledge: z.object({
      due: z.boolean(),
      reasons: z.array(z.string()),
      unprocessedKnowledgeIds: z.array(z.string().startsWith("knw_")),
      unresolvedQuestions: z.array(z.string()),
      proposedClaimIds: z.array(z.string().startsWith("clm_")),
      contestedClaimIds: z.array(z.string().startsWith("clm_")),
      recentOutcomes: z.array(
        z.object({
          id: z.string().startsWith("knw_"),
          title: z.string(),
          description: z.string(),
          decision: z.enum(["promoted", "rejected", "observed", "failed"]),
          score: z.number().finite().nullable(),
          diagnostics: z.record(z.string(), z.number().finite()),
        }),
      ).max(30),
      recentClaims: z.array(
        z.object({
          id: z.string().startsWith("clm_"),
          kind: ResearchDomain.KnowledgeClaim.shape.kind,
          statement: z.string(),
          confidence: z.number().min(0).max(1),
          status: ResearchDomain.KnowledgeClaim.shape.status,
        }),
      ).max(30),
    }),
    activeJobs: z.array(
      z.object({
        id: z.string().startsWith("job_"),
        kind: z.enum(["autoresearch", "knowledge_refresh", "campaign_loop", "capability_refinement", "skill_shadow_replay"]),
        targetId: z.string(),
        status: ResearchDomain.JobStatus,
      }),
    ),
  })
  export type Observation = z.infer<typeof Observation>

  const Rationale = z.string().trim().min(1).max(4_000)
  const ExpectedInformationGain = z.union([
    z.string().trim().min(1).max(2_000),
    z.number().finite().min(0).max(1).transform((value) => `Estimated relative information gain: ${value}`),
  ])
  export const Move = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("iterate_experiment"),
      experimentId: z.string().startsWith("exp_"),
      iterations: z.number().int().min(1).max(10),
      agent: z.enum(["biology", "ml", "task"]),
      rationale: Rationale,
      expectedInformationGain: ExpectedInformationGain,
      searchPolicy: ResearchSearchPolicy.Policy.optional(),
    }),
    z.object({
      kind: z.literal("refresh_knowledge"),
      force: z.boolean().default(false),
      question: z.string().trim().min(1).max(2_000).optional(),
      rationale: Rationale,
    }),
    z.object({
      kind: z.literal("request_experiment"),
      hypothesis: z.string().trim().min(1).max(2_000),
      rationale: Rationale,
      successCriterion: z.string().trim().min(1).max(2_000),
    }),
    z.object({
      kind: z.literal("refine_skill"),
      skillId: z.string().regex(/^skill_[a-z0-9._-]+$/),
      experimentId: z.string().startsWith("exp_"),
      agent: z.enum(["biology", "ml", "task"]).default("biology"),
      repetitions: z.number().int().min(3).max(5).default(3),
      trajectoryRefs: z.array(z.string().regex(/^(exp|trl|evl|run|knw|clm|job)_[A-Za-z0-9_-]+$/)).min(1).max(100),
      rationale: Rationale,
      expectedInformationGain: ExpectedInformationGain,
    }),
    z.object({
      kind: z.literal("request_review"),
      claimIds: z.array(z.string().startsWith("clm_")).min(1).max(100),
      rationale: Rationale,
    }),
    z.object({
      kind: z.literal("stop"),
      rationale: Rationale,
      unresolvedQuestions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
    }),
  ])
  export type Move = z.input<typeof Move>

  export const Decision = z.discriminatedUnion("status", [
    z.object({
      status: z.literal("authorized"),
      move: Move,
      executable: z.boolean(),
    }),
    z.object({
      status: z.literal("approval_required"),
      move: Move,
      reason: z.string(),
    }),
    z.object({
      status: z.literal("rejected"),
      move: Move,
      reasons: z.array(z.string()).min(1),
    }),
  ])
  export type Decision = z.infer<typeof Decision>

  export async function observe(campaignId: string): Promise<Observation> {
    const projectId = Instance.project.id
    const campaigns = await Research.listCampaigns(projectId)
    const campaign = campaigns.find((item) => item.id === campaignId)
    if (!campaign) throw new Error(`Campaign ${campaignId} was not found`)
    const [experiments, refresh, claims, outcomes, cycles, jobs] = await Promise.all([
      Research.listExperiments(projectId, campaignId),
      Research.knowledgeRefreshStatus(projectId, campaignId),
      Research.listClaims(projectId, campaignId),
      Research.listKnowledge(projectId, campaignId),
      Research.listKnowledgeCycles(projectId, campaignId),
      ResearchJobs.list(projectId),
    ])
    const histories = await Promise.all(experiments.map((experiment) => Research.history(projectId, experiment.id)))
    const experimentIds = new Set(experiments.map((experiment) => experiment.id))
    return Observation.parse({
      version: 1,
      observedAt: new Date().toISOString(),
      campaign,
      experiments: histories.map(({ experiment, trials, evaluations, runs }) => {
        const incumbent = experiment.incumbentTrialId
          ? evaluations.find((evaluation) => evaluation.trialId === experiment.incumbentTrialId)
          : undefined
        return {
          id: experiment.id,
          status: experiment.status,
          objective: experiment.contract.objective,
          contractHash: experiment.contractHash,
          budget: experiment.contract.budget,
          evaluator: {
            direction: experiment.contract.evaluator.direction,
            fixedSeeds: experiment.contract.evaluator.fixedSeeds,
            submissionSize: experiment.contract.evaluator.submissionSize,
          },
          incumbentTrialId: experiment.incumbentTrialId,
          incumbentScore: incumbent?.score ?? null,
          trialCount: trials.length,
          succeededRuns: runs.filter((run) => run.status === "succeeded").length,
          failedRuns: runs.filter((run) => run.status === "failed").length,
          recentEvaluations: evaluations.slice(-10).map(({ trialId, valid, score, diagnostics }) => ({
            trialId,
            valid,
            score,
            diagnostics,
          })),
        }
      }),
      knowledge: {
        ...refresh,
        unresolvedQuestions: cycles[0]?.outputs.unresolvedQuestions ?? [],
        proposedClaimIds: claims.filter((claim) => claim.status === "proposed").map((claim) => claim.id),
        contestedClaimIds: claims.filter((claim) => claim.status === "contested").map((claim) => claim.id),
        recentOutcomes: outcomes.slice(0, 30).map(({ id, title, description, decision, score, diagnostics }) => ({
          id,
          title,
          description,
          decision,
          score,
          diagnostics,
        })),
        recentClaims: claims.slice(0, 30).map(({ id, kind, statement, confidence, status }) => ({
          id,
          kind,
          statement,
          confidence,
          status,
        })),
      },
      activeJobs: jobs
        .filter((job) => ACTIVE_JOB_STATES.has(job.status))
        .filter(
          (job) =>
            ((job.payload.kind === "knowledge_refresh" || job.payload.kind === "campaign_loop" || job.payload.kind === "capability_refinement" || job.payload.kind === "skill_shadow_replay") && job.payload.campaignId === campaignId) ||
            (job.payload.kind === "autoresearch" && experimentIds.has(job.payload.experimentId)),
        )
        .map((job) => ({
          id: job.id,
          kind: job.payload.kind,
          targetId: job.payload.kind === "autoresearch"
            ? job.payload.experimentId
            : job.payload.kind === "capability_refinement" || job.payload.kind === "skill_shadow_replay"
              ? job.payload.kind === "capability_refinement" ? job.payload.skillId : job.payload.candidateVersionId
              : job.payload.campaignId,
          status: job.status,
        })),
    })
  }

  export function compile(rawObservation: Observation, rawMove: Move): Decision {
    const observation = Observation.parse(rawObservation)
    const move = Move.parse(rawMove)
    if (move.kind === "stop") return { status: "authorized", move, executable: false }
    if (observation.campaign.status !== "active") {
      return { status: "rejected", move, reasons: [`Campaign ${observation.campaign.id} is ${observation.campaign.status}`] }
    }
    if (move.kind === "iterate_experiment") {
      const experiment = observation.experiments.find((item) => item.id === move.experimentId)
      const reasons = [
        ...(!experiment ? [`Experiment ${move.experimentId} is outside this campaign`] : []),
        ...(experiment && experiment.status !== "active" ? [`Experiment ${move.experimentId} is ${experiment.status}`] : []),
        ...(observation.activeJobs.some(
          (job) => job.kind === "autoresearch" && job.targetId === move.experimentId,
        )
          ? [`Experiment ${move.experimentId} already has active autoresearch`]
          : []),
      ]
      return reasons.length
        ? { status: "rejected", move, reasons }
        : { status: "authorized", move, executable: true }
    }
    if (move.kind === "refresh_knowledge") {
      const reasons = [
        ...(!observation.knowledge.due && !move.force ? ["Knowledge refresh is not due"] : []),
        ...(observation.activeJobs.some((job) => job.kind === "knowledge_refresh")
          ? ["Campaign already has an active knowledge refresh"]
          : []),
      ]
      return reasons.length
        ? { status: "rejected", move, reasons }
        : { status: "authorized", move, executable: true }
    }
    if (move.kind === "request_experiment") {
      return {
        status: "approval_required",
        move,
        reason: "A new experiment changes the frozen scientific contract and requires explicit approval",
      }
    }
    if (move.kind === "refine_skill") {
      const experiment = observation.experiments.find((item) => item.id === move.experimentId)
      const visible = JSON.stringify(observation)
      const unknown = move.trajectoryRefs.filter((reference) => !visible.includes(`"${reference}"`))
      const reasons = [
        ...(unknown.length ? [`Trajectory references are outside this observation: ${unknown.join(", ")}`] : []),
        ...(!experiment || experiment.status !== "active" ? [`Replay experiment ${move.experimentId} is not active in this campaign`] : []),
        ...(observation.activeJobs.some((job) => job.kind === "capability_refinement" && job.targetId === move.skillId)
          ? [`Skill ${move.skillId} already has active capability refinement`]
          : []),
      ]
      return reasons.length
        ? { status: "rejected", move, reasons }
        : { status: "authorized", move, executable: true }
    }
    const knownClaims = new Set([
      ...observation.knowledge.proposedClaimIds,
      ...observation.knowledge.contestedClaimIds,
    ])
    const unknown = move.claimIds.filter((id) => !knownClaims.has(id))
    return unknown.length
      ? { status: "rejected", move, reasons: [`Claims are not pending review: ${unknown.join(", ")}`] }
      : { status: "authorized", move, executable: false }
  }
}
