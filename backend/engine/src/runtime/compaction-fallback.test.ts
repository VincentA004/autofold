import {expect,test} from 'bun:test'
import type {AgentMessage} from '@earendil-works/pi-agent-core'
import {createAssistantMessageEventStream,type AssistantMessage,type Context} from '@earendil-works/pi-ai'
import {compactContext,contextRangeHash,estimateActiveContextInput,validateContextProtocol} from './context'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
import {restoreManager} from './sdk'
import {exactInstructionMessages,restoreExactInstructions} from './instructions'
import {restoreScientificContext} from './scientific-context'

const policy={maxInputTokens:12000,reserveTokens:2000,keepRecentTokens:1000,retainLatestToolGroups:[['read_context','read_decision_memory']]}
const model={...DEFAULT_MODEL,contextWindow:48000}
const intent='Exact human objective: complete the bounded experiment. Do not turn interpretations into measurements. 原始🧬'
const system='Exact host constraints: preserve canonical receipts, current scope and independently frozen scoring.'
const assistant=(content:AssistantMessage['content'],cost=.03,reason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,api:model.api,provider:model.provider,model:model.id,timestamp:10,stopReason:reason,usage:{input:7,output:11,cacheRead:0,cacheWrite:0,totalTokens:18,cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}}})
const answer=(message:AssistantMessage)=>{const stream=createAssistantMessageEventStream();stream.push(message.stopReason==='error'||message.stopReason==='aborted'?{type:'error',reason:message.stopReason,error:message}:{type:'done',reason:message.stopReason as 'stop'|'toolUse'|'length',message});stream.end(message);return stream}
const call=(id:string,name:string)=>({type:'toolCall' as const,id,name,arguments:{path:'trial.py'}})
const result=(id:string,name:string,text:string)=>({role:'toolResult' as const,toolCallId:id,toolName:name,content:[{type:'text' as const,text}],isError:false,timestamp:11})
const isSummary=(context:Context)=>JSON.stringify(context).includes('<conversation>')||JSON.stringify(context).includes('# Conversation')
async function fixture(){
 const store=new MemorySessionStore(),runtime=new PiRuntime({store}),session=await runtime.create({metadata:{projectId:'project_fallback',experimentId:'exp_fallback'}})
 delete session.sdk
 const packet=JSON.stringify({decisionMemory:{format:'autofold.decision-memory.v1',sourceManifest:{scope:{projectId:'project_fallback',experimentId:'exp_fallback'}},facts:[{runId:'run_first_baseline',receiptStatus:'verified',receiptHash:'sha256:first',score:.2},{runId:'run_second_baseline',receiptStatus:'verified',receiptHash:'sha256:second',score:.3}],fullProvenance:'Full current scientific context 原始🧬'.repeat(60)}})
 const scientific=result('original_memory','read_decision_memory',packet)
 ;(scientific as any).details={hidden:'Original backend metadata is archived, never silently expanded into summary input. '.repeat(1000)}
 session.messages=[{role:'system',content:system,timestamp:1},{role:'user',content:intent,timestamp:2},assistant([call('original_memory','read_decision_memory')],0,'toolUse'),scientific]
 for(let index=0;index<35;index++)session.messages.push(assistant([call('historical_'+index,'read')],0,'toolUse'),result('historical_'+index,'read','Historical source '+index+' 原始🧬 '+('Exact historical coordinates and context. '.repeat(110))))
 session.messages.push(assistant([{type:'text',text:'Current bounded authoring action remains to write and validate a draft.'}],0),{role:'user',content:'Continue under the same bounded host authority.',timestamp:500})
 return {store,session,manager:restoreManager(session),packet,scientific}
}

