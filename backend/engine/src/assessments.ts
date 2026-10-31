import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

const runner = fileURLToPath(new URL('../scripts/run_trial.py', import.meta.url))
const readOnlyTools = new Set(['read', 'grep', 'find', 'ls'])
const correction = 'Commit a draft using run_trial.py --assess; existing assessments stay preserved. ' +
  'Record subsequent corrections in a dated notebook entry linking the original and correcting evidence.'

// Resolve existing ancestors too, so aliases to a trial directory cannot evade the guard.
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return join(canonical(dirname(path)), basename(path))
  }
}

function protectedAssessment(cwd: string, path: string) {
  // Match Pi's local path syntax before checking the actual filesystem target.
  path = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1))
  if (path.startsWith('file://')) path = fileURLToPath(path)
  const parts = relative(canonical(cwd), canonical(resolve(cwd, path))).split(sep)
  return parts.length === 4 && parts[0] === 'output' && parts[1] === 'trials' &&
    parts[2].startsWith('t-') && ['assessment.md', 'assessment.json'].includes(parts[3])
}

/** Reuse the runner's verifier, rather than maintaining a second receipt contract. */
function integrityIssue(cwd: string): string | undefined {
  if (!existsSync(join(cwd, 'output'))) return
  const result = spawnSync('python3', [runner, '--campaign', cwd, '--verify-assessments'], {
    encoding: 'utf8', timeout: 30_000,
  })
  if (result.status === 0 && !result.error) return
  return 'Assessment integrity failure. Stop and request operator recovery; do not reseal changed evidence.\n' +
    (result.stdout?.trim() || result.stderr?.trim() || result.error?.message || 'Verifier did not complete.')
}

/** Practical accidental-edit protection, not a sandbox for unrestricted shell commands. */
export const assessmentProtection: ExtensionFactory = pi => {
  pi.on('tool_call', (event, ctx) => {
    if (readOnlyTools.has(event.toolName)) return
    if ((event.toolName === 'write' || event.toolName === 'edit') && typeof event.input.path === 'string') {
      try {
        if (protectedAssessment(ctx.cwd, event.input.path)) return { block: true, reason: correction }
      } catch (error) {
        return { block: true, reason: `Cannot check assessment path: ${String(error)}` }
      }
    }
    const reason = integrityIssue(ctx.cwd)
    if (reason) return { block: true, reason, terminate: true }
  })
  pi.on('tool_result', (event, ctx) => {
    if (readOnlyTools.has(event.toolName)) return
    const issue = integrityIssue(ctx.cwd)
    if (issue) return { isError: true, content: [...event.content, { type: 'text', text: issue }] }
  })
  pi.on('before_agent_start', (_event, ctx) => {
    const issue = integrityIssue(ctx.cwd)
    if (issue) return { message: { customType: 'assessment-integrity', content: issue, display: true } }
  })
  pi.on('agent_end', (_event, ctx) => {
    const issue = integrityIssue(ctx.cwd)
    if (issue) pi.sendMessage({ customType: 'assessment-integrity', content: issue, display: true }, { triggerTurn: false })
  })
}
