import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import {createAssistantMessageEventStream,type AssistantMessage,type Context} from '@earendil-works/pi-ai'
import {findCutPoint,buildSessionProjection,type Extension,type SessionEntry} from '@earendil-works/pi-coding-agent'
import {Type} from 'typebox'
import {PiRuntime,MemorySessionStore,SqliteSessionStore,AppendOnlySessionStore,DEFAULT_MODEL} from './index'
import {readToolArtifact} from './artifacts'
import {exactInstructionMessages,PROMPT_ORIGIN,INSTRUCTION_BINDING,assertPayloadInstructions,restoreExactInstructions} from './instructions'
import {restoreManager} from './sdk'
import type {RuntimeTool,RuntimeToolDelivery} from './types'

const assistant=(content:AssistantMessage['content'],stopReason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,stopReason,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}})
const answer=(value:AssistantMessage)=>{const stream=createAssistantMessageEventStream();stream.push(value.stopReason==='error'?{type:'error',reason:'error',error:value}:{type:'done',reason:value.stopReason as 'stop'|'toolUse',message:value});stream.end(value);return stream}
const call=(id:string,value='original')=>({type:'toolCall' as const,id,name:'write',arguments:{value}})
const tool=(execute:(value:string)=>Promise<unknown>|unknown,onDelivery?:RuntimeTool['onDelivery'],executionMode:'sequential'|'parallel'='sequential'):RuntimeTool=>({name:'write',label:'Write',description:'Offline host fixture',parameters:Type.Object({value:Type.String()},{additionalProperties:false}),executionMode,onDelivery,execute:async(_id,args)=>({content:[{type:'text',text:JSON.stringify(await execute((args as any).value))}],details:{}})})
const extension=(handlers:Record<string,(event:any)=>unknown|Promise<unknown>>):Extension=>({path:'autofold:fixture',resolvedPath:'autofold:fixture',sourceInfo:{path:'autofold:fixture',source:'test',scope:'project',origin:'top-level',baseDir:'.'},handlers:new Map(Object.entries(handlers).map(([name,handler])=>[name,[handler]])),tools:new Map(),messageRenderers:new Map(),commands:new Map(),flags:new Map(),shortcuts:new Map()} as Extension)
const isSummary=(context:Context)=>JSON.stringify(context.messages).includes('# Conversation')||JSON.stringify(context.messages).includes('<conversation>')

test('native scoped tool hooks preserve blocks, argument mutations and final result/error overrides',async()=>{
  for(const mode of ['block','mutate','invalid','error','forge'] as const){
    let effects=0,requests=0
    const runtime=new PiRuntime({store:new MemorySessionStore(),stopToolNames:['write'],tools:[tool(value=>{effects++;expect(value).toBe(mode==='mutate'?'native': 'original');if(mode==='forge')throw new Error('Host handoff failed');return {accepted:true}})],
      extensions:[extension({tool_call:async event=>{if(mode==='block')return {block:true,reason:'Native refused'};if(mode==='mutate')event.input.value='native';if(mode==='invalid')event.input.value=3},tool_result:async()=>mode==='error'?{content:[{type:'text',text:'Native normalized error'}],isError:true}:mode==='forge'?{content:[{type:'text',text:'Forged success'}],isError:false}:undefined})],
      streamFn:(_model,context)=>{if(requests++===0)return answer(assistant([call('call')],'toolUse'));const text=JSON.stringify(context.messages);expect(text).toContain(mode==='block'?'Native refused':mode==='invalid'?'invalid arguments':mode==='error'?'Native normalized error':'Forged success');return answer(assistant([{type:'text',text:'No accepted handoff.'}]))}})
    const result=await runtime.run((await runtime.create()).id,'Exact human constraint')
    expect(result.status).toBe('completed');expect(effects).toBe(mode==='block'||mode==='invalid'?0:1);expect(requests).toBe(mode==='mutate'?1:2)
  }
})

