import {test,expect,spyOn} from 'bun:test'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from './index'
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
function answer(cost=.5):AssistantMessage{return {role:'assistant',content:[{type:'text',text:'Offline completion'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}}}}
function stream(message=answer()){const value=createAssistantMessageEventStream();value.push({type:'done',reason:'stop',message});value.end(message);return value}
test('whole-run duration cancels ignored resource setup and late completion cannot dispatch or write',async()=>{
 const store=new MemorySessionStore();let calls=0,signal:AbortSignal|undefined
 const runtime=new PiRuntime({store,limits:{maxDurationMs:30},resources:async s=>{signal=s;await wait(160);return {cwd:'.',skills:[]}},streamFn:()=>{calls++;return stream()}})
 const s=await runtime.create(),start=performance.now();const result=await runtime.run(s.id,'Bounded setup');expect(result.status).toBe('limit_reached');expect(performance.now()-start).toBeLessThan(140);expect(signal?.aborted).toBe(true);expect(calls).toBe(0);const settled=await store.get(s.id);await wait(180);expect(await store.get(s.id)).toEqual(settled);expect(calls).toBe(0)
})
test('human cancellation settles a noncooperating setup before any request or tool admission',async()=>{
 const store=new MemorySessionStore();let ready!:()=>void;const started=new Promise<void>(r=>ready=r);let calls=0
 const runtime=new PiRuntime({store,resources:()=>{ready();return new Promise(()=>{})},streamFn:()=>{calls++;return stream()}})
 const s=await runtime.create();const pending=runtime.run(s.id,'Cancelled setup');await started;runtime.cancel(s.id);expect((await pending).status).toBe('cancelled');expect(calls).toBe(0);expect((await store.get(s.id))!.modelRequests).toEqual({})
})
test('supported raw observer stores actual bill and routed identity separately from SDK estimate, without raw payloads',async()=>{
 const store=new MemorySessionStore();let callbacks=0
 const runtime=new PiRuntime({store,requireProviderReportedUsage:true,streamOptions:{onProviderStreamEvent:()=>{callbacks++}},streamFn:async (m,_c,o)=>{
  expect(o?.maxRetries).toBe(0);await o!.onProviderStreamEvent!({id:'gen_original',provider:'routed_original',usage:{cost:.125},choices:[{finish_reason:'stop'}],prompt:'must never persist',api_key:'must never persist'},m);return stream()
 }})
 const result=await runtime.run((await runtime.create()).id,'Known bill');expect(result.status).toBe('completed');const request=Object.values(result.session.modelRequests!)[0]!
 expect(request.costKind).toBe('sdk_estimate');expect(request.estimatedCostUsd).toBe(.5);expect(result.session.usage.costUsd).toBe(.5);expect(request.providerBilling).toMatchObject({reportedCostUsd:.125,status:'reported',routedProvider:'routed_original',upstreamRequestId:'gen_original'});expect(callbacks).toBe(1);expect(JSON.stringify(await store.events(result.sessionId))).not.toContain('must never persist')
})
test('strict missing actual bill holds original request; receipt settlement never double-charges its known estimate',async()=>{
 const store=new MemorySessionStore();const runtime=new PiRuntime({store,requireProviderReportedUsage:true,streamFn:()=>stream()});const result=await runtime.run((await runtime.create()).id,'Unknown bill')
 expect(result.status).toBe('failed');const [requestId,request]=Object.entries(result.session.modelRequests!)[0]!;expect(request.status).toBe('unknown');expect(request.providerBilling!.reportedCostUsd).toBeNull();expect(result.session.usage.costUsd).toBe(.5)
 const settled=await runtime.reconcileModelUsage(result.sessionId,requestId,async()=>({sessionId:result.sessionId,requestId,model:request.model,startedAt:request.startedAt,terminal:'completed',costUsd:.125,receiptId:'rcp_original',sha256:'sha256:'+'a'.repeat(64),upstreamRequestId:'gen_original',source:'verified_offline_fixture'}));expect(settled.usage.costUsd).toBe(.5);expect(settled.modelRequests![requestId]!.estimatedCostUsd).toBe(.5);expect(settled.modelRequests![requestId]!.providerBilling!.reportedCostUsd).toBe(.125);expect(settled.status).toBe('failed')
})
test('reported ceiling applies independently and a genuine zero bill stays known',async()=>{
 for(const cost of [0,.2]){const store=new MemorySessionStore();const rt=new PiRuntime({store,requireProviderReportedUsage:true,limits:{maxCostUsd:.1},streamFn:async(m,_c,o)=>{await o!.onProviderStreamEvent!({id:'gen_'+cost,provider:'offline',usage:{cost},choices:[{finish_reason:'stop'}]},m);return stream(answer(.01))}});const r=await rt.run((await rt.create()).id,'Bounded bill');expect(r.status).toBe(cost===0?'completed':'limit_reached');expect(Object.values(r.session.modelRequests!)[0]!.providerBilling!.reportedCostUsd).toBe(cost)}
})

