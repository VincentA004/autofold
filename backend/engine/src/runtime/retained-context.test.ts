import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import {Type} from 'typebox'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {PiRuntime,MemorySessionStore,SqliteSessionStore,DEFAULT_MODEL} from './index'
import {projectRetainedToolArtifacts,readToolArtifact,toolProjectionBytes} from './artifacts'
import {restoreManager,snapshotManager} from './sdk'
import {validateContextProtocol} from './context'
const assistant=(content:AssistantMessage['content'],stopReason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,stopReason,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}})
const answer=(message:AssistantMessage)=>{const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end(message);return stream}

test('retained tool budget and latest snapshot use rehydratable native edits without changing originals across SQLite reopen',async()=>{
  const file='/private/tmp/autofold-retained-context-'+crypto.randomUUID()+'.sqlite',store=new SqliteSessionStore(file)
  const runtime=new PiRuntime({store}),session=await runtime.create()
  const names=['read_context','search_files','read','read_decision_memory','read','read','read_decision_memory','write','evaluate_trial']
  const values=names.map((name,index)=>name==='write'?'Saved.':name==='evaluate_trial'?JSON.stringify({result:'Valid.',decisionMemoryRefresh:{status:'unavailable'}}):JSON.stringify({snapshot:index,text:'原始🧬'.repeat(1200)}))
  session.messages=[{role:'user',content:'Exact human instruction: π🧬 preserve uncertainty.',timestamp:1}]
  for(const [index,name] of names.entries())session.messages.push(assistant([{type:'toolCall',id:'call_'+index,name,arguments:{source:index===7?'x'.repeat(9500):index}}],'toolUse'),{role:'toolResult',toolCallId:'call_'+index,toolName:name!,content:[{type:'text',text:values[index]!}],isError:false,timestamp:index+2})
  const originals=structuredClone(session.messages),manager=restoreManager(session)
  const proof=projectRetainedToolArtifacts(manager,session,22000,[['read_context','read_decision_memory'],['evaluate_trial']])
  expect(proof.count).toBeGreaterThan(2);expect(proof.protectedOverflow).toBe(true);expect(proof.retainedBytesAfter).toBeGreaterThan(22000)
  const projected=manager.buildSessionProjection().messages;validateContextProtocol(projected)
  expect(projected.find(m=>m.role==='toolResult'&&m.toolCallId==='call_6')).toEqual(originals[14])
  expect(projected.find(m=>m.role==='toolResult'&&m.toolCallId==='call_7')).toEqual(originals[16])
  expect(projected.find(m=>m.role==='toolResult'&&m.toolCallId==='call_8')).toEqual(originals[18])
  expect(projected[0]).toEqual(originals[0]);expect(session.messages).toEqual(originals)
  const card=projected.find(m=>m.role==='toolResult'&&m.toolCallId==='call_0')!
  if(card.role!=='toolResult')throw new Error('Expected projected tool artifact')
  const ref=JSON.parse((card.content[0] as {text:string}).text).toolArtifact
  snapshotManager(session,manager);await store.save(session);store.close()
  const reopened=new SqliteSessionStore(file)
  try{
    const saved=(await reopened.get(session.id))!;expect(saved.messages).toEqual(originals)
    let text='',offset=0
    for(;;){const page=readToolArtifact(saved,{...ref,offsetBytes:offset,limitBytes:997});text+=page.text;if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes}
    expect(JSON.parse(text)).toEqual(originals[2]);expect(restoreManager(saved).buildSessionProjection().messages).toEqual(projected)
  }finally{reopened.close();await Promise.all(['','-wal','-shm'].map(suffix=>fs.rm(file+suffix,{force:true})))}
})

