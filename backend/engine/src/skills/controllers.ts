import {NativeFeedbackController} from '../feedback'
import {PiSessionHost,type SessionHostBaseline} from '../session-host'
import {ResearchScientistMemory} from '@autofold/science-core/scientist-memory'
import {prepareDecisionMemory,publishDecisionMemory,snapshotHistory,decisionMemoryExposure} from '../decision-memory'
import {DecisionMemory} from '@autofold/science-core/decision-memory'
import {JobInterrupted} from '../jobs/lease'
import {AuxiliaryProjectionPendingError,AuxiliaryOperation} from '../operations/auxiliary-state'
import {readAuxiliaryState,assertRecoveryJob,exactRecoverySession,recoveryCost,unresolvedRecovery,sameIdentity,terminalAccounting} from '../operations/auxiliary-recovery'
import {canonicalOperationJSON,operationHash,type OperationDomain} from '@autofold/science-core/operations'
import type {RecoveryOutcome} from '../jobs/operation'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import {ScientificWorkspace} from '../scientist/workspace'
import {inspectScientificProgram} from '../scientist/admission'
import {scientistApi,NATIVE_AUTHORING_GUIDANCE} from '../scientist/resources'
import z from 'zod'
import { Type } from 'typebox'
import type { RuntimeTool } from '../runtime'
import { ResearchDomain } from '@autofold/science-core/domain'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchPrograms } from '@autofold/science-core/programs'
import {generationSeed as deriveGenerationSeed} from '@autofold/science-core/research/generation-seed'
import { ResearchSkills } from '@autofold/science-core/research-skills'
import { CampaignEvidence } from '@autofold/science-core/campaign-evidence'
import {TrialReasoning} from '@autofold/science-core/trial-reasoning'
import {emptyResearchState,type ResearchStore,type ResearchState} from '@autofold/science-core/store'
import { ScientificExecution } from '../execution'
import { checkedPath } from '../execution/paths'
import {captureReferenceFiles, verifyFrozenReference, type FrozenReferenceFile} from './references'
import { DEFAULT_MODEL_SELECTION, createSessionStore, assertSessionAccountingComplete, type AgentRuntimeOptions } from '../runtime'
import { CampaignSkillService, CampaignSkills, loadSnapshotSkill } from './service'
export interface SkillLifecycle {checkpoint(phase: string, data: unknown): Promise<unknown>; readCheckpoint(phase: string): Promise<any | undefined>; checkCancelled(): Promise<unknown> | unknown}
export interface SkillControllerOptions {workspace: string; projectId: string; research: ResearchService.Service; store: ResearchStore; sessionDirectory: string;
  execution: ScientificExecution; runtimeOptions?: Omit<AgentRuntimeOptions, 'store' | 'tools' | 'modelSelection'>;
  /** Test/plumbing-only authority; native scientific programs remain the default. */ allowMockPrograms?: boolean}
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const Identity = z.object({operationId: z.string().trim().min(1).max(500).optional(), jobId: z.string().startsWith('job_').optional(),
  modelBudgetUsd: z.number().finite().positive().max(100).default(2), modelSelection: z.object({provider: z.string().min(1), modelId: z.string().min(1)}).default(DEFAULT_MODEL_SELECTION)})
const RefinementInput = Identity.extend({campaignId: z.string().startsWith('cmp_'), skillId: ResearchSkills.Reference.shape.id,
  trajectoryRefs: z.array(z.string().min(1).max(500)).min(1).max(30)})
const ReplayInput = Identity.extend({campaignId: z.string().startsWith('cmp_'), validationCampaignId: z.string().startsWith('cmp_').optional(),
  experimentId: z.string().startsWith('exp_'), candidateVersionId: z.string().startsWith('skv_'), repetitions: z.number().int().min(3).max(5).default(3)})
