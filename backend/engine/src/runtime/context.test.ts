import {afterEach, expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import type {AgentTool, StreamFn} from '@earendil-works/pi-agent-core'
import {createAssistantMessageEventStream, type AssistantMessage, type Context} from '@earendil-works/pi-ai'
import {Type} from 'typebox'
import {MemorySessionStore, SqliteSessionStore, PiRuntime, DEFAULT_MODEL, contextRangeHash, estimateContextInput} from './index'
import type {PiSessionStore} from './types'

const model = {...DEFAULT_MODEL, contextWindow: 14000}
const selection = {provider: model.provider, modelId: model.id, model}
const policy = {maxInputTokens: 10000, reserveTokens: 2000, keepRecentTokens: 2500}
const originalIntent = 'Investigate the frozen target. Preserve uncertainty; no extra compute without authorization.'
const paths: string[] = []
afterEach(async () => {for (const path of paths.splice(0)) await Promise.all([path, path + '-wal', path + '-shm'].map(file => fs.rm(file, {force: true})))})
function assistant(content: AssistantMessage['content'], cost = 0, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
    usage: {input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
      cost: {input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost}}}
}
function answer(value: AssistantMessage) {
  const stream = createAssistantMessageEventStream()
  stream.push({type: 'start', partial: value})
  if (value.stopReason === 'error' || value.stopReason === 'aborted') stream.push({type: 'error', reason: value.stopReason, error: value})
  else stream.push({type: 'done', reason: value.stopReason as 'stop' | 'toolUse' | 'length', message: value})
  stream.end(value); return stream
}
function summaryRequest(context: Context) {
  return context.messages.some(message => message.role === 'user' && (JSON.stringify(message.content).includes('<conversation>') || JSON.stringify(message.content).includes('# Conversation')))
}
const semanticSummary = '## Goal\nInvestigate the frozen target.\n## Constraints & Preferences\nPreserve uncertainty.\n## Progress\nVerified historical receipts remain in their exact archive.\n## Key Decisions\nReconcile evidence before further actions.\n## Next Steps\nContinue the bounded investigation.\n## Critical Context\nAssistant interpretations are not measurements.'
function pairIntegrity(context: Context) {
  const calls = new Set<string>()
  for (const message of context.messages) {
    if (message.role === 'assistant') {
      expect(calls.size).toBe(0)
      for (const part of message.content) if (part.type === 'toolCall') calls.add(part.id)
    } else if (message.role === 'toolResult') expect(calls.delete(message.toolCallId)).toBe(true)
  }
  expect(calls.size).toBe(0)
}
async function seed(runtime: PiRuntime, store: PiSessionStore, count = 45) {
  const session = await runtime.create()
  // A legacy v1 transcript has no SDK tree yet.
  delete session.sdk
  session.messages = [{role: 'system', content: 'Immutable host instructions: measurement authority remains in verified receipts.', timestamp: 1},
    {role: 'user', content: originalIntent, timestamp: 2}]
  for (let index = 0; index < count; index++) session.messages.push(
    assistant([{type: 'toolCall', id: 'old_' + index, name: 'write', arguments: {value: 'Historical bounded request ' + index}}], 0, 'toolUse'),
    {role: 'toolResult', toolCallId: 'old_' + index, toolName: 'write', isError: false, timestamp: index + 4,
      content: [{type: 'text', text: 'Exact archived scientific tool text ' + index + ': ' + 'evidence '.repeat(80)}]},
    assistant([{type: 'text', text: 'Historical interpretation ' + index + ': ' + 'uncertain '.repeat(25)}]))
  await store.save(session); return session
}
function writeTool(execute: (id: string) => Promise<void>, receipt = 'Verified '.repeat(500)): AgentTool<any> {
  return {name: 'write', label: 'Write', description: 'Offline bounded fixture', parameters: Type.Object({value: Type.String()}, {additionalProperties: false}),
    execute: async id => {await execute(id); return {content: [{type: 'text', text: receipt}], details: {saved: true}}}}
}