test('ordinary preparation applies retained-tool edits before actual delivery and protects the newest complete groups',async()=>{
  const store=new MemorySessionStore();let requests=0,effects=0
  const runtime=new PiRuntime({store,contextPolicy:{retainedToolBytes:22000},tools:[{name:'lookup',label:'Lookup',description:'Offline retained-context fixture',parameters:Type.Object({}),execute:async()=>{effects++;return {content:[{type:'text' as const,text:'Newest lookup'}],details:{}}}}],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    if(requests++===0){
      const old=context.messages.filter(m=>m.role==='toolResult').map(m=>JSON.stringify(m.content))
      expect(old.some(value=>value.includes('artifact_reference_only'))).toBe(true)
      expect(old.at(-1)).toContain('recent_exact_5')
      return answer(assistant([{type:'toolCall',id:'fresh',name:'lookup',arguments:{}}],'toolUse'))
    }
    expect(JSON.stringify(context.messages.at(-1))).toContain('Newest lookup')
    return answer(assistant([{type:'text',text:'Continue from exact newest lookup and archived sources.'}]))
  }})
  const session=await runtime.create();delete session.sdk
  session.messages=[{role:'user',content:'Human rules remain verbatim.',timestamp:1}]
  for(let index=0;index<6;index++)session.messages.push(assistant([{type:'toolCall',id:'old_'+index,name:'lookup',arguments:{}}],'toolUse'),{role:'toolResult',toolCallId:'old_'+index,toolName:'lookup',content:[{type:'text',text:'recent_exact_'+index+' '+ 'x'.repeat(8000)}],isError:false,timestamp:index+2})
  const originals=structuredClone(session.messages);await store.save(session)
  const result=await runtime.run(session.id,'Continue the investigation')
  expect(result.error).toBeUndefined();expect(result.status).toBe('completed');expect(effects).toBe(1);expect(requests).toBe(2)
  expect(result.session.messages.slice(0,originals.length)).toEqual(originals)
  expect(Object.values(result.session.modelRequests??{}).every(request=>request.delivery?.status==='completed'&&request.delivery.partialToolCallCount===0)).toBe(true)
  expect((await store.events(session.id)).some(event=>event.type==='retained_tool_context_projected')).toBe(true)
})

test('hidden archived tool details do not consume the retained model-context budget',async()=>{
  const runtime=new PiRuntime({store:new MemorySessionStore()}),session=await runtime.create()
  for(let index=0;index<4;index++){
    const result={role:'toolResult' as const,toolCallId:'metadata_'+index,toolName:'lookup',content:[{type:'text' as const,text:'Small visible result '+index}],isError:false,timestamp:index+1,details:{archived:'x'.repeat(100000)}}
    session.messages.push(assistant([{type:'toolCall',id:result.toolCallId,name:result.toolName,arguments:{}}],'toolUse'),result)
  }
  const originals=structuredClone(session.messages),manager=restoreManager(session)
  const proof=projectRetainedToolArtifacts(manager,session,2048)
  expect(proof.count).toBe(0);expect(proof.retainedBytesBefore).toBeLessThan(2048)
  expect(manager.buildSessionProjection().messages).toEqual(originals);expect(session.messages).toEqual(originals)
})

