import {createHash} from 'node:crypto'
import type {ProviderJournalEntry} from './provider'

/** Deliberately normalized from public HTTP responses by the harness. No engine
 * validators, database reads, operation hashes or accounting helpers belong here. */
export type PublicRun={id:string;trialId:string;status:string;manifestHash?:string|null}
export type PublicModelRequest={id:string;upstreamRequestId?:string;status:string;reportedCostUsd?:number|null;estimatedCostUsd?:number|null}
export type PublicObservation={at:string;campaignStatus:string;completed:boolean;trialIds:string[];runs:PublicRun[];modelRequests:PublicModelRequest[];reportedCostUsd:number;estimatedCostUsd:number;holdReason?:string}
export type WorkerObservation={event:'worker_start'|'worker_exit'|'worker_exit_observed';pid:number;runId:string;at:string;exitCode?:number}
export type ManifestObservation={runId:string;bytes:Uint8Array;sha256?:string;files?:Record<string,Uint8Array>;linkedFiles?:Record<string,Uint8Array>}
export type BehavioralEvidence={requestedResults:number;provider:ProviderJournalEntry[];workers:WorkerObservation[];observations:PublicObservation[];manifests:ManifestObservation[];restartAt?:string;interruptedRunId?:string;requireComplete?:boolean}
export type BehavioralVerdict={passed:boolean;failures:string[];counts:{providerRequests:number;providerInvoices:number;workerStarts:number;successfulRuns:number};reportedCostUsd:number}
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0)
const duplicate=(values:string[])=>values.length!==new Set(values).size
const validMoney=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0
const digest=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex')
const sameAmount=(a:number,b:number)=>Math.abs(a-b)<=1e-9

