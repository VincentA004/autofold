import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Type} from 'typebox'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchJobService} from '@autofold/science-core/job-service'
import {ResearchService} from '@autofold/science-core/service'
import {ScientificExecution,LocalWorkerTransport,ReceiptUnresolvedError,fileHash} from '../execution'
import {DEFAULT_MODEL,createSessionStore,PiRuntime} from '../runtime'
import {PiJobController,type PiJobControllerOptions} from './index'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
/** Component fixtures exercise original host allowance/admission using real Pi journals.
 * Scientific counts here are deliberately inert; public native tests prove effects. */
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-partial-policy-'));roots.push(workspace)
 const projectId='partial_policy',store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
 const execution=new ScientificExecution({workspace,projectId,research,inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_policy_fixture'}})
 const campaign=await research.createCampaign(projectId,{objective:'Offline unchanged-accounting-hold policy'});await research.activateCampaign(projectId,campaign.id)
 const evaluator=(await execution.evaluators())[0]!
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Policy only',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7],submissionSize:1}}});await research.activateExperiment(projectId,experiment.id)
 const options:PiJobControllerOptions={workspace,projectId,store,research,execution,sessionDirectory:path.join(workspace,'pi'),scientistFactory:()=>({initialize:async()=>{},status:async()=>({completedEvaluations:0,stopped:false,researchRequested:false}),context:async()=>({}),tools:()=>[],systemPrompt:'Offline allowance policy'})}
 return {workspace,projectId,store,research,execution,campaign,experiment,options}
}
const response=(tool=false)=>{
 const value:AssistantMessage={role:'assistant',content:tool?[{type:'toolCall',id:'original_inspect',name:'inspect',arguments:{}}]:[{type:'text',text:'Original settled reasoning'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:tool?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}}
 const output=createAssistantMessageEventStream();output.push({type:'start',partial:value});output.push({type:'done',reason:tool?'toolUse':'stop',message:value});output.end(value);return output
}
async function interruptedOriginal(policy:{maxTurns?:number;maxToolCalls?:number;reported?:number|null;tool?:boolean;parent?:boolean;required?:boolean}={}){
 const f=await fixture(),shutdown=new AbortController();let calls=0
 const controller=new PiJobController({...f.options,...(policy.tool?{scientistFactory:()=>({...f.options.scientistFactory!({} as never),tools:()=>[{name:'inspect',label:'Inspect',description:'Offline original tool',parameters:Type.Object({}),execute:async()=>{shutdown.abort();return {content:[{type:'text' as const,text:'Original tool settled'}],details:{}}}}]})}:{}),runtimeOptions:{requireProviderReportedUsage:policy.required,limits:{maxTurns:policy.maxTurns??1,maxToolCalls:policy.maxToolCalls??2,maxCostUsd:.5},streamFn:async(model,_context,options)=>{calls++;await options!.onProviderStreamEvent!({id:'gen_original_policy_'+calls,provider:'offline_policy',choices:[{finish_reason:policy.tool?'tool_calls':'stop'}],usage:policy.reported===null?{}:{cost:policy.reported??.02}},model);return response(policy.tool)}}})
 const jobs=new ResearchJobService.Service(f.store)
 const parent=policy.parent?await controller.enqueueJob({idempotencyKey:'parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_partial_policy_parent',maxSteps:3,maximumDurationMs:60000}}):undefined
 const parentOwner=parent?await jobs.claim(f.projectId,60000,{eligible:job=>job.id===parent.id}):undefined
 controller.registerHandler('campaign_loop',async()=>({status:'fixture_parent'}))
 const job=await controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'original',iterations:2,modelBudgetUsd:1,maximumDurationMs:60000,...(parent?{parentJobId:parent.id,parentLeaseId:parentOwner!.leaseId}:{})})
 const mutate=f.store.mutate.bind(f.store)
 f.store.mutate=async(project,fn)=>{const result=await mutate(project,fn);if((await controller.get(job.id)).checkpoints['pi:turn:1:result'])shutdown.abort();return result}
 try{const first=await controller.runOnce({jobId:job.id,signal:shutdown.signal});if(first?.status!==(policy.required?'recovery_required':'interrupted'))throw new Error(JSON.stringify({status:first?.status,error:first?.error,recovery:first?.recovery}));expect(first.status).toBe(policy.required?'recovery_required':'interrupted')}finally{f.store.mutate=mutate}
 expect(calls).toBe(1)
 return {...f,job,controller,jobs,parent,parentOwner}
}