test('tool authority is rechecked after an awaited native mutation and immediately before effects',async()=>{
  let effects=0,gates=0,allowed=true,requests=0
  const runtime=new PiRuntime({store:new MemorySessionStore(),tools:[tool(()=>{effects++;return 'effect'})],
    extensions:[extension({tool_call:async event=>{await Promise.resolve();event.input.value='native';allowed=false}})],
    authorizeToolCall:request=>{gates++;expect((request.args as any).value).toBe('native');if(!allowed)throw new Error('Grant revoked')},
    streamFn:()=>answer(requests++===0?assistant([call('call')],'toolUse'):assistant([{type:'text',text:'Stopped.'}]))})
  const result=await runtime.run((await runtime.create()).id,'Work')
  expect(result.status).toBe('completed');expect(gates).toBe(1);expect(effects).toBe(0)
})

test('native parallel preparation reserves the final tool allowance once before either effect',async()=>{
  let effects=0
  const runtime=new PiRuntime({store:new MemorySessionStore(),toolExecution:'parallel',limits:{maxToolCalls:1},tools:[tool(()=>{effects++;return 'done'},undefined,'parallel')],
    extensions:[extension({tool_call:async()=>{await Promise.resolve()}})],streamFn:()=>answer(assistant([call('first'),call('second')],'toolUse'))})
  const result=await runtime.run((await runtime.create()).id,'One tool effect')
  expect(result.status).toBe('limit_reached');expect(effects).toBe(1);expect(result.session.usage.toolCalls).toBe(1)
  expect(result.session.messages.filter(message=>message.role==='toolResult')).toHaveLength(2)
})

test('exact intermediate human instructions survive many compactable host snapshots and reopen',async()=>{
  const file='/private/tmp/autofold-cohesive-'+crypto.randomUUID()+'.sqlite',store=new SqliteSessionStore(file)
  const model={...DEFAULT_MODEL,contextWindow:14000},policy={maxInputTokens:10000,reserveTokens:2000,keepRecentTokens:1000}
  let summaries=0,sessionId='',hostEntries=0,middleHuman=''
  const anchors=['First exact human requirement.','Middle requirement: π stays literal.','Latest exact human requirement.']
  const runtime=new PiRuntime({store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:policy,
    streamFn:async(_model,context)=>{if(isSummary(context)){summaries++;return answer(assistant([{type:'text',text:'Continuity summary; originals remain authoritative.'}]))}
      for(const anchor of anchors)expect(context.messages.some(message=>message.role==='user'&&message.content===anchor)).toBe(true)
      if(middleHuman)expect(JSON.stringify(context.messages)).toContain(middleHuman)
      const saved=(await store.get(sessionId))!;hostEntries=saved.sdk!.entries.filter(entry=>entry.type==='custom'&&entry.customType===PROMPT_ORIGIN).length
      expect(hostEntries).toBeGreaterThan(0)
      return answer(assistant([{type:'text',text:'Observed host state. '+ 'progress '.repeat(120)}]))}})
  try{
    sessionId=(await runtime.create()).id
    for(let index=0;index<24;index++){
      if(index===12){middleHuman='Intermediate actual human message after initial host snapshots';expect((await runtime.run(sessionId,middleHuman)).status).toBe('completed')}
      const result=await runtime.run(sessionId,'Generated state '+index+': '+'snapshot '.repeat(220),{promptOrigin:'host_context',exactInstructions:anchors.map((text,id)=>({id:'human:'+id,text})),owningBinding:{operationId:'op_fixture',bindingHash:'sha256:'+'a'.repeat(64)}})
      expect(result.error).toBeUndefined();expect(result.status).toBe('completed')
    }
    const original=(await store.get(sessionId))!
    expect(summaries).toBeGreaterThan(0);expect(hostEntries).toBe(24)
    expect(original.sdk!.entries.filter(entry=>entry.type==='custom'&&entry.customType===INSTRUCTION_BINDING)).toHaveLength(3)
    expect(exactInstructionMessages(restoreManager(original)).filter(message=>message.role==='user')).toHaveLength(4)
    expect(Object.values(original.modelRequests!).filter(request=>request.owningBinding).every(request=>request.owningBinding?.operationId==='op_fixture')).toBe(true)
    expect(Object.values(original.modelRequests!).some(request=>request.purpose==='compaction')).toBe(true)
    const rejected=await runtime.run(sessionId,'Do not dispatch',{exactInstructions:[{id:'human:1',text:'Changed requirement'}]})
    expect(rejected.status).toBe('failed');expect(rejected.error).toContain('instruction identity changed')
    store.close();const reopened=new SqliteSessionStore(file)
    try{const loaded=(await reopened.get(sessionId))!;expect(loaded.sdk).toEqual(rejected.session.sdk);expect(exactInstructionMessages(restoreManager(loaded)).filter(message=>message.role==='user')).toHaveLength(4)}finally{reopened.close()}
  }finally{store.close();await Promise.all(['','-wal','-shm'].map(suffix=>fs.rm(file+suffix,{force:true})))}
})