export function inspectBehavior(evidence:BehavioralEvidence):BehavioralVerdict{
 const failures:string[]=[],check=(condition:unknown,message:string)=>{if(!condition)failures.push(message)}
 const requests=evidence.provider.filter(row=>row.event==='request'),invoices=evidence.provider.filter(row=>row.event==='invoice'),starts=evidence.workers.filter(row=>row.event==='worker_start')
 const last=evidence.observations.at(-1),successful=last?.runs.filter(run=>run.status==='succeeded')??[]
 check(Number.isInteger(evidence.requestedResults)&&evidence.requestedResults>0,'Requested result count must be explicit and positive')
 check(!!last,'Missing final public observation')
 check(requests.length>0,'Workflow produced no externally observed provider requests')
 check(!duplicate(requests.map(row=>row.requestId)),'Duplicate external provider request identity')
 check(!duplicate(invoices.map(row=>row.requestId)),'Duplicate external invoice')
 check(invoices.every(row=>requests.some(request=>request.requestId===row.requestId)),'Invoice without an external request')
 check(!duplicate(starts.map(row=>row.runId)),'Duplicate worker execution for one run')
 check(starts.every(row=>Number.isInteger(row.pid)&&row.pid>0&&!!row.runId),'Worker start missing OS or scientific identity')
 check(!evidence.provider.some(row=>row.event==='fixture_error'),'Provider fixture failed; scenario did not exercise its intended contract')
 const known=invoices.filter(row=>validMoney(row.costUsd)),reportedCostUsd=sum(known.map(row=>row.costUsd as number)),unknown=invoices.length!==known.length||requests.some(row=>!invoices.some(invoice=>invoice.requestId===row.requestId))
 if(last){
  check(!duplicate(last.trialIds),'Public trials contain duplicate identities')
  check(!duplicate(last.runs.map(run=>run.id)),'Public runs contain duplicate identities')
  check(!duplicate(last.modelRequests.map(request=>request.id)),'Public model requests contain duplicate identities')
  check(!duplicate(last.modelRequests.flatMap(request=>request.upstreamRequestId?[request.upstreamRequestId]:[])),'One external invoice is credited to multiple public model requests')
  check(successful.length<=evidence.requestedResults,'Campaign produced more successful results than authorized')
  check(last.trialIds.length<=evidence.requestedResults,'Proposals consumed or exceeded authorized scientific slots')
  check(starts.length<=evidence.requestedResults,'Worker effects exceeded authorized result count')
  check(starts.every(start=>last.runs.some(run=>run.id===start.runId)),'External worker execution disappeared from public results')
  check(successful.every(run=>starts.some(start=>start.runId===run.id)),'Successful public result has no actual worker execution')
  check(successful.every(run=>last.trialIds.includes(run.trialId)),'Successful result lost its public scientific trial')
  for(const run of successful){
   const manifests=evidence.manifests.filter(manifest=>manifest.runId===run.id)
   check(manifests.length===1,`Successful result ${run.id} must have one immutable manifest`)
   if(manifests.length===1){
    const observed=manifests[0]!,hash=digest(observed.bytes);check(run.manifestHash===hash,`Public manifest hash does not match bytes for ${run.id}`);if(observed.sha256)check(observed.sha256===hash,`External manifest hash does not match bytes for ${run.id}`)
    try{
     const manifest=JSON.parse(new TextDecoder().decode(observed.bytes))
     check(manifest.runId===run.id&&manifest.trialId===run.trialId,`Manifest scientific identity differs for ${run.id}`)
     check(manifest.files&&typeof manifest.files==='object'&&!Array.isArray(manifest.files),`Manifest artifact bindings missing for ${run.id}`)
     for(const [key,expected] of Object.entries(manifest.files??{})){
      const bytes=observed.files?.[key]
      check(!!bytes,`Missing independently collected artifact ${key} for ${run.id}`)
      if(bytes)check(typeof expected==='string'&&digest(bytes)===expected,`Manifest artifact bytes differ for ${key} of ${run.id}`)
     }
     for(const key of ['result','candidates','generation_runs'])check(typeof manifest.files?.[key]==='string',`Successful manifest is missing required ${key} artifact for ${run.id}`)
     if(observed.files?.result){
      const result=JSON.parse(new TextDecoder().decode(observed.files.result))
      check(result.runId===run.id&&result.trialId===run.trialId,`Result scientific identity differs for ${run.id}`)
      check(result.valid===true,`Successful run ${run.id} does not contain a valid result`)
      check(typeof result.score==='number'&&Number.isFinite(result.score),`Successful run ${run.id} does not contain a finite numeric score`)
     }
     if(observed.files?.candidates){
      const result=JSON.parse(new TextDecoder().decode(observed.files.candidates)),rows=result.candidates
      check(result.runId===run.id&&result.trialId===run.trialId,`Candidate set scientific identity differs for ${run.id}`)
      check(Array.isArray(rows)&&rows.length>0&&rows.every((row:any)=>typeof row?.id==='string'&&row.id.trim().length>0&&typeof row?.sequence==='string'&&row.sequence.trim().length>0)&&
       new Set(rows.map((row:any)=>row.id)).size===rows.length,`Successful run ${run.id} contains empty, invalid or repeated candidates`)
     }
     const generationBytes=observed.files?.generation_runs
     if(generationBytes){
      const index=JSON.parse(new TextDecoder().decode(generationBytes))
      check(index.runId===run.id,`Generation index scientific identity differs for ${run.id}`)
      check(Array.isArray(index.entries),`Generation index entries missing for ${run.id}`)
      const linked=[...(Array.isArray(index.entries)?index.entries.map((entry:any)=>({path:entry.artifactPath,hash:entry.artifactHash})):[]),...(index.nativeSearch?[index.nativeSearch]:[])]
      for(const reference of linked){
       const bytes=typeof reference.path==='string'?observed.linkedFiles?.[reference.path]:undefined
       check(!!bytes,`Missing independently collected linked artifact ${String(reference.path)} for ${run.id}`)
       if(bytes)check(typeof reference.hash==='string'&&digest(bytes)===reference.hash,`Linked artifact bytes differ for ${String(reference.path)} of ${run.id}`)
      }
     }
    }catch(error){check(false,`Unreadable independent manifest or generation artifact for ${run.id}: ${String(error)}`)}
   }
   check(evidence.workers.some(row=>row.runId===run.id&&['worker_exit','worker_exit_observed'].includes(row.event)),`Successful result ${run.id} has no observed worker exit`)
  }
  check(validMoney(last.reportedCostUsd)&&sameAmount(last.reportedCostUsd,reportedCostUsd),'Public reported costs differ from independently recorded provider invoices')
  check(validMoney(last.estimatedCostUsd),'Public SDK cost is not finite and nonnegative')
  const publicEstimates=last.modelRequests.map(request=>request.estimatedCostUsd)
  check(publicEstimates.every(validMoney),'Public model request has missing or invalid SDK estimate')
  check(sameAmount(sum(publicEstimates.filter(validMoney)),last.estimatedCostUsd),'Public SDK total differs from its retained request estimates')
  for(const invoice of known){const matches=last.modelRequests.filter(request=>request.upstreamRequestId===invoice.requestId);check(matches.length===1,`External invoice ${invoice.requestId} is not settled exactly once in public requests`);if(matches.length===1)check(matches[0]!.status==='settled'&&sameAmount(matches[0]!.reportedCostUsd??NaN,invoice.costUsd as number),`External invoice ${invoice.requestId} lost its public settlement or amount`)}
  if(unknown){
   check(!last.completed,'Unknown provider billing must prevent successful completion');check(!!last.holdReason,'Unknown provider billing must expose an explicit hold')
   for(const invoice of invoices.filter(row=>!validMoney(row.costUsd))){
    const matches=last.modelRequests.filter(request=>request.upstreamRequestId===invoice.requestId)
    check(matches.length===1&&matches[0]!.status==='unknown'&&!validMoney(matches[0]!.reportedCostUsd),`Unknown external invoice ${invoice.requestId} lost its retained public unknown request`)
   }
   const firstUnknown=invoices.find(row=>!validMoney(row.costUsd))??requests.find(row=>!invoices.some(invoice=>invoice.requestId===row.requestId))
   if(firstUnknown){check(!starts.some(start=>Date.parse(start.at)>Date.parse(firstUnknown.at)),'New worker execution occurred after provider billing became unknown');check(!requests.some(request=>request.sequence>firstUnknown.sequence),'New inference occurred after provider billing became unknown')}
  }
  if(last.completed||evidence.requireComplete!==false){check(last.completed,'Campaign never automatically completed');check(successful.length===evidence.requestedResults,'Campaign completed with only partial scientific results');check(last.runs.length===evidence.requestedResults&&last.trialIds.length===evidence.requestedResults,'Completed campaign has orphan proposals or runs');check(!unknown,'Completed campaign contains unknown provider billing')}
 }
 for(let index=1;index<evidence.observations.length;index++){
  const before=evidence.observations[index-1]!,after=evidence.observations[index]!
  check(after.reportedCostUsd+1e-9>=before.reportedCostUsd,'Reported cost reset after interruption')
  check(after.estimatedCostUsd+1e-9>=before.estimatedCostUsd,'SDK estimate reset after interruption')
  check(before.runs.every(run=>after.runs.some(current=>current.id===run.id)),'A previously visible result disappeared after recovery')
  check(before.modelRequests.every(request=>after.modelRequests.some(current=>current.id===request.id)),'A previously visible model request disappeared after recovery')
 }
 if(evidence.restartAt){
  const restart=Date.parse(evidence.restartAt);check(Number.isFinite(restart),'Restart timestamp is invalid')
  check(starts.some(start=>Date.parse(start.at)>restart),'Recovery collected receipts but never automatically continued to a new worker execution')
  if(evidence.interruptedRunId){check(starts.filter(start=>start.runId===evidence.interruptedRunId).length===1,'Interrupted original run was redispatched');check(successful.some(run=>run.id===evidence.interruptedRunId),'Interrupted original result was not recovered')}
 }
 return {passed:failures.length===0,failures,counts:{providerRequests:requests.length,providerInvoices:invoices.length,workerStarts:starts.length,successfulRuns:successful.length},reportedCostUsd}
}
export function requireBehavior(evidence:BehavioralEvidence){const verdict=inspectBehavior(evidence);if(!verdict.passed)throw Error('Behavioral acceptance failed:\n'+verdict.failures.map(failure=>'- '+failure).join('\n'));return verdict}