test('SDK semantic summaries reset active context, preserve complete groups and archives, and count all inference', async () => {
  const store = new MemorySessionStore(), requests: Context[] = []
  let sessionId = '', effects = 0, turn = 0, summaries = 0, latestPrompt = ''
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy,
    tools: [writeTool(async id => {
      const durable = (await store.get(sessionId))!
      expect(durable.pendingTools[id]).toBeDefined()
      expect(durable.sdk!.entries.some(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.content.some(part => part.type === 'toolCall' && part.id === id))).toBe(true)
      effects++
    })], streamFn: async (_model, context, options) => {
      if (summaryRequest(context)) expect(options?.maxTokens).toBe(1600)
      else expect(options?.maxTokens).toBeUndefined()
      if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}], 0.01))}
      expect(await estimateContextInput(context)).toBeLessThanOrEqual(policy.maxInputTokens)
      expect(context.messages.some(message => message.role === 'user' && message.content === originalIntent)).toBe(true)
      expect(context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(latestPrompt))).toBe(true)
      pairIntegrity(context); requests.push(structuredClone(context))
      const index = turn++
      return answer(index % 2 === 0 ? assistant([{type: 'toolCall', id: 'new_' + index, name: 'write', arguments: {value: 'bounded'}}], 0.01, 'toolUse') :
        assistant([{type: 'text', text: 'Bounded finding remains uncertain. ' + 'interpretation '.repeat(100)}], 0.01))
    }})
  const seeded = await seed(runtime, store); sessionId = seeded.id
  for (let index = 0; index < 10; index++) {
    latestPrompt = 'Continue the same bounded investigation ' + index
    const result = await runtime.run(sessionId, latestPrompt)
    expect(result.error).toBeUndefined(); expect(result.status).toBe('completed')
    expect(result.session.messages.slice(0, seeded.messages.length)).toEqual(seeded.messages)
  }
  const saved = (await store.get(sessionId))!, events = await store.events(sessionId)
  expect(requests).toHaveLength(20); expect(effects).toBe(10); expect(summaries).toBeGreaterThan(1)
  expect(saved.usage.turns).toBe(20 + summaries); expect(saved.usage.toolCalls).toBe(10)
  expect(saved.usage.costUsd).toBeCloseTo((20 + summaries) * 0.01)
  expect(saved.sdk!.entries.filter(entry => entry.type === 'compaction')).toHaveLength(saved.contextCompactions!.length)
  expect(events.filter(event => event.type === 'context_compacted')).toHaveLength(saved.contextCompactions!.length)
  for (const checkpoint of saved.contextCompactions!) {
    expect(checkpoint.summary).toContain('## Goal')
    expect(checkpoint.estimatedTokensAfter).toBeLessThanOrEqual(checkpoint.inputBudget)
    expect(contextRangeHash(JSON.stringify(saved.messages.slice(0, checkpoint.originalRange.end)))).toBe(checkpoint.sha256)
  }
  expect(saved.contextCompactions!.at(-1)!.estimatedTokensBefore).toBeLessThan(15000)
})

test('host authority gates compaction provider effects before any request debit or summary dispatch', async () => {
  const store = new MemorySessionStore(); let calls = 0; const purposes: string[] = []
  const runtime = new PiRuntime({store,modelSelection:selection,contextPolicy:policy,
    authorizeModelRequest:request=>{purposes.push(request.purpose);throw new Error('Fixture summary grant expired')},
    streamFn:()=>{calls++;return answer(assistant([{type:'text',text:semanticSummary}]))}})
  const session = await seed(runtime,store)
  const result = await runtime.run(session.id,'Continue')
  expect(result.status).toBe('failed');expect(calls).toBe(0);expect(purposes).toEqual(['compaction'])
  expect(result.session.usage.turns).toBe(0);expect(result.session.modelRequests).toEqual({});expect(result.session.contextCompactions).toBeUndefined()
})

test('exact scoped archives and authoritative SDK compaction entries survive SQLite reopen without another summary', async () => {
  const file = '/private/tmp/autofold-context-' + crypto.randomUUID() + '.sqlite'; paths.push(file)
  const store = new SqliteSessionStore(file)
  let summaries = 0
  const streamFn: StreamFn = (_model, context) => {
    if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
    return answer(assistant([{type: 'text', text: 'Bounded continuation.'}]))
  }
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn})
  const session = await seed(runtime, store), result = await runtime.run(session.id, 'Continue')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(summaries).toBeGreaterThan(0)
  const initialSummaries=summaries
  const checkpoint = result.session.contextCompactions![0]!, expected = JSON.stringify(result.session.messages.slice(0, checkpoint.originalRange.end))
  store.close()
  const reopenedStore = new SqliteSessionStore(file)
  try {
    const reopened = new PiRuntime({store: reopenedStore, modelSelection: selection, contextPolicy: policy, streamFn})
    const resumed = await reopened.resume(session.id)
    expect(resumed.sdk).toEqual(result.session.sdk)
    expect((await reopened.run(session.id, 'Continue after reopen')).status).toBe('completed'); expect(summaries).toBe(initialSummaries)
    let offset = 0, text = ''
    while (true) {const page = await reopened.readContextArchive(session.id, {archiveId: checkpoint.id, offset, limit: 997}); text += page.content; if (page.nextOffset === null) break; offset = page.nextOffset}
    expect(text).toBe(expected); expect(contextRangeHash(text)).toBe(checkpoint.sha256)
    const another = await reopened.create()
    await expect(reopened.readContextArchive(another.id, {archiveId: checkpoint.id})).rejects.toThrow('does not belong')
    await expect(reopened.readContextArchive(session.id, {archiveId: checkpoint.id, path: '/etc/passwd'} as never)).rejects.toThrow('Invalid session context archive arguments')
    const changed = (await reopenedStore.get(session.id))!; changed.messages[1] = {role: 'user', content: 'Changed', timestamp: 2}; await reopenedStore.save(changed)
    await expect(reopened.readContextArchive(session.id, {archiveId: checkpoint.id})).rejects.toThrow('source hash changed')
  } finally {reopenedStore.close()}
})

