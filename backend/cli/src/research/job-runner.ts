import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import type z from "zod"
import { ResearchAutoresearch } from "./autoresearch"
import { ResearchCampaignLoop } from "./campaign-loop"
import { ResearchJobs } from "./job-service"
import { ResearchLiteratureReview } from "./literature-review"
import { ResearchDomain } from "./domain"
import { CapabilityRefinement } from "./capability-refinement"
import { SkillShadowReplay } from "./skill-shadow-replay"
import { CampaignSkills } from "./campaign-skills"
import { ResearchSkills } from "./research-skills"

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
          if (iteration.status === "succeeded") iterations[index] = iteration
        }
      }
      const result = await ResearchAutoresearch.run(payload, undefined, signal, {
        proposals,
        runs,
        iterations,
        originJobId: job.id,
        contractLock,
        skillRefs: ResearchSkills.references(skillKnowledge),
        skillKnowledge,
        directive: {
          rationale: "Improve the frozen experiment objective with a genuinely generated binder candidate.",
          expectedInformationGain: "Test a new binder hypothesis rather than replaying the incumbent sequence.",
          generatorPolicy: "required",
          preferredGenerators: [],
        },
        onProposal: (index, proposal) =>
          ResearchJobs.checkpoint(projectId, job.id, leaseId, `iteration:${index}:proposal`, { ...proposal }).then(
            () => undefined,
          ),
        onRunStarted: (index, run) =>
          ResearchJobs.checkpoint(projectId, job.id, leaseId, `iteration:${index}:run`, run).then(() => undefined),
        onIteration: (iteration) =>
          ResearchJobs.checkpoint(
            projectId,
            job.id,
            leaseId,
            `iteration:${iteration.iteration}:completed`,
            iteration,
          ).then(() => undefined),
      })
      if (result.completedIterations !== result.requestedIterations && !result.stopReason) {
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
      return SkillShadowReplay.run(payload, {
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
}
