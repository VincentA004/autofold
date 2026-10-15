import {ScientistAuthority} from './authority'
import {DecisionMemory} from '@autofold/science-core/decision-memory'
import {decisions} from './evidence'
import {EvidenceView} from '@autofold/science-core/evidence-view'
import {CampaignResources} from '@autofold/science-core/campaign-resources'
import {ProtoModelRegistry} from '@autofold/science-core/research/model-registry'
import {ScientificContext} from './context'
import {FrozenTargetReferences,FrozenTargetPublicationError} from './target-references'
import {atomicJSON} from './persistence'
import {inspectScientificDraft,type CapturedScientificProgram} from './admission'
import {ScientificWorkspace} from './workspace'
import {ScientificResourcePack,SCIENTIST_SYSTEM_PROMPT,scientistApi} from './resources'
export {SCIENTIST_SYSTEM_PROMPT} from './resources'
import { NativeFeedbackController } from '../feedback'
import {CampaignSkillService} from '../skills/service'
import { CampaignKnowledgeReader, KnowledgeKinds, GraphKinds } from '../knowledge'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import z from 'zod'
import { Type, type TSchema, type Static } from 'typebox'
import type { RuntimeTool } from '../runtime'
import {toolProjectionBytes} from '../runtime/artifacts'
import { ResearchDomain } from '@autofold/science-core/domain'
import type { ResearchStore } from '@autofold/science-core/store'
import type {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchPrograms } from '@autofold/science-core/programs'
import { CampaignEvidence } from '@autofold/science-core/campaign-evidence'
import { ResearchQuestions } from '@autofold/science-core/research-questions'
import { TrialReasoning } from '@autofold/science-core/trial-reasoning'
import { ResearchScientistKernel } from '@autofold/science-core/scientist-kernel'
import { ResearchScientistMemory } from '@autofold/science-core/scientist-memory'
import { ResearchTrajectoryCloseout } from '@autofold/science-core/trajectory-closeout'
import { ScientistReview } from '@autofold/science-core/scientist-review'
import { ExperimentBranches } from '@autofold/science-core/experiment-branches'
import { ScientificExecution, ReceiptUnresolvedError } from '../execution'
import { checkedPath } from '../execution/paths'
import { ExecutionPreflightUnavailableError } from '../execution/errors'
import { HostCapabilitiesUnavailableError } from '../execution/capabilities'
import {generationSeed as deriveGenerationSeed} from '@autofold/science-core/research/generation-seed'

const reviewParameters = Type.Unsafe<z.input<typeof ScientistReview.Input>>(z.toJSONSchema(ScientistReview.Input, {io: 'input', unrepresentable: 'any'}))
const hash = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex')
function compactReceipt(result: Record<string, any>): Record<string, any> {
  const keys = ['status', 'continuation', 'resultPath', 'evidencePaths', 'trialId', 'runId', 'evaluationId', 'programHash', 'programPath',
    'score', 'valid', 'decision', 'intent', 'scientific', 'evidenceKind', 'hypothesis', 'decisionPlan', 'prediction', 'evidenceRefs',
    'publicationGaps','priorBestScore', 'scoreDeltaFromPriorBest', 'predictionAssessment', 'measuredPrediction', 'candidateSummaries',
    'observed', 'nativeSearch', 'evidenceCompleteness', 'closeoutVersion', 'observationId', 'commitHash', 'knowledgeCycleId', 'searchObservationIds', 'error', 'evidenceAuthority']
  return Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]]))
}
const decisionMemoryResultLimitBytes=60_000
function deliveredToolResultBytes(toolName:string,result:unknown) {
  const content=JSON.stringify(result)
  return toolProjectionBytes({role:'toolResult',toolCallId:'call_bounded_refresh_delivery',toolName,
    content:[{type:'text',text:content}],isError:false,timestamp:0})
}
const text = () => Type.String({minLength: 1})
export interface ScientistLifecycle {
  checkpoint(phase: string, data: unknown): Promise<unknown>
  readCheckpoint(phase: string): Promise<any | undefined>
  checkCancelled(): Promise<unknown> | unknown
}
/** Host policy inspects a cloned, normalized candidate before any immutable scientific identity. */
export type ScientistProspectiveCandidate = {
  projectId:string; experimentId:string; sessionId:string; contractHash:string; jobId?:string
  iteration:number; generationSeed:number; programHash:string; draftPath:string
  declaration:Readonly<Omit<ResearchService.CreateTrialInput,'programPath'|'programHash'|'origin'>>
  nativeDescriptor?:ExecutionProtocol.NativeExecution['descriptor']
} & ({phase:'validate';requestId?:never}|{phase:'evaluate';requestId:string})
export interface ScientistLaneOptions {
  workspace: string; projectId: string; experimentId: string; sessionId: string
  research: ResearchService.Service; store: ResearchStore; execution: ScientificExecution
  /** Absolute durable request ceiling, rebased by the host for each authorized job. */
  maximumEvaluations: number; evaluationBaseline?: number; allowCompute?:boolean;
  /** Throw to reject a new candidate; this hook cannot replace captured bytes or grant execution. */
  prospectiveAdmission?:(candidate:ScientistProspectiveCandidate)=>void|Promise<void>;
  /** Host-owned fixed protocols can reserve completion authority without allowing scientific pause. */
  allowScientificStop?:boolean; signal?: AbortSignal; origin?: {jobId: string; leaseId?: string}; lifecycle?: ScientistLifecycle
}
interface EvaluationIntent {
  requestId: string; programHash: string; programPath: string; draftPath: string; iteration: number
  input: ResearchService.CreateTrialInput; trialId?: string; phase: 'intent' | 'trial' | 'dispatched' | 'result'
  result?: Record<string, any>
}
export interface ScientistLaneStatus {
  [key: string]: unknown
  format: 'autofold.scientist-state.v2'; experimentId: string; contractHash: string; sessionId: string
  completedEvaluations: number; stopped: boolean; researchRequested: boolean
  pending?: {trialId?: string; requestId: string; programHash: string; programPath: string; iteration: number}
  latestResult?: Record<string, any>; stopDecision?: unknown; researchRequest?: unknown
}
// Historical receipts omit basis. New stop admissions must supply the typed scientific condition.
type StopInput = {basis?: 'objective_satisfied' | 'futility' | 'no_justified_intervention'; reason: string; rationale: string; evidenceRefs: string[]}
const scientificStop = z.object({basis:z.enum(['objective_satisfied','futility','no_justified_intervention']),reason:z.string().trim().min(1),rationale:z.string().trim().min(1),evidenceRefs:z.array(z.string().min(1)).min(1)})
type ResearchInput = {purpose?: "empirical_test" | "knowledge_lookup"; prerequisiteBranchId?: string; question: string; competingExplanations: string[]; requiredEvidence: string; applicabilityChecks: string; decisionIfResolved: string; evidenceRefs?: string[]}
interface State extends ScientistLaneStatus { requests: Record<string, EvaluationIntent>; operation?: {kind: 'stop' | 'research'; input: any; checkpointPhase?: string; generatedBy?: string; binding?: {requestId: string; revision: string | null}}; rejectedOperations?: {operation: NonNullable<State['operation']>; issues: CampaignEvidence.Issue[]; validationError?: string; rejectedAt: string}[] }
function tool<T extends TSchema>(name: string, description: string, parameters: T, execute: (input: Static<T>, signal?: AbortSignal) => Promise<any>): RuntimeTool<T> {
  return {name, label: name.replaceAll('_', ' '), description, parameters, executionMode: 'sequential', replay: 'never',
    execute: async (_id, input, signal) => {
      if (signal?.aborted) throw new Error('Scientist operation cancelled')
      const result = await execute(input, signal)
      return {content: [{type: 'text', text: JSON.stringify(result)}], details: result,
        ...(name === 'stop_discovery' || result?.continuation === 'yield' ? {terminate: true} : {})}
    }}
}
export class ScientistLane {
  readonly systemPrompt: string
  readonly root: string
  private readonly resourcePack:ScientificResourcePack
  private readonly targetReferences:FrozenTargetReferences
  private readonly contextReader:ScientificContext
  private readonly workspace:ScientificWorkspace
  private createWorkspace() {return new ScientificWorkspace({workspace:this.options.workspace,root:this.root,
    initialize:()=>this.prepareRead(),scope:()=>this.scope(),execution:this.options.execution,
    verifyReference:async(relative,bytes)=>{
      await this.targetReferences.verifyRead(relative,bytes)
      await this.resourcePack.verify(relative,bytes)
      this.contextReader.verifySourceRead(relative,bytes)
    }})}

