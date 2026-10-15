import z from "zod"
import {createHash} from "node:crypto"

/** Canonical host operation state. JSON files are rebuildable projections of this record. */
export namespace OperationDomain {
  export const Owner = z.object({leaseId:z.string().min(1),epoch:z.number().int().positive(),mode:z.enum(["run","settle"]),expiresAt:z.iso.datetime(),jobLeaseId:z.string().optional()})
  export const ScientificDispatch = z.object({version:z.literal(1),originalJobId:z.string().optional(),status:z.enum(["not_started","prepared"]),requestIds:z.array(z.string().min(1))})
  export const TerminalInput = z.object({outcome:z.enum(["succeeded","failed","cancelled"]),reason:z.string().optional(),effects:z.discriminatedUnion("kind",[z.object({kind:z.literal("none"),originalJobId:z.string().optional(),requestIds:z.array(z.string().min(1))}),z.object({kind:z.literal("receipts"),receiptIds:z.array(z.string().min(1)).min(1)}),z.object({kind:z.literal("unknown"),originalIds:z.array(z.string()),detail:z.string().min(1)})]),accounting:z.discriminatedUnion("kind",[z.object({kind:z.literal("known"),modelCostUsd:z.number().finite().nonnegative(),sessionIds:z.array(z.string()),source:z.enum(["provider","fixture"]),providerAccounting:z.object({status:z.enum(["reported","unknown"]),reportedCostUsd:z.number().finite().nonnegative().nullable(),originalRequestIds:z.array(z.string()),knownReportedCostUsd:z.number().finite().nonnegative(),upstreamRequestIds:z.array(z.string()),unknownRequestIds:z.array(z.string())}).optional()}),z.object({kind:z.literal("unknown"),detail:z.string().min(1),modelCostUsd:z.number().finite().nonnegative().optional()})])})
  export type TerminalInput = z.infer<typeof TerminalInput>
  export const TerminalEvidence = TerminalInput.extend({version:z.literal(1),operationId:z.string(),identityHash:z.string()})
  export type TerminalEvidence = z.infer<typeof TerminalEvidence>
  export const Record = z.object({scientificDispatch:ScientificDispatch.optional(),id:z.string().startsWith("op_"),projectId:z.string().min(1),kind:z.string().min(1),identity:z.record(z.string(),z.unknown()),identityHash:z.string(),jobId:z.string().optional(),parentOperationId:z.string().optional(),grant:z.record(z.string(),z.unknown()).default({}),revision:z.number().int().nonnegative(),epoch:z.number().int().nonnegative(),owner:Owner.optional(),phase:z.string().min(1),state:z.record(z.string(),z.unknown()),cancelledAt:z.iso.datetime().optional(),effect:z.enum(["none","prepared","running","unknown","settled"]),accounting:z.enum(["pending","unknown","settled"]),outcome:z.enum(["pending","succeeded","failed","cancelled"]),settlement:z.enum(["pending","unresolved","settled"]),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()})
  export type Record = z.infer<typeof Record>
  export const Event = z.object({id:z.string(),operationId:z.string(),revision:z.number().int().nonnegative(),epoch:z.number().int().nonnegative(),type:z.string().min(1),data:z.record(z.string(),z.unknown()),createdAt:z.iso.datetime()})
  export type Event = z.infer<typeof Event>
  export const Outbox = z.object({id:z.string().min(1),operationId:z.string(),kind:z.string().min(1),purpose:z.enum(["effect","projection"]),data:z.record(z.string(),z.unknown()),identityHash:z.string(),status:z.enum(["pending","acknowledged","unknown","superseded"]),receiptId:z.string().optional(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()})
  export type Outbox = z.infer<typeof Outbox>
  export interface Handle {projectId:string;operationId:string;leaseId:string;epoch:number;revision:number;mode:"run"|"settle"}
}
export function canonicalOperationJSON(input:unknown):string {
  if(Array.isArray(input))return "["+input.map(value=>canonicalOperationJSON(value)).join(",")+"]"
  if(input&&typeof input==="object")return "{"+Object.entries(input).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>JSON.stringify(key)+":"+canonicalOperationJSON(value)).join(",")+"}"
  return JSON.stringify(input)??"null"
}
export const operationHash = (input:unknown) => createHash("sha256").update(canonicalOperationJSON(input)).digest("hex")

