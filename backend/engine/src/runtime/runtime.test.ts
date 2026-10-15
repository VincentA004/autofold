import { describe, expect, test } from 'bun:test'
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type ToolCall } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { MemorySessionStore, PiRuntime, SqliteSessionStore, DEFAULT_MODEL, MAX_TIMER_DURATION_MS, assertSessionAccountingComplete } from './index'

const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop', cost = 0): AssistantMessage => ({
  role: 'assistant', content, api: DEFAULT_MODEL.api, provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.id,
  timestamp: Date.now(), stopReason, usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
  ...(stopReason === 'error' ? { errorMessage: 'provider failure' } : {}),
})
const call = (id: string, args: unknown = { value: 'hello' }, name = 'write'): ToolCall => ({ type: 'toolCall', id, name, arguments: args as Record<string, any> })
const scripted = (...messages: AssistantMessage[]): StreamFn => {
  let index = 0
  return (_model, context) => {
    expect(context.messages.some(entry => entry.role === 'user')).toBe(true)
    const value = messages[index++]
    if (!value) throw new Error('Unexpected model turn')
    const stream = createAssistantMessageEventStream()
    stream.push({ type: 'start', partial: value })
    if (value.content[0]?.type === 'text') stream.push({ type: 'text_delta', contentIndex: 0, delta: value.content[0].text, partial: value })
    if (value.stopReason === 'error' || value.stopReason === 'aborted') stream.push({ type: 'error', reason: value.stopReason, error: value })
    else stream.push({ type: 'done', reason: value.stopReason as 'stop' | 'length' | 'toolUse', message: value })
    stream.end(value)
    return stream
  }
}
function writeTool(execute: (id: string, value: string) => Promise<unknown>): AgentTool<any> {
  return { name: 'write', label: 'Write', description: 'Fixture', parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    execute: async (id, args) => { const value = await execute(id, (args as { value: string }).value); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value } } }
}

