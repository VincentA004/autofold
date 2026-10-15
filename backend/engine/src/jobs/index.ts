import {PiSessionHost,type SessionHostBaseline} from '../session-host'
import {scientistContextPolicy} from './scientist-context'
import {AuxiliaryProjectionPendingError} from '../operations/auxiliary-state'
import {OperationService} from '@autofold/science-core/operation-service'
import {cancelOperationsForJobs,operationHash} from '@autofold/science-core/operations'
import {planOriginalRecovery,type OperationSpec,type RecoveryContext,type RecoveryOutcome,type RecoveryPlan,type OperationSettlementPort} from './operation'
export type {OperationSpec,RecoveryContext,RecoveryOutcome,RecoveryPlan} from './operation'
import { KnowledgeReviewController, KnowledgeReviewInput, freezeKnowledgeReviewGraph } from '../knowledge-review-controller'
import { CapabilityRefinementController, SkillShadowReplayController, type CapabilityRefinementInput, type SkillShadowReplayInput } from "../skills"
import path from 'node:path'
import {assertNoAdmissionUsage, captureJobAccountingBaseline, readJobAccounting, readAccountingSession, type JobAccountingBaseline, type JobAccounting} from './accounting'
import { createHash } from 'node:crypto'
import z from 'zod'
import type { RuntimeTool } from '../runtime'
import { ResearchDomain } from '@autofold/science-core/domain'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchJobService } from '@autofold/science-core/job-service'
import type { ResearchStore, ResearchState } from '@autofold/science-core/store'
import { ScientificExecution, ReceiptUnresolvedError } from '../execution'
import {JobLease, JobInterrupted, JobRecoveryRequired} from './lease'
export {JobRecoveryRequired} from './lease'
import { LiteratureReviewController, type LiteratureReviewInput } from "../literature"
import { ScientistLane } from '../scientist'
import { DEFAULT_MODEL_SELECTION, MAX_TIMER_DURATION_MS, createAgentRuntime, createSessionStore, RuntimeSessionBusyError, resolveModel,
  type AgentRuntimeOptions, type AgentRuntime, type PiModelSelection, type PiSessionStore } from '../runtime'

export const PI_JOB_RUNTIME = 'autofold-pi.v1'
const ModelIdentity = z.object({ provider: z.string().trim().min(1), modelId: z.string().trim().min(1) })
const Payload = z.object({
  runtime: z.literal(PI_JOB_RUNTIME), kind: z.literal('autoresearch'), experimentId: z.string().startsWith('exp_'),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]+$/), iterations: z.number().int().min(1).max(100),
  contractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), modelSelection: ModelIdentity,
  modelBudgetUsd: z.number().finite().positive().max(1000),
  maximumDurationMs: z.number().int().positive().max(MAX_TIMER_DURATION_MS).optional(),
  // Historical payloads retain this field; it never partitions the Pi agent loop.
  authoringTimeMs: z.number().int().positive().max(MAX_TIMER_DURATION_MS).optional(),
  prompt: z.string().trim().min(1).max(16000).optional(),
  conversation: z.boolean().default(false),
  allowCompute: z.boolean().default(false),
  parentJobId: z.string().startsWith('job_').optional(),
}).passthrough()
type Payload = z.infer<typeof Payload>
const Allowance = z.object({maxCostUsd:z.number().finite().positive(),maxTurns:z.number().int().positive(),maxToolCalls:z.number().int().positive()})
const Baseline = z.object({ allowance:Allowance.optional(), completedEvaluations: z.number().int().nonnegative(), costUsd: z.number().finite().nonnegative(), deadlineMs: z.number().finite().positive() }).passthrough()

