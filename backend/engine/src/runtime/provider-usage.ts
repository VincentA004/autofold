import crypto from 'node:crypto'
import type {PiProviderBilling} from './types'

/** Capture only explicit upstream identity/usage through Pi's supported raw
 * event observer. Never retain payloads, prompts, headers or credentials. */
export function observeProviderBilling(previous:PiProviderBilling|undefined, data:unknown):PiProviderBilling|undefined {
  if (!data || typeof data !== 'object') return previous
  const event=data as Record<string,unknown>, usage=event.usage && typeof event.usage==='object' ? event.usage as Record<string,unknown> : undefined
  const upstreamRequestId=typeof event.id==='string' && event.id.length<=256 ? event.id : previous?.upstreamRequestId
  if(previous?.upstreamRequestId && upstreamRequestId && previous.upstreamRequestId!==upstreamRequestId)throw new Error('Conflicting original upstream request identity')
  const routedProvider=typeof event.provider==='string' && event.provider.length<=256 ? event.provider : previous?.routedProvider
  if(previous?.routedProvider&&routedProvider&&previous.routedProvider!==routedProvider)throw new Error('Conflicting original routed provider identity')
  const observedModelId=typeof event.model==='string'&&event.model.length<=256?event.model:previous?.observedModelId
  if(previous?.observedModelId&&observedModelId&&previous.observedModelId!==observedModelId)throw new Error('Conflicting original routed model identity')
  const firstChoice=Array.isArray(event.choices)&&event.choices[0]&&typeof event.choices[0]==='object'?event.choices[0] as Record<string,unknown>:undefined
  const rawFinishReason=event.finish_reason??event.finishReason??firstChoice?.finish_reason
  const finishReason=typeof rawFinishReason==='string'&&rawFinishReason.length>0&&rawFinishReason.length<=128?rawFinishReason:previous?.finishReason
  const cost=typeof usage?.cost==='number' && Number.isFinite(usage.cost) && usage.cost>=0 ? usage.cost : undefined
  if (!upstreamRequestId && !routedProvider && cost===undefined&&!finishReason&&!observedModelId) return previous
  const reportedCostUsd=cost??previous?.reportedCostUsd??null
  const value:PiProviderBilling={source:'openrouter_stream',upstreamRequestId,routedProvider,reportedCostUsd,finishReason,observedModelId,
    status:reportedCostUsd!==null&&upstreamRequestId&&routedProvider&&finishReason?'reported':'unknown'}
  // Stream chunks may expose usage before identity/provider, or provider after
  // final usage. A cost chunk is not a final bill until the terminal finish reason
  // is present. Always bind evidence to the accumulated tuple we actually save.
  if (value.status==='reported') value.evidenceHash='sha256:'+crypto.createHash('sha256').update(JSON.stringify({upstreamRequestId,routedProvider,observedModelId,reportedCostUsd:value.reportedCostUsd,finishReason})).digest('hex')
  return value
}
