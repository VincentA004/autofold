import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { createAutofold } from './index.ts'

test('a fresh scientist can retrieve and revise notebook knowledge without prior conversation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'autofold-notebook-'))
  const notebook = join(cwd, 'notebook')
  await mkdir(notebook)
  const index = '# My campaign\n\nObjective: inspect synthetic CPU fixtures.\n\nNo results yet.\n'
  await writeFile(join(notebook, 'index.md'), index)
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, 'agent/auth.json'), modelsPath: null,
    modelsStorePath: join(cwd, 'models.json'), refreshOnCreate: false,
  })
  const provider = fauxProvider()
  modelRuntime.registerNativeProvider(provider.provider)
  const options = { cwd, agentDir: join(cwd, 'agent'), modelRuntime, model: provider.getModel() }
  const tool = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
  const result = JSON.stringify({ provenance: 'offline_fixture', validCandidates: 2 }) + '\n'
  const finding = '# Findings\n\n## CPU fixture\n\nObserved two valid synthetic candidates.\n' +
    'Evidence: [Trial 001](../output/trials/001/result.json).\n' +
    'Interpretation: this checks plumbing; it establishes no biological or method improvement.\n'
  let runtime: Awaited<ReturnType<typeof createAutofold>> | undefined
  try {
    runtime = await createAutofold(options)
    expect(await readFile(join(notebook, 'index.md'), 'utf8')).toBe(index)
    expect(await readFile(join(notebook, 'findings.md'), 'utf8')).toBeTruthy()
    expect(await readFile(join(notebook, 'questions.md'), 'utf8')).toBeTruthy()
    provider.setResponses([
      tool('read', { path: 'notebook/index.md' }),
      tool('write', { path: 'output/trials/001/result.json', content: result }),
      tool('write', { path: 'notebook/findings.md', content: finding }),
      tool('write', { path: 'notebook/questions.md', content: '# Questions\n\nDoes the fixture result reproduce?\n' }),
      tool('edit', { path: 'notebook/index.md', oldText: 'No results yet.', newText: '[CPU fixture finding](findings.md#cpu-fixture). Next: check repeatability.' }),
      fauxAssistantMessage('Recorded the synthetic observation, evidence and open question.'),
    ])
    await runtime.session.prompt('Record the supplied synthetic fixture result in the lab notebook.')
    expect(runtime.session.messages.filter(message => message.role === 'toolResult').every(message => !message.isError)).toBe(true)
    const originalSession = runtime.session.sessionId
    const savedIndex = await readFile(join(notebook, 'index.md'), 'utf8')
    await runtime.dispose()

    runtime = await createAutofold(options) // deliberately not --continue
    expect(runtime.session.sessionId).not.toBe(originalSession)
    expect(runtime.session.messages.some(message => message.role === 'user')).toBe(false)
    expect(await readFile(join(notebook, 'index.md'), 'utf8')).toBe(savedIndex)
    expect(await readFile(join(notebook, 'findings.md'), 'utf8')).toBe(finding)
    provider.setResponses([
      tool('read', { path: 'notebook/index.md' }),
      tool('read', { path: 'notebook/findings.md' }),
      tool('read', { path: 'output/trials/001/result.json' }),
      tool('read', { path: 'notebook/questions.md' }),
      tool('edit', { path: 'notebook/questions.md', oldText: 'Does the fixture result reproduce?', newText: 'Repeatability remains untested. Next investigation: repeat the fixture.' }),
      context => {
        const input = JSON.stringify(context.messages)
        expect(input).toContain('validCandidates')
        expect(input).toContain('no biological or method improvement')
        return fauxAssistantMessage('The notebook links two synthetic candidates to trial 001; repeatability remains open.')
      },
    ])
    await runtime.session.prompt('Use the lab notebook to recover the investigation and update the next question.')
    expect(runtime.session.messages.filter(message => message.role === 'toolResult').every(message => !message.isError)).toBe(true)
    expect(await readFile(join(cwd, 'output/trials/001/result.json'), 'utf8')).toBe(result)
    const questions = await readFile(join(notebook, 'questions.md'), 'utf8')
    expect(questions).toContain('Repeatability remains untested.')
    await runtime.newSession()
    expect(await readFile(join(notebook, 'questions.md'), 'utf8')).toBe(questions)
    expect(await readFile(join(notebook, 'findings.md'), 'utf8')).toBe(finding)
  } finally {
    await runtime?.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
}, 15000)