export type CapabilityRefinementInput = z.input<typeof RefinementInput>
export type SkillShadowReplayInput = z.input<typeof ReplayInput>
type BudgetBaseline=SessionHostBaseline
class SkillAuthoringFailure extends Error {
  constructor(message:string){super(message);this.name='SkillAuthoringFailure'}
}
class Operation {
  readonly sessions: ReturnType<typeof createSessionStore>; readonly signal: AbortSignal; readonly key: string; readonly jobId: string
  private constructor(readonly options: SkillControllerOptions, readonly kind: string, readonly operationId: string, readonly input: unknown, readonly canonical:AuxiliaryOperation, readonly lifecycle?: SkillLifecycle, readonly origin?: {jobId: string; leaseId: string}) {
    if (!path.isAbsolute(options.workspace) || !path.isAbsolute(options.sessionDirectory)) throw new Error('Skill operation requires absolute host paths')
    this.key = hash(options.projectId + ':' + kind + ':' + operationId); this.jobId = 'job_skill_' + this.key
    this.sessions = createSessionStore(path.join(options.sessionDirectory, 'sessions.sqlite')); this.signal=canonical.signal
  }
  static async open(options: SkillControllerOptions, kind: string, input: z.output<typeof Identity>, lifecycle?: SkillLifecycle, signal?: AbortSignal, origin?: {jobId: string; leaseId: string}) {
    const id = input.operationId ?? input.jobId
    if (!id) throw new Error('Skills require a stable operationId or jobId')
    const key=hash(options.projectId+':'+kind+':'+id)
    const raw=input as any,data=kind==='shadow'?await options.store.read(options.projectId):undefined
    const authoring=Math.min(600_000,options.runtimeOptions?.limits?.maxDurationMs??600_000),duration=kind==='shadow'?(authoring+(data?.experiments[raw.experimentId]?.contract.budget.wallTimeMinutes??0)*60_000)*raw.repetitions*2:authoring
    const canonical=await AuxiliaryOperation.open(options,{maxDurationMs:duration,id:'op_'+key,kind:kind==='refinement'?'capability_refinement':'skill_shadow_replay',identity:input,origin,scientificOriginJobId:input.jobId??'job_skill_'+key,signal,projection:await checkedPath(options.workspace,'.autofold/skills/operations/'+key+'/state.json')})
    return new Operation(options,kind,id,input,canonical,lifecycle,origin)
  }
  async check() {await this.canonical.check(); await this.lifecycle?.checkCancelled(); await this.canonical.check()}
  async checkpoint(phase: string, data: unknown) {await this.check(); await this.lifecycle?.checkpoint('skill:' + this.key + ':' + phase, data)}
  async read<T>(): Promise<T | undefined> {
    const value=this.canonical.state<any>()
    if (value && (value.format !== 'autofold.pi-skills.v1' || !sameIdentity(value.input,this.input))) throw new Error('Skill operation is bound to another immutable request')
    if(value?.terminalEvidence&&value.terminalEvidence.outcome!=='succeeded')throw new Error(value.terminalEvidence.reason??'Original skill operation terminated '+value.terminalEvidence.outcome)
    return value as T|undefined
  }
  async save(data:unknown) {await this.check();const value=data as any;await this.canonical.save(value,value.result?'committed':this.kind==='refinement'&&value.markdown?'accepted':'authoring')}
  get authority(){return this.canonical.authority}
  async prepareScientificDispatch(requestId:string){await this.canonical.prepareScientificDispatch(requestId)}
  async accounting(baselines:Record<string,BudgetBaseline>,modelCostUsd:number){return terminalAccounting(this.options,{jobId:this.origin?.jobId,modelCostUsd,sessionIds:Object.keys(baselines),fixture:this.options.runtimeOptions?.accountingProvenance==='offline_fixture',baselineCostUsd:Object.fromEntries(Object.entries(baselines).map(([id,entry])=>[id,entry.costUsd])),originalRequestIds:Object.fromEntries(Object.entries(baselines).filter(([,entry])=>entry.originalRequestIds!==undefined).map(([id,entry])=>[id,entry.originalRequestIds!]))})}
  async complete(data:unknown){
    await this.check();const state=data as any
    if(this.canonical.state<any>()?.terminalEvidence?.outcome==='succeeded')return
    const baselines=state.baselines??{},modelCostUsd=await this.cost(baselines)
    const receiptIds=[state.result?.id,...Object.values(state.arms??{}).map((arm:any)=>arm.runId)].filter((id):id is string=>typeof id==='string')
    await this.canonical.complete(state,{outcome:'succeeded',effects:{kind:'receipts',receiptIds},accounting:await this.accounting(baselines,modelCostUsd)})
  }
  async recordFailure(error:unknown){
    if(error instanceof JobInterrupted||error instanceof AuxiliaryProjectionPendingError||this.signal.reason instanceof JobInterrupted)return
    const record=await this.canonical.service.read(this.options.projectId,this.authority.operationId)
    if(!record||record.state.terminalEvidence)return
    const state=record.state as any,baselines=state.baselines??{}
    let effects:OperationDomain.TerminalInput['effects'],outcome:'failed'|'cancelled'=this.signal.aborted?'cancelled':'failed'
    if(record.scientificDispatch?.status==='not_started'){
      // An accepted domain handoff may still need its original deterministic
      // commit after an interruption; it is not failed authoring.
      if(state.markdown||state.result||Object.values(state.arms??{}).some((arm:any)=>arm.proposal))return
      effects={kind:'none',originalJobId:record.jobId??record.scientificDispatch.originalJobId,requestIds:[]}
    }else{
      const data=await this.options.store.read(this.options.projectId),originalJobId=(this.input as any).jobId??this.jobId
      const candidate=data.skillVersions[(this.input as any).candidateVersionId]
      if(state.result||(candidate?.validations as ResearchDomain.SkillReplay[]|undefined)?.some(validation=>validation.benchmarkId===state.benchmarkId))return
      const runs=Object.values(data.runs).filter(run=>data.trials[run.trialId]?.origin?.jobId===originalJobId)
      const preparedIds=new Set((record.scientificDispatch?.requestIds??[]).map(requestId=>'run_'+hash(this.options.projectId+':'+requestId)))
      if(!runs.length||runs.some(run=>!['succeeded','failed','cancelled'].includes(run.status)||!preparedIds.has(run.id))||[...preparedIds].some(id=>!runs.some(run=>run.id===id)))return
      const authoringFailure=error instanceof SkillAuthoringFailure
      if(runs.every(run=>run.status==='succeeded')&&!authoringFailure&&!this.signal.aborted)return
      const receiptIds:string[]=[]
      for(const run of runs){
        if(run.status==='succeeded'){const receipt=await this.options.execution.artifacts(run.id);receiptIds.push(receipt.run.id)}
        else {const receipt=await this.options.execution.failureReceipt(run.id);receiptIds.push(receipt.runId,receipt.receiptId);if(receipt.status==='cancelled')outcome='cancelled'}
      }
      effects={kind:'receipts',receiptIds}
    }
    let accounting:OperationDomain.TerminalInput['accounting']
    try{accounting=await this.accounting(baselines,await this.cost(baselines))}catch(problem){accounting={kind:'unknown',detail:problem instanceof Error?problem.message:String(problem)}}
    const reason=error instanceof Error?error.message:String(error)
    await this.canonical.close()
    await AuxiliaryOperation.settleTerminal(this.options,record.id,{terminalStatus:outcome,error:reason},
      {outcome,reason,effects,accounting})
  }
  async model(sessionId: string, metadata: Record<string, unknown>, prompt: unknown, systemPrompt: string, tools: RuntimeTool<any>[], stopTool: string, budget: number, baselines: Record<string, BudgetBaseline>, save: () => Promise<void>, resources?:AgentRuntimeOptions['resources'],onInferenceContext?:AgentRuntimeOptions['onInferenceContext']) {
    const host=new PiSessionHost({store:this.sessions,sessionId,metadata,metadataPolicy:'exact',modelSelection:(this.input as any).modelSelection,
      operationId:this.authority.operationId,jobId:this.origin?.jobId,inputHash:'sha256:'+hash(JSON.stringify(this.input)),signal:this.signal,
      checkNewWork:async signal=>{
      if(this.authority.mode!=='run')throw new Error('Settled skill operations cannot authorize model requests')
      await this.check()
      if (this.origin) await this.options.research.assertTrustedJobLease(this.options.projectId, this.origin, {newWork:true})
      signal.throwIfAborted()
    },runtimeOptions:{...this.options.runtimeOptions,tools,...(resources?{resources}:{}),systemPrompt,stopToolNames:[stopTool],
      onInferenceContext:async request=>{await this.options.runtimeOptions?.onInferenceContext?.(request);await onInferenceContext?.(request)}}})
    const session=await host.open()
    const authorized = {maxTurns: Math.min(24, this.options.runtimeOptions?.limits?.maxTurns ?? 12), maxToolCalls: Math.min(48, this.options.runtimeOptions?.limits?.maxToolCalls ?? 12),
      maxDurationMs: Math.min(600_000, this.options.runtimeOptions?.limits?.maxDurationMs ?? 600_000)}
    baselines[sessionId] ??= host.baseline(session,authorized.maxDurationMs);await save()
    let remainingLimits:ReturnType<PiSessionHost['remaining']>
    try{remainingLimits=host.remaining(session,baselines[sessionId],{maxCostUsd:budget,...authorized})}catch(error){throw new SkillAuthoringFailure(error instanceof Error?error.message:String(error))}
    await this.check(); const result = await host.run(JSON.stringify(prompt),remainingLimits,{signal:this.signal,promptOrigin:'host_context'}); await this.check()
    return result
  }
  async cost(baselines: Record<string, BudgetBaseline>) {
    let total = 0
    for(const [id,baseline] of Object.entries(baselines)){const session=await this.sessions.get(id);if(!session||session.usage.costUsd<baseline.costUsd)throw new Error('Skill model usage lost or reset');assertSessionAccountingComplete(session);total+=session.usage.costUsd-baseline.costUsd}
    return total
  }
  async close() {this.sessions.close();await this.canonical.close()}
}
const tool = (name: string, parameters: any, execute: (args: any) => Promise<unknown>): RuntimeTool<any> => ({name, label: name, description: name.replaceAll('_', ' '), parameters,
  executionMode: 'sequential', replay: 'never', execute: async (_id, args, signal) => {signal?.throwIfAborted(); const result = await execute(args); return {content: [{type: 'text', text: JSON.stringify(result)}], details: result}}})
