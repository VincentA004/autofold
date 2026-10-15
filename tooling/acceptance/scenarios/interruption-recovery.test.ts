import {test, expect} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createAcceptanceHarness, waitFor} from '../harness'
import {inspectBehavior, type PublicObservation} from '../oracle'
import {collectManifestEvidence} from '../artifact-evidence'
import {observePublicWorkflow as observe} from '../public-observation'

type Harness=Awaited<ReturnType<typeof createAcceptanceHarness>>
type ProcessIdentity=Awaited<ReturnType<Harness['verifyWorkerProcess']>>
async function captureNewNativeProcesses(h:Harness,known:Map<string,ProcessIdentity>) {
  for(const entry of (await h.workerEntries()).filter(row=>row.event==='worker_start'))if(!known.has(entry.runId))known.set(entry.runId,await h.verifyWorkerProcess(entry))
}
async function requireCompletionQuiescence(h:Harness,experimentId:string,campaignId:string,observations:PublicObservation[],facts:Record<string,unknown>) {
  const first=await observe(h,experimentId,campaignId);observations.push(first)
  expect(first.completed,'Authorization must be complete before the quiet window').toBe(true)
  const jobIds=(await h.api('/research/jobs')).map((job:any)=>job.id).sort()
  const requests=()=>h.provider.entries().filter(row=>row.event==='request'||row.event==='invoice').map(row=>({event:row.event,id:row.requestId}))
  const originalRequests=requests(),originalStarts=(await h.workerEntries()).filter(row=>row.event==='worker_start')
  const originalTrials=[...first.trialIds].sort(),originalRuns=first.runs.map(run=>run.id).sort(),started=Date.now()
  while(Date.now()-started<3000){
    await Bun.sleep(100)
    const current=await observe(h,experimentId,campaignId);observations.push(current)
    expect(current.completed,'Completed authorization reopened during the quiet window').toBe(true)
    expect([...current.trialIds].sort()).toEqual(originalTrials)
    expect(current.runs.map(run=>run.id).sort()).toEqual(originalRuns)
    expect((await h.api('/research/jobs')).map((job:any)=>job.id).sort()).toEqual(jobIds)
    expect(requests()).toEqual(originalRequests)
    expect((await h.workerEntries()).filter(row=>row.event==='worker_start')).toEqual(originalStarts)
  }
  facts.quiescentAfterCompletion=true;facts.quietWindowMs=Date.now()-started
}
async function writeReport(h:Harness|undefined,id:string,status:string,facts:Record<string,unknown>,error?:string) {
  const report={id,status,proofLevel:'native_cpu_public_workflow',observations:facts,evidence:{directory:h?.root},error}
  if(h)await fs.writeFile(path.join(h.root,'scenario-report.json'),JSON.stringify(report,null,2))
  if(process.env.AUTOFOLD_ACCEPTANCE_REPORT_DIR){await fs.mkdir(process.env.AUTOFOLD_ACCEPTANCE_REPORT_DIR,{recursive:true});await fs.writeFile(path.join(process.env.AUTOFOLD_ACCEPTANCE_REPORT_DIR,id+'.json'),JSON.stringify(report,null,2),{flag:'wx'})}
}
async function baseline() {
  const id='recovery.baseline-completes',facts:Record<string,unknown>={},observations:PublicObservation[]=[]
  let h:Harness|undefined,status='blocked',error:string|undefined
  try {
    h=await createAcceptanceHarness(id);console.log('Acceptance evidence '+h.root);await h.start()
    const {campaign,experiment,job}=await h.prepareCampaign();facts.initialJobId=job.id
    const processes=new Map<string,ProcessIdentity>()
    const latest=await waitFor('happy public CPU campaign completes two actual results',async()=>{
      const fixtureError=h!.provider.entries().find(row=>row.event==='fixture_error');if(fixtureError)throw Error('Provider actor fixture: '+JSON.stringify(fixtureError))
      await captureNewNativeProcesses(h!,processes)
      const row=await observe(h!,experiment.id,campaign.id);observations.push(row)
      if(row.holdReason&&!row.completed)throw Error('Happy public campaign unexpectedly held: '+row.holdReason)
      return row
    },row=>row.completed,90_000)
    const snapshots=new Map<string,Awaited<ReturnType<Harness['waitForWorkerExit']>>>()
    for(const [runId,identity] of processes)snapshots.set(runId,await h.waitForWorkerExit(identity,runId))
    const manifests=[]
    for(const run of latest.runs){const record=await h.api('/research/runs/'+run.id);manifests.push(await collectManifestEvidence({runId:run.id,workspace:h.workspace,outputPath:record.outputPath,expectedSha:snapshots.get(run.id)?.manifest.sha256}))}
    await requireCompletionQuiescence(h,experiment.id,campaign.id,observations,facts)
    const verdict=inspectBehavior({requestedResults:2,provider:h.provider.entries(),workers:await h.workerEntries(),observations,manifests});facts.verdict=verdict
    await fs.writeFile(path.join(h.root,'behavioral-verdict.json'),JSON.stringify({...verdict,observations},null,2))
    expect(verdict.failures,JSON.stringify(verdict,null,2)).toEqual([]);status='passed'
  }catch(caught){error=caught instanceof Error?caught.stack??caught.message:String(caught);status=Object.hasOwn(facts,'initialJobId')?'failed':'blocked';throw caught}
  finally {
    try{await h?.close()}catch(cleanup){status='failed';error=(error??'')+'\nCleanup: '+String(cleanup);throw cleanup}
    finally{await writeReport(h,id,status,facts,error)}
  }
}
async function scenario(mode:'restart'|'suspension',options:{id?:string;trajectories?:number;batchSize?:number}={}) {
  const id=options.id??(mode==='restart'?'recovery.restart-continues':'recovery.suspension-continues'),trajectories=options.trajectories??2,batchSize=options.batchSize??1
  let h:Harness|undefined,status:'passed'|'failed'|'blocked'='blocked',error:string|undefined
  const observations:PublicObservation[]=[],facts:Record<string,unknown>={}
  try {
    h=await createAcceptanceHarness(id);console.log('Acceptance evidence '+h.root)
    await h.start();const {experiment,campaign,job}=await h.prepareCampaign(trajectories,batchSize);facts.initialJobId=job.id;facts.requestedResults=trajectories;facts.discoveryBatchSize=batchSize
    const first=await waitFor('first genuine native CPU execution',async()=>{const fixtureError=h!.provider.entries().find(row=>row.event==='fixture_error');if(fixtureError)throw Error('Provider actor prerequisite: '+JSON.stringify(fixtureError));const entries=await h!.workerEntries();if(entries.some(row=>row.event==='worker_start'))return entries
      const jobs=await h!.api('/research/jobs'),failed=jobs.find((job:any)=>job.status==='failed'||job.status==='cancelled'||job.status==='recovery_required')
      if(failed)throw Error('Public workflow cannot reach fault injection: '+JSON.stringify({id:failed.id,status:failed.status,error:failed.error}))
      return entries},rows=>rows.some(row=>row.event==='worker_start'),90_000)
    const original=first.find(row=>row.event==='worker_start')!;const processIdentity=await h.verifyWorkerProcess(original);facts.originalWorkerPid=processIdentity.workerPid;facts.generationPid=processIdentity.generationPid;facts.interruptedRunId=original.runId
    observations.push(await observe(h,experiment.id,campaign.id))
    let originalPartialChild:any
    if(batchSize>1){
      const history=await h.api('/research/experiments/'+experiment.id+'/history')
      const run=history.runs.find((run:any)=>run.id===original.runId)
      const trial=history.trials.find((trial:any)=>trial.id===run?.trialId)
      expect(typeof trial?.origin?.jobId,'First actual effect must have a public original child identity').toBe('string')
      originalPartialChild=await h.api('/research/jobs/'+trial.origin.jobId)
      expect(originalPartialChild.payload.iterations).toBe(batchSize)
      expect(originalPartialChild.checkpoints['pi:job:start']).toBeDefined()
      expect(originalPartialChild.checkpoints['host:lifecycle:start']).toBeDefined()
      facts.originalPartialChild={id:originalPartialChild.id,sessionId:originalPartialChild.payload.sessionId,piJobStart:originalPartialChild.checkpoints['pi:job:start'],hostLifecycleStart:originalPartialChild.checkpoints['host:lifecycle:start']}
    }
    expect((await h.verifyWorkerProcess(original)).workerPid).toBe(processIdentity.workerPid)
    const faultAt=Date.now();if(mode==='restart')await h.kill();else await h.suspend()
    facts.faultAt=new Date(faultAt).toISOString()
    const originalWorkerExit=await h.waitForWorkerExit(processIdentity,original.runId)
    const originalWorkerExitAt=originalWorkerExit.at
    facts.originalWorkerExitAt=originalWorkerExitAt
    facts.originalManifestHashBeforeRecovery=originalWorkerExit.manifest.sha256
    expect(Date.parse(originalWorkerExitAt)).toBeGreaterThan(faultAt)
    // Product default is a 30-second owner lease. No test clock or DB mutation.
    await Bun.sleep(Math.max(0,faultAt+32_000-Date.now()))
    const restartAt=new Date().toISOString();facts.restartAt=restartAt
    expect(Date.parse(originalWorkerExitAt)).toBeLessThan(Date.parse(restartAt))
    if(mode==='restart')await h.start();else await h.resume()
    const processes=new Map<string,ProcessIdentity>([[original.runId,processIdentity]])
    let latest:PublicObservation|undefined
    try {
      latest=await waitFor('automatic original receipt recovery AND next distinct discovery',async()=>{await captureNewNativeProcesses(h!,processes);const row=await observe(h!,experiment.id,campaign.id);observations.push(row);return row},row=>row.completed,90_000)
    }catch(caught){facts.continuationWaitError=caught instanceof Error?caught.message:String(caught);latest=observations.at(-1)}
    const snapshots=new Map([[original.runId,originalWorkerExit]])
    for(const [runId,identity] of processes)if(runId!==original.runId)snapshots.set(runId,await h.waitForWorkerExit(identity,runId))
    const workers=await h.workerEntries(),manifests=[]
    for(const run of latest?.runs.filter(run=>run.status==='succeeded')??[]){const record=await h.api('/research/runs/'+run.id);manifests.push(await collectManifestEvidence({runId:run.id,workspace:h.workspace,outputPath:record.outputPath,expectedSha:snapshots.get(run.id)?.manifest.sha256}))}
    if(latest?.completed)await requireCompletionQuiescence(h,experiment.id,campaign.id,observations,facts)
    const evidence={requestedResults:trajectories,provider:h.provider.entries(),workers,observations,manifests,restartAt,interruptedRunId:original.runId}
    const verdict=inspectBehavior(evidence);facts.verdict=verdict
    await fs.writeFile(path.join(h.root,'behavioral-verdict.json'),JSON.stringify({...verdict,observations,evidence:{workerJournal:'worker-journal.jsonl',providerJournal:'provider-journal.jsonl',httpJournal:'http-journal.jsonl',controllerJournal:'controller-journal.jsonl'}},null,2))
    // This is the independent end-state oracle. Receipt collection alone is RED.
    expect(verdict.failures,JSON.stringify(verdict,null,2)).toEqual([])
    if(originalPartialChild){
      const history=await h.api('/research/experiments/'+experiment.id+'/history')
      const nativeStarts=workers.filter(worker=>worker.event==='worker_start')
      const firstBatchTrialIds=nativeStarts.slice(0,batchSize).map(worker=>history.runs.find((run:any)=>run.id===worker.runId)?.trialId)
      const firstBatchTrials=firstBatchTrialIds.map(trialId=>history.trials.find((trial:any)=>trial.id===trialId))
      expect(firstBatchTrials.length).toBe(batchSize)
      expect(firstBatchTrials.every((trial:any)=>trial?.origin?.jobId===originalPartialChild.id),'The interrupted batch must resume the SAME original child').toBe(true)
      expect(history.trials.filter((trial:any)=>trial.origin?.jobId===originalPartialChild.id).length,'Original child retains exactly its original batch grant').toBe(batchSize)
      const finalChild=await h.api('/research/jobs/'+originalPartialChild.id)
      expect(finalChild.payload).toEqual(originalPartialChild.payload)
      expect(finalChild.checkpoints['pi:job:start']).toEqual(originalPartialChild.checkpoints['pi:job:start'])
      expect(finalChild.checkpoints['host:lifecycle:start']).toEqual(originalPartialChild.checkpoints['host:lifecycle:start'])
      facts.sameOriginalChildResumed=true;facts.originalAuthorizationPreserved=true
      facts.originalPartialChildResultTrialIds=firstBatchTrialIds
    }
    status='passed'
  }catch(caught){error=caught instanceof Error?caught.stack??caught.message:String(caught);status=caught instanceof Error&&caught.message.startsWith('Acceptance prerequisite:')?'blocked':Object.hasOwn(facts,'interruptedRunId')?'failed':'blocked';throw caught}
  finally {
    try{await h?.close()}catch(cleanup){status='failed';error=(error??'')+'\nCleanup: '+String(cleanup);throw cleanup}
    finally {
      await writeReport(h,id,status,facts,error)
    }
  }
}

test('recovery.baseline-completes: real public campaign authors and completes two native CPU results with independent receipts',baseline,150_000)

test('recovery.restart-continues: original CPU receipt is collected once and discovery automatically continues after external service restart',()=>scenario('restart'),240_000)
test('recovery.suspension-continues: expired ownership after real controller suspension recovers and automatically continues',()=>scenario('suspension'),240_000)

test('recovery.partial-batch-continues: the SAME original partial child resumes its unchanged batch grant and completes all three authorized CPU results',()=>scenario('restart',{id:'recovery.partial-batch-continues',trajectories:3,batchSize:2}),270_000)
