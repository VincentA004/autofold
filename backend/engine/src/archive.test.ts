import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { archivePath, jsonPointer, markdownLinks, readArchive, readArchiveSession } from './archive.ts'
import { archiveHandler } from './web.ts'
import { campaignCatalog } from './archives.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'autofold-archive-'))
  directories.push(root)
  const put = async (path: string, value: string | object) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  await put('campaign.md', '# A discovery campaign\n')
  return { root, put }
}

test('archive rejects traversal, private files, directories, and outward symlinks', async () => {
  const { root, put } = await workspace()
  const outside = await mkdtemp(join(tmpdir(), 'autofold-outside-')); directories.push(outside)
  await writeFile(join(outside, 'secret'), 'outside')
  await put('.autofold/secret.json', { secret: true })
  await symlink(join(outside, 'secret'), join(root, 'outside.txt'))
  for (const path of ['../secret', '/etc/passwd', '.autofold/secret.json', 'outside.txt', 'a\\b', 'foo/../../secret']) {
    await expect(archivePath(root, path)).rejects.toThrow()
  }
  const handler = archiveHandler(root)
  expect((await handler(new Request('http://localhost/api/archive/file?path=.autofold%2Fsecret.json'))).status).toBe(400)
  expect((await handler(new Request('http://localhost/api/archive/file?path=.', { method: 'GET' }))).status).toBe(400)
  expect((await handler(new Request('http://localhost/api/archive', { method: 'POST' }))).status).toBe(405)
  expect((await handler(new Request('http://localhost/api/archive', { headers: { origin: 'https://unrelated.example' } }))).status).toBe(403)
  expect((await handler(new Request('http://unrelated.example/api/archive'))).status).toBe(403)
})

test('link projection ignores code examples and retains exact sections, lines, and campaign-relative targets', () => {
  const text = '# Investigation\n[Evidence](../../sources/paper/article.txt)\n`[not a citation](missing)`\n```md\n[example](missing)\n```\n## Notebook navigation\n[Current](../index.md#decision)\n[Named file](<../a%20b.md>)\n[External](https://example.com)'
  expect(markdownLinks(text, 'notebook/investigations/question.md')).toEqual([
    { target: 'sources/paper/article.txt', label: 'Evidence', section: 'Investigation', line: 2 },
    { target: 'notebook/index.md', label: 'Current', section: 'Notebook navigation', line: 8 },
    { target: 'notebook/a b.md', label: 'Named file', section: 'Notebook navigation', line: 9 },
  ])
})

test('one read-only handler can serve a built frontend without exposing private or outside files', async () => {
  const { root, put } = await workspace()
  await put('web/index.html', '<!doctype html><title>Archive</title>')
  await put('web/assets/app.js', 'console.log("archive")')
  await put('web/.private', 'hidden')
  const handler = archiveHandler(root, join(root, 'web'))
  expect(await (await handler(new Request('http://localhost/'))).text()).toContain('<title>Archive</title>')
  expect((await handler(new Request('http://localhost/assets/app.js'))).headers.get('content-type')).toContain('javascript')
  expect((await handler(new Request('http://localhost/.private'))).status).toBe(400)
  expect((await handler(new Request('http://localhost/assets/missing.js'))).status).toBe(404)
})

