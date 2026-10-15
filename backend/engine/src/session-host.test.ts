import {expect,test} from 'bun:test'
import {PiSessionHost,type SessionHostBaseline} from './session-host'
import {createAgentRuntime,MemorySessionStore,DEFAULT_MODEL_SELECTION,type AgentRuntimeOptions,type PiRunOptions} from './runtime'
const limits={maxCostUsd:2,maxTurns:12,maxToolCalls:24,maxDurationMs:300_000}
function fixture(overrides:Partial<ConstructorParameters<typeof PiSessionHost>[0]>={}) {
 const store=new MemorySessionStore(),options={store,sessionId:'ses_shared_host',metadata:{projectId:'offline',contractHash:'original'},modelSelection:DEFAULT_MODEL_SELECTION,
  operationId:'op_original',jobId:'job_original',inputHash:'sha256:original',runtimeOptions:{},checkNewWork:async()=>{},...overrides}
 return {store,options,host:new PiSessionHost(options)}
}
test('shared host persists one original binding and cumulative baseline without relabeling earlier requests',async()=>{
 let runOptions:PiRunOptions|undefined
 const f=fixture({runtimeFactory:options=>{
  const runtime=createAgentRuntime(options)
  return {...Object.fromEntries([]),get:runtime.get.bind(runtime),create:runtime.create.bind(runtime),resume:runtime.resume.bind(runtime),run:async(id,prompt,options)=>{
   runOptions=options;return {sessionId:id,status:'completed',session:(await runtime.get(id))!}
  }}
 }})
 const session=await f.host.open(),baseline=f.host.baseline(session,300_000)
 expect(baseline.originalRequestIds).toEqual([]);expect(baseline.binding?.operationId).toBe('op_original')
 const original=JSON.stringify(session)
 await f.host.run('Generated snapshot',limits,{promptOrigin:'host_context',exactInstructions:[{id:'job_original:human',text:'Keep every original constraint.'}]})
 expect(runOptions).toMatchObject({owningBinding:{operationId:'op_original',jobId:'job_original',bindingHash:f.host.binding.bindingHash},promptOrigin:'host_context'})
 expect(JSON.stringify(await f.store.get(session.id))).toBe(original)
})
test('shared host subtracts original cumulative counters and deadline across resumed calls',async()=>{
 const f=fixture(),session=await f.host.open(),baseline=f.host.baseline(session,300_000),originalBaseline=JSON.stringify(baseline)
 session.usage={costUsd:.4,turns:3,toolCalls:7}
 const remaining=f.host.remaining(session,baseline,limits)
 expect(remaining.maxCostUsd).toBeCloseTo(1.6);expect(remaining.maxTurns).toBe(9);expect(remaining.maxToolCalls).toBe(17)
 expect(remaining.maxDurationMs).toBeLessThanOrEqual(300_000)
 expect(JSON.stringify(baseline)).toBe(originalBaseline)
 expect(()=>f.host.remaining(session,{...baseline,deadlineMs:Date.now()-1},limits)).toThrow('exhausted')
 expect(()=>f.host.usage(session,{...baseline,costUsd:.5})).toThrow('lost or reset')
 const other=fixture({operationId:'op_other'}).host
 expect(()=>other.usage(session,baseline)).toThrow('another original operation')
})
test('legacy counter omissions keep per-call caps and unknown original request attribution',async()=>{
 const f=fixture(),session=await f.host.open()
 const legacy:SessionHostBaseline={costUsd:0,deadlineMs:Date.now()+60_000}
 session.usage={costUsd:.25,turns:80,toolCalls:120}
 expect(f.host.remaining(session,legacy,limits)).toMatchObject({maxCostUsd:1.75,maxTurns:12,maxToolCalls:24})
 expect(legacy.originalRequestIds).toBeUndefined();expect(legacy.binding).toBeUndefined()
 delete session.modelRequests
 expect(f.host.baseline(session,60_000).originalRequestIds).toBeUndefined()
})
test('identity is checked before resume can alter the original transcript',async()=>{
 const f=fixture(),session=await f.host.open();session.metadata.contractHash='changed';await f.store.save(session)
 let resumes=0
 const host=new PiSessionHost({...f.options,runtimeFactory:options=>{
  const r=createAgentRuntime(options);return {get:r.get.bind(r),create:r.create.bind(r),run:r.run.bind(r),resume:async id=>{resumes++;return r.resume(id)}}
 }})
 await expect(host.open()).rejects.toThrow('immutable launch');expect(resumes).toBe(0)
 session.metadata.contractHash='original';session.modelSelection.modelId='different';await f.store.save(session)
 await expect(host.open()).rejects.toThrow('model or original session')
})
test('receipt-only opening marks interrupted provider effects unknown and never creates missing sessions',async()=>{
 const f=fixture(),session=await f.host.open();session.modelRequests!.lost={status:'dispatched',model:session.modelSelection,purpose:'turn',startedAt:1};await f.store.save(session)
 expect((await f.host.open({receiptOnly:true})).modelRequests!.lost!.status).toBe('unknown')
 expect((await f.store.get(session.id))!.modelRequests!.lost!.status).toBe('unknown')
 await expect(f.host.run('Must not infer during original receipt recovery',limits)).rejects.toThrow('cannot authorize inference')
 await expect(fixture().host.open({receiptOnly:true})).rejects.toThrow('cannot create')
 await expect(f.host.open()).rejects.toThrow('unresolved usage')
})
test('ancestor revocation at the durable provider boundary prevents dispatch',async()=>{
 let checks=0,dispatches=0,externalChecks=0
 const runtimeOptions:Partial<AgentRuntimeOptions>={authorizeModelRequest:()=>{externalChecks++},streamFn:()=>{dispatches++;throw new Error('Must not dispatch')}}
 const f=fixture({runtimeOptions,checkNewWork:async()=>{if(++checks===3)throw new Error('Original authority revoked')}})
 await f.host.open()
 const result=await f.host.run('Protected exact instruction',limits)
 expect(result.status).toBe('failed');expect(result.error).toContain('Original authority revoked')
 expect(dispatches).toBe(0);expect(externalChecks).toBe(2)
 expect(Object.values(result.session.modelRequests!)).toHaveLength(1)
 expect(Object.values(result.session.modelRequests!)[0]?.status).toBe('not_dispatched')
})
