import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, fauxAssistantMessage as say, fauxProvider, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai'
import { createAutofold } from './index.ts'

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => say(fauxToolCall(name, args), { stopReason: 'toolUse' })
const task = (role = 'investigator') => ({ role, question: 'Inspect evidence.md and propose a discriminating next test.', evidence: ['evidence.md'] })

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'autofold-helpers-'))
  await writeFile(join(cwd, 'evidence.md'), '# Evidence\nOne predictor improved; the other disagrees.\n')
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, 'agent/auth.json'),
    modelsPath: null, modelsStorePath: join(cwd, 'models.json'), refreshOnCreate: false })
  const provider = fauxProvider()
  modelRuntime.registerNativeProvider(provider.provider)
  return { cwd, provider, options: { cwd, agentDir: join(cwd, 'agent'), modelRuntime, model: provider.getModel() } }
}

async function records(cwd: string) {
  const root = join(cwd, '.autofold/helpers')
  if (!existsSync(root)) return []
  return Promise.all((await readdir(root)).map(async id => ({ directory: join(root, id),
    result: JSON.parse(await readFile(join(root, id, 'result.json'), 'utf8')) })))
}

test('two native Pi helpers run concurrently, inherit the model and return reports without head history', async () => {
  const { cwd, provider, options } = await fixture()
  const runtime = await createAutofold(options)
  let started = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const child: FauxResponseFactory = async (context, _options, _state, model) => {
    expect(model.id).toBe(options.model.id)
    expect(model.maxTokens).toBeLessThanOrEqual(16384)
    expect(JSON.stringify(context)).not.toContain('PRIVATE_HEAD_CANARY')
    started++
    if (started === 2) release()
    await barrier
    return say('Read evidence.md; compare the parent and proposal under the second predictor before promotion.')
  }
  provider.setResponses([tool('delegate', { tasks: [task(), task('reviewer')] }), child, child, say('Reconcile reports with evidence.')])
  try {
    await runtime.session.prompt('PRIVATE_HEAD_CANARY: consult two helpers.')
    const saved = await records(cwd)
    expect(saved.map(s => s.result.reason)).toEqual([undefined, undefined])
    expect(started).toBe(2)
    expect(saved.map(s => s.result.role).sort()).toEqual(['investigator', 'reviewer'])
    for (const { result } of saved) {
      expect(result.status).toBe('completed')
      expect(existsSync(result.session)).toBe(true)
      expect(await readFile(join(cwd, result.report), 'utf8')).toContain('second predictor')
    }
    expect(await readFile(join(cwd, 'evidence.md'), 'utf8')).toContain('One predictor improved')
    expect(provider.state.callCount).toBe(4)
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
}, 10000)

test('helper cannot write, delegate recursively, or read hidden/outside/symlinked evidence', async () => {
  const { cwd, provider, options } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'autofold-helper-outside-'))
  await writeFile(join(outside, 'private.txt'), 'OUTSIDE_PRIVATE_VALUE')
  // These innocent local decoys used to pass a raw-path guard before native read
  // interpreted @ and file:// as references to a different, outside file.
  const aliases = [`@${join(outside, 'private.txt')}`, pathToFileURL(join(outside, 'private.txt')).href]
  for (const alias of aliases) {
    await mkdir(dirname(join(cwd, alias)), { recursive: true })
    await writeFile(join(cwd, alias), 'LOCAL_DECOY')
  }
  await symlink(join(outside, 'private.txt'), join(cwd, 'alias.txt'))
  const runtime = await createAutofold(options)
  provider.setResponses([
    tool('delegate', { tasks: [task('reviewer')] }),
    tool('write', { path: 'evidence.md', content: 'rewritten' }),
    tool('delegate', { tasks: [task()] }),
    tool('read', { path: 'alias.txt' }),
    tool('read', { path: '.autofold/sessions' }),
    ...aliases.map(path => tool('read', { path })),
    tool('read', { path: '@evidence.md' }),
    say('Read evidence.md; no changes executed.'), say('Reviewed.'),
  ])
  try {
    await runtime.session.prompt('Review the evidence.')
    const [{ result }] = await records(cwd)
    const transcript = await readFile(result.session, 'utf8')
    expect(transcript).not.toContain('OUTSIDE_PRIVATE_VALUE')
    expect(transcript).toContain('Helpers read non-hidden campaign evidence')
    expect(transcript).toContain('One predictor improved')
    expect(result.status).toBe('completed')
    expect(await readFile(join(cwd, 'evidence.md'), 'utf8')).not.toContain('rewritten')
    expect((await records(cwd)).length).toBe(1)
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
}, 10000)