async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,timeout=3000):Promise<T>{
 const end=Date.now()+timeout;let value=await read()
 while(!accept(value)){if(Date.now()>end)throw new Error('Expected public job transition did not occur: '+JSON.stringify(value));await Bun.sleep(5);value=await read()}
 return value
}
async function heldWorker(options:{parent?:boolean;deadlineMs?:number;required?:boolean;afterFactual?:(f:Awaited<ReturnType<typeof interruptedOriginal>>)=>Promise<void>;prepare?:(f:Awaited<ReturnType<typeof interruptedOriginal>>)=>Promise<ScientificExecution>}={}){
 const f=await interruptedOriginal({maxTurns:4,reported:null,parent:options.parent,required:options.required});let modelCalls=0
 if(options.deadlineMs)await f.store.mutate(f.projectId,state=>{state.jobs[f.job.id]!.checkpoints['host:lifecycle:start']!.data.deadlineMs=options.deadlineMs!})
 if(f.parent)await f.jobs.interrupt(f.projectId,f.parent.id,f.parentOwner!.leaseId!,{reason:'shutdown',detail:'Original campaign suspended'})
 const execution=options.prepare?await options.prepare(f):f.execution
 const controller=new PiJobController({...f.options,execution,runtimeOptions:{limits:{maxTurns:4,maxToolCalls:2,maxCostUsd:.5},streamFn:async(model,_context,options)=>{modelCalls++;await options!.onProviderStreamEvent!({id:'gen_after_receipt_'+modelCalls,provider:'offline_policy',choices:[{finish_reason:'stop'}],usage:{cost:.02}},model);return response()}}})
 controller.registerHandler('campaign_loop',async()=>({status:'receipt_fixture_parent'}))
 if(options.afterFactual){const reconcile=controller.reconcileDetailed.bind(controller);let observed=false;controller.reconcileDetailed=async(...args)=>{const result=await reconcile(...args);if(!observed){observed=true;await options.afterFactual!(f)}return result}}
 const stop=new AbortController(),work=controller.runWorker({signal:stop.signal,pollMs:5})
 try{await until(()=>controller.get(f.job.id),job=>job.status==='recovery_required'&&job.recoveryCount>=1)}catch(error){stop.abort();await work;throw error}
 return {...f,controller,stop,work,modelCalls:()=>modelCalls,rootId:f.parent?.id??f.job.id}
}
const shape=(job:{recoveryCount:number;checkpoints:Record<string,unknown>})=>({recoveryCount:job.recoveryCount,phases:Object.keys(job.checkpoints).sort()})

test('unchanged original accounting holds stay responsive without reacquiring parent or child ownership',async()=>{
 const f=await heldWorker({parent:true})
 try{
  await until(()=>f.controller.get(f.rootId),job=>job.status==='recovery_required'&&job.recoveryCount>=1)
  const root=shape(await f.controller.get(f.rootId)),child=shape(await f.controller.get(f.job.id))
  await Bun.sleep(100)
  expect(shape(await f.controller.get(f.rootId))).toEqual(root);expect(shape(await f.controller.get(f.job.id))).toEqual(child)
  expect(f.modelCalls()).toBe(0);expect(f.controller.workerState.status).toBe('running')
 }finally{f.stop.abort();await f.work}
})

async function verifyOriginalReceipt(f:Pick<Awaited<ReturnType<typeof interruptedOriginal>>,'options'|'job'>){
  const sessions=createSessionStore(path.join(f.options.sessionDirectory,'sessions.sqlite'))
  try{
   const session=(await sessions.get(f.job.payload.sessionId))!,[requestId,request]=Object.entries(session.modelRequests!)[0]!
   const runtime=new PiRuntime({store:sessions,getApiKey:()=> 'offline_original_receipt_key',openRouterGenerationFetch:(async()=>new Response(JSON.stringify({data:{id:request.providerBilling!.upstreamRequestId,model:request.modelBinding?.canonicalModelId??DEFAULT_MODEL.id,provider_name:'offline_policy',total_cost:.02,finish_reason:'stop'}}),{status:200})) as unknown as typeof fetch})
   await runtime.reconcileOpenRouterModelUsage(session.id,requestId)
  }finally{sessions.close()}
}