test('about 130k tokens do not compact early in the selected million-token model', async () => {
  const store = new MemorySessionStore(); let summaries = 0
  const runtime = new PiRuntime({store, streamFn: (_model, context) => {
    if (summaryRequest(context)) summaries++
    expect(JSON.stringify(context.messages)).toContain('large prior reference')
    return answer(assistant([{type: 'text', text: 'Complete.'}]))
  }})
  const session = await runtime.create(); session.messages.push(assistant([{type: 'text', text: 'large prior reference ' + 'x'.repeat(520000)}])); delete session.sdk; await store.save(session)
  expect((await runtime.run(session.id, 'Continue')).status).toBe('completed'); expect(summaries).toBe(0)
})

test('summary inference participates in both per-run request and cost limits before scientific effects', async () => {
  for (const limits of [{maxTurns: 1}, {maxCostUsd: 0.01}]) {
    const store = new MemorySessionStore(); let requests = 0, effects = 0
    const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, limits,
      tools: [writeTool(async () => {effects++})], streamFn: (_model, context) => {
        requests++; expect(summaryRequest(context)).toBe(true)
        return answer(assistant([{type: 'text', text: semanticSummary}], 0.02))
      }})
    const session = await seed(runtime, store), result = await runtime.run(session.id, 'Continue')
    expect(result.status).toBe('limit_reached'); expect(requests).toBe(1); expect(effects).toBe(0)
    expect(result.session.usage).toMatchObject({turns: 1, costUsd: 0.02})
  }
})

test('unknown interrupted scientific tool outcomes are reconciled and never replayed through SDK reconstruction', async () => {
  const store = new MemorySessionStore(); let effects = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, tools: [writeTool(async () => {effects++})],
    streamFn: (_model, context) => {
      if (summaryRequest(context)) return answer(assistant([{type: 'text', text: semanticSummary}]))
      pairIntegrity(context)
      expect(context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'uncertain')).toMatchObject({isError: true})
      return answer(assistant([{type: 'text', text: 'Reconcile first.'}]))
    }})
  const session = await seed(runtime, store); session.status = 'running'
  session.messages.push(assistant([{type: 'toolCall', id: 'uncertain', name: 'write', arguments: {value: 'unknown'}}], 0, 'toolUse'))
  session.pendingTools.uncertain = {name: 'write', args: {}, startedAt: Date.now()}; await store.save(session)
  const result = await runtime.run(session.id, 'Reconcile')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(effects).toBe(0)
  expect(result.session.pendingTools).toEqual({})
})

test('cancellation after atomic SDK compaction checkpoint prevents continuation dispatch', async () => {
  const store = new MemorySessionStore(); let requests = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: (_model, context) => {
    requests++; expect(summaryRequest(context)).toBe(true)
    return answer(assistant([{type: 'text', text: semanticSummary}], 0.02))
  }})
  const session = await seed(runtime, store), result = await runtime.run(session.id, 'Continue', {onEvent: async event => {
    if (event.type === 'context_compacted') {expect((await store.get(session.id))!.sdk!.entries.some(entry => entry.type === 'compaction')).toBe(true); runtime.cancel(session.id)}
  }})
  expect(result.status).toBe('cancelled'); expect(requests).toBeGreaterThan(0); expect(result.session.usage.costUsd).toBeCloseTo(requests*0.02)
  expect(Object.values(result.session.modelRequests!).filter(request=>request.purpose==='compaction'&&request.status==='settled')).toHaveLength(requests)
})