export interface DiscoveryJobInput {
  idempotencyKey: string
  iterations: number
  sessionId?: string
  modelSelection?: Pick<PiModelSelection, 'provider' | 'modelId'>
  modelBudgetUsd?: number
  maximumDurationMs?: number
  /** @deprecated New jobs reject this policy; use explicit runtime request/tool limits. */
  maximumAuthoringAttempts?: number
  /** @deprecated New jobs reject this policy; completed evaluations are not a repair-progress test. */
  maximumNoProgressAttempts?: number
  /** @deprecated Additional job time for old callers; prefer maximumDurationMs. */
  authoringTimeMs?: number
  parentJobId?: string
  parentLeaseId?: string
  prompt?: string
  conversation?: boolean
  allowCompute?: boolean
}
export interface ScientistJobStatus {
  completedEvaluations: number
  stopped: boolean
  researchRequested: boolean
  pending?: { trialId?: string; requestId: string; programHash: string; programPath: string; iteration: number }
}
export interface JobScientist {
  initialize(): Promise<void>
  status(): Promise<ScientistJobStatus>
  context(): Promise<unknown>
  tools(): RuntimeTool<any>[]
  readonly systemPrompt: string
  resources?():Promise<import('../runtime').RuntimeResources>
}
export interface PiJobControllerOptions {
  workspace: string
  projectId: string
  research: ResearchService.Service
  store: ResearchStore
  execution: ScientificExecution
  sessionDirectory: string
  runtimeOptions?: Omit<AgentRuntimeOptions, 'store' | 'tools' | 'modelSelection'>
  literature?: LiteratureReviewController
  /** Explicit host-owned persistence choice; existing stores are never implicitly migrated. */
  sessionStoreFactory?: (file:string)=>PiSessionStore & {close():void}
  runtimeFactory?: (options: AgentRuntimeOptions) => Pick<AgentRuntime, 'get' | 'create' | 'resume' | 'run' | 'cancel'>
  scientistFactory?: (options: ConstructorParameters<typeof ScientistLane>[0]) => JobScientist
  /** Host timing policy; never accepted from a queued job or model tool. */
  leaseMs?: number
  heartbeatMs?: number
  cancelPollMs?: number
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const PI_JOB_KINDS = new Set(['autoresearch', 'knowledge_refresh', 'knowledge_review', 'campaign_loop', 'capability_refinement', 'skill_shadow_replay'])
export const isPiJob = (candidate: ResearchDomain.Job) => PI_JOB_KINDS.has(candidate.payload.kind) && candidate.payload.runtime === PI_JOB_RUNTIME
export interface PiJobHandlerContext { job: ResearchDomain.Job; signal: AbortSignal; recoveryOnly?: boolean; lifecycle: { checkpoint(phase: string,data: unknown):Promise<unknown>; readCheckpoint(phase:string):Promise<any | undefined>; checkCancelled():Promise<unknown> }; controller: PiJobController }
export type PiJobHandler = (context: PiJobHandlerContext) => Promise<Record<string, unknown>>
export interface PiWorkerState {
  status: 'stopped' | 'running' | 'degraded'
  consecutiveFailures: number
  lastError?: string
  lastFailureAt?: string
  lastSuccessAt?: string
  nextPollAt?: string
  /** Per-job admission holds do not prevent unrelated campaign work. */
  continuationHolds?: Array<{jobId:string;error:string}>
}
const identityEqual = (a: { provider: string; modelId: string }, b: { provider: string; modelId: string }) => a.provider === b.provider && a.modelId === b.modelId

/** Durable jobs bind scientific scope and budgets; Pi owns generic model execution. */
export class PiJobController {
  private worker: PiWorkerState = {status:'stopped',consecutiveFailures:0}
  get workerState(): Readonly<PiWorkerState> { return {...this.worker} }
  private readonly specs = new Map<ResearchDomain.JobPayload["kind"],OperationSpec>()
  readonly operations: OperationService.Service
  private readonly handlers = new Map<ResearchDomain.JobPayload["kind"], PiJobHandler>()
  private readonly jobs: ResearchJobService.Service
  private readonly leaseMs: number
  private readonly heartbeatMs: number
  private readonly cancelPollMs: number
  constructor(private readonly options: PiJobControllerOptions) {
    if (!path.isAbsolute(options.workspace) || !path.isAbsolute(options.sessionDirectory) || !options.projectId.trim()) throw new Error('Pi jobs require explicit absolute workspace/session paths and a project identity')
    this.jobs = new ResearchJobService.Service(options.store)
    this.operations = new OperationService.Service(options.store)
    this.leaseMs = options.leaseMs ?? 30_000
    this.heartbeatMs = options.heartbeatMs ?? 10_000
    this.cancelPollMs = options.cancelPollMs ?? 250
    for (const value of [this.leaseMs, this.heartbeatMs, this.cancelPollMs]) if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DURATION_MS) throw new Error('Invalid Pi job timing policy')
    if (this.heartbeatMs * 2 >= this.leaseMs) throw new Error('Pi job heartbeat must be less than half its lease duration')
    const literature = options.literature ?? new LiteratureReviewController(options)
    this.registerHandler('knowledge_refresh', async ({job,signal,lifecycle}) => {
      if (job.payload.kind !== 'knowledge_refresh') throw new Error('Literature handler received another job kind')
      const state = await options.store.read(options.projectId)
      const frozen = job.payload.contracts as {id:string;contractHash:string}[] | undefined
      if (!frozen) throw new Error('Queued literature operation lacks frozen contract identity')
      for (const contract of frozen) { const experiment = state.experiments[contract.id]; if (!experiment || experiment.contractHash !== contract.contractHash) throw new Error('Queued literature contract changed'); ResearchDomain.assertContractIntegrity(experiment) }
      const result = await literature.run({ campaignId: job.payload.campaignId, jobId: job.id, sessionId: job.payload.sessionId,
        focusExperimentId: typeof job.payload.focusExperimentId === 'string' ? job.payload.focusExperimentId : undefined,
        question: job.payload.question, maxSources: job.payload.maxSources, maxClaims: job.payload.maxClaims,
        maxRequests: typeof job.payload.maxRequests === 'number' ? job.payload.maxRequests : undefined,
        modelBudgetUsd: typeof job.payload.modelBudgetUsd === 'number' ? job.payload.modelBudgetUsd : undefined,
        modelSelection: ModelIdentity.parse(job.payload.modelSelection),
      }, lifecycle, {signal,origin:{jobId:job.id,leaseId:job.leaseId!}})
      return {...result, runtime:PI_JOB_RUNTIME}
    })
    this.registerRecovery('knowledge_refresh',{inspect:async context=>this.inspectCanonicalJob(context.job),recover:context=>literature.recover(context.job,context.signal)})
  }
  registerHandler(kind: Exclude<ResearchDomain.JobPayload['kind'], 'autoresearch'>, handler: PiJobHandler) {
    if (this.handlers.has(kind)) throw new Error(`Pi job handler already registered: ${kind}`)
    this.handlers.set(kind, handler); return this
  }
  private async inspectCanonicalJob(job:ResearchDomain.Job) {
    const state=await this.options.store.read(this.options.projectId),records=Object.values(state.operations).filter(record=>record.jobId===job.id&&record.kind!=='native_job')
    return {effects:records.filter(record=>record.effect==='unknown').map(record=>record.id),accounting:records.filter(record=>record.accounting==='unknown').map(record=>record.id),blockers:[],phase:records.at(-1)?.phase??'legacy_receipt_inspection'}
  }
  registerOperation(kind: Exclude<ResearchDomain.JobPayload['kind'],'autoresearch'>, spec: OperationSpec) {
    if(this.specs.has(kind))throw new Error(`Operation recovery spec already registered: ${kind}`)
    this.specs.set(kind,spec);this.handlers.set(kind,spec.run);return this
  }
  registerRecovery(kind: Exclude<ResearchDomain.JobPayload['kind'],'autoresearch'>, ports: Pick<OperationSpec,'inspect'|'recover'>) {
    const run=this.handlers.get(kind);if(!run)throw new Error('Register the operation run port first')
    return this.registerOperation(kind,{...ports,run})
  }
  private settlementPort():OperationSettlementPort {
    const service=this.operations
    const assert=(handle:Parameters<OperationService.Service['update']>[0])=>{if(handle.mode!=='settle')throw new Error('Recovery only receives original settlement authority')}
    return {read:service.read.bind(service),events:service.events.bind(service),acquire:(projectId,id,input)=>service.acquire(projectId,id,{...input,mode:'settle'}),
      update:(handle,input)=>{assert(handle);return service.update(handle,input)},release:handle=>{assert(handle);return service.release(handle)},renew:(handle,leaseMs)=>{assert(handle);return service.renew(handle,leaseMs)},acknowledge:(handle,id,input)=>{assert(handle);return service.acknowledge(handle,id,input)}}
  }
  private recoveryContext(job:ResearchDomain.Job,signal:AbortSignal,checkpoint?:RecoveryContext['checkpoint']):RecoveryContext {
    return {job,signal,operations:this.settlementPort(),readCheckpoint:async phase=>(await this.get(job.id)).checkpoints[phase]?.data,checkpoint}
  }
  async enqueueJob(input: ResearchJobService.EnqueueInput, authorize?: (state:Readonly<ResearchState>)=>void) {
    if (!PI_JOB_KINDS.has(input.payload.kind)) throw new Error('Unrecognized Pi job kind')
    return this.jobs.enqueuePrepared(this.options.projectId,state=>{authorize?.(state);return {...input,payload:{...input.payload,runtime:PI_JOB_RUNTIME}}})
  }
  async enqueueLiterature(campaignId: string, input: Omit<LiteratureReviewInput,'campaignId'|'operationId'|'jobId'> & {idempotencyKey:string;parentJobId?:string;parentLeaseId?:string}) {
    const state = await this.options.store.read(this.options.projectId), campaign = state.campaigns[campaignId]
    if (!campaign || campaign.projectId !== this.options.projectId || campaign.status !== 'active') throw new Error('Literature requires an active campaign in this project')
    const contracts = Object.values(state.experiments).filter(experiment=>experiment.campaignId===campaignId).map(experiment=>{ResearchDomain.assertContractIntegrity(experiment);return {id:experiment.id,contractHash:experiment.contractHash}})
    if (input.focusExperimentId && !contracts.some(contract=>contract.id===input.focusExperimentId)) throw new Error('Literature focus is outside this campaign')
    const selection = ModelIdentity.parse(input.modelSelection ?? DEFAULT_MODEL_SELECTION); resolveModel(selection,this.options.runtimeOptions?.models)
    return this.enqueueJob({idempotencyKey:input.idempotencyKey,parentLeaseId:input.parentLeaseId,payload:{kind:'knowledge_refresh',campaignId,sessionId:input.sessionId??`ses_literature_${hash(this.options.projectId+':'+input.idempotencyKey)}`,
      question:input.question,maxSources:input.maxSources??10,maxClaims:input.maxClaims??10,maxRequests:input.maxRequests??10,modelBudgetUsd:input.modelBudgetUsd??2,
      modelSelection:selection,contracts,focusExperimentId:input.focusExperimentId,parentJobId:input.parentJobId}})
  }
  registerKnowledgeReview(controller: KnowledgeReviewController) {
    return this.registerHandler('knowledge_review', async ({job,signal,lifecycle}) => {
      if (job.payload.kind !== 'knowledge_review') throw new Error('Wrong knowledge review kind')
      const result = await controller.run({campaignId:job.payload.campaignId,jobId:job.id,sessionId:job.payload.sessionId,
        claimIds:job.payload.claimIds,alignmentIds:job.payload.alignmentIds,question:job.payload.question,maxRequests:job.payload.maxRequests,
        modelBudgetUsd:job.payload.modelBudgetUsd,modelSelection:ModelIdentity.parse(job.payload.modelSelection)},lifecycle,{signal,origin:{jobId:job.id,leaseId:job.leaseId!}})
      return {...result,runtime:PI_JOB_RUNTIME}
    }).registerRecovery('knowledge_review',{inspect:async context=>this.inspectCanonicalJob(context.job),recover:context=>controller.recover(context.job,context.signal)})
  }
  async enqueueKnowledgeReview(campaignId: string, input: Omit<KnowledgeReviewInput,'campaignId'|'jobId'|'sessionId'> & {idempotencyKey:string;sessionId?:string;parentJobId?:string;parentLeaseId?:string}) {
    const state = await this.options.store.read(this.options.projectId), campaign = state.campaigns[campaignId]
    if (!campaign || campaign.projectId !== this.options.projectId || campaign.status !== 'active') throw new Error('Knowledge review requires an active campaign')
    const selection = ModelIdentity.parse(input.modelSelection ?? DEFAULT_MODEL_SELECTION); resolveModel(selection,this.options.runtimeOptions?.models)
    const contracts = Object.values(state.experiments).filter(experiment=>experiment.campaignId===campaignId).map(experiment=>{ResearchDomain.assertContractIntegrity(experiment);return {id:experiment.id,contractHash:experiment.contractHash}})
    const claimIds = [...new Set(input.claimIds)], alignmentIds = [...new Set(input.alignmentIds ?? [])]
    for (const id of claimIds) if (state.claims[id]?.campaignId !== campaignId) throw new Error('Review claim is outside this campaign')
    for (const id of alignmentIds) if (state.alignments[id]?.campaignId !== campaignId) throw new Error('Review alignment is outside this campaign')
    if (claimIds.length + alignmentIds.length < 1) throw new Error('Knowledge review requires explicit targets')
    const reviewTargets = freezeKnowledgeReviewGraph(state, {campaignId,claimIds,alignmentIds}).records

    return this.enqueueJob({idempotencyKey:input.idempotencyKey,parentLeaseId:input.parentLeaseId,payload:{kind:'knowledge_review',campaignId,
      sessionId:input.sessionId ?? `ses_review_${hash(this.options.projectId+':'+input.idempotencyKey)}`,claimIds,alignmentIds,
      contracts,reviewTargets, question:input.question ?? 'Reconcile the frozen claims and observation alignments.',maxRequests:input.maxRequests ?? 50,
      modelBudgetUsd:input.modelBudgetUsd ?? 2,modelSelection:selection,parentJobId:input.parentJobId}})
  }
  registerSkills(controllers: {refinement: CapabilityRefinementController; replay: SkillShadowReplayController}) {
    this.registerHandler('capability_refinement', async ({job,signal,lifecycle}) => {
      if(job.payload.kind!=='capability_refinement')throw new Error('Wrong refinement kind')
      const state=await this.options.store.read(this.options.projectId),contracts=job.payload.contracts as {id:string;contractHash:string}[]|undefined
      if(!contracts)throw new Error('Queued refinement lacks frozen contracts')
      for(const frozen of contracts){const experiment=state.experiments[frozen.id];if(!experiment||experiment.contractHash!==frozen.contractHash)throw new Error('Queued refinement contract changed');ResearchDomain.assertContractIntegrity(experiment)}
      const result=await controllers.refinement.run({campaignId:job.payload.campaignId,skillId:job.payload.skillId,trajectoryRefs:job.payload.trajectoryRefs,jobId:job.id,
        modelBudgetUsd:typeof job.payload.modelBudgetUsd==='number'?job.payload.modelBudgetUsd:undefined,modelSelection:ModelIdentity.parse(job.payload.modelSelection)},lifecycle,{signal,origin:{jobId:job.id,leaseId:job.leaseId!}})
      return {version:result,modelCostUsd:result.modelCostUsd,runtime:PI_JOB_RUNTIME}
    })
    this.registerHandler('skill_shadow_replay', async ({job,signal,lifecycle}) => {
      if(job.payload.kind!=='skill_shadow_replay')throw new Error('Wrong replay kind')
      const experiment=(await this.options.store.read(this.options.projectId)).experiments[job.payload.experimentId]
      if(!experiment||experiment.contractHash!==job.payload.contractHash)throw new Error('Queued shadow contract changed')
      ResearchDomain.assertContractIntegrity(experiment)
      const result=await controllers.replay.run({campaignId:job.payload.campaignId,experimentId:job.payload.experimentId,candidateVersionId:job.payload.candidateVersionId,repetitions:job.payload.repetitions,jobId:job.id,
        validationCampaignId:typeof job.payload.validationCampaignId==='string'?job.payload.validationCampaignId:undefined,
        modelBudgetUsd:typeof job.payload.modelBudgetUsd==='number'?job.payload.modelBudgetUsd:undefined,modelSelection:ModelIdentity.parse(job.payload.modelSelection)},lifecycle,{signal,origin:{jobId:job.id,leaseId:job.leaseId!}})
      return {...result,runtime:PI_JOB_RUNTIME}
    })
    this.registerRecovery('capability_refinement',{inspect:async context=>this.inspectCanonicalJob(context.job),recover:context=>controllers.refinement.recover(context.job,context.signal)})
    this.registerRecovery('skill_shadow_replay',{inspect:async context=>this.inspectCanonicalJob(context.job),recover:context=>controllers.replay.recover(context.job,context.signal)})
    return this
  }
  async enqueueRefinement(input: CapabilityRefinementInput & {idempotencyKey:string;parentJobId?:string;parentLeaseId?:string}) {
    const state=await this.options.store.read(this.options.projectId),campaign=state.campaigns[input.campaignId]
    if(!campaign||campaign.projectId!==this.options.projectId||campaign.status!=='active')throw new Error('Refinement requires active campaign')
    const contracts=Object.values(state.experiments).filter(experiment=>experiment.campaignId===input.campaignId).map(experiment=>{ResearchDomain.assertContractIntegrity(experiment);return{id:experiment.id,contractHash:experiment.contractHash}})
    const selection=ModelIdentity.parse(input.modelSelection??DEFAULT_MODEL_SELECTION);resolveModel(selection,this.options.runtimeOptions?.models)
    return this.enqueueJob({idempotencyKey:input.idempotencyKey,parentLeaseId:input.parentLeaseId,payload:{contracts,kind:'capability_refinement',campaignId:input.campaignId,skillId:input.skillId,trajectoryRefs:input.trajectoryRefs,
      sessionId:`ses_refinement_${hash(this.options.projectId+':'+input.idempotencyKey)}`,modelSelection:selection,modelBudgetUsd:input.modelBudgetUsd??2,parentJobId:input.parentJobId}})
  }
  async enqueueShadowReplay(input: SkillShadowReplayInput & {idempotencyKey:string;parentJobId?:string;parentLeaseId?:string}) {
    const state=await this.options.store.read(this.options.projectId),experiment=state.experiments[input.experimentId],campaign=experiment&&state.campaigns[experiment.campaignId]
    if(!campaign||campaign.projectId!==this.options.projectId||campaign.id!==(input.validationCampaignId??input.campaignId)||campaign.status!=='active'||experiment?.status!=='active')throw new Error('Shadow replay requires active validation scope')
    ResearchDomain.assertContractIntegrity(experiment)
    const selection=ModelIdentity.parse(input.modelSelection??DEFAULT_MODEL_SELECTION);resolveModel(selection,this.options.runtimeOptions?.models)
    return this.enqueueJob({idempotencyKey:input.idempotencyKey,parentLeaseId:input.parentLeaseId,payload:{kind:'skill_shadow_replay',campaignId:input.campaignId,experimentId:input.experimentId,candidateVersionId:input.candidateVersionId,
      sessionId:`ses_shadow_${hash(this.options.projectId+':'+input.idempotencyKey)}`,agent:'biology',repetitions:input.repetitions??3,validationCampaignId:input.validationCampaignId,
      contractHash:experiment.contractHash,modelSelection:selection,modelBudgetUsd:input.modelBudgetUsd??2,parentJobId:input.parentJobId}})
  }
  async enqueueDiscovery(experimentId: string, input: DiscoveryJobInput) {
    const selection = ModelIdentity.parse(input.modelSelection ?? DEFAULT_MODEL_SELECTION)
    resolveModel(selection, this.options.runtimeOptions?.models)
    return this.jobs.enqueuePrepared(this.options.projectId, state => {
      const experiment = state.experiments[experimentId]
      if (!experiment) throw new Error(`Experiment ${experimentId} was not found in this project`)
      ResearchDomain.assertContractIntegrity(experiment)
      const replay = Object.values(state.jobs).some(job => job.idempotencyKey === input.idempotencyKey && isPiJob(job))
      if (!replay && experiment.status !== 'active') throw new Error(`Experiment must be active, currently ${experiment.status}`)
      if (!replay && (input.maximumAuthoringAttempts !== undefined || input.maximumNoProgressAttempts !== undefined))
        throw new Error('Authoring-attempt policies are retired; use maximumDurationMs, modelBudgetUsd and explicit runtime request/tool limits')
      const bound = experiment.piScientistSessionId
      if (bound !== undefined && typeof bound !== 'string') throw new Error('Experiment scientist session binding is invalid')
      const sessionId = input.sessionId ?? bound ?? `ses_scientist_${hash(`${this.options.projectId}:${experimentId}`)}`
      if (bound && sessionId !== bound) throw new Error('Experiment already belongs to another persistent Pi scientist session')
      const previousModel = experiment.piScientistModelSelection
      if (previousModel && !identityEqual(ModelIdentity.parse(previousModel), selection)) throw new Error('Persistent Pi scientist model identity cannot change')
      const result = Payload.parse({ runtime: PI_JOB_RUNTIME, kind: 'autoresearch', experimentId, sessionId, contractHash: experiment.contractHash,
        iterations: input.iterations, prompt:input.prompt,conversation:input.conversation??false,allowCompute:input.allowCompute??false,parentJobId:input.parentJobId, modelSelection: selection, modelBudgetUsd: input.modelBudgetUsd ?? 2,
        maximumDurationMs: input.maximumDurationMs ?? Math.min(MAX_TIMER_DURATION_MS,
          experiment.contract.budget.wallTimeMinutes * 60_000 * input.iterations + (input.authoringTimeMs ?? input.iterations * 300_000)),
      })
      experiment.piScientistSessionId = sessionId
      experiment.piScientistModelSelection = selection
      return {idempotencyKey: input.idempotencyKey, parentLeaseId: input.parentLeaseId, payload: {...result, agent: 'biology'}}
    })
  }
  async list() { return (await this.jobs.list(this.options.projectId)).filter(job => isPiJob(job)) }
  async get(jobId: string) {
    const job = await this.jobs.get(this.options.projectId, jobId)
    if (!isPiJob(job)) throw new Error(`Job ${jobId} is not owned by the Pi worker`)
    return job
  }
  async cancel(jobId: string) {
    await this.get(jobId)
    return this.options.store.mutate(this.options.projectId,state=>{
      const selected=new Set([jobId]);let changed=true
      while(changed){changed=false;for(const job of Object.values(state.jobs))if(isPiJob(job)&&!selected.has(job.id)&&
        [job.payload.parentJobId,job.payload.continuedFromJobId].some(id=>typeof id==='string'&&selected.has(id))){selected.add(job.id);changed=true}}
      const now=new Date().toISOString()
      for(const id of selected){const job=state.jobs[id];if(!job||['succeeded','failed','cancelled'].includes(job.status))continue
        state.jobs[id]=ResearchDomain.Job.parse({...job,status:'cancelled',cancelRequestedAt:now,completedAt:now,updatedAt:now,leaseId:undefined,leaseExpiresAt:undefined,heartbeatAt:undefined,nextAttemptAt:undefined})}
      cancelOperationsForJobs(state,selected,now)
      return state.jobs[jobId]
    })
  }
  async retry(jobId: string) { await this.get(jobId); return this.jobs.retry(this.options.projectId, jobId) }

