import {test,expect} from 'bun:test'
import crypto from 'node:crypto'
import {observeProviderBilling} from './provider-usage'
const expected=(value:any)=>'sha256:'+crypto.createHash('sha256').update(JSON.stringify({upstreamRequestId:value.upstreamRequestId,routedProvider:value.routedProvider,observedModelId:value.observedModelId,reportedCostUsd:value.reportedCostUsd,finishReason:value.finishReason})).digest('hex')
test('billing evidence binds accumulated identity provider and amount regardless of stream chunk order',()=>{
 const usage=observeProviderBilling(undefined,{usage:{cost:.25}})!
 expect(usage.status).toBe('unknown')
 const identity=observeProviderBilling(usage,{id:'gen_original',provider:'route_a'})!
 expect(identity.status).toBe('unknown')
 const provider=observeProviderBilling(identity,{model:'vendor/canonical-20261001',finish_reason:'stop'})!
 expect(provider.status).toBe('reported');expect(provider.evidenceHash).toBe(expected(provider))
 expect(provider).toEqual(observeProviderBilling(undefined,{id:'gen_original',provider:'route_a',model:'vendor/canonical-20261001',usage:{cost:.25},finish_reason:'stop'})!)
 expect(observeProviderBilling(provider,{id:'gen_original'})).toEqual(provider)
 expect(()=>observeProviderBilling(provider,{id:'gen_replacement'})).toThrow('Conflicting original upstream')
 expect(()=>observeProviderBilling(provider,{provider:'route_b'})).toThrow('Conflicting original routed provider')
 expect(()=>observeProviderBilling(provider,{model:'vendor/different'})).toThrow('Conflicting original routed model')
})
test('routed provider changes fail closed before a partial identity can become billable',()=>{
 const partial=observeProviderBilling(undefined,{id:'gen_original',provider:'route_a',usage:{cost:.25}})!
 expect(partial.status).toBe('unknown')
 expect(()=>observeProviderBilling(partial,{provider:'route_b',finish_reason:'stop'})).toThrow('Conflicting original routed provider')
})
test('billing accepts the native OpenAI choices finish_reason as terminal stream evidence',()=>{
 const provider=observeProviderBilling(undefined,{id:'gen_original',provider:'route_a',model:'vendor/model-20261001',usage:{cost:.25},choices:[{finish_reason:'stop'}]})!
 expect(provider.status).toBe('reported');expect(provider.finishReason).toBe('stop');expect(provider.evidenceHash).toBe(expected(provider))
})
test('explicit free usage has identity-bound evidence while missing usage stays unknown',()=>{
 const missing=observeProviderBilling(undefined,{id:'gen_original',provider:'route_a'})!
 expect(missing.status).toBe('unknown');expect(missing.reportedCostUsd).toBeNull();expect(missing.evidenceHash).toBeUndefined()
 const free=observeProviderBilling(missing,{usage:{cost:0}})!
 expect(free.status).toBe('unknown');expect(free.reportedCostUsd).toBe(0);expect(free.evidenceHash).toBeUndefined()
 const nonterminal=observeProviderBilling(free,{id:'gen_original',provider:'route_a',finish_reason:null})!
 expect(nonterminal.status).toBe('unknown');expect(nonterminal.reportedCostUsd).toBe(0);expect(nonterminal.evidenceHash).toBeUndefined()
 const final=observeProviderBilling(nonterminal,{finish_reason:'stop'})!
 expect(final.status).toBe('reported');expect(final.reportedCostUsd).toBe(0);expect(final.evidenceHash).toBe(expected(final))
})