test('failed or tool-bearing summaries never become durable compaction checkpoints', async () => {
  for (const reason of ['length', 'toolUse', 'error'] as const) {
    const store = new MemorySessionStore(); let requests = 0
    const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: () => {
      requests++; return answer({...assistant(reason === 'toolUse' ? [{type: 'toolCall', id: 'bad-summary', name: 'write', arguments: {}}] : [{type: 'text', text: 'partial'}], 0.01, reason), errorMessage: 'summary failure'})
    }})
    const session = await seed(runtime, store), result = await runtime.run(session.id, 'Continue')
    expect(result.status).toBe('failed'); expect(requests).toBe(1); expect(result.session.contextCompactions).toBeUndefined()
    expect(result.session.sdk!.entries.some(entry => entry.type === 'compaction')).toBe(false)
    expect(result.session.usage.costUsd).toBe(0.01)
  }
})

test('protected input and transformed payload fail before normal provider dispatch', async () => {
  for (const mode of ['intent', 'tools', 'transform'] as const) {
    let requests = 0
    const runtime = new PiRuntime({store: new MemorySessionStore(), modelSelection: selection, contextPolicy: mode === 'tools' ? {...policy, maxInputTokens: 500} : policy,
      tools: mode === 'tools' ? [{...writeTool(async () => {}), description: 'host schema '.repeat(1000)}] : [],
      transformContext: mode === 'transform' ? async messages => [...messages, {role: 'user', content: 'x'.repeat(60000), timestamp: 1}] : undefined,
      streamFn: () => {requests++; return answer(assistant([{type: 'text', text: 'Must not run'}]))}})
    const result = await runtime.run((await runtime.create()).id, mode === 'intent' ? 'x'.repeat(60000) : 'Work')
    expect(result.status).toBe('failed'); expect(requests).toBe(0)
  }
})

test('latest oversized receipt remains original while a bounded artifact card permits continuation', async () => {
  const store = new MemorySessionStore(), receipt = 'verified '.repeat(6000); let requests = 0, effects = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, tools: [writeTool(async () => {effects++}, receipt)],
    streamFn: (_model,context) => {requests++; if(requests===1)return answer(assistant([{type: 'toolCall', id: 'receipt', name: 'write', arguments: {value: 'measure'}}], 0, 'toolUse'))
      expect(JSON.stringify(context.messages)).toContain('artifact_reference_only');expect(JSON.stringify(context.messages)).not.toContain(receipt)
      return answer(assistant([{type:'text',text:'Receipt can be rehydrated.'}]))}})
  const result = await runtime.run((await runtime.create()).id, 'Work')
  expect(result.status).toBe('completed');expect(requests).toBe(2);expect(effects).toBe(1)
  expect(result.session.messages.find(message=>message.role==='toolResult'&&message.toolCallId==='receipt')).toMatchObject({content:[{type:'text',text:receipt}]})
  expect(result.session.sdk?.entries.some(entry=>entry.type==='context_edit')).toBe(true)
})

test('default coding tools, skills, extensions and operator context are absent from SDK sessions', async () => {
  const runtime = new PiRuntime({store: new MemorySessionStore(), systemPrompt: 'Host policy only.', tools: [{...writeTool(async () => {}), name: 'scientific_measure'}],
    streamFn: (_model, context) => {
      const declaration = context.messages.flatMap(message => message.role === 'system' ? message.toolsAdded ?? [] : [])
      expect(declaration.map(tool => tool.name).sort()).toEqual(['read_context_archive', 'read_tool_artifact','scientific_measure'])
      expect(JSON.stringify(context.messages)).not.toContain('AGENTS.md')
      return answer(assistant([{type: 'text', text: 'Complete.'}]))
    }})
  expect((await runtime.run((await runtime.create()).id, 'Work')).status).toBe('completed')
})


test('one original prompt can run many autonomous tool groups and compact without losing its latest action', async () => {
  const store = new MemorySessionStore(); let normal = 0, summaries = 0, effects = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, limits: {maxTurns: 40, maxToolCalls: 30},
    tools: [writeTool(async () => {effects++})], streamFn: (_model, context) => {
      if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
      pairIntegrity(context)
      expect(context.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('One autonomous investigation'))).toBe(true)
      const index = normal++
      if (index > 0) expect(context.messages.findLast(m => m.role === 'toolResult')).toMatchObject({toolCallId: 'loop_' + (index - 1)})
      return answer(index < 18 ? assistant([{type: 'toolCall', id: 'loop_' + index, name: 'write', arguments: {value: 'bounded'}}], 0, 'toolUse') : assistant([{type: 'text', text: 'Complete.'}]))
    }})
  const result = await runtime.run((await runtime.create()).id, 'One autonomous investigation')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(effects).toBe(18)
  expect(summaries).toBeGreaterThan(1); expect(result.session.messages.filter(m => m.role === 'user')).toHaveLength(1)
})