test('known nonshrinking summary degrades to explicit archive continuity while full current memory, exact instructions and paid usage survive',async()=>{
 const f=await fixture(),original=JSON.stringify(f.session.messages),requests:Context[]=[]
 const compacted=await compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model,policy,nativePromptSizing:true,force:true,streamFn:(_model,context)=>{
  requests.push(structuredClone(context))
  expect(JSON.stringify(context)).not.toContain('Original backend metadata is archived')
  return answer(assistant([{type:'text',text:'NONSHRINKING_CONTINUITY '.repeat(600)}]))
 }})
 expect(compacted).toBeDefined()
 const checkpoint=compacted!.checkpoint,fallback=(checkpoint.summarization as any)?.fallback
 expect(fallback).toMatchObject({format:'autofold.pi-archive-continuity-fallback.v1',semanticCoverage:'unavailable',archive:{id:checkpoint.id,sha256:checkpoint.sha256,originalRange:checkpoint.originalRange}})
 expect(['nonshrinking_summary','recompression_allowance']).toContain(fallback.reason)
 expect(fallback.unprocessedGroupCount).toBeGreaterThan(0)
 expect(fallback.unprocessedGroups.length).toBeLessThanOrEqual(8)
 expect(fallback.unprocessedGroups.length+fallback.unprocessedGroupsOmitted).toBe(fallback.unprocessedGroupCount)
 expect(fallback.sourceManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
 expect(fallback.unprocessedManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
 expect(checkpoint.summary).toContain(checkpoint.id);expect(checkpoint.summary).toContain(checkpoint.sha256)
 expect(checkpoint.summary).not.toContain('NONSHRINKING_CONTINUITY')
 expect(checkpoint.estimatedTokensAfter).toBeLessThanOrEqual(policy.maxInputTokens)
 expect(checkpoint.summarization!.summaryRequests).toBe(requests.length)
 expect(requests.length).toBeGreaterThan(1);expect(requests.length).toBeLessThanOrEqual(5)
 expect(compacted!.result.usage!.cost.total).toBeCloseTo(requests.length*.03)
 expect(compacted!.result.usage!.input).toBe(requests.length*7)
 expect(contextRangeHash(JSON.stringify(f.session.messages.slice(0,checkpoint.originalRange.end)))).toBe(checkpoint.sha256)
 expect(JSON.stringify(f.session.messages)).toBe(original)
 f.manager.appendCompaction(compacted!.result.summary,compacted!.result.firstKeptEntryId,compacted!.result.tokensBefore,checkpoint,true,compacted!.result.usage)
 const anchors=exactInstructionMessages(f.manager),active=restoreScientificContext({manager:f.manager,messages:f.manager.buildSessionProjection().messages,session:f.session,groups:policy.retainLatestToolGroups})
 const delivered=restoreExactInstructions(active.messages,anchors)
 validateContextProtocol(delivered)
 expect(delivered.filter(message=>message.role==='system')).toEqual([{role:'system',content:system,timestamp:1}])
 expect(delivered.some(message=>message.role==='user'&&message.content===intent)).toBe(true)
 expect(delivered.find(message=>message.role==='toolResult'&&message.toolCallId==='original_memory')).toEqual(f.scientific)
 expect(await estimateActiveContextInput(active.messages,anchors)).toBeLessThanOrEqual(policy.maxInputTokens)
})

test('a second deterministic compaction preserves both immutable archive prefixes and the newest full scientific snapshot',async()=>{
 const f=await fixture();let requests=0
 for(let pass=0;pass<2;pass++){
  const before=JSON.stringify(f.session.messages)
  const compacted=await compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model,policy,nativePromptSizing:true,force:true,streamFn:()=>{requests++;return answer(assistant([{type:'text',text:'NONSHRINKING_CONTINUITY '.repeat(600)}]))}})
  expect(compacted).toBeDefined();expect((compacted!.checkpoint.summarization as any)?.fallback?.semanticCoverage).toBe('unavailable')
  const checkpoint=compacted!.checkpoint
  expect(contextRangeHash(JSON.stringify(f.session.messages.slice(0,checkpoint.originalRange.end)))).toBe(checkpoint.sha256)
  expect(JSON.stringify(f.session.messages)).toBe(before)
  f.manager.appendCompaction(compacted!.result.summary,compacted!.result.firstKeptEntryId,compacted!.result.tokensBefore,checkpoint,true,compacted!.result.usage)
  const active=restoreScientificContext({manager:f.manager,messages:f.manager.buildSessionProjection().messages,session:f.session,groups:policy.retainLatestToolGroups})
  validateContextProtocol(active.messages)
  expect(active.messages.find(message=>message.role==='toolResult'&&message.toolCallId===(pass?'newest_memory':'original_memory'))).toEqual(f.scientific)
  expect(await estimateActiveContextInput(active.messages,exactInstructionMessages(f.manager))).toBeLessThanOrEqual(policy.maxInputTokens)
  if(!pass){
   const newMemory=[assistant([call('newest_memory','read_decision_memory')],0,'toolUse'),result('newest_memory','read_decision_memory',f.packet+'\n')] as const
   f.scientific=newMemory[1]!
   const added:typeof f.session.messages=[...newMemory]
   for(let index=0;index<20;index++)added.push(assistant([call('second_history_'+index,'read')],0,'toolUse'),result('second_history_'+index,'read','Fresh historical source. '.repeat(170)))
   added.push({role:'user',content:'Continue the same original bounded experiment after new retrieval.',timestamp:900})
   for(const message of added){f.session.messages.push(message);f.manager.appendMessage(message as Parameters<typeof f.manager.appendMessage>[0])}
  }
 }
 expect(requests).toBeGreaterThan(2);expect(requests).toBeLessThanOrEqual(10)
})

