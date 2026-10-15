import {afterEach,expect,spyOn,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {MemoryResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchArtifacts} from '@autofold/science-core/artifacts'
import {ProtoModelRegistry} from '@autofold/science-core/research/model-registry'
import {operationHash} from '@autofold/science-core/operations'
import {ScientificExecution} from '../execution'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from '../runtime'
import {ScientistLane} from './index'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const answer=(text='Original receipt observed.',error=false)=>{
 const message:AssistantMessage={role:'assistant',content:[{type:'text',text}],stopReason:error?'error':'stop',...(error?{errorMessage:text}:{}),api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:5,usage:{input:2,output:1,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:.001,output:0,cacheRead:0,cacheWrite:0,total:.001}}}
 const events=createAssistantMessageEventStream();events.push(error?{type:'error',reason:'error',error:message}:{type:'done',reason:'stop',message});events.end(message);return events
}
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'scientist-delivery-rehydration-'));roots.push(workspace)
 const projectId='delivery_rehydration',store=new MemoryResearchStore(),research=new ResearchService.Service(store)
 const execution=new ScientificExecution({workspace,projectId,research,authorization:{localProto:false,maximumGpuSeconds:0,maximumCandidates:1,maximumWallTimeMinutes:1}})
 const target=await ResearchArtifacts.authorTarget(workspace,{format:'autofold.target-artifact.v1',name:'Immutable delivery target',chains:[{id:'A',sequence:'AC'}],bindingSite:{residues:[{chainId:'A',position:1}]}})
 const evaluator=(await execution.evaluators())[0]!,campaign=await research.createCampaign(projectId,{objective:'Exact full memory attribution'});await research.activateCampaign(projectId,campaign.id)
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Preserve exact delivery across scientist jobs',targetArtifactHash:target.targetArtifactHash,modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7],submissionSize:1}}});await research.activateExperiment(projectId,experiment.id)
 for(let i=0;i<2;i++){
  const trial=await research.createTrial(projectId,experiment.id,{hypothesis:'Original baseline '+i,designAdapter:'mock',programPath:'baseline-'+i+'.py',programHash:'sha256:'+'c'.repeat(64),generators:['fixture']})
  const run=await research.beginRun(projectId,trial.id,{bundlePath:'bundle.json',outputPath:'output'});await research.attachRunJob(projectId,run.id,'offline-fixture')
  await research.completeRun(projectId,run.id,{contractHash:experiment.contractHash,evaluatorHash:experiment.contract.evaluator.sourceHash,valid:true,score:.3+i*.1,diagnostics:{}},'sha256:'+'d'.repeat(64))
 }
 spyOn(execution,'artifacts').mockImplementation(async(id:string)=>{const state=await store.read(projectId),run=state.runs[id]!,trial=state.trials[run.trialId]!;return {run,trial,modelEvidence:[],candidates:{candidates:[]},scientific:false,evidenceKind:'plumbing_only'} as any})
 spyOn(execution,'capabilities').mockResolvedValue({} as any);spyOn(execution,'modelRegistry').mockResolvedValue(ProtoModelRegistry.snapshot([],null))
 const sessions=new MemorySessionStore(),created=await new PiRuntime({store:sessions}).create()
 const options={workspace,projectId,store,research,execution,experimentId:experiment.id,sessionId:created.id,maximumEvaluations:2,allowCompute:false}
 const lane=new ScientistLane(options);await lane.initialize()
 const tool=lane.tools().find(tool=>tool.name==='read_decision_memory')!
 const result=await tool.execute('original_memory',{},undefined,undefined)
 const packet=JSON.parse((result.content[0] as {text:string}).text).decisionMemory
 expect(packet.facts).toHaveLength(2)
 // Publish a complete original protocol pair, then let the real runtime deliver
 // it in an ordinary settled inference. No tool is replayed by the new job.
 const session=await sessions.get(created.id);if(!session)throw Error('Missing native session')
 delete session.sdk
 session.messages=[{role:'user',content:'Use the two original verified baseline receipts.',timestamp:1},{role:'assistant',content:[{type:'toolCall',id:'original_memory',name:'read_decision_memory',arguments:{}}],stopReason:'toolUse',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:2,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},{role:'toolResult',toolCallId:'original_memory',toolName:'read_decision_memory',content:result.content,details:result.details,isError:false,timestamp:3}]
 await sessions.save(session)
 return {workspace,store,projectId,experiment,options,lane,tool,result,packet,sessions,session}
}
async function deliver(f:Awaited<ReturnType<typeof fixture>>,lane:ScientistLane,error=false){
 const read=lane.tools().find(tool=>tool.name==='read_decision_memory')!,runtime=new PiRuntime({store:f.sessions,tools:[read],streamFn:(_model,context)=>{
  expect(context.messages.some(message=>message.role==='toolResult'&&JSON.stringify(message.content).includes(f.packet.sourceManifest.manifestHash))).toBe(true)
  return answer(error?'Original provider failed after visible input.':'Both original receipts are visible.',error)
 }})
 return runtime.run(f.session.id,'Continue the existing objective without replaying memory tools.')
}
test('a fresh scientist job rehydrates only the exact original full packet after actual settled ordinary inference',async()=>{
 const f=await fixture(),before=JSON.stringify(await f.store.read(f.projectId)),lane=new ScientistLane(f.options),reader=(lane as any).contextReader
 expect(reader.exposure({})).toBeUndefined()
 const result=await deliver(f,lane);expect(result.status).toBe('completed')
 const exposure=reader.exposure({evidenceRefs:[f.packet.facts[0].runId]})
 expect(exposure).toMatchObject({sessionId:f.session.id,packetHash:'sha256:'+operationHash(f.packet),manifestHash:f.packet.sourceManifest.manifestHash,scope:f.packet.sourceManifest.scope})
 expect(exposure.citedSources.map((source:any)=>source.id)).toContain(f.packet.facts[0].runId)
 expect(result.session.messages.slice(0,f.session.messages.length)).toEqual(f.session.messages)
 expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
 expect(result.session.usage.turns).toBe(1)
})
test('new-lane delivery refuses altered packets, manifests, wrong scopes, hidden details, cards and publication-only callbacks',async()=>{
 const f=await fixture(),full={phase:'inference' as const,projection:'full' as const,isError:false,content:f.result.content,details:f.result.details}
 const manifestFile=path.join(f.workspace,f.lane.root,f.packet.sourceManifest.manifestPath),manifestBytes=await fs.readFile(manifestFile)
 const bindingFile=path.join(f.workspace,f.lane.root,'evidence/memory-delivery',operationHash(f.packet)+'.json'),bindingBytes=await fs.readFile(bindingFile)
 for(const variant of ['packet','manifest','scope','project','campaign','binding','missingBinding','hidden','card','published','error'] as const){
  const lane=new ScientistLane(f.options),tool=lane.tools().find(tool=>tool.name==='read_decision_memory')!,reader=(lane as any).contextReader,delivery=structuredClone(full)
  if(['packet','scope','project','campaign'].includes(variant)){
   const value=JSON.parse((delivery.content[0] as {text:string}).text)
   if(variant==='packet')value.decisionMemory.facts[0].score=999
   else if(variant==='scope')value.decisionMemory.sourceManifest.scope.experimentId='exp_foreign'
   else if(variant==='project')value.decisionMemory.sourceManifest.scope.projectId='foreign_project'
   else value.decisionMemory.sourceManifest.scope.campaignId='cmp_foreign'
   delivery.content=[{type:'text',text:JSON.stringify(value)}]
  }
  if(variant==='manifest'){
   const file=path.join(f.workspace,f.lane.root,f.packet.sourceManifest.manifestPath);await fs.chmod(file,0o600);await fs.writeFile(file,'{}')
  }
  if(variant==='binding'){await fs.chmod(bindingFile,0o600);await fs.writeFile(bindingFile,'{}')}
  if(variant==='missingBinding')await fs.unlink(bindingFile)
  if(variant==='hidden')delivery.content=[{type:'text',text:'The actual packet exists only in hidden backend details.'}]
  if(variant==='card'){delivery.projection='artifact_reference' as any;delivery.content=[{type:'text',text:'artifact_reference_only'}]}
  if(variant==='published')delivery.phase='published' as any
  if(variant==='error')delivery.isError=true
  await tool.onDelivery!(delivery);expect(reader.exposure({})).toBeUndefined()
  if(variant==='manifest')await fs.writeFile(manifestFile,manifestBytes)
  if(variant==='binding'||variant==='missingBinding')await fs.writeFile(bindingFile,bindingBytes,{mode:0o400})
 }
})
test('a failed ordinary provider call never rehydrates exposure from its input',async()=>{
 const f=await fixture(),lane=new ScientistLane(f.options),result=await deliver(f,lane,true)
 expect(result.status).toBe('failed');expect((lane as any).contextReader.exposure({})).toBeUndefined()
})


