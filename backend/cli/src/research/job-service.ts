import crypto from "node:crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { ResearchDomain } from "./domain"
import { StorageResearchStore, type ResearchState, type ResearchStore } from "./store"

const TERMINAL = new Set<ResearchDomain.JobStatus>(["succeeded", "failed", "cancelled"])

export namespace ResearchJobService {
  export const NotFoundError = NamedError.create(
    "ResearchJobNotFoundError",
    z.object({ id: z.string() }),
  )

  export const ConflictError = NamedError.create(
    "ResearchJobConflictError",
    z.object({ code: z.string(), message: z.string() }),
  )

  export const EnqueueInput = z.object({
    idempotencyKey: z.string().trim().min(1).max(500),
    payload: ResearchDomain.JobPayload,
    // Agent failures are not automatically replayed: a retry can repeat every
    // billable child call when a plan/report checkpoint does not yet exist.
    // Operators can explicitly retry a failed job after inspecting its cause.
    maxAttempts: z.number().int().min(1).max(20).default(1),
  })
  export type EnqueueInput = z.input<typeof EnqueueInput>

  export interface Options {
    now?: () => string
    id?: () => string
    leaseId?: () => string
  }

  export class Service {
    private readonly now: () => string
    private readonly id: () => string
    private readonly leaseId: () => string

    constructor(
      private readonly store: ResearchStore,
      options: Options = {},
    ) {
      this.now = options.now ?? (() => new Date().toISOString())
      this.id = options.id ?? (() => `job_${crypto.randomUUID().replaceAll("-", "")}`)
      this.leaseId = options.leaseId ?? (() => crypto.randomUUID())
    }

    async enqueue(projectId: string, raw: EnqueueInput): Promise<ResearchDomain.Job> {
      const input = EnqueueInput.parse(raw)
      return this.store.mutate(projectId, (state) => {
        const existing = Object.values(state.jobs).find((job) => job.idempotencyKey === input.idempotencyKey)
        if (existing) {
          if (JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) {
            throw new ConflictError({
              code: "idempotency_key_reused",
              message: `Idempotency key ${input.idempotencyKey} was already used for a different job`,
            })
          }
          return existing
        }
        this.assertTarget(state, input.payload)
        const timestamp = this.now()
        const job = ResearchDomain.Job.parse({
          id: this.id(),
          projectId,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
          status: "queued",
          attempts: 0,
          maxAttempts: input.maxAttempts,
          createdAt: timestamp,
          updatedAt: timestamp,
          checkpoints: {},
        })
        state.jobs[job.id] = job
        return job
      })
    }

    async list(projectId: string): Promise<ResearchDomain.Job[]> {
      const state = await this.store.read(projectId)
      return Object.values(state.jobs).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    }

    async get(projectId: string, jobId: string): Promise<ResearchDomain.Job> {
      return this.job(await this.store.read(projectId), jobId)
    }

    async claim(projectId: string, leaseMs: number): Promise<ResearchDomain.Job | undefined> {
      return this.store.mutate(projectId, (state) => {
        const now = this.now()
        this.recoverExpired(state, now)
        const candidate = Object.values(state.jobs)
          .filter((job) => job.status === "queued" || (job.status === "retry_wait" && (!job.nextAttemptAt || job.nextAttemptAt <= now)))
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        if (!candidate) return undefined
        const leaseId = this.leaseId()
        const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
        const claimed = ResearchDomain.Job.parse({
          ...candidate,
          status: "running",
          attempts: candidate.attempts + 1,
          startedAt: candidate.startedAt ?? now,
          heartbeatAt: now,
          leaseId,
          leaseExpiresAt,
          nextAttemptAt: undefined,
          error: undefined,
          updatedAt: now,
        })
        state.jobs[claimed.id] = claimed
        return claimed
      })
    }