  private state!: State
  private ready?: Promise<void>
  private authorityReady?:Promise<void>
  private readonly authority:ScientistAuthority
  private readonly publicationGaps=new Map<string,string>()
  private hydrated=false
  constructor(readonly options: ScientistLaneOptions) {
    this.systemPrompt=SCIENTIST_SYSTEM_PROMPT+(options.allowScientificStop===false?'\nThis fixed host protocol reserves batch and campaign completion authority. Scientific stop is not authorized and stop_discovery is unavailable. Continue authoring, validation and evaluation within the current grant; exhaustion returns control to the host for its next authorized batch. Failure, unknown effects, cancellation and hard model, compute and time bounds still hold; report those accurately without inventing a scientific completion.':'')
    if (!path.isAbsolute(options.workspace) || !/^exp_[A-Za-z0-9_-]+$/.test(options.experimentId) || !/^ses_[A-Za-z0-9_-]+$/.test(options.sessionId)) throw new Error('Scientist requires absolute workspace and valid host identities')
    if (!Number.isInteger(options.maximumEvaluations) || options.maximumEvaluations < 0) throw new Error('Scientist requires a nonnegative bounded evaluation limit')
    if (options.evaluationBaseline !== undefined && (!Number.isInteger(options.evaluationBaseline) || options.evaluationBaseline < 0 || options.evaluationBaseline > options.maximumEvaluations)) throw new Error('Scientist requires a valid host evaluation baseline')
    if (options.execution.workspace !== path.resolve(options.workspace) || options.execution.projectId !== options.projectId) throw new Error('Scientific execution belongs to another workspace or project')
    this.authority=new ScientistAuthority(options)
    this.root = `.autofold/autoresearch/${options.experimentId}`
    this.resourcePack=new ScientificResourcePack(options,this.root)
    this.targetReferences=new FrozenTargetReferences(options,this.root)
    this.workspace=this.createWorkspace()
    this.contextReader=new ScientificContext({options,root:this.root,initialize:()=>this.prepareRead(),scope:()=>this.scope(),
      acknowledgeResearch:()=>this.acknowledgeResearch(),verifyTargetReferences:()=>this.targetReferences.verifyPublished(),
      listFiles:()=>this.listFiles(),status:()=>this.status(),requests:()=>Object.keys(this.state.requests).length,
      completedEvaluations:()=>this.state.completedEvaluations,latestResult:()=>this.state.latestResult,publicationGaps:()=>Object.fromEntries(this.publicationGaps)})
  }
  /** Ordinary owner initialization retains original-effect reconciliation exactly once.
   * Reads and projection repair use prepareRead, which cannot execute pending intents. */
  initialize(): Promise<void> {return this.ready??=this.initializeOnce()}
  private authorityReadOnly=false
  private ephemeralAuthority=false
  private async ensureAuthority(readOnly=false):Promise<void>{
    if(!readOnly&&this.authorityReadOnly){
      const pending=this.authorityReady
      await pending
      if(this.authorityReady===pending){this.authorityReady=undefined;this.authorityReadOnly=false}
    }
    if(!this.authorityReady){this.authorityReadOnly=readOnly;this.authorityReady=this.loadAuthority(readOnly).catch(error=>{this.authorityReady=undefined;throw error})}
    await this.authorityReady
  }
  private async loadAuthority(readOnly=false){
    const o=this.options
    const bind=(state:Awaited<ReturnType<ResearchStore['read']>>)=>{
      const experiment=state.experiments[o.experimentId]
      if(!experiment||state.campaigns[experiment.campaignId]?.projectId!==o.projectId)throw new Error('Scientist experiment belongs to another project')
      ResearchDomain.assertContractIntegrity(experiment)
      if(experiment.piScientistSessionId&&experiment.piScientistSessionId!==o.sessionId)throw new Error('Experiment already has a different persistent scientist session')
      return experiment
    }
    let experiment=bind(await o.store.read(o.projectId))
    if(!readOnly&&!experiment.piScientistSessionId)experiment=await o.store.mutate(o.projectId,state=>{const experiment=bind(state);experiment.piScientistSessionId=o.sessionId;return experiment})
    const canonical=await this.authority.read()
    this.ephemeralAuthority=readOnly&&!canonical
    const previous=await Bun.file(await checkedPath(o.workspace,this.root+'/scientist.json')).json().catch(error=>{if(error.code==='ENOENT')return undefined;if(canonical){this.publicationGaps.set('scientist.json',String(error));return undefined}throw error})
    if(canonical&&previous)this.authority.checkProjection(previous,canonical)
    this.state=await this.authority.load(experiment,previous,{readOnly}) as State
    // The mandatory append-only journal is validated independently from derived Markdown.
    await ResearchScientistMemory.read(o.workspace,o.experimentId)
    if(!readOnly&&!canonical)await this.save()
  }
  private async projection(name:string,work:()=>Promise<unknown>){
    try{await work();this.publicationGaps.delete(name)}catch(error){this.publicationGaps.set(name,error instanceof Error?error.message:String(error))}
  }
  private async hydrate(){
    if(this.hydrated&&!this.publicationGaps.size)return
    const o=this.options,{experiment,state}=await this.scope()
    await this.projection('programs',async()=>{await fs.mkdir(await checkedPath(o.workspace,this.root+'/programs'),{recursive:true,mode:0o700})})
    await this.publishViews()
    if(this.publicationGaps.has('EVENTS.md')){const publication=await ResearchScientistMemory.publishReadable(o.workspace,o.experimentId);if(publication.status==='published')this.publicationGaps.delete('EVENTS.md');else this.publicationGaps.set('EVENTS.md',publication.error!)}
    // Source target verification remains mandatory; only destination publication errors are advisory.
    try{await this.targetReferences.publish(experiment);this.publicationGaps.delete('frozen-target')}catch(error){
      if(!(error instanceof FrozenTargetPublicationError))throw error
      this.publicationGaps.set('frozen-target',error.message)
    }
    await this.projection('NATIVE_TEMPLATE.py',async()=>{
      const file=await checkedPath(o.workspace,this.root+'/NATIVE_TEMPLATE.py'),temporary=file+'.'+crypto.randomUUID()+'.tmp'
      const template=ResearchPrograms.nativeProtoTemplate({intent:'optimize',gpuHours:experiment.contract.budget.gpuHours,
        evidenceRefs:[...CampaignEvidence.resolve(state,{campaignId:experiment.campaignId,experimentId:experiment.id}).ids()].slice(0,30)})
      await fs.writeFile(temporary,template,{mode:0o400,flag:'wx'});await fs.rename(temporary,file)
    })
    await this.projection('DECISION_PLAN.schema.json',async()=>atomicJSON(await checkedPath(o.workspace,this.root+'/DECISION_PLAN.schema.json'),z.toJSONSchema(TrialReasoning.DecisionPlan,{io:'input',unrepresentable:'any'})))
    await this.projection('API.md',async()=>{
      const api=await checkedPath(o.workspace,this.root+'/API.md'),temporary=api+'.'+crypto.randomUUID()+'.tmp'
      await fs.writeFile(temporary,scientistApi(await o.execution.scientistReference(o.workspace,this.root+'/references')),{mode:0o400,flag:'wx'})
      await fs.rename(temporary,api)
    })
    this.hydrated=true
  }
  private async prepareRead(){await this.ensureAuthority(true);await this.hydrate()}
  private async initializeOnce(){
    await this.ensureAuthority();await this.hydrate()
    const o=this.options
    await new CampaignSkillService(o).initialize((await this.scope()).campaign.id)
    for (const intent of Object.values(this.state.requests)) if (!intent.result) {
      if(o.allowCompute===false){
        const history=await o.research.history(o.projectId,o.experimentId),run=history.runs.find(run=>run.trialId===intent.trialId)
        if(!run)continue
        if(!['succeeded','failed','cancelled'].includes(run.status)&&!await Bun.file(await checkedPath(o.workspace,`.autofold/runs/${run.id}/dispatch.json`)).exists())continue
      }
      await this.executeIntent(intent,o.signal)
    }
    if (o.origin?.leaseId) {
      const feedback = new NativeFeedbackController(o)
      for (const intent of Object.values(this.state.requests)) if (intent.result && intent.input.origin?.jobId === o.origin.jobId &&
        ['succeeded', 'run_failed'].includes(intent.result.status) && typeof intent.result.runId === 'string') {
        await o.lifecycle?.checkCancelled()
        await feedback.recordRun({jobId: o.origin.jobId, leaseId: o.origin.leaseId}, intent.result.runId)
      }
    }
    if (this.state.operation?.kind === 'stop') {
      await o.lifecycle?.checkCancelled()
      const {state, experiment, campaign} = await this.scope()
      const issues = CampaignEvidence.resolve(state, {campaignId: campaign.id, experimentId: experiment.id}).issues(this.state.operation.input.evidenceRefs)
      // Legacy invalid intents were saved before validation. Discard only an
      // uncommitted stop, retaining its rejected input and scoped diagnosis.
      if (issues.length && !this.state.stopped && experiment.status === 'active' && !experiment.piStopDecision) {
        await o.lifecycle?.checkCancelled()
        this.state.rejectedOperations = [...this.state.rejectedOperations ?? [],
          {operation: this.state.operation, issues, rejectedAt: new Date().toISOString()}]
        delete this.state.operation
        await this.save(); await this.publishViews()
      } else if (issues.length) {
        throw new CampaignEvidence.ResolutionError(issues, 'Saved scientist stop intent evidence')
      }
    }
    if (this.state.operation?.kind === 'research') {
      await o.lifecycle?.checkCancelled()
      const {state, experiment, campaign} = await this.scope(), operation = this.state.operation
      let validationError: z.ZodError | undefined
      try { this.researchInput(operation.input) }
      catch (error) { if (error instanceof z.ZodError) validationError = error; else throw error }
      const issues = validationError ? [] : CampaignEvidence.resolve(state, {campaignId: campaign.id, experimentId: experiment.id})
        .issues(operation.input.evidenceRefs ?? [])
      if (validationError || issues.length) {
        const questions = this.projectedQuestions(state, campaign.id)
        const bound = operation.binding && questions.some(question => question.occurrenceIds.includes(operation.binding!.requestId))
        const sameQuestion = typeof operation.input.question === 'string' && typeof operation.input.requiredEvidence === 'string' &&
          questions.some(question => ResearchQuestions.identity(question.authoritativeRequest) === ResearchQuestions.identity(operation.input))
        const priorEffect = sameQuestion || (validationError ? Object.values(state.researchRequests).some(record => record.experimentId === experiment.id &&
          record.generatedBy === (operation.generatedBy ?? 'autofold-pi-scientist/v1:' + o.sessionId)) : this.priorResearchEffect(state, operation))
        if (!this.state.stopped && !this.state.researchRequested && campaign.status === 'active' && experiment.status === 'active' &&
          !bound && !priorEffect) {
          await o.lifecycle?.checkCancelled()
          this.state.rejectedOperations = [...this.state.rejectedOperations ?? [],
            {operation, issues, ...(validationError ? {validationError: validationError.message} : {}), rejectedAt: new Date().toISOString()}]
          delete this.state.operation
          await this.save(); await this.publishViews()
        } else if (validationError) throw validationError
        else throw new CampaignEvidence.ResolutionError(issues, 'Saved scientist research intent evidence')
      }
    }
    if (this.state.operation) await this.completeOperation(this.state.operation)
    await this.acknowledgeResearch()
  }
  private projectedQuestions(state:Awaited<ReturnType<ResearchStore['read']>>,campaignId:string) {return this.contextReader.projectedQuestions(state,campaignId)}
  /** Release historical research yields without answering them; project real assessments when available. */
  private async acknowledgeResearch() {
    if (this.state.researchRequested) {
      await this.options.lifecycle?.checkCancelled()
      this.state.researchRequested = false
      await this.save()
      await this.checkpoint('scientist:research:advisory:' + hash(JSON.stringify(this.state.researchRequest)), {request: this.state.researchRequest, blocking: false, processing: 'separate_research'})
    }
    const bound = this.state.researchRequest as {requestId?: string} | undefined
    if (!bound?.requestId) return
    const {state, campaign} = await this.scope()
    const question = this.projectedQuestions(state, campaign.id).find(question => question.occurrenceIds.includes(bound.requestId!))
    const baseline = this.state.researchRequestRevision ?? null
    if (!question || !question.revision || question.revision === baseline || !['answered', 'blocked'].includes(question.status)) return
    const cycle = state.knowledgeCycles[question.revision]
    const update = cycle?.outputs.researchRequestUpdates.find(update => question.occurrenceIds.includes(update.requestId) && update.status === question.status)
    if (!cycle || cycle.campaignId !== campaign.id || !update || !update.assessment || !update.remainingGap || !update.nextAction || (this.state.researchAcknowledgement as {revision?: string} | undefined)?.revision === cycle.id) return
    if (question.status === 'answered' && !update.literatureIds.length) return
    if (update.literatureIds.some(id => state.literature[id]?.campaignId !== campaign.id || !cycle.outputs.literatureIds.includes(id))) return
    await this.options.lifecycle?.checkCancelled()
    const acknowledgement = {requestId: bound.requestId, authoritativeRequestId: question.requestId, revision: cycle.id, status: question.status,
      assessment: update.assessment, remainingGap: update.remainingGap, nextAction: update.nextAction, literatureIds: update.literatureIds,
      evidenceRefs: [...new Set([...question.evidenceRefs, cycle.id, ...update.literatureIds])], authority: 'committed_knowledge_cycle_assessment'}
    this.state.researchAcknowledgement = acknowledgement
    this.state.researchRequested = false
    await this.save(); await this.publishViews()
    await this.checkpoint(`scientist:research:ack:${hash(bound.requestId)}:${cycle.id}`, acknowledgement)
  }
  private async save() {
    const snapshot=await this.scope()
    const pending = this.state.pending && this.state.requests[hash(this.state.pending.requestId)]
    const latest = this.state.latestResult
    let phase: ResearchScientistKernel.StateUpdate = {phase: 'authoring'}
    if (pending) phase = {phase: 'evaluation_pending', programFingerprint: pending.programHash,
      semanticProgramFingerprint: pending.input.semanticProgramFingerprint!, workflowFingerprint: pending.input.workflowFingerprint!}
    else if (latest && ['succeeded', 'run_failed'].includes(latest.status)) phase = {phase: 'result_available',
      status: latest.status, trialId: latest.trialId, runId: latest.runId, score: latest.score, error: latest.error}
    if (this.state.stopped) phase = {phase: 'stopped', ...this.state.stopDecision as {reason: string; rationale: string; evidenceRefs: string[]}}
    else if (this.state.researchRequested) phase = {phase: 'finished', reason: 'knowledge_refresh', completedEvaluations: this.state.completedEvaluations}
    const kernel = ResearchScientistKernel.State.parse({format: 'autofold.scientist-state.v2', experimentId: this.state.experimentId,
      contractHash: this.state.contractHash, sessionId: this.state.sessionId,
      iteration: pending?.iteration ?? Math.max(1, this.state.completedEvaluations),
      mutableTrialPath: pending?.draftPath ?? latest?.programPath ?? this.root + '/trial.py',
      memoryRevision:DecisionMemory.sourceManifest(snapshot.state,{projectId:this.options.projectId,
        campaignId:snapshot.campaign.id,experimentId:this.options.experimentId},await ResearchScientistMemory.read(this.options.workspace,this.options.experimentId)).revisions.evidence,
      updatedAt: new Date().toISOString(), ...phase})
    // Preserve the lane's durable request bindings beside the portable native kernel projection.
    // Drop prior phase-specific fields so each overwrite remains one complete total state.
    const {phase: priorPhase, status: priorStatus, trialId, runId, score, error, reason, rationale, evidenceRefs,
      programFingerprint, semanticProgramFingerprint, workflowFingerprint, ...lane} = this.state
    this.state = {...lane, ...kernel}
    const authorityRevision=await this.authority.save(this.state)
    await this.projection('scientist.json',async()=>atomicJSON(await checkedPath(this.options.workspace,this.root+'/scientist.json'),{...this.state,authorityRevision}))
  }
  private async checkpoint(phase: string, data: unknown) { await this.options.lifecycle?.checkpoint(phase, data) }
  private phase(requestId: string, suffix: string) { return `scientist:evaluation:${hash(requestId)}:${suffix}` }
  async status(): Promise<ScientistLaneStatus> {
    const canonical=this.state??await this.authority.read()
    const state = canonical ?? await Bun.file(await checkedPath(this.options.workspace, this.root + '/scientist.json')).json().catch(error => {if (error.code === 'ENOENT') return undefined; throw error})
    if (state) {const {requests, operation, ...status} = state; return structuredClone({...status,originalIntentAuthority:{status:canonical&&!this.ephemeralAuthority?'canonical':this.ephemeralAuthority?'ephemeral_read_only':Object.keys(requests??{}).length||operation?'held_legacy_unknown':'legacy_projection',requestCount:Object.keys(requests??{}).length,pendingOperation:operation?.kind??null,...(canonical&&!this.ephemeralAuthority?{revision:this.authority.currentRevision}:{limitation:'No canonical request register; explicit original-receipt migration is required before resuming legacy effects.'})}})}
    const history = await this.options.research.history(this.options.projectId, this.options.experimentId)
    return {format: 'autofold.scientist-state.v2', experimentId: this.options.experimentId, contractHash: history.experiment.contractHash,
      sessionId: this.options.sessionId, completedEvaluations: 0, stopped: false, researchRequested: false}
  }
  private async scope() {
    if(!this.state)await this.ensureAuthority(true)
    const state = await this.options.store.read(this.options.projectId)
    const experiment = state.experiments[this.options.experimentId]
    const ephemeral=this.ephemeralAuthority&&!experiment?.piScientistSessionId&&!Object.values(state.scientistLanes).some(record=>record.experimentId===experiment?.id)
    if (!experiment || state.campaigns[experiment.campaignId]?.projectId !== this.options.projectId || experiment.contractHash !== this.state.contractHash || !ephemeral&&experiment.piScientistSessionId !== this.options.sessionId) throw new Error('Scientist frozen binding changed')
    ResearchDomain.assertContractIntegrity(experiment)
    return {state, experiment, campaign: state.campaigns[experiment.campaignId]!}
  }
  queryKnowledge(input:Parameters<CampaignKnowledgeReader['query']>[0]) {return this.contextReader.queryKnowledge(input)}
  readKnowledge(input:Parameters<CampaignKnowledgeReader['read']>[0]) {return this.contextReader.readKnowledge(input)}
  context() {return this.contextReader.context()}
  private async decisionMemoryRefreshResult(toolName:string,base?:Record<string,any>,query?:DecisionMemory.Query) {
    try {
      const refresh=await this.contextReader.refreshDecisionMemory(query)
      const result=base?{...base,decisionMemoryRefresh:refresh}:refresh
      if(deliveredToolResultBytes(toolName,result)<=decisionMemoryResultLimitBytes)return result
      this.contextReader.clearMemoryAcknowledgement()
      const gap={status:'unavailable',reason:'Fresh decision-memory packet and tool result exceed the bounded full-delivery size. A smaller selection may fit; packet metadata can also remain above the limit. Use read_decision_memory or paged read_context/archive retrieval.',
        maximumBytes:decisionMemoryResultLimitBytes,readTool:'read_decision_memory'}
      return base?{...base,decisionMemoryRefresh:gap}:gap
    } catch(error) {
      this.contextReader.clearMemoryAcknowledgement()
      const gap={status:'unavailable',reason:'Fresh decision-memory preparation failed: '+(error instanceof Error?error.message:String(error)).slice(0,800),readTool:'read_decision_memory'}
      return base?{...base,decisionMemoryRefresh:gap}:gap
    }
  }
  private graphOperation(kind:'search'|'read'|'traverse',input:any) {return this.contextReader.graphOperation(kind,input)}
  private relative(input:string) {return this.workspace.relative(input)}
  private unresolvedEvaluationRequest() {
    return this.state.pending?.requestId ?? Object.values(this.state.requests).find(intent=>!intent.result)?.requestId
  }
  private assertNoUnresolvedEvaluation() {
    const requestId=this.unresolvedEvaluationRequest()
    if(requestId!==undefined)throw new Error('Accepted evaluation request '+JSON.stringify(requestId)+' requires reconciliation. Resume the exact original requestId and frozen program before validating or admitting a new candidate; no new trial or generation seed was admitted.')
  }
  private nextEvaluationSlotOrdinal() {return Object.keys(this.state.requests).length + 1}
  private generationSeedForOrdinal(ordinal=this.nextEvaluationSlotOrdinal()) {
    return deriveGenerationSeed(this.options.projectId,this.options.experimentId,this.options.sessionId,ordinal)
  }
  readFile(input:{path:string;offset?:number;limit?:number}) {return this.workspace.read(input)}
  writeFile(input:{path:string;content:string}) {return this.workspace.write(input)}
  editFile(input:{path:string;oldText:string;newText:string}) {return this.workspace.edit(input)}
  listFiles() {return this.workspace.list()}
  private capture(programPath?:string) {return this.workspace.capture(programPath)}
  async resources() {
    await this.prepareRead();const {campaign}=await this.scope()
    return {cwd:path.resolve(this.options.workspace,this.root),skills:await this.resourcePack.skills(campaign.id)}
  }
  private async assertBranchIntegrity(captured: {programHash: string; draftPath: string}, parentBranchId?: string | null) {
    const {state, experiment, campaign} = await this.scope()
    const matching = Object.values(state.experimentBranches).filter(branch => branch.experimentId === experiment.id && branch.programHash === captured.programHash).map(branch => branch.id)
    const draftAncestor = state.branchDrafts[`${experiment.id}:${captured.draftPath}`]
    const pending = [...matching, ...(draftAncestor ? [draftAncestor] : []), ...(parentBranchId ? [parentBranchId] : [])]
    const seen = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const branch = state.experimentBranches[id]
      if (!branch || branch.experimentId !== experiment.id || branch.contractHash !== experiment.contractHash || ExperimentBranches.hash(branch.program) !== branch.programHash) throw new Error('Branch contract or integrity mismatch')
      if (branch.parentBranchId) pending.push(branch.parentBranchId)
    }
  }
  private async inspect(captured:CapturedScientificProgram,evaluation:boolean,parentBranchId?:string|null,generationSeed=this.generationSeedForOrdinal()) {
    const result=await inspectScientificDraft({options:this.options,root:this.root,scope:()=>this.scope(),
      assertBranchIntegrity:(draft,parent)=>this.assertBranchIntegrity(draft,parent),graphEvidence:this.contextReader.graphEvidence},captured,evaluation,parentBranchId,generationSeed)
    return {...result,input:{...result.input,...(evaluation?{decisionMemoryExposure:this.contextReader.exposure({decisionPlan:result.input.decisionPlan,evidenceRefs:result.input.evidenceRefs})}:{})}}
  }
  private async admitProspective(captured:CapturedScientificProgram,preflight:Awaited<ReturnType<ScientistLane['inspect']>>,iteration:number,generationSeed:number,stage:{phase:'validate'}|{phase:'evaluate';requestId:string}) {
    if(!this.options.prospectiveAdmission)return
    await this.options.prospectiveAdmission(structuredClone({...stage,projectId:this.options.projectId,experimentId:this.options.experimentId,
      sessionId:this.options.sessionId,contractHash:this.state.contractHash,jobId:this.options.origin?.jobId,
      iteration,generationSeed,programHash:captured.programHash,draftPath:captured.draftPath,
      declaration:preflight.input,nativeDescriptor:preflight.inspected.nativeExecution?.descriptor}))
  }
  async validateTrial(input: {programPath?: string; parentBranchId?: string | null}) {
    await this.initialize(); await this.options.lifecycle?.checkCancelled()
    const iteration=this.nextEvaluationSlotOrdinal(), generationSeed=this.generationSeedForOrdinal(iteration)
    let captured: Awaited<ReturnType<ScientistLane['capture']>> | undefined
    let result: {valid: boolean; [key: string]: any}
    try {
      this.assertNoUnresolvedEvaluation()
      captured = await this.capture(input.programPath)
      const preflight = await this.inspect(captured, !!this.options.prospectiveAdmission, input.parentBranchId,generationSeed)
      await this.admitProspective(captured,preflight,iteration,generationSeed,{phase:'validate'})
      await this.options.lifecycle?.checkCancelled()
      const branch = await this.options.research.saveExperimentBranch(this.options.projectId, this.options.experimentId, {
        program: captured.program, draftPath: captured.draftPath, parentBranchId: input.parentBranchId,
        title: preflight.input.hypothesis.slice(0, 2000), rationale: 'Captured native program passed host-bound preflight', revisitWhen: 'Inspect after a verified evaluation', evidenceRefs: preflight.input.evidenceRefs ?? []})
      result = {valid: true, programPath: captured.draftPath, programHash: captured.programHash, branchId: branch.id, declaration: preflight.input,
        contractHash: this.state.contractHash, pipelineHash: preflight.inspected.pipelineHash}
    } catch (error) {
      const hostConfiguration = error instanceof ExecutionPreflightUnavailableError || error instanceof HostCapabilitiesUnavailableError
      const unresolved=this.unresolvedEvaluationRequest()
      result = {valid: false, category: hostConfiguration ? 'host_configuration' : unresolved!==undefined ? 'execution_unresolved' : 'program', error: error instanceof Error ? error.message : String(error),
        decisionPlanSchema: 'DECISION_PLAN.schema.json',
        repair: hostConfiguration
          ? 'Inspect executionCapabilities and any authored executable/cache overrides. A missing host transport hook requires a host repair; record the gap or choose an available pipeline. No trial or run was created.'
          : unresolved!==undefined ? 'Resume or reconcile accepted request '+JSON.stringify(unresolved)+' with its exact original requestId and frozen program. Do not repair its seed or create a replacement identity; no new trial or run was created.'
          : 'Edit the named program using the pinned API reference and DECISION_PLAN.schema.json, then validate again; no trial or run was created.'}
      if (error instanceof CampaignEvidence.ResolutionError) {
        const {state, experiment} = await this.scope()
        const catalog = CampaignEvidence.resolve(state, {campaignId: experiment.campaignId, experimentId: experiment.id})
        Object.assign(result, {issues: error.issues, evidenceScope: catalog.scope,
          allowedEvidenceRefs: [...catalog.ids()].slice(0, 100), evidenceFile: 'EVIDENCE.json',
          repair: 'Choose applicable persisted IDs from allowedEvidenceRefs or EVIDENCE.json for decision_plan.evidenceRefs and ProtoTrial.evidence_refs. Artifact hashes and invented target IDs are not evidence references. No trial or run was created.'})
      }
    }
    const origin = this.options.origin
    if (origin?.leaseId) {
      await this.options.lifecycle?.checkCancelled()
      const state = await this.options.store.read(this.options.projectId), job = state.jobs[origin.jobId]
      const attempts = Object.keys(job?.checkpoints ?? {}).map(phase => new RegExp('^scientist:authoring:' + iteration + ':(\\d+)$').exec(phase)).filter(Boolean).map(match => Number(match![1]))
      await new NativeFeedbackController(this.options).recordAuthoring({jobId: origin.jobId, leaseId: origin.leaseId}, {
        experimentId: this.options.experimentId, iteration, attempt: Math.max(0, ...attempts) + 1,
        status: result.valid ? 'ready' : 'failed', programFingerprint: captured?.programHash,
        semanticProgramFingerprint: result.declaration?.semanticProgramFingerprint, workflowFingerprint: result.declaration?.workflowFingerprint,
        ...(!result.valid ? {error: result.error.slice(0,2000)} : {}),
      })
    }
    return result
  }
  private async admission() {
    await this.options.lifecycle?.checkCancelled()
    this.assertNoUnresolvedEvaluation()
    await this.acknowledgeResearch()
    const {state, experiment, campaign} = await this.scope()
    if (this.state.stopped) throw new Error('Scientist has stopped; no further evaluation is authorized')
    if (experiment.status !== 'active' || campaign.status !== 'active') throw new Error('Scientist requires an active campaign and experiment')
    if (Object.keys(this.state.requests).length >= this.options.maximumEvaluations) throw new Error('Current scientist job evaluation budget exhausted')
    const resources = CampaignResources.summarize(state, campaign.id)
    if (resources.remainingGpuSeconds !== null && CampaignResources.gpuSeconds(experiment.contract.budget.gpuHours, "reservation") > resources.remainingGpuSeconds) throw new Error('Campaign frozen GPU allocation budget exhausted')
  }
  async evaluateTrial(input: {programPath?: string; requestId: string; parentBranchId?: string | null}, signal?: AbortSignal): Promise<Record<string, any>> {
    await this.initialize()
    if (!input.requestId.trim() || input.requestId.length > 4096) throw new Error('Evaluation needs a stable nonempty requestId')
    const key = hash(input.requestId)
    const previous = this.state.requests[key]
    if (previous) {
      if (previous.requestId !== input.requestId) throw new Error('Evaluation identity collision')
      if (input.programPath && this.relative(input.programPath) !== previous.draftPath) throw new Error('requestId is already bound to another program file')
      const current = await this.capture(previous.draftPath)
      if (current.programHash !== previous.programHash) throw new Error('requestId is bound to earlier captured bytes; use a new requestId for changed programs')
      if (previous.result) {
        // Reverify before presenting any saved successful result as trusted.
        if (previous.result.status === 'succeeded') await this.options.execution.artifacts(previous.result.runId)
        return previous.result
      }
      return this.executeIntent(previous, signal)
    }
    await this.admission()
    await this.options.execution.assertUnusedRequest(input.requestId)
    const captured = await this.capture(input.programPath)
    const iteration=this.nextEvaluationSlotOrdinal(), generationSeed=this.generationSeedForOrdinal(iteration)
    const preflight = await this.inspect(captured, true, input.parentBranchId,generationSeed)
    await this.admitProspective(captured,preflight,iteration,generationSeed,{phase:'evaluate',requestId:input.requestId})
    await this.options.lifecycle?.checkCancelled()
    const authored = await ResearchPrograms.author(this.options.workspace, {...preflight.input, program: captured.program})
    const intent: EvaluationIntent = {requestId: input.requestId, programHash: captured.programHash, programPath: authored.programPath,
      draftPath: captured.draftPath, iteration, input: {...preflight.input, ...authored, generationSeed, origin: {jobId: this.options.origin?.jobId ?? `job_scientist_${hash(this.options.sessionId)}`, phase: this.phase(input.requestId, 'trial')}}, phase: 'intent'}
    // Both the checkpoint and local fsync bind bytes, declaration and request before any scientific mutation.
    await this.checkpoint(this.phase(input.requestId, 'intent'), intent)
    this.state.requests[key] = intent
    this.state.pending = {requestId: intent.requestId, programHash: intent.programHash, programPath: intent.programPath, iteration: intent.iteration}
    await this.save()
    await this.options.research.saveExperimentBranch(this.options.projectId, this.options.experimentId, {
      program: captured.program, draftPath: captured.draftPath, parentBranchId: input.parentBranchId,
      title: preflight.input.hypothesis.slice(0, 2000), rationale: 'Prospective native evaluation admitted', revisitWhen: 'Interpret the verified result', evidenceRefs: preflight.input.evidenceRefs ?? []})
    return this.executeIntent(intent, signal)
  }
  private async executeIntent(intent: EvaluationIntent, signal?: AbortSignal) {
    await this.options.lifecycle?.checkCancelled()
    const o = this.options
    if (!intent.trialId) {
      const trial = await o.research.createTrial(o.projectId, o.experimentId, {...intent.input,
        origin: intent.input.origin ?? {jobId: o.origin?.jobId ?? `job_scientist_${hash(o.sessionId)}`, phase: this.phase(intent.requestId, 'trial')}}, o.origin?.leaseId ? {jobId:o.origin.jobId,leaseId:o.origin.leaseId} : undefined)
      intent.trialId = trial.id; intent.phase = 'trial'
      this.state.pending = {trialId: trial.id, requestId: intent.requestId, programHash: intent.programHash, programPath: intent.programPath, iteration: intent.iteration}
      await this.save(); await this.checkpoint(this.phase(intent.requestId, 'trial'), intent)
    }
    // Recovery can resume a recorded intent, but cannot admit a new evaluation after yielding.
    const {state, experiment, campaign} = await this.scope()
    const bound = await o.research.getTrialContext(o.projectId, intent.trialId)
    if (bound.experiment.id !== o.experimentId || bound.experiment.contractHash !== this.state.contractHash ||
      bound.trial.programHash !== intent.programHash || bound.trial.programPath !== intent.programPath) throw new Error('Persisted scientist intent differs from its frozen trial binding')
    const ownRun = Object.values(state.runs).find(run => run.trialId === intent.trialId)
    const resources = CampaignResources.summarize(state, campaign.id)
    if (!ownRun && resources.remainingGpuSeconds !== null && CampaignResources.gpuSeconds(experiment.contract.budget.gpuHours, "reservation") > resources.remainingGpuSeconds) throw new Error('Campaign resource budget no longer admits this evaluation')
    intent.phase = 'dispatched'; await this.save(); await this.checkpoint(this.phase(intent.requestId, 'dispatched'), intent)
    let receipt: Awaited<ReturnType<ScientificExecution['artifacts']>> | undefined
    let error: string | undefined
    try { receipt = await o.execution.evaluateTrial({trialId: intent.trialId, requestId: intent.requestId, signal: signal ?? o.signal, caller: o.origin?.leaseId ? {jobId:o.origin.jobId,leaseId:o.origin.leaseId} : undefined}) }
    catch (failure) {
      if (failure instanceof ReceiptUnresolvedError) throw failure
      const history = await o.research.history(o.projectId, o.experimentId)
      const run = history.runs.find(run => run.trialId === intent.trialId)
      if (run?.status === 'cancelled' || !run && (signal?.aborted || o.signal?.aborted)) return this.cancelledIntent(intent, run, failure)
      if (!run || run.status !== 'failed') throw failure
      error = failure instanceof Error ? failure.message : String(failure)
    }
    const history = await o.research.history(o.projectId, o.experimentId)
    const trial = history.trials.find(trial => trial.id === intent.trialId)!
    const run = receipt?.run ?? history.runs.find(run => run.trialId === intent.trialId)!
    const evaluation = history.evaluations.find(evaluation => evaluation.trialId === trial.id)
    const knowledge = history.knowledge.find(knowledge => knowledge.runId === run.id)
    await this.options.lifecycle?.checkCancelled()
    const failureReceiptHash=receipt?undefined:(await o.execution.failureReceipt(run.id)).receiptHash
    const closeoutInput = {campaignId: history.experiment.campaignId, experimentId: o.experimentId, sessionId: o.sessionId,
      iteration: intent.iteration, trialId: trial.id, runId: run.id, status: receipt ? 'succeeded' : 'run_failed',
      score: evaluation?.score, decision: knowledge?.decision === 'failed' ? undefined : knowledge?.decision, error, failureReceiptHash,
      generatorPortfolio: trial.generators, generatorAllocations: trial.generatorAllocations,
      decisionPlan: trial.decisionPlan, prediction: trial.prediction, evidenceRefs: trial.evidenceRefs,
      semanticProgramFingerprint: trial.semanticProgramFingerprint, configurationFamilyFingerprint: trial.configurationFamilyFingerprint,
      workflowFingerprint: trial.workflowFingerprint, calibrationClass: trial.calibrationClass, calibrationReplicateOfTrialId: trial.replicateOfTrialId,
      generatorDiagnostics: receipt?.generationRuns?.generatorDiagnostics ?? [],
      generationReplicate: receipt?.generationRuns?.replicate, generationWallSeconds: receipt?.generationRuns?.runtime.wallSeconds,
      candidateSequences: receipt?.candidates.candidates.map(candidate => candidate.sequence) ?? [],
      modelIds: [...new Set(receipt ? decisions(receipt.modelEvidence).map(item => item.modelId) : [])],
    } satisfies ResearchTrajectoryCloseout.Input
    const closeout = await ResearchTrajectoryCloseout.run(closeoutInput, {commit: input=>o.research.recordTrajectoryObservation(o.projectId,input),
      project: async projection=>{
        const label=projection.kind==='trajectory_journal_v2'?'events.v2.jsonl':'campaignKnowledge'
        try{
          if(projection.kind==='trajectory_journal_v2'){
            await checkedPath(o.workspace,this.root+'/events.v2.jsonl')
            await ResearchTrajectoryCloseout.projectJournalV2(projection,o.workspace)
          }else await o.research.publishCampaignKnowledge(o.projectId,projection.campaignId,o.workspace)
          this.publicationGaps.delete(label)
        }catch(error){this.publicationGaps.set(label,error instanceof Error?error.message:String(error));throw error}
      },acknowledge:(id,commitHash)=>o.research.acknowledgeTrajectoryProjection(o.projectId,id,commitHash)})
    if (closeout.status !== 'completed') throw new Error(`Trusted terminal trajectory closeout is incomplete: ${closeout.reason}`)
    if(closeout.closeoutVersion===1){
      await checkedPath(o.workspace,this.root+'/events.jsonl')
      await ResearchTrajectoryCloseout.runLegacy(closeoutInput,{
        projectId:o.projectId,store:o.store,
        verifyOriginalReceipt:async()=>({receiptHash:receipt?.run.manifestHash??failureReceiptHash!}),
        readEvents:experimentId=>ResearchScientistMemory.read(o.workspace,experimentId),
        appendEvent:event=>ResearchTrajectoryCloseout.appendTrustedEvent(event,o.workspace,history.experiment.contract.evaluator.direction),
      })
    }
    await this.checkpoint(this.phase(intent.requestId, 'closeout'), closeout)
    const candidateTable = receipt ? EvidenceView.candidateTable(decisions(receipt.modelEvidence), receipt.candidates.candidates) : undefined
    const priorEvaluations = evaluation ? history.evaluations.slice(0, history.evaluations.findIndex(item => item.id === evaluation.id)) : history.evaluations
    const priorScores = priorEvaluations.filter(item => item.valid && item.score !== null && history.trials.find(trial => trial.id === item.trialId)?.intent === 'optimize').map(item => item.score!)
    const priorBestScore = priorScores.length ? (history.experiment.contract.evaluator.direction === 'minimize' ? Math.min(...priorScores) : Math.max(...priorScores)) : null
    const evidenceSummary = receipt ? EvidenceView.summary(decisions(receipt.modelEvidence), receipt.candidates.candidates) : undefined
    const result = {status: receipt ? 'succeeded' : 'run_failed', trialId: trial.id, runId: run.id, evaluationId: evaluation?.id,
      programHash: trial.programHash, programPath: intent.draftPath, score: evaluation?.score ?? null, valid: evaluation?.valid ?? false,
      decision: knowledge?.decision, intent: trial.intent, scientific: receipt?.scientific, evidenceKind: receipt?.evidenceKind, error,
      hypothesis: trial.hypothesis, decisionPlan: trial.decisionPlan, prediction: trial.prediction, evidenceRefs: trial.evidenceRefs,
      priorBestScore, scoreDeltaFromPriorBest: priorBestScore !== null && evaluation?.score !== null && evaluation?.score !== undefined
        ? history.experiment.contract.evaluator.direction === 'minimize' ? priorBestScore - evaluation.score : evaluation.score - priorBestScore : null,
      predictionAssessment: TrialReasoning.assess(trial.prediction, evaluation?.score ?? null, history.evaluations.find(item => item.trialId === trial.prediction?.comparatorTrialId), evaluation?.valid ?? false),
      measuredPrediction: receipt ? EvidenceView.assessMeasurement(trial.decisionPlan?.measurement, decisions(receipt.modelEvidence)) : undefined,
      candidateSummaries: receipt?.candidates.candidates.slice(0, 12).map(candidate => ({id: candidate.id, sequence: candidate.sequence, seed: candidate.seed})),
      observed: {panel: evaluation?.diagnostics ?? null, returnedCandidateCount: receipt?.candidates.candidates.length ?? null},
      nativeSearch: receipt?.nativeSearch,
      evidenceSummary: evidenceSummary && (({candidateTable, measurementCatalog, ...summary}) => summary)(evidenceSummary),
      closeoutVersion:closeout.closeoutVersion,observationId:closeout.observationId,commitHash:closeout.commitHash,
      knowledgeCycleId: closeout.trajectory.knowledgeCycleId, searchObservationIds: closeout.trajectory.searchObservationIds,
      evidenceCompleteness: receipt?.evidenceCompleteness, candidateTable, measurementCatalog: candidateTable ? EvidenceView.measurementCatalog(candidateTable) : [],
      evidencePaths: {bundle: run.bundlePath, score: run.outputPath + '/result.json', candidates: run.outputPath + '/candidates.json',
        generation: run.outputPath + '/generation-runs/index.json', models: run.outputPath + '/model-runs/index.json',
        ...(receipt?.nativeSearch ? {nativeSearch: run.outputPath + '/' + receipt.nativeSearch.artifactPath} : {})},
      publicationGaps:{} as Record<string,string>,resultPath: this.root + `/results/${run.id}.json`, continuation: Object.keys(this.state.requests).length >= o.maximumEvaluations ? 'yield' : 'continue'}
    await this.projection('result:'+run.id,async()=>atomicJSON(await checkedPath(o.workspace,result.resultPath),result))
    result.publicationGaps=Object.fromEntries(this.publicationGaps)
    const compact = compactReceipt(result)
    intent.result = compact; intent.phase = 'result'
    this.state.completedEvaluations = Object.values(this.state.requests).filter(request => request.result).length
    delete this.state.pending; this.state.latestResult = compact
    await this.save(); await this.publishViews()
    await this.checkpoint(this.phase(intent.requestId, 'result'), result)
    if (o.origin?.leaseId) await new NativeFeedbackController(o).recordRun({jobId: o.origin.jobId, leaseId: o.origin.leaseId}, run.id)
    return compact
  }
  private async cancelledIntent(intent: EvaluationIntent, run: ResearchDomain.Run | undefined, failure: unknown) {
    const result = {status: 'cancelled', trialId: intent.trialId, runId: run?.id, programHash: intent.programHash,
      programPath: intent.draftPath, valid: false, score: null, error: failure instanceof Error ? failure.message : String(failure),
      evidenceAuthority: 'Cancelled execution produced no trusted scientific score, failure finding or trajectory knowledge cycle.',
      resultPath: this.root + `/results/${run?.id ?? 'cancelled_' + hash(intent.requestId)}.json`, continuation: Object.keys(this.state.requests).length >= this.options.maximumEvaluations ? 'yield' : 'continue'}
    await this.projection('cancelledResult',async()=>atomicJSON(await checkedPath(this.options.workspace,result.resultPath),result))
    intent.result = result; intent.phase = 'result'; this.state.completedEvaluations = Object.values(this.state.requests).filter(request => request.result).length
    delete this.state.pending; this.state.latestResult = result
    // A cancelled job cannot acquire authority for a science mutation or final checkpoint.
    // Preserve its transparent local receipt so a later authorized job can inspect and choose a new request.
    await this.save(); await this.publishViews()
    return result
  }
  private publishViews() {return this.projection('workspaceViews',()=>this.contextReader.publishViews())}
  private stopPhase(input: StopInput) {
    return 'scientist:stop:' + hash(JSON.stringify({...input.basis?{basis:input.basis}:{},reason: input.reason, rationale: input.rationale, evidenceRefs: input.evidenceRefs}))
  }
  private stopResult(input: StopInput) { return {status: 'stopped', continuation: 'yield', decision: input} }
  private researchInput(input: ResearchInput): ResearchInput {
    const parsed = ResearchService.RequestResearchInput.parse({request: {...input, action: 'create'}, evidenceRefs: input.evidenceRefs ?? [],
      generatedBy: 'autofold-pi-scientist/v1:' + this.options.sessionId})
    const {question, competingExplanations, requiredEvidence, applicabilityChecks, decisionIfResolved, purpose, prerequisiteBranchId} = parsed.request
    return {...(purpose ? {purpose} : {}), ...(prerequisiteBranchId ? {prerequisiteBranchId} : {}), question, competingExplanations, requiredEvidence, applicabilityChecks, decisionIfResolved, evidenceRefs: parsed.evidenceRefs}
  }
  /** Older result receipts may say yield; preserve them without reinstating that policy. */
  private async checkpointResearchResult(phase: string, result: Record<string, any>) {
    const saved = await this.options.lifecycle?.readCheckpoint(phase)
    if (saved) {
      if (saved.requestId !== result.requestId) throw new Error('Research result checkpoint belongs to a different request')
      return
    }
    await this.checkpoint(phase, result)
  }
  private researchPhase(input: ResearchInput) { return 'scientist:research:' + hash(JSON.stringify(this.researchInput(input))) }
  private priorResearchEffect(state: Awaited<ReturnType<ResearchStore['read']>>, operation: NonNullable<State['operation']>) {
    const generatedBy = operation.generatedBy ?? 'autofold-pi-scientist/v1:' + this.options.sessionId
    return Object.values(state.researchRequests).find(record => record.experimentId === this.options.experimentId && record.generatedBy === generatedBy &&
      ResearchQuestions.identity(record.request) === ResearchQuestions.identity(operation.input))
  }
  private async completeOperation(operation: NonNullable<State['operation']>): Promise<Record<string, any>> {
    await this.options.lifecycle?.checkCancelled()
    const {kind, input} = operation
    if (kind === 'stop') {
      await this.options.store.mutate(this.options.projectId, state => {
        const experiment = state.experiments[this.options.experimentId]!
        CampaignEvidence.resolve(state, {campaignId: experiment.campaignId, experimentId: experiment.id}).assert(input.evidenceRefs, 'Stop evidence')
        if (experiment.status !== 'active' && experiment.status !== 'paused') throw new Error('Cannot stop this experiment')
        if (experiment.status !== 'paused' || !experiment.piStopDecision || this.stopPhase(experiment.piStopDecision as StopInput) !== this.stopPhase(input)) {
          experiment.status = 'paused'; experiment.updatedAt = new Date().toISOString(); experiment.piStopDecision = {...input, authority: 'scientist_interpretation'}
        }
      })
      this.state.stopped = true; this.state.stopDecision = input
    } else {
      const {state, campaign} = await this.scope()
      const generatedBy = operation.generatedBy ?? 'autofold-pi-scientist/v1:' + this.options.sessionId
      const priorEffect = this.priorResearchEffect(state, operation)
      const bound = operation.binding ?? (priorEffect ? {requestId: priorEffect.id, revision: null} : undefined)
      const request = bound ? {requestId: bound.requestId, status: 'open' as const, scheduledAction: 'iterate_experiment' as const} :
        await this.options.research.requestResearch(this.options.projectId, this.options.experimentId,
          {request: {...input, action: 'create'}, evidenceRefs: input.evidenceRefs ?? [], generatedBy})
      // Preserve exact durable request identity without imposing a discovery dependency.
      this.state.researchRequested = false; this.state.researchRequest = {...request, ...(input.purpose ? {purpose: input.purpose} : {}), ...(input.prerequisiteBranchId ? {prerequisiteBranchId: input.prerequisiteBranchId} : {})}
      this.state.researchRequestRevision = bound?.revision ?? null
      this.state.researchRequestPhase = operation.checkpointPhase
    }
    delete this.state.operation; await this.save(); await this.publishViews()
    const result = kind === 'stop' ? this.stopResult(input) : {...this.state.researchRequest as object, continuation: 'continue', blocking: false, processing: 'separate_research'}
    // Saved operations without a phase predate input-specific operation checkpoints.
    const resultPhase = (operation.checkpointPhase ?? 'scientist:' + kind) + ':result'
    if (kind === 'research') await this.checkpointResearchResult(resultPhase, result)
    else await this.checkpoint(resultPhase, result)
    return result
  }
  async stop(input: StopInput) {
    await this.initialize(); await this.options.lifecycle?.checkCancelled()
    if(this.options.allowScientificStop===false)throw new Error('This host-owned protocol reserves completion authority; scientist stop is not authorized. Continue within the granted bounds or report a host failure.')
    input = scientificStop.parse(input)
    // Exhausting a child grant transfers control to its host; it cannot pause the experiment.
    // Check before persisting an intent so a mistaken stop leaves no durable scientific effect.
    if (!this.state.stopped && Object.keys(this.state.requests).length >= this.options.maximumEvaluations)
      throw new Error('Current job evaluation allowance is exhausted. The host completes this batch and renews campaign authorization when available; this is not a scientific stop.')
    const {state, experiment, campaign} = await this.scope()
    CampaignEvidence.resolve(state, {campaignId: campaign.id, experimentId: experiment.id}).assert(input.evidenceRefs, 'Stop evidence')
    const settled=ResearchTrajectoryCloseout.events(state,[],experiment.id).some(event=>
      event.closeoutVersion===2&&event.receiptHash&&event.commitHash&&['succeeded','failed'].includes(state.runs[event.runId]?.status??'')&&
      (input.basis!=='objective_satisfied'||event.status==='succeeded'&&event.valid===true)&&
      input.evidenceRefs.some(ref=>ref===event.runId||ref===state.searchObservations[String(event.observationId)]?.evaluationId||ref===event.observationId))
    if(!settled)throw new Error('Scientific stop requires a cited canonical settled run, evaluation or observation from this experiment; objective_satisfied requires a successful valid measurement. Setup identities, interpretation and unresolved or cancelled effects cannot establish scientific completion or futility.')
    if (experiment.status !== 'active' && experiment.status !== 'paused') throw new Error('Cannot stop this experiment')
    const checkpointPhase = this.stopPhase(input)
    if (this.state.stopped && this.state.stopDecision && this.stopPhase(this.state.stopDecision as StopInput) === checkpointPhase) {
      const result = this.stopResult(input)
      await this.checkpoint(checkpointPhase + ':result', result)
      return result
    }
    await this.checkpoint(checkpointPhase + ':intent', input)
    this.state.operation = {kind: 'stop', input, checkpointPhase}; await this.save()
    return this.completeOperation(this.state.operation)
  }
  async requestResearch(input: ResearchInput): Promise<Record<string, any>> {
    await this.initialize(); await this.options.lifecycle?.checkCancelled()
    if (this.state.stopped) throw new Error('Scientist stopped')
    input = this.researchInput({...input, purpose: input.purpose ?? "empirical_test"})
    const {state, experiment, campaign} = await this.scope()
    if (campaign.status !== 'active' || experiment.status !== 'active') throw new Error('Research requests require an active campaign and experiment')
    CampaignEvidence.resolve(state, {campaignId: campaign.id, experimentId: experiment.id}).assert(input.evidenceRefs ?? [], 'Research request evidence')
    if (input.prerequisiteBranchId) {
      const branch = state.experimentBranches[input.prerequisiteBranchId]
      if (!branch || branch.experimentId !== experiment.id || branch.contractHash !== experiment.contractHash || ExperimentBranches.hash(branch.program) !== branch.programHash) throw new Error('Knowledge prerequisite branch must be host-validated in this frozen experiment')
    }
    const existing = this.projectedQuestions(state, campaign.id).find(question => ResearchQuestions.identity(question.authoritativeRequest) === ResearchQuestions.identity(input))
    if (existing && existing.status !== 'open') throw new Error('This research request is already assessed; use its saved assessment to choose another intervention')
    const checkpointPhase = this.researchPhase(input)
    if (this.state.researchRequest && this.state.researchRequestPhase === checkpointPhase) {
      const result = {...this.state.researchRequest as object, scheduledAction: 'iterate_experiment', continuation: 'continue', blocking: false, processing: 'separate_research'}
      await this.checkpointResearchResult(checkpointPhase + ':result', result)
      return result
    }
    const generatedBy = 'autofold-pi-scientist/v1:' + this.options.sessionId + ':' + hash(JSON.stringify(input))
    const binding = existing ? {requestId: existing.requestId, revision: existing.revision} : undefined
    await this.checkpoint(checkpointPhase + ':intent', input)
    this.state.operation = {kind: 'research', input, generatedBy, binding, checkpointPhase}; await this.save()
    return this.completeOperation(this.state.operation)
  }
  async reviewResult(input: unknown) {
    await this.initialize(); const parsed = ScientistReview.Input.parse(input)
    const context = await this.options.research.getTrialContext(this.options.projectId, (await this.options.research.getRun(this.options.projectId, parsed.runId)).trialId)
    if (context.experiment.id !== this.options.experimentId) throw new Error('Review run belongs to another scientist experiment')
    const receipt = await this.options.execution.artifacts(parsed.runId)
    const candidateTable = EvidenceView.candidateTable(decisions(receipt.modelEvidence), receipt.candidates.candidates)
    const review = await this.options.research.recordScientistReview(this.options.projectId, this.options.experimentId, parsed,
      {candidateTable, measurementCatalog: EvidenceView.measurementCatalog(candidateTable), evidenceCompleteness: receipt.evidenceCompleteness})
    await this.publishViews(); return review
  }
  async branches(raw: unknown) {
    await this.initialize(); const action = ExperimentBranches.Action.parse(raw)
    const o = this.options
    if (action.action === 'list') return (await o.research.experimentBranches(o.projectId, o.experimentId)).slice(action.offset, action.offset + action.limit)
    if (action.action === 'save') {
      const input = raw as Record<string, any>, captured = await this.capture(input.programPath)
      const validated = await this.inspect(captured, false, input.parentBranchId)
      const result = await o.research.saveExperimentBranch(o.projectId, o.experimentId, {...action, program: captured.program,
        draftPath: captured.draftPath, parentBranchId: input.parentBranchId, evidenceRefs: validated.input.evidenceRefs ?? []})
      await this.publishViews(); return result
    }
    if (action.action === 'status') {const result = await o.research.updateExperimentBranch(o.projectId, o.experimentId, action); await this.publishViews(); return result}
    const branch = await o.research.restoreExperimentBranch(o.projectId, o.experimentId, action.branchId)
    const input = raw as Record<string, any>
    await this.writeFile({path: input.programPath ?? 'trial.py', content: branch.program})
    await o.research.bindExperimentDraft(o.projectId, o.experimentId, this.relative(input.programPath ?? 'trial.py'), branch.program)
    await this.publishViews(); return {branchId: branch.id, programHash: branch.programHash, programPath: input.programPath ?? 'trial.py'}
  }
  tools(options:{legacyAliases?:boolean}={}): RuntimeTool<any>[] {
    const program = {programPath: Type.Optional(text()), parentBranchId: Type.Optional(Type.Union([text(), Type.Null()]))}
    const readContext=tool('read_context', 'Inspect the frozen experiment and persisted prior evidence.', Type.Object({}), () => this.contextReader.context(true))
    readContext.onDelivery=delivery=>this.contextReader.acknowledgeDelivery(delivery)
    const tools = [
      readContext,
      tool('read_model_card', 'Read a pinned native Proto model summary first, or page the chosen configSchema/full card. Defaults to a summary and 4000 characters; full metadata remains available. No inference or asset probes.',
        Type.Object({key: text(), kind: Type.Union([Type.Literal('tool'), Type.Literal('generator'), Type.Literal('constraint'), Type.Literal('optimizer')]),
          section: Type.Optional(Type.Union([Type.Literal('summary'), Type.Literal('card'), Type.Literal('inputSchema'), Type.Literal('configSchema'), Type.Literal('outputSchema')])),
          offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 24000}))}),
        async input => ProtoModelRegistry.readCard(await this.options.execution.modelRegistry(), input)),
      tool('query_knowledge', 'Query all records in this bound campaign, with lifecycle and epistemic labels; includes older evidence beyond recent history. Read returned IDs for source provenance and relations.', Type.Object({query: Type.Optional(Type.String({maxLength: 500})), kinds: Type.Optional(Type.Array(Type.Union(KnowledgeKinds.map(kind => Type.Literal(kind))), {minItems: 1, maxItems: 7})), includeDeprecated: Type.Optional(Type.Boolean()), offset: Type.Optional(Type.Integer({minimum: 0, maximum: 100000})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 20}))}, {additionalProperties: false}), input => this.queryKnowledge(input)),
      tool('read_knowledge', 'Read one campaign knowledge, source, claim, alignment, cycle, hypothesis or interpretation with source hashes and paged relations. Offset/limit page source evidence and edges; body reports truncation.', Type.Object({id: text(), offset: Type.Optional(Type.Integer({minimum: 0, maximum: 100000})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 20}))}, {additionalProperties: false}), input => this.readKnowledge(input)),
      tool('search_graph', 'Search persisted knowledge and scientific entities across campaigns in this bound project. Other-campaign results require applicability checks and do not expand scientific authority.', Type.Object({query:Type.Optional(Type.String({maxLength:500})), kinds:Type.Optional(Type.Array(Type.Union(GraphKinds.map(k=>Type.Literal(k))), {minItems:1})), limit:Type.Optional(Type.Integer({minimum:1,maximum:20})), offset:Type.Optional(Type.Integer({minimum:0,maximum:100000})), includeDeprecated:Type.Optional(Type.Boolean())}, {additionalProperties:false}), input=>this.graphOperation('search',input)),
      tool('read_graph_node', 'Read a project graph node with canonical record hash, source/receipt identity, status and applicability. Interpretations remain interpretations; optionally require the previously retrieved hash.', Type.Object({id:text(),expectedHash:Type.Optional(text())}, {additionalProperties:false}), input=>this.graphOperation('read',input)),
      tool('traverse_graph', 'Follow bounded project graph relationships in either direction, including contradicting and historical evidence. Paths identify original relationship records. Start with the experiment ID in read_context.decisionMemory.sourceManifest.scope.', Type.Object({id:text(),expectedHash:Type.Optional(text()),maxHops:Type.Optional(Type.Integer({minimum:1,maximum:4})),maxNodes:Type.Optional(Type.Integer({minimum:1,maximum:40})),relations:Type.Optional(Type.Array(Type.String({maxLength:80}),{minItems:1,maxItems:20}))}, {additionalProperties:false}), input=>this.graphOperation('traverse',input)),
      tool('read_file', 'Read an experiment-scoped program, reference or evidence file by line.', Type.Object({path: text(), offset: Type.Optional(Type.Integer({minimum: 1})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 1000}))}), input => this.readFile(input)),
      tool('write_file', 'Write trial.py, programs/**/*.py or LAB.md within the scientist workspace.', Type.Object({path: text(), content: text()}), input => this.writeFile(input)),
      tool('edit_file', 'Replace one exact text match in a mutable scientist file.', Type.Object({path: text(), oldText: text(), newText: Type.String()}), input => this.editFile(input)),
      tool('list_files', 'List a bounded page of experiment-scoped files. Use path to narrow to a directory, then pass nextCursor back with the same path to continue. The result states whether files remain.', Type.Object({path:Type.Optional(text()),cursor:Type.Optional(Type.String({maxLength:4096})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),maxBytes:Type.Optional(Type.Integer({minimum:2048,maximum:16000}))},{additionalProperties:false}), async input => {await this.prepareRead(); return this.workspace.listPage(input)}),
      tool('search_files','Find literal text in experiment-scoped files without shell execution. Case-sensitive by default; set caseSensitive=false to ignore case. Narrow with path and glob patterns such as *.py or **/*.py; use the returned cursor with the same query and filters to continue. Results include bounded match-centered excerpts with line/column and truncation markers, optional nearby context, scanned-byte and skipped-file counts, and an explicit omission reason. Pagination reflects the live workspace, so edits between pages can shift later results.',Type.Object({query:Type.String({minLength:1,maxLength:500}),path:Type.Optional(text()),glob:Type.Optional(Type.String({minLength:1,maxLength:256})),caseSensitive:Type.Optional(Type.Boolean()),cursor:Type.Optional(Type.String({maxLength:4096})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),maxBytes:Type.Optional(Type.Integer({minimum:2048,maximum:16000})),context:Type.Optional(Type.Integer({minimum:0,maximum:2}))},{additionalProperties:false}),async input=>{await this.prepareRead();return this.workspace.search(input)}),
      ...this.workspace.nativeTools(),
      tool('validate_trial', 'Preflight captured native build_trial bytes; no scientific trial or run is created.', Type.Object(program), input => this.validateTrial(input)),
      (()=>{
        const evaluate=tool('evaluate_trial', 'Evaluate a prospective native trial with one durable requestId; after verified closeout, attach the current bounded decision-memory packet for the next decision. Replayed requests may refresh memory without new scientific work.',
          Type.Object({...program, requestId: text()}), async (input,signal)=>this.decisionMemoryRefreshResult('evaluate_trial',await this.evaluateTrial(input,signal)))
        evaluate.onDelivery=delivery=>this.contextReader.acknowledgeDelivery(delivery)
        return evaluate
      })(),
      (()=>{
        const readMemory=tool('read_decision_memory','Refresh a small exact packet from the current frozen experiment ledger. Coverage, selected facts, omissions and hashes remain explicit. If a size gap persists at the minimum selection, use read_context and paged archive retrieval.',
          Type.Object({maxFacts:Type.Optional(Type.Integer({minimum:1,maximum:4})),maxInterpretations:Type.Optional(Type.Integer({minimum:1,maximum:4})),
            question:Type.Optional(Type.String({maxLength:400})),intent:Type.Optional(Type.String({maxLength:80})),configurationFamilyFingerprint:Type.Optional(Type.String({maxLength:200})),
            evidenceRefs:Type.Optional(Type.Array(Type.String({maxLength:200}),{maxItems:20}))},{additionalProperties:false}),
          input=>this.decisionMemoryRefreshResult('read_decision_memory',undefined,input))
        readMemory.onDelivery=delivery=>this.contextReader.acknowledgeDelivery(delivery)
        return readMemory
      })(),
      tool('review_result', 'Record scientific interpretation using this run’s verified measurements. Include runId, expectedRevision, finding, interpretation, predictionAssessment, remainingExplanations, limitations, nextDecision and evidenceRefs.', reviewParameters, input => this.reviewResult(input)),
      tool('branches', 'List, save, restore or change the status of executable alternatives. Ordinary file authoring is sufficient; saving is optional.', Type.Any(), input => this.branches(input)),
      tool('request_research', 'Record an advisory unresolved question for separate research processing. purpose defaults to empirical_test; knowledge_lookup may annotate a host-validated branch with prerequisiteBranchId but never blocks discovery. Continue empirical work within the existing grant. Cite scoped evidenceRefs from EVIDENCE.json or read_context; review interpretation IDs are not measurement references. Assessed questions require using their saved assessment to choose another intervention.', Type.Object({purpose: Type.Optional(Type.Union([Type.Literal('empirical_test'), Type.Literal('knowledge_lookup')])), prerequisiteBranchId: Type.Optional(text()), question: text(), competingExplanations: Type.Array(text(), {minItems: 2, maxItems: 6}), requiredEvidence: text(), applicabilityChecks: text(), decisionIfResolved: text(), evidenceRefs: Type.Optional(Type.Array(text()))}), input => this.requestResearch(input)),
      tool('stop_discovery', 'Pause this experiment for a scientific condition supported by scoped evidence, while empirical allowance remains. This permanently binds future batches until host reactivation. Job/batch allowance exhaustion, normal prose completion, runtime limits and research questions are host scheduling boundaries, never scientific stop conditions. Cite scoped evidenceRefs from EVIDENCE.json or read_context; scientist review IDs are interpretations, not measurement references.', Type.Object({basis:Type.Union([Type.Literal('objective_satisfied'),Type.Literal('futility'),Type.Literal('no_justified_intervention')]),reason: text(), rationale: text(), evidenceRefs: Type.Array(text(),{minItems:1})}), input => this.stop(input)),
    ]
    return tools.filter(tool=>(this.options.allowScientificStop!==false||tool.name!=='stop_discovery')&&(options.legacyAliases||!['read_file','write_file','edit_file'].includes(tool.name)))
  }
}