test('latest direct and nested memory gaps or failed receipts prevent older full snapshots resurrecting exposure',async()=>{
 for(const kind of ['direct','nested','failed'] as const){
  const f=await fixture(),lane=new ScientistLane(f.options),reader=(lane as any).contextReader,tool=lane.tools().find(tool=>tool.name==='read_decision_memory')!
  const session=structuredClone(f.session),oldCall=session.messages[1]!
  if(oldCall.role!=='assistant')throw Error('Original assistant call absent')
  session.messages.push({...oldCall,content:[{type:'toolCall',id:'latest_gap',name:'read_decision_memory',arguments:{}}],timestamp:6},
   {role:'toolResult',toolCallId:'latest_gap',toolName:'read_decision_memory',isError:kind==='failed',timestamp:7,content:[{type:'text',text:JSON.stringify(kind==='nested'?{decisionMemoryRefresh:{status:'unavailable',reason:'Current source unavailable',readTool:'read_decision_memory'}}:{status:'unavailable',reason:'Current source unavailable',readTool:'read_decision_memory'})}]})
  await f.sessions.save(session)
  const runtime=new PiRuntime({store:f.sessions,tools:[tool],streamFn:()=>answer('Respect the latest explicit memory gap.')})
  const result=await runtime.run(session.id,'Continue while preserving the current memory gap.');expect(result.status).toBe('completed')
  expect(reader.exposure({})).toBeUndefined()
  await tool.onDelivery!({phase:'inference',projection:'full',isError:false,content:f.result.content,details:f.result.details})
  expect(reader.exposure({})).toBeUndefined()
  // An explicit fresh read can recover; a historical packet alone cannot.
  const fresh=await tool.execute('fresh_recovery',{},undefined,undefined)
  await tool.onDelivery!({phase:'inference',projection:'full',isError:false,content:fresh.content,details:undefined})
  expect(reader.exposure({})).toBeDefined()
 }
})
test('an intervening memory invalidation fences in-flight immutable rehydration',async()=>{
 const f=await fixture(),lane=new ScientistLane(f.options),reader=(lane as any).contextReader,tool=lane.tools().find(tool=>tool.name==='read_decision_memory')!
 const acknowledgment=tool.onDelivery!({phase:'inference',projection:'full',isError:false,content:f.result.content,details:undefined})
 reader.clearMemoryAcknowledgement();await acknowledgment
 expect(reader.exposure({})).toBeUndefined()
})


