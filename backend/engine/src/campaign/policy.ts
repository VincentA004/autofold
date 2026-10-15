import {DecisionMemory} from '@autofold/science-core/decision-memory'
import {ScientistReview} from '@autofold/science-core/scientist-review'
import z from "zod"
import { ResearchDomain } from "@autofold/science-core/domain"
import { CampaignResources } from "@autofold/science-core/campaign-resources"
import { ResearchSearchPolicy } from "@autofold/science-core/search-policy"
/** Pure scientific campaign policy preserved from the native product; host ports own all effects. */
export namespace CampaignPolicy {
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
    modelEvidenceCoverage: z.unknown().optional(),
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
    programFingerprint: z.string().startsWith("sha256:").optional(),
    attempt: z.number().int().positive().optional(),
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
    resources: z.object({allocatedGpuHours: z.number().nonnegative(), maximumGpuHours: z.number().positive().optional(), remainingGpuHours: z.number().nonnegative().nullable(), remainingGpuSeconds: z.number().int().nonnegative().nullable().optional(), accounting: z.literal("conservative_frozen_allocations")}).passthrough().optional(),
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
    // Historical saved observations retain their interpretation envelope; fresh
    // deliveries use decisionMemory and never duplicate that projection.
    scientistReviews: ScientistReview.Projection.optional(),
    decisionMemory:z.array(DecisionMemory.Packet).optional(),
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
      blockingResearchExperimentIds: z.array(z.string().startsWith("exp_")).optional(),
      reasons: z.array(z.string()),
      unprocessedKnowledgeIds: z.array(z.string().startsWith("knw_")),
      unresolvedQuestions: z.array(z.string()),
      proposedClaimIds: z.array(z.string().startsWith("clm_")),
      contestedClaimIds: z.array(z.string().startsWith("clm_")),
      reviewableContestedClaimIds: z.array(z.string().startsWith("clm_")).default([]),
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
        kind: z.enum(["autoresearch", "knowledge_refresh", "knowledge_review", "campaign_loop", "capability_refinement", "skill_shadow_replay"]),
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
      trialIntent: z.enum(["optimize", "calibrate", "negative_control", "shadow_replay"]).optional(),
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
      contract: ResearchDomain.ExperimentContract.optional(),
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
      reason: z.enum(['scientific_stop','no_testable_refinement','discovery_budget_exhausted','success_criteria_closed']).optional(),
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
      const referenced = move.trajectoryRefs.filter(reference => /^(run|trl|job)_/.test(reference))
      const handled = referenced.length > 0 && referenced.every(reference => observation.recentSkillFeedback.some(item =>
        item.skillId === move.skillId && item.trajectoryRefs.includes(reference) && item.refinement &&
        item.refinement.status !== 'candidate'))
      const reasons = [
        ...(handled ? ['These exact trajectories already have an evaluated refinement; cite a new independent unresolved signal before refining again'] : []),
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
      ...observation.knowledge.reviewableContestedClaimIds,
    ])
    const unknown = move.claimIds.filter((id) => !knownClaims.has(id))
    return unknown.length
      ? { status: "rejected", move, reasons: [`Claims are not pending review: ${unknown.join(", ")}`] }
      : { status: "authorized", move, executable: true }
  }
}