function terminalFailureRecovery(record:OperationDomain.Record|undefined,identity:unknown):RecoveryOutcome|undefined {
  const evidence=record?.state.terminalEvidence as OperationDomain.TerminalEvidence|undefined
  if(!record||!evidence||evidence.outcome==='succeeded')return
  if(!sameIdentity(record.identity,identity)||evidence.operationId!==record.id||evidence.identityHash!==record.identityHash)throw new Error('Original terminal evidence identity differs')
  if(record.settlement!=='settled')return {kind:'unresolved',effects:evidence.effects.kind==='unknown'?evidence.effects.originalIds:[],accounting:evidence.accounting.kind==='unknown'?[evidence.accounting.detail]:[],blockers:['Original skill failure has unresolved effects or provider billing']}
  const terminalStatus=evidence.outcome
  return {kind:'complete',terminalStatus,error:evidence.reason,receiptIds:evidence.effects.kind==='receipts'?evidence.effects.receiptIds:[],
    result:{terminalStatus,error:evidence.reason,modelCostUsd:evidence.accounting.kind==='known'?evidence.accounting.modelCostUsd:0,scientificStatus:'unevaluated'}}
}
interface RefinementState {authoringProtocol?:'autofold.decision-memory.v1';format: 'autofold.pi-skills.v1'; input: z.output<typeof RefinementInput>; baselines: Record<string,BudgetBaseline>; context: unknown; parentId: string; parentHash: string; nextVersion: number; markdown?: string; result?: ResearchDomain.SkillVersion}
export class CapabilityRefinementController {
  readonly skills: CampaignSkillService
  constructor(readonly options: SkillControllerOptions) {this.skills = new CampaignSkillService(options)}
  async recover(job:ResearchDomain.Job,signal?:AbortSignal):Promise<RecoveryOutcome> {
    try {
      signal?.throwIfAborted();assertRecoveryJob(this.options,job,'capability_refinement')
      if(job.payload.kind!=='capability_refinement')throw new Error('Wrong auxiliary kind')
      const input=RefinementInput.parse({jobId:job.id,campaignId:job.payload.campaignId,skillId:job.payload.skillId,trajectoryRefs:job.payload.trajectoryRefs,modelBudgetUsd:job.payload.modelBudgetUsd,modelSelection:job.payload.modelSelection})
      const key=hash(this.options.projectId+':refinement:'+job.id),actor='autofold-pi-refinement/v1:'+key
      const {state}=await readAuxiliaryState<RefinementState>(this.options,'op_'+key,await checkedPath(this.options.workspace,'.autofold/skills/operations/'+key+'/state.json'))
      const data=await this.options.store.read(this.options.projectId),terminal=terminalFailureRecovery(data.operations['op_'+key],input);if(terminal)return terminal
      const versions=Object.values(data.skillVersions).filter(v=>v.origin?.jobId===job.id&&v.origin.phase==='skill:proposal')
      if(!versions.length)return{kind:'incomplete',boundary:state?.markdown?'accepted_skill_proposal_without_native_commit':'refinement_authoring_incomplete'}
      if(versions.length!==1||!state?.markdown||!sameIdentity(state.input,input))throw new Error('Refinement native receipt lacks exact original proposal')
      const version=versions[0]!,skill=ResearchSkills.parseMarkdown(state.markdown),parent=data.skillVersions[state.parentId]
      if(version.campaignId!==input.campaignId||version.skillId!==input.skillId||version.parentVersionId!==state.parentId||version.contentHash!==skill.contentHash||version.createdBy!==actor||version.version!==state.nextVersion||parent?.contentHash!==state.parentHash||!sameIdentity(version.trajectoryRefs,input.trajectoryRefs))throw new Error('Refinement canonical version identity differs')
      const immutable=await this.skills.loadVersion(input.campaignId,version.id)
      if(immutable.contentHash!==version.contentHash)throw new Error('Refinement immutable Markdown receipt changed')
      await exactRecoverySession(this.options,job,'ses_refinement_'+key,{campaignId:input.campaignId,parentId:state.parentId,parentHash:state.parentHash,operationId:job.id})
      const modelCostUsd=await recoveryCost(this.options,job);signal?.throwIfAborted()
      const outcome:RecoveryOutcome={kind:'complete',receiptIds:[version.id],result:{version:{...version,modelCostUsd},modelCostUsd}}
      await AuxiliaryOperation.settleTerminal(this.options,'op_'+key,outcome.result,{outcome:'succeeded',effects:{kind:'receipts',receiptIds:outcome.receiptIds},accounting:await terminalAccounting(this.options,{jobId:job.id,modelCostUsd,sessionIds:Object.keys(state.baselines),fixture:this.options.runtimeOptions?.accountingProvenance==='offline_fixture'})});return outcome
    }catch(error){return unresolvedRecovery(error)}
  }
  async run(raw: CapabilityRefinementInput, lifecycle?: SkillLifecycle, run: {signal?: AbortSignal; origin?: {jobId: string; leaseId: string}} = {}) {
    const input = RefinementInput.parse(raw), operation = await Operation.open(this.options, 'refinement', input, lifecycle, run.signal, run.origin)
    try {
      let state = await operation.read<RefinementState>()
      if (!state) {
        await this.skills.initialize(input.campaignId)
        const data = await this.options.store.read(this.options.projectId), campaign = data.campaigns[input.campaignId]
        if (!campaign || campaign.projectId !== this.options.projectId || campaign.status !== 'active') throw new Error('Skill campaign is outside the active host project')
        const catalog = CampaignEvidence.resolve(data, {campaignId: campaign.id}); catalog.assert(input.trajectoryRefs, 'Refinement evidence')
        const versions = Object.values(data.skillVersions).filter(version=>version.campaignId===campaign.id), parent = versions.find(version => version.skillId === input.skillId && version.status === 'active')
        if (!parent) throw new Error('No active parent domain skill')
        const skill = await loadSnapshotSkill(this.options.workspace,parent)
        const evidence = input.trajectoryRefs.map(id => ({reference: catalog.get(id), record: Object.values(data).flatMap(table => typeof table === 'object' && table ? Object.values(table) : []).find((item: any) => item?.id === id)}))
        const runIds=new Set(Object.values(data.runs).filter(run=>input.trajectoryRefs.includes(run.id)||input.trajectoryRefs.includes(run.trialId)).map(run=>run.id))
        const projection=runIds.size?await new NativeFeedbackController(this.options).collect(campaign.id,data,runIds):undefined
        const experimentIds=[...new Set([...runIds].flatMap(runId=>data.trials[data.runs[runId]!.trialId]?.experimentId??[]))]
        const scopedData=structuredClone(data),trialIds=new Set([...runIds].map(id=>data.runs[id]!.trialId))
        scopedData.runs=Object.fromEntries(Object.entries(data.runs).filter(([id])=>runIds.has(id)))
        scopedData.trials=Object.fromEntries(Object.entries(data.trials).filter(([id])=>trialIds.has(id)))
        scopedData.evaluations=Object.fromEntries(Object.entries(data.evaluations).filter(([,row])=>trialIds.has(row.trialId)))
        scopedData.searchObservations=Object.fromEntries(Object.entries(data.searchObservations).filter(([,row])=>runIds.has(row.runId)))
        scopedData.knowledge=Object.fromEntries(Object.entries(data.knowledge).filter(([,row])=>!row.runId||runIds.has(row.runId)))
        scopedData.scientistReviews=Object.fromEntries(Object.entries(data.scientistReviews).filter(([,row])=>runIds.has(row.runId)))
        const decisionMemory=await Promise.all(experimentIds.map(async experimentId=>{
          const legacyEvents=(await ResearchScientistMemory.read(this.options.workspace,experimentId)).filter(event=>runIds.has(event.runId))
          return (await prepareDecisionMemory({...this.options,state:scopedData,campaignId:campaign.id,experimentId,guideIds:[parent.id],legacyEvents})).packet
        }))
        const proceduralEvidence={decisionMemory,hostFeedback:projection?.recentSkillFeedback??[],authority:'Verified receipts supply observations; interpretations cannot establish measurements.'}
        state = {authoringProtocol:'autofold.decision-memory.v1',format: 'autofold.pi-skills.v1', input, baselines: {}, context: {campaign, parent: skill, evidence,proceduralEvidence}, parentId: parent.id, parentHash: parent.contentHash,
          nextVersion: Math.max(...versions.filter(value => value.skillId === input.skillId).map(value => value.version)) + 1}
        await operation.checkpoint('context', state); await operation.save(state)
      }
      const current = state
      if(current.result&&operation.authority.mode==='settle'){await this.skills.loadVersion(input.campaignId,current.result.id);return {...current.result,modelCostUsd:await operation.cost(current.baselines)}}
      const save = () => operation.save(current)
      if (!current.markdown) {
        if(current.authoringProtocol!=='autofold.decision-memory.v1')throw new Error('Historical refinement context is receipt-only; new decision-memory authoring requires a new operation')
        const submit = tool('submit_skill', Type.Object({markdown: Type.String({minLength: 1, maxLength: 100000})}, {additionalProperties: false}), async args => {
          await operation.check(); const parsed = ResearchSkills.parseMarkdown(args.markdown), parent = (current.context as any).parent
          if (parsed.id !== input.skillId || parsed.version !== current.nextVersion || JSON.stringify(parsed.source) !== JSON.stringify(parent.source) || JSON.stringify(parsed.capabilities) !== JSON.stringify(parent.capabilities) || JSON.stringify(parsed.appliesToToolKeys) !== JSON.stringify(parent.appliesToToolKeys)) throw new Error('Refinement must preserve exact attributed source, scope, capabilities and next immutable version')
          await operation.checkpoint('proposal', {markdown: args.markdown, contentHash: parsed.contentHash}); current.markdown = args.markdown; await save(); return {accepted: true, contentHash: parsed.contentHash}
        })
        const result = await operation.model('ses_refinement_' + operation.key, {projectId: this.options.projectId, campaignId: input.campaignId, parentId: current.parentId, parentHash: current.parentHash, operationId: operation.operationId},
          {context: current.context, nextVersion: current.nextVersion}, `Refine one attributed domain knowledge skill using only the frozen supplied evidence. Use proceduralEvidence.decisionMemory verified facts, structured condition/design comparisons and scoped interpretations; interpretations are not measurements. Propose one concrete procedural decision change and its falsifying observation. Preserve the exact id, source attribution, capabilities and applies_to, then increment to ${current.nextVersion}. Use this canonical YAML shape, retaining the quoted parent metadata exactly except title and version:\n${skillFrontmatterGuide((current.context as any).parent,current.nextVersion)}\nInclude sections exactly named Guidance, Failure modes and Falsifying questions. If submit_skill returns a parsing error, repair the named YAML field or heading and resubmit; do not remove attribution or required sections. Interpretations must not claim biological validation. No runtime, endpoints, shell, credentials or installation instructions. Submit complete Markdown via submit_skill. You cannot author scores, activate skills, change contracts or grant compute.`, [submit], 'submit_skill', input.modelBudgetUsd, current.baselines, save)
        if (!current.markdown) throw new SkillAuthoringFailure('Refinement ended ' + result.status + ' without an accepted attributed proposal')
      }
      await operation.check()
      current.result ??= await this.skills.propose(input.campaignId, input.skillId, {parentVersionId: current.parentId, markdown: current.markdown,
        trajectoryRefs: input.trajectoryRefs, createdBy: 'autofold-pi-refinement/v1:' + operation.key, origin: {jobId: input.jobId ?? operation.jobId, phase: 'skill:proposal'}}, operation.origin,operation.authority)
      await save(); await operation.checkpoint('proposed', current.result)
      const modelCostUsd=await operation.cost(current.baselines);await operation.complete(current)
      return {...current.result, modelCostUsd}
    } catch(error){try{await operation.recordFailure(error)}catch{}throw error} finally {await operation.close()}
  }
}
const GuidanceApplication=z.object({guidanceQuote:z.string().trim().min(20).max(600),programDecision:z.string().trim().min(20).max(2000),falsifyingObservation:z.string().trim().min(20).max(2000)}).strict()
function skillFrontmatterGuide(parent:ResearchSkills.DomainKnowledge,nextVersion:number) {
  const yaml=(value:string)=>JSON.stringify(value)
  return ['---',`id: ${parent.id}`,`version: ${nextVersion}`,`title: ${yaml(parent.title)}`,
    `capabilities: [${parent.capabilities.map(yaml).join(', ')}]`,`applies_to: [${parent.appliesToToolKeys.map(yaml).join(', ')}]`,'source:',
    `  repository: ${yaml(parent.source.repository)}`,`  commit: ${yaml(parent.source.commit)}`,
    `  paths: [${parent.source.paths.map(yaml).join(', ')}]`,`  license: ${yaml(parent.source.license)}`,
    `  attribution: ${yaml(parent.source.attribution)}`,'---'].join('\n')
}
interface ArmState {guidanceApplication?:z.infer<typeof GuidanceApplication>&{skill:ResearchSkills.Reference;programHash:string};sessionId: string; generationSeed?:number; requestId: string; originPhase: string; proposal?: ResearchService.CreateTrialInput; trialId?: string; runId?: string}
/** Freeze only scientific admission records. Operational state must never recurse
 * through earlier replay snapshots or expose another campaign's context. */
