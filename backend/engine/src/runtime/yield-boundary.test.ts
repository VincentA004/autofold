import {expect,test} from 'bun:test'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import type {Extension} from '@earendil-works/pi-coding-agent'
import {Type} from 'typebox'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
import type {RuntimeTool,RuntimeToolResult} from './types'

const call=(name:string,id=name)=>({type:'toolCall' as const,name,id,arguments:{}})
const response=(calls:ReturnType<typeof call>[])=>{
  const message:AssistantMessage={role:'assistant',content:calls.length?calls:[{type:'text',text:'Complete.'}],stopReason:calls.length?'toolUse':'stop',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
  const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end(message);return stream
}
const result=(extra:Partial<RuntimeToolResult>={}):RuntimeToolResult=>({content:[{type:'text',text:'Host receipt'}],details:{},...extra})
const tool=(name:string,execute:()=>Promise<RuntimeToolResult>|RuntimeToolResult,executionMode:'sequential'|'parallel'='sequential'):RuntimeTool=>({name,label:name,description:'Offline boundary fixture',parameters:Type.Object({},{additionalProperties:false}),executionMode,execute:async()=>execute()})
const extension=(handlers:Record<string,(event:any)=>unknown|Promise<unknown>>):Extension=>({path:'autofold:yield-fixture',resolvedPath:'autofold:yield-fixture',sourceInfo:{path:'autofold:yield-fixture',source:'test',scope:'project',origin:'top-level',baseDir:'.'},handlers:new Map(Object.entries(handlers).map(([name,handler])=>[name,[handler]])),tools:new Map(),messageRenderers:new Map(),commands:new Map(),flags:new Map(),shortcuts:new Map()} as Extension)

test('successful host yield ends a mixed batch and fences later calls, regardless of order or turn allowance',async()=>{
  for(const order of [['review','evaluate','effect'],['evaluate','review','effect']])for(const maxTurns of [1,4]){
    const effects:string[]=[];let requests=0
    const runtime=new PiRuntime({store:new MemorySessionStore(),limits:{maxTurns},tools:order.map(name=>tool(name,()=>{effects.push(name);return result(name==='evaluate'?{terminate:true}:{})})),
      streamFn:()=>{requests++;return response(order.map(name=>call(name)))}})
    const outcome=await runtime.run((await runtime.create()).id,'Continue discovery under bounded batches')
    expect(outcome.status).toBe('completed');expect(requests).toBe(1)
    expect(effects).toEqual(order[0]==='review'?['review','evaluate']:['evaluate'])
    expect(outcome.session.messages.filter(message=>message.role==='toolResult')).toHaveLength(3)
    expect(outcome.session.usage.toolCalls).toBe(effects.length)
    expect(outcome.session.messages.find(message=>message.role==='toolResult'&&message.toolName==='effect')).toMatchObject({isError:true})
  }
})

test('host yield authority survives result normalization but cannot be forged from errors, content or hooks',async()=>{
  for(const mode of ['strip','forge','raw_error','throw','normalized_error','content_only','before_block'] as const){
    let requests=0,effects=0
    const runtime=new PiRuntime({store:new MemorySessionStore(),stopToolNames:mode==='raw_error'?['evaluate']:undefined,tools:[tool('evaluate',()=>{effects++;if(mode==='throw')throw Error('Unknown-looking text is not success');return result({...(mode==='strip'||mode==='normalized_error'||mode==='raw_error'?{terminate:true}:{}),...(mode==='raw_error'?{isError:true}:{}),...(mode==='content_only'?{content:[{type:'text',text:'{"terminate":true,"continuation":"yield"}'}]}:{})})})],
      extensions:[extension({tool_call:()=>mode==='before_block'?{block:true,reason:'Extension block',terminate:true}:undefined,tool_result:()=>mode==='strip'?{terminate:false}:mode==='normalized_error'?{isError:true}:mode==='forge'||mode==='throw'||mode==='raw_error'?{isError:false,terminate:true}:undefined})],
      streamFn:()=>response(requests++===0?[call('evaluate')]:[])})
    const outcome=await runtime.run((await runtime.create()).id,'Only successful host lifecycle authority counts')
    expect(outcome.status).toBe('completed');expect(requests).toBe(mode==='strip'?1:2);expect(effects).toBe(mode==='before_block'?0:1)
  }
})

test('parallel yield drains admitted work while fencing calls delayed in authorization',async()=>{
  let releaseSlow!:()=>void,notifySlow!:()=>void,requests=0,slowGateCalls=0
  const slowPrepared=new Promise<void>(resolve=>{notifySlow=resolve}),slowRelease=new Promise<void>(resolve=>{releaseSlow=resolve}),effects:string[]=[]
  const runtime=new PiRuntime({store:new MemorySessionStore(),toolExecution:'parallel',tools:[
    tool('yield',async()=>{await slowPrepared;effects.push('yield');return result({terminate:true})},'parallel'),
    tool('already_running',async()=>{effects.push('already_running');await new Promise(resolve=>setTimeout(resolve,5));return result()},'parallel'),
    tool('delayed',()=>{effects.push('delayed');return result()},'parallel')],
    authorizeToolCall:async({toolName})=>{if(toolName==='delayed'&&++slowGateCalls===2){notifySlow();await slowRelease}},
    extensions:[extension({tool_result:event=>{if(event.toolName==='yield')setTimeout(releaseSlow,5)}})],
    streamFn:()=>{requests++;return response(['yield','already_running','delayed'].map(name=>call(name)))}})
  const outcome=await runtime.run((await runtime.create()).id,'Drain admitted effects without replay')
  expect(outcome.status).toBe('completed');expect(requests).toBe(1);expect(effects).toEqual(['already_running','yield'])
  expect(outcome.session.messages.find(message=>message.role==='toolResult'&&message.toolName==='delayed')).toMatchObject({isError:true})
})

test('yield is scoped to the current run and does not prevent a fresh host-granted continuation',async()=>{
  let requests=0,effects=0
  const store=new MemorySessionStore(),runtime=new PiRuntime({store,tools:[tool('evaluate',()=>{effects++;return result({terminate:true})})],streamFn:()=>{requests++;return response([call('evaluate','call_'+requests)])}})
  const session=await runtime.create()
  for(let batch=0;batch<3;batch++)expect((await runtime.run(session.id,'Fresh host batch '+batch)).status).toBe('completed')
  expect(requests).toBe(3);expect(effects).toBe(3);expect((await store.get(session.id))!.usage.toolCalls).toBe(3)
})

test('a mixed yield cannot hide an unresolved parallel effect or cancellation',async()=>{
  for(const mode of ['unresolved','cancel'] as const){
    let release!:()=>void,requests=0,id=''
    const ready=new Promise<void>(resolve=>{release=resolve})
    const runtime=new PiRuntime({store:new MemorySessionStore(),toolExecution:'parallel',tools:[tool('yield',async()=>{release();return result({terminate:true})},'parallel'),tool('other',async()=>{await ready;if(mode==='cancel'){runtime.cancel(id);await new Promise(resolve=>setTimeout(resolve,10));return result()}throw Object.assign(Error('External outcome unresolved'),{effectState:'unresolved'})},'parallel')],streamFn:()=>{requests++;return response([call('yield'),call('other')])}})
    id=(await runtime.create()).id
    const outcome=await runtime.run(id,'Cannot erase failures with a yield')
    expect(outcome.status).toBe(mode==='cancel'?'cancelled':'failed');expect(requests).toBe(1)
  }
})