test('science retention keeps protected overflowing snapshots through runtime startup and publication',async()=>{
  const store=new MemorySessionStore(),visible='Current exact snapshot '+ 'x'.repeat(70000),deliveries:Array<{phase:string;projection:string;content:unknown}>=[]
  let requests=0
  const runtime=new PiRuntime({store,contextPolicy:{maxInputTokens:48000,keepRecentTokens:20000,retainedToolBytes:60000,retainLatestToolGroups:[['read_context','read_decision_memory'],['evaluate_trial']]},tools:[{
    name:'read_context',label:'Read current snapshot',description:'Offline latest snapshot fixture',parameters:Type.Object({}),
    execute:async()=>({content:[{type:'text' as const,text:visible}],details:{hidden:visible}}),
    onDelivery:value=>{deliveries.push({phase:value.phase,projection:value.projection,content:value.content})},
  }],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    const snapshot=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_context')!
    if(snapshot.role!=='toolResult')throw new Error('Current snapshot missing')
    expect(snapshot.content).toEqual([{type:'text',text:visible}])
    return answer(requests++===0?assistant([{type:'toolCall',id:'new_snapshot',name:'read_context',arguments:{}}],'toolUse'):assistant([{type:'text',text:'Both startup and freshly published snapshots were fully delivered.'}]))
  }})
  const session=await runtime.create();delete session.sdk
  const original={role:'toolResult' as const,toolCallId:'old_snapshot',toolName:'read_context',content:[{type:'text' as const,text:visible}],isError:false,timestamp:1,details:{hidden:visible}}
  session.messages=[assistant([{type:'toolCall',id:original.toolCallId,name:original.toolName,arguments:{}}],'toolUse'),original]
  await store.save(session)
  const result=await runtime.run(session.id,'Continue with the exact current snapshot')
  expect(result.error).toBeUndefined();expect(result.status).toBe('completed');expect(requests).toBe(2)
  expect(result.session.messages[1]).toEqual(original)
  expect(deliveries.some(value=>value.phase==='published'&&value.projection==='full')).toBe(true)
  expect(deliveries.filter(value=>value.phase==='inference'&&value.projection==='full').length).toBe(2)
  const archived=deliveries.filter(value=>value.phase==='inference'&&value.projection==='artifact_reference')
  expect(archived.length).toBe(1)
  expect(JSON.stringify(archived[0]!.content)).toContain('superseded_tool_snapshot')
  expect(JSON.stringify(archived[0]!.content)).toContain('old_snapshot')
})

const scopedRetention={maxInputTokens:48000,keepRecentTokens:20000,retainedToolBytes:60000,retainLatestToolGroups:[['read_context','read_decision_memory'],['evaluate_trial']]}
const oversizedInventory='reference/source/file.py\n'.repeat(9000)+'原始🧬\n'

test('newest oversized inventory is an exact card at startup and publication while current scientific snapshots stay full',async()=>{
  const store=new MemorySessionStore(),snapshot='Current full science snapshot '+ 's'.repeat(70000),deliveries:Array<{tool:string;phase:string;projection:string;content:unknown}>=[]
  let requests=0
  const runtime=new PiRuntime({store,contextPolicy:scopedRetention,tools:[
    {name:'list_files',label:'Files',description:'Offline bulk inventory',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:oversizedInventory}],details:{sameOriginal:oversizedInventory}}),onDelivery:value=>{deliveries.push({tool:'list_files',phase:value.phase,projection:value.projection,content:value.content})}},
    {name:'read_decision_memory',label:'Current memory',description:'Offline complete science snapshot',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:snapshot}],details:{hidden:snapshot}}),onDelivery:value=>{deliveries.push({tool:'read_decision_memory',phase:value.phase,projection:value.projection,content:value.content})}},
  ],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    const inventory=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='list_files')!
    const memory=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_decision_memory')!
    if(inventory.role!=='toolResult'||memory.role!=='toolResult')throw Error('Expected paired original results')
    expect(JSON.stringify(inventory.content)).toContain('artifact_reference_only')
    expect(JSON.stringify(inventory.content)).not.toContain('reference/source/file.py')
    expect(memory.content).toEqual([{type:'text',text:snapshot}])
    return answer(requests++===0?assistant([{type:'toolCall',id:'fresh_inventory',name:'list_files',arguments:{}},{type:'toolCall',id:'fresh_memory',name:'read_decision_memory',arguments:{}}],'toolUse'):assistant([{type:'text',text:'Proceed to authoring from exact memory and a bounded inventory reference.'}]))
  }})
  const session=await runtime.create();delete session.sdk
  session.messages=[assistant([{type:'toolCall',id:'old_inventory',name:'list_files',arguments:{}},{type:'toolCall',id:'old_memory',name:'read_decision_memory',arguments:{}}],'toolUse'),
    {role:'toolResult',toolCallId:'old_inventory',toolName:'list_files',content:[{type:'text',text:oversizedInventory}],details:{sameOriginal:oversizedInventory},isError:false,timestamp:1},
    {role:'toolResult',toolCallId:'old_memory',toolName:'read_decision_memory',content:[{type:'text',text:snapshot}],details:{hidden:snapshot},isError:false,timestamp:2}]
  const originals=structuredClone(session.messages);await store.save(session)
  const result=await runtime.run(session.id,'Draft using the verified current data')
  expect(result.status).toBe('completed');expect(result.error).toBeUndefined();expect(requests).toBe(2)
  expect(result.session.messages.slice(0,originals.length)).toEqual(originals)
  expect(Object.values(result.session.modelRequests??{}).every(request=>request.purpose==='turn')).toBe(true)
  expect(deliveries.some(value=>value.tool==='list_files'&&value.phase==='published'&&value.projection==='artifact_reference')).toBe(true)
  expect(deliveries.some(value=>value.tool==='list_files'&&value.phase==='inference'&&value.projection==='artifact_reference')).toBe(true)
  const memoryDeliveries=deliveries.filter(value=>value.tool==='read_decision_memory')
  expect(memoryDeliveries.filter(value=>value.phase==='inference'&&value.projection==='full').length).toBe(2)
  expect(memoryDeliveries.filter(value=>value.phase==='published').every(value=>value.projection==='full')).toBe(true)
  const archivedMemory=memoryDeliveries.filter(value=>value.projection==='artifact_reference')
  expect(archivedMemory.length).toBe(1)
  expect(JSON.stringify(archivedMemory[0]!.content)).toContain('superseded_tool_snapshot')
  expect(JSON.stringify(archivedMemory[0]!.content)).toContain('old_memory')
  const saved=(await store.get(session.id))!,projected=restoreManager(saved).buildSessionProjection().messages
  const card=projected.find(message=>message.role==='toolResult'&&message.toolCallId==='fresh_inventory')!
  if(card.role!=='toolResult')throw Error('Card absent')
  const ref=JSON.parse((card.content[0] as {text:string}).text).toolArtifact
  let exact='',offset=0
  for(;;){const page=readToolArtifact(saved,{...ref,offsetBytes:offset,limitBytes:7997});exact+=page.text;if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes}
  expect(JSON.parse(exact)).toEqual(saved.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='fresh_inventory'))
})

