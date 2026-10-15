import {expect,test} from 'bun:test'
import {normalizeContext,resolveTranscript,getCurrentSystemMessage,getCurrentTools,createAssistantMessageEventStream,type Context,type AssistantMessage} from '@earendil-works/pi-ai'
import {stream} from '@earendil-works/pi-ai/api/openai-completions'
import {convertToLlm} from '@earendil-works/pi-coding-agent'
import {compactContext,estimateContextInput,estimateActiveContextInput,contextRangeHash,validateContextProtocol} from './context'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
import {restoreManager} from './sdk'
import {exactInstructionMessages,restoreExactInstructions} from './instructions'
import {restoreScientificContext} from './scientific-context'

const human='Repeated exact human instruction 原始🧬: preserve the original evidence and frozen limits.'
const policy={maxInputTokens:48000,reserveTokens:16384,keepRecentTokens:6000}
const assistant=(text:string):AssistantMessage=>({role:'assistant',content:[{type:'text',text}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,stopReason:'stop',timestamp:10,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
async function fixture(){
 const session=await new PiRuntime({store:new MemorySessionStore()}).create();delete session.sdk
 session.messages=[
  {role:'system',content:'APPEND_BASE_LITERAL',sections:{first:'FIRST_SECTION',guide:'OBSOLETE_A '.repeat(7200),obsolete:'DELETE_THIS_SECTION'},toolsAdded:[{name:'inspect',description:'Old capability',parameters:{type:'object',properties:{value:{type:'string'}}}}],timestamp:1},
  {role:'user',content:human,timestamp:2},
  {role:'system',content:'APPEND_TRUE_DELTA',sections:{guide:'OBSOLETE_B '.repeat(7200),obsolete:null,tail:'NEW_TAIL_SECTION'},toolsRemoved:[{name:'inspect'}],toolsAdded:[{name:'inspect',description:'Changed capability',parameters:{type:'object',properties:{value:{type:'integer'}}}},{name:'additional',description:'A genuinely new capability',parameters:{type:'object'}}],timestamp:3},
  assistant('Completed historical observation remains interpretation.'),
  {role:'system',content:'APPEND_LAST_LITERAL',sections:{guide:'CURRENT_GUIDE '.repeat(6000),first:null},timestamp:4},
  {role:'system',content:'',sections:{first:'RESTORED_LAST_SECTION'},timestamp:5},
  {role:'user',content:human,timestamp:6},
  assistant('Current bounded action.'),
 ]
 const manager=restoreManager(session),anchors=exactInstructionMessages(manager),messages=manager.buildSessionProjection().messages
 const context=normalizeContext({messages:convertToLlm(restoreExactInstructions(messages,anchors))})
 return {session,manager,anchors,messages,context}
}

/** Native adapter is an offline composition oracle; the hard throw precedes HTTP. */
async function prepare(context:Context,model=DEFAULT_MODEL){
 let payload:any,fetches=0
 const output=await stream(model,normalizeContext(context),{apiKey:'OFFLINE_COMPOSITION_FIXTURE',env:{},maxRetries:0,maxTokens:model.maxTokens,
  fetch:Object.assign(async()=>{fetches++;throw Error('Forbidden fixture HTTP')},{preconnect:()=>{fetches++;throw Error('Forbidden fixture preconnect')}}),
  onPayload:value=>{payload=structuredClone(value);throw Error('OFFLINE_PREPARED_BEFORE_HTTP')},
 }).result()
 expect(fetches).toBe(0);expect(payload).toBeDefined();expect(output.errorMessage).toContain('OFFLINE_PREPARED_BEFORE_HTTP')
 return payload
}
const wire=(payload:any)=>({model:payload.model,messages:payload.messages,tools:payload.tools,tool_choice:payload.tool_choice})
const summary=()=>{const message=assistant('Historical continuity is bounded; verified original receipts remain authoritative.');const events=createAssistantMessageEventStream();events.push({type:'done',reason:'stop',message});events.end(message);return events}

test('native provider sizing uses the exact SDK system fold without changing the prepared input, archive or human/tool semantics',async()=>{
 const f=await fixture(),original=JSON.stringify(f.session.messages),source=JSON.stringify(f.context)
 const resolved=resolveTranscript(f.context,DEFAULT_MODEL.compat?.supportsMidConvoSystemMessages)
 const originalPayload=await prepare(f.context),resolvedPayload=await prepare(resolved)
 expect(wire(resolvedPayload)).toEqual(wire(originalPayload))
 expect(originalPayload.messages.filter((message:any)=>message.role==='user'&&message.content===human)).toHaveLength(2)
 for(const literal of ['APPEND_BASE_LITERAL','APPEND_TRUE_DELTA','APPEND_LAST_LITERAL'])expect(JSON.stringify(resolvedPayload.messages)).toContain(literal)
 expect(Object.keys(getCurrentSystemMessage(f.context.messages)!.sections!)).toEqual(['guide','tail','first'])
 expect(getCurrentTools(resolved.messages).map(tool=>tool.name)).toEqual(['inspect','additional'])
 expect(getCurrentTools(resolved.messages).find(tool=>tool.name==='inspect')!.parameters).toMatchObject({properties:{value:{type:'integer'}}})
 expect(JSON.stringify(resolvedPayload)).not.toContain('DELETE_THIS_SECTION')
 expect(JSON.stringify(f.context)).toBe(source);expect(JSON.stringify(f.session.messages)).toBe(original)
 const raw=await estimateContextInput(f.context),native=await estimateContextInput(f.context,undefined,{nativeModel:DEFAULT_MODEL})
 expect(raw).toBeGreaterThan(policy.maxInputTokens)
 expect(native).toBe(await estimateContextInput(resolved));expect(native).toBeLessThan(policy.maxInputTokens)
 expect(await estimateActiveContextInput(f.messages,f.anchors,undefined,undefined,{nativeModel:DEFAULT_MODEL})).toBe(native)
})

test('a native wire-sized input below the hard ceiling causes no unnecessary semantic request despite large internal system deltas',async()=>{
 const f=await fixture(),original=JSON.stringify(f.session.messages);let requests=0
 const value=await compactContext({sessionId:f.session.id,manager:f.manager,messages:f.messages,archive:f.session.messages,session:f.session,model:DEFAULT_MODEL,policy,nativePromptSizing:true,streamFn:()=>{requests++;throw Error('Unnecessary semantic compaction')}})
 expect(value).toBeUndefined();expect(requests).toBe(0);expect(JSON.stringify(f.session.messages)).toBe(original)
})

test('explicit midconversation support and arbitrary/custom provider sizing retain their original system-delta semantics',async()=>{
 const f=await fixture(),original=JSON.stringify(f.context),mid={...DEFAULT_MODEL,compat:{...DEFAULT_MODEL.compat,supportsMidConvoSystemMessages:true}}
 const resolved=resolveTranscript(f.context,true),actual=await prepare(f.context,mid),candidate=await prepare(resolved,mid)
 expect(wire(actual)).toEqual(wire(candidate));expect(resolved.messages.filter(message=>message.role==='system')).toHaveLength(4)
 expect(await estimateContextInput(f.context,undefined,{nativeModel:mid})).toBe(await estimateContextInput(resolved))
 const unscoped=await estimateContextInput(f.context)
 expect(await estimateActiveContextInput(f.messages,f.anchors)).toBe(unscoped)
 expect(await estimateContextInput(f.context,undefined,{nativeModel:{...DEFAULT_MODEL,api:'anthropic-messages'}})).toBe(unscoped)
 expect(JSON.stringify(f.context)).toBe(original)
})

test('genuinely oversized exact human instructions remain a hard pre-provider hold under native sizing',async()=>{
 const f=await fixture();let requests=0
 f.session.messages.push({role:'user',content:'EXACT_UNOMITTABLE_HUMAN '.repeat(12000),timestamp:20})
 const manager=restoreManager({...f.session,sdk:undefined}),original=JSON.stringify(f.session.messages)
 await expect(compactContext({sessionId:f.session.id,manager,messages:manager.buildSessionProjection().messages,archive:f.session.messages,session:f.session,model:DEFAULT_MODEL,policy,nativePromptSizing:true,force:true,streamFn:()=>{requests++;throw Error('Protected input cannot be summarized away')}})).rejects.toThrow('protected context')
 expect(requests).toBe(0);expect(JSON.stringify(f.session.messages)).toBe(original)
})

test('compaction reserves useful working room for a subsequent complete tool cycle while retaining full current evidence and exact archives',async()=>{
 const session=await new PiRuntime({store:new MemorySessionStore()}).create();delete session.sdk
 const packet=JSON.stringify({decisionMemory:{facts:[{runId:'baseline_one',receiptHash:'sha256:first',receiptStatus:'verified'},{runId:'baseline_two',receiptHash:'sha256:second',receiptStatus:'verified'}],provenance:'P'.repeat(4000)}})
 const memoryCall={...assistant(''),stopReason:'toolUse' as const,content:[{type:'toolCall' as const,id:'current_memory',name:'read_decision_memory',arguments:{}}]}
 const memory={role:'toolResult' as const,toolCallId:'current_memory',toolName:'read_decision_memory',content:[{type:'text' as const,text:packet}],timestamp:11,isError:false}
 session.messages=[{role:'system',content:'Exact host prefix.',sections:{host:'H'.repeat(24000)},timestamp:1},{role:'user',content:human,timestamp:2},memoryCall,memory]
 for(let index=0;index<14;index++)session.messages.push({...assistant(''),stopReason:'toolUse',content:[{type:'toolCall',id:'old_'+index,name:'read',arguments:{path:'source_'+index}}]}, {role:'toolResult',toolCallId:'old_'+index,toolName:'read',content:[{type:'text',text:'T'.repeat(4000)}],timestamp:20+index,isError:false})
 session.messages.push(assistant('Continue the same bounded authoring task.'))
 const manager=restoreManager(session),original=JSON.stringify(session.messages),bounded={maxInputTokens:12000,reserveTokens:2000,keepRecentTokens:6000,retainLatestToolGroups:[['read_decision_memory']]}
 let requests=0
 const run=()=>compactContext({sessionId:session.id,manager,messages:manager.buildSessionProjection().messages,archive:session.messages,session,model:DEFAULT_MODEL,policy:bounded,nativePromptSizing:true,streamFn:()=>{requests++;return summary()}})
 const first=await run();expect(first).toBeDefined();expect(requests).toBeGreaterThan(0)
 const checkpoint=first!.checkpoint
 expect(contextRangeHash(JSON.stringify(session.messages.slice(0,checkpoint.originalRange.end)))).toBe(checkpoint.sha256)
 expect(JSON.stringify(session.messages)).toBe(original)
 manager.appendCompaction(first!.result.summary,first!.result.firstKeptEntryId,first!.result.tokensBefore,checkpoint,true,first!.result.usage)
 const science=restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session,groups:bounded.retainLatestToolGroups})
 expect(science.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='current_memory')).toEqual(memory)
 validateContextProtocol(science.messages)
 const continuation:[AssistantMessage,typeof memory]=[{...assistant(''),stopReason:'toolUse',content:[{type:'toolCall',id:'next_bounded_read',name:'read',arguments:{path:'trial.py'}}]},{...memory,toolCallId:'next_bounded_read',toolName:'read',content:[{type:'text',text:'B'.repeat(15000)}]}]
 for(const message of continuation){session.messages.push(message);manager.appendMessage(message)}
 const beforeSecond=requests,next=await run()
 expect(next).toBeUndefined();expect(requests).toBe(beforeSecond)
 expect(checkpoint.estimatedTokensAfter).toBeLessThanOrEqual((checkpoint as any).compactionTargetTokens)
 expect((checkpoint as any).continuationHeadroomTokens).toBeGreaterThan(0)
 expect((checkpoint as any).compactionTargetTokens).toBeLessThan(checkpoint.inputBudget)
 const delivered=restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session,groups:bounded.retainLatestToolGroups}).messages
 expect(await estimateActiveContextInput(delivered,exactInstructionMessages(manager),undefined,undefined,{nativeModel:DEFAULT_MODEL})).toBeLessThanOrEqual(bounded.maxInputTokens)
})

