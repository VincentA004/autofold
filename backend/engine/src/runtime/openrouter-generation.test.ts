import {expect,test} from 'bun:test'
import {verifyOpenRouterGeneration} from './openrouter-generation'
import type {PiModelRequest} from './types'

const request:PiModelRequest={status:'unknown',model:{provider:'openrouter',modelId:'vendor/model-latest'},
 modelBinding:{provider:'openrouter',requestedModelId:'vendor/model-latest',canonicalModelId:'vendor/model-20261001',source:'explicit_host_alias'},
 purpose:'turn',startedAt:123,providerBilling:{source:'openrouter_stream',status:'unknown',upstreamRequestId:'gen_original',routedProvider:'route_original',reportedCostUsd:null}}
const metadata=(overrides:Record<string,unknown>={})=>({data:{id:'gen_original',model:'vendor/model-20261001',provider_name:'route_original',total_cost:.0123,finish_reason:'stop',created_at:1900000000,...overrides}})
const fetcher=(body:unknown,inspect?:(url:URL,init:RequestInit)=>void):typeof fetch=>((input:RequestInfo|URL,init?:RequestInit)=>{
 const url=new URL(input instanceof Request?input.url:String(input));inspect?.(url,init??{});return Promise.resolve(new Response(JSON.stringify(body),{status:200}))
}) as typeof fetch

test('generation recovery fetches only the exact original ID and enforces explicit dated model alias binding',async()=>{
 let calls=0
 const receipt=await verifyOpenRouterGeneration({sessionId:'ses_original',requestId:'req_original',request,apiKey:'offline-secret',fetcher:fetcher(metadata(),(url,init)=>{
  calls++;expect(url.origin).toBe('https://openrouter.ai');expect(url.pathname).toBe('/api/v1/generation');expect(url.searchParams.get('id')).toBe('gen_original')
  expect(init.method).toBe('GET');expect((init.headers as Record<string,string>).Authorization).toBe('Bearer offline-secret');expect(init.redirect).toBe('error')
 })})
 expect(calls).toBe(1)
 expect(receipt).toMatchObject({sessionId:'ses_original',requestId:'req_original',model:{provider:'openrouter',modelId:'vendor/model-latest'},terminal:'completed',costUsd:.0123,
  upstreamRequestId:'gen_original',routedProvider:'route_original',canonicalModelId:'vendor/model-20261001',finishReason:'stop',source:'openrouter_generation_api_v1'})
 expect(receipt.sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
})

test('generation recovery accepts the frozen requested alias on stream when final metadata uses its canonical dated model',async()=>{
 const aliasRequest={...request,providerBilling:{...request.providerBilling!,observedModelId:'vendor/model-latest'}}
 const receipt=await verifyOpenRouterGeneration({sessionId:'ses_original',requestId:'req_original',request:aliasRequest,apiKey:'offline-secret',fetcher:fetcher(metadata())})
 expect(receipt.model.modelId).toBe('vendor/model-latest')
 expect(receipt.canonicalModelId).toBe('vendor/model-20261001')
})

test('generation recovery rejects null terminal reason even when provider reports zero',async()=>{
 await expect(verifyOpenRouterGeneration({sessionId:'ses_original',requestId:'req_original',request,apiKey:'offline-secret',fetcher:fetcher(metadata({total_cost:0,finish_reason:null}))}))
  .rejects.toThrow('not a completed final billing record')
})

test('generation recovery rejects missing or malformed final billing amounts',async()=>{
 for(const total_cost of [undefined,null,'0',-1,Number.NaN]){
  await expect(verifyOpenRouterGeneration({sessionId:'ses_original',requestId:'req_original',request,apiKey:'offline-secret',fetcher:fetcher(metadata({total_cost}))}))
   .rejects.toThrow('no valid final billed cost')
 }
})

test('generation recovery rejects changed original request IDs, routed providers, and canonical model IDs',async()=>{
 for(const [field,value,expected] of [
  ['id','gen_other','different original request ID'],
  ['provider_name','route_other','provider does not match'],
  ['model','vendor/model-20261002','canonical model binding'],
 ] as const){
  await expect(verifyOpenRouterGeneration({sessionId:'ses_original',requestId:'req_original',request,apiKey:'offline-secret',fetcher:fetcher(metadata({[field]:value}))})).rejects.toThrow(expected)
 }
 await expect(verifyOpenRouterGeneration({sessionId:'ses_original',requestId:'req_original',request:{...request,modelBinding:undefined},apiKey:'offline-secret',fetcher:fetcher(metadata())}))
  .rejects.toThrow('canonical model binding')
})
