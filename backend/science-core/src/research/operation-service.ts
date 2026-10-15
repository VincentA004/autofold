import crypto from "node:crypto"
import {OperationDomain,appendOperationEvent,operationHash} from "./operations"
import {ResearchJobService} from "./job-service"
import type {ResearchStore,ResearchState,RecordScope} from "./store"

export namespace OperationService {
  type zDispatch = OperationDomain.Record["scientificDispatch"]
  export type Handle = OperationDomain.Handle
  export class ConflictError extends Error {constructor(readonly code:string,message:string){super(message);this.name="OperationConflictError"}}
  export interface OpenInput {id:string;kind:string;identity:Record<string,unknown>;jobId?:string;parentOperationId?:string;grant?:Record<string,unknown>;state?:Record<string,unknown>;scientificDispatch?:zDispatch}
  export interface UpdateInput {phase:string;state:Record<string,unknown>;effect?:OperationDomain.Record["effect"];accounting?:OperationDomain.Record["accounting"];outcome?:OperationDomain.Record["outcome"];settlement?:OperationDomain.Record["settlement"];outbox?:Array<{id:string;kind:string;purpose?:"effect"|"projection";data:Record<string,unknown>}>}
  export class Service {
    constructor(private readonly store:ResearchStore,private readonly options:{now?:()=>string;leaseId?:()=>string}={}){}
    private now(){return this.options.now?.()??new Date().toISOString()}
    private async readScope(projectId:string,scope:RecordScope){return this.store.readRecords?.(projectId,scope)??this.store.read(projectId)}
    private eventId(id:string,revision:number){return `ope_${operationHash([id,revision])}`}
    private mutateScope<T>(projectId:string,scope:RecordScope,fn:(state:ResearchState)=>T){return this.store.mutateRecords?.(projectId,scope,fn)??this.store.mutate(projectId,fn)}
    private async handleScope(handle:OperationDomain.Handle,outboxIds:string[]=[]):Promise<RecordScope>{
      const record=await this.read(handle.projectId,handle.operationId)
      return {records:{operations:[handle.operationId],operationEvents:[this.eventId(handle.operationId,handle.revision+1)],operationOutbox:outboxIds,jobs:record?.jobId?[record.jobId]:[]},jobAncestors:record?.jobId}
    }
    private async mutateHandle<T>(handle:OperationDomain.Handle,outboxIds:string[],fn:(state:ResearchState)=>T){return this.mutateScope(handle.projectId,await this.handleScope(handle,outboxIds),fn)}
    async check(handle:OperationDomain.Handle){const state=await this.readScope(handle.projectId,await this.handleScope(handle));return this.assertHandle(state,handle)}
    async read(projectId:string,id:string){return (await this.readScope(projectId,{records:{operations:[id]}})).operations[id]}
    async open(projectId:string,input:OpenInput):Promise<OperationDomain.Record>{return this.mutateScope(projectId,{records:{operations:[input.id],operationEvents:[this.eventId(input.id,0)],jobs:input.jobId?[input.jobId]:[]}},state=>{
      const identityHash=operationHash({kind:input.kind,identity:input.identity,jobId:input.jobId,parentOperationId:input.parentOperationId,grant:input.grant??{}})
      const existing=state.operations[input.id]
      if(existing){if(existing.identityHash!==identityHash)throw new ConflictError("operation_identity_conflict","Original operation identity cannot change");return existing}
      if(input.jobId&&!state.jobs[input.jobId])throw new ConflictError("operation_job_missing","Managed operation owner is missing")
      const now=this.now(),record=OperationDomain.Record.parse({...input,projectId,identityHash,revision:0,epoch:0,phase:"opened",state:input.state??{},effect:"none",accounting:"pending",outcome:"pending",settlement:"pending",createdAt:now,updatedAt:now,...(input.jobId&&state.jobs[input.jobId]?.status==="cancelled"?{cancelledAt:now}:{})})
      state.operations[record.id]=record;appendOperationEvent(state,record,"opened",{identityHash},now);return record
    })}
    private record(state:Readonly<ResearchState>,id:string){const record=state.operations[id];if(!record)throw new ConflictError("operation_missing","Operation does not exist");return record}
    private runAuthority(state:Readonly<ResearchState>,record:OperationDomain.Record,jobLeaseId?:string){
      if(record.outcome!=="pending")throw new ConflictError("operation_terminal","Terminal outcomes permit original receipt settlement only")
      if(record.cancelledAt)throw new ConflictError("operation_cancelled","Cancellation forbids new operation work")
      const now=this.now(),nowMs=Date.parse(now)
      if(record.grant.deadlineMs!==undefined&&(typeof record.grant.deadlineMs!=="number"||!Number.isFinite(record.grant.deadlineMs)||record.grant.deadlineMs<=nowMs))throw new ConflictError("operation_deadline","Original operation grant expired")
      if(!record.jobId)return
      const job=state.jobs[record.jobId]
      if(!job||!jobLeaseId||!ResearchJobService.inspectOwnership(state,job,now,jobLeaseId).valid)throw new ConflictError("operation_job_fence","Managed operation lost its exact native job epoch or ancestry")
      let current:typeof job|undefined=job
      while(current){for(const value of [current.checkpoints["host:lifecycle:start"]?.data.deadlineMs,current.checkpoints["pi:job:start"]?.data.deadlineMs,current.checkpoints["campaign:job:start"]?.data.deadlineMs,current.payload.originDeadlineMs])if(value!==undefined&&(typeof value!=="number"||!Number.isFinite(value)||value<=nowMs))throw new ConflictError("operation_deadline","Original job grant expired");current=typeof current.payload.parentJobId==="string"?state.jobs[current.payload.parentJobId]:undefined}
    }
    async acquire(projectId:string,id:string,input:{mode:"run"|"settle";leaseMs:number;jobLeaseId?:string}):Promise<OperationDomain.Handle>{
      if(!Number.isFinite(input.leaseMs)||input.leaseMs<1||input.leaseMs>2147483647)throw new Error("Invalid operation lease duration")
      const observed=await this.read(projectId,id)
      return this.mutateScope(projectId,{records:{operations:[id],jobs:observed?.jobId?[observed.jobId]:[]},jobAncestors:observed?.jobId,operationNextEvent:id},state=>{const record=this.record(state,id),now=this.now()
        if(record.owner&&Date.parse(record.owner.expiresAt)>Date.parse(now))throw new ConflictError("operation_busy","Original operation is still leased")
        if(input.mode==="run")this.runAuthority(state,record,input.jobLeaseId)
        const owner={leaseId:this.options.leaseId?.()??crypto.randomUUID(),epoch:record.epoch+1,mode:input.mode,jobLeaseId:input.jobLeaseId,expiresAt:new Date(Date.parse(now)+input.leaseMs).toISOString()}
        const updated=OperationDomain.Record.parse({...record,owner,epoch:owner.epoch,revision:record.revision+1,updatedAt:now})
        state.operations[id]=updated;appendOperationEvent(state,updated,"owner_acquired",{mode:input.mode},now);return this.handle(updated)
      })
    }
    private handle(record:OperationDomain.Record):OperationDomain.Handle {return {projectId:record.projectId,operationId:record.id,leaseId:record.owner!.leaseId,epoch:record.owner!.epoch,revision:record.revision,mode:record.owner!.mode}}
    private assertHandle(state:Readonly<ResearchState>,handle:OperationDomain.Handle,revision=true){const record=this.record(state,handle.operationId),owner=record.owner
      if(record.projectId!==handle.projectId||!owner||owner.leaseId!==handle.leaseId||owner.epoch!==handle.epoch||owner.mode!==handle.mode||Date.parse(owner.expiresAt)<=Date.parse(this.now()))throw new ConflictError("operation_epoch_lost","Operation lease epoch is no longer active")
      if(revision&&record.revision!==handle.revision)throw new ConflictError("operation_revision_conflict","Operation state revision changed")
      if(owner.mode==="run")this.runAuthority(state,record,owner.jobLeaseId)
      return record
    }
    async update(handle:OperationDomain.Handle,input:UpdateInput):Promise<{record:OperationDomain.Record;handle:OperationDomain.Handle}>{return this.mutateHandle(handle,(input.outbox??[]).map(item=>item.id),state=>{
      const record=this.assertHandle(state,handle),now=this.now()
      if(handle.mode==="settle"&&(input.effect==="prepared"||input.effect==="running"||input.outbox?.some(item=>item.purpose==="effect")))throw new ConflictError("settlement_cannot_launch","Receipt settlement cannot prepare or launch a new effect")
      if(record.effect==="settled"&&input.effect!==undefined&&input.effect!=="settled"||record.accounting==="settled"&&input.accounting!==undefined&&input.accounting!=="settled"||record.settlement==="settled"&&input.settlement!==undefined&&input.settlement!=="settled"||record.outcome!=="pending"&&input.outcome!==undefined&&input.outcome!==record.outcome)
        throw new ConflictError("operation_terminal_conflict","Settled operation axes cannot regress or change their original outcome")
      const updated=OperationDomain.Record.parse({...record,...input,outbox:undefined,revision:record.revision+1,updatedAt:now})
      if(updated.outcome==="succeeded"&&(updated.accounting!=="settled"||!["none","settled"].includes(updated.effect)))throw new ConflictError("operation_unsettled","Success requires original effects and known accounting settlement")
      for(const item of input.outbox??[]){const identityHash=operationHash({operationId:record.id,kind:item.kind,purpose:item.purpose??"projection",data:item.data}),existing=state.operationOutbox[item.id]
        if(existing&&existing.identityHash!==identityHash)throw new ConflictError("outbox_identity_conflict","Original outbox intent identity cannot change")
        if(!existing)state.operationOutbox[item.id]=OperationDomain.Outbox.parse({...item,operationId:record.id,purpose:item.purpose??"projection",identityHash,status:"pending",createdAt:now,updatedAt:now})
      }
      state.operations[record.id]=updated;appendOperationEvent(state,updated,"state_committed",{phase:updated.phase,effect:updated.effect,accounting:updated.accounting,outcome:updated.outcome,settlement:updated.settlement,outboxIds:(input.outbox??[]).map(item=>item.id)},now)
      return {record:updated,handle:this.handle(updated)}
    })}
    /** Write-ahead boundary: once prepared, a missing success receipt never proves no dispatch. */
    async prepareScientificDispatch(handle:OperationDomain.Handle,requestId:string){
      if(!requestId.trim())throw new Error("Original scientific request ID is required")
      return this.mutateHandle(handle,[],state=>{const record=this.assertHandle(state,handle)
        if(handle.mode!=="run"||record.settlement==="settled")throw new ConflictError("settlement_cannot_launch","Terminal settlement cannot prepare science")
        const now=this.now(),updated=OperationDomain.Record.parse({...record,scientificDispatch:{version:1,originalJobId:record.scientificDispatch?.originalJobId,status:"prepared",requestIds:[...new Set([...(record.scientificDispatch?.requestIds??[]),requestId])]},revision:record.revision+1,updatedAt:now})
        state.operations[record.id]=updated;appendOperationEvent(state,updated,"scientific_dispatch_prepared",{requestId},now);return {record:updated,handle:this.handle(updated)}
      })
    }
    /** Domain receipt readers verify artifacts; the kernel verifies original ownership and uncertainty. */
    async terminal(handle:OperationDomain.Handle,input:{phase:string;state:Record<string,unknown>;evidence:OperationDomain.TerminalEvidence;outbox?:UpdateInput["outbox"]}){
      const evidence=OperationDomain.TerminalEvidence.parse(input.evidence)
      // A full ownership census is deliberately in the same transaction as terminal commit.
      return this.store.mutate(handle.projectId,state=>{
        const record=this.assertHandle(state,handle),now=this.now()
        if(evidence.operationId!==record.id||evidence.identityHash!==record.identityHash)throw new ConflictError("terminal_identity_conflict","Terminal evidence belongs to another original operation")
        const jobs=new Set<string>();if(record.jobId)jobs.add(record.jobId);if(record.scientificDispatch?.originalJobId)jobs.add(record.scientificDispatch.originalJobId)
        let expanded=true;while(expanded){expanded=false;for(const job of Object.values(state.jobs))if(typeof job.payload.parentJobId==="string"&&jobs.has(job.payload.parentJobId)&&!jobs.has(job.id)){jobs.add(job.id);expanded=true}}
        const ownedRuns=Object.values(state.runs).filter(run=>{const jobId=state.trials[run.trialId]?.origin?.jobId;return !!jobId&&jobs.has(jobId)})
        const external=Object.values(state.operationOutbox).filter(item=>item.operationId===record.id&&item.purpose==="effect")
        let effects:OperationDomain.Record["effect"]="unknown"
        if(evidence.effects.kind==="none"){
          if(evidence.effects.requestIds.length||(record.jobId??record.scientificDispatch?.originalJobId)!==evidence.effects.originalJobId||record.scientificDispatch?.status!=="not_started"||record.scientificDispatch.requestIds.length||ownedRuns.length||external.length||["prepared","running","unknown","settled"].includes(record.effect))throw new ConflictError("dispatch_absence_unproven","Original write-ahead boundary and ownership census do not prove zero scientific dispatch")
          effects="none"
        }else if(evidence.effects.kind==="receipts"){
          const ids=new Set(evidence.effects.receiptIds)
          // Execution IDs use raw sha256 bytes rather than canonical JSON string encoding.
          const originalPreparedRuns=(record.scientificDispatch?.requestIds??[]).map(requestId=>state.runs[`run_${crypto.createHash("sha256").update(record.projectId+":"+requestId).digest("hex")}`])
          if(originalPreparedRuns.some(run=>!run||!ids.has(run.id)||!["succeeded","failed","cancelled"].includes(run.status)))throw new ConflictError("original_effect_unresolved","Every prepared original scientific request requires its terminal receipt")
          if(ownedRuns.some(run=>!ids.has(run.id)||!["succeeded","failed","cancelled"].includes(run.status))||external.some(item=>item.status!=="acknowledged"||!item.receiptId||!ids.has(item.receiptId)))throw new ConflictError("original_effect_unresolved","Original effect receipts are incomplete")
          effects="settled"
        }
        const accounting=evidence.accounting.kind==="known"&&(evidence.accounting.source==="fixture"||evidence.accounting.providerAccounting?.status==="reported"&&evidence.accounting.providerAccounting.reportedCostUsd!==null)?"settled":"unknown"
        const settled=accounting==="settled"&&["none","settled"].includes(effects)
        if(evidence.outcome==="succeeded"&&!settled)throw new ConflictError("operation_unsettled","Success requires known original billing and effects")
        const terminalState={...input.state,terminalEvidence:evidence}
        const previous=record.state.terminalEvidence as OperationDomain.TerminalEvidence|undefined
        if(record.outcome!=="pending"&&record.outcome!==evidence.outcome)throw new ConflictError("operation_terminal_conflict","Original terminal outcome cannot change")
        if(previous&&(previous.reason!==evidence.reason||previous.accounting.kind==="known"&&operationHash(previous.accounting)!==operationHash(evidence.accounting)||previous.effects.kind!=="unknown"&&operationHash(previous.effects)!==operationHash(evidence.effects)))throw new ConflictError("operation_terminal_conflict","Known original terminal evidence cannot change")
        if(record.settlement==="settled"&&operationHash(previous)!==operationHash(evidence))throw new ConflictError("operation_terminal_conflict","Original terminal evidence cannot change")
        if(record.effect==="settled"&&effects!=="settled"||record.accounting==="settled"&&accounting!=="settled")throw new ConflictError("operation_terminal_conflict","Settled operation axes cannot regress")
        const updated=OperationDomain.Record.parse({...record,owner:{...record.owner!,mode:"settle"},phase:input.phase,state:terminalState,effect:effects,accounting,outcome:evidence.outcome,settlement:settled?"settled":"unresolved",revision:record.revision+1,updatedAt:now})
        for(const item of input.outbox??[]){if(item.purpose==="effect")throw new ConflictError("settlement_cannot_launch","Terminal commit cannot prepare effects");const identityHash=operationHash({operationId:record.id,kind:item.kind,purpose:item.purpose??"projection",data:item.data}),existing=state.operationOutbox[item.id];if(existing&&existing.identityHash!==identityHash)throw new ConflictError("outbox_identity_conflict","Original outbox intent identity cannot change");if(!existing)state.operationOutbox[item.id]=OperationDomain.Outbox.parse({...item,operationId:record.id,purpose:"projection",identityHash,status:"pending",createdAt:now,updatedAt:now})}
        state.operations[record.id]=updated;appendOperationEvent(state,updated,"terminal_evidence_committed",{evidence,phase:updated.phase,effect:effects,accounting,settlement:updated.settlement},now)
        return {record:updated,handle:this.handle(updated)}
      })
    }
    async renew(handle:OperationDomain.Handle,leaseMs:number){if(!Number.isFinite(leaseMs)||leaseMs<1||leaseMs>2147483647)throw new Error("Invalid operation lease duration");return this.mutateHandle(handle,[],state=>{const record=this.assertHandle(state,handle,false);state.operations[record.id]=OperationDomain.Record.parse({...record,owner:{...record.owner!,expiresAt:new Date(Date.parse(this.now())+leaseMs).toISOString()}});return this.handle(state.operations[record.id]!)})}
    async release(handle:OperationDomain.Handle){return this.mutateScope(handle.projectId,{records:{operations:[handle.operationId]},operationNextEvent:handle.operationId},state=>{const record=this.record(state,handle.operationId);if(record.owner?.leaseId!==handle.leaseId||record.owner.epoch!==handle.epoch)return
      const now=this.now(),updated=OperationDomain.Record.parse({...record,owner:undefined,revision:record.revision+1,updatedAt:now});state.operations[record.id]=updated;appendOperationEvent(state,updated,"owner_released",{},now)
    })}
    async acknowledge(handle:OperationDomain.Handle,id:string,input:{status:"acknowledged"|"unknown"|"superseded";receiptId?:string}){return this.mutateHandle(handle,[id],state=>{const record=this.assertHandle(state,handle),item=state.operationOutbox[id];if(!item||item.operationId!==record.id)throw new ConflictError("outbox_missing","Outbox intent does not belong to operation")
      if(input.status==="superseded"&&item.purpose!=="projection")throw new ConflictError("effect_cannot_supersede","Uncertain effects require their original receipt; only derivative projections may be superseded")
      if(["acknowledged","superseded"].includes(item.status)&&(input.status!==item.status||item.receiptId!==input.receiptId))throw new ConflictError("outbox_receipt_conflict","Original acknowledged receipt cannot change")
      const now=this.now();state.operationOutbox[id]=OperationDomain.Outbox.parse({...item,...input,updatedAt:now});const updated=OperationDomain.Record.parse({...record,revision:record.revision+1,updatedAt:now});state.operations[record.id]=updated;appendOperationEvent(state,updated,"outbox_observed",{id,...input},now);return this.handle(updated)
    })}
    async eventPage(projectId:string,id:string,afterRevision=-1,limit=100){
      if(!Number.isSafeInteger(afterRevision)||afterRevision < -1||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid operation event cursor')
      const record=await this.read(projectId,id)
      if(!record)return {events:[],nextRevision:afterRevision,hasMore:false}
      const end=Math.min(record.revision,afterRevision+limit),ids=Array.from({length:Math.max(0,end-afterRevision)},(_,index)=>this.eventId(id,afterRevision+index+1))
      const state=await this.readScope(projectId,{records:{operationEvents:ids}}),events=ids.map(key=>state.operationEvents[key])
      if(events.some(event=>!event))throw new Error('Original operation event history is incomplete')
      return {events:events as OperationDomain.Event[],nextRevision:events.length?end:afterRevision,hasMore:end<record.revision}
    }
    async events(projectId:string,id:string){
      const record=await this.read(projectId,id);if(!record)return []
      // Complete observation is bounded by its original revision, even if another
      // owner appends while these immutable indexed pages are being reconstructed.
      const events:OperationDomain.Event[]=[];let revision=-1
      while(revision<record.revision){const page=await this.eventPage(projectId,id,revision,Math.min(100,record.revision-revision));events.push(...page.events);revision=page.nextRevision}
      return events
    }
  }
}
