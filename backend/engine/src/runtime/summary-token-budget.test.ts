import {expect,test} from 'bun:test'
import {normalizeContext,createAssistantMessageEventStream,type AssistantMessage,type Context,type Model} from '@earendil-works/pi-ai'
import {stream} from '@earendil-works/pi-ai/api/openai-completions'
import {compactContext,estimateContextInput,contextRangeHash} from './context'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
import {restoreManager} from './sdk'
import {historicalSummarySource,type SummaryFragment} from './summary-fragments'
import {fitPiPayloadToContext} from './capacity'

const policy={maxInputTokens:48000,reserveTokens:16384,keepRecentTokens:1000}
const assistant=(content:AssistantMessage['content'],reason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,stopReason:reason,timestamp:2,usage:{input:3,output:4,cacheRead:0,cacheWrite:0,totalTokens:7,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}})
const response=(message:AssistantMessage)=>{const events=createAssistantMessageEventStream();events.push(message.stopReason==='error'?{type:'error',reason:'error',error:message}:{type:'done',reason:'stop',message});events.end(message);return events}
function fragments(context:Context){
 const result:SummaryFragment[]=[]
 for(const message of context.messages){
  if(message.role!=='user')continue
  const text=typeof message.content==='string'?message.content:message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')
  for(const line of text.split('\n')){
   try{const value=JSON.parse(line.startsWith('[User]: ')?line.slice(8):line);if(value.format==='autofold.pi-historical-fragment.v1')result.push(value)}catch{}
  }
 }
 return result
}
async function fixture(repeats:number,prior=false){
 const session=await new PiRuntime({store:new MemorySessionStore()}).create();delete session.sdk
 const group=[assistant([{type:'thinking',thinking:'Original reasoning remains uncertain π🧬. '.repeat(repeats)}, {type:'toolCall',id:'large_original_edit',name:'edit',arguments:{path:'trial.py',value:'ATOM 1 CA ALA B 1 0.2 0.3 0.4\n'.repeat(repeats)}}],'toolUse'),{role:'toolResult' as const,toolCallId:'large_original_edit',toolName:'edit',content:[{type:'text' as const,text:'Exact visible saved source 原始🧬 '+ 'bounded '.repeat(200)}],details:{hidden:'NEVER_SUMMARIZE_HIDDEN_BACKEND '.repeat(10000)},timestamp:3,isError:false}]
 session.messages=[{role:'user',content:'Exact original human objective stays protected.',timestamp:1},...group,assistant([{type:'text',text:'Recent bounded continuation. '.repeat(200)}]),{role:'user',content:'Current bounded host continuation.',timestamp:4}]
 const manager=restoreManager(session)
 if(prior){const first=manager.getBranch().find(entry=>entry.type==='message')!;manager.appendCompaction('Previously settled continuity. '.repeat(300),first.id,100000)}
 return {session,manager,group}
}
/** Capture the actual public SDK payload and stop before HTTP, not a copied prompt template. */
async function prepared(context:Context,maxTokens:number){
 let payload:any,fetches=0
 const captured=await stream(DEFAULT_MODEL,normalizeContext(context),{apiKey:'OFFLINE_SUMMARY_ORACLE',env:{},maxTokens,maxRetries:0,
  fetch:Object.assign(async()=>{fetches++;throw Error('Forbidden summary HTTP')},{preconnect:()=>{fetches++;throw Error('Forbidden preconnect')}}),
  onPayload:value=>{payload=structuredClone(value);throw Error('SUMMARY_PAYLOAD_CAPTURED_WITHOUT_HTTP')},
 }).result()
 expect(fetches).toBe(0);expect(payload).toBeDefined();expect(captured.errorMessage).toContain('SUMMARY_PAYLOAD_CAPTURED_WITHOUT_HTTP')
 return payload
}