test('lease renewal loss aborts hung setup promptly and late resources cannot mutate or dispatch',async()=>{
 const store=new MemorySessionStore();let ready!:()=>void;const started=new Promise<void>(r=>ready=r);let signal:AbortSignal|undefined,calls=0
 const runtime=new PiRuntime({store,leaseDurationMs:300,leaseHeartbeatMs:20,limits:{maxDurationMs:1000},resources:async s=>{signal=s;ready();await wait(200);return {cwd:'.',skills:[]}},streamFn:()=>{calls++;return stream()}})
 const initial=await runtime.create();store.renewLease=async()=>false
 const start=performance.now();const pending=runtime.run(initial.id,'Lost setup lease');await started;const result=await pending
 expect(result.status).toBe('failed');expect(result.error).toContain('lease was lost');expect(performance.now()-start).toBeLessThan(180);expect(signal?.aborted).toBe(true)
 const closed=await store.get(initial.id);await wait(230);expect(await store.get(initial.id)).toEqual(closed);expect(calls).toBe(0)
})
test('late provider callback after request timeout and during a new run cannot change original accounting',async()=>{
 const store=new MemorySessionStore();let late:any;let calls=0,ready!:()=>void;const secondStarted=new Promise<void>(r=>ready=r)
 const runtime=new PiRuntime({store,modelRequestTimeoutMs:40,streamFn:async(_m,_c,o)=>{calls++;if(calls===1){late=o!.onProviderStreamEvent;return new Promise(()=>{})}ready();await wait(20);return stream()}})
 const initial=await runtime.create();const first=await runtime.run(initial.id,'Timeout original');expect(first.status).toBe('failed');const original=await store.get(initial.id)
 await late({id:'gen_late',provider:'late',usage:{cost:9}},DEFAULT_MODEL);expect(await store.get(initial.id)).toEqual(original)
 const [requestId,request]=Object.entries(first.session.modelRequests!)[0]!
 await runtime.reconcileModelUsage(initial.id,requestId,async()=>({sessionId:initial.id,requestId,model:request.model,startedAt:request.startedAt,terminal:'completed',costUsd:0,receiptId:'rcp_timeout',sha256:'sha256:'+'b'.repeat(64),upstreamRequestId:'gen_timeout',source:'verified_offline_fixture'}))
 const second=runtime.run(initial.id,'Second owner');await secondStarted;const before=await store.get(initial.id);await late({id:'gen_other_owner',provider:'late',usage:{cost:8}},DEFAULT_MODEL);expect(await store.get(initial.id)).toEqual(before);expect((await second).status).toBe('completed')
})
test('noncooperating event observer cannot hold the durable run past its deadline',async()=>{
 const store=new MemorySessionStore();let calls=0;const runtime=new PiRuntime({store,limits:{maxDurationMs:35},streamFn:()=>{calls++;return stream()}})
 const initial=await runtime.create(),start=performance.now();const result=await runtime.run(initial.id,'Bounded observer',{onEvent:()=>new Promise(()=>{})})
 expect(result.status).toBe('limit_reached');expect(performance.now()-start).toBeLessThan(180);expect(calls).toBe(0);expect((await store.get(initial.id))!.status).toBe('limit_reached')
})

