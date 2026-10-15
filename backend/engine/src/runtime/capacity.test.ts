import {expect, test} from 'bun:test'
import type {AssistantMessage} from '@earendil-works/pi-ai'
import {MemorySessionStore, PiRuntime, DEFAULT_MODEL, assertSessionAccountingComplete} from './index'
import {fitPiPayloadToContext, PiLocalContextOverflow} from './capacity'

test('capacity uses the converted system, tools, UTF-8 and response schema without a fixed answer cap', () => {
  const minimal = {messages: [{role: 'user', content: 'hello'}], max_tokens: DEFAULT_MODEL.maxTokens}
  expect(fitPiPayloadToContext(minimal, DEFAULT_MODEL)!.sizing.admittedOutputTokens).toBe(DEFAULT_MODEL.maxTokens)
  const payload = {...minimal, messages: [{role: 'system', content: 'schemas '.repeat(110000)}, {role: 'user', content: '蛋白🧬'.repeat(1000)}],
    tools: [{type: 'function', function: {name: 'scientific_receipt', parameters: {description: 'd'.repeat(10000)}}}], response_format: {type: 'json_object'}}
  const fitted = fitPiPayloadToContext(payload, DEFAULT_MODEL)!
  expect(fitted.sizing.admittedOutputTokens).toBeGreaterThan(16384)
  expect(fitted.sizing.inputTokenBound + fitted.sizing.admittedOutputTokens).toBe(DEFAULT_MODEL.contextWindow)
  // Regression: the old reservation plus the actual CoreWeave input overflowed.
  expect(384260 + 666847).toBeGreaterThan(DEFAULT_MODEL.contextWindow)
  expect(384260 + fitted.sizing.admittedOutputTokens).toBeLessThan(DEFAULT_MODEL.contextWindow)
  expect(payload.max_tokens).toBe(DEFAULT_MODEL.maxTokens)
  const nativeSummary = fitPiPayloadToContext({...minimal, max_tokens: 1600}, DEFAULT_MODEL)!
  expect(nativeSummary.sizing.admittedOutputTokens).toBe(1600)
  expect(() => fitPiPayloadToContext({...minimal, messages: [{role: 'user', content: 'x'.repeat(DEFAULT_MODEL.contextWindow)}]}, DEFAULT_MODEL)).toThrow(PiLocalContextOverflow)
})

const model = {...DEFAULT_MODEL, contextWindow: 128000, maxTokens: 100000}
const selection = {provider: model.provider, modelId: model.id, model}
const originalIntent = 'Original frozen scientific intent; evidence must remain exact.'
async function history(runtime: PiRuntime, store: MemorySessionStore, count = 22) {
  const session = await runtime.create(); delete session.sdk
  session.messages.push({role: 'user', content: originalIntent, timestamp: 1})
  for (let index = 0; index < count; index++) session.messages.push({role: 'assistant', content: [{type: 'text', text: `Historical uncertainty ${index}: ` + 'evidence '.repeat(1000)}],
    api: model.api, provider: model.provider, model: model.id, timestamp: 2 + index, stopReason: 'stop',
    usage: {input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}} satisfies AssistantMessage)
  await store.save(session); return session
}
function fixtureFetch(handler: (body: Record<string, unknown>, index: number) => Response) {
  let count = 0
  const transport = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => handler(JSON.parse(String(init?.body)), ++count), {preconnect: () => {}}) as typeof fetch
  return {transport, count: () => count}
}
function completion(index: number, text: string, finish_reason = 'stop') {
  const chunk = {id: `gen_fixture_${index}`, model: model.id, provider: 'OfflineExactIdentity', choices: [{index: 0, delta: {content: text}, finish_reason}],
    usage: {prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, cost: 0.001}}
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}})
}
const isSummary = (body: Record<string, unknown>) => JSON.stringify(body.messages).includes('<conversation>')||JSON.stringify(body.messages).includes('# Conversation')