test('aggregate ordinary results in the newest multi-call group can be carded without dropping protocol pairing',async()=>{
  const runtime=new PiRuntime({store:new MemorySessionStore()}),session=await runtime.create()
  session.messages=[assistant([0,1,2].map(index=>({type:'toolCall' as const,id:'bulk_'+index,name:'lookup',arguments:{index}})),'toolUse')]
  for(let index=0;index<3;index++)session.messages.push({role:'toolResult',toolCallId:'bulk_'+index,toolName:'lookup',content:[{type:'text',text:'bulk_'+index+' '+ 'x'.repeat(25000)}],isError:false,timestamp:index+1})
  const originals=structuredClone(session.messages),manager=restoreManager(session)
  const proof=projectRetainedToolArtifacts(manager,session,60000)
  expect(proof.count).toBeGreaterThan(0);expect(proof.retainedBytesAfter).toBeLessThanOrEqual(60000);expect(proof.protectedOverflow).toBe(false)
  snapshotManager(session,manager)
  const projected=manager.buildSessionProjection().messages;validateContextProtocol(projected)
  expect(projected[0]).toEqual(originals[0]);expect(projected.length).toBe(originals.length);expect(session.messages).toEqual(originals)
  expect(projected.filter(message=>message.role==='toolResult').map(message=>message.toolCallId)).toEqual(['bulk_0','bulk_1','bulk_2'])
  const cards=projected.filter(message=>message.role==='toolResult')
  for(let index=0;index<cards.length;index++){
    const card=cards[index]!
    if(card.role!=='toolResult')throw Error('Expected result card')
    const originalResult=originals[index+1]
    if(originalResult?.role!=='toolResult')throw Error('Expected original result')
    if(JSON.stringify(card.content).includes('artifact_reference_only')){
      const ref=JSON.parse((card.content[0] as {text:string}).text).toolArtifact
      let exact='',offset=0
      for(;;){const page=readToolArtifact(session,{...ref,offsetBytes:offset,limitBytes:8000});exact+=page.text;if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes}
      expect(JSON.parse(exact)).toEqual(originalResult)
    }else expect(card).toEqual(originalResult)
  }
  expect(cards.some(card=>card.role==='toolResult'&&JSON.stringify(card.content).includes('artifact_reference_only'))).toBe(true)
})

