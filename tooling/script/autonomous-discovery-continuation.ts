import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {Database} from 'bun:sqlite'
import {Application} from '../../backend/engine/src/application.ts'
import {loadExecutionConfig} from '../../backend/engine/src/config.ts'
import {workerTreeIdentity} from '../../backend/engine/src/execution/index.ts'
import {openSessionReader,assertSessionAccountingComplete} from '../../backend/engine/src/runtime/index.ts'
import {operationHash} from '../../backend/science-core/src/research/operations.ts'
import {ResearchDomain} from '../../backend/science-core/src/research/domain.ts'
import {auditAuthoredProgram} from '../../backend/engine/src/acceptance/index.ts'
import {ResearchArtifacts} from '../../backend/science-core/src/research/artifacts.ts'
const routing={mode:'openrouter_default',providerOverride:false}

const main=path.resolve(import.meta.dir,'../..'),workspace=path.join(main,'.autofold/cohesive-engine-refactor-20261012/autonomous-discovery-20261013')
const projectId='prj_autonomous_discovery_20261013',parentOperator=path.join(workspace,'operator'),operator=path.join(parentOperator,'continuation-01')
const model={provider:'openrouter',modelId:'deepseek/deepseek-v4.1-flash'}
const hash=(v:string|Uint8Array)=>'sha256:'+crypto.createHash('sha256').update(v).digest('hex')
const terminal=(s:string)=>['succeeded','failed','cancelled'].includes(s)
const save=async(name:string,v:unknown,exclusive=false)=>{
 const file=path.join(operator,name),bytes=JSON.stringify(v,null,2)+'\n'
 if(exclusive){await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return}
 const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});await fs.rename(temp,file)
}
async function source(){
 const sourceRoot=path.join(main,'backend/engine/src'),files:Array<{path:string;contentHash:string}>=[]
 const visit=async(dir:string)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw Error('Unexpected source symlink');const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()&&((entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts'))||entry.name==='SKILL.md'))files.push({path:path.relative(sourceRoot,file).split(path.sep).join('/'),contentHash:hash(await fs.readFile(file))})}}
 await visit(sourceRoot);await visit(path.join(main,'backend/science-core/src'));files.sort((a,b)=>a.path.localeCompare(b.path))
 for(const relative of ['../package.json','../../science-core/package.json','../../../package.json','../../../package-lock.json'])files.push({path:relative,contentHash:hash(await fs.readFile(path.resolve(sourceRoot,relative)))})
 return {sourceHash:hash(JSON.stringify(files)),workerHash:(await workerTreeIdentity(path.join(main,'backend/worker'))).sourceHash,files}
}
async function pin(file:string){return {path:file,contentHash:hash(await fs.readFile(file))}}
async function pins(){
 const p=await Bun.file(path.join(operator,'launch-preparation.json')).json(),s=await source()
 if(s.sourceHash!==p.sourceHash||s.workerHash!==p.workerHash)throw Error('Tested source or worker changed; do not launch stale preparation')
 for(const item of [p.profile,p.contract,p.driver,p.grant,p.offline,p.historicalBefore,...p.offlineLogs,...p.targetFiles])if(hash(await fs.readFile(item.path))!==item.contentHash)throw Error('Frozen pin changed: '+item.path)
 return p
}
async function prepare(){
 if(await fs.access(operator).then(()=>true,()=>false))throw Error('Continuation preparation already exists')
 await fs.mkdir(operator,{recursive:true,mode:0o700})
 const previous=await Bun.file(path.join(parentOperator,'launch-preparation.json')).json(),origin=await Bun.file(path.join(parentOperator,'campaign-result.json')).json()
 if(origin.status!=='succeeded'||origin.result.status!=='deferred'||origin.result.boundary!=='runtime_limit_reached'||origin.result.modelCostUsd!==0.042947412)throw Error('Original source must be settled with exact known billing and zero consumed work')
 for(const name of ['profile.json','contract.json','host-readiness.json'])await fs.copyFile(path.join(parentOperator,name),path.join(operator,name),fs.constants.COPYFILE_EXCL)
 const identity=await source();if(identity.sourceHash!==previous.sourceHash||identity.workerHash!==previous.workerHash)throw Error('Source changed since settled original attempt')
 const grant={...await Bun.file(path.join(parentOperator,'human-grant.json')).json(),maxTurns:64,maxToolCalls:128,continuationOf:origin.id,priorSettledCostUsd:origin.result.modelCostUsd,reason:'Original 24-turn allowance ended immediately after successful autonomous native validation; continue same scientist/draft without resetting original inference/trial/deadline ceilings.'}
 await save('human-grant.json',grant,true)
 await save('launch-preparation.json',{...previous,preparedAt:new Date().toISOString(),driver:await pin(import.meta.path),profile:await pin(path.join(operator,'profile.json')),contract:await pin(path.join(operator,'contract.json')),grant:await pin(path.join(operator,'human-grant.json')),continuationOf:origin.id,originalPreparation:await pin(path.join(parentOperator,'launch-preparation.json'))},true)
 console.log(JSON.stringify({mode:'prepared_residual_continuation',workspace,continuationOf:origin.id,remainingInferenceUsd:2-origin.result.modelCostUsd,providerCalls:0,gpuCalls:0}))
}
async function verifyShutdown(){
 await pins()
 if(!await Bun.file(path.join(operator,'driver-exit.json')).exists())throw Error('Original local driver has not exited')
 const remote=(await Bun.file(path.join(operator,'profile.json')).json()).remote
 if(remote.host!=='workstation_4090'||remote.root!=='/home/vincent/.autofold-autonomous-discovery-20261013')throw Error('Original worker destination differs')
 const attempts=await Bun.file(path.join(operator,'original-dispatch-records.json')).json().catch(()=>[])
 const code=`import json,pathlib,subprocess,datetime,os
root=pathlib.Path(${JSON.stringify(remote.root)})
processes=[]
for d in pathlib.Path('/proc').iterdir():
 if not d.name.isdigit() or int(d.name)==os.getpid():continue
 try:
  args=(d/'cmdline').read_bytes().decode(errors='replace').split('\\x00')
  cwd=str((d/'cwd').resolve())
  if any(str(root) in a for a in args) or cwd.startswith(str(root)+'/') or cwd==str(root):processes.append({'pid':int(d.name),'executable':pathlib.Path(args[0]).name})
 except (OSError,IndexError):pass
receipts=[]
for d in sorted((root/'runs').glob('*')):
 f=d/'remote-receipt.json'
 if f.is_file():
  v=json.loads(f.read_text());receipts.append({k:v.get(k) for k in ['runId','requestId','bundleHash','planHash','workerHash','state','exitCode','completedAt']})
gpu=subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_gpu_memory','--format=csv,noheader'],text=True,capture_output=True,timeout=10)
print(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originalRoot':str(root),'originalProcesses':processes,'receipts':receipts,'gpuQueryReturnCode':gpu.returncode,'gpuComputeProcesses':gpu.stdout.strip(),'readOnly':True}))
`
 const child=Bun.spawn(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','--',remote.host,remote.python+' -'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
 child.stdin.write(code);child.stdin.end();const timer=setTimeout(()=>child.kill(),40000)
 let response:string,exitCode:number
 try{[response,exitCode]=await Promise.all([new Response(child.stdout).text(),child.exited]);const stderr=await new Response(child.stderr).text();if(exitCode)throw Error('Original shutdown observation failed: '+stderr.slice(0,1000))}finally{clearTimeout(timer)}
 const observation=JSON.parse(response),expected=new Set(attempts.map((item:any)=>item.runId))
 const receiptIds=new Set(observation.receipts.map((item:any)=>item.runId))
 const originalReceiptsTerminal=expected.size===attempts.length&&receiptIds.size===expected.size&&observation.receipts.every((item:any)=>expected.has(item.runId)&&attempts.some((attempt:any)=>attempt.runId===item.runId&&attempt.bundleHash===item.bundleHash&&attempt.workerHash===item.workerHash)&&['succeeded','failed','cancelled','timed_out'].includes(item.state))
 const passed=observation.originalProcesses.length===0&&originalReceiptsTerminal&&observation.gpuQueryReturnCode===0
 await save('shutdown-evidence.json',{...observation,expectedOriginalRuns:[...expected],originalReceiptsTerminal,passed,newEffects:0,inferenceCalls:0,remoteMutationCalls:0})
 console.log(JSON.stringify({mode:'original_read_only_shutdown',passed,originalProcesses:observation.originalProcesses,originalReceiptsTerminal}))
 if(!passed)process.exitCode=1
}
const mode=process.argv.slice(2).join(' ')
if(mode==='--prepare'){await prepare();process.exit(0)}
if(mode==='--verify-preparation'){await pins();console.log(JSON.stringify({mode:'verified_local_preparation',remoteCalls:0,providerCalls:0}));process.exit(0)}
if(mode==='--verify-shutdown'){await verifyShutdown();process.exit(process.exitCode??0)}
if(mode!=='--launch')throw Error('Use --prepare for local-only final pinning, --verify-shutdown for original read-only physical verification, or --launch for the one original bounded campaign')
async function persistedSessions(){
 const file=path.join(workspace,'.autofold/pi',projectId,'sessions.sqlite')
 if(!await Bun.file(file).exists())return {sessions:[],leases:[],journal:[]}
 const db=new Database(file,{readonly:true}),reader=openSessionReader(file)!
 try{const ids=(db.query('SELECT id FROM pi_sessions').all() as {id:string}[]).map(r=>r.id),sessions=[],journal=[]
  for(const id of ids){const session=await reader.get(id);if(!session)throw Error('Original session archive unavailable: '+id);sessions.push(session);journal.push(...await reader.events(id))}
  return {sessions,leases:db.query('SELECT session_id,expires_at FROM pi_leases WHERE expires_at>?').all(Date.now()),journal}
 }finally{reader.close();db.close()}
}
const prepared=await pins(),grant=await Bun.file(path.join(operator,'human-grant.json')).json()
if(grant.maximumTrials!==8||grant.maximumDiscoveryTrajectories!==2||grant.reservedReplayTrajectories!==6||grant.maximumGpuSeconds!==600||grant.maximumWorkerWallMinutes!==15||grant.modelBudgetUsd!==2||grant.reportedInferenceCeilingUsd!==2||grant.maximumModelRequests!==384||grant.maximumCampaignSteps!==8||grant.perChildModelBudgetUsd!==.5||grant.maxTurns!==64||grant.maxToolCalls!==128||grant.autofoldOutputTokenCap!==null||grant.providerRetries!==0||JSON.stringify(grant.model)!==JSON.stringify(model)||grant.maximumDurationMs!==7200000||grant.sourceHash!==prepared.sourceHash||JSON.stringify(grant.routing)!==JSON.stringify(routing))throw Error('Fresh bounded grant mismatch')
const profile=await Bun.file(prepared.profile.path).json()
if(profile.remote?.host!=='workstation_4090'||profile.remote?.root!=='/home/vincent/.autofold-autonomous-discovery-20261013')throw Error('Fresh authorized worker destination differs')
const readiness=await Bun.file(path.join(operator,'host-readiness.json')).json()
if(!Number.isFinite(Date.parse(readiness.observedAt))||Date.now()-Date.parse(readiness.observedAt)>600000||readiness.computeReturnCode!==0||readiness.gpuComputeProcesses||readiness.workerProcesses.length||!readiness.freshRootAbsent||!Object.values(readiness.requiredPaths).every(Boolean))throw new Error('Idle bound host readiness required')
const credentials=await Bun.file('/Users/vincentallam/.local/share/openscience/auth.json').json()
if(typeof credentials.openrouter?.key!=='string'||!credentials.openrouter.key)throw new Error('Selected host credential unavailable')
delete process.env.OPENROUTER_API_KEY
const origin=await Bun.file(path.join(parentOperator,'campaign-result.json')).json(),priorCost=origin.result.modelCostUsd;const launchMs=Date.now(),authorizedAt=new Date(launchMs).toISOString(),deadlineMs=Date.parse((await Bun.file(path.join(parentOperator,'launch-fence.json')).json()).deadline)
await save('launch-fence.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),projectId,workspace,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,grantHash:hash(await fs.readFile(path.join(operator,'human-grant.json')))},true)
const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(new Error('Original long-range deadline reached')),deadlineMs-Date.now())
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort(new Error('Controller interrupted; inspect only original effects')))
let app:Application|undefined,jobId:string|undefined,timer:ReturnType<typeof setInterval>|undefined,busy=false,count=0,stage='preflight',error:unknown
count=24;const observations:Promise<unknown>[]=[],providerReceipts:any[]=await Promise.all(Array.from({length:24},(_,i)=>Bun.file(path.join(parentOperator,'provider-response-'+(i+1)+'.json')).json())),payloadOutputSizing:number[][]=[];let dispatches=0,reopen=false,reopenForbiddenCalls=0
const authorize=()=>{if(reopen)throw Error('Receipt-only reopen forbids all inference and dispatch');controller.signal.throwIfAborted();if(Date.now()>=deadlineMs)throw new Error('Original deadline expired')}
const providerReportedCost=()=>providerReceipts.length===count&&providerReceipts.every(r=>typeof r.usage?.cost==='number'&&Number.isFinite(r.usage.cost)&&r.usage.cost>=0)?providerReceipts.reduce((n,r)=>n+r.usage.cost,0):null
const auditedFetch=Object.assign(async(url:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
 if(new URL(String(url)).origin!=='https://openrouter.ai')throw new Error('Unapproved model recipient')
 authorize();await Promise.all(observations);const sdkSpent=(await persistedSessions()).sessions.reduce((n,s)=>n+s.usage.costUsd,0);if(sdkSpent>=grant.modelBudgetUsd)throw Error('Aggregate SDK estimate ceiling reached');const actual=providerReportedCost();if(count&&actual===null)throw Error('Original provider billing unresolved; no further inference');if(count>=grant.maximumModelRequests)throw Error('Fresh model request ceiling reached');if(actual!==null&&actual>=grant.reportedInferenceCeilingUsd)throw Error('Actual provider cost ceiling reached');const payload=JSON.parse(String(init?.body)),caps=['max_tokens','max_completion_tokens'].filter(k=>payload[k]!==undefined).map(k=>payload[k]);if(payload.model!==model.modelId||Object.hasOwn(payload,'provider')||caps.some(v=>!Number.isSafeInteger(v)||v<1))throw Error('Frozen model/routing/native capacity policy differs');payloadOutputSizing.push(caps);count++;const sequence=count;await save('route-latest.json',{count,model,routing,providerOverridePresent:false,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,nativePayloadOutputSizing:caps,payloadMessageCharacters:JSON.stringify(payload.messages??[]).length,priorReportedProviderCostUsd:actual,recordedAt:new Date().toISOString()});const response=await fetch(url,init),clone=response.clone()
 const observation=(async()=>{if(!response.ok){void clone.body?.cancel();const r={requestSequence:sequence,status:response.status,error:{classification:'router_http_error',code:response.status,message:'OpenRouter rejected original request; billing remains unknown'},observedAt:new Date().toISOString()};providerReceipts.push(r);await save('provider-response-'+sequence+'.json',r,true);return}const reader=clone.body?.getReader();if(!reader)return;let pending='',metadata:any={requestSequence:sequence,status:response.status},decoder=new TextDecoder()
  const consume=(line:string)=>{if(!line.startsWith('data: '))return;try{const c=JSON.parse(line.slice(6));for(const k of ['id','provider','model'])if(c[k]!==undefined&&c[k]!==null){if(typeof c[k]!=='string'||c[k].length>256){metadata.identityInvalid=true;continue}if(k==='id'&&metadata.id&&metadata.id!==c.id)metadata.identityConflict=true;metadata[k]=c[k]}if(c.error)metadata.error={classification:'router_stream_error',message:'Original stream returned an error; billing requires original evidence'};if(c.usage&&typeof c.usage==='object'){metadata.usage??={};for(const key of ['cost','prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens'])if(typeof c.usage[key]==='number'&&Number.isFinite(c.usage[key]))metadata.usage[key]=c.usage[key]}}catch{}}
  try{for(;;){const v=await reader.read();if(v.done)break;pending+=decoder.decode(v.value,{stream:true});let i;while((i=pending.indexOf('\n'))>=0){consume(pending.slice(0,i));pending=pending.slice(i+1)}}consume(pending)}catch(e){metadata.observationError='original_stream_read_failed'}finally{reader.releaseLock()}
  const receipt={...metadata,observedAt:new Date().toISOString()};providerReceipts.push(receipt);await save('provider-response-'+sequence+'.json',receipt,true)
 })();observations.push(observation);return response
},{preconnect:fetch.preconnect})
async function bindOriginalJob(state:Awaited<ReturnType<Application['store']['read']>>){if(jobId)return;const originals=Object.values(state.jobs).filter(j=>j.payload.kind==='autoresearch');if(originals.length===1)jobId=originals[0]!.id;else if(originals.length>1)throw Error('Ambiguous original acceptance job identity')}
const observe=async()=>{if(!app||busy)return;busy=true;try{const state=await app.store.read(projectId);await bindOriginalJob(state);dispatches=0;for(const run of Object.values(state.runs))if(await Bun.file(path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json')).exists())dispatches++;const snapshot={stage,observedAt:new Date().toISOString(),jobId:jobId??Object.values(state.jobs).find(j=>j.payload.kind==='autoresearch')?.id,jobs:Object.values(state.jobs).map(j=>({id:j.id,kind:j.payload.kind,status:j.status,cost:j.result?.modelCostUsd})),trials:Object.values(state.trials).map(t=>({id:t.id,status:t.status})),runs:Object.values(state.runs).map(r=>({id:r.id,status:r.status})),operations:await app.operationDiagnostics(),providerRequests:count,originalDispatches:dispatches,providerReportedCostUsd:providerReportedCost(),canonicalCostSemantics:'sdk_static_price_estimate',actualProviders:[...new Set(providerReceipts.map(r=>r.provider).filter(Boolean))]};await save('monitor-latest.json',snapshot);console.log(JSON.stringify(snapshot))}catch(e){console.error(JSON.stringify({type:'observation_error',message:String(e)}))}finally{busy=false}}
try{
 const config=(await loadExecutionConfig(prepared.profile.path))!
 app=new Application({workspace,projectId,execution:{...config,authorization:{...config.authorization,deadlineMs,authorize}},jobs:{runtimeOptions:{getApiKey:p=>p==='openrouter'?credentials.openrouter.key:undefined,authorizeModelRequest:authorize,requireProviderReportedUsage:true,limits:{maxTurns:64,maxToolCalls:128,maxDurationMs:7200000},streamOptions:{maxRetries:0,fetch:auditedFetch,onPayload:async(payload:any,m:any)=>{authorize();await Promise.all(observations);const sdkSpent=(await persistedSessions()).sessions.reduce((n,s)=>n+s.usage.costUsd,0);if(sdkSpent>=grant.modelBudgetUsd)throw Error('Aggregate SDK estimate ceiling reached');const actual=providerReportedCost();if(count&&actual===null)throw new Error('Original provider billing unresolved; no further inference');if(count>=grant.maximumModelRequests)throw new Error('Fresh validation model-request ceiling reached');if(actual!==null&&actual>=grant.reportedInferenceCeilingUsd)throw new Error('Actual OpenRouter cost ceiling reached');if(m.provider!==model.provider||m.id!==model.modelId)throw new Error('Authorized model changed');const caps=['max_tokens','max_completion_tokens'].filter(k=>payload[k]!==undefined).map(k=>payload[k]);if(caps.some(v=>!Number.isSafeInteger(v)||v<1))throw Error('Invalid native SDK output sizing');const {provider:ignored,...routed}=payload;return routed}}}}})
 const contract=ResearchDomain.ExperimentContract.parse(await Bun.file(prepared.contract.path).json());const frozenProfile=await Bun.file(prepared.profile.path).json();if(contract.budget.maximumCandidates!==1||contract.budget.gpuHours!==600/3600||contract.budget.wallTimeMinutes!==15||JSON.stringify(contract.evaluator.fixedSeeds)!=='[20260809]'||contract.evaluator.submissionSize!==1||frozenProfile.authorization.maximumGpuSeconds!==600||frozenProfile.authorization.maximumCandidates!==1||frozenProfile.authorization.maximumWallTimeMinutes!==15)throw Error('Frozen per-trial grant differs')
 if(ResearchDomain.hashContract(contract)!==prepared.contractHash)throw new Error('Frozen scientific contract changed')
 const campaign=(await app.store.read(projectId)).campaigns[origin.payload.campaignId]!
 const experiment=await app.experiment(origin.payload.experimentId)
 if(origin.result.remainingTrajectories!==8||origin.result.remainingDiscoveryTrajectories!==2)throw Error('Residual empirical authority differs')
 await app.skills.initialize(campaign.id)
 await app.execution.preflightExperiment(await app.experiment(experiment.id),controller.signal)
 await pins()
 const job=await app.campaign.enqueueCampaign(campaign.id,{idempotencyKey:'fresh-autonomous-discovery-20261013-continuation-01',continuedFromJobId:origin.id,experimentId:experiment.id,maxSteps:7,maximumTrajectories:8,maximumDiscoveryTrajectories:2,reservedReplayTrajectories:6,discoveryBatchSize:2,maximumKnowledgeRefreshes:0,modelBudgetUsd:2-priorCost,perChildModelBudgetUsd:.5,maximumDurationMs:Math.max(1,Math.min(deadlineMs,Date.parse(origin.startedAt)+origin.payload.maximumDurationMs)-Date.now()-1000),modelSelection:model})
 jobId=job.id
 await save('authorization.json',{authorizedAt,deadline:new Date(deadlineMs).toISOString(),workspace,projectId,campaignId:campaign.id,experimentId:experiment.id,jobId,contractHash:experiment.contractHash,sourceHash:prepared.sourceHash,workerHash:prepared.workerHash,limits:grant,controlledFault:false,operatorAuthoredScience:false},true)
 await save('original-job-identity.json',{jobId,sessionId:job.payload.sessionId,campaignId:campaign.id,experimentId:experiment.id},true)
 stage='native_cohesive_engine_campaign';await observe();timer=setInterval(()=>void observe(),30000)
 await app.jobs.runOnce({jobId,signal:controller.signal})
 await Promise.all(observations);await pins()
 let state=await app.store.read(projectId)
 await save('campaign-result.json',await app.jobs.get(jobId),true)
 if(Object.keys(state.trials).length>8||Object.keys(state.runs).length>8||Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length>2||Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length>6)throw new Error('Fresh trial grant exceeded')
 const attempts=[];for(const run of Object.values(state.runs)){const file=path.join(workspace,path.dirname(run.bundlePath),'remote-launch-attempt.json');if(await Bun.file(file).exists())attempts.push({runId:run.id,...await Bun.file(file).json()})}dispatches=attempts.length;if(dispatches>8)throw Error('Original launch attempt grant exceeded');await save('original-dispatch-records.json',attempts,true)
 const trialBudgetChecks=[];for(const run of Object.values(state.runs)){const bundle=await Bun.file(path.join(workspace,run.bundlePath)).json(),planFile=path.join(workspace,path.dirname(run.bundlePath),'remote-plan.identity.json'),plan=await Bun.file(planFile).exists()?await Bun.file(planFile).json():undefined;trialBudgetChecks.push({runId:run.id,passed:bundle.candidateBudget===1&&bundle.submissionSize===1&&JSON.stringify(bundle.seeds)==='[20260809]'&&bundle.nativeExecution?.observation==='scoped_native_lifecycle_v1'&&bundle.nativeExecution.resources.reservedSearchComputeSeconds+bundle.nativeExecution.resources.reservedEvaluationComputeSeconds<=600&&bundle.contractHash===prepared.contractHash&&bundle.targetArtifactHash===contract.targetArtifactHash&&bundle.evaluator?.id===contract.evaluator.id&&bundle.evaluator?.version===contract.evaluator.version&&(!plan||Number.isFinite(plan.timeoutMs)&&plan.timeoutMs>0&&plan.timeoutMs<=15*60000&&Number.isFinite(plan.authorizationDeadlineMs)&&plan.authorizationDeadlineMs<=deadlineMs)})}
 let sessions=await persistedSessions();for(const session of sessions.sessions)assertSessionAccountingComplete(session)
 await save('sessions.json',sessions.sessions,true);await save('pi-events.json',sessions.journal,true)
 const receipts=[],failedReceipts=[]
 for(const run of Object.values(state.runs)){
  if(run.status==='failed'||run.status==='cancelled'){const receipt=await app.execution.failureReceipt(run.id);await save('verified-failure-'+run.id+'.json',receipt,true);failedReceipts.push(receipt);continue}
  if(run.status!=='succeeded')continue
  const receipt=await app.execution.artifacts(run.id);await save('verified-receipt-'+run.id+'.json',receipt,true)
  const trial=state.trials[run.trialId]!
  receipts.push({runId:run.id,trialId:trial.id,intent:trial.intent,manifestHash:run.manifestHash,valid:receipt.evaluation.valid,score:receipt.evaluation.score,scientific:receipt.scientific,workerHash:receipt.worker?.sourceHash,wallSeconds:(Date.parse(run.completedAt!)-Date.parse(run.startedAt!))/1000})
 }
 const responses=[...providerReceipts.filter(r=>r.requestSequence<=24),...await Promise.all((await fs.readdir(operator)).filter(n=>/^provider-response-\d+\.json$/.test(n)).map(n=>Bun.file(path.join(operator,n)).json()))]
 const providerCost=providerReportedCost(),sessionCost=sessions.sessions.reduce((n,s)=>n+s.usage.costUsd,0),jobCost=Number(state.jobs[jobId]!.result?.modelCostUsd)+priorCost
 const ledger=sessions.sessions.flatMap(session=>Object.entries(session.modelRequests??{}).map(([requestId,request])=>({sessionId:session.id,requestId,...request}))),dispatched=ledger.filter(r=>r.status!=='not_dispatched')
 const ledgerReportedCost=dispatched.every(r=>r.providerBilling?.status==='reported'&&Number.isFinite(r.providerBilling.reportedCostUsd))?dispatched.reduce((n,r)=>n+r.providerBilling!.reportedCostUsd!,0):null
 const boundIds=new Set(dispatched.map(r=>r.providerBilling?.upstreamRequestId)),responseIds=new Set(responses.map(r=>r.id))
 const perRequestBilling=dispatched.map(request=>{
  const billing=request.providerBilling,response=responses.find(r=>r.id===billing?.upstreamRequestId)
  const evidenceHash=response?hash(JSON.stringify({upstreamRequestId:response.id,routedProvider:response.provider,reportedCostUsd:response.usage?.cost})):undefined
  return {sessionId:request.sessionId,requestId:request.requestId,upstreamRequestId:billing?.upstreamRequestId,passed:request.status==='settled'&&request.model.provider===model.provider&&request.model.modelId===model.modelId&&!!response&&typeof response.id==='string'&&response.id.length>0&&typeof response.provider==='string'&&response.provider.length>0&&response.model===model.modelId&&typeof response.usage?.cost==='number'&&Number.isFinite(response.usage.cost)&&response.usage.cost>=0&&billing?.status==='reported'&&billing.routedProvider===response.provider&&billing.reportedCostUsd===response.usage.cost&&billing.evidenceHash===evidenceHash&&!response.error&&!response.identityConflict&&!response.identityInvalid&&!response.observationError}
 })
 const exactBillingIds=dispatched.length===count&&responses.length===count&&boundIds.size===count&&responseIds.size===count&&[...boundIds].every(id=>typeof id==='string'&&responseIds.has(id))&&perRequestBilling.every(r=>r.passed)
 const effectSnapshot=async()=>{
  const originals=[];const root=path.join(workspace,'.autofold/runs');if(await Bun.file(root).exists().catch(()=>false)||await fs.stat(root).then(v=>v.isDirectory(),()=>false))for(const entry of await fs.readdir(root,{withFileTypes:true})){if(!entry.isDirectory())continue;const file=path.join(root,entry.name,'remote-launch-attempt.json');if(await Bun.file(file).exists())originals.push({runId:entry.name,contentHash:hash(await fs.readFile(file))})}
  originals.sort((a,b)=>a.runId.localeCompare(b.runId))
  return {requests:count,providerIds:providerReceipts.map(r=>r.id).sort(),jobs:Object.keys(state.jobs).sort(),trials:Object.keys(state.trials).sort(),runs:Object.keys(state.runs).sort(),sessionIds:sessions.sessions.map(s=>s.id).sort(),sessionRequestIds:sessions.sessions.flatMap(s=>Object.keys(s.modelRequests??{}).map(id=>s.id+':'+id)).sort(),operations:Object.keys(state.operations).sort(),operationEvents:Object.keys(state.operationEvents).sort(),operationOutbox:Object.values(state.operationOutbox).filter(item=>item.purpose==='effect').map(item=>item.id).sort(),scientistLanes:Object.keys(state.scientistLanes).sort(),sessionEvents:sessions.journal.map(e=>e.sessionId+':'+e.sequence).sort(),originalLaunchAttempts:originals,originalLaunchAttemptCount:originals.length}
 }
 const before=await effectSnapshot();let recovery:any
 if(Object.values(state.jobs).every(j=>terminal(j.status))){
  stage='receipt_only_terminal_reopen';reopen=true
  const noInference=()=>{reopenForbiddenCalls++;throw Error('Terminal receipt-only verifier forbids inference')}
  const verifier=new Application({workspace,projectId,execution:{...config,authorization:{...config.authorization,authorize:noInference}},jobs:{runtimeOptions:{streamFn:noInference,getApiKey:noInference,authorizeModelRequest:noInference}}})
  recovery=await verifier.jobs.reconcileDetailed(jobId)
  state=await verifier.store.read(projectId);sessions=await persistedSessions()
 }
 const after=await effectSnapshot()
 const sameOriginalEffects=(snapshot:Awaited<ReturnType<typeof effectSnapshot>>)=>{const {operationEvents,...effects}=snapshot;return effects}
 const operations=await app.operationDiagnostics()
 const settled=Object.values(state.jobs).every(j=>terminal(j.status)&&!j.leaseId)&&Object.values(state.runs).every(r=>terminal(r.status))&&sessions.leases.length===0&&sessions.sessions.every(s=>s.status!=='running'&&Object.keys(s.pendingTools??{}).length===0)&&Object.values(state.scientistLanes).every(l=>{const lane=l.state as any;return lane&&typeof lane==='object'&&!lane.pending&&!lane.operation&&Object.values(lane.requests??{}).every((r:any)=>r.phase==='result'&&r.result)})&&operations.every(o=>o.settlement==='settled'&&!o.owner)
 const authoringChecks=[]
 const details=(event:any)=>event.data?.result?.details??event.data?.result
 const successfulTool=(event:any,name:string)=>event.type==='tool_execution_end'&&event.data?.toolName===name&&!event.data?.isError
 const legacyToolAbsence=sessions.journal.every((event:any)=>!['submit_shadow_program','read_reference'].includes(event.data?.toolName))
 for(const trial of Object.values(state.trials)){
  let sessionId:string|undefined,submission:any
  if(trial.intent==='shadow_replay'){
   const slot=Object.values(state.operations).filter(operation=>operation.kind==='skill_shadow_replay').flatMap(operation=>Object.values((operation.state as any).arms??{}) as any[]).find(arm=>arm.proposal?.programHash===trial.programHash&&arm.trialId===trial.id)
   sessionId=slot?.sessionId
  }else sessionId=String(state.jobs[trial.origin?.jobId??'']?.payload.sessionId??'')||undefined
  const trace=sessions.journal.filter((event:any)=>event.sessionId===sessionId)
  const originalRun=Object.values(state.runs).find(run=>run.trialId===trial.id),originalRequest=originalRun?await Bun.file(path.join(workspace,'.autofold/runs',originalRun.id,'request.json')).json():undefined
  if(trial.intent==='shadow_replay')submission=trace.find((event:any)=>successfulTool(event,'submit_trial')&&details(event)?.accepted===true&&details(event)?.programHash===trial.programHash)
  const start=submission?trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolCallId===submission.data?.toolCallId):trace.find((event:any)=>event.type==='tool_execution_start'&&event.data?.toolName==='evaluate_trial'&&event.data?.args?.requestId===originalRequest?.requestId)
  const author=trace.filter((event:any)=>['write','edit','write_file','edit_file'].some(name=>successfulTool(event,name))&&details(event)?.programHash===trial.programHash&&event.sequence<(start?.sequence??0)).at(-1)
  const fileHash=hash(await fs.readFile(path.join(workspace,trial.programPath)))
  const passed=fileHash===trial.programHash&&await auditAuthoredProgram(trace,author,trial.programHash,start?.sequence,details(author)?.path)&&!!start&&(trial.intent!=='shadow_replay'||!!submission)
  authoringChecks.push({trialId:trial.id,intent:trial.intent,sessionId,programHash:trial.programHash,fileHash,nativeAuthorTool:(author?.data as any)?.toolName,submissionTool:trial.intent==='shadow_replay'?'submit_trial':'evaluate_trial',passed})
 }
 await save('native-authoring-audit.json',{passed:legacyToolAbsence&&authoringChecks.every(item=>item.passed),legacyToolAbsence,authoringChecks,replayTrialsCovered:authoringChecks.filter(item=>item.intent==='shadow_replay').length,providerCalls:0,newDispatches:0},true)
 const feedbackAudit=Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').map(t=>({trialId:t.id,programHash:t.programHash,decisionPlan:t.decisionPlan,evidenceRefs:t.evidenceRefs,decisionMemoryExposure:(t as any).decisionMemoryExposure}));await save('discovery-feedback-audit.json',{trials:feedbackAudit,interpretation:'Exposure and prospective citations must be independently checked; two successful runs alone do not prove learning.'},true)
 const ordinary=Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)),first=ordinary[0],second=ordinary[1]
 const firstRun=first&&Object.values(state.runs).find(r=>r.trialId===first.id&&r.status==='succeeded'),exposure=second?.decisionMemoryExposure
 const citedFirstRun=!!firstRun&&!!second&&[...second.evidenceRefs??[],...second.decisionPlan?.evidenceRefs??[]].includes(firstRun.id)
 const feedbackChecks={twoVerifiedOrdinaryRuns:receipts.filter(r=>r.intent!=='shadow_replay'&&r.valid).length===2,
   secondDecisionCitesFirstRun:citedFirstRun,
   firstResultExposed:!!firstRun&&!!exposure&&exposure.citedSources.some(s=>s.id===firstRun.id)&&exposure.scope.projectId===projectId&&exposure.scope.experimentId===second!.experimentId,
   declarationBound:!!second&&!!exposure&&exposure.decisionHash==='sha256:'+operationHash({decisionPlan:second.decisionPlan,evidenceRefs:second.evidenceRefs}),
   prospectiveChangeDeclared:!!second?.decisionPlan?.changedVariables?.length&&second.programHash!==first?.programHash}
 await save('feedback-checks.json',{checks:feedbackChecks,mechanismObserved:Object.values(feedbackChecks).every(Boolean),interpretation:'Prospective citations, actual delivered packet and changed program establish an attributable feedback trace; they do not establish scientific improvement.'},true)
 const validationTrace=sessions.journal.filter((e:any)=>e.type==='tool_execution_end'&&e.data?.toolName==='validate_trial')
 await save('admission-repair-coverage.json',{validationCalls:validationTrace.length,validationEvents:validationTrace,repairCoverage:'Inspect exact failure/write/validation chronology before claiming repaired admission; immediate success does not exercise repair.'},true)
 const checks={memoryInformedFollowupVerified:Object.values(feedbackChecks).every(Boolean),nativeAuthoringVerified:authoringChecks.every(item=>item.passed)&&authoringChecks.length>0,legacyAuthoringToolsAbsent:legacyToolAbsence,failedOriginalReceiptsVerified:failedReceipts.length===Object.values(state.runs).filter(run=>['failed','cancelled'].includes(run.status)).length&&failedReceipts.every(receipt=>receipt.workerHash===prepared.workerHash),finiteGrantRespected:Object.keys(state.trials).length<=8&&Object.keys(state.runs).length<=8&&attempts.length<=8&&count<=384&&Object.values(state.trials).filter(t=>t.intent!=='shadow_replay').length<=2&&Object.values(state.trials).filter(t=>t.intent==='shadow_replay').length<=6&&payloadOutputSizing.length===count&&payloadOutputSizing.every(c=>c.every(v=>Number.isSafeInteger(v)&&v>0))&&grant.autofoldOutputTokenCap===null&&grant.outputPolicy==='pi_and_provider_default'&&trialBudgetChecks.every(r=>r.passed),validLockedEvaluation:receipts.length>0&&receipts.every(r=>r.valid),uniqueOriginalLaunches:attempts.length===Object.values(state.runs).length&&new Set(attempts.map(r=>r.runId)).size===attempts.length,successfulScientificRuns:receipts.length>0&&receipts.every(r=>r.scientific),allSuccessfulReceiptsVerified:receipts.length===Object.values(state.runs).filter(r=>r.status==='succeeded').length,originalWorker:receipts.every(r=>r.workerHash===prepared.workerHash),settled,canonicalEstimatesReconciled:typeof jobCost==='number'&&Math.abs(jobCost-sessionCost)<1e-8,canonicalReportedUsageReconciled:(state.jobs[jobId]!.result?.providerAccounting as any)?.status==='reported'&&providerCost!==null&&Math.abs(Number((state.jobs[jobId]!.result?.providerAccounting as any)?.reportedCostUsd)+priorCost-providerCost)<1e-8,providerUsageComplete:responses.length===count&&providerCost!==null,providerUsageBoundExactly:exactBillingIds&&ledgerReportedCost!==null&&providerCost!==null&&Math.abs(ledgerReportedCost-providerCost)<1e-8,requestedModelOnly:responses.length>0&&responses.every(r=>typeof r.provider==='string'&&r.provider.length>0&&r.model===model.modelId&&!r.observationError&&!r.identityConflict&&!r.identityInvalid),bothCostCeilingsRespected:sessionCost<=grant.modelBudgetUsd&&providerCost!==null&&providerCost<=grant.reportedInferenceCeilingUsd,receiptOnlyReopenNoNewEffects:!!recovery&&reopenForbiddenCalls===0&&JSON.stringify(sameOriginalEffects(before))===JSON.stringify(sameOriginalEffects(after))}
 const coverage={ordinaryVerifiedRuns:receipts.filter(r=>r.intent!=='shadow_replay').length,replayVerifiedRuns:receipts.filter(r=>r.intent==='shadow_replay').length,failedRuns:Object.values(state.runs).filter(r=>r.status==='failed').length,failedOperations:operations.filter(o=>o.outcome==='failed').length,sharedReplayFullyValidated:receipts.filter(r=>r.intent==='shadow_replay'&&r.valid).length===6,scientificImprovementEstablished:false,authority:'Engineering validation only; replay requires a naturally supported refinement opportunity'}
 const report={priorSettledCostUsd:priorCost,continuationOf:origin.id,feedbackAudit,coverage,format:'autofold.cohesive-engine-validation.v1',observedAt:new Date().toISOString(),...checks,passed:Object.values(checks).every(Boolean),receipts,failedReceipts,authoringChecks,jobs:Object.values(state.jobs),operations,sdkEstimatedInferenceUsd:sessionCost,providerReportedCostUsd:providerCost,sessionReportedCostUsd:ledgerReportedCost,perRequestBilling,trialBudgetChecks,payloadOutputSizing,autofoldOutputTokenCap:null,outputPolicy:grant.outputPolicy,providerRequests:ledger.map(r=>({sessionId:r.sessionId,requestId:r.requestId,status:r.status,costKind:r.costKind,estimatedCostUsd:r.estimatedCostUsd,canonicalCostUsd:r.reportedCostUsd,providerBilling:r.providerBilling})),costSemantics:'Canonical SDK estimates and separate exact original OpenRouter reported usage; unequal amounts do not fabricate invoice equality',actualProviders:[...new Set(responses.map(r=>r.provider))],originalDispatches:dispatches,providerResponses:responses.length,receiptOnlyReopen:{before,after,recovery,forbiddenInferenceAttempts:reopenForbiddenCalls},controlledFault:false,biologicalValidationEstablished:false,methodImprovementEstablished:false,remoteShutdownVerified:false}
 await save(settled?'settlement-audit.json':'held-state-audit.json',report,true)
 console.log(JSON.stringify({type:'result',passed:report.passed,coverage,checks,receipts,sdkEstimatedInference:sessionCost,providerReportedInference:providerCost,providerResponses:responses.length}))
 stage=report.passed?'settled_pending_physical_shutdown':'held_acceptance_gap';if(!report.passed)process.exitCode=1
}catch(e){error=e;stage='held_exception';process.exitCode=1;if(app)await app.store.read(projectId).then(bindOriginalJob).catch(()=>{});await save('driver-error.json',{observedAt:new Date().toISOString(),message:e instanceof Error?e.message:String(e),stack:e instanceof Error?e.stack:undefined,jobId},true);console.error(JSON.stringify({type:'driver_error',message:String(e),jobId}));if(!await Bun.file(path.join(operator,'held-state-audit.json')).exists()&&!await Bun.file(path.join(operator,'settlement-audit.json')).exists())await save('held-state-audit.json',{format:'autofold.cohesive-engine-held-state.v1',observedAt:new Date().toISOString(),passed:false,error:String(e),jobId,providerRequests:count,providerReportedCostUsd:providerReportedCost(),state:app?await app.store.read(projectId).catch(()=>null):null,canonicalSettlementProven:false,receiptVerificationNotCompleted:true,replacementDispatches:0},true)}
finally{clearTimeout(timeout);if(timer)clearInterval(timer);await Promise.allSettled(observations);await observe();await save('driver-exit.json',{observedAt:new Date().toISOString(),stage,jobId,exitCode:process.exitCode??0,error:error?String(error):undefined},true)}