test('SDK-native context overflow gets one compact-and-retry and saves its checkpoint before continuation', async () => {
  const store = new MemorySessionStore(); let normal = 0, summaries = 0, id = ''
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: async (_model, context) => {
    if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
    if (normal++ === 0) return answer({...assistant([], 0.01, 'error'), errorMessage: 'maximum context length exceeded'})
    expect((await store.get(id))!.contextCompactions!.length).toBeGreaterThan(0)
    expect((await store.events(id)).some(event => event.type === 'context_compacted')).toBe(true)
    return answer(assistant([{type: 'text', text: 'Recovered.'}], 0.01))
  }})
  id = (await seed(runtime, store, 15)).id
  const result = await runtime.run(id, 'Continue')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(normal).toBe(2); expect(summaries).toBeGreaterThan(0)
  expect(result.session.usage.turns).toBe(normal + summaries)
  const resumed = await runtime.resume(id); expect(resumed.sdk!.entries.some(entry => entry.type === 'context_edit')).toBe(true)
})

test('a failed compaction save poisons the run and leaves no checkpoint hidden under run_finished', async () => {
  class FailingStore extends MemorySessionStore {
    override async save(session: Parameters<MemorySessionStore['save']>[0], event?: Parameters<MemorySessionStore['save']>[1], owner?: string) {
      if (event?.type === 'context_compacted') throw new Error('Transient checkpoint fixture failure')
      return super.save(session, event, owner)
    }
  }
  const store = new FailingStore(); let requests = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: (_model, context) => {
    requests++; expect(summaryRequest(context)).toBe(true); return answer(assistant([{type: 'text', text: semanticSummary}]))
  }})
  const session = await seed(runtime, store)
  await expect(runtime.run(session.id, 'Continue')).rejects.toThrow('Transient checkpoint fixture failure')
  const saved = (await store.get(session.id))!, events = await store.events(session.id)
  expect(saved.contextCompactions).toBeUndefined(); expect(saved.sdk!.entries.some(entry => entry.type === 'compaction')).toBe(false)
  expect(events.some(event => event.type === 'run_finished')).toBe(false); expect(requests).toBeGreaterThan(0)
  expect(Object.values(saved.modelRequests!).filter(request=>request.purpose==='compaction'&&request.status==='settled')).toHaveLength(requests)
  expect((await runtime.resume(session.id)).status).toBe('failed')
})

test('an explicit empty host credential callback cannot fall back to an ambient provider key', async () => {
  const previous = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'ambient-fixture-key'
  let requests = 0
  try {
    const runtime = new PiRuntime({store: new MemorySessionStore(), getApiKey: () => undefined,
      streamOptions: {onPayload: () => {requests++; throw new Error('ambient key used')}}})
    const result = await runtime.run((await runtime.create()).id, 'Work')
    expect(result.status).toBe('failed'); expect(requests).toBe(0); expect(result.session.usage.turns).toBe(0)
  } finally {if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous}
})


test('native overflow recovery is bounded even when the retry also overflows', async () => {
  const store = new MemorySessionStore(); let normal = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: (_model, context) => {
    if (summaryRequest(context)) return answer(assistant([{type: 'text', text: semanticSummary}]))
    normal++; return answer({...assistant([], 0, 'error'), errorMessage: 'maximum context length exceeded'})
  }})
  const session = await seed(runtime, store, 15), result = await runtime.run(session.id, 'Continue')
  expect(result.status).toBe('failed'); expect(normal).toBe(2); expect(result.error).toContain('one compact-and-retry')
})

