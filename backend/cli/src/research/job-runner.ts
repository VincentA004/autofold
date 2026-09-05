import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import type z from "zod"
import { ResearchAutoresearch } from "./autoresearch"
import { ResearchCampaignLoop } from "./campaign-loop"
import { ResearchJobs, ResearchJobService } from "./job-service"
import { ResearchLiteratureReview } from "./literature-review"
import { ResearchDomain } from "./domain"
import { CapabilityRefinement } from "./capability-refinement"
import { SkillShadowReplay } from "./skill-shadow-replay"
import { CampaignSkills } from "./campaign-skills"
import { ResearchSkills } from "./research-skills"
import { ResearchTrajectoryCloseout } from "./trajectory-closeout"
import { ResearchOrchestration } from "./orchestration"

const LEASE_MS = 30_000
const HEARTBEAT_MS = 10_000
const POLL_MS = 1_000
const log = Log.create({ service: "research.jobs" })
const loops = new Map<string, Promise<void>>()
const rerun = new Set<string>()
const active = new Map<string, AbortController>()

export namespace ResearchJobRunner {
  export function wake(directory = Instance.directory): void {
    if (loops.has(directory)) {
      rerun.add(directory)
      return
    }
    const loop = run(directory).finally(() => {
      loops.delete(directory)
      if (!rerun.delete(directory)) return
      wake(directory)
    })
    loops.set(directory, loop)
  }

  export function abort(jobId: string): void {
    active.get(jobId)?.abort(new Error(`Job ${jobId} was cancelled`))
  }

  async function run(directory: string): Promise<void> {
    for (;;) {
      const pending = await Instance.provide({
        directory,
        async fn() {
          const projectId = Instance.project.id
          const job = await ResearchJobs.claim(projectId, LEASE_MS)
          if (job?.leaseId) await execute(projectId, job, job.leaseId)
          return (await ResearchJobs.list(projectId)).some((item) =>
            ["queued", "running", "retry_wait"].includes(item.status),
          )
        },
      }).catch((error) => {
        log.error("job loop failed", { directory, error })
        return false
      })
      if (!pending) return
      await Bun.sleep(POLL_MS)
    }
  }

  async function execute(
    projectId: string,
    job: ResearchDomain.Job,
    leaseId: string,
  ): Promise<void> {
    const jobId = job.id
    const controller = new AbortController()
    active.set(jobId, controller)
    const heartbeat = setInterval(() => {
      void ResearchJobs.heartbeat(projectId, jobId, leaseId, LEASE_MS).catch(() => controller.abort())
    }, HEARTBEAT_MS)
    heartbeat.unref()
    try {
      const result = await dispatch(projectId, job, leaseId, controller.signal)
      await ResearchJobs.succeed(projectId, jobId, leaseId, result)
    } catch (error) {
      await ResearchJobs.fail(projectId, jobId, leaseId, error).catch((cause) =>
        log.warn("failed to record job failure", { jobId, error: cause }),
      )
    } finally {
      clearInterval(heartbeat)
      active.delete(jobId)
    }
  }