test('a native summary group fitting the actual SDK token budget uses one batch, not several UTF-8-byte-budget requests',async()=>{
 const f=await fixture(850,true),original=JSON.stringify(f.session.messages),seen:SummaryFragment[]=[],payloads:any[]=[],estimates:number[]=[]
 const compacted=await compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model:DEFAULT_MODEL,policy,force:true,nativePromptSizing:true,streamFn:async(_model,context,options)=>{
  const estimate=await estimateContextInput(context,undefined,{nativeModel:DEFAULT_MODEL});estimates.push(estimate)
  expect(estimate).toBeLessThanOrEqual(policy.maxInputTokens)
  const payload=await prepared(context,options!.maxTokens!)
  expect(payload.max_tokens??payload.max_completion_tokens).toBe(Math.min(Math.floor(policy.reserveTokens*.8),DEFAULT_MODEL.maxTokens))
  expect(payload.messages.every((message:any)=>['system','developer','user'].includes(message.role))).toBe(true)
  expect(payload.tools??[]).toHaveLength(0)
  expect(JSON.stringify(payload)).not.toContain('NEVER_SUMMARIZE_HIDDEN_BACKEND')
  seen.push(...fragments(context));payloads.push(payload)
  return response(assistant([{type:'text',text:'Known concise continuity; exact originals remain authoritative.'}]))
 }})
 expect(compacted).toBeDefined()
 const source=historicalSummarySource(f.group,1,1),parts=seen.filter(fragment=>fragment.sourceKind==='projected_history'&&fragment.toolCalls.some(call=>call.id==='large_original_edit'))
 expect(Buffer.byteLength(source.text)).toBeGreaterThan(35712)
 expect(parts.map(part=>part.sourceText).join('')).toBe(source.text)
 expect(parts.at(-1)!.endBytes).toBe(Buffer.byteLength(source.text))
 expect(contextRangeHash(JSON.stringify(f.session.messages.slice(0,compacted!.checkpoint.originalRange.end)))).toBe(compacted!.checkpoint.sha256)
 expect(JSON.stringify(f.session.messages)).toBe(original)
 expect(payloads).toHaveLength(1)
 expect(compacted!.checkpoint.summarization!.summaryRequests).toBe(1)
 expect(compacted!.checkpoint.summarization!.recompressionRequests).toBe(0)
 expect(compacted!.result.usage!.cost.total).toBeCloseTo(.01)
 console.log(JSON.stringify({format:'autofold.offline-native-summary-token-throughput.v1',sourceBytes:Buffer.byteLength(source.text),summaryRequests:payloads.length,nativeSdkEstimatedPromptTokens:estimates,nativeMaxOutputTokens:payloads[0].max_tokens??payloads[0].max_completion_tokens,httpCalls:0,scope:'Software fixture, not paid provider throughput.'}))
})

test('truly oversized native summary history is split with complete UTF-8/provenance coverage and every actual prompt bounded',async()=>{
 const f=await fixture(5000),original=JSON.stringify(f.session.messages),seen:SummaryFragment[]=[],estimates:number[]=[]
 const compacted=await compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model:DEFAULT_MODEL,policy,force:true,nativePromptSizing:true,streamFn:async(_model,context,options)=>{
  estimates.push(await estimateContextInput(context,undefined,{nativeModel:DEFAULT_MODEL}));await prepared(context,options!.maxTokens!)
  seen.push(...fragments(context));return response(assistant([{type:'text',text:'Concise known continuity; read exact archived source before relying on it.'}]))
 }})
 expect(compacted).toBeDefined();expect(estimates.length).toBeGreaterThan(1);expect(estimates.every(value=>value<=policy.maxInputTokens)).toBe(true)
 const source=historicalSummarySource(f.group,1,1),parts=seen.filter(fragment=>fragment.sourceKind==='projected_history'&&fragment.toolCalls.some(call=>call.id==='large_original_edit'))
 expect(parts.map(part=>part.sourceText).join('')).toBe(source.text)
 let offset=0
 for(const fragment of parts){expect(fragment.offsetBytes).toBe(offset);expect(fragment.sourceText).not.toContain('\ufffd');expect(Buffer.byteLength(fragment.sourceText)).toBe(fragment.endBytes-fragment.offsetBytes);expect(fragment.archive.sha256).toBe(compacted!.checkpoint.sha256);offset=fragment.endBytes}
 expect(offset).toBe(Buffer.byteLength(source.text));expect(JSON.stringify(f.session.messages)).toBe(original)
 expect(compacted!.result.usage!.cost.total).toBeCloseTo(estimates.length*.01)
})

test('native summary provider errors still hold instead of publishing omitted history or retrying a failed batch',async()=>{
 const f=await fixture(850);let requests=0
 await expect(compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model:DEFAULT_MODEL,policy,force:true,nativePromptSizing:true,streamFn:()=>{
  requests++;return response({...assistant([],'error'),errorMessage:'Original summary provider outcome unknown',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
 }})).rejects.toThrow('Original summary provider outcome unknown')
 expect(requests).toBe(1);expect(f.manager.getEntries().some(entry=>entry.type==='compaction')).toBe(false)
})