function freezeReplayAdmission(state:ResearchState,experiment:ResearchDomain.Experiment):ResearchState {
  const frozen=emptyResearchState(),catalog=CampaignEvidence.resolve(state,{campaignId:experiment.campaignId,experimentId:experiment.id})
  for(const table of ['campaigns','experiments','trials','evaluations','runs','knowledge','literature','claims','alignments','knowledgeCycles','campaignCharters','hypotheses','searchObservations','researchRequests','skillVersions'] as const){
    (frozen[table] as Record<string,unknown>)=Object.fromEntries(Object.entries(state[table]).filter(([id])=>catalog.has(id)))
  }
  frozen.jobs=Object.fromEntries(Object.entries(state.jobs).filter(([id])=>catalog.has(id)).map(([id,job])=>[id,{...job,checkpoints:{},result:undefined}]))
  frozen.experimentBranches=Object.fromEntries(Object.entries(state.experimentBranches).filter(([,branch])=>branch.experimentId===experiment.id&&branch.campaignId===experiment.campaignId))
  return structuredClone(frozen)
}
interface ReplayState {scientificInputHash?:string;authoringProtocol?:'autofold.native-authoring.v1'|'autofold.native-authoring.v2';format: 'autofold.pi-skills.v1'; input: z.output<typeof ReplayInput>; baselines: Record<string,BudgetBaseline>; benchmarkId: string; context: {campaign: ResearchDomain.Campaign; experiment: ResearchDomain.Experiment; parent: ResearchSkills.DomainKnowledge & {versionId: string}; candidate: ResearchSkills.DomainKnowledge & {versionId: string}; evidenceRefs: string[]; history: unknown; decisionMemory?:DecisionMemory.Packet; sourceManifest?:DecisionMemory.SourceManifest; memoryFiles?:{name:string;path:string;hash:string}[]; admissionState?:ResearchState; executionCapabilities?: Awaited<ReturnType<ScientificExecution['capabilities']>>; reference: string; referenceFiles?: FrozenReferenceFile[]}; arms: Record<string, ArmState>; result?: ResearchDomain.SkillVersion}
const replayInputHash=(context:ReplayState['context'])=>'sha256:'+hash(JSON.stringify(context))
export class SkillShadowReplayController {
  readonly skills: CampaignSkillService
  constructor(readonly options: SkillControllerOptions) {this.skills = new CampaignSkillService(options)}
  async recover(job:ResearchDomain.Job,signal?:AbortSignal):Promise<RecoveryOutcome> {
    try {
      signal?.throwIfAborted();assertRecoveryJob(this.options,job,'skill_shadow_replay')
      if(job.payload.kind!=='skill_shadow_replay')throw new Error('Wrong auxiliary kind')
      const input=ReplayInput.parse({jobId:job.id,campaignId:job.payload.campaignId,validationCampaignId:job.payload.validationCampaignId,experimentId:job.payload.experimentId,candidateVersionId:job.payload.candidateVersionId,repetitions:job.payload.repetitions,modelBudgetUsd:job.payload.modelBudgetUsd,modelSelection:job.payload.modelSelection})
      const key=hash(this.options.projectId+':shadow:'+job.id),benchmarkId='shadow-pi-v1:'+key
      const {state}=await readAuxiliaryState<ReplayState>(this.options,'op_'+key,await checkedPath(this.options.workspace,'.autofold/skills/operations/'+key+'/state.json'))
      const data=await this.options.store.read(this.options.projectId),terminal=terminalFailureRecovery(data.operations['op_'+key],input);if(terminal)return terminal
      const candidate=data.skillVersions[input.candidateVersionId]
      const validation=(candidate?.validations as ResearchDomain.SkillReplay[]|undefined)?.find(v=>v.benchmarkId===benchmarkId)
      if(!validation)return{kind:'incomplete',boundary:'shadow_replay_has_no_native_activation_receipt'}
      if(!state||!sameIdentity(state.input,input)||state.benchmarkId!==benchmarkId||candidate?.campaignId!==input.campaignId||candidate.contentHash!==state.context.candidate.contentHash||validation.candidateVersionId!==candidate.id||validation.baselineVersionId!==state.context.parent.versionId||validation.experimentId!==input.experimentId||validation.contractHash!==state.context.experiment.contractHash||validation.contractHash!==job.payload.contractHash||!validation.campaignIds.includes(state.context.campaign.id))throw new Error('Replay canonical benchmark identity differs')
      const pairs=validation.receiptPairs as {parent:{runId:string;sessionId:string};candidate:{runId:string;sessionId:string}}[]|undefined
      if(!pairs||pairs.length!==input.repetitions)throw new Error('Replay original paired receipts missing')
      const sessions=new Set<string>(),runs=new Set<string>(),programs=new Set<string>(),receiptIds=[candidate.id]
      for(let index=0;index<pairs.length;index++)for(const arm of ['parent','candidate'] as const){
        signal?.throwIfAborted();const receipt=pairs[index]![arm],slot=state.arms[(index+1)+':'+arm],skill=state.context[arm]
        const expectedSession='ses_shadow_'+hash(`${key}:${index+1}:${arm}`)
        if(!slot?.proposal||slot.sessionId!==expectedSession||receipt.sessionId!==expectedSession||slot.runId!==receipt.runId)throw new Error('Replay original arm identity differs')
        await exactRecoverySession(this.options,job,receipt.sessionId,{campaignId:state.context.campaign.id,experimentId:input.experimentId,contractHash:validation.contractHash,skillVersionId:skill.versionId,shadowArm:arm,benchmarkId,originJobId:job.id,originPhase:slot.originPhase,...(state.authoringProtocol?{authoringProtocol:state.authoringProtocol,scientificInputHash:state.scientificInputHash,cwd:path.resolve(this.options.workspace,'.autofold/skills/operations/'+key+'/arms/'+(index+1)+'-'+arm)}:{})})
        // artifacts() is a verified immutable receipt reader; it cannot launch work.
        const artifacts=await this.options.execution.artifacts(receipt.runId),trial=artifacts.trial
        const lineage=Object.values(data.knowledge).filter(record=>record.type==='Research Evaluation'&&record.runId===receipt.runId&&record.trialId===trial.id)
        const evaluation=lineage.length===1&&lineage[0]!.evaluationId?data.evaluations[lineage[0]!.evaluationId!]:undefined
        if(!evaluation||evaluation.trialId!==trial.id||!sameIdentity({contractHash:evaluation.contractHash,evaluatorHash:evaluation.evaluatorHash,valid:evaluation.valid,score:evaluation.score,diagnostics:evaluation.diagnostics},{contractHash:artifacts.evaluation.contractHash,evaluatorHash:artifacts.evaluation.evaluatorHash,valid:artifacts.evaluation.valid,score:artifacts.evaluation.score,diagnostics:artifacts.evaluation.diagnostics}))throw new Error('Replay original evaluation differs from immutable receipt')
        if(trial.id!==slot.trialId||trial.origin?.jobId!==job.id||trial.origin.phase!==slot.originPhase||trial.programHash!==slot.proposal.programHash||trial.experimentId!==input.experimentId||trial.intent!=='shadow_replay'||artifacts.evaluation.contractHash!==validation.contractHash||!trial.skills.some(ref=>ref.versionId===skill.versionId&&ref.contentHash===skill.contentHash)||sessions.has(receipt.sessionId)||runs.has(receipt.runId)||programs.has(trial.programHash))throw new Error('Replay verified receipt linkage or independence differs')
        if(slot.guidanceApplication){
          const {skill:reference,programHash,...application}=slot.guidanceApplication
          GuidanceApplication.parse(application)
          if(programHash!==trial.programHash||!sameIdentity(reference,ResearchSkills.reference(skill))||!skill.content.includes(application.guidanceQuote))throw new Error('Original guidance application differs from the frozen arm and admitted program')
        }
        sessions.add(receipt.sessionId);runs.add(receipt.runId);programs.add(trial.programHash);receiptIds.push(artifacts.run.id,evaluation.id)
      }
      const modelCostUsd=await recoveryCost(this.options,job);signal?.throwIfAborted()
      const finalStatus=state.context.campaign.id===input.campaignId?(validation.passed?'active':'rejected'):(state.result?.status??candidate.status)
      const outcome:RecoveryOutcome={kind:'complete',receiptIds,result:{modelCostUsd,campaignId:input.campaignId,validationCampaignId:state.context.campaign.id,experimentId:input.experimentId,candidateVersionId:input.candidateVersionId,pairs,replay:validation,validation,finalStatus}}
      await AuxiliaryOperation.settleTerminal(this.options,'op_'+key,outcome.result,{outcome:'succeeded',effects:{kind:'receipts',receiptIds:outcome.receiptIds},accounting:await terminalAccounting(this.options,{jobId:job.id,modelCostUsd,sessionIds:Object.keys(state.baselines),fixture:this.options.runtimeOptions?.accountingProvenance==='offline_fixture'})});return outcome
    }catch(error){return unresolvedRecovery(error)}
  }
  async run(raw: SkillShadowReplayInput, lifecycle?: SkillLifecycle, run: {signal?: AbortSignal; origin?: {jobId: string; leaseId: string}} = {}) {
    const input = ReplayInput.parse(raw), operation = await Operation.open(this.options, 'shadow', input, lifecycle, run.signal, run.origin)
    try {
      let state = await operation.read<ReplayState>()
      if (!state) {
        // Freeze the original authoritative journal before the canonical read.
        // Readiness/reference preparation cannot add later or sibling exposure.
        const legacyEvents=await ResearchScientistMemory.read(this.options.workspace,input.experimentId)
        const data = await this.options.store.read(this.options.projectId), candidate = data.skillVersions[input.candidateVersionId]
        if (!candidate?.parentVersionId || candidate.campaignId !== input.campaignId) throw new Error('Replay candidate is outside its owning campaign')
        const experiment = data.experiments[input.experimentId], campaign = experiment && data.campaigns[experiment.campaignId]
        if (!experiment || !campaign || campaign.projectId !== this.options.projectId || campaign.id !== (input.validationCampaignId ?? input.campaignId) || campaign.status !== 'active' || experiment.status !== 'active') throw new Error('Shadow replay requires the active frozen validation campaign and experiment')
        ResearchDomain.assertContractIntegrity(experiment)
        if (!this.options.allowMockPrograms) await this.options.execution.preflightExperiment(experiment, operation.signal)
        const executionCapabilities = this.options.allowMockPrograms ? undefined : await this.options.execution.capabilities()
        const reference = this.options.allowMockPrograms ? 'Mock plumbing-only trial source is never executed; bytes deterministically seed fixture candidates.' : await this.options.execution.scientistReference(this.options.workspace, '.autofold/skills/operations/' + operation.key + '/reference')
        const admissionState=freezeReplayAdmission(data,experiment)
        // History and admission share one canonical read/cutoff even if new
        // evidence arrives while host readiness and references are prepared.
        const history=snapshotHistory(admissionState,experiment)
        const commonMemory=await prepareDecisionMemory({...this.options,state:data,campaignId:campaign.id,experimentId:experiment.id,includeGuides:false,legacyEvents})
        const memoryRoot='.autofold/skills/operations/'+operation.key+'/common'
        const memoryPublicationGaps=await publishDecisionMemory(this.options.workspace,memoryRoot,commonMemory)
        const memoryFiles:{name:string;path:string;hash:string}[]=[]
        for(const name of [commonMemory.packet.expansion.ledgerPath,commonMemory.packet.expansion.archivePath,commonMemory.packet.expansion.questionsPath]){
          if(!name)continue
          if(memoryPublicationGaps[name])continue
          const relative=memoryRoot+'/'+name,bytes=await fs.readFile(await checkedPath(this.options.workspace,relative))
          memoryFiles.push({name,path:relative,hash:'sha256:'+hash(bytes.toString('utf8'))})
        }
        state = {authoringProtocol:'autofold.native-authoring.v2',format: 'autofold.pi-skills.v1', input, baselines: {}, benchmarkId: 'shadow-pi-v1:' + operation.key, arms: {}, context: {campaign, experiment,
          parent: await loadSnapshotSkill(this.options.workspace,data.skillVersions[candidate.parentVersionId]!), candidate: await loadSnapshotSkill(this.options.workspace,candidate),
          evidenceRefs: [...CampaignEvidence.resolve(data, {campaignId: campaign.id, experimentId: experiment.id}).ids()].filter(id=>!data.skillVersions[id]), history, decisionMemory:commonMemory.packet, sourceManifest:commonMemory.sourceManifest, memoryFiles, admissionState, executionCapabilities, reference,
          referenceFiles: this.options.allowMockPrograms ? [] : await captureReferenceFiles(this.options.workspace, '.autofold/skills/operations/' + operation.key + '/reference')}}
        state.scientificInputHash=replayInputHash(state.context)
        await operation.checkpoint('context', state); await operation.save(state)
      }
      const current = state, save = () => operation.save(current)
      if(current.authoringProtocol==='autofold.native-authoring.v2'){
        if(current.scientificInputHash!==replayInputHash(current.context))throw new Error('Frozen replay scientific input bytes changed')
        const packet=DecisionMemory.Packet.parse(current.context.decisionMemory),manifest=DecisionMemory.SourceManifest.parse(current.context.sourceManifest)
        if(packet.sourceManifest.manifestHash!=='sha256:'+operationHash(manifest)||packet.sourceManifest.snapshotHash!==manifest.snapshotHash||packet.proceduralGuidance.length||manifest.sources.some(source=>source.layer==='guidance'))throw new Error('Frozen replay common memory binding differs')
      }
      if(current.authoringProtocol!=='autofold.native-authoring.v2')throw new Error('Legacy replay is receipt-only; use original recovery, or a new operation for native authoring')
      if(current.result&&operation.authority.mode==='settle'){
        for(const slot of Object.values(current.arms)){if(!slot.runId)throw new Error('Completed replay lacks an original arm receipt');await this.options.execution.artifacts(slot.runId)}
        await this.skills.loadVersion(input.campaignId,current.context.parent.versionId);await this.skills.loadVersion(input.campaignId,current.context.candidate.versionId)
        return replayResult(current,await operation.cost(current.baselines))
      }
      const referenceRoot = '.autofold/skills/operations/' + operation.key + '/reference'
      const readHistory=tool('read_history',Type.Object({kind:Type.Union(['trials','runs','evaluations','knowledge'].map(value=>Type.Literal(value))),offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:8}))},{additionalProperties:false}),async args=>{
        await operation.check();const rows=(current.context.history as any)[args.kind] as unknown[],offset=args.offset??0,limit=args.limit??4
        return {kind:args.kind,items:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,scope:'Frozen common context only; no sibling replay effects'}
      })
      readHistory.description='Page original shared frozen evidence. Never reads current history or another replay arm.'
      for (let repetition = 1; repetition <= input.repetitions; repetition++) for (const arm of ['parent', 'candidate'] as const) {
        await operation.check()
        const experiment = (await this.options.store.read(this.options.projectId)).experiments[input.experimentId]
        if (experiment?.contractHash !== current.context.experiment.contractHash) throw new Error('Frozen replay contract changed')
        ResearchDomain.assertContractIntegrity(experiment)
        const key = repetition + ':' + arm, skill = current.context[arm]
        let slot = current.arms[key]
        if(!slot){
          const sessionId='ses_shadow_' + hash(operation.key + ':' + key)
          slot = {sessionId,generationSeed:deriveGenerationSeed(this.options.projectId,experiment.id,sessionId,1),requestId:'shadow:' + operation.key + ':' + key,originPhase:'shadow:' + key + ':trial'}
          current.arms[key]=slot
        }
        await save()
        if (!slot.proposal) {
          if(current.authoringProtocol!=='autofold.native-authoring.v2'||!current.context.admissionState)throw new Error('Legacy replay authoring is frozen; original accepted proposals and receipts remain recoverable, but new authoring requires a new operation')
          const root='.autofold/skills/operations/'+operation.key+'/arms/'+key.replace(':','-')
          const frozen=current.context.admissionState
          await fs.mkdir(await checkedPath(this.options.workspace,root),{recursive:true,mode:0o700})
          const template=this.options.allowMockPrograms?ResearchPrograms.templates().mock:ResearchPrograms.nativeProtoTemplate({evidenceRefs:current.context.evidenceRefs.slice(0,30),gpuHours:experiment.contract.budget.gpuHours,intent:'shadow_replay'})
          const resources:Record<string,string>={
            'NATIVE_TEMPLATE.py':template,
            'CONTRACT.json':JSON.stringify(current.context.experiment.contract,null,2),
            'EVIDENCE.json':JSON.stringify({evidenceRefs:current.context.evidenceRefs,decisionMemory:current.context.decisionMemory},null,2),
            'DECISION_MEMORY.json':JSON.stringify(current.context.decisionMemory,null,2),
            [current.context.decisionMemory!.sourceManifest.manifestPath]:canonicalOperationJSON(current.context.sourceManifest),
            'SKILL.md':skill.content,
            'API.md':scientistApi(current.context.reference),
            'DECISION_PLAN.schema.json':JSON.stringify(z.toJSONSchema(TrialReasoning.DecisionPlan),null,2),
          }
          for(const reference of current.context.memoryFiles??[]){
            const bytes=await fs.readFile(await checkedPath(this.options.workspace,reference.path))
            if('sha256:'+hash(bytes.toString('utf8'))!==reference.hash)throw new Error('Frozen replay decision-memory expansion changed')
            resources[reference.name]=bytes.toString('utf8')
          }
          for(const [name,content] of Object.entries(resources)){
            const file=await checkedPath(this.options.workspace,root+'/'+name)
            await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700})
            try{await fs.writeFile(file,content,{flag:'wx',mode:0o400})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await fs.readFile(file,'utf8')!==content)throw new Error('Frozen replay workspace resource changed')}
          }
          const workspace=new ScientificWorkspace({workspace:this.options.workspace,root,execution:this.options.execution,
            initialize:()=>operation.check(),scope:async()=>({state:frozen,experiment:current.context.experiment}),
            authorizeExternalRead:async relative=>(current.context.referenceFiles??[]).some(file=>file.path===relative),
            verifyReference:async(relative,bytes)=>{
              const name=relative.startsWith(root+'/')?relative.slice(root.length+1):undefined
              const expected=name===undefined?undefined:resources[name]
              if(expected!==undefined&&bytes.toString('utf8')!==expected)throw new Error('Frozen replay workspace resource changed')
              const file=current.context.referenceFiles?.find(file=>file.path===relative)
              if(file)verifyFrozenReference(current.context.referenceFiles!,relative,bytes)
            }})
          const inspect=async(programPath?:string,evaluation=false,captured=undefined as Awaited<ReturnType<ScientificWorkspace['capture']>>|undefined)=>{
            await operation.check();captured??=await workspace.capture(programPath)
            const admission=await inspectScientificProgram({workspace:this.options.workspace,root,execution:this.options.execution},captured,
              {state:frozen,experiment:current.context.experiment,campaign:current.context.campaign,generationSeed:slot.generationSeed,skills:[ResearchSkills.reference(skill)]},evaluation)
            if(admission.input.intent!=='shadow_replay')throw new Error('Native shadow declaration differs from the host intent')
            return {captured,admission}
          }
          const validate=tool('validate_trial',Type.Object({programPath:Type.Optional(Type.String({minLength:1,maxLength:1000}))},{additionalProperties:false}),async args=>{
            await operation.check()
            try{const {captured,admission}=await inspect(args.programPath);return {valid:true,programPath:captured.draftPath,programHash:captured.programHash,declaration:admission.input,contractHash:current.context.experiment.contractHash,pipelineHash:admission.inspected.pipelineHash}}
            catch(error){return {valid:false,error:error instanceof Error?error.message:String(error),repair:'Use native edit/write on your captured program and pinned API, then validate_trial again. No trial or scientific dispatch was created.'}}
          })
          const applicationSchema=Type.Unsafe(z.toJSONSchema(GuidanceApplication))
          let memoryExposed=false
          const acknowledgeMemory:NonNullable<AgentRuntimeOptions['onInferenceContext']>=request=>{
            if(request.sessionId!==slot.sessionId)throw new Error('Replay inference context belongs to another arm')
            for(const message of request.messages){
              const text=typeof message.content==='string'?[message.content]:message.content.filter(part=>part.type==='text').map(part=>part.text)
              for(const content of text){try{const value=JSON.parse(content);if(value?.decisionMemory&&operationHash(value.decisionMemory)===operationHash(current.context.decisionMemory))memoryExposed=true}catch{/* A projection/reference alone does not prove packet exposure. */}}
            }
          }
          const submit=tool('submit_trial',Type.Object({programPath:Type.Optional(Type.String({minLength:1,maxLength:1000})),
            ...(this.options.allowMockPrograms?{hypothesis:Type.Optional(Type.String({minLength:1,maxLength:4000}))}:{}),
            guidanceApplication:this.options.allowMockPrograms?Type.Optional(applicationSchema):applicationSchema},{additionalProperties:false}),async args=>{
            await operation.check()
            const application=args.guidanceApplication===undefined?undefined:GuidanceApplication.parse(args.guidanceApplication)
            if(!this.options.allowMockPrograms&&!application)throw new Error('Native replay requires guidanceApplication: quote the supplied skill, describe the program decision and its falsifying observation.')
            if(application&&!skill.content.includes(application.guidanceQuote))throw new Error('guidanceApplication.guidanceQuote must be an exact excerpt from this arm’s supplied skill content.')
            const captured=await workspace.capture(args.programPath)
            if(Object.values(current.arms).some(other=>other.proposal?.programHash===captured.programHash))throw new Error('Independent paired arms must author distinct immutable programs')
            const admission=this.options.allowMockPrograms?undefined:(await inspect(args.programPath,true,captured)).admission
            const hypothesis=admission?.input.hypothesis??args.hypothesis??'Independent plumbing-only replay arm'
            const authored=await ResearchPrograms.author(this.options.workspace,{hypothesis,program:captured.program,intent:'shadow_replay',designAdapter:this.options.allowMockPrograms?'mock':'proto'})
            slot.proposal={hypothesis,intent:'shadow_replay',designAdapter:this.options.allowMockPrograms?'mock':'proto',...admission?.input,...authored,
              ...(slot.generationSeed===undefined?{}:{generationSeed:slot.generationSeed}),
              ...(memoryExposed?{decisionMemoryExposure:decisionMemoryExposure(current.context.decisionMemory!,current.context.sourceManifest!,slot.sessionId,
                {decisionPlan:admission?.input.decisionPlan,evidenceRefs:admission?.input.evidenceRefs})}:{}),
              skills:[ResearchSkills.reference(skill)],origin:{jobId:input.jobId??operation.jobId,phase:slot.originPhase}}
            slot.guidanceApplication=application?{...application,skill:ResearchSkills.reference(skill),programHash:captured.programHash}:undefined
            await operation.checkpoint(key+':proposal',{...slot.proposal,guidanceApplication:slot.guidanceApplication});await save();return {accepted:true,programHash:captured.programHash,programPath:authored.programPath}
          })
          // One independent transcript per arm. Only its exact skill is provided; paired-arm evidence is absent.
          const result = await operation.model(slot.sessionId, {projectId: this.options.projectId, campaignId: current.context.campaign.id, experimentId: experiment.id,
            contractHash: experiment.contractHash, skillVersionId: skill.versionId, shadowArm: arm, benchmarkId: current.benchmarkId,
            originJobId: input.jobId ?? operation.jobId, originPhase: slot.originPhase,authoringProtocol:current.authoringProtocol,scientificInputHash:current.scientificInputHash,cwd:path.resolve(this.options.workspace,root)},
            {cwd:path.resolve(this.options.workspace,root),experiment: current.context.experiment, decisionMemory:current.context.decisionMemory, evidenceRefs: current.context.evidenceRefs.slice(0,200), evidenceRefCount:current.context.evidenceRefs.length,evidenceRefsOmitted:Math.max(0,current.context.evidenceRefs.length-200), skill, executionCapabilities: current.context.executionCapabilities, reference: current.context.reference, referenceFiles: current.context.referenceFiles?.filter(file => /manifest\.json$|\/(proto_trial|proto_generators|proto_portfolio|program|construct|segment|rejection_sampling_optimizer)\.py$|README\.md$/.test(file.path)), repetition,
              template},
            `Author one independent immutable program using only the supplied attributed skill and frozen context. ${NATIVE_AUTHORING_GUIDANCE} Export native build_trial(ctx) returning ProtoTrial with hypothesis and intent="shadow_replay". Declare a complete prospective decision_plan grounded in supplied evidence, including decision_plan.evidenceRefs; ProtoTrial.evidence_refs is separate and does not populate it. The supplied template is an API starting point; choose the actual intervention from the frozen evidence and assigned skill using available generator lanes. Use native build_trial rather than legacy build_program or AUTOFOLD_WORKFLOW. The host appends frozen scoring stages. Preserve at least one real optimizer Constraint. Obey identical frozen evaluator, seeds, candidate and compute budgets. Use native read for your frozen API.md, CONTRACT.json, EVIDENCE.json, SKILL.md, DECISION_PLAN.schema.json and the listed pinned reference files when needed. Repair the draft with native edit/write using concrete validate_trial feedback. submit_trial admits the exact captured file under the full scientific protocol; submit programPath and guidanceApplication after successful validation and any required repair. In guidanceApplication copy a short exact guidanceQuote from your assigned skill, state the concrete programDecision it informs and a falsifyingObservation. This is a prospective interpretation trace, not proof of causal benefit; preserve uncertainty and let the paired worker results decide. You cannot execute code, activate skills, author evaluation scores or change scientific authority. Mock fixture evidence proves plumbing only.`,
            this.options.allowMockPrograms ? [...workspace.nativeTools(),submit] : [...workspace.nativeTools(),readHistory,validate,submit], 'submit_trial', input.modelBudgetUsd / (input.repetitions * 2), current.baselines, save,async()=>({cwd:path.resolve(this.options.workspace,root),skills:[{name:skill.id,description:'Frozen assigned guide '+skill.versionId+'; use only this original arm guidance',filePath:path.resolve(this.options.workspace,root,'SKILL.md'),baseDir:path.resolve(this.options.workspace,root)}]}),acknowledgeMemory)
          if (!slot.proposal) throw new SkillAuthoringFailure('Shadow authoring ended ' + result.status + ' without an accepted program')
        }
        if (!slot.trialId) {await operation.check(); slot.trialId = (await this.options.research.createTrial(this.options.projectId, input.experimentId, slot.proposal, operation.origin,operation.authority)).id; await save(); await operation.checkpoint(key + ':trial', {trialId: slot.trialId})}
        if (!slot.runId) {await operation.check();await operation.prepareScientificDispatch(slot.requestId); const result = await this.options.execution.evaluateTrial({trialId: slot.trialId, requestId: slot.requestId, signal: operation.signal, caller: operation.origin,operationHandle:operation.authority}); slot.runId = result.run.id; await save(); await operation.checkpoint(key + ':result', {runId: slot.runId, manifestHash: result.run.manifestHash})}
        await this.options.execution.artifacts(slot.runId)
      }
      await operation.check()
      const pairs = Array.from({length: input.repetitions}, (_,i) => ({parent: {runId: current.arms[(i+1) + ':parent']!.runId!, sessionId: current.arms[(i+1) + ':parent']!.sessionId}, candidate: {runId: current.arms[(i+1) + ':candidate']!.runId!, sessionId: current.arms[(i+1) + ':candidate']!.sessionId}}))
      current.result = await this.skills.evaluate(input.campaignId, input.candidateVersionId, {benchmarkId: current.benchmarkId, campaignId: current.context.campaign.id, experimentId: input.experimentId, pairs}, this.options.execution, operation.sessions, {allowPlumbingOnly: this.options.allowMockPrograms, origin: operation.origin,operationHandle:operation.authority})
      await save(); await operation.checkpoint('evaluated', current.result)
      const modelCostUsd=await operation.cost(current.baselines);await operation.complete(current)
      return replayResult(current,modelCostUsd)
    } catch(error){try{await operation.recordFailure(error)}catch{}throw error} finally {await operation.close()}
  }
}