test('bounded newest ordinary read and artifact page stay visible when irreducible cards overflow the soft budget',async()=>{
  const store=new MemorySessionStore(),snapshot='Current verified snapshot '+ 's'.repeat(13_000),archive='archive page source '+ 'a'.repeat(1200),freshSearch='Fresh targeted API result '+ 'f'.repeat(7_000),scoped={retainedToolBytes:60_000,retainLatestToolGroups:[['read_context','read_decision_memory'],['evaluate_trial']],maxInputTokens:48_000,keepRecentTokens:12_000}
  const runtime=new PiRuntime({store,contextPolicy:scoped,tools:[
    {name:'read_context',label:'Current context',description:'Offline floor fixture',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:snapshot}],details:{}})},
    {name:'search_files',label:'Targeted search',description:'Offline fresh search result',parameters:Type.Object({query:Type.String()}),execute:async()=>({content:[{type:'text' as const,text:freshSearch}],details:{}})},
  ],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    const page=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_tool_artifact')
    if(!page){
      const current=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_context')
      expect(current?.role).toBe('toolResult');expect(current?.content).toEqual([{type:'text',text:snapshot}])
      const archived=context.messages.find(message=>message.role==='toolResult'&&message.toolName==='search_files')
      expect(archived?.role).toBe('toolResult');expect(JSON.stringify(archived?.content)).toContain('artifact_reference_only')
      const ref=JSON.parse((archived!.content[0] as {text:string}).text).toolArtifact
      return answer(assistant([
        {type:'toolCall',id:'read_page',name:'read_tool_artifact',arguments:{...ref,offsetBytes:0,limitBytes:4000}},
        {type:'toolCall',id:'fresh_search',name:'search_files',arguments:{query:'API'}},
      ],'toolUse'))
    }
    expect(page.role).toBe('toolResult')
    expect(JSON.stringify(page.content)).toContain('archive page source')
    expect(JSON.stringify(page.content)).not.toContain('artifact_reference_only')
    const search=context.messages.findLast(message=>message.role==='toolResult'&&message.toolCallId==='fresh_search')
    expect(search?.role).toBe('toolResult');expect(search?.content).toEqual([{type:'text',text:freshSearch}])
    return answer(assistant([{type:'text',text:'The exact archive page, fresh search result, and current snapshot are available.'}]))
  }})
  const session=await runtime.create();delete session.sdk
  session.messages=[]
  for(let index=0;index<140;index++)session.messages.push(
    assistant([{type:'toolCall',id:'archive_'+index,name:'search_files',arguments:{query:index}}],'toolUse'),
    {role:'toolResult',toolCallId:'archive_'+index,toolName:'search_files',content:[{type:'text',text:'archive page source '+index+' '+archive}],isError:false,timestamp:index+1},
  )
  session.messages.push(assistant([{type:'toolCall',id:'current_context',name:'read_context',arguments:{}}],'toolUse'),
    {role:'toolResult',toolCallId:'current_context',toolName:'read_context',content:[{type:'text',text:snapshot}],isError:false,timestamp:200},
    assistant([{type:'toolCall',id:'current_evaluation',name:'evaluate_trial',arguments:{}}],'toolUse'),
    {role:'toolResult',toolCallId:'current_evaluation',toolName:'evaluate_trial',content:[{type:'text',text:snapshot}],isError:false,timestamp:201},
  )
  const originals=structuredClone(session.messages),manager=restoreManager(session),proof=projectRetainedToolArtifacts(manager,session,60_000,scoped.retainLatestToolGroups)
  expect(proof.protectedOverflow).toBe(true)
  const initial=manager.buildSessionProjection().messages,firstArchive=initial.find(message=>message.role==='toolResult'&&message.toolName==='search_files')
  if(firstArchive?.role!=='toolResult')throw Error('Expected an archived ordinary result')
  expect(JSON.stringify(firstArchive.content)).toContain('artifact_reference_only')
  const retainedContext=initial.findLast(message=>message.role==='toolResult'&&message.toolName==='read_context')
  if(retainedContext?.role!=='toolResult')throw Error('Expected the current context snapshot')
  expect(retainedContext.content).toEqual([{type:'text',text:snapshot}])
  expect(session.messages).toEqual(originals);snapshotManager(session,manager);await store.save(session)
  const result=await runtime.run(session.id,'Read one exact page from the archived file, then continue from the current context')
  expect(result.status).toBe('completed');expect(result.error).toBeUndefined()
  expect(Object.values(result.session.modelRequests??{}).every(request=>request.delivery?.status==='completed')).toBe(true)
})

