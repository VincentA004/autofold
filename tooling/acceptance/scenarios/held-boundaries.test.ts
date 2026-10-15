import {test,expect} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createAcceptanceHarness,waitFor} from '../harness'
import {observePublicWorkflow as observe} from '../public-observation'
import {collectManifestEvidence} from '../artifact-evidence'
import {collectCancellationSnapshot,type CancellationArtifactSnapshot} from '../artifact-cancellation'
import {inspectCancellationBehavior,inspectUnknownBillingBehavior,type QuietProof,type AuthorityProof} from '../held-oracle'
import type {PublicObservation} from '../oracle'

type Harness=Awaited<ReturnType<typeof createAcceptanceHarness>>
type Facts=Record<string,unknown>
async function authority(h:Harness,rootJob:any,child:any,maximumTrajectories:number):Promise<AuthorityProof>{
 return {maximumTrajectories,deadlineMs:rootJob.checkpoints['host:lifecycle:start'].data.deadlineMs,modelBudgetUsd:rootJob.payload.modelBudgetUsd,child:{id:child.id,payload:child.payload,piJobStart:child.checkpoints['pi:job:start'].data,hostDeadlineMs:child.checkpoints['host:lifecycle:start'].data.deadlineMs,session:await h.api('/research/sessions/'+child.payload.sessionId)}}
}
async function report(h:Harness|undefined,id:string,status:string,facts:Facts,error?:string){
 const value={id,status,proofLevel:id==='recovery.unknown-billing-holds'?'public_workflow_hold':'native_cpu_public_workflow',observations:facts,evidence:{directory:h?.root},error}
 if(h)await fs.writeFile(path.join(h.root,'scenario-report.json'),JSON.stringify(value,null,2))
 if(process.env.AUTOFOLD_ACCEPTANCE_REPORT_DIR){await fs.mkdir(process.env.AUTOFOLD_ACCEPTANCE_REPORT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.AUTOFOLD_ACCEPTANCE_REPORT_DIR,id+'.json'),JSON.stringify(value,null,2),{flag:'wx'})}
}
async function preserveSnapshot(h:Harness,snapshot:CancellationArtifactSnapshot,name:string){
 const directory=path.join(h.root,name);await fs.mkdir(path.join(directory,'partial'),{recursive:true})
 await fs.writeFile(path.join(directory,'bundle.json'),snapshot.bundle,{flag:'wx'});await fs.writeFile(path.join(directory,'trial.py'),snapshot.program,{flag:'wx'})
 await fs.writeFile(path.join(directory,'inventory.json'),JSON.stringify({runId:snapshot.runId,trialId:snapshot.trialId,partialInventory:snapshot.partialInventory},null,2),{flag:'wx'})
 for(const [relative,bytes] of Object.entries(snapshot.partialCopies)){const target=path.join(directory,'partial',relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'})}
 return async()=>{
  const metadata=JSON.parse(await fs.readFile(path.join(directory,'inventory.json'),'utf8'))
  expect(metadata,'The preserved archive cannot redefine the original observed partial inventory').toEqual({runId:snapshot.runId,trialId:snapshot.trialId,partialInventory:snapshot.partialInventory})
  const partialCopies:Record<string,Uint8Array>={}
  for(const entry of snapshot.partialInventory)partialCopies[entry.path]=new Uint8Array(await fs.readFile(path.join(directory,'partial',entry.path)))
  return {...snapshot,bundle:new Uint8Array(await fs.readFile(path.join(directory,'bundle.json'))),program:new Uint8Array(await fs.readFile(path.join(directory,'trial.py'))),partialCopies}
 }
}
async function quiet(h:Harness,experimentId:string,campaignId:string,from:string,holdReason:string,observations:PublicObservation[],until:(row:PublicObservation,jobs:any[],operations:any[])=>boolean,minimumDurationMs=3000){
 const controller:QuietProof['controller']=[],started=Date.now();let last:PublicObservation|undefined,jobs:any[]=[],operations:any[]=[]
 let waitError:string|undefined
 try{await waitFor('public hold remains responsive and original owned effects settle',async()=>{
  const health=await h.api('/health');controller.push({at:new Date().toISOString(),ok:health.ok,workerStatus:health.worker?.status})
  jobs=await h.api('/research/jobs');operations=await h.api('/research/operations')
  last=await observe(h,experimentId,campaignId);observations.push(last)
  return Date.now()-started>=minimumDurationMs&&until(last,jobs,operations)
 },Boolean,60_000)}catch(error){if(!last)throw error;waitError=String(error)}
 const proof:QuietProof={from,through:last!.at,holdReason,controller}
 return {proof,last:last!,jobs,operations,waitError}
}
async function cancellation(){
 const id='recovery.cancel-holds',facts:Facts={},observations:PublicObservation[]=[]
 let h:Harness|undefined,status='blocked',error:string|undefined
 try{
  h=await createAcceptanceHarness(id);console.log('Acceptance evidence '+h.root);await h.start()
  const {experiment,campaign,job}=await h.prepareCampaign(3,1);facts.initialJobId=job.id
  const original=await waitFor('original actual CPU effect before recovery',async()=>{const rows=await h!.workerEntries();return rows.find(row=>row.event==='worker_start')},Boolean,90_000)
  const originalIdentity=await h.verifyWorkerProcess(original!);observations.push(await observe(h,experiment.id,campaign.id))
  const originalRoot=await h.api('/research/jobs/'+job.id)
  expect((await h.verifyWorkerProcess(original!)).workerPid).toBe(originalIdentity.workerPid)
  const faultAt=Date.now();await h.kill();facts.faultAt=new Date(faultAt).toISOString();facts.interruptedRunId=original!.runId
  const originalExit=await h.waitForWorkerExit(originalIdentity,original!.runId);facts.originalWorkerExitAt=originalExit.at
  expect(Date.parse(originalExit.at)).toBeGreaterThan(faultAt)
  await Bun.sleep(Math.max(0,faultAt+32000-Date.now()));const restartAt=new Date().toISOString();facts.restartAt=restartAt
  expect(Date.parse(originalExit.at)).toBeLessThan(Date.parse(restartAt));await h.start()
  const second=await waitFor('second distinct actual native effect in automatically continued lineage',async()=>{
   observations.push(await observe(h!,experiment.id,campaign.id));return(await h!.workerEntries()).find(row=>row.event==='worker_start'&&row.runId!==original!.runId)
  },Boolean,90_000)
  const secondIdentity=await h.verifyWorkerProcess(second!)
  const run=await h.api('/research/runs/'+second!.runId),history=await h.api('/research/experiments/'+experiment.id+'/history')
  const trial=history.trials.find((trial:any)=>trial.id===run.trialId),activeJob=await h.api('/research/jobs/'+trial.origin.jobId)
  const continued=await h.api('/research/jobs/'+activeJob.payload.parentJobId)
  expect(continued.payload.continuedFromJobId,'Second effect must belong to automatic continuation of original terminal root').toBe(job.id)
  const before=await collectCancellationSnapshot({runId:run.id,trialId:run.trialId,workspace:h.workspace,outputPath:run.outputPath})
  const rereadBefore=await preserveSnapshot(h,before,'cancel-before')
  expect((await h.verifyWorkerProcess(second!)).workerPid).toBe(secondIdentity.workerPid)
  const ack=await h.api('/research/jobs/'+job.id+'/cancel',{}),acknowledgedAt=new Date().toISOString()
  facts.cancellationAcknowledgedAt=acknowledgedAt;facts.activeRunId=run.id;facts.activeJobId=activeJob.id;facts.cancelResponse=ack
  const [secondExit,settled]=await Promise.all([h.waitForPhysicalWorkerExit(secondIdentity,run.id),quiet(h,experiment.id,campaign.id,acknowledgedAt,'Public cancellation of the original root revokes its continued lineage',observations,(row,jobs,operations)=>{
   const ids=new Set([job.id]);let changed=true
   while(changed){changed=false;for(const candidate of jobs)if(!ids.has(candidate.id)&&[candidate.payload?.parentJobId,candidate.payload?.continuedFromJobId].some(value=>ids.has(value))){ids.add(candidate.id);changed=true}}
   return row.runs.length>=2&&row.runs.every(run=>['succeeded','failed','cancelled'].includes(run.status))&&jobs.filter(candidate=>ids.has(candidate.id)).every(candidate=>['succeeded','failed','cancelled'].includes(candidate.status))&&operations.filter(operation=>ids.has(operation.jobId)).every(operation=>operation.effect!=='unknown'&&operation.accounting!=='unknown'&&operation.settlement==='settled')
  })]);facts.activeWorkerExitAt=secondExit.at
  // Join the independent physical-exit observation to a final responsive public
  // snapshot; completion of either parallel observer alone is insufficient.
  const finalHealth=await h.api('/health')
  settled.proof.controller.push({at:new Date().toISOString(),ok:finalHealth.ok,workerStatus:finalHealth.worker?.status})
  settled.jobs=await h.api('/research/jobs');settled.operations=await h.api('/research/operations')
  settled.last=await observe(h,experiment.id,campaign.id);observations.push(settled.last);settled.proof.through=settled.last.at
  if(settled.waitError)facts.holdWaitError=settled.waitError
  const after=await collectCancellationSnapshot({runId:run.id,trialId:run.trialId,workspace:h.workspace,outputPath:run.outputPath});await preserveSnapshot(h,after,'cancel-after')
  const manifests=[]
  for(const succeeded of settled.last.runs.filter(run=>run.status==='succeeded')){const publicRun=await h.api('/research/runs/'+succeeded.id);manifests.push(await collectManifestEvidence({runId:succeeded.id,workspace:h.workspace,outputPath:publicRun.outputPath,...succeeded.id===original!.runId?{expectedSha:originalExit.manifest.sha256}:{}}))}
  const proof={acknowledgedAt,originalRunId:original!.runId,activeRunId:run.id,originalJobId:job.id,activeJobId:activeJob.id,jobs:settled.jobs.map(candidate=>({id:candidate.id,status:candidate.status,parentJobId:candidate.payload?.parentJobId,continuedFromJobId:candidate.payload?.continuedFromJobId,cancelRequestedAt:candidate.cancelRequestedAt})),operations:settled.operations,quiet:settled.proof,authority:await authority(h,originalRoot,activeJob,3),activeEvidence:{before:await rereadBefore(),after}}
  const evidence={requestedResults:3,requireComplete:false,provider:h.provider.entries(),workers:await h.workerEntries(),observations,manifests,cancellation:proof}
  const verdict=inspectCancellationBehavior(evidence);facts.verdict=verdict
  await fs.writeFile(path.join(h.root,'held-public-evidence.json'),JSON.stringify({jobs:settled.jobs,operations:settled.operations,quiet:proof.quiet,authority:proof.authority},null,2))
  await fs.writeFile(path.join(h.root,'behavioral-verdict.json'),JSON.stringify(verdict,null,2))
  expect(verdict.failures,JSON.stringify(verdict,null,2)).toEqual([]);status='passed'
 }catch(caught){error=caught instanceof Error?caught.stack??caught.message:String(caught);status=Object.hasOwn(facts,'interruptedRunId')?'failed':'blocked';throw caught}
 finally{try{await h?.close()}catch(cleanup){status='failed';error=(error??'')+'\nCleanup: '+String(cleanup);throw cleanup}finally{await report(h,id,status,facts,error)}}
}
async function unknownBilling(){
 const id='recovery.unknown-billing-holds',facts:Facts={},observations:PublicObservation[]=[]
 let h:Harness|undefined,status='blocked',error:string|undefined
 try{
  h=await createAcceptanceHarness(id,{unknownFirstInvoice:true});console.log('Acceptance evidence '+h.root);await h.start()
  const {experiment,campaign,job}=await h.prepareCampaign(2,1);facts.initialJobId=job.id
  const held=await waitFor('first real wire reply exposes retained unknown billing and an explicit public accounting hold',async()=>{
   const observation=await observe(h!,experiment.id,campaign.id);observations.push(observation);return observation
  },row=>row.modelRequests.some(request=>request.status==='unknown')&&!!row.holdReason,45_000)
  const rootJob=await h.api('/research/jobs/'+job.id)
  const children=(await h.api('/research/jobs')).filter((candidate:any)=>candidate.payload?.parentJobId===job.id&&candidate.payload?.kind==='autoresearch')
  expect(children.length,'The first unknown invoice must belong to the actual sole original child').toBe(1)
  const ownedIds=[job.id,children[0].id]
  const baselineJobs=await waitFor('both original jobs have completed their first factual unknown-billing recovery',()=>h!.api('/research/jobs'),jobs=>ownedIds.every(id=>jobs.some((candidate:any)=>candidate.id===id&&candidate.status==='recovery_required'&&candidate.recoveryCount>=1)),30_000)
  const metadata=(jobs:any[])=>ownedIds.map(id=>{const candidate=jobs.find(candidate=>candidate.id===id);return {id,status:candidate?.status,recoveryCount:candidate?.recoveryCount,attempts:candidate?.attempts,checkpointPhases:Object.keys(candidate?.checkpoints??{}).sort()}})
  const originalMetadata=metadata(baselineJobs),from=new Date().toISOString()
  const settled=await quiet(h,experiment.id,campaign.id,from,held.holdReason!,observations,row=>!!row.holdReason&&row.modelRequests.some(request=>request.status==='unknown'),6000)
  if(settled.waitError)facts.holdWaitError=settled.waitError
  const evidence={requestedResults:2,requireComplete:false,provider:h.provider.entries(),workers:await h.workerEntries(),observations,manifests:[],hold:{quiet:settled.proof,authority:await authority(h,rootJob,children[0],2)}}
  const verdict=inspectUnknownBillingBehavior(evidence);facts.verdict=verdict
  await fs.writeFile(path.join(h.root,'held-public-evidence.json'),JSON.stringify({jobs:settled.jobs,operations:settled.operations,quiet:evidence.hold.quiet,authority:evidence.hold.authority},null,2))
  await fs.writeFile(path.join(h.root,'behavioral-verdict.json'),JSON.stringify(verdict,null,2))
  expect(verdict.failures,JSON.stringify(verdict,null,2)).toEqual([])
  const journal=(await fs.readFile(path.join(h.root,'http-journal.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const metadataObservations=[{at:from,jobs:originalMetadata},...journal.filter(row=>row.method==='GET'&&row.route==='/research/jobs'&&Date.parse(row.at)>=Date.parse(from)&&Date.parse(row.at)<=Date.parse(settled.proof.through)).map(row=>({at:row.at,jobs:metadata(row.response)}))]
  const stabilityFailures=metadataObservations.filter(row=>JSON.stringify(row.jobs)!==JSON.stringify(originalMetadata)).map(row=>({at:row.at,jobs:row.jobs}))
  facts.metadataStabilityFailureCount=stabilityFailures.length
  facts.metadataStabilityFirstFailure=stabilityFailures[0];facts.metadataStabilityLastFailure=stabilityFailures.at(-1)
  await fs.writeFile(path.join(h.root,'hold-metadata-observations.json'),JSON.stringify({from,through:settled.proof.through,expected:originalMetadata,observations:metadataObservations},null,2))
  expect(stabilityFailures.length,'An unchanged explicit accounting hold must not reacquire authority, repeat recovery or append checkpoints; see hold-metadata-observations.json').toBe(0)
  facts.heldJobCheckpointsStable=true;facts.holdMetadataQuietWindowMs=Date.parse(settled.proof.through)-Date.parse(from)
  status='passed'
 }catch(caught){error=caught instanceof Error?caught.stack??caught.message:String(caught);status=h?.provider.entries().some(row=>row.event==='invoice')?'failed':'blocked';throw caught}
 finally{try{await h?.close()}catch(cleanup){status='failed';error=(error??'')+'\nCleanup: '+String(cleanup);throw cleanup}finally{await report(h,id,status,facts,error)}}
}
test('recovery.cancel-holds: cancelling the original terminal root revokes active continuation without losing original effects or authorizing more work',cancellation,240_000)
test('recovery.unknown-billing-holds: one genuinely unknown provider invoice holds further inference and scientific work while the controller remains responsive',unknownBilling,90_000)