test('a verified saved original provider receipt wakes an unchanged held job automatically',async()=>{
 const f=await heldWorker({required:true})
 try{
  await Bun.sleep(30);expect(f.modelCalls()).toBe(0)
  await verifyOriginalReceipt(f)
  const finished=await until(()=>f.controller.get(f.job.id),job=>job.status==='succeeded')
  expect(finished.result).toMatchObject({reason:'runtime_limit_reached',completedEvaluations:0,providerAccounting:{status:'reported'}})
  expect(f.modelCalls()).toBe(3);expect((await f.controller.list()).length).toBe(1)
 }finally{f.stop.abort();await f.work}
})

for(const change of ['deadline','cancel','inactive'] as const)test(`${change} invalidates an unchanged accounting hold without a new request`,async()=>{
 const f=await heldWorker(change==='deadline'?{deadlineMs:Date.now()+1000}:change==='cancel'?{required:true}:{})
 try{
  await Bun.sleep(30)
  if(change==='cancel'){await f.controller.cancel(f.job.id);await verifyOriginalReceipt(f);await until(()=>f.controller.operations.read(f.projectId,'op_job_'+f.job.id.slice(4)),record=>record?.settlement==='settled'&&record.accounting==='settled')}
  if(change==='inactive')await f.store.mutate(f.projectId,state=>{state.experiments[f.experiment.id]!.status='completed'})
  const final=await until(()=>f.controller.get(f.job.id),job=>change==='cancel'?job.status==='cancelled':job.status==='succeeded')
  if(change!=='cancel')expect(final.result).toMatchObject({reason:change==='deadline'?'job_deadline_reached':'experiment_not_active',providerAccounting:{status:'unknown',reportedCostUsd:null}})
  expect(f.modelCalls()).toBe(0)
  if(change==='cancel'){const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)}
 }finally{f.stop.abort();await f.work}
})

test('an unchanged held root does not starve a later independent recovery queue',async()=>{
 const f=await heldWorker()
 try{
  const otherCampaign=await f.research.createCampaign(f.projectId,{objective:'Independent original receipt queue'});await f.research.activateCampaign(f.projectId,otherCampaign.id)
  const other=await f.controller.enqueueJob({idempotencyKey:'independent_recovery',payload:{kind:'knowledge_review',campaignId:otherCampaign.id,sessionId:'ses_independent_held',claimIds:[],question:'Independent queue',maxRequests:1,modelBudgetUsd:1}})
  const owner=await f.jobs.claim(f.projectId,30000,{eligible:job=>job.id===other.id})
  await f.jobs.checkpoint(f.projectId,other.id,owner!.leaseId!,'pi:job:result',{proof:'independent_recovery'})
  await f.jobs.interrupt(f.projectId,other.id,owner!.leaseId!,{reason:'execution_unresolved',detail:'Independent saved result'})
  f.controller.registerHandler('knowledge_review',async()=>({proof:'independent_recovery'}))
  expect(await until(()=>f.controller.get(other.id),job=>job.status==='succeeded')).toMatchObject({result:{proof:'independent_recovery'}})
  const stable=shape(await f.controller.get(f.job.id));await Bun.sleep(40)
  expect(shape(await f.controller.get(f.job.id))).toEqual(stable);expect(f.modelCalls()).toBe(0)
 }finally{f.stop.abort();await f.work}
})