test('deterministic fallback is published before actual ordinary continuation and retains every settled request charge',async()=>{
 const f=await fixture();let summaries=0,ordinary=0,effects=0
 const runtime=new PiRuntime({store:f.store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:policy,limits:{maxTurns:30},tools:[{name:'read_decision_memory',label:'Memory',description:'Only an original fixture receipt',parameters:{type:'object'} as any,execute:async()=>{effects++;throw Error('No historical tool may be replayed')}}],streamFn:(_model,context)=>{
  if(isSummary(context)){summaries++;return answer(assistant([{type:'text',text:'NONSHRINKING_RETURN '.repeat(1200)}]))}
  ordinary++
  expect(context.messages.some(message=>message.role==='user'&&message.content===intent)).toBe(true)
  expect(context.messages.some(message=>message.role==='toolResult'&&message.toolCallId==='original_memory'&&JSON.stringify(message.content)===JSON.stringify((f.scientific as any).content))).toBe(true)
  validateContextProtocol(context.messages as AgentMessage[])
  return answer(assistant([{type:'text',text:'Continue authoring from original receipts; no historical interpretation is measurement authority.'}]))
 }})
 await f.store.save(f.session)
 const output=await runtime.run(f.session.id,'Continue without renewing cumulative authority.')
 expect(output.error).toBeUndefined();expect(output.status).toBe('completed');expect(ordinary).toBe(1);expect(effects).toBe(0)
 expect(summaries).toBeGreaterThan(0);expect(summaries).toBeLessThanOrEqual(5)
 expect(output.session.contextCompactions?.some(checkpoint=>(checkpoint.summarization as any)?.fallback)).toBe(true)
 const requests=Object.values(output.session.modelRequests??{})
 expect(requests).toHaveLength(summaries+ordinary);expect(requests.every(request=>request.status==='settled')).toBe(true)
 expect(output.session.usage.costUsd).toBeCloseTo((summaries+ordinary)*.03)
 expect(output.session.messages.slice(0,f.session.messages.length)).toEqual(f.session.messages)
 const events=await f.store.events(f.session.id)
 expect(events.findIndex(event=>event.type==='context_compacted')).toBeLessThan(events.findIndex(event=>event.type==='model_request_dispatched'&&(event.data as {purpose?:string})?.purpose!=='compaction'))
})

test('pending protocol intent and oversized protected instructions hold without any summarization request',async()=>{
 for(const mode of ['pending','protected'] as const){
  const f=await fixture();let requests=0
  if(mode==='pending')f.session.messages.push(assistant([call('unsettled_intent','edit')],0,'toolUse'))
  else f.session.messages[1]={role:'user',content:intent+'EXACT '.repeat(12000),timestamp:2}
  const manager=restoreManager({...f.session,sdk:undefined})
  await expect(compactContext({sessionId:f.session.id,manager,messages:manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model,policy,nativePromptSizing:true,force:true,streamFn:()=>{requests++;return answer(assistant([{type:'text',text:'A fallback cannot hide pending effects or human instructions.'}]))}})).rejects.toThrow(mode==='pending'?'pending tool intent':'protected context')
  expect(requests).toBe(0)
 }
})

test('unknown provider outcome, invalid semantic response and cancellation cannot enter the deterministic size fallback',async()=>{
 for(const mode of ['unknown','toolUse','aborted'] as const){
  const f=await fixture(),controller=new AbortController();let requests=0
  const run=compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model,policy,nativePromptSizing:true,force:true,signal:controller.signal,streamFn:()=>{
   requests++
   if(mode==='aborted'){controller.abort(new Error('Explicit host cancellation'));return answer(assistant([{type:'text',text:'NONSHRINKING_CONTINUITY '.repeat(280)}]))}
   return answer(mode==='unknown'?{...assistant([],0,'error'),errorMessage:'Unknown provider delivery: do not retry'}:assistant([call('invalid_summary_tool','edit')],.03,'toolUse'))
  }})
  await expect(run).rejects.toThrow()
  expect(requests).toBe(1)
  expect(f.manager.getEntries().some(entry=>entry.type==='compaction')).toBe(false)
 }
})

test('an unknown recompression outcome retains its earlier paid charge and blocks future inference without a fallback checkpoint',async()=>{
 const f=await fixture();let requests=0
 const runtime=new PiRuntime({store:f.store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:policy,streamFn:()=>{
  requests++
  return answer(requests===1?assistant([{type:'text',text:'NONSHRINKING_RETURN '.repeat(1200)}]):{...assistant([],0,'error'),errorMessage:'Unknown recompression provider delivery',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
 }})
 await f.store.save(f.session)
 const output=await runtime.run(f.session.id,'Continue under unchanged authority.')
 expect(output.status).toBe('failed');expect(requests).toBe(2)
 expect(output.session.contextCompactions).toBeUndefined()
 expect(Object.values(output.session.modelRequests??{}).map(request=>request.status)).toEqual(['settled','unknown'])
 expect(output.session.usage.costUsd).toBeCloseTo(.03)
 const retry=await runtime.run(f.session.id,'Reconcile unknown provider outcome only.')
 expect(retry.status).toBe('failed');expect(requests).toBe(2)
})