  async function dispatch(
    projectId: string,
    job: ResearchDomain.Job,
    leaseId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const payload = job.payload
    if (payload.kind === "autoresearch" && autonomousPayload(payload)) {
      return dispatchDiscovery(projectId, job, leaseId, signal, payload)
    }
    if (payload.kind === "autoresearch") {
      const selectionContext = await ResearchAutoresearch.loadContext(payload.experimentId)
      const lockCheckpoint = job.checkpoints["contract-lock"]
      const contractLock = lockCheckpoint
        ? ResearchAutoresearch.ContractLock.parse(lockCheckpoint.data)
        : ResearchAutoresearch.ContractLock.parse({
            experimentId: selectionContext.experiment.id,
            contractHash: selectionContext.experiment.contractHash,
          })
      ResearchAutoresearch.assertContractLock(selectionContext, contractLock)
      if (!lockCheckpoint) {
        await ResearchJobs.checkpoint(projectId, job.id, leaseId, "contract-lock", contractLock)
      }
      const skillKnowledge = await CampaignSkills.service.select(
        projectId,
        selectionContext.experiment.campaignId,
        Instance.directory,
        ResearchSkills.Capability.options,
      )
      const proposals: Record<number, ResearchAutoresearch.Proposal> = {}
      const authoringAttempts: Record<number, Record<number, ResearchAutoresearch.AuthoringAttempt>> = {}
      const runs: Record<number, z.infer<typeof ResearchAutoresearch.RunCheckpoint>> = {}
      const iterations: Record<number, ResearchAutoresearch.Iteration> = {}
      for (let index = 1; index <= payload.iterations; index++) {
        const proposal = job.checkpoints[`iteration:${index}:proposal`]
        if (proposal) proposals[index] = ResearchAutoresearch.ProposalCheckpoint.parse(proposal.data)
        const run = job.checkpoints[`iteration:${index}:run`]
        if (run) runs[index] = ResearchAutoresearch.RunCheckpoint.parse(run.data)
        const completed = job.checkpoints[`iteration:${index}:completed`]
        if (completed) {
          const iteration = ResearchAutoresearch.Iteration.parse(completed.data)
          // Failed iteration checkpoints are evidence for operators, not a
          // completed resume point. Replaying them would make a retried job
          // instantly report the same failure without doing any work.
          if (iteration.status === "succeeded" || iteration.status === "stopped") iterations[index] = iteration
        }
      }
      for (const [phase, checkpoint] of Object.entries(job.checkpoints)) {
        const matched = phase.match(/^iteration:(\d+):authoring:(\d+)$/)
        if (!matched) continue
        const iteration = Number(matched[1])
        const attempt = Number(matched[2])
        authoringAttempts[iteration] ??= {}
        authoringAttempts[iteration]![attempt] = ResearchAutoresearch.AuthoringAttempt.parse(checkpoint.data)
      }
      const result = await ResearchAutoresearch.run(payload, undefined, signal, {
        proposals,
        authoringAttempts,
        runs,
        iterations,
        originJobId: job.id,
        contractLock,
        skillRefs: ResearchSkills.references(skillKnowledge),
        skillKnowledge,
        intent: payload.trialIntent,
        directive: {
          rationale: payload.rationale ?? "Improve the frozen experiment objective with a genuinely generated binder candidate.",
          expectedInformationGain: payload.expectedInformationGain ?? "Test a new binder hypothesis rather than replaying the incumbent sequence.",
          decisionMode: payload.decisionMode,
          generatorPolicy: payload.trialIntent === "negative_control" ? "forbidden" : "required",
          preferredGenerators: payload.trialIntent === "negative_control" ? [] : payload.searchPolicy?.preferredGenerators ?? [],
          baselineTrialId: payload.baselineTrialId,
          searchPolicy: payload.searchPolicy,
          evidenceRefs: payload.evidenceRefs,
          allowEquivalent: payload.allowEquivalent,
          equivalenceJustification: payload.equivalenceJustification,
          staticControlScope: payload.staticControlScope,
        },
        onProposal: (index, proposal) =>
          ResearchJobs.checkpoint(projectId, job.id, leaseId, `iteration:${index}:proposal`, { ...proposal }).then(
            () => undefined,
          ),
        onAuthoringAttempt: (attempt) =>
          ResearchJobs.checkpoint(
            projectId,
            job.id,
            leaseId,
            `iteration:${attempt.iteration}:authoring:${attempt.attempt}`,
            attempt,
          ).then(() => undefined),
        onRunStarted: (index, run) =>
          ResearchJobs.checkpoint(projectId, job.id, leaseId, `iteration:${index}:run`, run).then(() => undefined),
        onIteration: async (iteration) => {
          if (iteration.status === "succeeded" || iteration.status === "run_failed") {
            const prefix = `iteration:${iteration.iteration}:knowledge:`
            const completed = job.checkpoints[`${prefix}completed`]
            if (!completed) {
              const proposal = job.checkpoints[`${prefix}proposal`]
              const closeout = await ResearchTrajectoryCloseout.run(
                {
                  campaignId: selectionContext.experiment.campaignId,
                  experimentId: payload.experimentId,
                  sessionId: payload.sessionId,
                  iteration: iteration.iteration,
                  status: iteration.status,
                  trialId: iteration.trialId,
                  runId: iteration.runId,
                  score: iteration.score,
                  decision: iteration.decision,
                  error: iteration.error,
                  generatorPortfolio: iteration.generatorPortfolio ?? [],
                  generatorAllocations: iteration.generatorAllocations ?? [],
                  semanticProgramFingerprint: iteration.semanticProgramFingerprint,
                  workflowFingerprint: iteration.workflowFingerprint,
                  calibrationClass: iteration.calibrationClass,
                  calibrationReplicateOfTrialId: iteration.calibrationReplicateOfTrialId,
                  generationReplicate: iteration.generationReplicate,
                  generationWallSeconds: iteration.generationWallSeconds,
                  generatorDiagnostics: iteration.generatorDiagnostics ?? [],
                  candidateSequences: iterationCandidateSequences(iteration),
                  modelIds: iterationModelIds(iteration),
                },
                {
                  signal,
                  proposal: proposal
                    ? ResearchLiteratureReview.ProposalCheckpoint.parse(proposal.data)
                    : undefined,
                  onProposal: (value) => ResearchJobs.checkpoint(
                    projectId,
                    job.id,
                    leaseId,
                    `${prefix}proposal`,
                    value,
                  ).then(() => undefined),
                },
              )
              await ResearchJobs.checkpoint(projectId, job.id, leaseId, `${prefix}completed`, closeout)
            }
          }
          await ResearchJobs.checkpoint(
            projectId,
            job.id,
            leaseId,
            `iteration:${iteration.iteration}:completed`,
            iteration,
          )
        },
      })
      if (result.completedIterations !== result.requestedIterations && !result.stopReason && !result.yieldReason) {
        const failure = result.iterations.findLast((iteration) => iteration.status !== "succeeded")
        throw new Error(
          `Autoresearch stopped at iteration ${failure?.iteration ?? result.completedIterations + 1}: ${failure?.error ?? failure?.status ?? "incomplete"}`,
        )
      }
      return result
    }
    if (payload.kind === "campaign_loop") {
      return ResearchCampaignLoop.run(payload, {
        jobId: job.id,
        checkpoints: job.checkpoints,
        signal,
        checkpoint: (phase, data) =>
          ResearchJobs.checkpoint(projectId, job.id, leaseId, phase, data).then(() => undefined),
      })
    }
    if (payload.kind === "capability_refinement") {
      const trajectory = job.checkpoints.trajectory
        ? CapabilityRefinement.Trajectory.parse(job.checkpoints.trajectory.data)
        : undefined
      const proposal = job.checkpoints.proposal
        ? CapabilityRefinement.ProposalCheckpoint.parse(job.checkpoints.proposal.data)
        : undefined
      const candidate = job.checkpoints.candidate
        ? ResearchDomain.SkillVersion.parse(job.checkpoints.candidate.data)
        : undefined
      const result = await CapabilityRefinement.run(payload, {
        jobId: job.id,
        trajectory,
        proposal,
        candidate,
        signal,
        onTrajectory: (value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, "trajectory", value).then(() => undefined),
        onProposal: (value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, "proposal", value).then(() => undefined),
        onCandidate: (value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, "candidate", value).then(() => undefined),
      })
      if (!payload.replayExperimentId) return result
      const replay = await ResearchJobs.enqueue(projectId, {
        idempotencyKey: `capability-refinement:${job.id}:shadow-replay`,
        payload: {
          kind: "skill_shadow_replay",
          campaignId: payload.campaignId,
          experimentId: payload.replayExperimentId,
          candidateVersionId: result.candidateVersionId,
          sessionId: payload.sessionId,
          agent: payload.replayAgent,
          repetitions: payload.replayRepetitions,
          continuation: payload.continuation,
        },
      })
      return { ...result, replayJobId: replay.id }
    }
    if (payload.kind === "skill_shadow_replay") {
      const prepared = job.checkpoints.prepared
        ? SkillShadowReplay.Prepared.parse(job.checkpoints.prepared.data)
        : undefined
      const arms: SkillShadowReplay.Lifecycle["arms"] = {}
      for (let repetition = 1; repetition <= payload.repetitions; repetition++) {
        arms[repetition] = {}
        for (const arm of SkillShadowReplay.Arm.options) {
          const proposal = job.checkpoints[`shadow:${repetition}:${arm}:proposal`]
          const run = job.checkpoints[`shadow:${repetition}:${arm}:run`]
          const iteration = job.checkpoints[`shadow:${repetition}:${arm}:completed`]
          arms[repetition]![arm] = {
            proposal: proposal ? ResearchAutoresearch.ProposalCheckpoint.parse(proposal.data) : undefined,
            run: run ? ResearchAutoresearch.RunCheckpoint.parse(run.data) : undefined,
            iteration: iteration ? ResearchAutoresearch.Iteration.parse(iteration.data) : undefined,
          }
        }
      }
      const final = job.checkpoints.final ? ResearchDomain.SkillVersion.parse(job.checkpoints.final.data) : undefined
      const result = await SkillShadowReplay.run(payload, {
        jobId: job.id,
        prepared,
        arms,
        final,
        signal,
        onPrepared: (value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, "prepared", value).then(() => undefined),
        onProposal: (repetition, arm, value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, `shadow:${repetition}:${arm}:proposal`, { ...value }).then(() => undefined),
        onRun: (repetition, arm, value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, `shadow:${repetition}:${arm}:run`, value).then(() => undefined),
        onIteration: (repetition, arm, value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, `shadow:${repetition}:${arm}:completed`, value).then(() => undefined),
        onFinal: (value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, "final", value).then(() => undefined),
      })
      if (!payload.continuation) return result
      const continuation = await ResearchJobs.enqueue(projectId, campaignContinuationInput(payload, job.id))
      return { ...result, continuationJobId: continuation.id }
    }
    const proposal = job.checkpoints.proposal
    const resumeProposal = proposal ? ResearchLiteratureReview.ProposalCheckpoint.parse(proposal.data) : undefined
    const resume = resumeProposal
      ? { resumeProposalPath: resumeProposal.proposalPath, resumeChildSessionId: resumeProposal.childSessionId }
      : {}
    const result = await ResearchLiteratureReview.run(
      { ...payload, ...resume },
      undefined,
      signal,
      {
        onProposal: (value) =>
          ResearchJobs.checkpoint(projectId, job.id, leaseId, "proposal", value).then(() => undefined),
      },
    )
    return {
      campaignId: result.campaignId,
      childSessionId: result.childSessionId,
      proposalPath: result.proposalPath,
      cycleId: result.cycle.id,
      literatureIds: result.records.map((item) => item.id),
      claimIds: result.claims.map((item) => item.id),
      alignmentIds: result.alignments.map((item) => item.id),
      nextExperiment: result.nextExperiment,
    }
  }