test('untagged legacy middle instruction remains exact and a mismatched origin tag cannot omit it',async()=>{
  const store=new MemorySessionStore(),seen:string[]=[]
  const runtime=new PiRuntime({store,streamFn:(_model,context)=>{seen.push(JSON.stringify(context.messages));return answer(assistant([{type:'text',text:'Complete.'}]))}})
  const session=await runtime.create();delete session.sdk
  session.messages.push({role:'user',content:'Legacy original',timestamp:1},{role:'user',content:'Legacy middle human constraint',timestamp:2});await store.save(session)
  const result=await runtime.run(session.id,'New human')
  expect(seen[0]).toContain('Legacy middle human constraint')
  const manager=restoreManager(result.session),target=manager.getBranch().find(entry=>entry.type==='message'&&entry.message.role==='user')!
  manager.appendCustomEntry(PROMPT_ORIGIN,{targetEntryId:target.id,contentHash:'sha256:'+'0'.repeat(64),origin:'host_context'})
  expect(()=>exactInstructionMessages(manager)).toThrow('does not match')
})

test('oversized tool cards preserve original UTF-8 bytes, scoped identity and actual delivery phases',async()=>{
  const store=new MemorySessionStore(),original='π🙂'.repeat(25000),delivery:RuntimeToolDelivery[]=[],contexts:Context[]=[]
  let requests=0
  const runtime=new PiRuntime({store,tools:[tool(()=>({decisionMemory:{packetHash:'original',full:original}}),value=>{delivery.push(value)})],streamFn:(_model,context)=>{contexts.push(structuredClone(context));return answer(requests++===0?assistant([call('huge')],'toolUse'):assistant([{type:'text',text:'Inspect the artifact.'}]))}})
  const result=await runtime.run((await runtime.create()).id,'Work')
  expect(result.status).toBe('completed');expect(delivery.map(value=>[value.phase,value.projection])).toEqual([['published','artifact_reference'],['inference','artifact_reference']])
  const projected=contexts[1]!.messages.find(message=>message.role==='toolResult')!
  const card=JSON.parse((projected.content[0] as {text:string}).text)
  expect(card.exposure).toBe('artifact_reference_only');expect(JSON.stringify(projected)).not.toContain(original)
  let offset=0,exact=''
  while(true){const page=readToolArtifact(result.session,{...card.toolArtifact,offsetBytes:offset,limitBytes:997});exact+=page.text;if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes}
  expect(JSON.parse(exact)).toEqual(result.session.messages.find(message=>message.role==='toolResult'))
  expect(()=>readToolArtifact(result.session,{...card.toolArtifact,sessionId:'ses_other'})).toThrow('another Pi session')
  expect(()=>readToolArtifact(result.session,{...card.toolArtifact,toolCallId:'wrong'})).toThrow('identity changed')
  expect(()=>readToolArtifact(result.session,{...card.toolArtifact,messageHash:'sha256:'+'0'.repeat(64)})).toThrow('identity changed')
})

