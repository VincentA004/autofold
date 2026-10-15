import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Type} from 'typebox'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchJobService} from '@autofold/science-core/job-service'
import {ResearchService} from '@autofold/science-core/service'
import {ScientificExecution} from '../execution'
import {DEFAULT_MODEL} from '../runtime'
import {PiJobController,type PiJobControllerOptions} from './index'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
/** Component fixtures exercise original host allowance/admission using real Pi journals.
 * Scientific counts here are deliberately inert; public native tests prove effects. */
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-partial-policy-'));roots.push(workspace)
 const projectId='partial_policy',store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
 const execution=new ScientificExecution({workspace,projectId,research,inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_policy_fixture'}})
 const campaign=await research.createCampaign(projectId,{objective:'Offline partial allowance policy'});await research.activateCampaign(projectId,campaign.id)
 const evaluator=(await execution.evaluators())[0]!
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Policy only',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7],submissionSize:1}}});await research.activateExperiment(projectId,experiment.id)
 const options:PiJobControllerOptions={workspace,projectId,store,research,execution,sessionDirectory:path.join(workspace,'pi'),scientistFactory:()=>({initialize:async()=>{},status:async()=>({completedEvaluations:0,stopped:false,researchRequested:false}),context:async()=>({}),tools:()=>[],systemPrompt:'Offline allowance policy'})}
 return {workspace,projectId,store,research,execution,campaign,experiment,options}
}
const response=(tool=false)=>{
 const value:AssistantMessage={role:'assistant',content:tool?[{type:'toolCall',id:'original_inspect',name:'inspect',arguments:{}}]:[{type:'text',text:'Original settled reasoning'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:tool?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}}
 const output=createAssistantMessageEventStream();output.push({type:'start',partial:value});output.push({type:'done',reason:tool?'toolUse':'stop',message:value});output.end(value);return output
}
async function interruptedOriginal(policy:{maxTurns?:number;maxToolCalls?:number;reported?:number|null;tool?:boolean;parent?:boolean}={}){
 const f=await fixture(),shutdown=new AbortController();let calls=0
 const controller=new PiJobController({...f.options,...(policy.tool?{scientistFactory:()=>({...f.options.scientistFactory!({} as never),tools:()=>[{name:'inspect',label:'Inspect',description:'Offline original tool',parameters:Type.Object({}),execute:async()=>{shutdown.abort();return {content:[{type:'text' as const,text:'Original tool settled'}],details:{}}}}]})}:{}),runtimeOptions:{limits:{maxTurns:policy.maxTurns??1,maxToolCalls:policy.maxToolCalls??2,maxCostUsd:.5},streamFn:async(model,_context,options)=>{calls++;if(policy.reported!==null)await options!.onProviderStreamEvent!({id:'gen_original_policy_'+calls,provider:'offline_policy',choices:[{finish_reason:policy.tool?'tool_calls':'stop'}],usage:{cost:policy.reported??.02}},model);return response(policy.tool)}}})
 const jobs=new ResearchJobService.Service(f.store)
 const parent=policy.parent?await controller.enqueueJob({idempotencyKey:'parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_partial_policy_parent',maxSteps:3,maximumDurationMs:60000}}):undefined
 const parentOwner=parent?await jobs.claim(f.projectId,60000,{eligible:job=>job.id===parent.id}):undefined
 controller.registerHandler('campaign_loop',async()=>({status:'fixture_parent'}))
 const job=await controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'original',iterations:2,modelBudgetUsd:1,maximumDurationMs:60000,...(parent?{parentJobId:parent.id,parentLeaseId:parentOwner!.leaseId}:{})})
 const mutate=f.store.mutate.bind(f.store)
 f.store.mutate=async(project,fn)=>{const result=await mutate(project,fn);if((await controller.get(job.id)).checkpoints['pi:turn:1:result'])shutdown.abort();return result}
 try{const first=await controller.runOnce({jobId:job.id,signal:shutdown.signal});if(first?.status!=='interrupted')throw new Error(JSON.stringify({status:first?.status,error:first?.error,recovery:first?.recovery}));expect(first.status).toBe('interrupted')}finally{f.store.mutate=mutate}
 expect(calls).toBe(1)
 return {...f,job,controller,jobs,parent,parentOwner}
}

test('an interrupted original job freezes its first-admission cost, turn and tool ceilings',async()=>{
 const f=await interruptedOriginal(),baseline=(await f.controller.get(f.job.id)).checkpoints['pi:job:start']!.data
 expect(baseline.allowance).toEqual({maxCostUsd:.5,maxTurns:1,maxToolCalls:2})
})