test('near-hard protected science reserves its bounded summary before allocating optional continuation headroom',async()=>{
 const session=await new PiRuntime({store:new MemorySessionStore()}).create();delete session.sdk
 const packet=JSON.stringify({decisionMemory:{facts:[{runId:'baseline_one'},{runId:'baseline_two'}],exactProvenance:'P'.repeat(4000)}})
 const call={...assistant(''),stopReason:'toolUse' as const,content:[{type:'toolCall' as const,id:'near_hard_memory',name:'read_decision_memory',arguments:{}}]}
 const memory={role:'toolResult' as const,toolCallId:'near_hard_memory',toolName:'read_decision_memory',content:[{type:'text' as const,text:packet}],timestamp:3,isError:false}
 session.messages=[{role:'system',content:'Exact high protected context.',sections:{host:'H'.repeat(180000)},timestamp:1},{role:'user',content:human,timestamp:2},call,memory]
 for(let index=0;index<8;index++)session.messages.push(assistant('Ordinary archived source '.repeat(250)))
 const manager=restoreManager(session),original=JSON.stringify(session.messages),scoped={...policy,keepRecentTokens:6000,retainLatestToolGroups:[['read_decision_memory']]}
 const protectedEstimate=await estimateActiveContextInput([call,memory],exactInstructionMessages(manager),undefined,undefined,{nativeModel:DEFAULT_MODEL})
 expect(protectedEstimate).toBeGreaterThan(45000);expect(protectedEstimate).toBeLessThan(policy.maxInputTokens)
 const compacted=await compactContext({sessionId:session.id,manager,messages:manager.buildSessionProjection().messages,archive:session.messages,session,model:DEFAULT_MODEL,policy:scoped,nativePromptSizing:true,streamFn:()=>summary()})
 expect(compacted).toBeDefined();expect(compacted!.checkpoint.estimatedTokensAfter).toBeLessThanOrEqual(policy.maxInputTokens)
 expect(compacted!.checkpoint.estimatedTokensAfter).toBeLessThanOrEqual(compacted!.checkpoint.compactionTargetTokens!)
 expect(compacted!.checkpoint.continuationHeadroomTokens).toBeGreaterThanOrEqual(0)
 expect(compacted!.checkpoint.continuationHeadroomTokens).toBeLessThan(1024)
 expect(JSON.stringify(session.messages)).toBe(original)
 expect(contextRangeHash(JSON.stringify(session.messages.slice(0,compacted!.checkpoint.originalRange.end)))).toBe(compacted!.checkpoint.sha256)
 manager.appendCompaction(compacted!.result.summary,compacted!.result.firstKeptEntryId,compacted!.result.tokensBefore,compacted!.checkpoint,true,compacted!.result.usage)
 const active=restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session,groups:scoped.retainLatestToolGroups})
 expect(active.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='near_hard_memory')).toEqual(memory)
 validateContextProtocol(active.messages)
})