export function materialObservationFingerprint(raw: CampaignPolicy.Observation, currentJobId?: string) {
  const {observedAt, activeJobs, ...material} = CampaignPolicy.Observation.parse(raw)
  return JSON.stringify({...material, activeJobs: activeJobs.filter(job => job.id !== currentJobId)})
}
export function knowledgeInterruptDue(observation: CampaignPolicy.Observation) {
  return observation.knowledge.due && observation.knowledge.reasons.some(reason =>
    ['no_prior_knowledge_cycle', 'scheduled_refresh_due', 'open_research_questions'].includes(reason))
}
/** Research annotations, including older serialized barriers, never gate discovery. */
export function autonomousIterationBudget(observation: CampaignPolicy.Observation, experimentId?: string) {
  const maximum = observation.researchState.charter.constraints.maximumCampaignTrials
  const consumed = observation.experiments.reduce((sum, experiment) => sum + experiment.trialCount, 0)
  let budget = maximum === undefined ? 100 : Math.max(0, Math.min(100, maximum - consumed))
  const experiment = observation.experiments.find(experiment => experiment.id === experimentId)
  if (experiment && observation.resources?.remainingGpuHours !== null && observation.resources?.remainingGpuHours !== undefined && experiment.budget.gpuHours > 0) {
    const remaining = observation.resources.remainingGpuSeconds ?? CampaignResources.gpuSeconds(observation.resources.remainingGpuHours, "grant")
    budget = Math.min(budget, Math.floor(remaining / CampaignResources.gpuSeconds(experiment.budget.gpuHours, "reservation")))
  }
  return budget
}
export interface DiscoveryScheduling {
  discoveryBatchSize?: number
  maximumDiscoveryTrajectories?: number
  reservedReplayTrajectories?: number
  /** Optional assistance runs at a settled discovery boundary, never on cold start. */
  assistanceDue?: boolean
  unavailableAssistance?: Array<'refresh_knowledge' | 'request_review'>
}
/** Host authority for ordinary discovery; replay can consume the protected aggregate residual separately. */
export function ordinaryDiscoveryBudget(trajectories: number, scheduling: DiscoveryScheduling = {}) {
  return Math.max(0, Math.min(scheduling.discoveryBatchSize ?? 2, scheduling.maximumDiscoveryTrajectories ?? trajectories,
    trajectories - (scheduling.reservedReplayTrajectories ?? 0)))
}
export function directActiveExperimentProposal(observation: CampaignPolicy.Observation, trajectories: number, experimentId?: string, _allowKnowledge = true,
  scheduling: DiscoveryScheduling = {}): CampaignPolicy.Move | undefined {
  if (observation.campaign.status !== 'active') return undefined
  const active = observation.experiments.filter(experiment => experiment.status === 'active')
  const experiment = experimentId ? active.find(experiment => experiment.id === experimentId) : active.length === 1 ? active[0] : undefined
  if (!experiment) return undefined
  const criterion = observation.researchState.charter.successCriteria.find(criterion => criterion.status === 'open')
  if (!criterion) return {kind: 'stop', reason: 'success_criteria_closed', rationale: 'No open campaign success criterion authorizes additional discovery.', unresolvedQuestions: observation.knowledge.unresolvedQuestions}
  const budget = Math.min(ordinaryDiscoveryBudget(trajectories, scheduling), autonomousIterationBudget(observation, experiment.id))
  // Literature and review run separately; due or failed OKF work does not occupy discovery boundaries.
  // Procedural candidates assist later batches only after protected paired evaluation.
  if ((budget === 0 || scheduling.assistanceDue) && trajectories >= 6 && autonomousIterationBudget(observation,experiment.id) >= 6 && (scheduling.reservedReplayTrajectories??0) >= 6) {
    const procedural = proceduralFeedbackProposal(observation, experiment.id)
    if (procedural) return procedural
    // Successful evidence can warrant procedural learning too. A bounded Pi assessment
    // decides whether guidance is testable; absence of a failure trigger is not a stop.
    const trusted = observation.recentTrajectories.filter(item => item.experimentId === experiment.id &&
      item.trial.intent !== 'shadow_replay' && item.run?.status === 'succeeded' && item.evaluation?.valid && item.modelEvidence?.some(model => model.status === 'completed'))
    if (new Set(trusted.map(item => item.run!.id)).size >= 2 && observation.skills.active.length) return undefined
  }
  if (budget === 0) return {kind: 'stop', reason: 'discovery_budget_exhausted', rationale: 'The approved ordinary discovery allowance is exhausted.' + ((scheduling.reservedReplayTrajectories ?? 0) > 0 ? ' Protected replay slots remain available only for a supported procedural intervention.' : ''), unresolvedQuestions: observation.knowledge.unresolvedQuestions}
  return {kind: 'iterate_experiment', experimentId: experiment.id, iterations: budget, agent: 'task', recursionMode: 'autonomous_discovery',
    rationale: 'Continue the sole active frozen experiment directly with its persistent scientist.', expectedInformationGain: 'Let the scientist choose the next concrete intervention using committed trusted evidence.',
    researchBasis: {goalCriterionId: criterion.id, hypothesis: 'A scientist-selected same-contract intervention can provide decision-relevant evidence.',
      expectedObservation: 'A locked comparable trajectory advances the frontier, resolves uncertainty, or identifies a supported boundary.',
      falsificationCriterion: 'The authorized trajectories add neither frontier progress nor decision-relevant information.',
      searchDelta: 'The persistent scientist owns the next native program change, selected after inspecting the last committed result.'}}
}