test('leases and inference deadlines remain active during semantic summarization', async () => {
  class ObservedStore extends MemorySessionStore {
    renewals = 0
    override async renewLease(id: string, owner: string, ttl: number) {this.renewals++; return super.renewLease(id, owner, ttl)}
  }
  const store = new ObservedStore(); let started = false, providerSignal: AbortSignal | undefined
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, leaseDurationMs: 100, leaseHeartbeatMs: 20, modelRequestTimeoutMs: 100,
    streamFn: (_model, context, options) => {expect(summaryRequest(context)).toBe(true); started = true; providerSignal = options?.signal; return createAssistantMessageEventStream()}})
  const session = await seed(runtime, store), result = await runtime.run(session.id, 'Continue')
  expect(started).toBe(true); expect(result.status).toBe('failed'); expect(result.error).toContain('Model request deadline exceeded')
  expect(store.renewals).toBeGreaterThanOrEqual(3); expect(providerSignal?.aborted).toBe(true)
  expect(result.session.contextCompactions).toBeUndefined()
})


test('an empty host prompt does not inherit the SDK coding prompt or documentation resources', async () => {
  for (const systemPrompt of [undefined, '']) {
    const runtime = new PiRuntime({store: new MemorySessionStore(), systemPrompt, streamFn: (_model, context) => {
      const payload = JSON.stringify(context.messages)
      expect(payload).not.toContain('expert coding assistant')
      expect(payload).not.toContain('Pi documentation')
      expect(payload).not.toContain('docs/sdk.md')
      return answer(assistant([{type: 'text', text: 'Complete.'}]))
    }})
    expect((await runtime.run((await runtime.create()).id, 'Work')).status).toBe('completed')
  }
})


test('semantic summarization obeys the host hard input ceiling as well as the selected window', async () => {
  const store = new MemorySessionStore(), hardLimit = 10000; let summaryCalls = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: {...policy, maxInputTokens: hardLimit},
    streamFn: async (_model, context) => {
      expect(await estimateContextInput(context)).toBeLessThanOrEqual(hardLimit)
      if (summaryRequest(context)) {summaryCalls++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
      return answer(assistant([{type: 'text', text: 'Continued.'}]))
    }})
  const session = await seed(runtime, store), result = await runtime.run(session.id, 'Continue')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(summaryCalls).toBeGreaterThan(1)
})

test('native overflow validates all exact human instructions before another summary', async () => {
  const store = new MemorySessionStore(); let summaries = 0, normal = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: {...policy, reserveTokens: 12500},
    streamFn: (_model, context) => {
      if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
      normal++; return answer({...assistant([], 0, 'error'), errorMessage: 'maximum context length exceeded'})
    }})
  const session = await runtime.create()
  // The SDK checks pre-prompt overflow before sending the newest instruction.
  // It must reserve the explicit output capacity while protecting that receipt.
  session.messages.push({role: 'user', content: 'Inspect '+ 'human requirement '.repeat(400), timestamp: 1},
    assistant([{type: 'toolCall', id: 'prior', name: 'write', arguments: {value: 'bounded'}}], 0, 'toolUse'),
    {role: 'toolResult', toolCallId: 'prior', toolName: 'write', content: [{type: 'text', text: 'receipt '.repeat(900)}], isError: false, timestamp: 2},
    {...assistant([], 0, 'error'), errorMessage: 'maximum context length exceeded', timestamp: 3})
  delete session.sdk; await store.save(session)
  const result = await runtime.run(session.id, 'Continue')
  expect(result.status).toBe('failed'); expect(result.error).toContain('protected context exceeds model input budget')
  expect(normal).toBe(0); expect(summaries).toBe(0)
})


test('native overflow may summarize old tool groups while preserving exact original receipts', async () => {
  const store = new MemorySessionStore(), receipt = 'Exact protected scientific receipt: ' + 'x'.repeat(14000)
  let normal = 0, summaries = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: (_model, context) => {
    if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
    pairIntegrity(context)
    if (normal++ === 0) return answer({...assistant([], 0, 'error'), errorMessage: 'maximum context length exceeded'})
    expect(context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'protected_receipt')).toBeUndefined()
    expect(context.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Latest instruction'))).toBe(true)
    return answer(assistant([{type: 'text', text: 'Recovered with exact scientific evidence.'}]))
  }})
  const session = await runtime.create(); delete session.sdk
  session.messages.push({role: 'user', content: 'Original bounded research task', timestamp: 1},
    assistant([{type: 'text', text: 'Older progress: ' + 'uncertain '.repeat(100)}]),
    assistant([{type: 'toolCall', id: 'protected_receipt', name: 'old_scientific_measure', arguments: {}}], 0, 'toolUse'),
    {role: 'toolResult', toolCallId: 'protected_receipt', toolName: 'old_scientific_measure', content: [{type: 'text', text: receipt}], isError: false, timestamp: 2},
    assistant([{type: 'text', text: 'Newer analysis: uncertainty remains.'}]))
  await store.save(session)
  const result = await runtime.run(session.id, 'Latest instruction: reconcile the protected receipt')
  expect(result.error).toBeUndefined(); expect(result.status).toBe('completed'); expect(normal).toBe(2); expect(summaries).toBeGreaterThan(0)
})


