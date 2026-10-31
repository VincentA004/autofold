import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxThinking, fauxText } from '@earendil-works/pi-ai'
import { campaignCatalog } from './archives.ts'
import { readArchive } from './archive.ts'
import { LiveWorkspace } from './live.ts'
import { liveHandler } from './live-http.ts'
import type { AppEvent } from './app-types'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(slow = false) {
  const directory = await mkdtemp(join(tmpdir(), 'autofold-app-')), root = join(directory, 'saved/campaign')
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'campaign.md'), '# Saved discovery\n')
  const models = await ModelRuntime.create({ authPath: join(directory, 'agent/auth.json'), modelsPath: null, modelsStorePath: join(directory, 'models.json'), refreshOnCreate: false })
  const provider = fauxProvider(slow ? { tokensPerSecond: 50, tokenSize: { min: 1, max: 1 } } : {})
  models.registerNativeProvider(provider.provider)
  const catalog = await campaignCatalog(root, directory)
  const app = new LiveWorkspace(catalog, { archivesDirectory: directory, agentDir: join(directory, 'agent'), modelRuntime: models, model: provider.getModel() })
  cleanups.push(async () => { await app.dispose(); await rm(directory, { recursive: true, force: true }) })
  const handler = liveHandler(app)
  const request = (route: string, data?: object) => handler(new Request(`http://localhost/api/app/${route}?campaign=saved`, data === undefined ? undefined : { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(data) }))
  return { directory, root, app, provider, request, handler, models }
}
function finished(app: LiveWorkspace, events?: AppEvent[]) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(Error('Scientist did not settle')) }, 10000)
    let active = false
    const off = app.subscribe('saved', event => {
      events?.push(event)
      if (event.type !== 'state') return
      active ||= event.state.running
      if (active && !event.state.running) { off(); clearTimeout(timeout); resolve() }
    })
  })
}

