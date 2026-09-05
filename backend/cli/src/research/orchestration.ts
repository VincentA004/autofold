import z from "zod"
import { Instance } from "@/project/instance"
import { ResearchDomain } from "./domain"
import { ResearchJobs } from "./job-service"
import { Research } from "./service"
import { ResearchSearchPolicy } from "./search-policy"
import { ResearchExecution } from "./execution"
import { CampaignSkills } from "./campaign-skills"

const ACTIVE_JOB_STATES = new Set<ResearchDomain.JobStatus>(["queued", "running", "retry_wait"])

export namespace ResearchOrchestration {
  export const RecentTrajectory = z.object({
    experimentId: z.string().startsWith("exp_"),
    trial: ResearchDomain.Trial.pick({
      id: true,
      parentTrialId: true,
      origin: true,
      hypothesis: true,
      intent: true,
      designAdapter: true,
      programHash: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    }),
    run: ResearchDomain.Run.pick({
      id: true,
      status: true,
      manifestHash: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    }).optional(),
    evaluation: ResearchDomain.Evaluation.pick({
      id: true,
      valid: true,
      score: true,
      diagnostics: true,
      evaluatedAt: true,
    }).optional(),
    knowledge: ResearchDomain.KnowledgeConcept.pick({
      id: true,
      type: true,
      decision: true,
      score: true,
      error: true,
      description: true,
      createdAt: true,
    }).optional(),
    candidates: z.array(z.object({
      id: z.string(),
      sequence: z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/),
      generationModel: z.string().optional(),
    })).max(8).optional(),
    modelEvidence: z.array(z.object({
      candidateId: z.string(),
      stage: z.string().optional(),
      modelId: z.string(),
      seed: z.number().int(),
      status: z.enum(["completed", "skipped"]),
      metrics: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().optional(),
    })).max(24).optional(),
    evidenceCompleteness: z.object({
      status: z.enum(["complete", "partial_optional"]),
      totalDecisions: z.number().int().nonnegative(),
      completedDecisions: z.number().int().nonnegative(),
      skippedOptionalDecisions: z.number().int().nonnegative(),
      requiredDecisions: z.number().int().nonnegative(),
      completedRequiredDecisions: z.number().int().nonnegative(),
      skippedStages: z.array(z.string()),
    }).optional(),
    latestAt: z.string().datetime(),
  })
  export type RecentTrajectory = z.infer<typeof RecentTrajectory>

  export const RecentAuthoringAttempt = z.object({
    jobId: z.string().startsWith("job_"),
    experimentId: z.string().startsWith("exp_"),
    iteration: z.number().int().positive(),
    attempt: z.number().int().positive(),
    status: z.enum(["ready", "failed"]),
    programFingerprint: z.string().startsWith("sha256:").optional(),
    semanticProgramFingerprint: z.string().startsWith("sha256:").optional(),
    workflowFingerprint: z.string().startsWith("sha256:").optional(),
    error: z.string().optional(),
    recordedAt: z.string().datetime(),
  })
  export type RecentAuthoringAttempt = z.infer<typeof RecentAuthoringAttempt>

  export const RecentSkillFeedback = z.object({
    jobId: z.string().startsWith("job_"),
    experimentId: z.string().startsWith("exp_"),
    iteration: z.number().int().positive(),
    skillId: z.string().regex(/^skill_[a-z0-9._-]+$/),
    trigger: z.enum(["authoring_failure", "run_failure", "optional_evidence_gap", "predictor_disagreement"]),
    rationale: z.string().trim().min(1).max(2_000),
    trajectoryRefs: z.array(ResearchDomain.EvidenceRef).min(1).max(20),
    requiresShadowReplay: z.literal(true),
    recordedAt: z.string().datetime(),
    refinement: z.object({
      versionId: z.string().startsWith("skv_"),
      status: ResearchDomain.SkillVersion.shape.status,
      replayPassed: z.boolean().optional(),
      evaluatedAt: z.string().datetime().optional(),
    }).optional(),
  })
  export type RecentSkillFeedback = z.infer<typeof RecentSkillFeedback>

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
        incumbentSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(12),
        incumbentScore: z.number().finite().nullable(),
        trialCount: z.number().int().nonnegative(),
        succeededRuns: z.number().int().nonnegative(),
        failedRuns: z.number().int().nonnegative(),
        recentEvaluations: z.array(
          z.object({
            evaluationId: z.string().startsWith("evl_"),
            trialId: z.string().startsWith("trl_"),
            valid: z.boolean(),
            score: z.number().finite().nullable(),
            diagnostics: z.record(z.string(), z.number().finite()),
            evaluatedAt: z.string().datetime(),
          }),
        ).max(10),
      }),
    ),
    recentTrajectories: z.array(RecentTrajectory).max(20),
    recentAuthoringAttempts: z.array(RecentAuthoringAttempt).max(20),
    recentSkillFeedback: z.array(RecentSkillFeedback).max(20),
    skills: z.object({
      active: z.array(ResearchDomain.SkillVersion.pick({
        id: true,
        skillId: true,
        version: true,
        contentHash: true,
        capabilities: true,
        appliesToToolKeys: true,
        status: true,
        source: true,
        createdAt: true,
      })).max(30),
      recentRefinements: z.array(ResearchDomain.SkillVersion.pick({
        id: true,
        skillId: true,
        version: true,
        parentVersionId: true,
        contentHash: true,
        status: true,
        trajectoryRefs: true,
        origin: true,
        replay: true,
        createdAt: true,
      })).max(20),
    }),
    researchState: z.object({
      charter: ResearchDomain.CampaignCharter,
      hypotheses: z.array(ResearchDomain.ResearchHypothesis).max(50),
      searchLandscape: z.array(ResearchDomain.SearchObservation).max(100),
      progress: z.object({
        openSuccessCriteria: z.number().int().nonnegative(),
        metSuccessCriteria: z.number().int().nonnegative(),
        highestTrustedEvidenceLevel: ResearchDomain.EpistemicLevel,
        exploredPrograms: z.number().int().nonnegative(),
        exploredGenerators: z.array(z.string()).max(100),
      }),
    }),
    knowledge: z.object({
      due: z.boolean(),
      reasons: z.array(z.string()),
      unprocessedKnowledgeIds: z.array(z.string().startsWith("knw_")),
      unresolvedQuestions: z.array(z.string()),
      proposedClaimIds: z.array(z.string().startsWith("clm_")),
      contestedClaimIds: z.array(z.string().startsWith("clm_")),
      latestCycle: ResearchDomain.KnowledgeCycle.pick({
        id: true,
        question: true,
        campaignSummary: true,
        nextExperiment: true,
        createdAt: true,
        nextReviewAt: true,
      }).optional(),
      recentOutcomes: z.array(
        z.object({
          id: z.string().startsWith("knw_"),
          experimentId: z.string().startsWith("exp_"),
          trialId: z.string().startsWith("trl_"),
          evaluationId: z.string().startsWith("evl_").optional(),
          runId: z.string().startsWith("run_").optional(),
          title: z.string(),
          description: z.string(),
          decision: z.enum(["promoted", "rejected", "observed", "failed"]),
          score: z.number().finite().nullable(),
          error: z.string().optional(),
          diagnostics: z.record(z.string(), z.number().finite()),
          createdAt: z.string().datetime(),
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
  const ResearchBasis = z.object({
    goalCriterionId: z.string().regex(/^[a-z][a-z0-9_-]{1,60}$/),
    hypothesisId: z.string().startsWith("hyp_").optional(),
    hypothesis: z.string().trim().min(1).max(2_000),
    expectedObservation: z.string().trim().min(1).max(2_000),
    falsificationCriterion: z.string().trim().min(1).max(2_000),
    searchDelta: z.string().trim().min(1).max(2_000),
  })
  export const Move = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("iterate_experiment"),
      experimentId: z.string().startsWith("exp_"),
      iterations: z.number().int().min(1).max(100),
      agent: z.enum(["biology", "ml", "task"]),
      recursionMode: z.enum(["autonomous_discovery", "single_intent"]).optional(),
      trialIntent: ResearchDomain.Trial.shape.intent.optional(),
      baselineTrialId: z.string().startsWith("trl_").optional(),
      rationale: Rationale,
      expectedInformationGain: ExpectedInformationGain,
      researchBasis: ResearchBasis,
      decisionMode: z.enum(["agent_directed", "policy_guided"]).optional(),
      searchPolicy: ResearchSearchPolicy.Policy.optional(),
      evidenceRefs: z.array(ResearchDomain.EvidenceRef).max(100).optional(),
      allowEquivalent: z.boolean().optional(),
      equivalenceJustification: z.string().trim().min(1).max(2_000).optional(),
      staticControlScope: z.enum(["local_derivative", "same_length_scaffold"]).optional(),
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
      kind: z.literal("replay_skill"),
      candidateVersionId: z.string().startsWith("skv_"),
      experimentId: z.string().startsWith("exp_"),
      agent: z.enum(["biology", "ml", "task"]).default("biology"),
      repetitions: z.number().int().min(3).max(5).default(3),
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
    const [experiments, refresh, claims, outcomes, cycles, jobs, researchState, skillVersions] = await Promise.all([
      Research.listExperiments(projectId, campaignId),
      Research.knowledgeRefreshStatus(projectId, campaignId),
      Research.listClaims(projectId, campaignId),
      Research.listKnowledge(projectId, campaignId),
      Research.listKnowledgeCycles(projectId, campaignId),
      ResearchJobs.list(projectId),
      Research.campaignResearchState(projectId, campaignId),
      CampaignSkills.service.list(projectId, campaignId),
    ])
    const histories = await Promise.all(experiments.map((experiment) => Research.history(projectId, experiment.id)))
    const incumbentSequences = new Map(await Promise.all(histories.map(async ({ experiment, runs }) => {
      const run = experiment.incumbentTrialId
        ? runs.findLast((item) => item.trialId === experiment.incumbentTrialId && item.status === "succeeded")
        : undefined
      if (!run) return [experiment.id, [] as string[]] as const
      const artifacts = await ResearchExecution.artifacts(run.id).catch(() => undefined)
      return [experiment.id, artifacts?.candidates.candidates.map((candidate) => candidate.sequence).slice(0, 12) ?? []] as const
    })))
    const experimentIds = new Set(experiments.map((experiment) => experiment.id))
    const recentTrajectories = await enrichRecentTrajectories(collectRecentTrajectories(histories, outcomes))
    const recentAuthoringAttempts = collectRecentAuthoringAttempts(jobs, campaignId, experimentIds)
    const recentSkillFeedback = reconcileRecentSkillFeedback(
      collectRecentSkillFeedback(jobs, campaignId, experimentIds),
      recentTrajectories,
      skillVersions,
    )
    // Progress summarizes the strongest trusted campaign evidence, not only
    // evidence that an agent chose to attach to a hypothesis. Search
    // observations are derived deterministically from verified run artifacts
    // and can therefore carry stronger multi-model or multi-seed support.
    const highestTrustedEvidenceLevel = strongestEvidenceLevel([
      ...researchState.hypotheses.map((hypothesis) => hypothesis.evidenceLevel),
      ...researchState.searchObservations.map((observation) => observation.epistemicLevel),
    ])
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
          incumbentSequences: incumbentSequences.get(experiment.id) ?? [],
          incumbentScore: incumbent?.score ?? null,
          trialCount: trials.length,
          succeededRuns: runs.filter((run) => run.status === "succeeded").length,
          failedRuns: runs.filter((run) => run.status === "failed").length,
          recentEvaluations: evaluations.slice(-10).toReversed().map(({ id, trialId, valid, score, diagnostics, evaluatedAt }) => ({
            evaluationId: id,
            trialId,
            valid,
            score,
            diagnostics,
            evaluatedAt,
          })),
        }
      }),
      recentTrajectories,
      recentAuthoringAttempts,
      recentSkillFeedback,
      skills: {
        active: skillVersions.filter((version) => version.status === "active"),
        recentRefinements: skillVersions
          .filter((version) => version.source === "campaign_refinement")
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 20),
      },
      researchState: {
        charter: researchState.charter,
        hypotheses: researchState.hypotheses.slice(0, 50),
        searchLandscape: researchState.searchObservations.slice(0, 100),
        progress: {
          openSuccessCriteria: researchState.charter.successCriteria.filter((criterion) => criterion.status === "open").length,
          metSuccessCriteria: researchState.charter.successCriteria.filter((criterion) => criterion.status === "met").length,
          highestTrustedEvidenceLevel,
          exploredPrograms: new Set(researchState.searchObservations.map((observation) => observation.programHash)).size,
          exploredGenerators: [...new Set(researchState.searchObservations.flatMap((observation) => observation.generatorPortfolio))].toSorted(),
        },
      },
      knowledge: {
        ...refresh,
        unresolvedQuestions: cycles[0]?.outputs.unresolvedQuestions ?? [],
        proposedClaimIds: claims.filter((claim) => claim.status === "proposed").map((claim) => claim.id),
        contestedClaimIds: claims.filter((claim) => claim.status === "contested").map((claim) => claim.id),
        ...(cycles[0] ? { latestCycle: cycles[0] } : {}),
        recentOutcomes: outcomes.slice(0, 30).map(({ id, experimentId, trialId, evaluationId, runId, title, description, decision, score, error, diagnostics, createdAt }) => ({
          id,
          experimentId,
          trialId,
          evaluationId,
          runId,
          title,
          description,
          decision,
          score,
          error,
          diagnostics,
          createdAt,
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

  export function strongestEvidenceLevel(
    levels: ResearchDomain.EpistemicLevel[],
  ): ResearchDomain.EpistemicLevel {
    const ranks = ResearchDomain.EpistemicLevel.options
    return levels.toSorted((left, right) => ranks.indexOf(right) - ranks.indexOf(left))[0]
      ?? "model_observation"
  }

  export function collectRecentTrajectories(
    histories: Array<{
      experiment: ResearchDomain.Experiment
      trials: ResearchDomain.Trial[]
      evaluations: ResearchDomain.Evaluation[]
      runs: ResearchDomain.Run[]
    }>,
    outcomes: ResearchDomain.KnowledgeConcept[],
  ): RecentTrajectory[] {
    const knowledgeByTrial = new Map<string, ResearchDomain.KnowledgeConcept>()
    for (const concept of outcomes) {
      if (!knowledgeByTrial.has(concept.trialId)) knowledgeByTrial.set(concept.trialId, concept)
    }
    return histories
      .flatMap(({ experiment, trials, evaluations, runs }) => {
        const evaluationByTrial = new Map(evaluations.map((evaluation) => [evaluation.trialId, evaluation]))
        const runsByTrial = Map.groupBy(runs, (run) => run.trialId)
        return trials.map((trial): RecentTrajectory => {
          const evaluation = evaluationByTrial.get(trial.id)
          const run = runsByTrial.get(trial.id)?.toSorted((a, b) =>
            (b.completedAt ?? b.startedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.startedAt ?? a.createdAt)
          )[0]
          const knowledge = knowledgeByTrial.get(trial.id)
          const latestAt = [trial.updatedAt, evaluation?.evaluatedAt, run?.completedAt, knowledge?.createdAt]
            .filter((value): value is string => Boolean(value))
            .toSorted((a, b) => b.localeCompare(a))[0]!
          return RecentTrajectory.parse({
            experimentId: experiment.id,
            trial: {
              id: trial.id,
              parentTrialId: trial.parentTrialId,
              origin: trial.origin,
              hypothesis: trial.hypothesis,
              intent: trial.intent,
              designAdapter: trial.designAdapter,
              programHash: trial.programHash,
              status: trial.status,
              createdAt: trial.createdAt,
              updatedAt: trial.updatedAt,
            },
            ...(run ? { run: {
              id: run.id,
              status: run.status,
              manifestHash: run.manifestHash,
              error: run.error,
              createdAt: run.createdAt,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
            } } : {}),
            ...(evaluation ? { evaluation: {
              id: evaluation.id,
              valid: evaluation.valid,
              score: evaluation.score,
              diagnostics: evaluation.diagnostics,
              evaluatedAt: evaluation.evaluatedAt,
            } } : {}),
            ...(knowledge ? { knowledge: {
              id: knowledge.id,
              type: knowledge.type,
              decision: knowledge.decision,
              score: knowledge.score,
              error: knowledge.error,
              description: knowledge.description,
              createdAt: knowledge.createdAt,
            } } : {}),
            latestAt,
          })
        })
      })
      .toSorted((a, b) => b.latestAt.localeCompare(a.latestAt) || b.trial.id.localeCompare(a.trial.id))
      .slice(0, 20)
  }

  async function enrichRecentTrajectories(trajectories: RecentTrajectory[]): Promise<RecentTrajectory[]> {
    return Promise.all(trajectories.map(async (trajectory, index) => {
      if (index >= 5 || trajectory.run?.status !== "succeeded") return trajectory
      const artifacts = await ResearchExecution.artifacts(trajectory.run.id).catch(() => undefined)
      if (!artifacts) return trajectory
      return RecentTrajectory.parse({
        ...trajectory,
        candidates: artifacts.candidates.candidates.slice(0, 8).map((candidate) => {
          const generation = (candidate as { generation?: unknown }).generation
          const generationModel = generation && typeof generation === "object" && !Array.isArray(generation)
            ? (generation as { model?: unknown }).model
            : undefined
          return {
            id: candidate.id,
            sequence: candidate.sequence,
            generationModel: typeof generationModel === "string" ? generationModel : undefined,
          }
        }),
        modelEvidence: artifacts.modelEvidence.slice(0, 24),
        evidenceCompleteness: artifacts.evidenceCompleteness,
      })
    }))
  }

  export function collectRecentAuthoringAttempts(
    jobs: Awaited<ReturnType<typeof ResearchJobs.list>>,
    campaignId: string,
    experimentIds: Set<string>,
  ): RecentAuthoringAttempt[] {
    return jobs.flatMap((job) => Object.entries(job.checkpoints).flatMap(([phase, checkpoint]) => {
      const matched = parseRecursivePhase(phase, "authoring")
      if (!matched) return []
      let experimentId: string | undefined
      if (job.payload.kind === "autoresearch") experimentId = job.payload.experimentId
      if (job.payload.kind === "campaign_loop" && job.payload.campaignId === campaignId && matched.step) {
        const move = (job.checkpoints[`step:${matched.step}:proposal`]?.data as { move?: { experimentId?: unknown } } | undefined)?.move
        if (typeof move?.experimentId === "string") experimentId = move.experimentId
      }
      if (!experimentId || !experimentIds.has(experimentId)) return []
      const data = checkpoint.data as Record<string, unknown>
      const parsed = RecentAuthoringAttempt.safeParse({
        jobId: job.id,
        experimentId,
        iteration: matched.iteration,
        attempt: matched.attempt,
        status: data.status,
        programFingerprint: data.programFingerprint,
        semanticProgramFingerprint: data.semanticProgramFingerprint,
        workflowFingerprint: data.workflowFingerprint,
        error: data.error,
        recordedAt: data.recordedAt ?? checkpoint.completedAt,
      })
      return parsed.success ? [parsed.data] : []
    })).toSorted((left, right) => right.recordedAt.localeCompare(left.recordedAt)).slice(0, 20)
  }

  export function collectRecentSkillFeedback(
    jobs: Awaited<ReturnType<typeof ResearchJobs.list>>,
    campaignId: string,
    experimentIds: Set<string>,
  ): z.infer<typeof RecentSkillFeedback>[] {
    return jobs.flatMap((job) => Object.entries(job.checkpoints).flatMap(([phase, checkpoint]) => {
      const matched = parseRecursivePhase(phase, "completed")
      if (!matched) return []
      let experimentId: string | undefined
      if (job.payload.kind === "autoresearch") experimentId = job.payload.experimentId
      if (job.payload.kind === "campaign_loop" && job.payload.campaignId === campaignId && matched.step) {
        const move = (job.checkpoints[`step:${matched.step}:proposal`]?.data as { move?: { experimentId?: unknown } } | undefined)?.move
        if (typeof move?.experimentId === "string") experimentId = move.experimentId
      }
      if (!experimentId || !experimentIds.has(experimentId)) return []
      const data = checkpoint.data as { skillFeedback?: unknown[] }
      return (data.skillFeedback ?? []).flatMap((feedback) => {
        const parsed = RecentSkillFeedback.safeParse({
          ...(feedback as Record<string, unknown>),
          jobId: job.id,
          experimentId,
          iteration: matched.iteration,
          recordedAt: checkpoint.completedAt,
        })
        return parsed.success ? [parsed.data] : []
      })
    })).toSorted((left, right) => right.recordedAt.localeCompare(left.recordedAt)).slice(0, 20)
  }

  function parseRecursivePhase(
    phase: string,
    suffix: "authoring" | "completed",
  ): { step?: number; iteration: number; attempt?: number } | undefined {
    const ending = suffix === "authoring" ? ":authoring:(\\d+)$" : ":completed$"
    const legacy = phase.match(new RegExp(`^(?:step:(\\d+):autoresearch:)?iteration:(\\d+)${ending}`))
    if (legacy) {
      return {
        step: legacy[1] ? Number(legacy[1]) : undefined,
        iteration: Number(legacy[2]),
        attempt: legacy[3] ? Number(legacy[3]) : undefined,
      }
    }
    const discovery = phase.match(new RegExp(`^(?:step:(\\d+):)?discovery:cycle:(\\d+)${ending}`))
    if (!discovery) return undefined
    return {
      step: discovery[1] ? Number(discovery[1]) : undefined,
      iteration: Number(discovery[2]),
      attempt: discovery[3] ? Number(discovery[3]) : undefined,
    }
  }

  export function reconcileRecentSkillFeedback(
    feedback: RecentSkillFeedback[],
    trajectories: RecentTrajectory[],
    skillVersions: ResearchDomain.SkillVersion[] = [],
  ): RecentSkillFeedback[] {
    return feedback.filter((item) => {
      if (item.trigger !== "optional_evidence_gap") return true
      const referenced = new Set(item.trajectoryRefs)
      // Artifact verification is authoritative over a previously checkpointed
      // inference. Suppress only the exact optional-gap feedback whose referenced
      // run/trial now verifies as complete; retain unrelated and genuine gaps.
      return !trajectories.some((trajectory) =>
        trajectory.experimentId === item.experimentId &&
        trajectory.evidenceCompleteness?.status === "complete" &&
        (referenced.has(trajectory.trial.id) || (trajectory.run && referenced.has(trajectory.run.id)))
      )
    }).map((item) => {
      const refinement = skillVersions
        .filter((version) =>
          version.skillId === item.skillId &&
          version.source === "campaign_refinement" &&
          version.trajectoryRefs.some((reference) => item.trajectoryRefs.includes(reference))
        )
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      if (!refinement) return item
      return RecentSkillFeedback.parse({
        ...item,
        refinement: {
          versionId: refinement.id,
          status: refinement.status,
          replayPassed: refinement.replay?.passed,
          evaluatedAt: refinement.replay?.evaluatedAt,
        },
      })
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
      const singleIntent = move.recursionMode === "single_intent" || (
        move.recursionMode === undefined && Boolean(
          move.trialIntent || move.baselineTrialId || move.searchPolicy || move.staticControlScope,
        )
      )
      const reasons = [
        ...(!experiment ? [`Experiment ${move.experimentId} is outside this campaign`] : []),
        ...(experiment && experiment.status !== "active" ? [`Experiment ${move.experimentId} is ${experiment.status}`] : []),
        ...(observation.activeJobs.some(
          (job) => job.kind === "autoresearch" && job.targetId === move.experimentId,
        )
          ? [`Experiment ${move.experimentId} already has active autoresearch`]
          : []),
        ...(singleIntent && (move.trialIntent ?? "optimize") === "optimize" && move.searchPolicy && !move.searchPolicy.preferredGenerators.length
          ? ["Optimize search policy requires at least one preferred generator and allocation"]
          : []),
        ...(singleIntent && ["negative_control", "calibrate"].includes(move.trialIntent ?? "optimize") && !move.baselineTrialId
          ? ["Static control/calibration moves require an exact baselineTrialId"]
          : []),
        ...(singleIntent && move.baselineTrialId && experiment?.incumbentTrialId !== move.baselineTrialId
          ? [`Static baseline ${move.baselineTrialId} is not experiment ${move.experimentId}'s incumbent ${experiment?.incumbentTrialId ?? "(none)"}`]
          : []),
        ...(move.allowEquivalent && !move.equivalenceJustification
          ? ["Intentional equivalent proposals require an equivalenceJustification"]
          : []),
        ...(singleIntent && (move.staticControlScope === "same_length_scaffold") && !["negative_control", "calibrate"].includes(move.trialIntent ?? "optimize")
          ? ["Broad same-length scaffold controls are restricted to non-promotable negative_control or calibrate trials"]
          : []),
        ...(!observation.researchState.charter.successCriteria.some(
          (criterion) => criterion.id === move.researchBasis.goalCriterionId && criterion.status === "open",
        )
          ? [`Research basis goal criterion ${move.researchBasis.goalCriterionId} is not an open campaign success criterion`]
          : []),
        ...(move.researchBasis.hypothesisId && !observation.researchState.hypotheses.some(
          (hypothesis) => hypothesis.id === move.researchBasis.hypothesisId,
        )
          ? [`Research basis hypothesis ${move.researchBasis.hypothesisId} is outside this campaign`]
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
      const pending = observation.skills.recentRefinements.find((version) =>
        version.skillId === move.skillId && version.status === "candidate"
      )
      const visible = JSON.stringify(observation)
      const unknown = move.trajectoryRefs.filter((reference) => !visible.includes(`"${reference}"`))
      const reasons = [
        ...(unknown.length ? [`Trajectory references are outside this observation: ${unknown.join(", ")}`] : []),
        ...(!experiment || experiment.status !== "active" ? [`Replay experiment ${move.experimentId} is not active in this campaign`] : []),
        ...(observation.activeJobs.some((job) => job.kind === "capability_refinement" && job.targetId === move.skillId)
          ? [`Skill ${move.skillId} already has active capability refinement`]
          : []),
        ...(pending
          ? [`Skill ${move.skillId} already has candidate ${pending.id}; replay that candidate before proposing another refinement`]
          : []),
      ]
      return reasons.length
        ? { status: "rejected", move, reasons }
        : { status: "authorized", move, executable: true }
    }
    if (move.kind === "replay_skill") {
      const experiment = observation.experiments.find((item) => item.id === move.experimentId)
      const candidate = observation.skills.recentRefinements.find((version) => version.id === move.candidateVersionId)
      const reasons = [
        ...(!candidate ? [`Skill candidate ${move.candidateVersionId} is outside this campaign observation`] : []),
        ...(candidate && candidate.status !== "candidate" ? [`Skill ${candidate.id} is ${candidate.status}, not pending replay`] : []),
        ...(!experiment || experiment.status !== "active" ? [`Replay experiment ${move.experimentId} is not active in this campaign`] : []),
        ...(observation.activeJobs.some((job) => job.kind === "skill_shadow_replay" && job.targetId === move.candidateVersionId)
          ? [`Skill candidate ${move.candidateVersionId} already has active shadow replay`]
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