test('memory inference delivery follows actual transformed content and excludes same-batch blind decisions',async()=>{
  for(const mode of ['full','after_override','context_override','unknown_usage'] as const){
    const delivered:RuntimeToolDelivery[]=[],phasesAtEffect:number[]=[];let requests=0
    const packet={decisionMemory:{packetHash:'packet',observations:['exact evidence']}}
    const runtime=new PiRuntime({store:new MemorySessionStore(),tools:[tool(()=>packet,value=>{delivered.push(value)})],
      extensions:mode==='after_override'?[extension({tool_result:()=>({content:[{type:'text',text:'Artifact reference only'}]})})]:undefined,
      transformContext:mode==='context_override'?async messages=>messages.map(message=>message.role==='toolResult'?{...message,content:[{type:'text',text:'Transformed artifact'}]}:message):undefined,
      streamFn:()=>{if(requests++===0){phasesAtEffect.push(delivered.length);return answer(assistant([call('memory')],'toolUse'))}
        if(mode==='unknown_usage')return answer({...assistant([], 'error'),errorMessage:'Transport failed',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
        return answer(assistant([{type:'text',text:'Read actual context.'}]))}})
    const result=await runtime.run((await runtime.create()).id,'Work')
    expect(phasesAtEffect).toEqual([0]);expect(delivered[0]!.phase).toBe('published')
    const inference=delivered.filter(value=>value.phase==='inference')
    expect(inference).toHaveLength(mode==='unknown_usage'?0:1)
    if(inference.length)expect(JSON.stringify(inference[0]!.content).includes('exact evidence')).toBe(mode==='full')
    expect(result.status).toBe(mode==='unknown_usage'?'failed':'completed')
  }
})

test('phased delivery observers cannot change canonical tool bytes and failure prevents later effects',async()=>{
  for(const mode of ['mutate','throw'] as const){
    let requests=0,effects=0
    const runtime=new PiRuntime({store:new MemorySessionStore(),tools:[tool(()=>{effects++;return 'Original exact receipt'},delivery=>{
      if(delivery.phase==='inference'){if(mode==='throw')throw new Error('Local delivery acknowledgment failed');(delivery.content[0] as {text:string}).text='Observer mutation'}
    })],streamFn:()=>answer(requests++===0?assistant([call('first')],'toolUse'):assistant([call('second')],'toolUse')),limits:{maxTurns:2}})
    const result=await runtime.run((await runtime.create()).id,'Work')
    expect(result.session.messages.find(message=>message.role==='toolResult')).toMatchObject({content:[{type:'text',text:JSON.stringify('Original exact receipt')}]})
    if(mode==='throw'){expect(result.status).toBe('failed');expect(result.error).toContain('acknowledgment failed');expect(effects).toBe(1);expect(Object.values(result.session.modelRequests!).every(request=>request.status==='settled')).toBe(true)}
  }
})

test('actual settled ordinary context observer sees host prompt transforms and never summary or unknown usage',async()=>{
  const contexts:string[]=[],store=new MemorySessionStore(),packet=JSON.stringify({decisionMemory:{packetHash:'original',facts:['exact']}})
  const runtime=new PiRuntime({store,onInferenceContext:request=>{contexts.push(JSON.stringify(request.messages))},
    transformContext:async messages=>messages.map(message=>message.role==='user'&&(message.content===packet||Array.isArray(message.content)&&message.content.some(part=>part.type==='text'&&part.text===packet))?{...message,content:'Host snapshot replaced'}:message),
    streamFn:()=>answer(assistant([{type:'text',text:'Complete.'}]))})
  const result=await runtime.run((await runtime.create()).id,packet,{promptOrigin:'host_context',exactInstructions:[{id:'human',text:'Actual human requirements'}]})
  expect(result.status).toBe('completed');expect(contexts).toHaveLength(1);expect(contexts[0]).toContain('Host snapshot replaced');expect(contexts[0]).not.toContain('packetHash')
  expect(result.session.messages.some(message=>message.role==='user'&&(message.content===packet||Array.isArray(message.content)&&message.content.some(part=>part.type==='text'&&part.text===packet)))).toBe(true)
})

test('actual native lifecycle preparation and public cuts retain original projected entry IDs',async()=>{
  const store=new MemorySessionStore(),model={...DEFAULT_MODEL,contextWindow:14000},cuts:string[]=[]
  const runtime=new PiRuntime({store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:{maxInputTokens:10000,reserveTokens:2000,keepRecentTokens:1000},
    extensions:[extension({session_before_compact: event=>{
      const projection=buildSessionProjection(event.branchEntries),previous=projection.entries.findIndex(entry=>entry.sourceEntry.type==='compaction'&&entry.messages.length)
      const entries=projection.entries.map(entry=>entry.sourceEntry.type==='message'&&entry.messages.length?{...entry.sourceEntry,message:entry.messages[0]}:entry.sourceEntry) as SessionEntry[]
      const cut=findCutPoint(entries,previous<0?0:previous+1,entries.length,event.preparation.settings.keepRecentTokens)
      expect(entries[cut.firstKeptEntryIndex]!.id).toBe(event.preparation.firstKeptEntryId)
      cuts.push(event.preparation.firstKeptEntryId)
    }})],streamFn:(_model,context)=>answer(assistant([{type:'text',text:isSummary(context)?'Bounded native summary.':'Completed.'}]))})
  const session=await runtime.create();delete session.sdk;session.messages.push({role:'user',content:'Original instructions',timestamp:1})
  for(let index=0;index<20;index++)session.messages.push(assistant([{type:'text',text:'Historical state '+index+': '+ 'x'.repeat(3000)}]))
  session.messages.push({...assistant([], 'error'),errorMessage:'maximum context length exceeded'});await store.save(session)
  const result=await runtime.run(session.id,'Continue')
  expect(result.error).toBeUndefined();expect(cuts.length).toBeGreaterThan(0)
  for(const cut of cuts)expect(result.session.sdk!.entries.some(entry=>entry.type==='compaction'&&entry.firstKeptEntryId===cut)).toBe(true)
  expect(result.session.messages.slice(0,session.messages.length)).toEqual(session.messages)
})

test('original owning attribution cannot be moved, removed or retroactively added to legacy requests',async()=>{
  for(const store of [new MemorySessionStore(),new SqliteSessionStore(':memory:'),new AppendOnlySessionStore(':memory:')]){
    try{
      const runtime=new PiRuntime({store,streamFn:()=>answer(assistant([{type:'text',text:'Complete.'}]))}),session=await runtime.create()
      const original=await runtime.run(session.id,'First human',{owningBinding:{operationId:'op_original',bindingHash:'hash'}})
      const id=Object.keys(original.session.modelRequests!)[0]!
      for(const mode of ['change','remove'] as const){const bad=structuredClone(original.session);if(mode==='remove')delete bad.modelRequests![id]!.owningBinding;else bad.modelRequests![id]!.owningBinding!.operationId='op_other'
        await expect(store.save(bad)).rejects.toThrow('owning binding cannot change')}
      const next=await runtime.run(session.id,'Second human')
      const legacyId=Object.keys(next.session.modelRequests!).find(request=>request!==id)!,bad=structuredClone(next.session)
      bad.modelRequests![legacyId]!.owningBinding={operationId:'op_other',bindingHash:'hash'}
      await expect(store.save(bad)).rejects.toThrow('owning binding cannot change')
    }finally{if(!(store instanceof MemorySessionStore))store.close()}
  }
})

test('native after-hook images and content overrides retain exact normalized original bytes across compaction and SQLite reopen',async()=>{
  const file='/private/tmp/autofold-native-artifact-'+crypto.randomUUID()+'.sqlite',store=new AppendOnlySessionStore(file)
  const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const fullText='Exact after-hook observation: '+'π🙂'.repeat(18000),model={...DEFAULT_MODEL,contextWindow:14000}
  let requests=0,ref:any
  const runtime=new PiRuntime({store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:{maxInputTokens:10000,reserveTokens:2000,keepRecentTokens:1000},
    tools:[tool(()=>({raw:'will be replaced'}))],extensions:[extension({tool_result:()=>({content:[{type:'text',text:fullText},{type:'image',data:image,mimeType:'image/png'}],details:{normalized:true},isError:false})})],
    streamFn:(_model,context)=>{
      if(isSummary(context))return answer(assistant([{type:'text',text:'Continuity summary with original artifact reference.'}]))
      if(requests++===0)return answer(assistant([call('original_tool')],'toolUse'))
      const result=context.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='original_tool')
      if(result){const card=JSON.parse((result.content[0] as {text:string}).text);ref??=card.toolArtifact;expect(card.exposure).toBe('artifact_reference_only')}
      return answer(assistant([{type:'text',text:'Next decision '+ 'reasoning '.repeat(80)}]))}})
  try{
    const session=(await runtime.create()).id
    expect((await runtime.run(session,'Actual human requirement')).status).toBe('completed');expect(ref).toBeDefined()
    for(let index=0;index<18;index++)expect((await runtime.run(session,'Generated host state '+index+': '+'snapshot '.repeat(300),{promptOrigin:'host_context'})).status).toBe('completed')
    const original=(await store.get(session))!,source=original.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='original_tool')!
    expect(source.content).toEqual([{type:'text',text:fullText},{type:'image',data:image,mimeType:'image/png'}]);expect(original.contextCompactions!.length).toBeGreaterThan(0)
    store.close();const reopened=new AppendOnlySessionStore(file)
    try{
      const saved=(await reopened.get(session))!;expect(saved.sdk).toEqual(original.sdk)
      let offset=0,bytes=''
      while(true){const page=readToolArtifact(saved,{...ref,offsetBytes:offset,limitBytes:1031});bytes+=page.text;if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes}
      expect(JSON.parse(bytes)).toEqual(source)
    }finally{reopened.close()}
  }finally{store.close();await Promise.all(['','-wal','-shm'].map(suffix=>fs.rm(file+suffix,{force:true})))}
})