test('bounded working set keeps three authoring pages across later lookups',async()=>{
  const store=new MemorySessionStore(),snapshot='Current verified snapshot '+ 's'.repeat(13_000),archive='API_SOURCE archive page source '+ 'a'.repeat(1500),pages={template:'TEMPLATE_SOURCE '+ 't'.repeat(5_000),schema:'SCHEMA_SOURCE '+ 's'.repeat(5_000)},policy={retainedToolBytes:60_000,retainLatestToolGroups:[['read_context']],maxInputTokens:48_000,keepRecentTokens:12_000}
  let requests=0
  const runtime=new PiRuntime({store,contextPolicy:policy,tools:[
    {name:'read_context',label:'Current context',description:'Offline floor fixture',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:snapshot}],details:{}})},
    {name:'search_files',label:'Targeted search',description:'Offline fresh search result',parameters:Type.Object({query:Type.String()}),execute:async(_id,input)=>({content:[{type:'text' as const,text:pages[(input as {query:'template'|'schema'}).query]}],details:{}})},
  ],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    const page=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_tool_artifact')
    const template=context.messages.findLast(message=>message.role==='toolResult'&&message.toolCallId==='template_search')
    const schema=context.messages.findLast(message=>message.role==='toolResult'&&message.toolCallId==='schema_search')
    if(requests++===0){
      const old=context.messages.find(message=>message.role==='toolResult'&&message.toolName==='search_files')
      expect(old?.role).toBe('toolResult');expect(JSON.stringify(old?.content)).toContain('artifact_reference_only')
      const ref=JSON.parse((old!.content[0] as {text:string}).text).toolArtifact
      const call={type:'toolCall' as const,id:'working_page',name:'read_tool_artifact',arguments:{...ref,offsetBytes:0,limitBytes:7000}}
      return answer(assistant([call],'toolUse'))
    }
    if(requests===2){
      if(page?.role!=='toolResult')throw Error(`The exact first archive page was not retained: ${JSON.stringify(context.messages.slice(-8))}`)
      expect(JSON.stringify(page.content)).toContain('archive page source')
      const current=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_context')
      if(current?.role!=='toolResult')throw Error('The current context snapshot was not retained')
      expect(current.content).toEqual([{type:'text',text:snapshot}])
      return answer(assistant([{type:'toolCall',id:'template_search',name:'search_files',arguments:{query:'template'}}],'toolUse'))
    }
    if(requests===3){
      if(page?.role!=='toolResult'||template?.role!=='toolResult')throw Error('API and template pages must remain available before the schema lookup')
      expect(JSON.stringify(page.content)).toContain('API_SOURCE')
      expect(template.content).toEqual([{type:'text',text:pages.template}])
      return answer(assistant([{type:'toolCall',id:'schema_search',name:'search_files',arguments:{query:'schema'}}],'toolUse'))
    }
    if(page?.role!=='toolResult'||template?.role!=='toolResult'||schema?.role!=='toolResult')throw Error('All three bounded authoring pages must remain available together')
    expect(JSON.stringify(page.content)).toContain('archive page source')
    expect(JSON.stringify(page.content)).toContain('API_SOURCE')
    expect(template.content).toEqual([{type:'text',text:pages.template}])
    expect(schema.content).toEqual([{type:'text',text:pages.schema}])
    return answer(assistant([{type:'text',text:'The authoring stub received API, template, and schema pages together.'}]))
  }})
  const session=await runtime.create();delete session.sdk
  session.messages=[]
  for(let index=0;index<70;index++)session.messages.push(
    assistant([{type:'toolCall',id:'archive_'+index,name:'search_files',arguments:{query:index}}],'toolUse'),
    {role:'toolResult',toolCallId:'archive_'+index,toolName:'search_files',content:[{type:'text',text:'archive page source '+index+' '+archive}],isError:false,timestamp:index+1},
  )
  session.messages.push(assistant([{type:'toolCall',id:'current_context',name:'read_context',arguments:{}}],'toolUse'),
    {role:'toolResult',toolCallId:'current_context',toolName:'read_context',content:[{type:'text',text:snapshot}],isError:false,timestamp:200},
  )
  const originals=structuredClone(session.messages),manager=restoreManager(session),proof=projectRetainedToolArtifacts(manager,session,60_000,policy.retainLatestToolGroups)
  expect(proof.protectedOverflow).toBe(true)
  expect(manager.buildSessionProjection().messages.find(message=>message.role==='toolResult'&&message.toolName==='search_files')?.role).toBe('toolResult')
  const firstArchive=manager.buildSessionProjection().messages.find(message=>message.role==='toolResult'&&message.toolName==='search_files')
  if(firstArchive?.role!=='toolResult')throw Error('Expected a compact archived history card')
  expect(JSON.stringify(firstArchive.content)).toContain('artifact_reference_only')
  expect(session.messages).toEqual(originals);snapshotManager(session,manager);await store.save(session)
  const result=await runtime.run(session.id,'Read the source page, run a follow-up lookup, and keep both results in working context')
  if(result.status!=='completed')throw Error(`Working-set fixture failed: ${result.error??result.status}`)
  expect(result.status).toBe('completed');expect(result.error).toBeUndefined();expect(requests).toBe(4)
  expect(Object.values(result.session.modelRequests??{}).every(request=>request.delivery?.status==='completed')).toBe(true)
})