describe('actual Pi Agent runtime', () => {
  test('a successful response without usage is completed delivery with unresolved accounting',async()=>{
    const store=new MemorySessionStore(),runtime=new PiRuntime({store,requireProviderReportedUsage:true,streamFn:()=>{
      const value=message([{type:'text',text:'Delivered but unpriced'}]);delete (value as any).usage
      const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message:value});stream.end(value);return stream
    }})
    const result=await runtime.run((await runtime.create()).id,'Keep delivery and accounting distinct')
    const request=Object.values(result.session.modelRequests!)[0]!
    expect(result.status).toBe('failed');expect(request.status).toBe('unknown')
    expect(request.delivery).toMatchObject({status:'completed',stopReason:'stop',partialToolCallCount:0})
    expect(request.providerBilling).toMatchObject({status:'unknown',reportedCostUsd:null})
    expect(()=>assertSessionAccountingComplete(result.session)).toThrow('unresolved usage')
  })

  test('failed provider delivery persists separately from unresolved billing and discards partial tool calls', async () => {
    const store=new MemorySessionStore();let modelCalls=0,effects=0
    const partial=message([call('partial-write',{value:'must not execute'})],'error',0)
    const runtime=new PiRuntime({store,requireProviderReportedUsage:true,tools:[writeTool(async()=>{effects++;return 'unexpected'})],
      streamFn:async(_model,_context,options)=>{
        modelCalls++
        await options!.onProviderStreamEvent!({id:'gen_partial_original',provider:'route_original',model:'vendor/canonical-20261001',usage:{cost:0},finish_reason:null},DEFAULT_MODEL)
        const stream=createAssistantMessageEventStream()
        stream.push({type:'start',partial})
        stream.push({type:'error',reason:'error',error:partial})
        stream.end(partial);return stream
      }})
    const initial=await runtime.create(),result=await runtime.run(initial.id,'Do not execute an incomplete response')
    const [requestId,request]=Object.entries(result.session.modelRequests!)[0]!
    expect(modelCalls).toBe(1);expect(effects).toBe(0);expect(result.status).toBe('failed')
    expect(request.status).toBe('unknown');expect(request.providerBilling).toMatchObject({upstreamRequestId:'gen_partial_original',routedProvider:'route_original',reportedCostUsd:0,status:'unknown'})
    expect(request.delivery).toMatchObject({status:'failed',stopReason:'error',partialToolCallCount:1})
    expect(result.session.messages.filter(value=>value.role==='assistant').flatMap(value=>value.content).some(part=>part.type==='toolCall')).toBe(false)
    expect((await store.events(initial.id)).some(event=>event.type==='model_request_delivery_failed'||event.type==='model_request_settled')).toBe(true)
    const resumed=await runtime.resume(initial.id);expect(resumed.modelRequests![requestId]!.status).toBe('unknown')
    const blocked=await runtime.run(initial.id,'No inference may be used to recover billing')
    expect(blocked.status).toBe('failed');expect(blocked.error).toContain('unresolved usage')
    expect(modelCalls).toBe(1);expect(effects).toBe(0);expect((await store.get(initial.id))!.modelRequests![requestId]!.delivery).toEqual(request.delivery)
  })
  test('persists full assistant intent and execution boundary before serial tool effects and events', async () => {
    expect(typeof Agent).toBe('function')
    const store = new MemorySessionStore()
    const execution: string[] = []
    let id = ''
    const runtime = new PiRuntime({ store, tools: [writeTool(async callId => {
      const durable = await store.get(id)
      expect(durable?.messages.findLast(entry => entry.role === 'assistant')?.content.some(part => part.type === 'toolCall')).toBe(true)
      expect(durable?.pendingTools[callId]).toBeDefined()
      execution.push(callId); await Promise.resolve(); return { saved: true }
    })], streamFn: scripted(message([call('a'), call('b')], 'toolUse'), message([{ type: 'text', text: 'Done' }])) })
    const session = await runtime.create({ metadata: { projectId: 'p', experimentId: 'e' } }); id = session.id
    const events: string[] = []
    const result = await runtime.run(id, 'Work', { onEvent: async event => {
      expect((await store.events(id)).at(-1)?.sequence).toBe(event.sequence); events.push(event.type)
    } })
    expect(result.status).toBe('completed'); expect(execution).toEqual(['a', 'b'])
    expect(result.session.messages.filter(entry => entry.role === 'toolResult')).toHaveLength(2)
    expect(result.session.pendingTools).toEqual({}); expect(events).toContain('message_update')
    expect(result.session.usage.turns).toBe(2)
  })
  test('invalid tool arguments and extra experiment identity never execute', async () => {
    let effects = 0
    const runtime = new PiRuntime({ store: new MemorySessionStore(), tools: [writeTool(async () => ++effects)],
      streamFn: scripted(message([call('invalid', { value: 123 }), call('escape', { value: 'x', experimentId: 'other' })], 'toolUse'), message([{ type: 'text', text: 'Rejected' }])) })
    const result = await runtime.run((await runtime.create()).id, 'Work')
    expect(effects).toBe(0)
    expect(result.session.messages.filter(entry => entry.role === 'toolResult').every(entry => entry.role === 'toolResult' && entry.isError)).toBe(true)
  })
  test('invalid nested tool arguments expose bounded field paths without argument values', async () => {
    let effects=0
    const tool={...writeTool(async()=>++effects),parameters:Type.Object({updates:Type.Array(Type.Object({requestId:Type.String(),status:Type.Union([Type.Literal('answered'),Type.Literal('blocked')])},{additionalProperties:false}))},{additionalProperties:false})}
    const runtime=new PiRuntime({store:new MemorySessionStore(),tools:[tool],streamFn:scripted(message([call('missing',{updates:[{status:'sensitive-invalid-value'}]})],'toolUse'),message([{type:'text',text:'Done'}]))})
    const result=await runtime.run((await runtime.create()).id,'Work')
    const error=result.session.messages.find(m=>m.role==='toolResult') as any
    expect(error.isError).toBe(true);expect(error.content[0].text).toContain('/updates/0/requestId');expect(error.content[0].text).toContain('/updates/0/status')
    expect(error.content[0].text).not.toContain('sensitive-invalid-value');expect(effects).toBe(0)
  })
  test('model errors and exceptions produce failed results, never completed', async () => {
    for (const streamFn of [scripted(message([], 'error')), (() => { throw new Error('offline failure') }) as StreamFn]) {
      const runtime = new PiRuntime({ store: new MemorySessionStore(), streamFn })
      const result = await runtime.run((await runtime.create()).id, 'Work')
      expect(result.status).toBe('failed'); expect(result.error).toMatch(/failure/)
    }
  })
  test('cancels an uncooperative model stream', async () => {
    const store = new MemorySessionStore()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const runtime = new PiRuntime({ store, streamFn: () => { started(); return createAssistantMessageEventStream() } })
    const session = await runtime.create()
    const resultPromise = runtime.run(session.id, 'Work'); await ready; runtime.cancel(session.id)
    expect((await resultPromise).status).toBe('cancelled')
    expect((await store.get(session.id))?.status).toBe('cancelled')
  })
  test('cancelled tool outcomes remain uncertain and resume fails closed without replay', async () => {
    let effects = 0, started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const store = new MemorySessionStore()
    const runtime = new PiRuntime({ store, tools: [writeTool(async () => { effects++; started(); return new Promise(() => {}) })], streamFn: scripted(message([call('mutate')], 'toolUse')) })
    const session = await runtime.create(); const promise = runtime.run(session.id, 'Work'); await ready; runtime.cancel(session.id)
    const result = await promise; expect(result.status).toBe('cancelled'); expect(result.session.pendingTools.mutate).toBeDefined()
    const resumed = await new PiRuntime({ store }).resume(session.id)
    expect(resumed.status).toBe('failed'); expect(effects).toBe(1); expect(resumed.error).toMatch(/not replayed/)
  })
  test('bounds turns, tool effects, duration and cost', async () => {
    let effects = 0
    const tools = [writeTool(async () => ++effects)]
    const cases = [
      { limits: { maxTurns: 1 }, streamFn: scripted(message([call('t')], 'toolUse')), expectedEffects: 1 },
      { limits: { maxToolCalls: 1 }, streamFn: scripted(message([call('a'), call('b')], 'toolUse')), expectedEffects: 1 },
      { limits: { maxCostUsd: 0.1 }, streamFn: scripted(message([call('c')], 'toolUse', 0.2)), expectedEffects: 0 },
      { limits: { maxDurationMs: 10 }, streamFn: (() => createAssistantMessageEventStream()) as StreamFn, expectedEffects: 0 },
    ]
    for (const item of cases) {
      effects = 0; const runtime = new PiRuntime({ store: new MemorySessionStore(), tools, ...item })
      const result = await runtime.run((await runtime.create()).id, 'Work')
      expect(result.status).toBe('limit_reached'); expect(effects).toBe(item.expectedEffects)
    }
  })
  test('complete sessions resume with transcript and context transform', async () => {
    const store = new MemorySessionStore()
    const runtime = new PiRuntime({ store, streamFn: scripted(message([{ type: 'text', text: 'First' }])) })
    const session = await runtime.create(); await runtime.run(session.id, 'Work')
    let observed = false
    const resumed = new PiRuntime({ store, streamFn: scripted(message([{ type: 'text', text: 'Second' }])),
      transformContext: async messages => { observed = messages.some(entry => entry.role === 'assistant'); return messages } })
    expect((await resumed.resume(session.id)).messages.some(entry => entry.role === 'assistant')).toBe(true)
    const result = await resumed.run(session.id, 'Again'); expect(result.status).toBe('completed'); expect(observed).toBe(true)
    expect(result.session.messages.filter(entry => entry.role === 'assistant')).toHaveLength(2)
  })
  test('SQLite atomically journals state and recovers interrupted intent across reopen', async () => {
    const path = `/private/tmp/autofold-pi-${crypto.randomUUID()}.sqlite`
    const store = new SqliteSessionStore(path)
    const runtime = new PiRuntime({ store }); const session = await runtime.create()
    session.status = 'running'; session.messages.push(message([call('uncertain')], 'toolUse'))
    session.pendingTools.uncertain = { name: 'write', args: { value: 'x' }, startedAt: Date.now() }
    await store.save(session); store.close()
    const restoredStore = new SqliteSessionStore(path)
    const resumed = await new PiRuntime({ store: restoredStore }).resume(session.id)
    expect(resumed.status).toBe('failed')
    expect(resumed.messages.at(-1)?.role).toBe('toolResult')
    expect((await restoredStore.events(session.id)).at(-1)?.type).toBe('session_recovered')
    restoredStore.close()
    const { rm } = await import('node:fs/promises'); await Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => rm(file, { force: true })))
  })
  test('default changes cannot silently switch a persisted legacy session', async () => {
    const store = new MemorySessionStore()
    const selection = {provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash'}
    const session = await new PiRuntime({store, modelSelection: selection}).create()
    let calls = 0
    const wrong = new PiRuntime({store, streamFn: () => { calls++; throw new Error('Unexpected inference') }})
    const refused = await wrong.run(session.id, 'Resume')
    expect(refused.status).toBe('failed'); expect(refused.error).toContain('selected model'); expect(calls).toBe(0)
    expect((await store.get(session.id))?.modelSelection).toEqual(selection)
    const original = new PiRuntime({store, modelSelection: selection,
      streamFn: scripted({...message([{type: 'text', text: 'Original model retained'}]), model: selection.modelId})})
    expect((await original.run(session.id, 'Resume explicitly')).status).toBe('completed')
  })
  test('refuses donor transcript and missing selected models', async () => {
    const store = new MemorySessionStore(); const runtime = new PiRuntime({ store })
    const session = await runtime.create(); await store.save({ ...session, runtime: 'donor' } as never)
    await expect(runtime.resume(session.id)).rejects.toThrow(/not a supported Pi/)
    await expect(new PiRuntime({ store, modelSelection: { provider: 'openrouter', modelId: 'not-a-model' } }).create()).rejects.toThrow(/not registered/)
  })
})