test('native summary batches satisfy both estimated input tokens and actual payload byte capacity on smaller windows',async()=>{
 for(const variant of [{contextWindow:128000,maxTokens:100000,reserveTokens:16384},{contextWindow:64000,maxTokens:32000,reserveTokens:8192}]){
  const model:Model<'openai-completions'>={...DEFAULT_MODEL,contextWindow:variant.contextWindow,maxTokens:variant.maxTokens}
  const smallPolicy={...policy,reserveTokens:variant.reserveTokens}
  const f=await fixture(2200,true),original=JSON.stringify(f.session.messages),seen:SummaryFragment[]=[],capacities:Array<{inputTokenBound:number;admittedOutputTokens:number}>=[]
  let httpCalls=0,requests=0
  const compacted=await compactContext({sessionId:f.session.id,manager:f.manager,messages:f.manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model,policy:smallPolicy,force:true,nativePromptSizing:true,streamFn:async(_model,context,options)=>{
   requests++
   const estimated=await estimateContextInput(context,undefined,{nativeModel:model})
   expect(estimated).toBeLessThanOrEqual(Math.min(smallPolicy.maxInputTokens,model.contextWindow-smallPolicy.reserveTokens))
   let capacity:ReturnType<typeof fitPiPayloadToContext>
   const captured=await stream(model,normalizeContext(context),{apiKey:'OFFLINE_DUAL_CAPACITY_ORACLE',env:{},maxTokens:options!.maxTokens!,maxRetries:0,
    fetch:Object.assign(async()=>{httpCalls++;throw Error('Forbidden capacity HTTP')},{preconnect:()=>{httpCalls++;throw Error('Forbidden capacity preconnect')}}),
    onPayload:payload=>{
     const native=payload as Record<string,unknown>
     expect(native.max_tokens??native.max_completion_tokens).toBe(Math.min(Math.floor(variant.reserveTokens*.8),model.maxTokens))
     capacity=fitPiPayloadToContext(payload,model)
     throw Error('DUAL_CAPACITY_PAYLOAD_CAPTURED_WITHOUT_HTTP')
    },
   }).result()
   expect(captured.errorMessage).toContain('DUAL_CAPACITY_PAYLOAD_CAPTURED_WITHOUT_HTTP')
   expect(capacity).toBeDefined()
   expect(capacity!.sizing.inputTokenBound+capacity!.sizing.admittedOutputTokens).toBeLessThanOrEqual(model.contextWindow)
   expect(capacity!.sizing.admittedOutputTokens).toBe(Math.min(Math.floor(variant.reserveTokens*.8),model.maxTokens))
   capacities.push(capacity!.sizing);seen.push(...fragments(context))
   return response(assistant([{type:'text',text:'Concise continuity; exact Unicode source and original archive remain authoritative.'}]))
  }})
  expect(compacted).toBeDefined();expect(requests).toBeGreaterThan(1);expect(httpCalls).toBe(0)
  const source=historicalSummarySource(f.group,1,1),parts=seen.filter(fragment=>fragment.sourceKind==='projected_history'&&fragment.toolCalls.some(call=>call.id==='large_original_edit'))
  expect(parts.map(part=>part.sourceText).join('')).toBe(source.text)
  let offset=0
  for(const part of parts){expect(part.offsetBytes).toBe(offset);expect(part.sourceText).not.toContain('\ufffd');expect(part.endBytes-part.offsetBytes).toBe(Buffer.byteLength(part.sourceText));expect(part.archive.sha256).toBe(compacted!.checkpoint.sha256);offset=part.endBytes}
  expect(offset).toBe(Buffer.byteLength(source.text));expect(JSON.stringify(f.session.messages)).toBe(original)
  expect(compacted!.result.usage!.cost.total).toBeCloseTo(requests*.01)
  console.log(JSON.stringify({format:'autofold.offline-native-summary-dual-capacity.v1',contextWindow:model.contextWindow,reserveTokens:variant.reserveTokens,sourceBytes:Buffer.byteLength(source.text),requests,maxInputTokenBound:Math.max(...capacities.map(value=>value.inputTokenBound)),httpCalls}))
 }
})
