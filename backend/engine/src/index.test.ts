import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { createAutofold } from './index.ts'

test('embedded Pi authors and edits a program, uses bash, and resumes native memory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'autofold-pi-'))
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, 'agent', 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(cwd, 'models.json'),
    refreshOnCreate: false,
  })
  const provider = fauxProvider()
  modelRuntime.registerNativeProvider(provider.provider)
  const options = { cwd, agentDir: join(cwd, 'agent'), modelRuntime, model: provider.getModel() }
  const tool = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
  const program = await readFile(new URL('../../../examples/hello_proto.py', import.meta.url), 'utf8')
  const skillFile = fileURLToPath(new URL('../skills/proto-discovery/SKILL.md', import.meta.url))
  const cyclingFile = fileURLToPath(new URL('../skills/proto-discovery/references/cycling.md', import.meta.url))
  const skillBody = (await readFile(skillFile, 'utf8')).split('---\n').slice(2).join('---\n').trim()
  provider.setResponses([
    tool('read', { path: skillFile }),
    tool('read', { path: cyclingFile }),
    tool('write', { path: 'programs/trial.py', content: program }),
    tool('read', { path: 'programs/trial.py' }),
    tool('edit', { path: 'programs/trial.py', oldText: 'seed=7', newText: 'seed=17' }),
    tool('bash', { command: 'test -f programs/trial.py && echo PROGRAM_PRESENT' }),
    tool('write', { path: 'MEMORY.md', content: 'Native Proto draft uses seed 17.\n' }),
    fauxAssistantMessage('Draft saved; scientific execution has not been performed.'),
  ])

  let runtime: Awaited<ReturnType<typeof createAutofold>> | undefined
  try {
    runtime = await createAutofold(options)
    const skill = runtime.services.resourceLoader.getSkills().skills.find(item => item.name === 'proto-discovery')
    expect(skill?.filePath).toBe(skillFile)
    expect(runtime.session.systemPrompt).toContain(skillFile)
    expect(runtime.session.systemPrompt).not.toContain(skillBody)
    const researchFile = fileURLToPath(new URL('../skills/scientific-research/SKILL.md', import.meta.url))
    expect(runtime.services.resourceLoader.getSkills().skills.find(item => item.name === 'scientific-research')?.filePath).toBe(researchFile)
    expect(runtime.session.systemPrompt).toContain(researchFile)
    expect(runtime.session.systemPrompt).not.toContain('Search previews are discovery aids.')
    expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']))
    expect(runtime.session.systemPrompt).toContain('installed Proto library')
    await runtime.session.prompt('Write a native Proto draft and save what you did.')
    expect(await readFile(join(cwd, 'programs/trial.py'), 'utf8')).toContain('seed=17')
    const results = runtime.session.messages.filter(message => message.role === 'toolResult')
    expect(results).toHaveLength(7)
    expect(results.every(message => !message.isError)).toBe(true)
    expect(JSON.stringify(results)).toContain('PROGRAM_PRESENT')
    expect(JSON.stringify(results)).toContain(skillBody.split('\n')[0]!)
    const originalId = runtime.session.sessionId
    const originalFile = runtime.session.sessionFile
    expect(originalFile).toStartWith(join(cwd, '.autofold/sessions/'))
    await runtime.dispose()

    runtime = await createAutofold({ ...options, continue: true })
    expect(runtime.session.sessionId).toBe(originalId)
    expect(runtime.session.messages.filter(message => message.role === 'toolResult')).toHaveLength(7)
    provider.setResponses([
      tool('read', { path: 'MEMORY.md' }),
      fauxAssistantMessage('The saved draft uses seed 17.'),
    ])
    await runtime.session.prompt('Read the saved notes and continue.')
    expect(runtime.session.getLastAssistantText()).toBe('The saved draft uses seed 17.')
    expect(await readFile(originalFile!, 'utf8')).toContain('Read the saved notes and continue.')
    expect(provider.state.callCount).toBe(10)
    await runtime.newSession()
    expect(runtime.services.resourceLoader.getSkills().skills.some(item => item.filePath === skillFile)).toBe(true)
  } finally {
    await runtime?.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
}, 15000)
