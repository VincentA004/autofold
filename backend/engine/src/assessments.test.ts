import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { createAutofold } from './index.ts'

const runner = fileURLToPath(new URL('../scripts/run_trial.py', import.meta.url))
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const tool = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'autofold-assessment-'))
  const cli = (...args: string[]) => execFileSync('python3', [runner, '--campaign', cwd, ...args], { encoding: 'utf8' })
  await writeFile(join(cwd, 'campaign.md'), '# CPU fixture\n')
  await mkdir(join(cwd, 'programs/check'), { recursive: true })
  await writeFile(join(cwd, 'programs/check/main.py'), "print('synthetic evidence')\n")
  const trial = 'output/trials/' + JSON.parse(cli('--prepare')).trial_id
  await writeFile(join(cwd, trial, 'plan.md'), '# Plan\nTest synthetic evidence.\n')
  cli('--trial', trial, '--program', 'programs/check', '--intent', 'Test fixture', '--', 'python3', 'program/main.py')
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, 'agent/auth.json'), modelsPath: null,
    modelsStorePath: join(cwd, 'models.json'), refreshOnCreate: false,
  })
  const provider = fauxProvider()
  modelRuntime.registerNativeProvider(provider.provider)
  return { cwd, trial, cli, provider, options: { cwd, agentDir: join(cwd, 'agent'), modelRuntime, model: provider.getModel() } }
}

test('native Pi tools commit once, block direct writes/edits and preserve linked corrections', async () => {
  const { cwd, trial, cli, provider, options } = await fixture()
  const assessment = join(cwd, trial, 'assessment.md')
  const text = '# Initial assessment\nSynthetic result; no biological conclusion.\n'
  await symlink(join(cwd, trial), join(cwd, 'trial-alias'))
  let runtime: Awaited<ReturnType<typeof createAutofold>> | undefined
  try {
    runtime = await createAutofold(options)
    provider.setResponses([
      tool('write', { path: `${trial}/assessment.md`, content: 'uncommitted' }),
      tool('write', { path: `${trial}/assessment.json`, content: '{}' }),
      tool('write', { path: 'programs/assessment.md', content: text }),
      tool('bash', { command: `python3 ${quote(runner)} --campaign . --trial ${quote(trial)} --assess programs/assessment.md` }),
      tool('write', { path: 'trial-alias/assessment.md', content: 'replaced through alias' }),
      tool('write', { path: `@${trial}/assessment.md`, content: 'replaced with Pi path prefix' }),
      tool('write', { path: pathToFileURL(assessment).href, content: 'replaced through URL' }),
      tool('edit', { path: assessment, oldText: 'Synthetic result', newText: 'Claimed activity' }),
      tool('write', { path: 'notebook/investigations/check.md', content:
        `# Changes\n\n2026-10-18: Corrects [initial assessment](../../${trial}/assessment.md): interpretation remains provisional.\n` }),
      fauxAssistantMessage('Committed the first assessment and kept the correction in the notebook.'),
    ])
    await runtime.session.prompt('Exercise the assessment contract using synthetic evidence.')
    const results = runtime.session.messages.filter(message => message.role === 'toolResult')
    expect(results.map(message => message.isError === true)).toEqual([true, true, false, false, true, true, true, true, false])
    expect(await readFile(assessment, 'utf8')).toBe(text)
    expect(JSON.parse(cli('--verify-assessments')).errors).toEqual([])
    expect(await readFile(join(cwd, 'notebook/investigations/check.md'), 'utf8')).toContain(`${trial}/assessment.md`)
    const receipt = await readFile(join(cwd, trial, 'assessment.json'), 'utf8')
    await runtime.dispose()
    runtime = await createAutofold(options) // Protection survives a fresh scientist context.
    provider.setResponses([
      tool('edit', { path: `${trial}/assessment.md`, oldText: 'Synthetic result', newText: 'Rewritten result' }),
      fauxAssistantMessage('The preserved assessment cannot be edited.'),
    ])
    await runtime.session.prompt('Try editing the initial assessment from a fresh session.')
    expect(runtime.session.messages.some(message => message.role === 'toolResult' && message.isError)).toBe(true)
    expect(await readFile(assessment, 'utf8')).toBe(text)
    expect(await readFile(join(cwd, trial, 'assessment.json'), 'utf8')).toBe(receipt)
  } finally {
    await runtime?.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('shell bypass is reported, further mutation is blocked and handoff/resume expose the failure', async () => {
  const { cwd, trial, cli, provider, options } = await fixture()
  await writeFile(join(cwd, 'programs/assessment.md'), '# Initial assessment\nSynthetic.\n')
  cli('--trial', trial, '--assess', 'programs/assessment.md')
  const script = `from pathlib import Path; p = Path(${JSON.stringify(`${trial}/assessment.md`)}); p.chmod(0o644); p.write_text('changed via shell')`
  let runtime: Awaited<ReturnType<typeof createAutofold>> | undefined
  try {
    runtime = await createAutofold(options)
    provider.setResponses([
      tool('bash', { command: `python3 -c ${quote(script)}` }),
      tool('read', { path: `${trial}/assessment.md` }), // Inspection is still possible.
      tool('bash', { command: 'touch should-not-exist' }),
      fauxAssistantMessage('Should not reach a normal successful handoff.'),
    ])
    await runtime.session.prompt('Exercise integrity failure handling in this disposable fixture.')
    const results = runtime.session.messages.filter(message => message.role === 'toolResult')
    expect(results.map(message => message.isError === true)).toEqual([true, false, true])
    expect(JSON.stringify(results[0])).toContain('hash mismatch')
    expect(existsSync(join(cwd, 'should-not-exist'))).toBe(false)
    expect(JSON.stringify(runtime.session.messages)).toContain('assessment-integrity')
    await runtime.dispose()
    runtime = await createAutofold(options)
    provider.setResponses([context => {
      expect(JSON.stringify(context.messages)).toContain('Assessment integrity failure')
      return fauxAssistantMessage('Historical assessment was changed; operator recovery is required.')
    }])
    await runtime.session.prompt('Inspect the campaign handoff status from a fresh context.')
    expect(JSON.stringify(runtime.session.messages)).toContain('hash mismatch')
    expect(await readFile(join(cwd, trial, 'assessment.md'), 'utf8')).toBe('changed via shell')
  } finally {
    await runtime?.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