test('app reads do not create an agent; mutations require same-origin and archive mode stays read-only', async () => {
  const { root, request, handler, provider } = await fixture()
  expect((await (await request('status')).json()).connected).toBe(false)
  expect((await (await request('conversation')).json()).messages).toEqual([])
  expect(provider.state.callCount).toBe(0)
  expect(await readdir(root)).toEqual(['campaign.md'])
  expect((await handler(new Request('http://localhost/api/app/session?campaign=saved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403)
  expect((await handler(new Request('http://localhost/api/app/session?campaign=saved', { method: 'POST', headers: { origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403)
  expect((await handler(new Request('http://unrelated.example/api/app/status'))).status).toBe(403)
  expect((await liveHandler()(new Request('http://localhost/api/app/session', { method: 'POST', headers: { origin: 'http://localhost' } }))).status).toBe(403)
  expect((await handler(new Request('http://localhost/api/app/status?campaign=../../outside'))).status).toBe(404)
})

test('HTTP messages stream through native Pi tools, update real archive files, and resume the same canonical history', async () => {
  const { directory, root, app, request, provider, models } = await fixture()
  const stream = await request('events'), reader = stream.body!.getReader()
  expect(stream.headers.get('content-type')).toBe('text/event-stream')
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"connected":false')
  const status = await (await request('session', {})).json()
  expect(status.running).toBe(false)
  expect(status.connected).toBe(true)
  const events: AppEvent[] = [], done = finished(app, events)
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'programs/draft.py', content: 'print("native")\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('write', { path: 'output/trials/t-ui/plan.md', content: '# A prospective question\n\n## Question\nDoes this method answer the question?\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxThinking('PRIVATE_THINKING_SHOULD_NOT_BE_EXPOSED'), fauxText('Native draft and prospective plan saved. No scientific execution was performed.')]),
  ])
  expect((await request('message', { text: 'Draft a program and record a prospective trial plan.', sessionId: status.sessionId })).status).toBe(202)
  await done
  expect(await readFile(join(root, 'programs/draft.py'), 'utf8')).toContain('native')
  expect((await readArchive(root)).trials.map(t => t.id)).toContain('t-ui')
  expect(events.some(event => event.type === 'delta')).toBe(true)
  const conversation = await (await request('conversation')).json()
  expect(conversation.messages.filter((message: any) => message.role === 'toolResult')).toHaveLength(2)
  expect(JSON.stringify(conversation)).toContain('Native draft and prospective plan saved')
  expect(JSON.stringify(conversation)).not.toContain('PRIVATE_THINKING_SHOULD_NOT_BE_EXPOSED')
  expect(JSON.stringify(events)).not.toContain('PRIVATE_THINKING_SHOULD_NOT_BE_EXPOSED')
  const path = app.status('saved').sessionPath!
  expect(path).toStartWith('.autofold/sessions/')
  const resumed = await (await request('session', { path })).json()
  expect(resumed.sessionId).toBe(status.sessionId)
  expect(resumed.running).toBe(false)
  expect((await request('message', { text: 'Stale tab', sessionId: 'wrong' })).status).toBe(409)
  expect((await request('session', { path: '../../outside.jsonl' })).status).toBe(400)
  await reader.cancel()
  const catalog = app.catalog
  await app.dispose()
  const reopened = new LiveWorkspace(catalog, { modelRuntime: models, agentDir: join(directory, 'agent'), model: provider.getModel() })
  try {
    const restored = await reopened.start('saved', path)
    expect(restored.sessionId).toBe(status.sessionId)
    expect(reopened.conversation('saved').messages.filter(message => message.role === 'toolResult')).toHaveLength(2)
    const fresh = await reopened.start('saved', undefined, true)
    expect(fresh.sessionId).not.toBe(status.sessionId)
    expect(reopened.conversation('saved').messages).toHaveLength(0)
  } finally { await reopened.dispose() }
}, 15000)

test('stop cancels a native streaming turn and concurrent messages or model changes are rejected', async () => {
  const { app, provider, request } = await fixture(true)
  const status = await (await request('session', {})).json()
  provider.setResponses([fauxAssistantMessage('Streaming response. '.repeat(200))])
  const done = finished(app)
  const streaming = new Promise<void>(resolve => { const off = app.subscribe('saved', event => { if (event.type === 'delta') { off(); resolve() } }) })
  await request('message', { text: 'Start streaming', sessionId: status.sessionId })
  await streaming
  expect((await request('message', { text: 'Duplicate', sessionId: status.sessionId })).status).toBe(409)
  expect((await request('model', { thinking: 'high' })).status).toBe(409)
  expect((await request('stop', {})).status).toBe(200)
  await done
  expect(app.status('saved').running).toBe(false)
}, 15000)

test('new campaigns, uploads, and settings use existing Pi state and stay within their campaign', async () => {
  const { directory, root, provider, request, app } = await fixture()
  const created = await (await request('campaigns', { title: 'New target', brief: 'Design under a bounded budget.' })).json()
  expect(created.id).toStartWith('research-')
  expect(app.catalog.publicCatalog.campaigns.some(entry => entry.id === created.id)).toBe(true)
  expect(await readFile(join(directory, created.id, 'campaign/campaign.md'), 'utf8')).toContain('bounded budget')
  expect(app.status(created.id).connected).toBe(false)
  const uploaded = await app.upload('saved', '../../sequence.fasta', new TextEncoder().encode('>target\nTEST\n'))
  expect(uploaded.path).toStartWith('inputs/attachments/')
  expect(await readFile(join(root, uploaded.path), 'utf8')).toContain('TEST')
  const status = await (await request('session', {})).json()
  expect((await request('message', { text: 'Read attached', sessionId: status.sessionId, attachments: ['../../secret'] })).status).toBe(400)
  expect(provider.state.callCount).toBe(0)
  const models = await (await request('models')).json()
  expect(models.some((model: any) => model.id === provider.getModel().id)).toBe(true)
  const configured = await (await request('model', { provider: provider.getModel().provider, model: provider.getModel().id })).json()
  expect(configured.model.id).toBe(provider.getModel().id)
  expect(configured.running).toBe(false)
  expect((await request('model', { thinking: 'invalid' })).status).toBe(400)
  await mkdir(join(root, 'outward'), { recursive: true })
  await symlink(directory, join(root, 'outward/link'))
  expect((await request('message', { text: 'Read attached', sessionId: status.sessionId, attachments: ['outward/link/models.json'] })).status).toBe(400)
})