test('larger restart host limits cannot replenish an exhausted original turn allowance',async()=>{
 const f=await interruptedOriginal();let calls=0
 const baseline=structuredClone((await f.controller.get(f.job.id)).checkpoints['pi:job:start']!.data)
 const restored=new PiJobController({...f.options,runtimeOptions:{limits:{maxTurns:100,maxToolCalls:100,maxCostUsd:10},streamFn:()=>{calls++;throw new Error('Original turn cap is already spent')}}})
 await restored.reconcile(f.job.id);await restored.runOnce({jobId:f.job.id})
 expect(calls).toBe(0)
 expect(await restored.get(f.job.id)).toMatchObject({status:'succeeded',result:{reason:'runtime_limit_reached',completedEvaluations:0}})
 expect((await restored.get(f.job.id)).checkpoints['pi:job:start']!.data).toEqual(baseline)
})

test('an unfinished historical job without frozen ceilings holds without inferring or retrofitting a grant',async()=>{
 const f=await interruptedOriginal();let calls=0
 await f.store.mutate(f.projectId,state=>{delete state.jobs[f.job.id]!.checkpoints['pi:job:start']!.data.allowance})
 const baseline=structuredClone((await f.controller.get(f.job.id)).checkpoints['pi:job:start']!.data)
 const restored=new PiJobController({...f.options,runtimeOptions:{limits:{maxTurns:100},streamFn:()=>{calls++;throw new Error('Missing authority must hold')}}})
 await restored.reconcile(f.job.id);await restored.runOnce({jobId:f.job.id})
 expect(calls).toBe(0);expect((await restored.get(f.job.id)).status).toBe('recovery_required')
 expect((await restored.get(f.job.id)).checkpoints['pi:job:start']!.data).toEqual(baseline)
})

for(const scope of ['campaign','experiment'] as const)test(`${scope} revocation at original model admission forbids the request`,async()=>{
 const f=await fixture();let calls=0
 const controller=new PiJobController({...f.options,runtimeOptions:{limits:{maxTurns:1},authorizeModelRequest:async()=>{await f.store.mutate(f.projectId,state=>{if(scope==='campaign')state.campaigns[f.campaign.id]!.status='completed';else state.experiments[f.experiment.id]!.status='completed'})},streamFn:()=>{calls++;throw new Error('Revoked scope must not infer')}}})
 const job=await controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:scope,iterations:2})
 await controller.runOnce({jobId:job.id})
 expect(calls).toBe(0);expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})


test('receipt-only partial recovery preserves the same grant and invokes no model before ordinary continuation',async()=>{
 const f=await interruptedOriginal({maxTurns:4});let calls=0
 const original=await f.controller.get(f.job.id),baseline=structuredClone(original.checkpoints['pi:job:start']!.data)
 const restored=new PiJobController({...f.options,runtimeOptions:{limits:{maxTurns:100},streamFn:async(model,_context,options)=>{calls++;await options!.onProviderStreamEvent!({id:'gen_resumed_'+calls,provider:'offline_policy',choices:[{finish_reason:'stop'}],usage:{cost:.02}},model);return response()}}})
 const recovered=await restored.reconcile(f.job.id)
 expect(calls).toBe(0);expect(recovered.status).toBe('interrupted');expect(recovered.checkpoints['pi:recovery:resumable']).toBeDefined()
 const finished=await restored.runOnce({jobId:f.job.id})
 expect(calls).toBe(3);expect(finished).toMatchObject({id:f.job.id,status:'succeeded',result:{reason:'runtime_limit_reached',completedEvaluations:0}})
 expect(finished!.payload).toEqual(original.payload);expect(finished!.checkpoints['pi:job:start']!.data).toEqual(baseline)
 expect(await restored.list()).toHaveLength(1)
})

for(const limit of ['reported_cost','deadline','tools','unknown_billing','inactive_campaign','inactive_experiment','cancelled'] as const)test(`partial recovery holds or settles ${limit} without another model request`,async()=>{
 const f=await interruptedOriginal({maxTurns:4,...(limit==='reported_cost'?{reported:.5}:limit==='unknown_billing'?{reported:null}:limit==='tools'?{tool:true,maxToolCalls:1}:{})});let calls=0
 await f.store.mutate(f.projectId,state=>{
  const job=state.jobs[f.job.id]!
  if(limit==='deadline')job.checkpoints['host:lifecycle:start']!.data.deadlineMs=Date.now()-1
  if(limit==='inactive_campaign')state.campaigns[f.campaign.id]!.status='completed'
  if(limit==='inactive_experiment')state.experiments[f.experiment.id]!.status='completed'
 })
 const restored=new PiJobController({...f.options,runtimeOptions:{limits:{maxTurns:100},streamFn:()=>{calls++;throw new Error('Exhausted or revoked original authority cannot infer')}}})
 if(limit==='cancelled')await restored.cancel(f.job.id)
 await restored.reconcile(f.job.id);await restored.runOnce({jobId:f.job.id})
 expect(calls).toBe(0);expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
 const current=await restored.get(f.job.id)
 if(limit==='unknown_billing')expect(current).toMatchObject({status:'recovery_required',recovery:{reason:'accounting_unresolved'}})
 else if(limit==='cancelled')expect(current.status).toBe('cancelled')
 else expect(current).toMatchObject({status:'succeeded',result:{reason:limit==='deadline'?'job_deadline_reached':limit==='reported_cost'?'model_budget_exhausted':limit==='tools'?'runtime_limit_reached':'experiment_not_active',completedEvaluations:0}})
})