    async heartbeat(projectId: string, jobId: string, leaseId: string, leaseMs: number): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        this.assertLease(job, leaseId)
        const now = this.now()
        const updated = ResearchDomain.Job.parse({
          ...job,
          heartbeatAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
          updatedAt: now,
        })
        state.jobs[jobId] = updated
        return updated
      })
    }

    async checkpoint(
      projectId: string,
      jobId: string,
      leaseId: string,
      phase: string,
      data: Record<string, unknown>,
    ): Promise<ResearchDomain.JobCheckpoint> {
      const normalizedPhase = z.string().trim().min(1).max(200).parse(phase)
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        this.assertLease(job, leaseId)
        const existing = job.checkpoints[normalizedPhase]
        if (existing) {
          if (JSON.stringify(existing.data) !== JSON.stringify(data)) {
            throw new ConflictError({
              code: "checkpoint_conflict",
              message: `Checkpoint ${normalizedPhase} for job ${jobId} already contains different data`,
            })
          }
          return existing
        }
        const now = this.now()
        const checkpoint = ResearchDomain.JobCheckpoint.parse({ phase: normalizedPhase, data, completedAt: now })
        state.jobs[jobId] = ResearchDomain.Job.parse({
          ...job,
          checkpoints: { ...job.checkpoints, [normalizedPhase]: checkpoint },
          updatedAt: now,
        })
        return checkpoint
      })
    }

    async succeed(
      projectId: string,
      jobId: string,
      leaseId: string,
      result: Record<string, unknown>,
    ): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        if (job.status === "cancelled") return job
        this.assertLease(job, leaseId)
        const now = this.now()
        const updated = ResearchDomain.Job.parse({
          ...job,
          status: "succeeded",
          result,
          completedAt: now,
          updatedAt: now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
        })
        state.jobs[jobId] = updated
        return updated
      })
    }

    async fail(projectId: string, jobId: string, leaseId: string, cause: unknown): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        if (job.status === "cancelled") return job
        this.assertLease(job, leaseId)
        const now = this.now()
        const error = (cause instanceof Error ? cause.message : String(cause)).trim().slice(0, 4_000) || "Unknown job failure"
        const retry = job.attempts < job.maxAttempts
        const updated = ResearchDomain.Job.parse({
          ...job,
          status: retry ? "retry_wait" : "failed",
          error,
          nextAttemptAt: retry ? new Date(Date.parse(now) + Math.min(60_000, 1_000 * 2 ** (job.attempts - 1))).toISOString() : undefined,
          completedAt: retry ? undefined : now,
          updatedAt: now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
        })
        state.jobs[jobId] = updated
        return updated
      })
    }

    async cancel(projectId: string, jobId: string): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        if (TERMINAL.has(job.status)) return job
        const now = this.now()
        const updated = ResearchDomain.Job.parse({
          ...job,
          status: "cancelled",
          cancelRequestedAt: now,
          completedAt: now,
          updatedAt: now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
          nextAttemptAt: undefined,
        })
        state.jobs[jobId] = updated
        return updated
      })
    }

    async retry(projectId: string, jobId: string): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        if (job.status !== "failed" && job.status !== "cancelled") {
          throw new ConflictError({ code: "job_not_retryable", message: `Job ${jobId} is ${job.status}, not failed or cancelled` })
        }
        const now = this.now()
        const updated = ResearchDomain.Job.parse({
          ...job,
          status: "queued",
          attempts: 0,
          error: undefined,
          cancelRequestedAt: undefined,
          completedAt: undefined,
          nextAttemptAt: undefined,
          updatedAt: now,
        })
        state.jobs[jobId] = updated
        return updated
      })
    }

    async recover(projectId: string): Promise<void> {
      await this.store.mutate(projectId, (state) => this.recoverExpired(state, this.now()))
    }

    private recoverExpired(state: ResearchState, now: string): void {
      for (const job of Object.values(state.jobs)) {
        if (job.status !== "running" || !job.leaseExpiresAt || job.leaseExpiresAt > now) continue
        // A persisted phase checkpoint is a proof that this job implements a
        // resumable protocol. Reclaiming it after a worker/server restart must
        // not consume a scientific retry (or repeat completed billable work),
        // even when maxAttempts=1. Ordinary execution failures still flow
        // through fail() and retain the conservative no-automatic-retry policy.
        const resumable = Object.keys(job.checkpoints).length > 0
        const retry = resumable || job.attempts < job.maxAttempts
        state.jobs[job.id] = ResearchDomain.Job.parse({
          ...job,
          status: retry ? "retry_wait" : "failed",
          attempts: resumable ? Math.max(0, job.attempts - 1) : job.attempts,
          error: "Worker lease expired before the job completed",
          nextAttemptAt: retry ? now : undefined,
          completedAt: retry ? undefined : now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
          updatedAt: now,
        })
      }
    }

    private assertTarget(state: ResearchState, payload: ResearchDomain.JobPayload): void {
      if (payload.kind === "autoresearch" && !state.experiments[payload.experimentId]) {
        throw new ConflictError({ code: "experiment_not_found", message: `Experiment ${payload.experimentId} does not exist` })
      }
      if (payload.kind === "skill_shadow_replay") {
        const experiment = state.experiments[payload.experimentId]
        if (!experiment || experiment.campaignId !== payload.campaignId) {
          throw new ConflictError({ code: "experiment_not_found", message: `Experiment ${payload.experimentId} is outside ${payload.campaignId}` })
        }
        const candidate = state.skillVersions[payload.candidateVersionId]
        if (!candidate || candidate.campaignId !== payload.campaignId || !candidate.parentVersionId) {
          throw new ConflictError({ code: "skill_candidate_not_found", message: `Candidate ${payload.candidateVersionId} is outside ${payload.campaignId}` })
        }
        if (candidate.status !== "candidate" && !candidate.replay) {
          throw new ConflictError({ code: "skill_not_replayable", message: `Skill ${candidate.id} is ${candidate.status}` })
        }
      }
      if ((payload.kind === "knowledge_refresh" || payload.kind === "campaign_loop" || payload.kind === "capability_refinement") && !state.campaigns[payload.campaignId]) {
        throw new ConflictError({ code: "campaign_not_found", message: `Campaign ${payload.campaignId} does not exist` })
      }
      if (payload.kind === "capability_refinement") {
        const active = Object.values(state.skillVersions).find((version) =>
          version.campaignId === payload.campaignId && version.skillId === payload.skillId && version.status === "active",
        )
        if (!active) throw new ConflictError({ code: "active_skill_not_found", message: `No active ${payload.skillId} exists in ${payload.campaignId}` })
        const pending = Object.values(state.skillVersions).find((version) =>
          version.campaignId === payload.campaignId && version.skillId === payload.skillId && version.status === "candidate",
        )
        if (pending) throw new ConflictError({
          code: "skill_candidate_pending",
          message: `Candidate ${pending.id} must complete replay before refining ${payload.skillId} again`,
        })
        if (payload.replayExperimentId) {
          const experiment = state.experiments[payload.replayExperimentId]
          if (!experiment || experiment.campaignId !== payload.campaignId || experiment.status !== "active") {
            throw new ConflictError({ code: "replay_experiment_not_active", message: `Replay experiment ${payload.replayExperimentId} is not active in ${payload.campaignId}` })
          }
        }
      }
    }

    private assertLease(job: ResearchDomain.Job, leaseId: string): void {
      if (job.status !== "running" || job.leaseId !== leaseId) {
        throw new ConflictError({ code: "job_lease_lost", message: `Lease for job ${job.id} is no longer active` })
      }
    }

    private job(state: ResearchState, jobId: string): ResearchDomain.Job {
      const job = state.jobs[jobId]
      if (!job) throw new NotFoundError({ id: jobId })
      return job
    }
  }
}

export const ResearchJobs = new ResearchJobService.Service(new StorageResearchStore())