function replayResult(current:ReplayState,modelCostUsd:number) {
  const input=current.input
  if(!current.result)throw new Error('Replay has no canonical scientific result')
  const pairs=Array.from({length:input.repetitions},(_,i)=>({parent:{runId:current.arms[(i+1)+':parent']!.runId!,sessionId:current.arms[(i+1)+':parent']!.sessionId},candidate:{runId:current.arms[(i+1)+':candidate']!.runId!,sessionId:current.arms[(i+1)+':candidate']!.sessionId}}))
  return {modelCostUsd,campaignId:input.campaignId,validationCampaignId:current.context.campaign.id,experimentId:input.experimentId,candidateVersionId:input.candidateVersionId,pairs,replay:current.result.replay,
    guidanceApplications:Object.entries(current.arms).map(([arm,slot])=>({arm,runId:slot.runId,application:slot.guidanceApplication??null,authority:'prospective_scientist_interpretation'})),
    capabilityEvidence:Object.entries(current.arms).flatMap(([arm,slot])=>{
      const assigned=arm.endsWith(':parent')?'parent':'candidate',skill=current.context[assigned]
      const reference=ResearchSkills.reference(skill),application=slot.guidanceApplication??null
      return skill.capabilities.map(capability=>({arm,capability,skill:reference,runId:slot.runId??null,programHash:slot.proposal?.programHash??null,
        application:application?{guidanceQuote:application.guidanceQuote,programDecision:application.programDecision,falsifyingObservation:application.falsifyingObservation}:null,
        status:application?'needs_independent_review' as const:'not_assessed' as const,score:null,
        authority:'descriptive_guidance_trace_only' as const}))
    }),
    validation:(current.result.validations as ResearchDomain.SkillReplay[]).find(value=>value.benchmarkId===current.benchmarkId),finalStatus:current.result.status}
}