test('a settled partial child cannot release its parent ahead of a later unresolved sibling',async()=>{
 const f=await interruptedOriginal({maxTurns:4,parent:true})
 const sibling=await f.controller.enqueueJob({idempotencyKey:'unresolved_sibling',parentLeaseId:f.parentOwner!.leaseId,payload:{kind:'knowledge_review',campaignId:f.campaign.id,sessionId:'ses_unknown_sibling',parentJobId:f.parent!.id,modelBudgetUsd:1,claimIds:[],question:'Unknown original bill',maxRequests:1}})
 const owner=await f.jobs.claim(f.projectId,60000,{eligible:job=>job.id===sibling.id})
 await f.jobs.interrupt(f.projectId,sibling.id,owner!.leaseId!,{reason:'accounting_unresolved',detail:'Original sibling provider invoice unknown'})
 await f.jobs.interrupt(f.projectId,f.parent!.id,f.parentOwner!.leaseId!,{reason:'shutdown',detail:'Original parent suspended'})
 const restored=new PiJobController({...f.options,runtimeOptions:{streamFn:()=>{throw new Error('Unresolved sibling must hold all continuation')}}})
 restored.registerHandler('campaign_loop',async()=>({status:'fixture_parent'}))
 expect(await restored.reconcile(f.parent!.id)).toMatchObject({status:'recovery_required',recovery:{reason:'child_unresolved'}})
 expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})

test('the original parent and unfinished child resume through their ordinary leases without a new grant',async()=>{
 const f=await interruptedOriginal({maxTurns:4,parent:true});let calls=0
 await f.jobs.interrupt(f.projectId,f.parent!.id,f.parentOwner!.leaseId!,{reason:'shutdown',detail:'Original parent suspended'})
 const originalChild=await f.controller.get(f.job.id),originalParent=await f.controller.get(f.parent!.id)
 const restored=new PiJobController({...f.options,runtimeOptions:{limits:{maxTurns:100},streamFn:async(model,_context,options)=>{calls++;await options!.onProviderStreamEvent!({id:'gen_parent_resumed_'+calls,provider:'offline_policy',choices:[{finish_reason:'stop'}],usage:{cost:.02}},model);return response()}}})
 restored.registerHandler('campaign_loop',async()=>{const result=await restored.runOnce({jobId:f.job.id});return {childJobId:result!.id,childStatus:result!.status}})
 expect(await restored.reconcile(f.parent!.id)).toMatchObject({status:'interrupted',recovery:{reason:'shutdown'}})
 expect(calls).toBe(0)
 expect(await restored.runOnce({jobId:f.parent!.id})).toMatchObject({id:f.parent!.id,status:'succeeded',result:{childJobId:f.job.id,childStatus:'succeeded'}})
 expect(calls).toBe(3);expect(await restored.list()).toHaveLength(2)
 const child=await restored.get(f.job.id),parent=await restored.get(f.parent!.id)
 expect(child.payload).toEqual(originalChild.payload);expect(child.checkpoints['pi:job:start']).toEqual(originalChild.checkpoints['pi:job:start'])
 expect(parent.payload).toEqual(originalParent.payload)
})

test('closing an expired historical partial grant retains unknown billing without inventing ceilings or charges',async()=>{
 const f=await interruptedOriginal({maxTurns:4,reported:null});let calls=0
 await f.store.mutate(f.projectId,state=>{const job=state.jobs[f.job.id]!;delete job.checkpoints['pi:job:start']!.data.allowance;job.checkpoints['host:lifecycle:start']!.data.deadlineMs=Date.now()-1})
 const original=(await f.controller.get(f.job.id)).checkpoints['pi:job:start']
 const restored=new PiJobController({...f.options,runtimeOptions:{streamFn:()=>{calls++;throw new Error('Expired original grant cannot infer')}}})
 const recovered=await restored.reconcile(f.job.id)
 expect(recovered).toMatchObject({status:'succeeded',result:{reason:'job_deadline_reached',completedEvaluations:0,providerAccounting:{status:'unknown',reportedCostUsd:null}}})
 expect(calls).toBe(0);expect(recovered.checkpoints['pi:job:start']).toEqual(original)
 expect((await restored.get(f.job.id)).result!.providerAccounting).toMatchObject({status:'unknown',reportedCostUsd:null})
})