test('one platform discovers direct campaigns and keeps all file and session requests scoped to the selected campaign', async () => {
  const { root, put } = await workspace()
  for (const id of ['alpha', 'beta']) {
    await put(`library/${id}/campaign/campaign.md`, `# Campaign ${id}`)
    await put(`library/${id}/campaign/shared.txt`, id)
    await put(`library/${id}/campaign/output/trials/t-same/plan.md`, `# ${id} trial`)
    await put(`library/${id}/campaign/.autofold/sessions/same.jsonl`, [
      { type: 'session', version: 3, id, cwd: root, timestamp: '2026-01-01' },
      { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01', message: { role: 'user', content: `${id} conversation` } },
    ].map(value => JSON.stringify(value)).join('\n'))
  }
  await put('library/alpha/campaign/prior/nested/campaign/campaign.md', '# Nested prior run')
  await put('library/hidden/campaign.md', '# Not a direct campaign')
  await mkdir(join(root, 'library/symlink'), { recursive: true })
  await symlink(join(root, 'library/alpha/campaign'), join(root, 'library/symlink/campaign'))
  await symlink(join(root, 'library/alpha'), join(root, 'library/linked-parent'))
  const catalog = await campaignCatalog(join(root, 'library/alpha/campaign'), join(root, 'library'))
  expect(catalog.publicCatalog.campaigns.map(entry => entry.id)).toEqual(['alpha', 'beta'])
  expect(JSON.stringify(catalog.publicCatalog)).not.toContain(root)
  const handler = archiveHandler(join(root, 'library/alpha/campaign'), undefined, catalog)
  const request = (path: string) => handler(new Request(`http://localhost${path}`))
  expect((await (await request('/api/archives')).json()).defaultId).toBe('alpha')
  expect((await (await request('/api/archive')).json()).title).toBe('Campaign alpha')
  for (const id of ['alpha', 'beta']) {
    const snapshot = await (await request(`/api/archive?campaign=${id}`)).json()
    expect(snapshot.title).toBe(`Campaign ${id}`)
    expect(snapshot.trials[0].title).toBe(`${id} trial`)
    expect((await (await request(`/api/archive/file?campaign=${id}&path=shared.txt`)).json()).text).toBe(id)
    expect(await (await request(`/api/archive/file?campaign=${id}&path=shared.txt&raw=1`)).text()).toBe(id)
    expect((await (await request(`/api/archive/session?campaign=${id}&path=.autofold%2Fsessions%2Fsame.jsonl`)).json()).messages[0].text).toBe(`${id} conversation`)
  }
  for (const id of ['missing', '../beta/campaign', root]) {
    expect((await request(`/api/archive?campaign=${encodeURIComponent(id)}`)).status).toBe(404)
    expect((await request(`/api/archive/file?campaign=${encodeURIComponent(id)}&path=shared.txt`)).status).toBe(404)
  }
  expect((await request('/api/archive/file?campaign=alpha&path=..%2F..%2Fbeta%2Fcampaign%2Fshared.txt')).status).toBe(400)
})

test('unannotated trials preview only their own inventoried coordinate outputs', async () => {
  const { root, put } = await workspace(), path = 'output/trials/t-structure'
  await put(`${path}/execution.json`, { artifacts: [{ path: 'output/model.cif' }] })
  await put(`${path}/output/model.cif`, 'data_saved')
  await put('output/trials/t-other/output/not-captured.cif', 'data_uninventoried')
  const snapshot = await readArchive(root)
  expect(snapshot.trials.find(t => t.path === path)?.display.artifacts[0]?.path).toBe(`${path}/output/model.cif`)
  expect(snapshot.trials.find(t => t.id === 't-other')?.display.artifacts).toEqual([])
  expect(snapshot.trials.every(t => !t.display.metrics.length)).toBe(true)
})

test('metrics resolve only from inventoried trial evidence; unknown values stay unavailable', async () => {
  const { root, put } = await workspace(), trial = 'output/trials/t-first'
  await put(`${trial}/plan.md`, '# Why this test\n')
  await put(`${trial}/trial.json`, { id: 't-first', intent: 'Investigate a proposal', created_at: '2026-01-01', snapshot: [{ path: 'program/main.py', sha256: 'snapshot' }] })
  await put(`${trial}/program/main.py`, 'print("captured")')
  await put(`${trial}/output/result.json`, { record: { 'a/b': 0.706 } })
  await put(`${trial}/execution.json`, { state: 'completed', artifacts: [{ path: 'output/result.json', sha256: 'recorded' }] })
  await put('programs/editable.json', { score: 999 })
  await put('analysis/display.json', { version: 1, trials: [{ path: trial, title: 'Shared-position comparison', metrics: [
    { label: 'Shared RMSD', path: `${trial}/output/result.json`, pointer: '/record/a~1b', unit: 'Å' },
    { label: 'Absent measurement', path: `${trial}/output/result.json`, pointer: '/record/missing' },
    { label: 'Editable score', path: 'programs/editable.json', pointer: '/score' },
  ], artifacts: [{ label: 'Missing preview', kind: 'protein-structure', path: `${trial}/output/missing.cif` }] }] })
  const snapshot = await readArchive(root), first = snapshot.trials[0]!
  expect(first.assessment).toBe('pending')
  expect(first.display.metrics[0]?.value).toBe(0.706)
  expect(first.display.metrics[1]?.value).toBeUndefined()
  expect(first.display.metrics[1]?.error).toContain('Missing field')
  expect(first.display.metrics[2]?.error).toContain('not inventoried')
  expect(first.display.artifacts).toHaveLength(0)
  expect(await readFile(join(root, `${trial}/program/main.py`), 'utf8')).toBe('print("captured")')
  expect(await readdir(join(root, trial))).not.toContain('assessment.md')
  expect(jsonPointer({ a: { '~key': false } }, '/a/~0key')).toBe(false)
})

test('prepared trials and missing assessments are visible without a manifest or invented chronological edges', async () => {
  const { root, put } = await workspace()
  await put('notebook/index.md', '# Current understanding\n[Missing](missing.md)\n')
  for (const id of ['t-one', 't-two']) await put(`output/trials/${id}/execution.json`, { state: 'prepared' })
  const snapshot = await readArchive(root)
  expect(snapshot.trials).toHaveLength(2)
  expect(snapshot.trials.every(t => t.assessment === 'pending')).toBe(true)
  expect(snapshot.links).toHaveLength(0)
  expect(snapshot.nodes.some(n => n.path === 'notebook/missing.md')).toBe(false)
  expect(snapshot.warnings[0]).toContain('unresolved link')
})

test('input links retain saved copies and current notebook navigation is not historical evidence', async () => {
  const { root, put } = await workspace(), earlier = 'output/trials/t-earlier', later = 'output/trials/t-later'
  await put('notebook/index.md', '# Current understanding\n')
  await put(`${earlier}/execution.json`, { state: 'completed' })
  await put(`${earlier}/output/result.json`, { value: 4 })
  await put(`${later}/execution.json`, { state: 'completed' })
  await put(`${later}/trial.json`, { inputs: [{ source: `${earlier}/output/result.json`, path: 'inputs/result.json' }] })
  await put(`${later}/inputs/result.json`, { value: 4 })
  await put(`${later}/plan.md`, '# Reanalysis\n## Notebook navigation\n[Current](../../../notebook/index.md)\n')
  await put(`${later}/assessment.md`, '# Initial interpretation\n')
  const snapshot = await readArchive(root)
  expect(snapshot.links.find(l => l.kind === 'uses')?.capturedPath).toBe(`${later}/inputs/result.json`)
  expect(snapshot.links.find(l => l.sourcePath.endsWith('plan.md'))?.kind).toBe('current-notebook')
  expect(snapshot.trials.find(t => t.path === later)?.assessment).toBe('incomplete')
})

test('native Pi branch reading is memory-only, excludes abandoned branches and thinking, and associates tool IDs', async () => {
  const { root, put } = await workspace(), path = '.autofold/sessions/saved.jsonl'
  const entries = [
    { type: 'session', version: 3, id: 'native', cwd: root, timestamp: '2026-01-01' },
    { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01', message: { role: 'user', content: 'Inspect the evidence' } },
    { type: 'message', id: 'abandoned', parentId: 'user', timestamp: '2026-01-01', message: { role: 'assistant', content: [{ type: 'text', text: 'Wrong branch' }] } },
    { type: 'message', id: 'tool', parentId: 'user', timestamp: '2026-01-01', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'campaign.md' } }] } },
    { type: 'message', id: 'result', parentId: 'tool', timestamp: '2026-01-01', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'evidence' }] } },
    { type: 'message', id: 'final', parentId: 'result', timestamp: '2026-01-01', message: { role: 'assistant', content: [{ type: 'text', text: 'Binding is unmeasured.' }] } },
  ]
  const raw = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await put(path, raw)
  await put('notebook/index.md', `# Session evidence\n[Original session](../${path})\n`)
  const session = await readArchiveSession(root, path)
  expect(session.id).toBe('native')
  expect(session.messages.map(m => m.id)).toEqual(['user', 'tool', 'result', 'final'])
  expect(session.messages[1]?.tools[0]?.id).toEqual(session.messages[2]?.toolCallId ?? '')
  expect(JSON.stringify(session)).not.toContain('private reasoning')
  expect(await readFile(join(root, path), 'utf8')).toBe(raw)
  expect(await readdir(join(root, '.autofold/sessions'))).toEqual(['saved.jsonl'])
  const snapshot = await readArchive(root)
  expect(snapshot.warnings).toEqual([])
  expect(snapshot.links.some(l => l.targetPath === path)).toBe(true)
  expect(snapshot.files.some(f => f.path === path)).toBe(false)
})
