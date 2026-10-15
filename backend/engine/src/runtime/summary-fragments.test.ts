import {expect,test} from 'bun:test'
import {createAssistantMessageEventStream,type AssistantMessage,type Context,type Message} from '@earendil-works/pi-ai'
import {serializeConversation,convertToLlm} from '@earendil-works/pi-coding-agent'
import type {AgentMessage,StreamFn} from '@earendil-works/pi-agent-core'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL,estimateContextInput} from './index'
import {restoreManager} from './sdk'
import {compactContext} from './context'
import {historicalSummarySource,summaryFragmentMessage,fitSummaryFragment,type SummaryFragment} from './summary-fragments'

const assistant=(content:AssistantMessage['content'],cost=.01,stopReason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:10,stopReason,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}}})
const answer=(message:AssistantMessage)=>{const stream=createAssistantMessageEventStream();stream.push(message.stopReason==='error'?{type:'error',reason:'error',error:message}:{type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end(message);return stream}
const call=(id:string,name='edit',value='')=>({type:'toolCall' as const,id,name,arguments:{value}})
const toolResult=(id:string,text:string):Message=>({role:'toolResult',toolCallId:id,toolName:'edit',content:[{type:'text',text}],isError:false,timestamp:11})
const hugeGroup=():Message[]=>[assistant([{type:'thinking',thinking:'Reasoning and uncertainty π '.repeat(1200),thinkingSignature:'OPAQUE_TRANSPORT_SIGNATURE_MUST_NOT_BE_REVIEWED'}, {type:'text',text:'Concrete scientific edit.'},call('edit_large','edit','ATOM  12 CA ALA B 1 0.2 0.3 0.4\n'.repeat(700))],0,'toolUse'),toolResult('edit_large','{"projectedArtifact":"bounded-reference-only"}')]
const summaryText=(context:Context)=>context.messages.filter(message=>message.role==='user').flatMap(message=>typeof message.content==='string'?[message.content]:message.content.filter(part=>part.type==='text').map(part=>part.text)).join('\n')
function fragments(context:Context):SummaryFragment[]{
 const text=summaryText(context),parts:SummaryFragment[]=[]
 for(const line of text.split('\n')){
  const value=line.startsWith('[User]: ')?line.slice(8):line
  try{const parsed=JSON.parse(value);if(parsed.format==='autofold.pi-historical-fragment.v1')parts.push(parsed)}catch{}
 }
 return parts
}
async function fixture(messages:Message[],previousSummary?:string){
 const store=new MemorySessionStore(),runtime=new PiRuntime({store}),session=await runtime.create();delete session.sdk
 session.messages=[{role:'user',content:'Exact human frozen objective.',timestamp:1},...messages,{role:'user',content:'Current host continuation.',timestamp:50}]
 const manager=restoreManager(session)
 if(previousSummary){const first=manager.getBranch().find(entry=>entry.type==='message')!;manager.appendCompaction(previousSummary,first.id,100,{fixture:true},true)}
 return {session,manager}
}

test('UTF-8 fragments reconstruct all genuine visible reasoning, call arguments and tool text without hidden metadata',()=>{
 const group=hugeGroup();(group[1] as any).details={secret:'HIDDEN_BACKEND_GRAPH'.repeat(60000)}
 const original=JSON.stringify(group),source=historicalSummarySource(group,0,3),seen:SummaryFragment[]=[]
 let offset=0
 while(offset<Buffer.byteLength(source.text)){
  const next=fitSummaryFragment(source,offset,{id:'ctx_fixture',sha256:'sha256:original'},message=>Buffer.byteLength(JSON.stringify(message))<=6000)!
  expect(next).toBeDefined();expect(Buffer.byteLength(JSON.stringify(summaryFragmentMessage(next)))).toBeLessThanOrEqual(6000)
  seen.push(next);offset=next.endBytes
 }
 expect(seen.length).toBeGreaterThan(5);expect(seen.map(part=>part.sourceText).join('')).toBe(source.text)
 expect(source.text).toContain('Reasoning and uncertainty π');expect(source.text).toContain('ATOM  12 CA');expect(source.text).toContain('edit_large')
 expect(source.text).not.toContain('HIDDEN_BACKEND_GRAPH');expect(source.text).not.toContain('OPAQUE_TRANSPORT_SIGNATURE')
 expect(JSON.stringify(group)).toBe(original);expect(seen.every(part=>part.messageRangeBasis==='effective_summary_source'&&part.messageRange.start===3&&part.toolCallCount===1)).toBe(true)
})

test('complete mixed groups retain all call/result identifiers and tool text beyond SDK 2000-character summary truncation',()=>{
 const group:AgentMessage[]=[assistant([call('one'),call('two')],0,'toolUse'),toolResult('one','visible source '.repeat(500)+'END_FIRST_RESULT'),toolResult('two','π🙂'.repeat(1800)+'END_SECOND_RESULT')]
 const source=historicalSummarySource(group,1,10)
 expect(serializeConversation(convertToLlm(group))).not.toContain('END_FIRST_RESULT')
 expect(source.text).toContain('END_FIRST_RESULT');expect(source.text).toContain('END_SECOND_RESULT');expect(source.text).toContain('"id":"one"');expect(source.text).toContain('"toolCallId":"two"')
 expect(source.toolCalls).toEqual([{id:'one',name:'edit'},{id:'two',name:'edit'}])
})

test('native-sized compaction handles a real-shaped 56KB historical group and prior summary without changing archive or native output defaults',async()=>{
 const group=hugeGroup(),{session,manager}=await fixture([...group,assistant([{type:'text',text:'Recent bounded continuation. '.repeat(400)}],0)],'Prior continuity summary. '.repeat(800)),original=JSON.stringify(session.messages),seen:SummaryFragment[]=[],contexts:Context[]=[],maxTokens:number[]=[]
 const result=await compactContext({sessionId:session.id,manager,messages:manager.buildSessionProjection().messages,archive:session.messages,session,model:DEFAULT_MODEL,policy:{maxInputTokens:48000,reserveTokens:16384,keepRecentTokens:1000},nativePromptSizing:true,force:true,streamFn:(_model,context,options)=>{
  contexts.push(context);seen.push(...fragments(context));maxTokens.push(options!.maxTokens!);return answer(assistant([{type:'text',text:'Condensed factual continuity; originals retain authority.'}]))
 }})
 expect(result).toBeDefined();expect(contexts.length).toBeGreaterThan(1);expect(contexts.length).toBeLessThan(12)
 expect(maxTokens.every(value=>value===Math.floor(16384*.8))).toBe(true)
 for(const context of contexts)expect(await estimateContextInput(context)).toBeLessThan(48000)
 const source=historicalSummarySource(group,1,1),parts=seen.filter(part=>part.sourceKind==='projected_history'&&part.toolCalls.some(call=>call.id==='edit_large'))
 expect(parts.map(part=>part.sourceText).join('')).toBe(source.text)
 expect(result!.checkpoint.summarization!.fragments.some(part=>part.sourceKind==='previous_summary')).toBe(true)
 expect(result!.checkpoint.summarization!.summaryRequests).toBe(contexts.length)
 expect(result!.result.usage?.cost.total).toBeCloseTo(contexts.length*.01)
 expect(JSON.stringify(session.messages)).toBe(original)
})

test('growing summaries recompress with measured progress; nonshrinking output preserves archive continuity',async()=>{
 for(const nonshrinking of [false,true]){
  const {session,manager}=await fixture(hugeGroup());let requests=0
  const run=compactContext({sessionId:session.id,manager,messages:manager.buildSessionProjection().messages,archive:session.messages,model:DEFAULT_MODEL,policy:{maxInputTokens:48000,reserveTokens:16384,keepRecentTokens:1000},nativePromptSizing:true,force:true,streamFn:()=>{
   requests++;const text=requests===1||nonshrinking?'Verbose returned continuity. '.repeat(1600):'Bounded continuity.'
   return answer(assistant([{type:'text',text}]))
  }})
  if(nonshrinking){const result=await run;expect(result!.checkpoint.summarization!.fallback?.reason).toBe('nonshrinking_summary');expect(result!.checkpoint.summarization!.fallback?.semanticCoverage).toBe('unavailable');expect(requests).toBeLessThanOrEqual(5);expect(result!.result.usage!.cost.total).toBeCloseTo(requests*.01)}
  else {const result=await run;expect(result!.checkpoint.summarization!.recompressionRequests).toBeGreaterThan(0);expect(requests).toBeLessThan(10);expect(result!.result.usage!.cost.total).toBeCloseTo(requests*.01)}
 }
})

test('a failed later fragment retains every earlier paid request and unresolved billing blocks recovery inference',async()=>{
 const store=new MemorySessionStore(),model={...DEFAULT_MODEL,contextWindow:14000};let requests=0
 const streamFn:StreamFn=()=>{
  requests++;if(requests===1)return answer({...assistant([{type:'text',text:'First settled fragment summary.'}]),api:model.api})
  return answer({...assistant([],0,'error'),errorMessage:'Synthetic missing provider receipt',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
 }
 const runtime=new PiRuntime({store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:{maxInputTokens:10000,reserveTokens:2000,keepRecentTokens:1000},streamFn})
 const session=await runtime.create();delete session.sdk;session.messages=[{role:'user',content:'Exact objective.',timestamp:1},...hugeGroup(),{role:'user',content:'Continue under original host grant.',timestamp:50}];await store.save(session)
 const original=JSON.stringify(session.messages),outcome=await runtime.run(session.id,'Continue')
 expect(outcome.status).toBe('failed');expect(requests).toBe(2);expect(outcome.session.usage.costUsd).toBeCloseTo(.01)
 expect(Object.values(outcome.session.modelRequests!).map(request=>request.status)).toEqual(['settled','unknown']);expect(outcome.session.contextCompactions).toBeUndefined()
 expect(JSON.stringify(outcome.session.messages.slice(0,session.messages.length))).toBe(original)
 const retried=await runtime.run(session.id,'Reconcile only');expect(retried.status).toBe('failed');expect(requests).toBe(2)
})

test('semantic compaction re-exposes the exact current scientific packet to ordinary inference and settled delivery without executing its tool',async()=>{
 const store=new MemorySessionStore(),policy={maxInputTokens:10000,reserveTokens:2000,keepRecentTokens:1000,retainLatestToolGroups:[['read_decision_memory']]},model={...DEFAULT_MODEL,contextWindow:48000}
 const packet=JSON.stringify({decisionMemory:{sourceManifest:{scope:{projectId:'p_science',experimentId:'exp_science'}},facts:[{runId:'run_baseline_one',value:.2},{runId:'run_baseline_two',value:.3}],full:'Exact scientific provenance '.repeat(350)}})
 const originalResult:Message={role:'toolResult',toolCallId:'call_science',toolName:'read_decision_memory',isError:false,content:[{type:'text',text:packet}],details:{hidden:'HIDDEN_METADATA_NOT_PROVIDER_INPUT'},timestamp:3}
 const deliveries:{phase:string;projection:string;content:unknown}[]=[],observed:Context['messages'][]=[];let ordinary=0,summaries=0,executed=0
 const transport=Object.assign(async(_url:unknown,init?:RequestInit)=>{
  const payload=JSON.parse(String(init?.body)),serialized=JSON.stringify(payload)
  expect(serialized).not.toContain('HIDDEN_METADATA_NOT_PROVIDER_INPUT')
  const isSummary=serialized.includes('<conversation>')
  if(isSummary)summaries++
  else{
   ordinary++
   expect(payload.messages.some((message:any)=>message.role==='tool'&&JSON.stringify(message.content).includes('run_baseline_one')&&JSON.stringify(message.content).includes('run_baseline_two'))).toBe(true)
  }
  return new Response('data: '+JSON.stringify({id:'gen_projection_'+(summaries+ordinary),model:DEFAULT_MODEL.id,provider:'OfflineProjection',choices:[{index:0,delta:{content:isSummary?'Bounded factual continuity.':'Both exact baseline facts remain available.'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:.001}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
 },{preconnect:()=>{}}) as typeof fetch
 const runtime=new PiRuntime({store,modelSelection:{provider:model.provider,modelId:model.id,model:{...model,maxTokens:2000}},contextPolicy:policy,limits:{maxTurns:80,maxToolCalls:10},getApiKey:()=> 'offline-test-secret',
  tools:[{name:'read_decision_memory',label:'Memory',description:'Offline original current scientific snapshot',parameters:{type:'object'} as any,onDelivery:delivery=>{deliveries.push(delivery)},execute:async()=>{executed++;throw Error('Historical tool must not execute')}}],
  onInferenceContext:request=>{observed.push(request.messages)},streamOptions:{fetch:transport}})
 const session=await runtime.create({metadata:{projectId:'p_science',experimentId:'exp_science'}});delete session.sdk
 session.messages=[{role:'user',content:'Exact human science objective.',timestamp:1},assistant([call('call_science','read_decision_memory')],0,'toolUse'),originalResult,...hugeGroup(),assistant([{type:'text',text:'Recent ordinary work '.repeat(400)}],0),{role:'user',content:'Continue from the actual baseline pair.',timestamp:50}];await store.save(session)
 const outcome=await runtime.run(session.id,'Fresh bounded host grant')
 expect(outcome.error).toBeUndefined();expect(outcome.status).toBe('completed');expect(summaries).toBeGreaterThan(0);expect(ordinary).toBe(1);expect(executed).toBe(0)
 expect(outcome.session.contextCompactions?.some(checkpoint=>checkpoint.retainedAnchors.includes(2)&&checkpoint.scientificSnapshots?.some(snapshot=>snapshot.toolCallId==='call_science'))).toBe(true)
 expect(observed).toHaveLength(1);expect(observed[0]!.some(message=>message.role==='toolResult'&&message.toolCallId==='call_science')).toBe(true)
 expect(deliveries.some(delivery=>delivery.phase==='inference'&&delivery.projection==='full'&&JSON.stringify(delivery.content)===JSON.stringify(originalResult.content))).toBe(true)
 const events=await store.events(session.id);expect(events.some(event=>event.type==='scientific_context_reprojected')).toBe(true);expect(events.some(event=>event.type==='tool_execution_start')).toBe(false)
})