test('a large current scientific snapshot does not crowd out a small ordinary result in the same complete group',async()=>{
  const store=new MemorySessionStore(),science='Current scientific evidence '+ 'e'.repeat(65_000),fresh='Fresh targeted API result '+ 'f'.repeat(6_000),oldScience='Superseded scientific evidence '+ 'o'.repeat(65_000),policy={retainedToolBytes:60_000,retainLatestToolGroups:[['read_context']],maxInputTokens:48_000,keepRecentTokens:12_000}
  const runtime=new PiRuntime({store,contextPolicy:policy,tools:[
    {name:'read_context',label:'Current context',description:'Offline science snapshot',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:science}],details:{}})},
    {name:'search_files',label:'Targeted search',description:'Offline targeted result',parameters:Type.Object({query:Type.String()}),execute:async()=>({content:[{type:'text' as const,text:fresh}],details:{}})},
  ],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    const current=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='read_context')
    const targeted=context.messages.findLast(message=>message.role==='toolResult'&&message.toolName==='search_files')
    if(current?.role!=='toolResult'||targeted?.role!=='toolResult')throw Error('Current science and ordinary result must both be present')
    expect(current.content).toEqual([{type:'text',text:science}])
    expect(targeted.content).toEqual([{type:'text',text:fresh}])
    const earlierScience=context.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='old_science')
    expect(earlierScience?.role).toBe('toolResult');expect(JSON.stringify(earlierScience?.content)).toContain('artifact_reference_only')
    return answer(assistant([{type:'text',text:'Current science and the fresh API result are available together.'}]))
  }})
  const session=await runtime.create();delete session.sdk
  session.messages=[]
  for(let index=0;index<25;index++)session.messages.push(
    assistant([{type:'toolCall',id:'archive_'+index,name:'search_files',arguments:{query:index}}],'toolUse'),
    {role:'toolResult',toolCallId:'archive_'+index,toolName:'search_files',content:[{type:'text',text:'Old archive '+index+' '+ 'a'.repeat(1200)}],isError:false,timestamp:index+1},
  )
  session.messages.push(assistant([{type:'toolCall',id:'old_science',name:'read_context',arguments:{}}],'toolUse'),
    {role:'toolResult',toolCallId:'old_science',toolName:'read_context',content:[{type:'text',text:oldScience}],isError:false,timestamp:150},
    {...assistant([{type:'toolCall',id:'current_science',name:'read_context',arguments:{}},{type:'toolCall',id:'fresh_api',name:'search_files',arguments:{query:'API'}}],'toolUse'),content:[{type:'thinking',thinking:'Large assistant reasoning is outside the retained-result budget. '.repeat(1200)},{type:'toolCall',id:'current_science',name:'read_context',arguments:{}},{type:'toolCall',id:'fresh_api',name:'search_files',arguments:{query:'API'}}]},
    {role:'toolResult',toolCallId:'current_science',toolName:'read_context',content:[{type:'text',text:science}],isError:false,timestamp:151},
    {role:'toolResult',toolCallId:'fresh_api',toolName:'search_files',content:[{type:'text',text:fresh}],isError:false,timestamp:152},
  )
  const originals=structuredClone(session.messages),manager=restoreManager(session),proof=projectRetainedToolArtifacts(manager,session,60_000,policy.retainLatestToolGroups)
  expect(proof.protectedOverflow).toBe(true)
  const projected=manager.buildSessionProjection().messages
  expect(projected.find(message=>message.role==='toolResult'&&message.toolCallId==='old_science')?.role).toBe('toolResult')
  const old=projected.find(message=>message.role==='toolResult'&&message.toolCallId==='old_science')
  const current=projected.find(message=>message.role==='toolResult'&&message.toolCallId==='current_science')
  const targeted=projected.find(message=>message.role==='toolResult'&&message.toolCallId==='fresh_api')
  if(old?.role!=='toolResult'||current?.role!=='toolResult'||targeted?.role!=='toolResult')throw Error('Expected all paired scientific and ordinary results')
  expect(JSON.stringify(old.content)).toContain('artifact_reference_only')
  expect(current.content).toEqual([{type:'text',text:science}]);expect(targeted.content).toEqual([{type:'text',text:fresh}])
  expect(session.messages).toEqual(originals);snapshotManager(session,manager);await store.save(session)
  const result=await runtime.run(session.id,'Use the verified current science and fresh API result')
  if(result.status!=='completed')throw Error(`Mixed science fixture failed: ${result.error??result.status}`)
  expect(result.status).toBe('completed');expect(result.error).toBeUndefined()
})