test('task allowance survives resume and rejects a batch before allocating extra work', async () => {
  const { cwd, provider, options } = await fixture()
  let runtime = await createAutofold({ ...options, delegation: { maxTasks: 1 } })
  provider.setResponses([tool('delegate', { tasks: [task()] }), say('Bounded report.'),
    tool('delegate', { tasks: [task(), task('reviewer')] }), say('Use existing report.')])
  try {
    await runtime.session.prompt('Consult once then try to over-allocate.')
    expect((await records(cwd)).length).toBe(1)
    await runtime.dispose()
    runtime = await createAutofold({ ...options, continue: true, delegation: { maxTasks: 1 } })
    provider.setResponses([tool('delegate', { tasks: [task()] }), say('Allowance exhausted.')])
    await runtime.session.prompt('Try another helper after resume.')
    expect((await records(cwd)).length).toBe(1)
    const results = runtime.session.messages.filter(m => m.role === 'toolResult')
    expect(JSON.stringify(results)).toContain('helper allowance exhausted')
    expect(provider.state.callCount).toBe(6)
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
}, 10000)

test('estimated cost allowance and invalid evidence prevent new child calls', async () => {
  const { cwd, provider, options } = await fixture()
  const directory = join(cwd, '.autofold/helpers/previous')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'task.json'), '{}')
  await writeFile(join(directory, 'result.json'), '{}')
  await writeFile(join(directory, 'usage.json'), '{"cost":0.25}')
  const runtime = await createAutofold(options)
  provider.setResponses([tool('delegate', { tasks: [{ ...task(), evidence: ['../absent'] }] }),
    tool('delegate', { tasks: [task()] }), say('No new helper allocated.')])
  try {
    await runtime.session.prompt('Try invalid evidence and an exhausted cost allowance.')
    expect(provider.state.callCount).toBe(3)
    expect((await records(cwd)).length).toBe(1)
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
}, 10000)

test('head cancellation aborts both active helpers and preserves terminal records', async () => {
  const { cwd, provider, options } = await fixture()
  const runtime = await createAutofold(options)
  let count = 0, ready!: () => void
  const bothStarted = new Promise<void>(resolve => { ready = resolve })
  const waitForAbort: FauxResponseFactory = async (_ctx, stream) => {
    count++
    if (count === 2) ready()
    await new Promise<void>(resolve => stream!.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return say('', { stopReason: 'aborted' })
  }
  provider.setResponses([tool('delegate', { tasks: [task(), task('reviewer')] }), waitForAbort, waitForAbort])
  try {
    const prompt = runtime.session.prompt('Start two bounded helpers.')
    await bothStarted
    await runtime.session.abort()
    await prompt
    const saved = await records(cwd)
    expect(saved.length).toBe(2)
    expect(saved.every(s => s.result.status === 'limited' && s.result.reason === 'cancelled')).toBe(true)
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
}, 10000)

test('the just-finished response counts toward cost before another helper request', async () => {
  const { cwd, provider, options } = await fixture()
  const original = provider.provider.streamSimple
  options.modelRuntime.registerNativeProvider({ ...provider.provider,
    streamSimple(model, context, streamOptions) {
      const incoming = original(model, context, streamOptions)
      const output = createAssistantMessageEventStream()
      void (async () => {
        for await (const event of incoming) {
          if (event.type === 'done') event.message.usage.cost.total = 0.30
          output.push(event)
        }
        output.end(await incoming.result())
      })()
      return output
    },
  })
  const runtime = await createAutofold({ ...options, delegation: { maxCostUsd: 0.25 } })
  provider.setResponses([tool('delegate', { tasks: [task()] }),
    tool('read', { path: 'evidence.md' }), say('Helper stopped at its allowance.')])
  try {
    await runtime.session.prompt('Consult within the helper cost allowance.')
    const [{ result }] = await records(cwd)
    expect(result.status).toBe('limited')
    expect(result.reason).toBe('campaign helper cost limit')
    expect(result.cost).toBe(0.30) // The in-flight response can exceed the estimate.
    expect(provider.state.callCount).toBe(3) // Head, one helper response, head.
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
}, 10000)

test('helper timeout and turn cap return incomplete status, never a completed review', async () => {
  const { cwd, provider, options } = await fixture()
  const runtime = await createAutofold({ ...options, delegation: { maxTurns: 1, timeoutMs: 500 } })
  const waitForAbort: FauxResponseFactory = async (_ctx, stream) => {
    await new Promise<void>(resolve => stream!.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return say('', { stopReason: 'aborted' })
  }
  provider.setResponses([tool('delegate', { tasks: [task()] }), waitForAbort,
    tool('delegate', { tasks: [task('reviewer')] }), tool('read', { path: 'evidence.md' }), say('Both reports incomplete.')])
  try {
    await runtime.session.prompt('Exercise helper limits.')
    const saved = await records(cwd)
    expect(saved.length).toBe(2)
    expect(saved.map(s => s.result.reason).sort()).toEqual(['time limit', 'turn limit'])
    expect(saved.every(s => s.result.status === 'limited')).toBe(true)
  } finally { await runtime.dispose(); await rm(cwd, { recursive: true, force: true }) }
}, 10000)
