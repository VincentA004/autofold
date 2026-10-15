import {checkedPath} from '../execution/paths'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {operationHash,type OperationDomain} from '@autofold/science-core/operations'
import {OperationService} from '@autofold/science-core/operation-service'
import type {ResearchStore} from '@autofold/science-core/store'

export interface AuxiliaryHost {projectId:string; workspace:string; store:ResearchStore}
/** Canonical progress is durable; derivative publication must be recovered without a new grant. */
export class AuxiliaryProjectionPendingError extends Error {
  constructor(readonly publicationCause:unknown) {
    super('Auxiliary projection pending: '+(publicationCause instanceof Error?publicationCause.message:String(publicationCause)))
    this.name='AuxiliaryProjectionPendingError'
  }
}
export class LegacyOperationFrozenError extends Error {
  constructor() {super('Legacy operation is read-only; explicit migration is required before continuation');this.name='LegacyOperationFrozenError'}
}
export async function readLegacyProjection<T>(file:string):Promise<T|undefined> {
  try {return JSON.parse(await fs.readFile(file,'utf8'))} catch(error:any) {if(error.code==='ENOENT')return undefined;throw error}
}
async function project(file:string,state:unknown) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700})
  const temporary=file+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600)
  try {await handle.writeFile(JSON.stringify(state,null,2)+'\n');await handle.sync()}finally{await handle.close()}
  await fs.rename(temporary,file)
  const directory=await fs.open(path.dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
}

