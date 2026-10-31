import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { InteractiveMode, ModelRuntime, runPrintMode } from '@earendil-works/pi-coding-agent'
import { createAutofold } from './index.ts'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    continue: { type: 'boolean', short: 'c' },
    print: { type: 'boolean', short: 'p' },
    workspace: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
})

if (values.help) {
  console.log(`Autofold — embedded Pi agent for Proto authoring

Usage: npm run agent -- [options] [prompt]

  --workspace PATH       Working directory (default: current directory)
  -c, --continue         Resume the latest native Pi session in this workspace
  --provider PROVIDER   Pi provider; use together with --model
  --model MODEL         Exact model ID for that provider
  -p, --print           Run one prompt and exit
  -h, --help            Show this help

Without --print, opens Pi's native terminal UI (/model, /login, /resume).
Pi manages tools, providers, history and compaction.`)
} else {
  try {
    if (Boolean(values.provider) !== Boolean(values.model)) {
      throw new Error('Supply --provider and --model together.')
    }
    const prompt = positionals.join(' ')
    const print = values.print || !process.stdin.isTTY || !process.stdout.isTTY
    if (print && !prompt.trim()) throw new Error('Print mode requires a prompt.')

    const modelRuntime = values.provider ? await ModelRuntime.create() : undefined
    const model = values.provider ? modelRuntime!.getModel(values.provider, values.model!) : undefined
    if (values.provider && !model) throw new Error(`Unknown Pi model: ${values.provider}/${values.model}`)

    const runtime = await createAutofold({
      cwd: resolve(values.workspace ?? process.cwd()),
      continue: values.continue,
      modelRuntime,
      model,
    })
    try {
      if (print) {
        process.exitCode = await runPrintMode(runtime, { mode: 'text', initialMessage: prompt })
      } else {
        await new InteractiveMode(runtime, { initialMessage: prompt || undefined }).run()
      }
    } finally {
      await runtime.dispose()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