test('host transforms cannot remove an intermediate exact instruction before provider dispatch',async()=>{
  let requests=0
  const runtime=new PiRuntime({store:new MemorySessionStore(),transformContext:async messages=>messages.filter(message=>message.role!=='user'||message.content!=='Middle actual human constraint'),
    streamFn:()=>{requests++;return answer(assistant([{type:'text',text:'Must not dispatch'}]))}})
  const result=await runtime.run((await runtime.create()).id,'Host generated context',{promptOrigin:'host_context',exactInstructions:[{id:'first',text:'First actual human requirement'},{id:'middle',text:'Middle actual human constraint'},{id:'last',text:'Last actual human requirement'}]})
  expect(result.status).toBe('failed');expect(result.error).toContain('protected exact human instructions');expect(requests).toBe(0)
})

test('final native payload in-place mutation with undefined return cannot claim original exposure or alter protected instructions',async()=>{
  for(const mode of ['host_context','human'] as const){
    let transports=0,observations=0;const seen:Context['messages'][]=[]
    const transport=Object.assign(async()=>{transports++;return new Response('data: '+JSON.stringify({id:'gen_final_'+mode,model:DEFAULT_MODEL.id,provider:'OfflineExact',choices:[{index:0,delta:{content:'Complete.'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:.001}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})},{preconnect:()=>{}}) as typeof fetch
    const runtime=new PiRuntime({store:new MemorySessionStore(),getApiKey:()=> 'offline-secret',onInferenceContext:request=>{observations++;seen.push(request.messages)},streamOptions:{fetch:transport,onPayload:payload=>{
      const body=payload as {messages:Array<{role:string;content:unknown}>}
      const target=body.messages.findLast(message=>message.role==='user')!
      target.content='Observer changed the final payload in place'
      return undefined
    }}})
    const result=await runtime.run((await runtime.create()).id,JSON.stringify({decisionMemory:{packetHash:'original',facts:['not actually delivered']}}),mode==='host_context'?{promptOrigin:'host_context',exactInstructions:[{id:'human',text:'Actual human requirement'}]}:{})
    if(mode==='host_context'){expect(result.status).toBe('completed');expect(transports).toBe(1);expect(observations).toBe(1);expect(seen[0]).toEqual([])}
    else{expect(result.status).toBe('failed');expect(result.error).toContain('protected exact human instructions');expect(transports).toBe(0);expect(observations).toBe(0);expect(Object.values(result.session.modelRequests!).every(request=>request.status==='not_dispatched')).toBe(true)}
  }
})

test('an imported oversized legacy tool group becomes rehydratable before compaction without rewriting originals',async()=>{
  const file='/private/tmp/autofold-import-artifact-'+crypto.randomUUID()+'.sqlite',store=new SqliteSessionStore(file),receipt='Historical exact original π: '+'🧬'.repeat(20000)
  const model={...DEFAULT_MODEL,contextWindow:14000};let ref:any,requests=0
  const runtime=new PiRuntime({store,modelSelection:{provider:model.provider,modelId:model.id,model},contextPolicy:{maxInputTokens:10000,reserveTokens:2000,keepRecentTokens:1000},streamFn:(_model,context)=>{
    requests++;const result=context.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='legacy_call')!;expect(result).toBeDefined()
    ref=JSON.parse((result.content[0] as {text:string}).text).toolArtifact
    return answer(assistant([{type:'text',text:'Historical result is available by exact pages.'}]))}})
  try{
    const session=await runtime.create();delete session.sdk
    session.messages=[{role:'user',content:'Legacy human requirements',timestamp:1},assistant([call('legacy_call')],'toolUse'),{role:'toolResult',toolCallId:'legacy_call',toolName:'write',content:[{type:'text',text:receipt}],isError:false,timestamp:2}]
    await store.save(session)
    const result=await runtime.run(session.id,'Continue from original evidence')
    expect(result.error).toBeUndefined();expect(result.status).toBe('completed');expect(requests).toBe(1);expect(result.session.messages.slice(0,3)).toEqual(session.messages)
    store.close();const reopened=new SqliteSessionStore(file)
    try{const saved=(await reopened.get(session.id))!;let bytes='',offset=0
      while(true){const page=readToolArtifact(saved,{...ref,offsetBytes:offset,limitBytes:997});bytes+=page.text;if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes}
      expect(JSON.parse(bytes)).toEqual(session.messages[2]);expect(saved.messages.slice(0,3)).toEqual(session.messages)
    }finally{reopened.close()}
  }finally{store.close();await Promise.all(['','-wal','-shm'].map(suffix=>fs.rm(file+suffix,{force:true})))}
})

test('the final native payload preserves image-only human inputs, top-level constraints and instruction order',async()=>{
  const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const store=new MemorySessionStore();let transports=0
  const transport=Object.assign(async()=>{transports++;throw new Error('Forbidden transport')},{preconnect:()=>{}}) as typeof fetch
  const runtime=new PiRuntime({store,getApiKey:()=> 'offline-secret',streamOptions:{fetch:transport,onPayload:payload=>{
    const body=payload as {messages:unknown[]};body.messages=body.messages.filter(message=>!JSON.stringify(message).includes(image));return undefined
  }}})
  const session=await runtime.create();delete session.sdk
  session.messages.push({role:'user',content:[{type:'image',data:image,mimeType:'image/png'}],timestamp:1});await store.save(session)
  const result=await runtime.run(session.id,'Generated context',{promptOrigin:'host_context'})
  expect(result.status).toBe('failed');expect(result.error).toContain('protected exact human instructions');expect(transports).toBe(0)
  const before={system:[{type:'text',text:'Frozen host constraints'}],messages:[{role:'user',content:'First human'},{role:'user',content:'Middle human'}],tools:[]}
  const anchors=[{role:'user' as const,content:'First human',timestamp:1},{role:'user' as const,content:'Middle human',timestamp:2}]
  const top=structuredClone(before);top.system[0]!.text='Changed host constraints'
  expect(()=>assertPayloadInstructions(before,top,anchors)).toThrow('host constraints')
  const order=structuredClone(before);order.messages.reverse()
  expect(()=>assertPayloadInstructions(before,order,anchors)).toThrow('protected exact human instructions')
  expect(restoreExactInstructions([anchors[0]!,anchors[1]!],[anchors[0]!,{role:'user',content:'Originally omitted middle',timestamp:3},anchors[1]!]).map(message=>message.role==='user'?message.content:undefined)).toEqual(['First human','Originally omitted middle','Middle human'])
  let calls=0
  const orderRuntime=new PiRuntime({store:new MemorySessionStore(),transformContext:async messages=>[...messages].reverse(),streamFn:()=>{calls++;return answer(assistant([{type:'text',text:'Must not dispatch'}]))}})
  const rejected=await orderRuntime.run((await orderRuntime.create()).id,'Host context',{promptOrigin:'host_context',exactInstructions:[{id:'first',text:'First human'},{id:'middle',text:'Middle human'},{id:'last',text:'Last human'}]})
  expect(rejected.status).toBe('failed');expect(rejected.error).toContain('reordered protected exact human instructions');expect(calls).toBe(0)
})
