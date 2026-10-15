import {createHash} from 'node:crypto'
import type {PiModelRequest, PiVerifiedUsageReceipt} from './types'

const OPENROUTER_GENERATION_URL='https://openrouter.ai/api/v1/generation'
const boundedString=(value:unknown,max=256):value is string=>typeof value==='string'&&value.length>0&&value.length<=max

/** Read-only lookup for the exact OpenRouter generation observed on the original stream. */
export async function verifyOpenRouterGeneration(input:{sessionId:string;requestId:string;request:Readonly<PiModelRequest>;apiKey:string;fetcher?:typeof fetch}):Promise<PiVerifiedUsageReceipt>{
 const {sessionId,requestId,request}=input,billing=request.providerBilling,binding=request.modelBinding
 if(request.model.provider!=='openrouter'||!billing?.upstreamRequestId||!billing.routedProvider||!binding||binding.provider!=='openrouter'||
   binding.requestedModelId!==request.model.modelId||!binding.canonicalModelId)
  throw new Error('Original OpenRouter request lacks exact generation, provider, or canonical model binding')
 if(!input.apiKey.trim())throw new Error('OpenRouter API key is unavailable for original generation lookup')
 const url=new URL(OPENROUTER_GENERATION_URL);url.searchParams.set('id',billing.upstreamRequestId)
 const response=await (input.fetcher??fetch)(url,{method:'GET',headers:{Authorization:`Bearer ${input.apiKey}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)})
 if(!response.ok)throw new Error(`OpenRouter original generation lookup failed with HTTP ${response.status}`)
 let body:unknown
 try{body=await response.json()}catch{throw new Error('OpenRouter original generation response is not valid JSON')}
 const envelope=body&&typeof body==='object'?body as Record<string,unknown>:undefined
 const data=envelope?.data&&typeof envelope.data==='object'?envelope.data as Record<string,unknown>:undefined
 if(!data)throw new Error('OpenRouter original generation response has no data record')
 const id=data.id,model=data.model,provider=data.provider_name
 const totalCost=data.total_cost,finishReason=data.finish_reason
 if(id!==billing.upstreamRequestId)throw new Error('OpenRouter generation lookup returned a different original request ID')
 if(model!==binding.canonicalModelId||(billing.observedModelId&&billing.observedModelId!==binding.requestedModelId&&billing.observedModelId!==binding.canonicalModelId))
  throw new Error('OpenRouter generation model does not match the frozen canonical model binding')
 if(!boundedString(provider)||provider!==billing.routedProvider)
  throw new Error('OpenRouter generation provider does not match the observed original routed provider')
 if(typeof totalCost!=='number'||!Number.isFinite(totalCost)||totalCost<0)
  throw new Error('OpenRouter generation has no valid final billed cost')
 if(!boundedString(finishReason,128)||data.cancelled===true)
  throw new Error('OpenRouter generation is not a completed final billing record')
 const sha256='sha256:'+createHash('sha256').update(JSON.stringify({id,model,provider_name:provider,total_cost:totalCost,finish_reason:finishReason,
   native_finish_reason:data.native_finish_reason??null,created_at:data.created_at??null})).digest('hex')
 return {sessionId,requestId,model:{...request.model},startedAt:request.startedAt,terminal:'completed',costUsd:totalCost,
  receiptId:`openrouter-generation:${id}`,sha256,upstreamRequestId:id,source:'openrouter_generation_api_v1',routedProvider:provider,canonicalModelId:model,finishReason}
}