/** Two independent trusted signals expose a bounded procedural intervention; activation still requires locked paired replay. */
export function proceduralFeedbackProposal(observation: CampaignPolicy.Observation, experimentId?: string): CampaignPolicy.Move | undefined {
  for (const candidate of observation.skills.recentRefinements) {
    if (candidate.status !== 'candidate' || observation.activeJobs.some(job => job.kind === 'skill_shadow_replay' && job.targetId === candidate.id)) continue
    const experiment = observation.experiments.find(item => item.status === 'active' && (!experimentId || item.id === experimentId) &&
      (candidate.trajectoryRefs.includes(item.id) || observation.recentTrajectories.some(t => t.experimentId === item.id &&
        (candidate.trajectoryRefs.includes(t.trial.id) || !!t.run && candidate.trajectoryRefs.includes(t.run.id)))))
    if (experiment) return {kind: 'replay_skill', candidateVersionId: candidate.id, experimentId: experiment.id, agent: 'task', repetitions: 3,
      rationale: 'Evaluate the existing immutable procedural candidate before authoring another refinement.',
      expectedInformationGain: 'Three independent equal-budget parent/candidate pairs test the guidance without presuming an improvement.'}
  }
  const groups = new Map<string, CampaignPolicy.RecentSkillFeedback[]>()
  for (const item of observation.recentSkillFeedback) {
    if (experimentId && item.experimentId !== experimentId || item.refinement && item.refinement.status !== 'candidate') continue
    if (!observation.experiments.some(experiment => experiment.id === item.experimentId && experiment.status === 'active')) continue
    const key = item.experimentId + ':' + item.skillId + ':' + item.trigger, items = groups.get(key) ?? []
    items.push(item); groups.set(key, items)
  }
  for (const items of groups.values()) {
    const first = items[0]!
    const independent = new Set(items.flatMap(item => {
      const run = item.trajectoryRefs.find(reference => reference.startsWith('run_'))
      return run ? [run] : item.trigger === 'authoring_failure' && item.programFingerprint ? [item.programFingerprint] : []
    }))
    if (independent.size < 2 || !observation.skills.active.some(version => version.skillId === first.skillId)) continue
    if (observation.activeJobs.some(job => job.kind === 'capability_refinement' && job.targetId === first.skillId)) continue
    const candidate = observation.skills.recentRefinements.find(version => version.skillId === first.skillId && version.status === 'candidate')
    if (candidate) {
      if (observation.activeJobs.some(job => job.kind === 'skill_shadow_replay' && job.targetId === candidate.id)) continue
      return {kind: 'replay_skill', candidateVersionId: candidate.id, experimentId: first.experimentId, agent: 'task', repetitions: 3,
        rationale: 'Repeated independent trusted procedural signals already have an immutable candidate; compare the existing parent/candidate chain before creating another refinement.',
        expectedInformationGain: 'Three independent paired programs determine whether the proposed guidance improves the frozen procedural evidence.'}
    }
    return {kind: 'refine_skill', skillId: first.skillId, experimentId: first.experimentId, agent: 'task', repetitions: 3,
      trajectoryRefs: [...new Set(items.flatMap(item => item.trajectoryRefs).filter(reference => /^(exp|trl|evl|run|knw|clm|job)_/.test(reference)))].slice(0,100),
      rationale: `At least two independent trusted trajectories expose a repeated procedural opportunity: ${first.rationale}`.slice(0,4000),
      expectedInformationGain: 'Propose evidence-frozen guidance, then use three independent paired replays before any activation decision.'}
  }
  return undefined
}