test('real Pi adapter locally rejects an oversized prompt, compacts and retries with complete billing', async () => {
  const store = new MemorySessionStore(); let summaries = 0, ordinary = 0
  const fixture = fixtureFetch((body, index) => {
    const size = fitPiPayloadToContext(body, model)!.sizing
    expect(size.inputTokenBound + Number(body.max_tokens ?? body.max_completion_tokens)).toBeLessThanOrEqual(model.contextWindow)
    expect(JSON.stringify(body)).not.toContain('fixture-secret')
    if (isSummary(body)) {summaries++; return completion(index, 'Historical uncertainty remains. Continue the original frozen scientific intent; exact receipts remain in the archive.')}
    ordinary++; expect(JSON.stringify(body.messages)).toContain(originalIntent)
    return completion(index, 'Verified offline native continuation.')
  })
  const runtime = new PiRuntime({store, modelSelection: selection, getApiKey: () => 'fixture-secret', streamOptions: {fetch: fixture.transport}})
  const original = await history(runtime, store), result = await runtime.run(original.id, 'Continue without repeating scientific effects')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed')
  expect(summaries).toBeGreaterThan(0); expect(ordinary).toBe(1)
  expect(result.session.messages.slice(0, original.messages.length)).toEqual(original.messages)
  const requests = Object.values(result.session.modelRequests!)
  expect(requests.filter(r => r.status === 'not_dispatched')).toHaveLength(1)
  expect(requests.filter(r => r.status === 'settled')).toHaveLength(fixture.count())
  expect(result.session.usage.turns).toBe(fixture.count())
  expect(result.session.contextCompactions).toHaveLength(1)
  expect(() => assertSessionAccountingComplete(result.session)).not.toThrow()
  const events = await store.events(original.id)
  expect(events.filter(e => e.type === 'run_started')).toHaveLength(1)
  expect(events.filter(e => e.type === 'model_request_capacity_admitted')).toHaveLength(fixture.count())
  expect(JSON.stringify(events.filter(e => e.type === 'model_request_capacity_admitted'))).not.toContain('Historical uncertainty')
  expect(JSON.stringify(events)).not.toContain('fixture-secret')
})

test('a provider overflow with no original bill still stops before native retry or tool effects', async () => {
  const store = new MemorySessionStore()
  const fixture = fixtureFetch(() => new Response(JSON.stringify({error: {message: 'maximum context length is 128000 tokens', code: 400}}), {status: 400, headers: {'content-type': 'application/json'}}))
  const runtime = new PiRuntime({store, modelSelection: selection, getApiKey: () => 'fixture-secret', streamOptions: {fetch: fixture.transport}})
  const result = await runtime.run((await runtime.create()).id, 'Work')
  expect(result.status).toBe('failed'); expect(fixture.count()).toBe(1)
  expect(Object.values(result.session.modelRequests!)[0]!.status).toBe('unknown')
  expect(result.session.contextCompactions).toBeUndefined()
  expect(() => assertSessionAccountingComplete(result.session)).toThrow('unresolved usage')
})

test('real Pi adapter recovers a billed length stop through one native compact-and-retry', async () => {
  const store = new MemorySessionStore(); let ordinary = 0, summaries = 0
  const fixture = fixtureFetch((body, index) => {
    if (isSummary(body)) {summaries++; return completion(index, 'Preserve original frozen scientific intent and original receipts.')}
    ordinary++; return completion(index, ordinary === 1 ? 'Incomplete reasoning' : 'Completed native recovery', ordinary === 1 ? 'length' : 'stop')
  })
  const runtime = new PiRuntime({store, modelSelection: selection, getApiKey: () => 'fixture-secret', streamOptions: {fetch: fixture.transport}})
  const original = await history(runtime, store, 12), result = await runtime.run(original.id, 'Continue')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed')
  expect(ordinary).toBe(2); expect(summaries).toBeGreaterThan(0)
  expect(result.session.messages.filter(m => m.role === 'assistant' && m.stopReason === 'length')).toHaveLength(1)
  expect(result.session.contextCompactions).toHaveLength(1)
  expect(result.session.usage.turns).toBe(fixture.count())
  expect(Object.values(result.session.modelRequests!).every(r => r.status === 'settled' && r.providerBilling?.status === 'reported')).toBe(true)
  expect((await store.events(original.id)).filter(e => e.type === 'run_started')).toHaveLength(1)
})

test('a payload observer cannot grow the final prompt past capacity and dispatch it', async () => {
  const store = new MemorySessionStore(); const fixture = fixtureFetch((_body, index) => completion(index, 'Should never run'))
  const runtime = new PiRuntime({store, modelSelection: selection, getApiKey: () => 'fixture-secret', streamOptions: {fetch: fixture.transport,
    onPayload: payload => ({...payload as Record<string, unknown>, messages: [{role: 'user', content: 'x'.repeat(model.contextWindow)}]})}})
  const result = await runtime.run((await runtime.create()).id, 'Protected user intent')
  expect(result.status).toBe('failed'); expect(fixture.count()).toBe(0)
  expect(Object.values(result.session.modelRequests!).every(r => r.status === 'not_dispatched')).toBe(true)
  expect(result.session.usage.turns).toBe(0)
  expect(() => assertSessionAccountingComplete(result.session)).not.toThrow()
})
