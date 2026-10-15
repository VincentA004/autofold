import {createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type Extension, type SessionBeforeCompactEvent, type SessionBeforeCompactResult, type SessionCompactEvent} from '@earendil-works/pi-coding-agent'
import {InMemoryCredentialStore, type Api, type Model} from '@earendil-works/pi-ai'
import type {MutableModels} from '@earendil-works/pi-ai/models'
import {contextBudget, estimateContextInput} from './context'
import {immutableSessionValue} from './immutable'
import type {PiSession, PiRuntimeOptions} from './types'
import {exactInstructionMessages} from './instructions'

/** SQLite owns persistence; the SDK never opens a JSONL session or discovers operator resources. */
export function restoreManager(session: PiSession) {
  const manager = session.sdk ? SessionManager.inMemory('.', undefined, [session.sdk.header, ...session.sdk.entries]) : SessionManager.inMemory('.', {id: session.id})
  if (session.sdk?.leafId) manager.branch(session.sdk.leafId)
  const recorded = manager.getEntries().filter(e => e.type === 'message').length
  // Legacy v1 import and host fixture additions are data-only; no tools are replayed.
  for (const message of session.messages.slice(recorded)) {
    if (['system', 'user', 'assistant', 'toolResult'].includes(message.role)) manager.appendMessage(message as Parameters<SessionManager['appendMessage']>[0])
  }
  return manager
}
export function snapshotManager(session: PiSession, manager: SessionManager) {
  const prior=session.sdk?.entries??[]
  const entries=manager.getEntries().map((entry,index)=>prior[index]?.id===entry.id?prior[index]!:immutableSessionValue(entry))
  session.sdk={format:'autofold.pi-sdk-session.v1',header:immutableSessionValue(manager.getHeader()!),entries,leafId:manager.getLeafId()}
}
export interface HostCompactionHooks {
  before(event: SessionBeforeCompactEvent, manager: SessionManager): Promise<SessionBeforeCompactResult>
  after(event: SessionCompactEvent, manager: SessionManager): Promise<void>
}
export async function createHostSession(session: PiSession, model: Model<Api>, models: MutableModels, options: PiRuntimeOptions,
  tools: NonNullable<PiRuntimeOptions['tools']>, signal?: AbortSignal, compaction?: HostCompactionHooks) {
  signal?.throwIfAborted()
  const resources=await options.resources?.(signal)
  signal?.throwIfAborted()
  const cwd=resources?.cwd??'.'
  const manager = restoreManager(session)
  const budget = contextBudget(model, options.contextPolicy)
  // Pi owns threshold/overflow decisions and its bounded retry. Reserve host
  // declarations and verbatim intent framing in addition to output headroom.
  const fixedTokens = await estimateContextInput({messages: exactInstructionMessages(manager), systemPrompt: options.systemPrompt, tools: tools.map(({name,description,parameters})=>({name,description,parameters}))}, signal)
  const settings = SettingsManager.inMemory({compaction: {enabled: true, reserveTokens: model.contextWindow - Math.max(1, budget.inputBudget - fixedTokens - 512), keepRecentTokens: budget.keepRecentTokens}, retry: {enabled: false}, cacheWarming: 'off', images: {autoResize: false}})
  const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false})
  signal?.throwIfAborted()
  const provider = models.getProvider(model.provider)
  if (!provider) throw new Error('Pi host model provider is unavailable')
  runtime.registerNativeProvider({...provider, getModels: () => [model], auth: {apiKey: {name: 'Host-owned authorization',
    resolve: async () => {
      // SDK preflight only checks that the host owns authorization. Resolve the
      // actual credential once, inside the abortable/request-bounded stream gate.
      if (options.getApiKey) return {auth: {apiKey: 'host-owned-request-authorization'}}
      if (options.streamFn) return {auth: {apiKey: 'host-injected-offline-stream'}}
      return provider.auth.apiKey?.resolve({ctx: {env: async name => process.env[name], fileExists: async () => false}, signal: new AbortController().signal})
    }}}})
  const extensionRuntime = createExtensionRuntime()
  const extensions: Extension[] = [...options.extensions??[],...compaction ? [{path:'autofold:scoped-compaction',resolvedPath:'autofold:scoped-compaction',sourceInfo:{path:'autofold:scoped-compaction',source:'Autofold-scoped-science',scope:'project',origin:'top-level',baseDir:cwd},
    handlers:new Map([['session_before_compact',[(event)=>compaction.before(event as SessionBeforeCompactEvent,manager)]],['session_compact',[(event)=>compaction.after(event as SessionCompactEvent,manager)]]]),tools:new Map(),messageRenderers:new Map(),commands:new Map(),flags:new Map(),shortcuts:new Map()} as Extension] : []]
  const loader: ResourceLoader = {
    getExtensions: () => ({extensions, errors: [], runtime: extensionRuntime}),
    getSkills: () => ({skills: (resources?.skills??[]).map(skill=>({...skill,disableModelInvocation:false,sourceInfo:{path:skill.filePath,source:'Autofold-scoped-science',scope:'project' as const,origin:'top-level' as const,baseDir:skill.baseDir}})), diagnostics: []}), getPrompts: () => ({prompts: [], diagnostics: []}),
    getThemes: () => ({themes: [], diagnostics: []}), getAgentsFiles: () => ({agentsFiles: []}),
    // SDK treats an empty string as a request for its coding prompt. A whitespace
    // custom prompt preserves an intentionally empty host prompt without discovery.
    getSystemPrompt: () => options.systemPrompt || ' ', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  }
  const {session: sdk} = await createAgentSession({cwd, model, modelRuntime: runtime, sessionManager: manager,
    settingsManager: settings, resourceLoader: loader, tools: tools.map(t => t.name), customTools: tools.map(tool => ({...tool,
      execute: (id, args, signal, update) => tool.execute(id, args, signal, update)}))})
  if (signal?.aborted) { sdk.dispose(); signal.throwIfAborted() }
  snapshotManager(session, manager)
  return sdk
}
