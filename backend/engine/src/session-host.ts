import {operationHash} from '@autofold/science-core/operations'
import {assertSessionAccountingComplete,createAgentRuntime,MAX_TIMER_DURATION_MS,type AgentRuntimeOptions,type AgentRuntime,type PiLimits,type PiRunOptions,type PiSession,type PiSessionStore} from './runtime'

/** Stored beside existing controller progress, never as another task or lease. */
export interface SessionHostBinding {
  version:1; operationId:string; jobId?:string; sessionId:string; inputHash:string
  metadataHash:string; modelSelection:{provider:string;modelId:string}; bindingHash:string
}
export interface SessionHostBaseline {
  costUsd:number; turns?:number; toolCalls?:number; deadlineMs:number
  /** Missing historical request baselines remain unknown. */
  originalRequestIds?:string[]; binding?:SessionHostBinding
}
export function sessionUsage(session:PiSession,baseline:SessionHostBaseline) {
  assertSessionAccountingComplete(session)
  const usage={costUsd:session.usage.costUsd-baseline.costUsd,
    ...(baseline.turns!==undefined?{turns:session.usage.turns-baseline.turns}:{}),
    ...(baseline.toolCalls!==undefined?{toolCalls:session.usage.toolCalls-baseline.toolCalls}:{})}
  if(Object.values(usage).some(value=>!Number.isFinite(value)||value<0)||!Number.isFinite(baseline.costUsd)||baseline.costUsd<0||!Number.isFinite(baseline.deadlineMs))
    throw new Error('Session cumulative model usage lost or reset')
  return usage
}
type HostedRuntime=Pick<AgentRuntime,'get'|'create'|'resume'|'run'> & Partial<Pick<AgentRuntime,'cancel'>>
export class SessionHostBudgetExhausted extends Error {
  constructor(){super('Session cumulative authoring budget exhausted');this.name='SessionHostBudgetExhausted'}
}
export interface SessionHostOptions {
  store:PiSessionStore; sessionId:string; metadata:Record<string,unknown>
  modelSelection:AgentRuntimeOptions['modelSelection']; operationId:string; jobId?:string; inputHash:string
  runtimeOptions:Omit<AgentRuntimeOptions,'store'|'modelSelection'>
  runtimeFactory?:(options:AgentRuntimeOptions)=>HostedRuntime
  /** Existing operation/ancestor checks; never authority inferred from a transcript. */
  checkNewWork(signal:AbortSignal):Promise<unknown>; signal?:AbortSignal
  metadataPolicy?:'exact'|'required_fields'
}
/** Pi owns the conversation. This adapter owns only host identity and allowance. */
export class PiSessionHost {
  private launchBinding:SessionHostBinding
  private opened=false
  private receiptOnly=false
  get binding(){return structuredClone(this.launchBinding)}
  private active?:HostedRuntime
  constructor(readonly options:SessionHostOptions) {
    if(!options.modelSelection)throw new Error('Session host requires an explicit model selection')
    const {provider,modelId}=options.modelSelection
    const identity={version:1 as const,operationId:options.operationId,...(options.jobId?{jobId:options.jobId}:{}),sessionId:options.sessionId,
      inputHash:options.inputHash,metadataHash:operationHash(options.metadata),modelSelection:{provider,modelId}}
    this.launchBinding={...identity,bindingHash:operationHash(identity)}
  }
  private make(limits?:PiLimits) {
    const {runtimeOptions,checkNewWork}=this.options
    // A runtime invocation can have a tighter timeout than the cumulative grant.
    const invocationLimits=limits?{...limits,maxDurationMs:Math.min(limits.maxDurationMs,runtimeOptions.limits?.maxDurationMs??limits.maxDurationMs)}:undefined
    const runtime=(this.options.runtimeFactory??createAgentRuntime)({...runtimeOptions,store:this.options.store,modelSelection:this.options.modelSelection,
      ...(invocationLimits?{limits:invocationLimits}:{}),authorizeModelRequest:async(request,signal)=>{
        await runtimeOptions.authorizeModelRequest?.(request,signal)
        await checkNewWork(signal);signal.throwIfAborted()
      },authorizeToolCall:async(request,signal)=>{
        await runtimeOptions.authorizeToolCall?.(request,signal)
        await checkNewWork(signal);signal.throwIfAborted()
      }})
    this.active=runtime;return runtime
  }
  private verify(session:PiSession) {
    const selection=this.options.modelSelection!
    if(session.id!==this.options.sessionId||session.modelSelection.provider!==selection.provider||session.modelSelection.modelId!==selection.modelId)
      throw new Error('Session host model or original session identity changed')
    const matches=this.options.metadataPolicy==='exact'?operationHash(session.metadata)===this.binding.metadataHash:
      Object.entries(this.options.metadata).every(([key,value])=>operationHash(session.metadata[key])===operationHash(value))
    if(!matches)throw new Error('Session host immutable launch metadata changed')
    if(this.opened&&operationHash(session.metadata)!==this.launchBinding.metadataHash)throw new Error('Session host original launch metadata changed')
  }
  private bindLaunch(session:PiSession) {
    const {bindingHash,...identity}=this.launchBinding
    identity.metadataHash=operationHash(session.metadata)
    this.launchBinding={...identity,bindingHash:operationHash(identity)};this.opened=true
  }
  async get(){const session=await this.options.store.get(this.options.sessionId);if(session)this.verify(session);return session}
  async open(input:{receiptOnly?:boolean}={}) {
    this.receiptOnly=input.receiptOnly??false
    const runtime=this.make(),existing=await runtime.get(this.options.sessionId)
    if(existing)this.verify(existing)
    if(input.receiptOnly){
      if(!existing)throw new Error('Original session is missing; receipt recovery cannot create it')
      // Pi repairs incomplete protocol boundaries without invoking an old tool.
      // Scientific original effects still settle through the domain controller.
      const session=await runtime.resume(this.options.sessionId);this.verify(session);this.bindLaunch(session);return session
    }
    const session=existing?await runtime.resume(this.options.sessionId):await runtime.create({id:this.options.sessionId,metadata:this.options.metadata})
    this.verify(session);assertSessionAccountingComplete(session)
    this.bindLaunch(session)
    return session
  }
  baseline(session:PiSession,durationMs:number,deadlineMs=Date.now()+durationMs):SessionHostBaseline {
    this.verify(session);assertSessionAccountingComplete(session)
    return {costUsd:session.usage.costUsd,turns:session.usage.turns,toolCalls:session.usage.toolCalls,deadlineMs,
      ...(session.modelRequests?{originalRequestIds:Object.keys(session.modelRequests)}:{}),binding:this.binding}
  }
  usage(session:PiSession,baseline:SessionHostBaseline) {
    this.verify(session)
    if(baseline.binding&&operationHash(baseline.binding)!==operationHash(this.binding))throw new Error('Session host belongs to another original operation binding')
    return sessionUsage(session,baseline)
  }
  remaining(session:PiSession,baseline:SessionHostBaseline,limits:Pick<PiLimits,'maxCostUsd'|'maxTurns'|'maxToolCalls'>,deadlineMs=baseline.deadlineMs):PiLimits {
    const usage=this.usage(session,baseline)
    const remaining={maxCostUsd:limits.maxCostUsd-usage.costUsd,maxTurns:limits.maxTurns-(usage.turns??0),
      maxToolCalls:limits.maxToolCalls-(usage.toolCalls??0),maxDurationMs:Math.min(MAX_TIMER_DURATION_MS,Math.floor(Math.min(baseline.deadlineMs,deadlineMs)-Date.now()))}
    if(Object.values(remaining).some(value=>!Number.isFinite(value)||value<=0))throw new SessionHostBudgetExhausted()
    return remaining
  }
  async run(prompt:string,limits:PiLimits,runOptions:PiRunOptions={}) {
    if(!this.opened||this.receiptOnly)throw new Error('Receipt-only or unopened session host cannot authorize inference')
    const session=await this.get();if(!session)throw new Error('Original hosted session is missing')
    const signal=runOptions.signal??this.options.signal??new AbortController().signal
    await this.options.checkNewWork(signal);signal.throwIfAborted()
    const runtime=this.make(limits)
    const result=await runtime.run(this.options.sessionId,prompt,{...runOptions,signal,
      owningBinding:{operationId:this.binding.operationId,...(this.binding.jobId?{jobId:this.binding.jobId}:{}),bindingHash:this.binding.bindingHash}})
    this.verify(result.session);return result
  }
  cancel(){this.active?.cancel?.(this.options.sessionId)}
}