test('a changed latest full packet clears prior rehydrated exposure until an explicit fresh memory read',async()=>{
 const f=await fixture(),lane=new ScientistLane(f.options),reader=(lane as any).contextReader,tool=lane.tools().find(tool=>tool.name==='read_decision_memory')!
 const original={phase:'inference' as const,projection:'full' as const,isError:false,content:f.result.content,details:undefined}
 await tool.onDelivery!(original);expect(reader.exposure({})).toBeDefined()
 const changed=JSON.parse((f.result.content[0] as {text:string}).text);changed.decisionMemory.facts[0].score=999
 await tool.onDelivery!({...original,content:[{type:'text',text:JSON.stringify(changed)}]})
 expect(reader.exposure({})).toBeUndefined()
 await tool.onDelivery!(original);expect(reader.exposure({})).toBeUndefined()
 const fresh=await tool.execute('recover_after_changed_receipt',{},undefined,undefined)
 await tool.onDelivery!({...original,content:fresh.content});expect(reader.exposure({})).toBeDefined()
})

for(const gapFirst of [true,false])test(gapFirst?'actual ordered ordinary delivery can restore a newer full evaluation packet after an older memory-tool gap':'a later memory-tool gap overrides the earlier full evaluation packet in the same actual ordinary inference',async()=>{
 const f=await fixture(),lane=new ScientistLane(f.options),reader=(lane as any).contextReader,callbacks:any[]=[],session=structuredClone(f.session)
 const assistant=session.messages[1]!;if(assistant.role!=='assistant')throw Error('Original assistant protocol absent')
 const pair=(gap:boolean)=>[{...assistant,content:[{type:'toolCall' as const,id:gap?'older_gap':'newer_full',name:gap?'read_decision_memory':'evaluate_trial',arguments:{}}]},
  {role:'toolResult' as const,toolCallId:gap?'older_gap':'newer_full',toolName:gap?'read_decision_memory':'evaluate_trial',isError:false,timestamp:4,content:[{type:'text' as const,text:JSON.stringify(gap?{status:'unavailable',readTool:'read_decision_memory',reason:'An older retained source was unavailable'}:{status:'succeeded',decisionMemoryRefresh:JSON.parse((f.result.content[0] as {text:string}).text)})}]}]
 session.messages=[session.messages[0]!,...pair(gapFirst),...pair(!gapFirst)];await f.sessions.save(session)
 const tools=lane.tools().filter(tool=>['read_decision_memory','evaluate_trial'].includes(tool.name)).map(tool=>({...tool,onDelivery:async(delivery:Parameters<NonNullable<typeof tool.onDelivery>>[0])=>{callbacks.push({name:tool.name,phase:delivery.phase,inference:delivery.inference});await tool.onDelivery!(delivery)}}))
 const {scientistContextPolicy}=await import('../jobs/scientist-context')
 let visiblePositions:number[]=[]
 const runtime=new PiRuntime({store:f.sessions,tools,contextPolicy:scientistContextPolicy({}),streamFn:(_model,context)=>{
  visiblePositions=context.messages.flatMap((message,index)=>message.role==='toolResult'?[index]:[])
  expect(visiblePositions).toHaveLength(2)
  return answer('Use current full evidence while preserving the earlier explicit gap.')
 }})
 const result=await runtime.run(session.id,'Continue the same frozen objective.');expect(result.status).toBe('completed')
 expect(!!reader.exposure({})).toBe(gapFirst)
 expect(callbacks).toHaveLength(2);expect(callbacks.every(callback=>callback.phase==='inference')).toBe(true)
 expect(callbacks.map(callback=>callback.inference.position)).toEqual(visiblePositions)
 expect(callbacks[0].inference.requestId).toBe(callbacks[1].inference.requestId)
 expect(callbacks.map(callback=>callback.inference.toolCallId)).toEqual(gapFirst?['older_gap','newer_full']:['newer_full','older_gap'])
 expect((await f.sessions.events(session.id)).filter(event=>event.type==='tool_execution_start')).toHaveLength(0)
})