test('ordinary inference budgets a newly published multi-call bulk group without semantic summaries',async()=>{
  const store=new MemorySessionStore();let requests=0
  const runtime=new PiRuntime({store,contextPolicy:scopedRetention,tools:[{name:'lookup',label:'Lookup',description:'Offline medium bulk result',parameters:Type.Object({index:Type.Integer()}),execute:async(_id,input)=>({content:[{type:'text' as const,text:'bulk_'+(input as {index:number}).index+' '+ 'x'.repeat(25000)}],details:{}})}],streamFn:(_model,context)=>{
    validateContextProtocol(context.messages)
    if(requests++===0)return answer(assistant([0,1,2].map(index=>({type:'toolCall' as const,id:'fresh_bulk_'+index,name:'lookup',arguments:{index}})),'toolUse'))
    const results=context.messages.filter(message=>message.role==='toolResult')
    expect(results.length).toBe(3);expect(results.some(message=>JSON.stringify(message.content).includes('artifact_reference_only'))).toBe(true)
    expect(results.reduce((sum,message)=>sum+toolProjectionBytes(message),0)).toBeLessThanOrEqual(60000)
    return answer(assistant([{type:'text',text:'Paired bulk references fit; continue authoring.'}]))
  }})
  const session=await runtime.create(),result=await runtime.run(session.id,'Read three independent references then continue')
  expect(result.status).toBe('completed');expect(result.error).toBeUndefined();expect(requests).toBe(2)
  expect(Object.values(result.session.modelRequests??{}).every(request=>request.purpose==='turn')).toBe(true)
})