describe('session ownership and credential boundaries', () => {
  test('two runtimes sharing SQLite reject concurrent effects and recovery', async () => {
    const path = `/private/tmp/autofold-pi-lock-${crypto.randomUUID()}.sqlite`
    const firstStore = new SqliteSessionStore(path), secondStore = new SqliteSessionStore(path)
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let effects = 0
    const first = new PiRuntime({ store: firstStore, tools: [writeTool(async () => { effects++; ready(); return new Promise(() => {}) })],
      streamFn: scripted(message([call('single-effect')], 'toolUse')) })
    const second = new PiRuntime({ store: secondStore, tools: [writeTool(async () => ++effects)], streamFn: scripted(message([call('duplicate')], 'toolUse')) })
    const session = await first.create()
    const running = first.run(session.id, 'Work'); await started
    await expect(second.run(session.id, 'Race')).rejects.toThrow(/already running or locked/)
    await expect(second.resume(session.id)).rejects.toThrow(/already running or locked/)
    expect((await secondStore.get(session.id))?.status).toBe('running'); expect(effects).toBe(1)
    first.cancel(session.id); expect((await running).status).toBe('cancelled')
    expect((await second.resume(session.id)).status).toBe('failed')
    firstStore.close(); secondStore.close()
    const { rm } = await import('node:fs/promises'); await Promise.all([path, `${path}-wal`, `${path}-shm`].map(file => rm(file, { force: true })))
  })
  test('state/event CAS rejects stale writers atomically and expired lease owners cannot save', async () => {
    const store = new SqliteSessionStore(':memory:')
    const session = await new PiRuntime({ store }).create()
    const stale = structuredClone(session)
    session.sequence++
    await store.save(session, { sessionId: session.id, sequence: session.sequence, type: 'test', data: {}, timestamp: Date.now() })
    await expect(store.save(stale)).rejects.toThrow(/Concurrent Pi session update/)
    expect((await store.events(session.id))).toHaveLength(2)
    await expect(store.save(session, undefined, 'not-owner')).rejects.toThrow(/lease was lost/)
    store.close()
  })
  test('leaves ordinary output length to Pi and rejects an Autofold cap', async () => {
    let requests = 0
    const runtime = new PiRuntime({store: new MemorySessionStore(), streamFn: (model, context, options) => {
      requests++; expect(options?.maxTokens).toBeUndefined()
      return scripted(message([{type: 'text', text: 'Complete.'}]))(model, context, options)
    }})
    expect((await runtime.run((await runtime.create()).id, 'Work')).status).toBe('completed')
    expect(requests).toBe(1)
    expect(() => new PiRuntime({store: new MemorySessionStore(), streamOptions: {maxTokens: 16384} as any})).toThrow('output-token overrides are unsupported')
  })
  test('the actual Pi OpenRouter adapter uses the model output limit without an Autofold cap', async () => {
    let outputLimit: unknown
    const runtime = new PiRuntime({store: new MemorySessionStore(), getApiKey: () => 'offline-fixture-key',
      streamOptions: {onPayload: payload => {
        const request = payload as Record<string, unknown>
        outputLimit = request.max_tokens ?? request.max_completion_tokens
        throw new Error('Offline payload captured before transport')
      }}})
    const result = await runtime.run((await runtime.create()).id, 'Inspect output policy')
    expect(result.status).toBe('failed')
    expect(result.error).toContain('Offline payload captured before transport')
    expect(outputLimit).toBe(DEFAULT_MODEL.maxTokens)
    expect(outputLimit as number).toBeGreaterThan(8192)
  })
  test('API keys resolved for a model turn never enter session state or journal', async () => {
    const store = new MemorySessionStore(), secret = 'fixture-super-secret-provider-key'
    let gotKey = false
    const runtime = new PiRuntime({ store, getApiKey: () => secret,
      streamFn: (model, context, options) => { gotKey = options?.apiKey === secret; return scripted(message([{ type: 'text', text: 'Done' }]))(model, context, options) } })
    const session = await runtime.create(); expect((await runtime.run(session.id, 'Work')).status).toBe('completed')
    expect(gotKey).toBe(true); expect(JSON.stringify(await store.get(session.id))).not.toContain(secret)
    expect(JSON.stringify(await store.events(session.id))).not.toContain(secret)
  })
  test('deferred model output cannot be labelled as a completed run', async () => {
    const runtime = new PiRuntime({ store: new MemorySessionStore(), streamFn: scripted(message([], 'deferred')) })
    const result = await runtime.run((await runtime.create()).id, 'Work')
    expect(result.status).toBe('failed'); expect(result.error).toContain('did not complete')
  })
})