test('native overflow remains bounded after an original tool group becomes removable', async () => {
  const store = new MemorySessionStore(), receipt = 'Exact protected receipt: ' + 'x'.repeat(14000)
  let normal = 0, summaries = 0, sessionId = ''
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: async (_model, context) => {
    if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
    const message = {...assistant([], 0, 'error'), errorMessage: 'maximum context length exceeded'}
    if (normal++ > 0) {
      const compaction = (await store.get(sessionId))?.sdk?.entries.findLast(entry => entry.type === 'compaction')
      expect(compaction).toBeDefined()
      // A synchronous mock response can share the checkpoint millisecond. Pi
      // correctly treats that timestamp as a pre-compaction error, not a retry.
      message.timestamp = Math.max(message.timestamp, new Date(compaction!.timestamp).getTime() + 1)
    }
    return answer(message)
  }})
  const session = await runtime.create(); sessionId = session.id; delete session.sdk
  session.messages.push({role: 'user', content: 'Original bounded task', timestamp: 1},
    assistant([{type: 'toolCall', id: 'protected', name: 'old_scientific_measure', arguments: {}}], 0, 'toolUse'),
    {role: 'toolResult', toolCallId: 'protected', toolName: 'old_scientific_measure', content: [{type: 'text', text: receipt}], isError: false, timestamp: 2},
    assistant([{type: 'text', text: 'Newer interpretation is not a successful recovery.'}]))
  await store.save(session)
  const result = await runtime.run(session.id, 'Continue using the exact receipt')
  expect(result.status).toBe('failed'); expect(result.error).toContain('one compact-and-retry')
  expect(normal).toBe(2); expect(summaries).toBe(1)
  expect(result.session.usage).toMatchObject({turns: 3, toolCalls: 0, costUsd: 0})
  expect(result.session.contextCompactions).toHaveLength(1)
  expect(Object.values(result.session.modelRequests ?? {}).map(request => [request.purpose, request.status])).toEqual([['turn', 'settled'], ['compaction', 'settled'], ['turn', 'settled']])
  expect(result.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'protected')).toMatchObject({content: [{type: 'text', text: receipt}]})
})


test('native usage threshold skips a fitting exact payload without a second summary policy', async()=>{
  const store=new MemorySessionStore();let summaries=0
  const runtime=new PiRuntime({store,modelSelection:selection,contextPolicy:policy,streamFn:(_model,context)=>{
    if(summaryRequest(context)){summaries++;return answer(assistant([{type:'text',text:semanticSummary}]))}
    const message=assistant([{type:'text',text:'Small exact projection despite stale high usage.'}]);message.usage.input=13500;message.usage.totalTokens=13502
    return answer(message)
  }})
  const result=await runtime.run((await runtime.create()).id,'One small bounded task')
  expect(result.status).toBe('completed');expect(result.error).toBeUndefined();expect(summaries).toBe(0)
  expect(result.session.contextCompactions).toBeUndefined()
})

test('exact-payload and native usage triggers share one checkpoint and cut at the same boundary',async()=>{
  const store=new MemorySessionStore();let normal=0,summaries=0,id=''
  const runtime=new PiRuntime({store,modelSelection:selection,contextPolicy:policy,streamFn:async(_model,context)=>{
    if(summaryRequest(context)){summaries++;return answer(assistant([{type:'text',text:semanticSummary}]))}
    expect((await store.get(id))?.contextCompactions).toHaveLength(1)
    expect((await store.events(id)).filter(e=>e.type==='context_compacted')).toHaveLength(1)
    normal++;const message=assistant([{type:'text',text:'Done with the already committed safe cut.'}]);message.usage.input=13500;message.usage.totalTokens=13502
    return answer(message)
  }})
  id=(await seed(runtime,store)).id
  const result=await runtime.run(id,'Continue')
  expect(result.status).toBe('completed');expect(normal).toBe(1);expect(summaries).toBeGreaterThan(0)
  expect(result.session.contextCompactions).toHaveLength(1)
  expect(result.session.sdk?.entries.filter(e=>e.type==='compaction')).toHaveLength(1)
})