  export function campaignContinuationInput(
    payload: Extract<ResearchDomain.JobPayload, { kind: "skill_shadow_replay" }>,
    replayJobId: string,
  ): ResearchJobService.EnqueueInput {
    if (!payload.continuation) throw new Error("Shadow replay has no campaign continuation")
    return {
      idempotencyKey: `skill-shadow-replay:${replayJobId}:campaign-continuation`,
      payload: {
        kind: "campaign_loop",
        campaignId: payload.campaignId,
        experimentId: payload.experimentId,
        sessionId: payload.sessionId,
        maxSteps: payload.continuation.remainingSteps,
        ...(payload.continuation.remainingTrajectories === undefined
          ? {}
          : { maximumTrajectories: payload.continuation.remainingTrajectories }),
        continuedFromJobId: payload.continuation.sourceCampaignJobId,
      },
    }
  }

  function autonomousPayload(payload: Extract<ResearchDomain.JobPayload, { kind: "autoresearch" }>): boolean {
    if (payload.recursionMode === "autonomous_discovery") return true
    if (payload.recursionMode === "single_intent") return false
    return !(payload.trialIntent || payload.baselineTrialId || payload.searchPolicy || payload.staticControlScope)
  }

  function iterationCandidateSequences(iteration: ResearchAutoresearch.Iteration): string[] {
    return [...new Set((iteration.candidateSummaries ?? []).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
      const sequence = (candidate as Record<string, unknown>).sequence
      return typeof sequence === "string" && /^[ACDEFGHIKLMNPQRSTVWY]+$/.test(sequence) ? [sequence] : []
    }))]
  }

  function iterationModelIds(iteration: ResearchAutoresearch.Iteration): string[] {
    return [...new Set((iteration.modelEvidence ?? []).map((evidence) => evidence.modelId))]
  }

  async function dispatchDiscovery(
    projectId: string,
    job: ResearchDomain.Job,
    leaseId: string,
    signal: AbortSignal,
    payload: Extract<ResearchDomain.JobPayload, { kind: "autoresearch" }>,
  ): Promise<Record<string, unknown>> {
    const initial = await ResearchAutoresearch.loadContext(payload.experimentId)
    const prefix = "discovery:"
    const proposals: Record<number, ResearchAutoresearch.Proposal> = {}
    const authoringAttempts: Record<number, Record<number, ResearchAutoresearch.AuthoringAttempt>> = {}
    const runs: Record<number, z.infer<typeof ResearchAutoresearch.RunCheckpoint>> = {}
    const iterations: Record<number, ResearchAutoresearch.Iteration> = {}
    for (let cycle = 1; cycle <= payload.iterations; cycle++) {
      const proposal = job.checkpoints[`${prefix}cycle:${cycle}:proposal`]
      if (proposal) proposals[cycle] = ResearchAutoresearch.ProposalCheckpoint.parse(proposal.data)
      const run = job.checkpoints[`${prefix}cycle:${cycle}:run`]
      if (run) runs[cycle] = ResearchAutoresearch.RunCheckpoint.parse(run.data)
      const completed = job.checkpoints[`${prefix}cycle:${cycle}:completed`]
      if (completed) iterations[cycle] = ResearchAutoresearch.Iteration.parse(completed.data)
    }
    for (const [phase, checkpoint] of Object.entries(job.checkpoints)) {
      const matched = phase.match(/^discovery:cycle:(\d+):authoring:(\d+)$/)
      if (!matched) continue
      const cycle = Number(matched[1])
      const attempt = Number(matched[2])
      authoringAttempts[cycle] ??= {}
      authoringAttempts[cycle]![attempt] = ResearchAutoresearch.AuthoringAttempt.parse(checkpoint.data)
    }
    const lock = job.checkpoints[`${prefix}contract-lock`]
    const result = await ResearchAutoresearch.run(
      {
        experimentId: payload.experimentId,
        sessionId: payload.sessionId,
        iterations: payload.iterations,
        agent: payload.agent,
      },
      undefined,
      signal,
      {
        originJobId: job.id,
        originPhasePrefix: prefix,
        contractLock: lock ? ResearchAutoresearch.ContractLock.parse(lock.data) : undefined,
        proposals,
        authoringAttempts,
        runs,
        iterations,
        intent: "optimize",
        directive: {
          rationale: payload.rationale ?? "Advance the frozen experiment using the most informative next empirical trial.",
          expectedInformationGain: payload.expectedInformationGain ?? "Choose the next test from the live evidence and search landscape.",
          evidenceRefs: payload.evidenceRefs,
        },
        onContractLocked: (value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, `${prefix}contract-lock`, value).then(() => undefined),
        onProposal: (cycle, value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, `${prefix}cycle:${cycle}:proposal`, { ...value }).then(() => undefined),
        onAuthoringAttempt: (value) => ResearchJobs.checkpoint(
          projectId,
          job.id,
          leaseId,
          `${prefix}cycle:${value.iteration}:authoring:${value.attempt}`,
          value,
        ).then(() => undefined),
        onRunStarted: (cycle, value) => ResearchJobs.checkpoint(projectId, job.id, leaseId, `${prefix}cycle:${cycle}:run`, value).then(() => undefined),
        onIteration: async (iteration) => {
          const cycle = iteration.iteration
          if (iteration.status === "succeeded" || iteration.status === "run_failed") {
            const knowledgePrefix = `${prefix}cycle:${cycle}:knowledge:`
            const completed = job.checkpoints[`${knowledgePrefix}completed`]
            if (!completed) {
              const proposal = job.checkpoints[`${knowledgePrefix}proposal`]
              const closeout = await ResearchTrajectoryCloseout.run(
                {
                  campaignId: initial.experiment.campaignId,
                  experimentId: payload.experimentId,
                  sessionId: payload.sessionId,
                  iteration: cycle,
                  status: iteration.status,
                  trialId: iteration.trialId,
                  runId: iteration.runId,
                  score: iteration.score,
                  decision: iteration.decision,
                  error: iteration.error,
                  generatorPortfolio: iteration.generatorPortfolio ?? [],
                  generatorAllocations: iteration.generatorAllocations ?? [],
                  semanticProgramFingerprint: iteration.semanticProgramFingerprint,
                  workflowFingerprint: iteration.workflowFingerprint,
                  calibrationClass: iteration.calibrationClass,
                  calibrationReplicateOfTrialId: iteration.calibrationReplicateOfTrialId,
                  generationReplicate: iteration.generationReplicate,
                  generationWallSeconds: iteration.generationWallSeconds,
                  generatorDiagnostics: iteration.generatorDiagnostics ?? [],
                  candidateSequences: iterationCandidateSequences(iteration),
                  modelIds: iterationModelIds(iteration),
                },
                {
                  signal,
                  proposal: proposal ? ResearchLiteratureReview.ProposalCheckpoint.parse(proposal.data) : undefined,
                  onProposal: (value) => ResearchJobs.checkpoint(
                    projectId,
                    job.id,
                    leaseId,
                    `${knowledgePrefix}proposal`,
                    value,
                  ).then(() => undefined),
                },
              )
              await ResearchJobs.checkpoint(projectId, job.id, leaseId, `${knowledgePrefix}completed`, closeout)
            }
          }
          await ResearchJobs.checkpoint(projectId, job.id, leaseId, `${prefix}cycle:${cycle}:completed`, iteration)
        },
        shouldYield: async () => {
          const latest = await ResearchOrchestration.observe(initial.experiment.campaignId)
          if (ResearchCampaignLoop.knowledgeInterruptDue(latest)) return "knowledge_refresh"
          return undefined
        },
      },
    )
    const completedTrajectories = result.iterations.filter((iteration) =>
      (iteration.status === "succeeded" || iteration.status === "run_failed") && iteration.runId
    ).length
    const remainingTrajectories = Math.max(0, payload.iterations - completedTrajectories)
    const continuation = result.yieldReason && remainingTrajectories > 0 ? {
      sourceCampaignJobId: job.id,
      remainingSteps: 19 as const,
      remainingTrajectories,
    } : undefined
    const refinementJobIds = payload.automaticSkillRefinement
      ? await scheduleSkillRefinements(
          projectId,
          job,
          payload,
          initial.experiment.campaignId,
          result,
          continuation,
        )
      : []
    const continuationJob = continuation && refinementJobIds.length === 0
      ? await ResearchJobs.enqueue(projectId, {
          idempotencyKey: `autoresearch:${job.id}:campaign-continuation`,
          payload: {
            kind: "campaign_loop",
            campaignId: initial.experiment.campaignId,
            experimentId: payload.experimentId,
            sessionId: payload.sessionId,
            maxSteps: continuation.remainingSteps,
            maximumTrajectories: continuation.remainingTrajectories,
            continuedFromJobId: job.id,
          },
        })
      : undefined
    return {
      ...result,
      refinementJobIds,
      ...(continuationJob ? { continuationJobId: continuationJob.id } : {}),
      remainingTrajectories,
    }
  }

  export function skillRefinementCandidates(result: ResearchAutoresearch.Result): Array<{
    skillId: string
    trajectoryRefs: string[]
  }> {
    const grouped = new Map<string, { feedbackCount: number; refs: Set<string>; runs: Set<string> }>()
    for (const iteration of result.iterations) {
      for (const feedback of iteration.skillFeedback ?? []) {
        const group = grouped.get(feedback.skillId) ?? { feedbackCount: 0, refs: new Set(), runs: new Set() }
        group.feedbackCount++
        for (const reference of feedback.trajectoryRefs) {
          group.refs.add(reference)
          if (reference.startsWith("run_")) group.runs.add(reference)
        }
        grouped.set(feedback.skillId, group)
      }
    }
    return [...grouped.entries()]
      .filter(([, group]) => group.feedbackCount >= 2 && group.runs.size >= 2)
      .map(([skillId, group]) => ({ skillId, trajectoryRefs: [...group.refs].toSorted() }))
      .toSorted((left, right) => left.skillId.localeCompare(right.skillId))
  }

  async function scheduleSkillRefinements(
    projectId: string,
    sourceJob: ResearchDomain.Job,
    payload: Extract<ResearchDomain.JobPayload, { kind: "autoresearch" }>,
    campaignId: string,
    result: ResearchAutoresearch.Result,
    continuation?: NonNullable<Extract<ResearchDomain.JobPayload, { kind: "capability_refinement" }>["continuation"]>,
  ): Promise<string[]> {
    const candidates = skillRefinementCandidates(result)
    if (!candidates.length) return []
    const [versions, jobs] = await Promise.all([
      CampaignSkills.service.list(projectId, campaignId),
      ResearchJobs.list(projectId),
    ])
    const enqueued: string[] = []
    for (const candidate of candidates) {
      const pendingVersion = versions.some((version) => version.skillId === candidate.skillId && version.status === "candidate")
      const pendingJob = jobs.some((job) =>
        job.payload.kind === "capability_refinement" &&
        job.payload.campaignId === campaignId &&
        job.payload.skillId === candidate.skillId &&
        ["queued", "running", "retry_wait"].includes(job.status)
      )
      if (pendingVersion || pendingJob) continue
      const refinement = await ResearchJobs.enqueue(projectId, {
        idempotencyKey: `autoresearch:${sourceJob.id}:refine:${candidate.skillId}`,
        payload: {
          kind: "capability_refinement",
          campaignId,
          sessionId: payload.sessionId,
          skillId: candidate.skillId,
          trajectoryRefs: candidate.trajectoryRefs,
          replayExperimentId: payload.experimentId,
          replayAgent: payload.agent,
          replayRepetitions: 3,
          continuation,
        },
      })
      enqueued.push(refinement.id)
    }
    return enqueued
  }
}
