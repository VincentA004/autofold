import {cancelOperationsForJobs,ensureJobOperation,recordNativeJobLifecycle} from "./operations"
import crypto from "node:crypto"
import z from "zod"
import { NamedError } from "../util/error"
import { ResearchDomain } from "./domain"
import { type ResearchState, type ResearchStore } from "./store"

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
    /** Host-only enqueue fence; never persisted as scientific/model authority. */
    parentLeaseId: z.string().min(1).optional(),
    // Agent failures are not automatically replayed: a retry can repeat every
    // billable child call when a plan/report checkpoint does not yet exist.
    // Operators can explicitly retry a failed job after inspecting its cause.
    maxAttempts: z.number().int().min(1).max(20).default(1),
  })
  export type EnqueueInput = z.input<typeof EnqueueInput>

  /** Evaluated atomically against the current project state before leasing. */
  export type Eligibility = (candidate: ResearchDomain.Job, state: Readonly<ResearchState>) => boolean

  export type Ownership = {valid: true} | {valid: false; reason: "cancelled" | "lease_lost" | "ancestor_lost"; jobId: string}

  const live = (job: ResearchDomain.Job, now: string) => job.status === "running" && !job.cancelRequestedAt &&
    !!job.leaseId && !!job.leaseExpiresAt && Number.isFinite(Date.parse(job.leaseExpiresAt)) && Date.parse(job.leaseExpiresAt) > Date.parse(now)

  /** Snapshot-only authority checks shared by claims, lifecycle commits and scientific admission.
   * Recovery may adopt a new ancestor epoch, but every ancestor must currently be live.
   */
  export function inspectAncestry(state: Readonly<ResearchState>, job: ResearchDomain.Job, now: string): Ownership {
    if (job.payload.runtime !== "autofold-pi.v1") return {valid: true}
    const seen = new Set([job.id])
    let current = job
    while (current.payload.parentJobId !== undefined) {
      const id = current.payload.parentJobId
      if (typeof id !== "string" || seen.has(id) || seen.size > 100)
        return {valid: false, reason: "ancestor_lost", jobId: typeof id === "string" ? id : current.id}
      seen.add(id)
      const parent = state.jobs[id]
      if (!parent || parent.projectId !== job.projectId || parent.payload.runtime !== "autofold-pi.v1" || !live(parent, now))
        return {valid: false, reason: "ancestor_lost", jobId: id}
      current = parent
    }
    return {valid: true}
  }

  export function inspectOwnership(state: Readonly<ResearchState>, job: ResearchDomain.Job, now: string, expectedLeaseId?: string): Ownership {
    if (job.status === "cancelled" || job.cancelRequestedAt) return {valid: false, reason: "cancelled", jobId: job.id}
    if (!live(job, now) || expectedLeaseId !== undefined && job.leaseId !== expectedLeaseId)
      return {valid: false, reason: "lease_lost", jobId: job.id}
    return inspectAncestry(state, job, now)
  }

  export interface ClaimOptions {
    eligible?: Eligibility
    /** Runtime/kind recognition without the active-scope exclusion used for claims. */
    recoverable?: Eligibility
    /** Exact host-selected recovery only; never enables a general retry queue. */
    reconcileJobId?: string
  }

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
      return this.enqueuePrepared(projectId, () => raw)
    }

    /** Trusted host preparation and admission share one transaction. Rejection cannot
     * bind scientific ownership without admitting its exact idempotent job. */
    async enqueuePrepared(projectId: string, prepare: (state: ResearchState) => EnqueueInput): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const input = EnqueueInput.parse(prepare(state))
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
        const parentId = input.payload.parentJobId
        if (parentId !== undefined) {
          const parent = typeof parentId === "string" ? state.jobs[parentId] : undefined
          const campaignOf = (payload: ResearchDomain.JobPayload) => payload.kind === "autoresearch" ? state.experiments[payload.experimentId]?.campaignId : payload.campaignId
          if (!parent || parent.projectId !== projectId || parent.payload.runtime !== "autofold-pi.v1" || input.payload.runtime !== "autofold-pi.v1" ||
            campaignOf(parent.payload) !== campaignOf(input.payload) || !input.parentLeaseId ||
            !inspectOwnership(state, parent, this.now(), input.parentLeaseId).valid)
            throw new ConflictError({code: "parent_job_fence", message: "Child creation requires its active leased Pi parent in the same campaign"})
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
        if(job.payload.runtime==="autofold-pi.v1")ensureJobOperation(state,job,timestamp)
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

    async checkOwnership(projectId: string, jobId: string, leaseId: string): Promise<{job: ResearchDomain.Job; ownership: Ownership}> {
      const scope = {records: {jobs: [jobId]}, jobAncestors: jobId}
      const state = await (this.store.readRecords?.(projectId, scope) ?? this.store.read(projectId)), job = this.job(state, jobId)
      return {job, ownership: inspectOwnership(state, job, this.now(), leaseId)}
    }

    async claim(projectId: string, leaseMs: number, options?: Eligibility | ClaimOptions): Promise<ResearchDomain.Job | undefined> {
      return this.store.mutate(projectId, (state) => {
        const now = this.now()
        const eligible = typeof options === "function" ? options : options?.eligible
        const reconcileJobId = typeof options === "function" ? undefined : options?.reconcileJobId
        const recoverable = typeof options === "function" ? options : options?.recoverable ?? eligible
        this.recoverExpired(state, now, recoverable)
        const candidate = Object.values(state.jobs)
          .filter((job) => job.status === "queued" || job.status === "interrupted" || job.status === "recovery_required" && job.id === reconcileJobId || (job.status === "retry_wait" && (!job.nextAttemptAt || job.nextAttemptAt <= now)))
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
          .find((job) => inspectAncestry(state, job, now).valid && (!eligible || eligible(job, state)))
        if (!candidate) return undefined
        const leaseId = this.leaseId()
        const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
        const claimed = ResearchDomain.Job.parse({
          ...candidate,
          status: "running",
          attempts: ["interrupted", "recovery_required"].includes(candidate.status) ? Math.max(1, candidate.attempts) : candidate.attempts + 1,
          recoveryCount: candidate.recoveryCount + (["interrupted", "recovery_required"].includes(candidate.status) ? 1 : 0),
          startedAt: candidate.startedAt ?? now,
          heartbeatAt: now,
          leaseId,
          leaseExpiresAt,
          nextAttemptAt: undefined,
          error: undefined,
          updatedAt: now,
        })
        state.jobs[claimed.id] = claimed
        recordNativeJobLifecycle(state,claimed,now)
        return claimed
      })
    }

    async heartbeat(projectId: string, jobId: string, leaseId: string, leaseMs: number): Promise<ResearchDomain.Job> {
      const scope = {records: {jobs: [jobId]}, jobAncestors: jobId}
      const mutate = this.store.mutateRecords ? (fn: (state: ResearchState) => ResearchDomain.Job) => this.store.mutateRecords!(projectId, scope, fn) : (fn: (state: ResearchState) => ResearchDomain.Job) => this.store.mutate(projectId, fn)
      return mutate((state) => {
        const job = this.job(state, jobId)
        this.assertLease(state, job, leaseId)
        const now = this.now()
        const updated = ResearchDomain.Job.parse({
          ...job,
          heartbeatAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
          updatedAt: now,
        })
        state.jobs[jobId] = updated
        // A heartbeat changes only lease timestamps. Lifecycle/receipt projections
        // are committed by transitions, not recomputed from every scientific record.
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
        this.assertLease(state, job, leaseId)
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
        this.assertLease(state, job, leaseId)
        const now = this.now()
        const updated = ResearchDomain.Job.parse({
          ...job,
          status: "succeeded",
          result,
          recovery: undefined,
          completedAt: now,
          updatedAt: now,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          heartbeatAt: undefined,
        })
        state.jobs[jobId] = updated
        recordNativeJobLifecycle(state,updated,now)
        return updated
      })
    }

    async fail(projectId: string, jobId: string, leaseId: string, cause: unknown): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        if (job.status === "cancelled") return job
        this.assertLease(state, job, leaseId)
        const now = this.now()
        const structured = cause instanceof NamedError
          ? z.object({code:z.string().optional(),message:z.string()}).safeParse(cause.toObject().data) : undefined
        const details = structured?.success ? [structured.data.code,structured.data.message].filter(Boolean).join(": ")
          : cause instanceof Error ? cause.message : String(cause)
        const error = details.trim().slice(0, 4_000) || "Unknown job failure"
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
        recordNativeJobLifecycle(state,updated,now)
        return updated
      })
    }

    /** Verified original receipt recovery closes a failed/cancelled job without
     * reentering retry policy or authorizing another attempt. */
    async settleTerminal(projectId: string, jobId: string, leaseId: string,
      input: {status: "failed" | "cancelled"; result: Record<string, unknown>; error?: string}): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, state => {
        const job = this.job(state, jobId)
        this.assertLease(state, job, leaseId)
        const now = this.now()
        const updated = ResearchDomain.Job.parse({...job, status: input.status, result: input.result,
          error: input.error?.trim().slice(0, 4_000), recovery: undefined,
          ...(input.status === "cancelled" ? {cancelRequestedAt: job.cancelRequestedAt ?? now} : {}),
          completedAt: now, updatedAt: now, leaseId: undefined, leaseExpiresAt: undefined,
          heartbeatAt: undefined, nextAttemptAt: undefined})
        state.jobs[jobId] = updated
        recordNativeJobLifecycle(state, updated, now)
        if (input.status === "cancelled") cancelOperationsForJobs(state, new Set([jobId]), now)
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
        recordNativeJobLifecycle(state,updated,now)
        cancelOperationsForJobs(state,new Set([jobId]),now)
        return updated
      })
    }

    async retry(projectId: string, jobId: string): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, (state) => {
        const job = this.job(state, jobId)
        if(Object.values(state.operations).some(operation=>operation.jobId===jobId&&(operation.cancelledAt||operation.outcome!=="pending"||operation.settlement==="settled")))
          throw new ConflictError({code:"new_operation_required",message:"Cancelled or completed managed operations retain their original authority and receipts; enqueue a new explicit job and grant identity"})
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
        recordNativeJobLifecycle(state,updated,now)
        return updated
      })
    }

    /** Release this owner without inventing completion or spending a scientific retry.
     * Expiry permits a detach, never a renewed lease. A superseded owner is inert.
     */
    async interrupt(projectId: string, jobId: string, leaseId: string,
      input: Omit<ResearchDomain.JobRecovery, "originalLeaseId" | "recordedAt" | "accounting">,
    ): Promise<ResearchDomain.Job> {
      return this.store.mutate(projectId, state => {
        const job = this.job(state, jobId)
        if (job.status !== "running" || job.leaseId !== leaseId) return job
        return this.detach(state, job, input)
      })
    }

    private detach(state: ResearchState, job: ResearchDomain.Job,
      input: Omit<ResearchDomain.JobRecovery, "originalLeaseId" | "recordedAt" | "accounting">,
    ): ResearchDomain.Job {
      const now = this.now()
      const recovery = ResearchDomain.JobRecovery.parse({...input, detail: input.detail.slice(0,4000), originalLeaseId: job.leaseId!, recordedAt: now, accounting: "unsettled"})
      const resumable = ["shutdown", "lease_lost", "worker_crash"].includes(input.reason)
      const phase = `host:recovery:${job.leaseId}`
      const checkpoint = ResearchDomain.JobCheckpoint.parse({phase, data: recovery, completedAt: now})
      const updated = ResearchDomain.Job.parse({...job, status: resumable ? "interrupted" : "recovery_required", recovery,
        error: recovery.detail, completedAt: undefined, nextAttemptAt: undefined, leaseId: undefined, leaseExpiresAt: undefined,
        heartbeatAt: undefined, updatedAt: now, checkpoints: {...job.checkpoints, [phase]: checkpoint}})
      state.jobs[job.id] = updated
      recordNativeJobLifecycle(state,updated,now)
      return updated
    }

    async recover(projectId: string, recoverable?: Eligibility): Promise<void> {
      await this.store.mutate(projectId, (state) => this.recoverExpired(state, this.now(), recoverable))
    }

    private recoverExpired(state: ResearchState, now: string, recoverable?: Eligibility): void {
      for (const job of Object.values(state.jobs)) {
        if (job.status !== "running" || !job.leaseExpiresAt || job.leaseExpiresAt > now) continue
        if (recoverable && !recoverable(job, state)) continue
        // Pi resumes only its host-owned lifecycle protocol, never an arbitrary checkpoint.
        if (job.payload.runtime === "autofold-pi.v1") {
          const protocol = job.checkpoints["host:lifecycle:start"]?.data
          const native = job.checkpoints["pi:job:start"]?.data ?? job.checkpoints["campaign:job:start"]?.data
          const supported = protocol?.version === 1 && protocol.payloadHash === crypto.createHash("sha256").update(JSON.stringify(job.payload)).digest("hex") ||
            !protocol && typeof native?.deadlineMs === "number" && Number.isFinite(native.deadlineMs)
          this.detach(state, job, {reason: supported ? "worker_crash" : "unsupported_protocol",
            detail: supported ? "Worker lease expired; original effects must reconcile before continuation" : "Expired Pi job has no recognized recovery protocol; automatic execution is disabled"})
          continue
        }
        // Legacy job recovery remains scoped to its existing protocol.
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
        const validationCampaignId = payload.runtime === "autofold-pi.v1" && typeof payload.validationCampaignId === "string" ? payload.validationCampaignId : payload.campaignId
        if (!experiment || experiment.campaignId !== validationCampaignId) {
          throw new ConflictError({ code: "experiment_not_found", message: `Experiment ${payload.experimentId} is outside ${validationCampaignId}` })
        }
        const candidate = state.skillVersions[payload.candidateVersionId]
        if (!candidate || candidate.campaignId !== payload.campaignId || !candidate.parentVersionId) {
          throw new ConflictError({ code: "skill_candidate_not_found", message: `Candidate ${payload.candidateVersionId} is outside ${payload.campaignId}` })
        }
        if (candidate.status !== "candidate" && !candidate.replay) {
          throw new ConflictError({ code: "skill_not_replayable", message: `Skill ${candidate.id} is ${candidate.status}` })
        }
      }
      if ((payload.kind === "knowledge_refresh" || payload.kind === "knowledge_review" || payload.kind === "campaign_loop" || payload.kind === "capability_refinement") && !state.campaigns[payload.campaignId]) {
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

    private assertLease(state: Readonly<ResearchState>, job: ResearchDomain.Job, leaseId: string): void {
      if (!inspectOwnership(state, job, this.now(), leaseId).valid) {
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