test('ordered recovery rejects absent, stale, same-call and foreign-request provenance and fences a newer invalidation',async()=>{
 for(const variant of ['absent','earlier','same','foreign_request','same_call','invalid_position','replayed_gap','newer_invalidation'] as const){
  const f=await fixture(),lane=new ScientistLane(f.options),tool=lane.tools().find(tool=>tool.name==='read_decision_memory')!,reader=(lane as any).contextReader
  const gap={phase:'inference' as const,projection:'full' as const,isError:false,content:[{type:'text' as const,text:JSON.stringify({status:'unavailable',readTool:'read_decision_memory'})}],details:undefined,inference:{requestId:'ordinary_request',position:10,toolCallId:'original_gap'}}
  await tool.onDelivery!(gap)
  const inference=variant==='absent'?undefined:{requestId:variant==='foreign_request'?'other_request':'ordinary_request',position:variant==='earlier'?9:variant==='same'?10:variant==='invalid_position'?-1:11,toolCallId:variant==='same_call'?'original_gap':'later_full'}
  if(variant==='replayed_gap'){await tool.onDelivery!({...gap,inference:{...gap.inference,position:5}});inference!.position=8}
  const ack=tool.onDelivery!({phase:'inference',projection:'full',isError:false,content:f.result.content,details:undefined,...(inference?{inference}:{})})
  if(variant==='newer_invalidation')reader.clearMemoryAcknowledgement()
  await ack;expect(reader.exposure({})).toBeUndefined()
 }
})
