import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import {Database} from 'bun:sqlite'
import {createModels} from '@earendil-works/pi-ai/models'
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter'
import {PiRuntime,SqliteSessionStore,MemorySessionStore,DEFAULT_MODEL,PiLocalPayloadAdmissionRejected,assertSessionAccountingComplete} from './index'

const reject=()=>new PiLocalPayloadAdmissionRejected('Published-price reservation exceeds remaining inference budget')
const fetchCounter=()=>{
 let calls=0
 return {calls:()=>calls,fetch:Object.assign(async()=>{calls++;throw reject()},{preconnect:()=>{}}) as typeof fetch}
}

test('native payload admission rejection records no dispatch or bill and survives SQLite reopen without effects',async()=>{
 const file='/private/tmp/autofold-local-payload-'+crypto.randomUUID()+'.sqlite',store=new SqliteSessionStore(file),transport=fetchCounter()
 let payloads=0,deliveries=0
 try{
  const runtime=new PiRuntime({store,getApiKey:()=> 'offline-secret',onInferenceContext:()=>{deliveries++},streamOptions:{fetch:transport.fetch,onPayload:()=>{payloads++;throw reject()}}})
  const id=(await runtime.create()).id,result=await runtime.run(id,'Keep the approved inference ceiling')
  expect(result.status).toBe('failed');expect(result.error).toContain('remaining inference budget')
  expect(payloads).toBe(1);expect(transport.calls()).toBe(0);expect(deliveries).toBe(0)
  expect(result.session.usage).toEqual({turns:0,toolCalls:0,costUsd:0});expect(result.session.pendingTools).toEqual({})
  expect(result.session.contextCompactions).toBeUndefined()
  const requests=Object.values(result.session.modelRequests!);expect(requests).toHaveLength(1)
  expect(requests[0]!.status).toBe('not_dispatched');expect(requests[0]!.providerBilling).toBeUndefined()
  expect(requests[0]!.reportedCostUsd).toBeUndefined();expect(requests[0]!.estimatedCostUsd).toBeUndefined()
  expect(()=>assertSessionAccountingComplete(result.session)).not.toThrow()
  const originalEvents=await store.events(id)
  expect(originalEvents.filter(event=>event.type==='model_request_not_dispatched')).toHaveLength(1)
  expect(originalEvents.some(event=>event.type==='provider_billing_observed')).toBe(false)
  store.close()
  const reopened=new SqliteSessionStore(file)
  try{
   const verifier=new PiRuntime({store:reopened,getApiKey:()=>{throw Error('Read-only reopen cannot infer')},streamOptions:{fetch:transport.fetch}})
   const loaded=await verifier.get(id)
   expect(loaded).toEqual(result.session);expect(await reopened.events(id)).toEqual(originalEvents)
   expect(()=>assertSessionAccountingComplete(loaded!)).not.toThrow()
   const db=new Database(file,{readonly:true})
   try{expect(db.query('SELECT session_id FROM pi_leases').all()).toHaveLength(0)}finally{db.close()}
   expect(payloads).toBe(1);expect(transport.calls()).toBe(0)
  }finally{reopened.close()}
 }finally{store.close();await Promise.all(['','-wal','-shm'].map(suffix=>fs.rm(file+suffix,{force:true})))}
})

test('generic payload exceptions and typed transport exceptions retain unknown billing',async()=>{
 for(const mode of ['generic_observer','transport'] as const){
  const transport=fetchCounter();let payloads=0
  const runtime=new PiRuntime({store:new MemorySessionStore(),getApiKey:()=> 'offline-secret',streamOptions:{fetch:transport.fetch,onPayload:()=>{payloads++;if(mode==='generic_observer')throw Error('Unexpected observer failure')}}})
  const result=await runtime.run((await runtime.create()).id,'Inspect only the original request')
  expect(result.status).toBe('failed');expect(payloads).toBe(1);expect(transport.calls()).toBe(mode==='transport'?1:0)
  const request=Object.values(result.session.modelRequests!)[0]!
  expect(request.status).toBe('unknown');expect(request.providerBilling?.status).toBe('unknown')
  expect(()=>assertSessionAccountingComplete(result.session)).toThrow('unresolved usage')
 }
})

test('a custom stream cannot assert zero dispatch by invoking the native payload admission callback',async()=>{
 let streams=0,payloads=0
 const runtime=new PiRuntime({store:new MemorySessionStore(),getApiKey:()=> 'offline-secret',streamOptions:{onPayload:()=>{payloads++;throw reject()}},
  streamFn:async(model,_context,options)=>{streams++;await options!.onPayload!({model:model.id,messages:[{role:'user',content:'Original'}],max_tokens:model.maxTokens},model);throw Error('Callback must reject')}})
 const result=await runtime.run((await runtime.create()).id,'Custom transport has no pre-dispatch guarantee')
 expect(result.status).toBe('failed');expect(streams).toBe(1);expect(payloads).toBe(1)
 expect(Object.values(result.session.modelRequests!)[0]!.status).toBe('unknown')
 expect(()=>assertSessionAccountingComplete(result.session)).toThrow('unresolved usage')
})

test('proven native admission remains undispatched if SDK event delivery throws before usage settlement',async()=>{
 const models=createModels(),nativeStream=models.streamSimple.bind(models),transport=fetchCounter();let payloads=0
 const provider=openrouterProvider();models.setProvider({...provider,getModels:()=>[DEFAULT_MODEL]})
 models.streamSimple=(model,context,options)=>{
  const input=nativeStream(model,context,options)
  return new Proxy(input,{get(target,key){
   if(key===Symbol.asyncIterator)return async function*(){for await(const event of target){if(event.type==='error')throw Error('SDK delivery interrupted after local rejection');yield event}}
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
 }
 const runtime=new PiRuntime({store:new MemorySessionStore(),models,modelSelection:{provider:DEFAULT_MODEL.provider,modelId:DEFAULT_MODEL.id,model:DEFAULT_MODEL},getApiKey:()=> 'offline-secret',
  streamOptions:{fetch:transport.fetch,onPayload:()=>{payloads++;throw reject()}}})
 const result=await runtime.run((await runtime.create()).id,'Preserve the proven pre-transport outcome')
 expect(result.status).toBe('failed');expect(result.error).toContain('SDK delivery interrupted');expect(payloads).toBe(1);expect(transport.calls()).toBe(0)
 const request=Object.values(result.session.modelRequests!)[0]!
 expect(request.status).toBe('not_dispatched');expect(request.providerBilling).toBeUndefined();expect(request.reportedCostUsd).toBeUndefined()
 expect(result.session.usage.turns).toBe(0);expect(result.session.usage.costUsd).toBe(0)
 expect(()=>assertSessionAccountingComplete(result.session)).not.toThrow()
})
