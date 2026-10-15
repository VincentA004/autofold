import {expect,test} from 'bun:test'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {Type} from 'typebox'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
import type {RuntimeToolDelivery,RuntimeTool} from './types'

const assistant=(content:AssistantMessage['content'],stopReason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,stopReason,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}})
function answer(message:AssistantMessage){const stream=createAssistantMessageEventStream();if(message.stopReason==='error'||message.stopReason==='aborted')stream.push({type:'error',reason:message.stopReason,error:message});else stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end(message);return stream}
const call=(id:string)=>({type:'toolCall' as const,id,name:'memory',arguments:{kind:id}})

test('settled ordinary delivery identifies exact request, source position and call without changing model input',async()=>{
 const store=new MemorySessionStore(),deliveries:RuntimeToolDelivery[]=[],contexts=new Map<string,any[]>();let requests=0,sessionId=''
 const memory:RuntimeTool={name:'memory',label:'Memory',description:'Offline ordering fixture',parameters:Type.Object({kind:Type.String()}),executionMode:'sequential',
  execute:async(_id,args)=>({content:[{type:'text',text:JSON.stringify({kind:(args as any).kind})}],details:{hidden:'Never exposure'}}),
  onDelivery:async delivery=>{
   deliveries.push(structuredClone(delivery))
   if(delivery.phase==='inference'){
    const source=delivery.inference!,session=await store.get(sessionId)
    expect(source).toBeDefined();expect(session!.modelRequests![source.requestId]!.status).toBe('settled')
    expect(contexts.get(source.requestId)![source.position]).toMatchObject({role:'toolResult',toolCallId:source.toolCallId,content:delivery.content})
   }
  }}
 const runtime=new PiRuntime({store,tools:[memory],onInferenceContext:context=>{contexts.set(context.requestId,structuredClone(context.messages))},
  streamFn:(_model,context)=>{expect(JSON.stringify(context.messages)).not.toContain('"inference":');return answer(requests++===0?assistant([call('older-gap'),call('newer-full')],'toolUse'):assistant([{type:'text',text:'Continue with the newer full packet.'}]))}})
 sessionId=(await runtime.create()).id
 const result=await runtime.run(sessionId,'Observe exact source order')
 expect(result.status).toBe('completed')
 const published=deliveries.filter(delivery=>delivery.phase==='published'),ordinary=deliveries.filter(delivery=>delivery.phase==='inference')
 expect(published).toHaveLength(2);expect(published.every(delivery=>delivery.inference===undefined)).toBe(true)
 expect(ordinary).toHaveLength(2)
 expect(ordinary.map(delivery=>delivery.inference!.toolCallId)).toEqual(['older-gap','newer-full'])
 expect(ordinary[0]!.inference!.requestId).toBe(ordinary[1]!.inference!.requestId)
 expect(ordinary[1]!.inference!.position).toBeGreaterThan(ordinary[0]!.inference!.position)
 expect(ordinary.every(delivery=>delivery.details===undefined&&delivery.projection==='full')).toBe(true)
 expect(result.session.messages.filter(message=>message.role==='toolResult').every(message=>!Object.hasOwn(message,'inference'))).toBe(true)
})

test('failed or aborted ordinary responses never emit inference delivery provenance',async()=>{
 for(const stopReason of ['error','aborted'] as const){
  const deliveries:RuntimeToolDelivery[]=[];let requests=0
  const memory:RuntimeTool={name:'memory',label:'Memory',description:'Offline failure fixture',parameters:Type.Object({kind:Type.String()}),executionMode:'sequential',execute:async()=>({content:[{type:'text',text:'Original full packet'}],details:{}}),onDelivery:delivery=>{deliveries.push(delivery)}}
  const runtime=new PiRuntime({store:new MemorySessionStore(),tools:[memory],streamFn:()=>answer(requests++===0?assistant([call('full')],'toolUse'):{...assistant([],stopReason),errorMessage:'Original response failed'})})
  const result=await runtime.run((await runtime.create()).id,'Observe delivery boundary')
  expect(result.status).not.toBe('completed');expect(deliveries).toHaveLength(1)
  expect(deliveries[0]).toMatchObject({phase:'published'});expect(deliveries[0]!.inference).toBeUndefined()
 }
})