test('an active physical worker receipt is still observed before an accounting hold can quiesce',async()=>{
 let dispatches=0,runId=''
 const f=await heldWorker({prepare:async original=>{
  const owner=await original.jobs.claim(original.projectId,30000,{eligible:job=>job.id===original.job.id})
  const authority={jobId:original.job.id,leaseId:owner!.leaseId!}
  const program=path.join(original.workspace,'physical_receipt.py');await fs.writeFile(program,"raise RuntimeError('Mock evaluator never executes authored Python')\n")
  const trial=await original.research.createTrial(original.projectId,original.experiment.id,{hypothesis:'Physical receipt recovery policy only',designAdapter:'mock',programPath:'physical_receipt.py',programHash:await fileHash(program),origin:{jobId:original.job.id,phase:'physical_original'}},authority)
  const local=new LocalWorkerTransport(),availableAfter=Date.now()+300
  const execution=new ScientificExecution({workspace:original.workspace,projectId:original.projectId,research:original.research,transport:{kind:'local',dispatch:async input=>{dispatches++;runId=input.runId;return local.dispatch({...input,onStarted:async()=>{await input.onStarted?.();throw new Error('Fixture controller lost launch projection')}})},reconcile:input=>Date.now()<availableAfter?Promise.resolve({status:'pending' as const}):local.reconcile(input)}})
  await expect(execution.evaluateTrial({trialId:trial.id,requestId:'physical_original',caller:authority})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await original.jobs.interrupt(original.projectId,original.job.id,owner!.leaseId!,{reason:'shutdown',detail:'Original physical worker remains owned'})
  return execution
 }})
 try{
  const state=await until(()=>f.store.read(f.projectId),state=>state.runs[runId]?.status==='succeeded',5000)
  expect(state.runs[runId]!.manifestHash).toBeTruthy();expect(Object.values(state.evaluations)).toHaveLength(1)
  expect(dispatches).toBe(1);expect(f.modelCalls()).toBe(0)
 }finally{f.stop.abort();await f.work}
},10000)


test('strict reported-billing failure with terminal delivery remains unchanged after one factual recovery',async()=>{
 const f=await heldWorker({required:true})
 try{
  const sessions=createSessionStore(path.join(f.options.sessionDirectory,'sessions.sqlite'))
  try{const session=(await sessions.get(f.job.payload.sessionId))!,request=Object.values(session.modelRequests!)[0]!;expect(request.status).toBe('unknown');expect(request.delivery?.status).toBe('completed');expect(request.estimatedCostUsd).toBe(.01)}finally{sessions.close()}
  const stable=shape(await f.controller.get(f.job.id));await Bun.sleep(100)
  expect(shape(await f.controller.get(f.job.id))).toEqual(stable);expect(f.modelCalls()).toBe(0)
 }finally{f.stop.abort();await f.work}
})


test('strict unknown billing observes a passed original deadline once then remains a truthful stable hold',async()=>{
 const f=await heldWorker({required:true,deadlineMs:Date.now()+700})
 try{
  const before=(await f.controller.get(f.job.id)).recoveryCount
  await until(()=>f.controller.get(f.job.id),job=>job.recoveryCount>before,1500)
  await Bun.sleep(30)
  const observed=shape(await f.controller.get(f.job.id));await Bun.sleep(100)
  expect(shape(await f.controller.get(f.job.id))).toEqual(observed);expect((await f.controller.get(f.job.id)).status).toBe('recovery_required');expect(f.modelCalls()).toBe(0)
 }finally{f.stop.abort();await f.work}
})


test('scope changes during the factual recovery handoff remain observable without another model request',async()=>{
 const f=await heldWorker({afterFactual:async original=>{await original.store.mutate(original.projectId,state=>{state.experiments[original.experiment.id]!.status='completed'})}})
 try{
  const final=await until(()=>f.controller.get(f.job.id),job=>job.status==='succeeded')
  expect(final.result).toMatchObject({reason:'experiment_not_active',providerAccounting:{status:'unknown',reportedCostUsd:null}})
  expect(f.modelCalls()).toBe(0);const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
 }finally{f.stop.abort();await f.work}
})

test('an original deadline crossing during the factual recovery handoff remains observable without another model request',async()=>{
 const deadline=Date.now()+700
 const f=await heldWorker({deadlineMs:deadline,afterFactual:async()=>{while(Date.now()<=deadline)await Bun.sleep(5)}})
 try{
  const final=await until(()=>f.controller.get(f.job.id),job=>job.status==='succeeded')
  expect(final.result).toMatchObject({reason:'job_deadline_reached',providerAccounting:{status:'unknown',reportedCostUsd:null}})
  expect(f.modelCalls()).toBe(0);const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
 }finally{f.stop.abort();await f.work}
})

test('a verified original receipt arriving during the factual recovery handoff resumes only the original remaining allowance',async()=>{
 const f=await heldWorker({required:true,afterFactual:async original=>{await verifyOriginalReceipt(original)}})
 try{
  const final=await until(()=>f.controller.get(f.job.id),job=>job.status==='succeeded')
  expect(final.result).toMatchObject({reason:'runtime_limit_reached',completedEvaluations:0,providerAccounting:{status:'reported'}})
  expect(f.modelCalls()).toBe(3);expect((await f.controller.list()).length).toBe(1)
 }finally{f.stop.abort();await f.work}
})
