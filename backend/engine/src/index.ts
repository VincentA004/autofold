import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent'
import { initializeNotebook } from './notebook.ts'
import { assessmentProtection } from './assessments.ts'
import { createDelegateTool, type DelegationLimits } from './delegation.ts'

const instructions = readFileSync(new URL('../APPEND_SYSTEM.md', import.meta.url), 'utf8')

export type AutofoldOptions = Pick<CreateAgentSessionOptions,
  'cwd' | 'agentDir' | 'sessionManager' | 'modelRuntime' | 'model' | 'thinkingLevel'
> & { continue?: boolean; delegation?: false | Partial<DelegationLimits> }

/** Pi owns the agent. Autofold supplies scientific guidance and workspace files. */
export async function createAutofold(options: AutofoldOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const agentDir = options.agentDir ?? getAgentDir()
  const sessionDir = join(cwd, '.autofold', 'sessions')
  const sessionManager = options.sessionManager ?? (options.continue
    ? SessionManager.continueRecent(cwd, sessionDir)
    : SessionManager.create(cwd, sessionDir))

  const createRuntime: CreateAgentSessionRuntimeFactory = async target => {
    await initializeNotebook(target.cwd)
    const services = await createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      modelRuntime: options.modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [assessmentProtection],
        additionalSkillPaths: [fileURLToPath(new URL('../skills', import.meta.url))],
        appendSystemPromptOverride: base => [...base, instructions],
      },
    })
    return {
      ...await createAgentSessionFromServices({
        services,
        sessionManager: target.sessionManager,
        sessionStartEvent: target.sessionStartEvent,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        customTools: options.delegation === false ? [] : [createDelegateTool({
          cwd: target.cwd, agentDir, modelRuntime: services.modelRuntime, limits: options.delegation,
        })],
      }),
      services,
      diagnostics: services.diagnostics,
    }
  }

  return createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })
}