describe('duration timer boundaries', () => {
  test('rejects overflow and fractional durations before acquiring a session lease', () => {
    const store = new MemorySessionStore()
    for (const maxDurationMs of [MAX_TIMER_DURATION_MS + 1, Number.MAX_SAFE_INTEGER, 0.5]) {
      expect(() => new PiRuntime({ store, limits: { maxDurationMs } })).toThrow(/maxDurationMs must be an integer between 1 and 2147483647/)
    }
  })
  test('accepts the maximum duration with short renewable ownership', async () => {
    class ObservedStore extends MemorySessionStore {
      ttlMs = 0
      override async acquireLease(id: string, owner: string, ttlMs: number) {
        this.ttlMs = ttlMs
        return super.acquireLease(id, owner, ttlMs)
      }
    }
    const store = new ObservedStore()
    const runtime = new PiRuntime({ store, limits: { maxDurationMs: MAX_TIMER_DURATION_MS },
      streamFn: scripted(message([{ type: 'text', text: 'Done' }])) })
    const session = await runtime.create()
    expect((await runtime.run(session.id, 'Work')).status).toBe('completed')
    expect(store.ttlMs).toBe(30_000)
    expect(await store.acquireLease(session.id, 'next-owner', 1_000)).toBe(true)
    await store.releaseLease(session.id, 'next-owner')
  })
})


