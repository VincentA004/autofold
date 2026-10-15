import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {createServer} from 'node:net'
import {createProviderFixture, OFFLINE_API_KEY} from './provider'
import {createScientistActor} from './fixtures/scientist-actor'

const repository = path.resolve(import.meta.dir, '../..')
export type WorkerEntry = {event: 'worker_start'|'worker_exit_observed';runId:string;pid:number;at:string}
export async function waitFor<T>(description:string, read:()=>Promise<T>, accept:(value:T)=>boolean, timeoutMs=90_000):Promise<T> {
  const deadline = Date.now()+timeoutMs
  let value:T|undefined
  while(Date.now()<deadline) {value=await read();if(accept(value))return value;await Bun.sleep(100)}
  throw new Error('Acceptance timeout: '+description+'; last observation: '+JSON.stringify(value).slice(0,6000))
}
async function availablePort() {
  const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=(server.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port
}
async function commit(directory:string) {
  const child=Bun.spawn(['git','-C',directory,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'})
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  if(code||!/^[a-f0-9]{40}$/.test(stdout.trim()))throw Error('Acceptance prerequisite: pinned native source revision unavailable '+stderr)
  return stdout.trim()
}
async function append(file:string,row:unknown) {const handle=await fs.open(file,'a');try{await handle.write(JSON.stringify(row)+'\n');await handle.sync()}finally{await handle.close()}}
export async function createAcceptanceHarness(name:string,options:{unknownFirstInvoice?:boolean}={}) {
  const rootBase=path.resolve(process.env.AUTOFOLD_ACCEPTANCE_EVIDENCE_ROOT??path.join(repository,'.autofold/behavioral-suite-20261014'))
  const root=path.join(rootBase,name+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8))
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace,{recursive:true})
  const workerJournalPath=path.join(root,'worker-journal.jsonl'),httpJournal=path.join(root,'http-journal.jsonl'),lifecycleJournal=path.join(root,'controller-journal.jsonl')
  const port=await availablePort(),baseUrl='http://127.0.0.1:'+port,projectId='prj_behavioral_'+randomUUID().replaceAll('-','')
  const python=path.resolve(process.env.AUTOFOLD_TEST_PROTO_PYTHON??path.join(repository,'.autofold/envs/proto/bin/python'))
  const protoRoot=path.resolve(process.env.AUTOFOLD_TEST_PROTO_ROOT??path.join(repository,'.autofold/cohesive-engine-refactor-20261012/upstream-proto/v4/source'))
  await fs.access(python).catch(()=>{throw Error('Acceptance prerequisite: genuine native CPU Python runtime missing '+python)})
  const executionConfig=path.join(root,'execution-config.json')
  await fs.writeFile(executionConfig,JSON.stringify({python,proto:{root:protoRoot,python,languageCommit:await commit(protoRoot),toolsCommit:await commit(path.join(protoRoot,'proto-tools'))},authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:2}}))
  const scientistActor=createScientistActor(workerJournalPath);let providerReplies=0
  const provider=await createProviderFixture({journalPath:path.join(root,'provider-journal.jsonl'),actor:async request=>{
    const reply=await scientistActor(request)
    return options.unknownFirstInvoice&&providerReplies++===0?{...reply,reportedCostUsd:null}:reply
  },maximumRequests:64})
  let controller:ReturnType<typeof Bun.spawn>|undefined,generation=0,suspended=false,controllerExited=true
  const alive=()=>!!controller&&!controllerExited
  const controllerLogs:Promise<unknown>[]=[],ownedPids=new Set<number>()
  const env:Record<string,string>={PATH:process.env.PATH??'/usr/bin:/bin',HOME:path.join(workspace,'home'),TMPDIR:process.env.TMPDIR??'/tmp',LANG:'en_US.UTF-8',PYTHONDONTWRITEBYTECODE:'1',OPENROUTER_API_KEY:OFFLINE_API_KEY,AUTOFOLD_TEST_PROVIDER_URL:provider.url,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',CUDA_VISIBLE_DEVICES:'',PROTO_HOME:path.join(workspace,'proto')}
  async function start() {
    if(alive())throw Error('Owned controller already running')
    generation++;const log=await fs.open(path.join(root,'controller-'+generation+'.log'),'wx')
    controller=Bun.spawn([process.execPath,'--no-env-file','--preload',path.join(repository,'tooling/acceptance/provider-preload.ts'),path.join(repository,'backend/engine/src/server.ts'),'--port',String(port),'--workspace',workspace,'--project',projectId,'--execution-config',executionConfig],{cwd:repository,env,stdout:'pipe',stderr:'pipe'})
    controllerExited=false;const original=controller;void original.exited.then(()=>{if(controller===original)controllerExited=true})
    ownedPids.add(controller.pid)
    const pump=async(stream:ReadableStream<Uint8Array>)=>{for await(const chunk of stream)await log.write(chunk)}
    controllerLogs.push(Promise.all([pump(controller.stdout as ReadableStream<Uint8Array>),pump(controller.stderr as ReadableStream<Uint8Array>)]).finally(()=>log.close()))
    await append(lifecycleJournal,{event:'controller_started',pid:controller.pid,generation,at:new Date().toISOString()})
    await waitFor('public server health',async()=>{if(!alive())throw Error('Controller exited during startup; see '+root);return fetch(baseUrl+'/health').then(response=>response.ok).catch(()=>false)},Boolean,30_000)
  }
  async function api(route:string,body?:unknown,allowMissing=false):Promise<any> {
    const method=body===undefined?'GET':'POST'
    // Automatic-continuation scenarios explicitly forbid harness repair mutations.
    if(/\/(?:reconcile|retry|settle|rebuild-projection)$/.test(route))throw Error('Forbidden acceptance-harness recovery mutation '+route)
    const response=await fetch(baseUrl+route,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000)})
    const value=await response.json();await append(httpJournal,{at:new Date().toISOString(),method,route,status:response.status,request:body,response:value})
    if(response.status===404&&allowMissing)return undefined
    if(!response.ok)throw Error('Public API '+method+' '+route+' failed '+response.status+': '+JSON.stringify(value))
    return value
  }
  async function prepareCampaign(trajectories=2,discoveryBatchSize=1) {
    const campaign=await api('/research/campaigns',{objective:'PLUMBING_ONLY CPU behavioral acceptance: recover original independently supervised work and automatically continue the authorized campaign.'})
    await api('/research/campaigns/'+campaign.id+'/activate',{})
    const evaluators=await api('/research/evaluators'),evaluator=evaluators.find((item:any)=>item.id==='mock-peptide-panel')
    if(!evaluator)throw Error('Acceptance prerequisite: public CPU mock evaluator unavailable')
    const experiment=await api('/research/campaigns/'+campaign.id+'/experiments',{contract:{version:1,objective:'CPU plumbing only; no learned-generation, GPU or biological claim',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:2},evaluator:{...evaluator,fixedSeeds:[7,11],submissionSize:3}}})
    await api('/research/experiments/'+experiment.id+'/activate',{})
    const job=await api('/research/campaigns/'+campaign.id+'/loop',{idempotencyKey:'behavioral_campaign',experimentId:experiment.id,maxSteps:4,maximumTrajectories:trajectories,maximumDiscoveryTrajectories:trajectories,discoveryBatchSize,reservedReplayTrajectories:0,maximumKnowledgeRefreshes:0,modelBudgetUsd:1,perChildModelBudgetUsd:.5,maximumDurationMs:300_000})
    return {campaign,experiment,job}
  }
  async function workerEntries():Promise<WorkerEntry[]> {return fs.readFile(workerJournalPath,'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),()=>[])}
  async function verifyWorkerProcess(entry:WorkerEntry) {
    const snapshot=Bun.spawn(['/bin/ps','-axo','pid=,ppid=,args='],{stdout:'pipe',stderr:'pipe'})
    const [code,stdout,stderr]=await Promise.all([snapshot.exited,new Response(snapshot.stdout).text(),new Response(snapshot.stderr).text()])
    const rows=stdout.split('\n').flatMap(line=>{const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return match?[{pid:Number(match[1]),ppid:Number(match[2]),argv:match[3]!}]:[]})
    const chain:typeof rows=[];let current=rows.find(row=>row.pid===entry.pid)
    while(current&&chain.length<8){chain.push(current);current=rows.find(row=>row.pid===current!.ppid)}
    const worker=chain.find(row=>row.argv.includes(workspace)&&row.argv.includes('/'+entry.runId+'/')&&row.argv.includes('/worker/run_worker.py')&&row.argv.includes('--bundle'))
    await append(path.join(root,'worker-process-journal.jsonl'),{...entry,event:'worker_ancestry_observed',code,chain,stderr,observedAt:new Date().toISOString()})
    if(code!==0||!worker||(!chain[0]?.argv.includes('autofold_worker.stage_runner')||!chain[0]?.argv.includes('/'+entry.runId+'/')))throw Error('Native execution has no genuine generation-stage/worker OS ancestry: '+JSON.stringify(chain))
    return {generationPid:entry.pid,workerPid:worker.pid,workerArgv:worker.argv}
  }
  async function waitForPhysicalWorkerExit(worker:{workerPid:number;workerArgv:string},runId:string) {
    await waitFor('original complete worker process exit while controller unavailable',async()=>{
      const snapshot=Bun.spawn(['/bin/ps','-p',String(worker.workerPid),'-o','args='],{stdout:'pipe',stderr:'pipe'})
      const [code,stdout,stderr]=await Promise.all([snapshot.exited,new Response(snapshot.stdout).text(),new Response(snapshot.stderr).text()])
      if(code===0&&stdout.trim())return stdout.trim()!==worker.workerArgv
      if(code===1&&!stdout.trim()&&!stderr.trim()){
        try{process.kill(worker.workerPid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error}
      }
      throw Error('Acceptance prerequisite: OS worker inspection is unavailable or contradictory: '+JSON.stringify({pid:worker.workerPid,code,stdout,stderr}))
    },Boolean,45_000)
    const at=new Date().toISOString()
    await append(path.join(root,'worker-process-journal.jsonl'),{event:'root_worker_exit_observed',pid:worker.workerPid,runId,at})
    await append(workerJournalPath,{event:'worker_exit_observed',pid:worker.workerPid,runId,at})
    return {at}
  }
  async function waitForWorkerExit(worker:{workerPid:number;workerArgv:string},runId:string) {
    const {at}=await waitForPhysicalWorkerExit(worker,runId)
    // The root worker must have published its original immutable output before
    // the controller resumes; this file is observed, never synthesized/repaired.
    const manifest=path.join(workspace,'.autofold/runs',runId,'output/manifest.json')
    const bytes=new Uint8Array(await fs.readFile(manifest)),sha256='sha256:'+createHash('sha256').update(bytes).digest('hex')
    await fs.writeFile(path.join(root,'original-manifest-'+runId+'.json'),bytes,{flag:'wx'})
    await append(path.join(root,'worker-process-journal.jsonl'),{event:'original_manifest_observed',pid:worker.workerPid,runId,at,manifest,sha256})
    return {at,manifest:{runId,bytes,sha256}}
  }
  async function suspend() {if(!controller||!alive())throw Error('No owned controller to suspend');process.kill(controller.pid,'SIGSTOP');suspended=true;await append(lifecycleJournal,{event:'controller_suspended',pid:controller.pid,at:new Date().toISOString()})}
  async function resume() {if(!controller||!alive()||!suspended)throw Error('No owned suspended controller');process.kill(controller.pid,'SIGCONT');suspended=false;await append(lifecycleJournal,{event:'controller_resumed',pid:controller.pid,at:new Date().toISOString()})}
  async function kill() {if(!controller||!alive())return;if(suspended){process.kill(controller.pid,'SIGCONT');suspended=false}const pid=controller.pid;controller.kill('SIGKILL');await controller.exited;await append(lifecycleJournal,{event:'controller_killed',pid,at:new Date().toISOString()})}
  async function close() {
    if(controller&&alive()){if(suspended)await resume();controller.kill('SIGTERM');await Promise.race([controller.exited,Bun.sleep(5000)]);if(alive())await kill()}
    await Promise.all(controllerLogs);await provider.close()
    const remaining=(await workerEntries()).filter(row=>row.event==='worker_start').filter(start=>{try{process.kill(start.pid,0);return true}catch{return false}})
    const census=Bun.spawn(['/bin/ps','-axo','pid=,args='],{stdout:'pipe',stderr:'pipe'})
    const [censusCode,censusText,censusError]=await Promise.all([census.exited,new Response(census.stdout).text(),new Response(census.stderr).text()])
    const remainingWorkspaceProcesses=censusText.split('\n').filter(line=>line.includes(workspace))
    await fs.writeFile(path.join(root,'cleanup.json'),JSON.stringify({ownedControllerPids:[...ownedPids],controllerTerminal:!alive(),remainingObservedWorkerPids:remaining.map(row=>row.pid),remainingWorkspaceProcesses,censusCode,censusError,at:new Date().toISOString()},null,2))
    if(censusCode!==0||remaining.length||remainingWorkspaceProcesses.length)throw Error('Acceptance cleanup: owned local process is active or census unavailable; evidence '+root)
  }
  const hashes:Record<string,string>={}
  for(const relative of ['tooling/acceptance/harness.ts','tooling/acceptance/public-observation.ts','tooling/acceptance/fixtures/scientist-actor.ts','tooling/acceptance/fixtures/cpu-trial.ts','tooling/acceptance/provider.ts','tooling/acceptance/provider-preload.ts','tooling/acceptance/oracle.ts','tooling/acceptance/held-oracle.ts','tooling/acceptance/artifact-evidence.ts','tooling/acceptance/artifact-cancellation.ts','tooling/acceptance/scenarios/interruption-recovery.test.ts','tooling/acceptance/scenarios/held-boundaries.test.ts'])hashes[relative]='sha256:'+createHash('sha256').update(await fs.readFile(path.join(repository,relative))).digest('hex')
  await fs.writeFile(path.join(root,'configuration.json'),JSON.stringify({format:'autofold.blackbox-acceptance.v1',root,workspace,projectId,entrypoint:'backend/engine/src/server.ts',defaultWorker:true,unknownFirstInvoice:options.unknownFirstInvoice??false,providerBoundary:'native Pi OpenRouter HTTP/SSE redirected to loopback',workerBoundary:'actual native CPU Program.run with independent fsynced execution journal',gpuCalls:0,paidProviderCalls:0,hashes},null,2))
  return {root,workspace,projectId,baseUrl,provider,start,api,prepareCampaign,workerEntries,verifyWorkerProcess,waitForWorkerExit,waitForPhysicalWorkerExit,suspend,resume,kill,close,pid:()=>controller?.pid}
}