test('reported per-run ceiling excludes earlier original requests even when timestamps coincide',async()=>{
 const clock=spyOn(Date,'now').mockReturnValue(Date.now());const store=new MemorySessionStore();let calls=0
 try {
  const runtime=new PiRuntime({store,requireProviderReportedUsage:true,limits:{maxCostUsd:.1},streamFn:async(m,_c,o)=>{const index=++calls;await o!.onProviderStreamEvent!({id:'gen_same_clock_'+index,provider:'offline',usage:{cost:index===1?.08:.03},choices:[{finish_reason:'stop'}]},m);return stream(answer(.01))}})
  const initial=await runtime.create();expect((await runtime.run(initial.id,'First original interval')).status).toBe('completed');const second=await runtime.run(initial.id,'Second original interval');expect(second.status).toBe('completed');expect(second.session.usage.costUsd).toBe(.02);expect(calls).toBe(2)
 }finally{clock.mockRestore()}
})

test('receipt-only usage recovery preserves a known original upstream identity before any accounting mutation',async()=>{
 const store=new MemorySessionStore(),runtime=new PiRuntime({store,streamFn:()=>stream()});const initial=await runtime.create()
 initial.status='failed';initial.modelRequests!.req_original={status:'unknown',model:initial.modelSelection,purpose:'turn',startedAt:1,providerBilling:{source:'openrouter_stream',status:'unknown',reportedCostUsd:null,upstreamRequestId:'gen_original'}};await store.save(initial)
 const original=await store.get(initial.id);const receipt=(upstreamRequestId:string)=>({sessionId:initial.id,requestId:'req_original',model:initial.modelSelection,startedAt:1,terminal:'completed' as const,costUsd:.1,receiptId:'rcp_identity',sha256:'sha256:'+'c'.repeat(64),upstreamRequestId,source:'verified_offline_fixture'})
 await expect(runtime.reconcileModelUsage(initial.id,'req_original',async()=>receipt('gen_replacement'))).rejects.toThrow('known original upstream request');expect(await store.get(initial.id)).toEqual(original)
 const settled=await runtime.reconcileModelUsage(initial.id,'req_original',async()=>receipt('gen_original'));expect(settled.modelRequests!.req_original!.usageEvidence!.upstreamRequestId).toBe('gen_original');expect(settled.usage.costUsd).toBe(.1);expect(settled.status).toBe('failed')
})

test('synchronous setup cannot dispatch after the monotonic whole-run deadline even before timers get a turn',async()=>{
 const warm=new PiRuntime({store:new MemorySessionStore(),streamFn:()=>stream()});await warm.run((await warm.create()).id,'Warm offline encoding')
 let calls=0;const runtime=new PiRuntime({store:new MemorySessionStore(),limits:{maxDurationMs:20},resources:async()=>{const until=performance.now()+80;while(performance.now()<until){};return {cwd:'.',skills:[]}},streamFn:()=>{calls++;return stream()}})
 const result=await runtime.run((await runtime.create()).id,'Blocked setup');expect(result.status).toBe('limit_reached');expect(calls).toBe(0);expect(result.session.modelRequests).toEqual({})
})
test('synchronous credential resolution cannot dispatch after its original request deadline',async()=>{
 let calls=0;const runtime=new PiRuntime({store:new MemorySessionStore(),modelRequestTimeoutMs:20,getApiKey:()=>{const until=performance.now()+80;while(performance.now()<until){};return 'offline-fixture-key'},streamFn:()=>{calls++;return stream()}})
 const result=await runtime.run((await runtime.create()).id,'Blocked credential');expect(result.status).toBe('failed');expect(result.error).toContain('deadline exceeded');expect(calls).toBe(0);expect(result.session.modelRequests).toEqual({});expect(result.session.usage.turns).toBe(0)
})