// Buffered deltas can drain entirely through microtasks. A small synchronous
// decoding cost reproduces timer starvation without provider or network calls.
function bufferedThinking(final: AssistantMessage, chunks = 600): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream()
  stream[Symbol.asyncIterator] = async function* () {
    const partial = message([{ type: 'thinking', thinking: '' }])
    yield { type: 'start', partial } as AssistantMessageEvent
    for (let index = 0; index < chunks; index++) {
      const until = performance.now() + 0.5
      while (performance.now() < until) { /* Simulate buffered provider decoding. */ }
      const thinking = 'x'.repeat((index + 1) * 256)
      yield { type: 'thinking_delta', contentIndex: 0, delta: 'x'.repeat(256),
        partial: message([{ type: 'thinking', thinking }]) } as AssistantMessageEvent
    }
    stream.end(final)
    yield { type: 'done', reason: final.stopReason, message: final } as AssistantMessageEvent
  }
  return stream
}

describe('renewable ownership and inference deadlines', () => {
  test('long buffered reasoning renews ownership and coalesces progress without losing tool intent or final output', async () => {
    class ObservedStore extends SqliteSessionStore {
      renewals = 0
      override async renewLease(id: string, owner: string, ttlMs: number) {
        this.renewals++; return super.renewLease(id, owner, ttlMs)
      }
    }
    const store = new ObservedStore(':memory:')
    const thinking = 'x'.repeat(600 * 256)
    let sessionId = '', effects = 0, requests = 0
    const observed: number[] = []
    // Large legacy-tokenization work is synchronous; leave headroom for GC.
    // The >300 ms buffered stream must still renew repeatedly and exclude a competitor.
    const runtime = new PiRuntime({ store, leaseDurationMs: 300, leaseHeartbeatMs: 20, modelRequestTimeoutMs: 2000,
      tools: [writeTool(async callId => {
        const durable = await store.get(sessionId)
        expect(durable?.messages.at(-1)?.content).toEqual([{ type: 'thinking', thinking }, call(callId)])
        expect(durable?.pendingTools[callId]).toBeDefined()
        expect(await store.acquireLease(sessionId, 'competitor', 100)).toBe(false)
        effects++; return { saved: true }
      })], streamFn: (model, context, options) => requests++ === 0
        ? bufferedThinking(message([{ type: 'thinking', thinking }, call('after-reasoning')], 'toolUse'))
        : scripted(message([{ type: 'text', text: 'Complete.' }]))(model, context, options) })
    try {
      const session = await runtime.create(); sessionId = session.id
      // Prior scientific tool results make the existing transcript large.
      session.messages.push(message([{ type: 'text', text: 'prior evidence '.repeat(140000) }]))
      await store.save(session)
      const result = await runtime.run(sessionId, 'Continue', { onEvent: async event => {
        expect((await store.get(sessionId))?.sequence).toBe(event.sequence)
        observed.push(event.sequence)
      } })
      expect(result.status).toBe('completed'); expect(effects).toBe(1)
      expect(store.renewals).toBeGreaterThanOrEqual(4)
      const events = await store.events(sessionId)
      expect(events.filter(event => event.type === 'message_update').length).toBeLessThan(10)
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
      expect(observed).toEqual(events.slice(1).map(event => event.sequence))
      expect((await store.get(sessionId))?.messages).toEqual(result.session.messages)
      expect(result.session.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Complete.' }])
    } finally { store.close() }
  })

  test('cancellation timers interrupt buffered reasoning before a later tool effect', async () => {
    let effects = 0, sessionId = ''
    const runtime = new PiRuntime({ store: new MemorySessionStore(), leaseDurationMs: 100, leaseHeartbeatMs: 20,
      tools: [writeTool(async () => ++effects)], streamFn: () => {
        setTimeout(() => runtime.cancel(sessionId), 30)
        return bufferedThinking(message([call('must-not-execute')], 'toolUse'))
      } })
    sessionId = (await runtime.create()).id
    const result = await runtime.run(sessionId, 'Continue')
    expect(result.status).toBe('cancelled'); expect(effects).toBe(0)
  })

  test('model deadlines exclude scientific tool waits and leases renew during the tool', async () => {
    class ObservedStore extends MemorySessionStore {
      renewals = 0
      override async renewLease(id: string, owner: string, ttlMs: number) {
        this.renewals++; return super.renewLease(id, owner, ttlMs)
      }
    }
    const store = new ObservedStore()
    let sessionId = ''
    const runtime = new PiRuntime({ store, leaseDurationMs: 100, leaseHeartbeatMs: 20, modelRequestTimeoutMs: 15,
      limits: { maxDurationMs: 1000 }, tools: [writeTool(async () => {
        await Bun.sleep(140)
        expect(await store.acquireLease(sessionId, 'competitor', 100)).toBe(false)
        return { settled: true }
      })], streamFn: scripted(message([call('slow-science')], 'toolUse'), message([{ type: 'text', text: 'Done' }])) })
    sessionId = (await runtime.create()).id
    const result = await runtime.run(sessionId, 'Work')
    expect(result.status).toBe('completed')
    expect(store.renewals).toBeGreaterThanOrEqual(4)
    expect(await store.acquireLease(sessionId, 'after-completion', 100)).toBe(true)
  })

  test('an uncooperative inference request times out independently of the overall job', async () => {
    let providerSignal: AbortSignal | undefined
    const runtime = new PiRuntime({ store: new MemorySessionStore(), modelRequestTimeoutMs: 20, limits: { maxDurationMs: 2000 },
      streamFn: (_model, _context, options) => {
        providerSignal = options?.signal
        return createAssistantMessageEventStream()
      } })
    const result = await runtime.run((await runtime.create()).id, 'Work')
    expect(result.status).toBe('failed')
    expect(result.error).toContain('Model request deadline exceeded')
    expect(providerSignal?.aborted).toBe(true)
  })

  test('expired and replaced owners cannot renew or release a new owner', async () => {
    const stores = [new MemorySessionStore(), new SqliteSessionStore(':memory:')]
    try {
      for (const store of stores) {
        expect(await store.acquireLease('ses_fencing', 'old', 15)).toBe(true)
        await Bun.sleep(25)
        expect(await store.renewLease('ses_fencing', 'old', 100)).toBe(false)
        expect(await store.acquireLease('ses_fencing', 'new', 100)).toBe(true)
        await store.releaseLease('ses_fencing', 'old')
        expect(await store.renewLease('ses_fencing', 'new', 100)).toBe(true)
        expect(await store.renewLease('ses_fencing', 'old', 100)).toBe(false)
        await store.releaseLease('ses_fencing', 'new')
      }
    } finally { (stores[1] as SqliteSessionStore).close() }
  })

  test('lease loss aborts inference and prevents further tool effects', async () => {
    class LostStore extends MemorySessionStore {
      override async renewLease(id: string, owner: string, _ttlMs: number) {
        await super.releaseLease(id, owner); return false
      }
    }
    let effects = 0
    const runtime = new PiRuntime({ store: new LostStore(), leaseDurationMs: 100, leaseHeartbeatMs: 20,
      streamFn: () => createAssistantMessageEventStream(), tools: [writeTool(async () => ++effects)] })
    await expect(runtime.run((await runtime.create()).id, 'Work')).rejects.toThrow('Pi session lease was lost')
    expect(effects).toBe(0)
  })
})

test('unserializable tool output preserves the failure and contiguous durable journal without replay', async () => {
  const store = new MemorySessionStore(); let effects = 0
  const runtime = new PiRuntime({store, tools: [writeTool(async () => {effects++; return {unsupported: () => undefined}})],
    streamFn: scripted(message([call('bad-result')], 'toolUse'))})
  const session = await runtime.create()
  const result = await runtime.run(session.id, 'Run the fixture effect once')
  expect(result.status).toBe('failed')
  expect(result.error).not.toContain('Concurrent Pi session update')
  expect(effects).toBe(1)
  const events = await store.events(session.id)
  expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
  expect(events.at(-1)?.type).toBe('run_finished')
  await runtime.resume(session.id)
  expect(effects).toBe(1)
})


test('a provider that ends without a terminal event still accounts final usage and applies cost fences', async () => {
  const store = new MemorySessionStore(); let effects = 0
  const runtime = new PiRuntime({store, limits: {maxCostUsd: 0.1}, tools: [writeTool(async () => {effects++})], streamFn: () => {
    const stream = createAssistantMessageEventStream(), final = message([call('must-not-execute')], 'toolUse', 0.2)
    stream.push({type: 'start', partial: final}); stream.end(final); return stream
  }})
  const result = await runtime.run((await runtime.create()).id, 'Work')
  expect(result.status).toBe('limit_reached'); expect(result.session.usage.costUsd).toBe(0.2); expect(effects).toBe(0)
})


test('pending host credentials settle on request timeout or cancellation and never dispatch after resolving', async () => {
  for (const cancel of [false, true]) {
    let resolveKey!: (key: string) => void, ready!: () => void, calls = 0, credentials = 0
    const key = new Promise<string>(resolve => {resolveKey = resolve})
    const started = new Promise<void>(resolve => {ready = resolve})
    const runtime = new PiRuntime({store: new MemorySessionStore(), modelRequestTimeoutMs: cancel ? 2000 : 25,
      getApiKey: () => {credentials++; ready(); return key},
      streamFn: (model, context, options) => {calls++; return scripted(message([{type: 'text', text: 'Must not dispatch'}]))(model, context, options)}})
    const session = await runtime.create(), running = runtime.run(session.id, 'Work')
    await started
    if (cancel) runtime.cancel(session.id)
    const result = await running
    expect(result.status).toBe(cancel ? 'cancelled' : 'failed')
    if (!cancel) expect(result.error).toContain('Model request deadline exceeded')
    expect(result.session.usage.turns).toBe(0); expect(calls).toBe(0); expect(credentials).toBe(1)
    resolveKey('late-host-key'); await Bun.sleep(10)
    expect(calls).toBe(0); expect(result.session.usage.turns).toBe(0)
  }
})

test('provider dispatch is durably debited and timeout or cancellation leaves unknown billing across runtime restart', async () => {
  for (const cancel of [false, true]) {
    const store = new MemorySessionStore(); let id = '', ready!: () => void, calls = 0
    const dispatched = new Promise<void>(resolve => {ready = resolve})
    const runtime = new PiRuntime({store, modelRequestTimeoutMs: cancel ? 2000 : 25, streamFn: async () => {
      calls++
      const durable = (await store.get(id))!
      expect(durable.usage.turns).toBe(1)
      expect(Object.values(durable.modelRequests!)[0]?.status).toBe('dispatched')
      expect((await store.events(id)).at(-1)?.type).toBe('model_request_dispatched')
      ready()
      return createAssistantMessageEventStream() // Fixture deliberately ignores cancellation.
    }})
    id = (await runtime.create()).id
    const running = runtime.run(id, 'Fixture request')
    await dispatched
    if (cancel) runtime.cancel(id)
    const result = await running
    expect(result.status).toBe(cancel ? 'cancelled' : 'failed')
    expect(Object.values(result.session.modelRequests!)[0]?.status).toBe('unknown')
    expect(() => assertSessionAccountingComplete(result.session)).toThrow('unresolved usage')
    const restarted = new PiRuntime({store, streamFn: () => {calls++; throw new Error('Must not dispatch')}})
    const retried = await restarted.run(id, 'Continue')
    expect(retried.status).toBe('failed'); expect(retried.error).toContain('unresolved usage'); expect(calls).toBe(1)
  }
})

test('crashed dispatched request becomes unknown across SQLite reopen without resetting known spend or replaying', async () => {
  const path = `/private/tmp/autofold-request-ledger-${crypto.randomUUID()}.sqlite`
  const store = new SqliteSessionStore(path), runtime = new PiRuntime({store})
  const session = await runtime.create()
  session.status = 'running'; session.usage = {turns: 3, toolCalls: 1, costUsd: .11776617}
  session.modelRequests = {req_interrupted: {status:'dispatched', model:session.modelSelection, purpose:'compaction', startedAt:Date.now()}}
  await store.save(session); store.close()
  const reopened = new SqliteSessionStore(path)
  try {
    const recovered = await new PiRuntime({store:reopened}).resume(session.id)
    expect(recovered.status).toBe('failed'); expect(recovered.usage.costUsd).toBe(.11776617)
    expect(recovered.modelRequests!.req_interrupted!.status).toBe('unknown')
    expect(() => assertSessionAccountingComplete(recovered)).toThrow('unresolved usage')
    expect((await reopened.events(session.id)).at(-1)?.data).toMatchObject({interruptedModelRequests:['req_interrupted']})
  } finally {
    reopened.close()
    const {rm} = await import('node:fs/promises'); await Promise.all([path,`${path}-wal`,`${path}-shm`].map(file=>rm(file,{force:true})))
  }
})

test('failure to durably settle provider billing leaves the dispatched request and prevents tool effects', async () => {
  class FailingStore extends MemorySessionStore {
    override async save(session: Parameters<MemorySessionStore['save']>[0], event?: Parameters<MemorySessionStore['save']>[1], owner?: string) {
      if (event?.type === 'model_request_settled') throw new Error('Fixture usage checkpoint unavailable')
      return super.save(session,event,owner)
    }
  }
  const store = new FailingStore(); let effects = 0
  const runtime = new PiRuntime({store,streamFn:scripted(message([call('write')],'toolUse',.03)),tools:[writeTool(async()=>{effects++})]})
  const session = await runtime.create()
  await expect(runtime.run(session.id,'Fixture')).rejects.toThrow('Fixture usage checkpoint unavailable')
  expect(effects).toBe(0)
  const durable = (await store.get(session.id))!
  expect(Object.values(durable.modelRequests!)[0]?.status).toBe('dispatched')
  expect(durable.usage.costUsd).toBe(0)
  expect(() => assertSessionAccountingComplete(durable)).toThrow('unresolved usage')
})

test('provider final usage settles atomically before tools; missing or invalid terminal usage blocks scientific effects', async () => {
  for (const reported of [0, .03, undefined, NaN, -1]) {
    const store = new MemorySessionStore(); let effects = 0, id = ''
    const final = message([call('write_after_receipt')], 'toolUse', reported ?? 0)
    if (reported === undefined) delete (final as any).usage
    const runtime = new PiRuntime({store, stopToolNames:['write'], streamFn: scripted(final), tools:[writeTool(async () => {
      const durable = (await store.get(id))!
      expect(Object.values(durable.modelRequests!)[0]?.status).toBe('settled')
      expect(durable.usage.costUsd).toBe(reported!)
      effects++; return {saved:true}
    })]})
    id = (await runtime.create()).id
    const result = await runtime.run(id, 'Fixture')
    if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
      expect(effects).toBe(1); expect(() => assertSessionAccountingComplete(result.session)).not.toThrow()
    } else {
      expect(effects).toBe(0); expect(result.status).toBe('failed')
      expect(() => assertSessionAccountingComplete(result.session)).toThrow('unresolved usage')
    }
  }
})