test('Pi recovers reasoning-only truncation inside the original prompt and then executes a complete tool once', async () => {
  const store = new MemorySessionStore(); let normal = 0, summaries = 0, effects = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy,
    tools: [writeTool(async id => {expect(id).toBe('complete_after_truncation'); effects++}, 'Exact saved draft')],
    streamFn: (_model, context) => {
      if (summaryRequest(context)) {summaries++; return answer(assistant([{type: 'text', text: semanticSummary}]))}
      pairIntegrity(context)
      if (normal++ === 0) {
        const truncated = assistant([{type: 'thinking', thinking: 'Incomplete reasoning, never a scientific effect.'}], .01, 'length')
        truncated.usage.output = 16384; truncated.usage.reasoning = 16384
        return answer(truncated)
      }
      if (normal === 2) return answer(assistant([{type: 'toolCall', id: 'complete_after_truncation', name: 'write', arguments: {value: 'Complete draft'}}], .01, 'toolUse'))
      return answer(assistant([{type: 'text', text: 'Draft saved after native recovery.'}], .01))
    }})
  const original = await seed(runtime, store, 15), result = await runtime.run(original.id, 'Continue the original task')
  expect(result.status).toBe('completed'); expect(result.error).toBeUndefined()
  expect(normal).toBe(3); expect(summaries).toBeGreaterThan(0); expect(effects).toBe(1)
  expect(result.session.messages.slice(0, original.messages.length)).toEqual(original.messages)
  expect(result.session.messages.filter(m => m.role === 'assistant' && m.stopReason === 'length')).toHaveLength(1)
  expect((await store.events(original.id)).filter(e => e.type === 'run_started')).toHaveLength(1)
  expect(Object.values(result.session.modelRequests!).every(r => r.status === 'settled')).toBe(true)
  expect(result.session.usage.costUsd).toBeCloseTo(.03)
})

test('Pi rejects a truncated tool call and repairs it through the ordinary tool loop', async () => {
  const store = new MemorySessionStore(); let normal = 0, effects = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy,
    tools: [writeTool(async id => {expect(id).toBe('repaired_call'); effects++}, 'Saved complete bytes')], streamFn: (_model, context) => {
      if (summaryRequest(context)) return answer(assistant([{type: 'text', text: semanticSummary}]))
      if (normal++ === 0) return answer(assistant([{type: 'toolCall', id: 'partial_call', name: 'write', arguments: {value: 'Possibly truncated'}}], 0, 'length'))
      if (normal === 2) {
        expect(context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'partial_call')).toMatchObject({isError: true})
        return answer(assistant([{type: 'toolCall', id: 'repaired_call', name: 'write', arguments: {value: 'Complete repaired bytes'}}], 0, 'toolUse'))
      }
      return answer(assistant([{type: 'text', text: 'Native repair complete'}]))
    }})
  const original = await seed(runtime, store, 15), result = await runtime.run(original.id, 'Continue')
  expect(result.status).toBe('completed'); expect(effects).toBe(1); expect(normal).toBe(3)
  expect(result.session.pendingTools).toEqual({})
  expect((await store.events(original.id)).filter(e => e.type === 'run_started')).toHaveLength(1)
})

test('Pi bounds repeated reasoning-only provider truncation without a host restart loop', async () => {
  const store = new MemorySessionStore(); let normal = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, streamFn: (_model, context) => {
    if (summaryRequest(context)) return answer(assistant([{type: 'text', text: semanticSummary}]))
    normal++; return answer(assistant([{type: 'thinking', thinking: 'Provider-truncated reasoning'}], 0, 'length'))
  }})
  const original = await seed(runtime, store, 15), result = await runtime.run(original.id, 'Continue')
  expect(result.status).toBe('failed'); expect(result.error).toContain('one compact-and-retry'); expect(normal).toBe(2)
  expect((await store.events(original.id)).filter(e => e.type === 'run_started')).toHaveLength(1)
})

test('a real request budget prevents Pi length recovery from dispatching another request', async () => {
  const store = new MemorySessionStore(); let requests = 0
  const runtime = new PiRuntime({store, modelSelection: selection, contextPolicy: policy, limits: {maxTurns: 1},
    streamFn: () => {requests++; return answer(assistant([{type: 'thinking', thinking: 'Truncated provider output'}], .01, 'length'))}})
  const original = await seed(runtime, store, 15), result = await runtime.run(original.id, 'Continue')
  expect(result.status).toBe('limit_reached'); expect(result.error).toContain('Maximum model turns')
  expect(requests).toBe(1); expect(result.session.usage.turns).toBe(1)
  expect(Object.values(result.session.modelRequests!)).toHaveLength(1)
})
