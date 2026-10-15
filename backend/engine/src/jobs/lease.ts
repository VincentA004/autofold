import type {ResearchDomain} from '@autofold/science-core/domain'
import type {ResearchJobService} from '@autofold/science-core/job-service'

export class JobInterrupted extends Error {
  constructor(readonly reason: 'cancelled' | 'shutdown' | 'lease_lost', detail?: string) {
    super(detail ?? `Pi job ${reason}`); this.name = 'JobInterrupted'
  }
}
export class JobRecoveryRequired extends Error {
  constructor(readonly reason: 'execution_unresolved' | 'child_unresolved' | 'accounting_unresolved', detail: string,
    readonly identity: {runId?: string; childJobId?: string} = {}) {
    super(detail); this.name = 'JobRecoveryRequired'
  }
}
/** One owner for liveness, cancellation and interruption. Lease loss never becomes success.
 * All commits retain the store's lease CAS; racing cancellation cannot grant authority to late work.
 */
export class JobLease {
  readonly controller = new AbortController()
  interruption?: JobInterrupted
  private heartbeat?: ReturnType<typeof setInterval>
  private poll?: ReturnType<typeof setInterval>
  private heartbeatWork?: Promise<void>
  private pollWork?: Promise<void>
  private shutdown = () => this.interrupt(this.input.signal?.reason instanceof JobInterrupted ? this.input.signal.reason.reason : 'shutdown')
  constructor(private readonly input: {jobs: ResearchJobService.Service; projectId: string; job: ResearchDomain.Job;
    leaseMs: number; heartbeatMs: number; cancelPollMs: number; signal?: AbortSignal; onInterrupt?: () => void}) {}
  start() {
    this.input.signal?.addEventListener('abort', this.shutdown, {once: true})
    if (this.input.signal?.aborted) this.shutdown()
    this.heartbeat = setInterval(() => {
      if (this.heartbeatWork || this.interruption) return
      this.heartbeatWork = this.check().then(() => this.input.jobs.heartbeat(this.input.projectId, this.input.job.id, this.input.job.leaseId!, this.input.leaseMs))
        .then(() => {}).catch(error => this.interrupt('lease_lost', `Job heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {this.heartbeatWork = undefined})
    }, this.input.heartbeatMs)
    this.poll = setInterval(() => {
      if (this.pollWork || this.interruption) return
      this.pollWork = this.check().then(() => {}).catch(error => {
        if (!this.interruption) this.interrupt('lease_lost', `Job ownership check failed: ${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => {this.pollWork = undefined})
    }, this.input.cancelPollMs)
    this.heartbeat.unref(); this.poll.unref()
  }
  interrupt(reason: JobInterrupted['reason'], detail?: string) {
    this.interruption ??= new JobInterrupted(reason, detail)
    this.controller.abort(this.interruption); this.input.onInterrupt?.()
  }
  async check(): Promise<ResearchDomain.Job> {
    if (this.input.signal?.aborted) this.shutdown()
    if (this.interruption) throw this.interruption
    const {job: current, ownership} = await this.input.jobs.checkOwnership(this.input.projectId, this.input.job.id, this.input.job.leaseId!)
    if (!ownership.valid) this.interrupt(ownership.reason === 'cancelled' ? 'cancelled' : 'lease_lost',
      ownership.reason === 'ancestor_lost' ? `Ancestor ${ownership.jobId} lost live job ownership` : undefined)
    if (this.interruption) throw this.interruption
    return current
  }
  /** Stop waiting even if an external handler ignores abort. Its late writes remain fenced. */
  async wait<T>(operation: Promise<T>): Promise<T> {
    const signal = this.controller.signal
    let stop: (() => void) | undefined
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(this.interruption ?? new JobInterrupted('shutdown'))
      signal.addEventListener('abort', stop, {once: true}); if (signal.aborted) stop()
    })
    try {return await Promise.race([operation, interrupted])}
    finally {if (stop) signal.removeEventListener('abort', stop)}
  }
  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.poll) clearInterval(this.poll)
    this.input.signal?.removeEventListener('abort', this.shutdown)
    await Promise.allSettled([this.heartbeatWork, this.pollWork].filter(Boolean))
  }
}