test('SDK transport error default zero usage stays unknown while an explicit successful zero receipt settles', async () => {
  for (const stopReason of ['error','stop'] as const) {
    const final = message([{type:'text',text:'Fixture'}],stopReason)
    final.usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
    const runtime = new PiRuntime({store:new MemorySessionStore(),streamFn:scripted(final)})
    const result = await runtime.run((await runtime.create()).id,'Fixture')
    expect(Object.values(result.session.modelRequests!)[0]?.status).toBe(stopReason === 'error' ? 'unknown' : 'settled')
  }
})

test('fresh host authority gates every provider boundary and denial before intent consumes no request or scientific effect', async () => {
  const store = new MemorySessionStore(); let calls = 0, effects = 0, authorizations = 0
  const runtime = new PiRuntime({store,tools:[writeTool(async()=>{effects++})],
    authorizeModelRequest: (request,signal) => {expect(signal.aborted).toBe(false);expect(request.purpose).toBe('turn');authorizations++;throw new Error('Fixture ancestor authority expired')},
    streamFn: () => {calls++;return createAssistantMessageEventStream()}})
  const result = await runtime.run((await runtime.create()).id,'Fixture')
  expect(result.status).toBe('failed'); expect(result.error).toContain('Fixture ancestor authority expired')
  expect(calls).toBe(0);expect(effects).toBe(0);expect(authorizations).toBe(1)
  expect(result.session.usage.turns).toBe(0);expect(result.session.modelRequests).toEqual({})

  const observed: string[] = []
  const allowed = new PiRuntime({store:new MemorySessionStore(),tools:[writeTool(async()=>({saved:true}))],authorizeModelRequest:request=>{observed.push(request.purpose)},
    streamFn:scripted(message([call('allowed')],'toolUse'),message([{type:'text',text:'Done'}]))})
  const completed = await allowed.run((await allowed.create()).id,'Fixture')
  expect(completed.status).toBe('completed');expect(completed.session.usage.turns).toBe(2)
  expect(observed).toEqual(['turn','turn','turn','turn'])
})

test('authority revoked during the durable dispatch checkpoint proves no transport and does not invent a zero billing receipt', async () => {
  let checks = 0, calls = 0
  const runtime = new PiRuntime({store:new MemorySessionStore(),authorizeModelRequest:()=>{if (++checks===2)throw new Error('Fixture replaced epoch')},streamFn:()=>{calls++;throw new Error('Must not dispatch')}})
  const result = await runtime.run((await runtime.create()).id,'Fixture')
  expect(result.status).toBe('failed');expect(result.error).toContain('Fixture replaced epoch');expect(calls).toBe(0)
  const request = Object.values(result.session.modelRequests!)[0]!
  expect(request.status).toBe('not_dispatched');expect(request.reportedCostUsd).toBeUndefined();expect(result.session.usage.turns).toBe(0)
  expect(() => assertSessionAccountingComplete(result.session)).not.toThrow()
})