/** A single canonical CAS/epoch authority. JSON is exported only after canonical commit. */
export class AuxiliaryOperation {
  private readonly abort=new AbortController()
  readonly signal:AbortSignal
  private renewal?:Promise<unknown>
  private timer?:ReturnType<typeof setInterval>
  private constructor(readonly service:OperationService.Service,private handle:OperationDomain.Handle,
    private readonly projection:string|undefined,private record:Awaited<ReturnType<OperationService.Service['open']>>,external?:AbortSignal) {
    this.signal=external?AbortSignal.any([external,this.abort.signal]):this.abort.signal
    this.timer=setInterval(()=>{if(!this.renewal)this.renewal=this.service.renew(this.handle,30_000).then(()=>{}).catch(error=>this.abort.abort(error)).finally(()=>{this.renewal=undefined})},10_000)
    this.timer.unref()
  }
  static async open(host:AuxiliaryHost,input:{id:string;kind:string;identity:Record<string,unknown>;projection?:string;origin?:{jobId:string;leaseId:string};signal?:AbortSignal;legacyExists?:boolean;maxDurationMs?:number;scientificOriginJobId?:string}) {
    const service=new OperationService.Service(host.store)
    const previous=await service.read(host.projectId,input.id)
    if(!previous&&(input.legacyExists||input.projection&&await readLegacyProjection(input.projection)!==undefined))throw new LegacyOperationFrozenError()
    if(previous&&['failed','cancelled'].includes(previous.outcome))throw new Error((previous.state.terminalEvidence as OperationDomain.TerminalEvidence|undefined)?.reason??'Original operation terminated; original receipt settlement only')
    input.signal?.throwIfAborted()
    const record=await service.open(host.projectId,{id:input.id,kind:input.kind,identity:input.identity,jobId:input.origin?.jobId,scientificDispatch:previous?previous.scientificDispatch:{version:1,originalJobId:input.origin?.jobId??input.scientificOriginJobId,status:'not_started',requestIds:[]},grant:previous?.grant??{modelSelection:input.identity.modelSelection,modelBudgetUsd:input.identity.modelBudgetUsd,deadlineMs:Date.now()+(input.maxDurationMs??600_000),...(input.projection?{projectionPath:input.projection}:{})}})
    const handle=await service.acquire(host.projectId,input.id,{mode:previous?.outcome==='succeeded'&&previous.settlement==='settled'?'settle':'run',leaseMs:30_000,jobLeaseId:input.origin?.leaseId})
    return new AuxiliaryOperation(service,handle,input.projection,record,input.signal)
  }
  state<T>():T|undefined {return Object.keys(this.record.state).length?structuredClone(this.record.state) as T:undefined}
  get authority(){return structuredClone(this.handle)}
  async check(){this.signal.throwIfAborted();await this.service.check(this.handle);this.signal.throwIfAborted()}
  projectionPending(error:unknown):never {const pending=error instanceof AuxiliaryProjectionPendingError?error:new AuxiliaryProjectionPendingError(error);this.abort.abort(pending);throw pending}
  async save(state:Record<string,unknown>,phase='authoring') {
    await this.check()
    const stateHash='sha256:'+createHash('sha256').update(JSON.stringify(state)).digest('hex')
    const projectionId=this.projection?this.handle.operationId+':projection:'+(this.handle.revision+1):undefined
    const result=await this.service.update(this.handle,{phase,state:structuredClone(state),...(projectionId?{outbox:[{id:projectionId,kind:'auxiliary_json_projection',purpose:'projection' as const,data:{path:this.projection,stateHash}}]}:{})})
    this.record=result.record;this.handle=result.handle
    // Failure here cannot erase or replace canonical accepted proposals/commits.
    if(this.projection){try{await project(this.projection,state);this.handle=await this.service.acknowledge(this.handle,projectionId!,{status:'acknowledged',receiptId:stateHash})}catch(error){this.projectionPending(error)}}
  }
  async prepareScientificDispatch(requestId:string) {
    await this.check()
    const result=await this.service.prepareScientificDispatch(this.handle,requestId)
    this.record=result.record;this.handle=result.handle
  }
  /** Commit typed terminal evidence; known failure and unresolved billing stay separate. */
  async complete(state:Record<string,unknown>,input:OperationDomain.TerminalInput) {
    const evidence:OperationDomain.TerminalEvidence={...input,version:1,operationId:this.record.id,identityHash:this.record.identityHash}
    const terminalState={...state,terminalEvidence:evidence}
    const stateHash='sha256:'+createHash('sha256').update(JSON.stringify(terminalState)).digest('hex')
    const projectionId=this.projection?this.handle.operationId+':projection:'+(this.handle.revision+1):undefined
    const result=await this.service.terminal(this.handle,{phase:input.outcome==='succeeded'?'settled':input.outcome,state,evidence,...(projectionId?{outbox:[{id:projectionId,kind:'auxiliary_json_projection',purpose:'projection' as const,data:{path:this.projection,stateHash}}]}:{})})
    this.record=result.record;this.handle=result.handle
    if(this.projection){try{await project(this.projection,terminalState);this.handle=await this.service.acknowledge(this.handle,projectionId!,{status:'acknowledged',receiptId:stateHash})}catch(error){this.projectionPending(error)}}
  }
  /** Original receipt settlement can close an expired/cancelled grant, without dispatch. */
  static async settleTerminal(host:AuxiliaryHost,id:string,result:Record<string,unknown>,input:OperationDomain.TerminalInput) {
    const service=new OperationService.Service(host.store),record=await service.read(host.projectId,id)
    if(!record)return // Legacy inspection never opens or migrates canonical state.
    const evidence={...input,version:1,operationId:record.id,identityHash:record.identityHash}
    if(record.state.terminalEvidence){
      const previous=record.state.terminalEvidence as OperationDomain.TerminalEvidence
      if(operationHash(previous)===operationHash(evidence))return
      // Unknown effects or billing may be refined by verified original receipts.
    }
    const raw=record.grant.projectionPath
    const projection=typeof raw==='string'?await checkedPath(host.workspace,path.relative(host.workspace,raw)):undefined
    const handle=await service.acquire(host.projectId,id,{mode:'settle',leaseMs:30_000})
    const operation=new AuxiliaryOperation(service,handle,projection,record)
    try{
      try{await operation.complete({...record.state,recovery:{result:structuredClone(result),receiptIds:input.effects.kind==='receipts'?input.effects.receiptIds:[]}},input)}catch(error){
        const committed=await service.read(host.projectId,id)
        if(operationHash(committed?.state.terminalEvidence)!==operationHash(evidence))throw error
        // Derivative export failure stays in the outbox; it cannot undo terminal evidence.
      }
    }finally{await operation.close()}
  }
  /** Explicit derivative rebuild from canonical state; no authoring/science/provider port. */
  static async rebuildProjection(host:AuxiliaryHost,id:string) {
    const service=new OperationService.Service(host.store),record=await service.read(host.projectId,id)
    if(!record||typeof record.grant.projectionPath!=='string')throw new Error('Canonical operation projection is absent')
    const projection=await checkedPath(host.workspace,path.relative(host.workspace,record.grant.projectionPath))
    const handle=await service.acquire(host.projectId,id,{mode:'settle',leaseMs:30_000})
    const operation=new AuxiliaryOperation(service,handle,projection,record)
    try{
      await operation.save(record.state,record.phase)
      const pending=Object.values((await host.store.read(host.projectId)).operationOutbox).filter(item=>item.operationId===id&&item.kind==='auxiliary_json_projection'&&item.purpose==='projection'&&item.status==='pending'&&item.data.path===projection)
      for(const item of pending)operation.handle=await service.acknowledge(operation.handle,item.id,{status:'superseded',receiptId:'sha256:'+createHash('sha256').update(JSON.stringify(record.state)).digest('hex')})
    }finally{await operation.close()}
  }
  async close(){if(this.timer)clearInterval(this.timer);await this.renewal?.catch(()=>{});await this.service.release(this.handle)}
}