export function appendOperationEvent(state:{operationEvents:Record<string,OperationDomain.Event>},record:OperationDomain.Record,type:string,data:Record<string,unknown>,now:string) {
  const id=`ope_${operationHash([record.id,record.revision])}`
  if(state.operationEvents[id]) throw new Error("Operation event revision already exists")
  state.operationEvents[id]=OperationDomain.Event.parse({id,operationId:record.id,revision:record.revision,epoch:record.epoch,type,data,createdAt:now})
}
/** Called in the SAME transaction as native job cancellation, never by a projection worker. */
export function cancelOperationsForJobs(state:{operations:Record<string,OperationDomain.Record>;operationEvents:Record<string,OperationDomain.Event>},jobs:Set<string>,now:string) {
  for(const operation of Object.values(state.operations)) {
    if(!operation.jobId||!jobs.has(operation.jobId)||operation.cancelledAt)continue
    const updated=OperationDomain.Record.parse({...operation,cancelledAt:now,owner:undefined,revision:operation.revision+1,updatedAt:now})
    state.operations[updated.id]=updated;appendOperationEvent(state,updated,"cancelled",{jobId:operation.jobId},now)
  }
}

export function assertOperationHistory(previous:{operationEvents:Record<string,OperationDomain.Event>;operationOutbox:Record<string,OperationDomain.Outbox>;operations:Record<string,OperationDomain.Record>},next:typeof previous) {
  for(const [id,event] of Object.entries(previous.operationEvents))if(canonicalOperationJSON(event)!==canonicalOperationJSON(next.operationEvents[id]))throw new Error("Committed operation events are append-only")
  for(const [id,item] of Object.entries(previous.operationOutbox)) {const updated=next.operationOutbox[id];if(!updated||item.identityHash!==updated.identityHash||canonicalOperationJSON(item.data)!==canonicalOperationJSON(updated.data)||item.operationId!==updated.operationId||item.kind!==updated.kind||item.purpose!==updated.purpose)throw new Error("Committed outbox identity is immutable")}
  for(const [id,record] of Object.entries(previous.operations)){const updated=next.operations[id];if(!updated||record.id!==updated.id||record.projectId!==updated.projectId||record.kind!==updated.kind||record.cancelledAt!==undefined&&record.cancelledAt!==updated.cancelledAt||updated.revision<record.revision||updated.epoch<record.epoch||record.identityHash!==updated.identityHash||canonicalOperationJSON(record.identity)!==canonicalOperationJSON(updated.identity)||canonicalOperationJSON(record.grant)!==canonicalOperationJSON(updated.grant)||record.jobId!==updated.jobId||record.parentOperationId!==updated.parentOperationId)throw new Error("Canonical operation identity is immutable");if(record.scientificDispatch&&( !updated.scientificDispatch||record.scientificDispatch.originalJobId!==updated.scientificDispatch.originalJobId||record.scientificDispatch.status==="prepared"&&updated.scientificDispatch.status!=="prepared"||record.scientificDispatch.requestIds.some(id=>!updated.scientificDispatch!.requestIds.includes(id))))throw new Error("Original scientific dispatch boundary cannot regress")}
}

