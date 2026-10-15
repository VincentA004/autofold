import {expect, test} from 'bun:test'
import {MemorySessionStore, SqliteSessionStore, PiRuntime, assertSessionAccountingComplete, type PiVerifiedUsageReceipt} from './index'

for (const kind of ['memory', 'sqlite'] as const) test(`${kind}: verified original billing receipt settles once without inference or transcript repair`, async () => {
  const store = kind === 'memory' ? new MemorySessionStore() : new SqliteSessionStore(':memory:')
  let calls = 0
  const runtime = new PiRuntime({store, streamFn: () => {calls++; throw new Error('Forbidden provider call')}})
  const session = await runtime.create()
  session.status = 'failed'; session.error = 'Original interrupted request'
  session.modelRequests = {req_original: {status: 'unknown', model: session.modelSelection, purpose: 'turn', startedAt: 10}}
  session.usage.costUsd = 0.25
  await store.save(session)
  const receipt: PiVerifiedUsageReceipt = {sessionId: session.id, requestId: 'req_original', model: session.modelSelection, startedAt: 10,
    terminal: 'completed', costUsd: 0.5, receiptId: 'receipt_original', sha256: 'sha256:' + 'a'.repeat(64), upstreamRequestId: 'upstream_original', source: 'offline_verified_fixture'}
  await expect(runtime.reconcileModelUsage(session.id, 'req_original', async () => ({...receipt, requestId: 'req_other'}))).rejects.toThrow('exact original')
  await expect(runtime.reconcileModelUsage(session.id, 'req_absent', async () => receipt)).rejects.toThrow('absent')
  await expect(runtime.reconcileModelUsage(session.id, 'req_original', async () => ({...receipt, costUsd: NaN}))).rejects.toThrow('exact original')
  const result = await runtime.reconcileModelUsage(session.id, 'req_original', async () => receipt)
  expect(result.usage.costUsd).toBe(0.75); expect(result.status).toBe('failed'); expect(result.error).toBe(session.error)
  expect(result.messages).toEqual(session.messages); expect(result.pendingTools).toEqual(session.pendingTools)
  assertSessionAccountingComplete(result)
  expect((await runtime.reconcileModelUsage(session.id, 'req_original', async () => receipt)).sequence).toBe(result.sequence)
  await expect(runtime.reconcileModelUsage(session.id, 'req_original', async () => ({...receipt, costUsd: 0.6}))).rejects.toThrow('Conflicting')
  const other = await runtime.create()
  other.modelRequests = {req_other: {status: 'unknown', model: other.modelSelection, purpose: 'turn', startedAt: 10}}
  await store.save(other)
  await expect(runtime.reconcileModelUsage(other.id, 'req_other', async () => ({...receipt, sessionId: other.id, requestId: 'req_other'}))).rejects.toThrow('another session')
  expect((await store.get(other.id))!.modelRequests!.req_other!.status).toBe('unknown')
  expect(calls).toBe(0)
  if (store instanceof SqliteSessionStore) store.close()
})

test('OpenRouter recovery settles only the exact saved generation and preserves failed delivery without inference',async()=>{
 const store=new MemorySessionStore();let modelCalls=0,lookups=0
 const runtime=new PiRuntime({store,getApiKey:()=> 'offline-api-key',streamFn:()=>{modelCalls++;throw new Error('Recovery must not infer')},
  openRouterGenerationFetch:(async(input,init)=>{
   lookups++;const url=new URL(input instanceof Request?input.url:String(input))
   expect(init?.method).toBe('GET');expect(url.searchParams.get('id')).toBe('gen_exact_original')
   return new Response(JSON.stringify({data:{id:'gen_exact_original',model:'deepseek/canonical-20261013',provider_name:'route_exact',total_cost:.0042,finish_reason:'stop'}}),{status:200})
  }) as typeof fetch})
 const session=await runtime.create();session.status='failed';session.error='Original stream failed';session.modelRequests={req_exact:{status:'unknown',model:session.modelSelection,
  modelBinding:{provider:'openrouter',requestedModelId:session.modelSelection.modelId,canonicalModelId:'deepseek/canonical-20261013',source:'explicit_host_alias'},
  purpose:'turn',startedAt:10,delivery:{status:'failed',stopReason:'error',errorMessage:'stream failed',partialToolCallCount:1,recordedAt:11},
  providerBilling:{source:'openrouter_stream',status:'unknown',upstreamRequestId:'gen_exact_original',routedProvider:'route_exact',reportedCostUsd:null,observedModelId:'deepseek/canonical-20261013'}}}
 await store.save(session)
 const settled=await runtime.reconcileOpenRouterModelUsage(session.id,'req_exact'),request=settled.modelRequests!.req_exact!
 expect(settled.status).toBe('failed');expect(settled.error).toBe(session.error);expect(request.status).toBe('settled')
 expect(request.reportedCostUsd).toBe(.0042);expect(request.costKind).toBe('provider_reported')
 expect(request.providerBilling).toMatchObject({status:'reported',reportedCostUsd:.0042,upstreamRequestId:'gen_exact_original',routedProvider:'route_exact',observedModelId:'deepseek/canonical-20261013',finishReason:'stop'})
 expect(request.usageEvidence?.source).toBe('openrouter_generation_api_v1');expect(request.delivery).toEqual(session.modelRequests!.req_exact!.delivery)
 expect(settled.usage.costUsd).toBe(.0042);expect(lookups).toBe(1);expect(modelCalls).toBe(0)
 assertSessionAccountingComplete(settled)
})