  async runOnce(input: { signal?: AbortSignal;jobId?:string; recoveryOnly?:boolean } = {}): Promise<ResearchDomain.Job | undefined> {
    if (input.signal?.aborted) return undefined
    const recognized: ResearchJobService.Eligibility = candidate => isPiJob(candidate) && (candidate.payload.kind === 'autoresearch' || this.handlers.has(candidate.payload.kind))
    const experimentOf = (job: ResearchDomain.Job) => typeof job.payload.experimentId === 'string' ? job.payload.experimentId : typeof job.payload.focusExperimentId === 'string' ? job.payload.focusExperimentId : undefined
    const campaignOf = (job: ResearchDomain.Job, state: ResearchState) => typeof job.payload.validationCampaignId === 'string' ? job.payload.validationCampaignId : typeof job.payload.campaignId === 'string' ? job.payload.campaignId : state.experiments[experimentOf(job) ?? '']?.campaignId
    const pendingForeignExecution: ResearchJobService.Eligibility = (candidate, state) => {
      if (!['autoresearch','campaign_loop','skill_shadow_replay'].includes(candidate.payload.kind) || candidate.payload.conversation && !candidate.payload.allowCompute) return false
      return Object.values(state.runs).some(run => {
        if (!['queued','running'].includes(run.status)) return false
        const trial = state.trials[run.trialId], ownerId = trial?.origin?.jobId, other = ownerId && state.jobs[ownerId]
        if (!trial || ownerId === candidate.id || other && (other.payload.parentJobId === candidate.id || candidate.payload.parentJobId === other.id)) return false
        const experiment = experimentOf(candidate)
        return experiment ? trial.experimentId === experiment : state.experiments[trial.experimentId]?.campaignId === campaignOf(candidate, state)
      })
    }
    const claimed = await this.jobs.claim(this.options.projectId, this.leaseMs, {
      recoverable: candidate => recognized(candidate, {} as never) && (!input.jobId || candidate.id === input.jobId),
      reconcileJobId: input.recoveryOnly ? input.jobId : undefined,
      eligible: (candidate,state) => (!input.jobId||candidate.id===input.jobId) && recognized(candidate,state) && !pendingForeignExecution(candidate,state) && !Object.values(state.jobs).some(other=>{
        if (!['running','interrupted','recovery_required'].includes(other.status) || other.id === candidate.id || !isPiJob(other)) return false
        if (other.status !== 'running' && ['knowledge_refresh','knowledge_review'].includes(other.payload.kind)) return false
        if ((candidate.payload.parentJobId===other.id || other.payload.parentJobId===candidate.id) && (candidate.payload.kind==='campaign_loop'||other.payload.kind==='campaign_loop')) return false
        const a=experimentOf(candidate),b=experimentOf(other)
        return a&&b?a===b:campaignOf(candidate,state)!==undefined&&campaignOf(candidate,state)===campaignOf(other,state)
      }),
    })
    if (!claimed) return undefined
    const leaseId = claimed.leaseId!
    let sessionHost:PiSessionHost|undefined
    let sessionStore: (PiSessionStore & {close():void}) | undefined
    let runtimeWork: Promise<unknown> | undefined
    const waitRuntime = <T>(operation: Promise<T>) => {runtimeWork=operation; return owner.wait(operation)}
    const owner = new JobLease({jobs:this.jobs,projectId:this.options.projectId,job:claimed,leaseMs:this.leaseMs,
      heartbeatMs:this.heartbeatMs,cancelPollMs:this.cancelPollMs,signal:input.signal,onInterrupt:()=>sessionHost?.cancel()})
    const controller = owner.controller
    owner.start()
    const checkCancelled = () => owner.check()
    const checkpoint = async (phase: string, raw: unknown) => {
      const data = z.record(z.string(), z.unknown()).parse(raw)
      await checkCancelled()
      return this.jobs.checkpoint(this.options.projectId, claimed.id, leaseId, phase, data)
    }
    const readCheckpoint = async (phase: string) => (await checkCancelled()).checkpoints[phase]?.data
    let accountingBaseline: JobAccountingBaseline | undefined
    let recoveredResult:Record<string,unknown>|undefined
    const settleAccounting = async (result?: Record<string, unknown>) => {
      if (!accountingBaseline) return
      const prior = await readCheckpoint(`pi:accounting:settlement:${leaseId}`) as unknown as JobAccounting | undefined
      if (prior) return prior
      const current = await checkCancelled()
      const usage = await readJobAccounting(this.options, {...current, ...(result ? {result} : {})}, {baseline: accountingBaseline, ignoreSettlement: true})
      const state = await this.options.store.read(this.options.projectId)
      const actualTrials = Object.values(state.trials).filter(trial => trial.origin?.jobId === claimed.id).length
      const reported = result?.completedEvaluations
      if (reported !== undefined && (typeof reported !== 'number' || !Number.isInteger(reported) || reported < 0)) throw new Error('Pi job reported invalid trial consumption')
      const receipt = {...usage, consumedTrajectories: Math.max(actualTrials, typeof reported === 'number' ? reported : 0)}
      await checkpoint(`pi:accounting:settlement:${leaseId}`, receipt)
      return receipt
    }
    try {
      const payloadHash = hash(JSON.stringify(claimed.payload))
      const protocol = claimed.checkpoints['host:lifecycle:start']?.data
      if (protocol && (protocol.version !== 1 || protocol.payloadHash !== payloadHash)) throw new JobRecoveryRequired('execution_unresolved', 'Frozen recovery payload changed')
      const duration = claimed.payload.kind === 'autoresearch'
        ? Number(claimed.payload.maximumDurationMs ?? (Number(claimed.payload.authoringTimeMs ?? 300_000) + (await this.options.research.history(this.options.projectId, claimed.payload.experimentId)).experiment.contract.budget.wallTimeMinutes * 60_000 * claimed.payload.iterations))
        : Number(claimed.payload.maximumDurationMs ?? MAX_TIMER_DURATION_MS)
      const authorization = await this.options.store.read(this.options.projectId)
      const deadlines = [Number(protocol?.deadlineMs ?? claimed.checkpoints['pi:job:start']?.data.deadlineMs ?? claimed.checkpoints['campaign:job:start']?.data.deadlineMs ?? Date.parse(claimed.startedAt!) + Math.min(MAX_TIMER_DURATION_MS, duration))]
      const seen = new Set<string>()
      let bound: ResearchDomain.Job | undefined = claimed
      while (bound) {
        if (seen.has(bound.id)) throw new Error('Cyclic job authorization')
        seen.add(bound.id)
        for (const value of [bound.checkpoints['host:lifecycle:start']?.data.deadlineMs,bound.checkpoints['campaign:job:start']?.data.deadlineMs,bound.payload.originDeadlineMs]) if (typeof value === 'number') deadlines.push(value)
        bound = typeof bound.payload.parentJobId === 'string' ? authorization.jobs[bound.payload.parentJobId] : undefined
      }
      const deadlineMs = Math.min(...deadlines)
      if (!Number.isFinite(deadlineMs)) throw new Error('Recovery deadline is invalid')
      await checkpoint('host:lifecycle:start', protocol ?? {version:1,payloadHash,deadlineMs})
      if (claimed.payload.kind !== 'campaign_loop') {
        await checkCancelled()
        accountingBaseline = await captureJobAccountingBaseline(this.options, claimed)
        await checkpoint('pi:accounting:start', accountingBaseline)
        await checkpoint(`pi:accounting:lease:${leaseId}`, {jobId: claimed.id, leaseId})
      }
      // Original effects settle before any agent/session initialization or provider call.
      await owner.wait(this.options.execution.reconcileOwnedEffects(claimed, controller.signal))
      if (input.recoveryOnly && claimed.payload.kind !== 'autoresearch') {
        const children = Object.values((await this.options.store.read(this.options.projectId)).jobs).filter(job=>job.payload.parentJobId===claimed.id)
        const resumable:string[]=[]
        let childBillingKnown=true
        for (const child of children) {
          const inspected = (['interrupted','recovery_required'].includes(child.status) || child.status === 'running' && !!child.leaseExpiresAt && Date.parse(child.leaseExpiresAt) <= Date.now()) ? await this.reconcile(child.id, controller.signal) : child
          if(inspected.status==='cancelled') {
            const settled=await owner.wait(this.settleCancelled(inspected,controller.signal))
            if(settled.kind!=='complete')throw new JobRecoveryRequired(settled.kind==='unresolved'&&settled.accounting.length?'accounting_unresolved':'child_unresolved',settled.kind==='unresolved'?settled.blockers.join('; '):settled.boundary,{childJobId:child.id})
            if(inspected.attempts>0&&settled.kind==='complete'&&(settled.result.providerAccounting as JobAccounting['providerAccounting'])?.status!=='reported')childBillingKnown=false
          } else if(['succeeded','failed'].includes(inspected.status)) {
            await owner.wait(this.options.execution.reconcileOwnedEffects(inspected,controller.signal))
            const accounting=await readJobAccounting(this.options,inspected)
            if(accounting.providerAccounting?.status!=='reported')childBillingKnown=false
          }
          if (!['succeeded','failed','cancelled'].includes(inspected.status)) {
            const current=await this.options.store.read(this.options.projectId),original=current.jobs[child.id]!
            const recoveryLease=original.recovery?.originalLeaseId
            const ready=original.checkpoints['pi:recovery:resumable']?.data
            const receipt=recoveryLease?original.checkpoints[`pi:accounting:settlement:${recoveryLease}`]?.data:undefined
            const native=current.operations[`op_job_${child.id.slice(4)}`]
            const campaign=current.campaigns[String(claimed.payload.campaignId)],experiment=current.experiments[String(original.payload.experimentId)]
            const effects=Object.values(current.operations).filter(record=>record.jobId===child.id&&record.kind!=='native_job')
            if(original.status==='interrupted'&&original.recovery?.reason==='shutdown'&&ready?.leaseId===recoveryLease&&ready.payloadHash===hash(JSON.stringify(original.payload))&&ready.baselineHash===operationHash(original.checkpoints['pi:job:start']?.data)&&receipt?.jobId===child.id&&
              (receipt.providerAccounting as JobAccounting['providerAccounting'])?.status==='reported'&&native&&native.projectId===this.options.projectId&&native.jobId===child.id&&native.kind==='native_job'&&native.identity.jobId===child.id&&!native.cancelledAt&&native.identity.payloadHash===operationHash(original.payload)&&native.grant.payloadHash===operationHash(original.payload)&&
              effects.every(record=>['none','settled'].includes(record.effect)&&record.accounting==='settled'&&record.settlement==='settled')&&campaign?.status==='active'&&experiment?.status==='active'&&experiment.campaignId===campaign.id){
              resumable.push(child.id)
              continue
            }
            throw new JobRecoveryRequired('child_unresolved', `Owned child ${child.id} still needs recovery`, {childJobId:child.id})
          }
        }
        if(resumable.length){
          if(resumable.length!==1||!childBillingKnown)throw new JobRecoveryRequired('child_unresolved','Original child continuation is ambiguous or sibling billing remains unknown')
          // Inspect every sibling before releasing the SAME original parent grant.
          await checkCancelled()
          throw new JobInterrupted('shutdown','Original child receipts settled; original grant remains resumable')
        }
        if (this.specs.has(claimed.payload.kind) || !await readCheckpoint('pi:job:result') && claimed.payload.kind !== 'campaign_loop') {
          const spec=this.specs.get(claimed.payload.kind)
          if(!spec)throw new JobRecoveryRequired('execution_unresolved','Original operation has no typed receipt recovery port')
          const outcome=await owner.wait(spec.recover(this.recoveryContext(claimed,controller.signal,checkpoint)))
          if(outcome.kind==='complete'){
            recoveredResult=outcome.result
            const resultHash=hash(JSON.stringify(outcome.result))
            await checkpoint(`host:receipt-recovery:${hash(JSON.stringify({receiptIds:outcome.receiptIds,result:outcome.result}))}`,{receiptIds:outcome.receiptIds,payloadHash:hash(JSON.stringify(claimed.payload)),resultHash})
            if(outcome.terminalStatus)await checkpoint('host:receipt-terminal',{status:outcome.terminalStatus,error:outcome.error,receiptIds:outcome.receiptIds,resultHash})
            if(!await readCheckpoint('pi:job:result'))await checkpoint('pi:job:result',outcome.result)
          }
          else if(outcome.kind==='incomplete')throw new JobInterrupted('shutdown',outcome.boundary)
          else throw new JobRecoveryRequired(outcome.accounting.length?'accounting_unresolved':'execution_unresolved',outcome.blockers.join('; ')||'Original operation receipts remain unresolved')
        }
      }
      const savedResult = recoveredResult ?? await readCheckpoint('pi:job:result')
      if (savedResult) {
        const accounting = await settleAccounting(savedResult)
        const result=accounting ? {...savedResult,modelCostUsd:accounting.modelCostUsd,providerAccounting:savedResult.providerAccounting??accounting.providerAccounting,consumedTrajectories:accounting.consumedTrajectories} : savedResult
        const terminal=await readCheckpoint('host:receipt-terminal')
        if(terminal){
          if(!['failed','cancelled'].includes(String(terminal.status))||terminal.resultHash!==hash(JSON.stringify(savedResult)))throw new JobRecoveryRequired('execution_unresolved','Original terminal receipt differs from the recovered result')
          return this.jobs.settleTerminal(this.options.projectId,claimed.id,leaseId,{status:terminal.status as 'failed'|'cancelled',result,error:typeof terminal.error==='string'?terminal.error:undefined})
        }
        return this.jobs.succeed(this.options.projectId, claimed.id, leaseId, result)
      }
      if (claimed.payload.kind !== 'autoresearch') {
        const handler=this.handlers.get(claimed.payload.kind); if (!handler) throw new Error('Pi job kind has no host handler')
        const rawResult=await owner.wait(handler({job:claimed,signal:controller.signal,recoveryOnly:input.recoveryOnly,lifecycle:{checkpoint,readCheckpoint,checkCancelled},controller:this}))
        const accounting = await settleAccounting(rawResult)
        const result = accounting ? {...rawResult, modelCostUsd: accounting.modelCostUsd, providerAccounting: rawResult.providerAccounting ?? accounting.providerAccounting, consumedTrajectories: accounting.consumedTrajectories} : rawResult
        await checkpoint('pi:job:result',rawResult); await checkCancelled()
        return this.jobs.succeed(this.options.projectId,claimed.id,leaseId,result)
      }
      const payload = Payload.parse(claimed.payload)
      const state = await this.options.store.read(this.options.projectId)
      const experiment = state.experiments[payload.experimentId]
      if (!experiment) throw new Error('Queued experiment no longer exists')
      ResearchDomain.assertContractIntegrity(experiment)
      if (experiment.contractHash !== payload.contractHash) throw new Error('Queued scientific contract does not match the frozen experiment')
      if (experiment.piScientistSessionId !== payload.sessionId) throw new Error('Queued session does not match the persistent experiment scientist')
      if (experiment.piScientistModelSelection && !identityEqual(ModelIdentity.parse(experiment.piScientistModelSelection), payload.modelSelection)) throw new Error('Queued model identity does not match the persistent experiment scientist')
      const makeLane = (maximumEvaluations: number, evaluationBaseline?: number) => (this.options.scientistFactory ?? (options => new ScientistLane(options)))({
        workspace: this.options.workspace, projectId: this.options.projectId, experimentId: payload.experimentId, sessionId: payload.sessionId,
        research: this.options.research, store: this.options.store, execution: this.options.execution, maximumEvaluations, evaluationBaseline,
        origin: { jobId: claimed.id, leaseId }, signal: controller.signal,allowCompute: (!payload.conversation||payload.allowCompute) && (Number(deadlineMs)>Date.now() || input.recoveryOnly===true),
        lifecycle: { checkpoint, readCheckpoint, checkCancelled },
      })
      // Reading the lane register is effect-free; pending evaluations reconcile only in initialize().
      const initialLane = makeLane(Number.MAX_SAFE_INTEGER)
      const pending = (await initialLane.status()).pending
      if ((input.recoveryOnly || claimed.recoveryCount > 0) && pending && (!pending.trialId || !(await this.options.research.history(this.options.projectId,payload.experimentId)).runs.some(run=>run.trialId===pending.trialId && ['succeeded','failed','cancelled'].includes(run.status)))) throw new JobRecoveryRequired('execution_unresolved', 'Prepared scientist intent has no receipt-bound run; recovery cannot dispatch it')
      if (!payload.conversation || payload.allowCompute) await owner.wait(this.options.execution.preflightExperiment(experiment, controller.signal))
      resolveModel(payload.modelSelection, this.options.runtimeOptions?.models)
      sessionStore = (this.options.sessionStoreFactory??createSessionStore)(path.join(this.options.sessionDirectory, 'sessions.sqlite'))
      const factory = this.options.runtimeFactory ?? createAgentRuntime
      const makeHost=(lane:JobScientist)=>new PiSessionHost({store:sessionStore!,runtimeFactory:factory,sessionId:payload.sessionId,
        metadata:{projectId:this.options.projectId,experimentId:payload.experimentId,contractHash:payload.contractHash},
        modelSelection:payload.modelSelection,operationId:'op_job_'+claimed.id.slice(4),jobId:claimed.id,inputHash:'sha256:'+payloadHash,signal:controller.signal,
        runtimeOptions:{...this.options.runtimeOptions,contextPolicy:scientistContextPolicy(this.options.runtimeOptions?.contextPolicy),tools:lane.tools().map(tool=>payload.conversation&&!payload.allowCompute&&tool.name==='evaluate_trial'?{...tool,execute:async()=>{throw new Error('This conversation has no compute authorization')}}:tool),systemPrompt:lane.systemPrompt,resources:lane.resources?.bind(lane),stopToolNames:['stop_discovery']},
        checkNewWork:async signal=>{await checkCancelled();await this.options.research.assertTrustedJobLease(this.options.projectId,{jobId:claimed.id,leaseId},{newWork:true});
          const authority=await this.options.store.read(this.options.projectId),boundExperiment=authority.experiments[payload.experimentId]
          if(!boundExperiment||boundExperiment.status!=='active'||authority.campaigns[boundExperiment.campaignId]?.status!=='active')throw new JobRecoveryRequired('execution_unresolved','Scientific campaign or experiment is no longer active')
          signal.throwIfAborted()}})
      const savedBaseline = await readCheckpoint('pi:job:start')
      let baseline=savedBaseline===undefined?undefined:Baseline.parse(savedBaseline) as SessionHostBaseline&{completedEvaluations:number;allowance?:z.infer<typeof Allowance>}
      const configuredAllowance=Allowance.parse({maxCostUsd:Math.min(payload.modelBudgetUsd,this.options.runtimeOptions?.limits?.maxCostUsd??payload.modelBudgetUsd),
        maxTurns:this.options.runtimeOptions?.limits?.maxTurns??Number.MAX_SAFE_INTEGER,maxToolCalls:this.options.runtimeOptions?.limits?.maxToolCalls??Number.MAX_SAFE_INTEGER})
      sessionHost=makeHost(initialLane)
      let session=await sessionHost.open({receiptOnly:input.recoveryOnly})
      if(!baseline){
        if(input.recoveryOnly)throw new JobRecoveryRequired('accounting_unresolved','Original scientist allowance baseline is missing; receipt recovery cannot create it')
        const initial=await initialLane.status()
        baseline={...sessionHost.baseline(session,Math.max(1,deadlineMs-Date.now()),deadlineMs),completedEvaluations:initial.completedEvaluations,allowance:configuredAllowance}
        await checkpoint('pi:job:start',baseline)
      }
      sessionHost.usage(session,baseline)
      const allowance=baseline.allowance?{maxCostUsd:Math.min(configuredAllowance.maxCostUsd,baseline.allowance.maxCostUsd),
        maxTurns:Math.min(configuredAllowance.maxTurns,baseline.allowance.maxTurns),maxToolCalls:Math.min(configuredAllowance.maxToolCalls,baseline.allowance.maxToolCalls)}:configuredAllowance
      const lane = makeLane(baseline.completedEvaluations + (payload.conversation ? (payload.allowCompute ? 1 : 0) : payload.iterations), baseline.completedEvaluations)
      await checkCancelled()
      await owner.wait(lane.initialize())
      sessionHost=makeHost(lane)
      if(!input.recoveryOnly)session=await sessionHost.open()
      let status = await lane.status()
      const attempts = Object.keys((await checkCancelled()).checkpoints).filter(phase => /^pi:turn:\d+:intent$/.test(phase)).length
      let attempt = attempts
      let reason = 'iteration_limit_reached'
      if(input.recoveryOnly) {
        status = await lane.status()
        if (status.pending) throw new JobRecoveryRequired('execution_unresolved', 'Scientific effects remain unresolved')
        if (status.completedEvaluations - baseline.completedEvaluations < payload.iterations && !status.stopped) {
          const authority=await this.options.store.read(this.options.projectId),boundExperiment=authority.experiments[payload.experimentId]
          // Closing an already expired/revoked grant observes facts only. It does
          // not require inventing missing historical limits or provider charges.
          if(boundExperiment?.status!=='active'||authority.campaigns[boundExperiment.campaignId]?.status!=='active')reason='experiment_not_active'
          else if(Date.now()>=Math.min(baseline.deadlineMs,deadlineMs))reason='job_deadline_reached'
          else {
            if(!baseline.allowance||baseline.turns===undefined||baseline.toolCalls===undefined)throw new JobRecoveryRequired('accounting_unresolved','Original scientist ceilings are missing; unfinished receipt recovery cannot mint a replacement grant')
            const accounting=await settleAccounting({completedEvaluations:status.completedEvaluations-baseline.completedEvaluations})
            if(accounting?.providerAccounting?.status!=='reported')throw new JobRecoveryRequired('accounting_unresolved','Original provider billing remains unknown; unfinished discovery cannot resume')
            const usage=sessionHost.usage(session,baseline)
            if(usage.costUsd>=allowance.maxCostUsd||accounting.providerAccounting.reportedCostUsd!>=allowance.maxCostUsd)reason='model_budget_exhausted'
            else if(usage.turns!>=allowance.maxTurns||usage.toolCalls!>=allowance.maxToolCalls)reason='runtime_limit_reached'
            else {
              await checkpoint('pi:recovery:resumable',{leaseId,payloadHash,baselineHash:operationHash(baseline)})
              throw new JobInterrupted('shutdown','Original receipts settled; original scientist grant remains resumable')
            }
          }
        }
      }
      let resumedReportedCost:number|undefined
      const remainingAuthority=await this.options.store.read(this.options.projectId),remainingExperiment=remainingAuthority.experiments[payload.experimentId]
      const activeGrant=remainingExperiment?.status==='active'&&remainingAuthority.campaigns[remainingExperiment.campaignId]?.status==='active'&&Date.now()<Math.min(baseline.deadlineMs,deadlineMs)
      if(!input.recoveryOnly&&savedBaseline&&activeGrant&&status.completedEvaluations-baseline.completedEvaluations<payload.iterations&&!status.stopped){
        if(!baseline.allowance||baseline.turns===undefined||baseline.toolCalls===undefined)throw new JobRecoveryRequired('accounting_unresolved','Original scientist ceilings are missing; unfinished discovery cannot resume')
        if(claimed.recoveryCount>0){const accounting=await readJobAccounting(this.options,await checkCancelled(),{ignoreSettlement:true});if(accounting.providerAccounting?.status!=='reported')throw new JobRecoveryRequired('accounting_unresolved','Original provider billing remains unknown; unfinished discovery cannot resume');resumedReportedCost=accounting.providerAccounting.reportedCostUsd!}
      }
      if(payload.conversation && !input.recoveryOnly){
        const settled=await readCheckpoint('pi:conversation:result')
        if(!settled){
          const prompt=payload.prompt??'Inspect the saved scientific context and explain the current evidence and next decision.'
          await checkpoint('pi:conversation:intent',{prompt,allowCompute:payload.allowCompute})
          const turn=await waitRuntime(sessionHost.run(prompt,sessionHost.remaining(session,baseline,allowance,deadlineMs),{signal:controller.signal,...(payload.prompt?{}:{promptOrigin:'host_context' as const})}))
          await checkCancelled();if(turn.status==='failed'||turn.status==='cancelled')throw new Error(turn.error??'Conversation turn failed')
          await checkpoint('pi:conversation:result',{runtimeStatus:turn.status,cumulativeModelCostUsd:turn.session.usage.costUsd})
        }
        status=await lane.status();reason='conversation_completed'
      }
      // Pi owns scientific work. A finished assistant response is not a completed job:
      // the host continues within the same cumulative grant until science or a host bound settles it.
      while (!input.recoveryOnly && !payload.conversation && (status.completedEvaluations - baseline.completedEvaluations < payload.iterations && !status.stopped)) {
        await checkCancelled()
        if (status.pending) throw new JobRecoveryRequired('execution_unresolved', 'Scientific execution remains unresolved; reconcile the original request before another model action')
        if (experiment.status !== 'active') reason = 'experiment_not_active'
        const currentExperiment = (await this.options.store.read(this.options.projectId)).experiments[payload.experimentId]
        if (!currentExperiment || currentExperiment.contractHash !== payload.contractHash) throw new Error('Frozen experiment contract changed during discovery')
        ResearchDomain.assertContractIntegrity(currentExperiment)
        if (currentExperiment.status !== 'active'||(await this.options.store.read(this.options.projectId)).campaigns[currentExperiment.campaignId]?.status!=='active') reason = 'experiment_not_active'
        session = (await sessionHost.get())!
        const usage=sessionHost.usage(session,baseline),spent=usage.costUsd
        const remainingCost = allowance.maxCostUsd - spent
        if (remainingCost <= 0 || resumedReportedCost!==undefined&&resumedReportedCost>=allowance.maxCostUsd) reason = 'model_budget_exhausted'
        const remainingTime = Math.min(MAX_TIMER_DURATION_MS, Math.floor(Math.min(baseline.deadlineMs, deadlineMs) - Date.now()))
        if (remainingTime <= 0) reason = 'job_deadline_reached'
        if ((usage.turns??0)>=allowance.maxTurns || (usage.toolCalls??0)>=allowance.maxToolCalls) reason='runtime_limit_reached'
        if(reason!=='iteration_limit_reached')break
        if (reason === 'iteration_limit_reached') {
          const before = status.completedEvaluations
          const phase = `pi:turn:${++attempt}`
          const continuation = `Continue discovery for the bound experiment using the saved workspace and trusted evidence. This job authorizes at most ${payload.iterations - (status.completedEvaluations - baseline.completedEvaluations)} more empirical evaluations. This is the remaining allowance for the current job; cumulative evaluation counts and earlier job iteration limits do not exhaust it. Read read_context.budgets for current job, per-trial and campaign bounds. Exhausting this batch automatically returns control to the host, which can renew residual parent authorization; never call stop_discovery for an allowance boundary. Normal assistant prose completion does not settle this job; the host continues using the same cumulative model, turn, tool and time limits. Keep the frozen objective and evidence-grounded scientific stop conditions; remaining slots do not require spending compute without justification. Inspect the current context, reconcile the latest result, then choose a concrete next intervention or a typed evidence-supported scientific stop. Record research questions as advisory work for a separate process; they never require yielding this discovery job. Validation and repair consume model effort, not an empirical slot. Never repeat an unresolved execution request.`
          const prompt=continuation
          await checkpoint(`${phase}:intent`, { prompt, completedEvaluations: before, cumulativeModelCostUsd: session.usage.costUsd, remainingModelBudgetUsd: remainingCost })
          const result=await waitRuntime(sessionHost.run(prompt,sessionHost.remaining(session,baseline,allowance,deadlineMs),{signal:controller.signal,promptOrigin:'host_context',...(payload.prompt?{exactInstructions:[{id:claimed.id+':human_prompt',text:payload.prompt}]}:{})}))
          await checkCancelled()
          session = result.session
          status = await lane.status()
          if (status.pending) throw new JobRecoveryRequired('execution_unresolved', result.error ?? 'Scientific execution has an unresolved original request')
          const consumed=sessionHost.usage(session,baseline).costUsd
          await checkpoint(`${phase}:result`, { runtimeStatus: result.status, completedEvaluations: status.completedEvaluations,
            cumulativeModelCostUsd: session.usage.costUsd, modelCostUsd: consumed, remainingModelBudgetUsd: Math.max(0, payload.modelBudgetUsd - consumed) })
          if (!status.stopped && status.completedEvaluations - baseline.completedEvaluations < payload.iterations) {
            if (result.status === 'failed') throw new Error(result.error ?? 'Pi model execution failed')
            if (result.status === 'cancelled') throw new Error(result.error ?? 'Pi model execution cancelled without a job cancellation')
            if(result.status==='limit_reached'){
              reason=consumed>=payload.modelBudgetUsd?'model_budget_exhausted':Date.now()>=Math.min(baseline.deadlineMs,deadlineMs)?'job_deadline_reached':'runtime_limit_reached'
              break
            }
          }
        }
      }
      await checkCancelled()
      if (status.stopped) reason = 'scientist_stopped'
      const finalSession = await sessionHost.get()
      let result = { providerAccounting: undefined as JobAccounting['providerAccounting'], runtime: PI_JOB_RUNTIME, reason, sessionId: payload.sessionId, contractHash: payload.contractHash,
        completedEvaluations: status.completedEvaluations - baseline.completedEvaluations, scientist: status,
        modelCostUsd: sessionHost.usage(finalSession??session,baseline).costUsd, modelBudgetUsd: payload.modelBudgetUsd,
      }
      const accounting = await settleAccounting(result)
      if (accounting) result = {...result, modelCostUsd: accounting.modelCostUsd, providerAccounting: accounting.providerAccounting}
      const settledResult = {...result, consumedTrajectories: accounting?.consumedTrajectories ?? result.completedEvaluations}
      await checkpoint('pi:job:result', result)
      await checkCancelled()
      return await this.jobs.succeed(this.options.projectId, claimed.id, leaseId, settledResult)
    } catch (error) {
      const interruption = owner.interruption ?? (error instanceof JobInterrupted ? error : undefined)
      if (interruption) {
        if (interruption.reason === 'cancelled') return this.jobs.get(this.options.projectId, claimed.id)
        return this.jobs.interrupt(this.options.projectId, claimed.id, leaseId, {reason:interruption.reason,detail:interruption.message})
      }
      const recovery = error instanceof AuxiliaryProjectionPendingError ? new JobRecoveryRequired('execution_unresolved',error.message) : error instanceof RuntimeSessionBusyError ? new JobRecoveryRequired('accounting_unresolved', error.message) : error instanceof Error && error.message.startsWith('Model accounting unavailable:')
        ? new JobRecoveryRequired('accounting_unresolved', error.message) : error instanceof ReceiptUnresolvedError
        ? new JobRecoveryRequired('execution_unresolved', error.message, {runId:error.runId}) : error instanceof JobRecoveryRequired ? error : undefined
      if (recovery) return this.jobs.interrupt(this.options.projectId, claimed.id, leaseId, {reason:recovery.reason,detail:recovery.message,...recovery.identity})
      try { await checkCancelled() } catch {
        return this.jobs.interrupt(this.options.projectId, claimed.id, leaseId, {reason:'lease_lost',detail:'Controller lost ownership before final settlement'})
      }
      try {await settleAccounting()} catch (accountingError) {
        return this.jobs.interrupt(this.options.projectId, claimed.id, leaseId, {reason:'accounting_unresolved',detail:`${error instanceof Error ? error.message : String(error)}; ${accountingError instanceof Error ? accountingError.message : String(accountingError)}`})
      }
      return this.jobs.fail(this.options.projectId, claimed.id, leaseId, error)
    } finally {
      await owner.close()
      // Abort detaches job authority promptly, while the SDK still must finish its
      // transcript journal and release its independent session lease. Keep SQLite
      // alive for that cleanup; an uncooperative tool cannot block shutdown forever.
      if (runtimeWork && sessionStore) {
        const store = sessionStore
        const closed = runtimeWork.then(()=>store.close(),()=>store.close())
        let timer: ReturnType<typeof setTimeout> | undefined
        try {await Promise.race([closed,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000)})])}
        finally {if(timer)clearTimeout(timer)}
      } else sessionStore?.close()
    }
  }
  /** Recover the original ownership tree, then return the job the caller selected.
   * An expired ancestor must own its children before any original receipt can settle.
   * This operation never authorizes another provider turn, staging or dispatch.
   */
  async planRecovery(jobId:string):Promise<RecoveryPlan> {
    await this.get(jobId)
    const state=await this.options.store.read(this.options.projectId),plan=planOriginalRecovery(state,jobId),signal=new AbortController().signal
    if(plan.blockers.length)return plan
    for(const id of plan.orderedJobIds){const job=state.jobs[id]!,spec=this.specs.get(job.payload.kind)
      if(!spec)continue
      const inspection=await spec.inspect(this.recoveryContext(job,signal))
      for(const detail of inspection.blockers)plan.blockers.push({jobId:id,code:'receipt_inspection_blocker',detail})
      for(const effect of inspection.effects)plan.blockers.push({jobId:id,code:'effect_observation_pending',detail:effect})
      for(const accounting of inspection.accounting)plan.blockers.push({jobId:id,code:'accounting_observation_pending',detail:accounting})
    }
    return plan
  }
  private async settleCancelled(job:ResearchDomain.Job,signal:AbortSignal):Promise<RecoveryOutcome> {
    const id=`op_job_${job.id.slice(4)}`,existing=await this.operations.read(this.options.projectId,id)
    if(existing?.settlement==='settled')return {kind:'complete',result:existing.state.result as Record<string,unknown>??{},receiptIds:existing.state.receiptIds as string[]??[]}
    // Explicit legacy cancellation inspection may collect original receipts, but never creates historical canonical state.
    const handle=existing?await this.operations.acquire(this.options.projectId,id,{mode:'settle',leaseMs:this.leaseMs}):undefined
    try {
      signal.throwIfAborted()
      await this.options.execution.reconcileOwnedEffects(job,signal)
      const spec=this.specs.get(job.payload.kind)
      const native=job.checkpoints['pi:job:result']?.data
      let outcome:RecoveryOutcome
      if(job.attempts===0){await assertNoAdmissionUsage(this.options,job);outcome={kind:'complete',result:{reason:'cancelled_before_admission',modelCostUsd:0,consumedTrajectories:0},receiptIds:[]}}
      else if(spec)outcome=await spec.recover(this.recoveryContext(job,signal))
      else if(native){const accounting=await readJobAccounting(this.options,{...job,result:native});outcome={kind:'complete',result:{...native,...accounting},receiptIds:[]}}
      else if(job.payload.kind==='autoresearch') {
        const state=await this.options.store.read(this.options.projectId),runs=Object.values(state.runs).filter(run=>state.trials[run.trialId]?.origin?.jobId===job.id)
        if(runs.some(run=>!['succeeded','failed','cancelled'].includes(run.status)))outcome={kind:'unresolved',effects:runs.filter(run=>!['succeeded','failed','cancelled'].includes(run.status)).map(run=>run.id),accounting:[],blockers:['Original cancelled scientific effects remain unresolved']}
        else {const accounting=await readJobAccounting(this.options,job);outcome={kind:'complete',result:{reason:'cancelled_effects_settled',...accounting,consumedTrajectories:Object.values(state.trials).filter(trial=>trial.origin?.jobId===job.id).length},receiptIds:runs.map(run=>run.id)}}
      } else outcome={kind:'unresolved',effects:[],accounting:[],blockers:['Cancelled operation has no typed original receipt recovery port']}
      if(outcome.kind==='complete'&&job.attempts>0){const accounting=await readJobAccounting(this.options,{...job,result:outcome.result});outcome={...outcome,result:{...outcome.result,modelCostUsd:accounting.modelCostUsd}}}
      if(handle)await this.operations.update(handle,{phase:outcome.kind==='complete'?'cancelled_settled':'cancelled_unresolved',state:{outcome,result:outcome.kind==='complete'?outcome.result:undefined,receiptIds:outcome.kind==='complete'?outcome.receiptIds:[]},effect:outcome.kind==='complete'?(job.attempts===0?'none':'settled'):'unknown',accounting:outcome.kind==='complete'?'settled':'unknown',settlement:outcome.kind==='complete'?'settled':'unresolved'})
      return outcome
    }catch(error){const detail=error instanceof Error?error.message:String(error);if(handle)await this.operations.update(handle,{phase:'cancelled_unresolved',state:{blockers:[detail]},effect:'unknown',accounting:'unknown',settlement:'unresolved'}).catch(()=>{});return {kind:'unresolved',effects:[],accounting:[job.id],blockers:[detail]}}
    finally {if(handle)await this.operations.release(handle)}
  }
  async reconcileDetailed(jobId:string,signal?:AbortSignal):Promise<{plan:RecoveryPlan;job:ResearchDomain.Job;outcomes:Record<string,RecoveryOutcome>}> {
    const plan=await this.planRecovery(jobId),outcomes:Record<string,RecoveryOutcome>={}
    if(plan.blockers.some(blocker=>!['receipt_inspection_blocker','effect_observation_pending','accounting_observation_pending'].includes(blocker.code)))return {plan,job:await this.get(jobId),outcomes}
    plan.blockers=[]
    const abort=signal??new AbortController().signal,root=await this.get(plan.rootJobId)
    if(root.status==='queued'||root.status==='retry_wait'){outcomes[root.id]={kind:'incomplete',boundary:'queued_not_admitted'};return {plan,job:await this.get(jobId),outcomes}}
    if(root.status==='cancelled'){
      // Cancellation remains on the authorization axis. Every descendant is observed without reacquiring native run authority.
      for(const id of [...plan.orderedJobIds].reverse()) {const original=await this.get(id);if(original.status==='cancelled')outcomes[id]=await this.settleCancelled(original,abort);else if(['succeeded','failed'].includes(original.status))outcomes[id]={kind:'complete',result:original.result??{},receiptIds:[]};else outcomes[id]={kind:'unresolved',effects:[id],accounting:[],blockers:['Cancelled ancestor forbids native child continuation; original effect inspection is required']}}
    }else if(['interrupted','recovery_required'].includes(root.status)||root.status==='running'&&!!root.leaseExpiresAt&&Date.parse(root.leaseExpiresAt)<=Date.now()) {
      await this.runOnce({jobId:root.id,signal:abort,recoveryOnly:true})
      for(const id of plan.orderedJobIds){const current=await this.get(id);outcomes[id]=['succeeded','failed'].includes(current.status)?{kind:'complete',result:current.result??{},receiptIds:[]}:{kind:current.status==='interrupted'?'incomplete':'unresolved',...(current.status==='interrupted'?{boundary:current.error??'Original operation incomplete'}:{effects:[id],accounting:current.recovery?.reason==='accounting_unresolved'?[id]:[],blockers:[current.error??`Original job is ${current.status}`]})} as RecoveryOutcome}
    }else outcomes[root.id]={kind:'incomplete',boundary:root.status==='running'?'original_owner_live':'original_job_terminal'}
    for(const [id,outcome] of Object.entries(outcomes))if(outcome.kind==='unresolved')plan.blockers.push({jobId:id,code:'original_effect_unresolved',detail:outcome.blockers.join('; ')})
    return {plan,job:await this.get(jobId),outcomes}
  }
  async reconcile(jobId:string,signal?:AbortSignal){return (await this.reconcileDetailed(jobId,signal)).job}

  /** Observe a quiescent original accounting hold without acquiring authority.
   * This is only a per-worker observation cache; saved receipts remain authoritative. */
  private async accountingHoldFingerprint(state:ResearchState,rootId:string):Promise<string|undefined> {
    try {
      const root=state.jobs[rootId]
      if(!root||!['recovery_required','cancelled'].includes(root.status))return
      const tree=new Set([rootId])
      for(let changed=true;changed;){changed=false;for(const job of Object.values(state.jobs))if(typeof job.payload.parentJobId==='string'&&tree.has(job.payload.parentJobId)&&!tree.has(job.id)){tree.add(job.id);changed=true}}
      const jobs=[...tree].map(id=>state.jobs[id]!).sort((a,b)=>a.id.localeCompare(b.id))
      if(jobs.some(job=>!['autoresearch','campaign_loop'].includes(job.payload.kind)||['queued','running','retry_wait'].includes(job.status)))return
      const trials=Object.values(state.trials).filter(trial=>trial.origin&&tree.has(trial.origin.jobId)),trialIds=new Set(trials.map(trial=>trial.id))
      const runs=Object.values(state.runs).filter(run=>trialIds.has(run.trialId)||!!run.jobId&&tree.has(run.jobId))
      if(runs.some(run=>['queued','running'].includes(run.status)))return
      const operations=Object.values(state.operations).filter(record=>record.jobId&&tree.has(record.jobId))
      if(operations.some(record=>record.kind!=='native_job'&&!['none','settled'].includes(record.effect)))return
      let held=false
      const sessions:unknown[]=[],lanes:unknown[]=[],experiments:unknown[]=[],campaigns:unknown[]=[]
      for(const job of jobs){
        const native=state.operations[`op_job_${job.id.slice(4)}`]
        if(!native||native.kind!=='native_job'||native.projectId!==this.options.projectId||native.jobId!==job.id||native.identity.jobId!==job.id||native.identity.payloadHash!==operationHash(job.payload)||native.grant.payloadHash!==operationHash(job.payload))return
        if(job.payload.kind!=='autoresearch')continue
        const payload=Payload.parse(job.payload),experiment=state.experiments[payload.experimentId]
        if(!experiment||experiment.contractHash!==payload.contractHash)return
        ResearchDomain.assertContractIntegrity(experiment)
        const lane=(this.options.scientistFactory??(options=>new ScientistLane(options)))({workspace:this.options.workspace,projectId:this.options.projectId,experimentId:payload.experimentId,sessionId:payload.sessionId,research:this.options.research,store:this.options.store,execution:this.options.execution,maximumEvaluations:Number.MAX_SAFE_INTEGER,allowCompute:false})
        const status=await lane.status();if(status.pending)return
        lanes.push({jobId:job.id,status})
        const session=await readAccountingSession(this.options,payload.sessionId)
        if(!session||session.status==='running'||Object.keys(session.pendingTools).length||session.metadata.projectId!==this.options.projectId||session.metadata.experimentId!==payload.experimentId||session.metadata.contractHash!==payload.contractHash||!identityEqual(session.modelSelection,payload.modelSelection))return
        const requests=Object.values(session.modelRequests??{})
        for(const request of requests){
          if(request.status==='dispatched')return
          if(request.status==='unknown'&&(!request.delivery||!['completed','failed'].includes(request.delivery.status)||!Number.isFinite(request.completedAt)||request.costKind!=='sdk_estimate'||typeof request.estimatedCostUsd!=='number'||!Number.isFinite(request.estimatedCostUsd)||request.estimatedCostUsd<0))return
        }
        const baseline=job.checkpoints['pi:job:start']?.data
        const missingCeilings=!baseline?.allowance||baseline.turns===undefined||baseline.toolCalls===undefined
        const unknownBilling=requests.some(request=>request.status!=='not_dispatched'&&request.providerBilling?.status!=='reported')
        if((unknownBilling||missingCeilings)&&(job.status==='cancelled'||['succeeded','failed'].includes(job.status)||job.status==='recovery_required'&&job.recovery?.reason==='accounting_unresolved'))held=true
        sessions.push({id:session.id,metadata:session.metadata,modelSelection:session.modelSelection,status:session.status,usage:session.usage,modelRequests:session.modelRequests,pendingTools:session.pendingTools})
        experiments.push(experiment);campaigns.push(state.campaigns[experiment.campaignId])
      }
      if(!held)return
      const ancestors=new Map<string,ResearchDomain.Job>()
      const observe=(job:ResearchDomain.Job)=>{if(ancestors.has(job.id))return;ancestors.set(job.id,job);for(const id of [job.payload.parentJobId,job.payload.continuedFromJobId])if(typeof id==='string'&&state.jobs[id])observe(state.jobs[id]!)}
      jobs.forEach(observe)
      const deadlines=[...ancestors.values()].flatMap(job=>[job.checkpoints['host:lifecycle:start']?.data.deadlineMs,job.checkpoints['pi:job:start']?.data.deadlineMs,job.checkpoints['campaign:job:start']?.data.deadlineMs,job.payload.originDeadlineMs]).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value))
      const semanticJobs=jobs.map(job=>({id:job.id,payload:job.payload,status:job.status,cancelRequestedAt:job.cancelRequestedAt,result:job.result,recovery:job.recovery?{reason:job.recovery.reason,detail:job.recovery.detail}:undefined,
        checkpoints:Object.fromEntries(Object.entries(job.checkpoints).filter(([phase])=>!/^host:recovery:|^pi:accounting:(lease|settlement):|^pi:recovery:resumable$/.test(phase)).map(([phase,checkpoint])=>[phase,checkpoint.data])),
        settlements:[...new Set(Object.entries(job.checkpoints).filter(([phase])=>phase.startsWith('pi:accounting:settlement:')).map(([,checkpoint])=>operationHash(checkpoint.data)))].sort()}))
      return operationHash({jobs:semanticJobs,ancestors:[...ancestors.values()].map(job=>({id:job.id,payload:job.payload,status:job.status,cancelRequestedAt:job.cancelRequestedAt})),
        ancestorOperations:[...ancestors.keys()].map(id=>state.operations[`op_job_${id.slice(4)}`]).filter(record=>!!record).map(record=>({id:record.id,cancelledAt:record.cancelledAt,identity:record.identity,grant:record.grant,outcome:record.outcome,settlement:record.settlement})),
        operations:operations.map(record=>({id:record.id,kind:record.kind,identity:record.identity,grant:record.grant,cancelledAt:record.cancelledAt,effect:record.effect,accounting:record.accounting,outcome:record.outcome,settlement:record.settlement,state:record.kind==='native_job'?{result:record.state.result}:record.state})),
        trials,runs,sessions,lanes,experiments,campaigns,deadlineExpired:deadlines.length?Date.now()>=Math.min(...deadlines):false})
    }catch{return undefined} // Unreadable or ambiguous evidence is never cached.
  }

  /** Facts that can change outside this recovery pass, excluding its own lease receipts. */
  private async recoveryWakeFingerprint(rootId:string):Promise<string|undefined> {
    try {
      const state=await this.options.store.read(this.options.projectId),root=state.jobs[rootId]
      if(!root)return
      const tree=new Set([rootId])
      for(let changed=true;changed;){changed=false;for(const job of Object.values(state.jobs))if(typeof job.payload.parentJobId==='string'&&tree.has(job.payload.parentJobId)&&!tree.has(job.id)){tree.add(job.id);changed=true}}
      const jobs=[...tree].map(id=>state.jobs[id]!).sort((a,b)=>a.id.localeCompare(b.id)),ancestors=new Map<string,ResearchDomain.Job>()
      const observe=(job:ResearchDomain.Job)=>{if(ancestors.has(job.id))return;ancestors.set(job.id,job);for(const id of [job.payload.parentJobId,job.payload.continuedFromJobId])if(typeof id==='string'&&state.jobs[id])observe(state.jobs[id]!)}
      jobs.forEach(observe)
      const sessions:unknown[]=[],lanes:unknown[]=[],experiments:unknown[]=[],campaigns:unknown[]=[]
      for(const job of jobs){
        if(job.payload.kind!=='autoresearch')continue
        const payload=Payload.parse(job.payload),session=await readAccountingSession(this.options,payload.sessionId)
        if(!session)return
        sessions.push({id:session.id,metadata:session.metadata,modelSelection:session.modelSelection,status:session.status,usage:session.usage,modelRequests:session.modelRequests,pendingTools:session.pendingTools})
        const lane=(this.options.scientistFactory??(options=>new ScientistLane(options)))({workspace:this.options.workspace,projectId:this.options.projectId,experimentId:payload.experimentId,sessionId:payload.sessionId,research:this.options.research,store:this.options.store,execution:this.options.execution,maximumEvaluations:Number.MAX_SAFE_INTEGER,allowCompute:false})
        lanes.push({jobId:job.id,status:await lane.status()});experiments.push(state.experiments[payload.experimentId]);campaigns.push(state.campaigns[state.experiments[payload.experimentId]!.campaignId])
      }
      const originalDeadlines=[...ancestors.values()].map(job=>{
        const saved=job.checkpoints['host:lifecycle:start']?.data.deadlineMs??job.checkpoints['pi:job:start']?.data.deadlineMs??job.checkpoints['campaign:job:start']?.data.deadlineMs
        if(typeof saved==='number')return saved
        const duration=job.payload.kind==='autoresearch'?Number(job.payload.maximumDurationMs??(Number(job.payload.authoringTimeMs??300_000)+state.experiments[job.payload.experimentId]!.contract.budget.wallTimeMinutes*60_000*job.payload.iterations)):Number(job.payload.maximumDurationMs??MAX_TIMER_DURATION_MS)
        const deadline=Date.parse(job.startedAt!)+Math.min(MAX_TIMER_DURATION_MS,duration)
        if(!Number.isFinite(deadline))throw new Error('Original recovery deadline is unreadable')
        return deadline
      })
      const deadlines=[...originalDeadlines,...[...ancestors.values()].flatMap(job=>[job.checkpoints['host:lifecycle:start']?.data.deadlineMs,job.checkpoints['pi:job:start']?.data.deadlineMs,job.checkpoints['campaign:job:start']?.data.deadlineMs,job.payload.originDeadlineMs]).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value))]
      const trials=Object.values(state.trials).filter(trial=>trial.origin&&tree.has(trial.origin.jobId)),trialIds=new Set(trials.map(trial=>trial.id))
      return operationHash({sessions,lanes,experiments,campaigns,
        jobs:[...ancestors.values()].map(job=>({id:job.id,payload:job.payload,cancelRequestedAt:job.cancelRequestedAt,revoked:job.status==='cancelled',ancestorStatus:tree.has(job.id)?undefined:job.status,
          baseline:job.checkpoints['pi:job:start']?.data})),
        operations:Object.values(state.operations).filter(record=>record.jobId&&ancestors.has(record.jobId)).map(record=>({id:record.id,kind:record.kind,identity:record.identity,grant:record.grant,cancelledAt:record.cancelledAt,
          evidence:record.kind==='native_job'?undefined:{effect:record.effect,accounting:record.accounting,outcome:record.outcome,settlement:record.settlement,state:record.state}})),
        trials,runs:Object.values(state.runs).filter(run=>trialIds.has(run.trialId)||!!run.jobId&&tree.has(run.jobId)),deadlineMs:deadlines.length?Math.min(...deadlines):undefined,deadlineExpired:deadlines.length?Date.now()>=Math.min(...deadlines):false})
    }catch{return undefined}
  }

  async runWorker(input: { signal?: AbortSignal; pollMs?: number } = {}) {
    const pollMs = input.pollMs ?? 1000
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60_000) throw new Error('Invalid Pi worker poll interval')
    this.worker = {...this.worker,status:'running',consecutiveFailures:0,lastError:undefined,nextPollAt:undefined,continuationHolds:[]}
    const accountingHolds=new Map<string,string>()
    try {
      while (!input.signal?.aborted) {
        let delayMs = pollMs
        try {
          const state=await this.options.store.read(this.options.projectId)
          const candidates=Object.values(state.jobs).filter(job=>isPiJob(job)&&(job.payload.kind==='autoresearch'||this.handlers.has(job.payload.kind))&&
            (['interrupted','recovery_required'].includes(job.status)||job.status==='running'&&!!job.leaseExpiresAt&&Date.parse(job.leaseExpiresAt)<=Date.now()||job.status==='cancelled'&&state.operations[`op_job_${job.id.slice(4)}`]&&state.operations[`op_job_${job.id.slice(4)}`]!.settlement!=='settled')).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
          const observedRoots=new Set<string>();let recoverable:ResearchDomain.Job|undefined,recoveryRoot:string|undefined
          for(const candidate of candidates){
            const root=planOriginalRecovery(state,candidate.id).rootJobId
            if(observedRoots.has(root))continue
            observedRoots.add(root)
            const fingerprint=await this.accountingHoldFingerprint(state,root)
            if(fingerprint&&accountingHolds.get(root)===fingerprint)continue
            accountingHolds.delete(root);recoverable=candidate;recoveryRoot=root;break
          }
          for(const root of accountingHolds.keys())if(!candidates.some(candidate=>planOriginalRecovery(state,candidate.id).rootJobId===root))accountingHolds.delete(root)
          if(recoverable){
            const wakeBefore=await this.recoveryWakeFingerprint(recoveryRoot!)
            await this.reconcileDetailed(recoverable.id,input.signal)
            const fingerprint=await this.accountingHoldFingerprint(await this.options.store.read(this.options.projectId),recoveryRoot!)
            // A fact arriving during reconciliation must remain eligible for a fresh pass.
            // Read again AFTER the full hold signature so it cannot absorb that fact.
            const wakeAfter=fingerprint?await this.recoveryWakeFingerprint(recoveryRoot!):undefined
            if(fingerprint&&wakeBefore&&wakeBefore===wakeAfter)accountingHolds.set(recoveryRoot!,fingerprint)
          }
          // The saved terminal receipt is also the durable handoff point. Sweep
          // on every restart so a crash between settlement and admission cannot
          // strand residual authority. Recovery itself never calls this port.
          const settled=await this.options.store.read(this.options.projectId)
          const continuationHolds:Array<{jobId:string;error:string}>=[]
          for(const original of Object.values(settled.jobs).filter(job=>isPiJob(job)&&job.status==='succeeded')) {
            input.signal?.throwIfAborted()
            try {await this.specs.get(original.payload.kind)?.continue?.(original,input.signal??new AbortController().signal)}
            catch(error) {input.signal?.throwIfAborted();continuationHolds.push({jobId:original.id,error:(error instanceof Error?error.message:String(error)).slice(0,4000)})}
          }
          this.worker={...this.worker,continuationHolds}
          const job=await this.runOnce({signal:input.signal})
          this.worker = {...this.worker,status:'running',consecutiveFailures:0,lastError:undefined,lastSuccessAt:new Date().toISOString(),nextPollAt:undefined}
          if (job) continue
        } catch (error) {
          const consecutiveFailures = this.worker.consecutiveFailures + 1
          delayMs = Math.min(30_000,Math.max(250,pollMs) * 2 ** Math.min(7,consecutiveFailures - 1))
          this.worker = {...this.worker,status:'degraded',consecutiveFailures,lastError:(error instanceof Error ? error.message : String(error)).slice(0,4000),
            lastFailureAt:new Date().toISOString(),nextPollAt:new Date(Date.now()+delayMs).toISOString()}
        }
        if (input.signal?.aborted) break
        await new Promise<void>(resolve => {
          const stop = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', stop); resolve() }
          const timer = setTimeout(stop, delayMs)
          input.signal?.addEventListener('abort', stop, { once: true })
          if (input.signal?.aborted) stop()
        })
      }
    } finally {this.worker = {...this.worker,status:'stopped',nextPollAt:undefined}}
  }
}