export function assertOperationHandle(state:{operations:Record<string,OperationDomain.Record>},handle:OperationDomain.Handle,now:string,requiredMode:"run"|"settle"="run") {
  const record=state.operations[handle.operationId],owner=record?.owner
  if(handle.mode!==requiredMode||!record||record.projectId!==handle.projectId||!owner||owner.leaseId!==handle.leaseId||owner.epoch!==handle.epoch||owner.mode!==handle.mode||record.revision!==handle.revision||Date.parse(owner.expiresAt)<=Date.parse(now)||handle.mode==="run"&&!!record.cancelledAt)throw new Error("Canonical operation lost its exact epoch or revision")
  if(requiredMode==="run"&&record.grant.deadlineMs!==undefined&&(typeof record.grant.deadlineMs!=="number"||!Number.isFinite(record.grant.deadlineMs)||record.grant.deadlineMs<=Date.parse(now)))throw new Error("Original canonical operation grant expired before scientific commit")
  return record
}
export function ensureJobOperation(state:{operations:Record<string,OperationDomain.Record>;operationEvents:Record<string,OperationDomain.Event>},job:{id:string;projectId:string;payload:unknown},now:string) {
  const id=`op_job_${job.id.slice(4)}`
  if(state.operations[id])return state.operations[id]!
  const identity={jobId:job.id,payloadHash:operationHash(job.payload)},record=OperationDomain.Record.parse({id,projectId:job.projectId,jobId:job.id,kind:"native_job",identity,identityHash:operationHash({kind:"native_job",identity,jobId:job.id,grant:{payloadHash:identity.payloadHash}}),grant:{payloadHash:identity.payloadHash},revision:0,epoch:0,phase:"queued",state:{jobId:job.id},effect:"none",accounting:"pending",outcome:"pending",settlement:"pending",createdAt:now,updatedAt:now})
  state.operations[id]=record;appendOperationEvent(state,record,"opened",{identityHash:record.identityHash},now);return record
}

/** Native job liveness remains native; this operation carries its separate settlement diagnostics. */
export function recordNativeJobLifecycle(state:{operations:Record<string,OperationDomain.Record>;operationEvents:Record<string,OperationDomain.Event>;jobs:Record<string,{id:string;payload:Record<string,unknown>}>;trials:Record<string,{origin?:{jobId:string}}>;runs:Record<string,{id:string;trialId:string;status:string}>},job:{id:string;status:string;leaseId?:string;result?:Record<string,unknown>;error?:string;recovery?:unknown;checkpoints:Record<string,{data:Record<string,unknown>}>},now:string) {
  const id=`op_job_${job.id.slice(4)}`,record=state.operations[id]
  const terminal=job.checkpoints["host:receipt-terminal"]?.data,originalResult=job.checkpoints["pi:job:result"]?.data
  const verifiedCancellation=job.status==="cancelled"&&terminal?.status==="cancelled"&&originalResult&&terminal.resultHash===createHash("sha256").update(JSON.stringify(originalResult)).digest("hex")
  if(!record||record.cancelledAt&&!verifiedCancellation)return
  const owned=new Set([job.id]);let expanded=true
  while(expanded){expanded=false;for(const child of Object.values(state.jobs))if(typeof child.payload.parentJobId==="string"&&owned.has(child.payload.parentJobId)&&!owned.has(child.id)){owned.add(child.id);expanded=true}}
  const receipts=Object.values(state.runs).filter(run=>{const ownerId=state.trials[run.trialId]?.origin?.jobId;return !!ownerId&&owned.has(ownerId)})
  const settlement=Object.entries(job.checkpoints).filter(([phase])=>phase.startsWith("pi:accounting:settlement:")).at(-1)?.[1].data
  const cost=job.result?.modelCostUsd??settlement?.modelCostUsd
  const known=typeof cost==="number"&&Number.isFinite(cost)&&cost>=0
  const complete=["succeeded","failed"].includes(job.status)||!!verifiedCancellation,effectsSettled=receipts.every(run=>["succeeded","failed","cancelled"].includes(run.status))
  const nextState={jobId:job.id,nativeStatus:job.status,nativeLeaseId:job.leaseId,result:job.result,error:job.error,recovery:job.recovery,receiptIds:receipts.map(run=>run.id),...(known?{modelCostUsd:cost}:{})}
  if(record.phase===job.status&&canonicalOperationJSON(record.state)===canonicalOperationJSON(nextState))return
  const updated=OperationDomain.Record.parse({...record,phase:job.status,state:nextState,revision:record.revision+1,updatedAt:now,
    ...(complete?{effect:effectsSettled?(receipts.length?"settled":"none"):"unknown",accounting:known?"settled":"unknown",settlement:known&&effectsSettled?"settled":"unresolved",outcome:job.status==="failed"?"failed":verifiedCancellation?"cancelled":known&&effectsSettled?"succeeded":"pending"}:{})})
  state.operations[id]=updated;appendOperationEvent(state,updated,"native_lifecycle_observed",{nativeStatus:job.status,receiptIds:receipts.map(run=>run.id),knownAccounting:known},now)
}
