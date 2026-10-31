import { watch } from 'node:fs'
import { mkdir as makeDirectory, writeFile as saveFile, realpath } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ModelRuntime, SessionManager, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createAutofold, type AutofoldOptions } from './index.ts'
import { archivePath } from './archive.ts'
import type { campaignCatalog } from './archives.ts'
import type { AppStatus, AppModel, AppEvent, AppConversation } from './app-types'
import type { ArchiveMessage } from './archive-types'

type Catalog = Awaited<ReturnType<typeof campaignCatalog>>
type Runtime = Awaited<ReturnType<typeof createAutofold>>
type Slot = { revision: number; runtime?: Runtime; opening: boolean; running: boolean; cancelled: boolean; text: string; tool?: string; error?: string; task?: Promise<void>; off?: () => void }
export class AppError extends Error { constructor(message: string, public status = 400) { super(message) } }

/** One native Pi runtime per selected campaign. No second agent loop or transcript store. */
export class LiveWorkspace {
  private slots = new Map<string, Slot>()
  private listeners = new Map<string, Set<(event: AppEvent) => void>>()
  private modelRuntime?: Promise<ModelRuntime>
  constructor(readonly catalog: Catalog, private options: { archivesDirectory?: string; modelRuntime?: ModelRuntime; agentDir?: string; model?: AutofoldOptions['model'] } = {}) {}
  entry(id: string) {
    const entry = this.catalog.entries.find(entry => entry.id === (id || this.catalog.publicCatalog.defaultId))
    if (!entry) throw new AppError('Unknown campaign', 404)
    return entry
  }
  private modelsRuntime() { return this.modelRuntime ??= this.options.modelRuntime ? Promise.resolve(this.options.modelRuntime) : ModelRuntime.create({ allowModelNetwork: false }) }
  async models(): Promise<AppModel[]> {
    return (await (await this.modelsRuntime()).getAvailable()).map(model => ({ provider: model.provider, id: model.id, name: model.name }))
  }
  status(id: string): AppStatus {
    const slot = this.slots.get(this.entry(id).id), session = slot?.runtime?.session
    const model = session?.model
    return { revision: slot?.revision || 0, enabled: true, connected: !!session, running: !!slot?.running || !!slot?.opening, sessionId: session?.sessionId,
      sessionPath: session?.sessionFile ? relative(this.entry(id).root, session.sessionFile).split('\\').join('/') : undefined,
      model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
      thinking: session?.thinkingLevel, thinkingLevels: session?.getAvailableThinkingLevels() || [], streamText: slot?.text || '', tool: slot?.tool, error: slot?.error }
  }
  private emit(id: string, event: AppEvent) { for (const listener of this.listeners.get(this.entry(id).id) || []) listener(event) }
  private changed(id: string) { const slot = this.slots.get(this.entry(id).id); if (slot) slot.revision++; this.emit(id, { type: 'state', state: this.status(id) }) }
  subscribe(id: string, listener: (event: AppEvent) => void) {
    const entry = this.entry(id), set = this.listeners.get(entry.id) || new Set()
    set.add(listener); this.listeners.set(entry.id, set)
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => listener({ type: 'archive_changed' }), 700) }
    let watcher: ReturnType<typeof watch> | undefined
    try { watcher = watch(entry.root, { recursive: true }, (_, path) => { if (path && !String(path).split(/[\\/]/).some(part => part.startsWith('.'))) changed() }); watcher.on('error', () => watcher?.close()) } catch { /* Native tool and completion events also refresh the archive. */ }
    return () => { set.delete(listener); watcher?.close(); clearTimeout(timer) }
  }
  private idle(slot: Slot) { if (slot.running || slot.opening || slot.runtime?.session.isStreaming) throw new AppError('Stop the current scientist turn before changing sessions or settings.', 409) }
  async start(id: string, path?: string, fresh = false) {
    const entry = this.entry(id)
    let slot = this.slots.get(entry.id)
    if (!slot) { slot = { revision: 0, opening: false, running: false, cancelled: false, text: '' }; this.slots.set(entry.id, slot) }
    this.idle(slot)
    if (!fresh && slot.runtime && (!path || this.status(id).sessionPath === path)) return this.status(id)
    if (path && !/^\.autofold\/sessions\/[^/]+\.jsonl$/.test(path)) throw new AppError('Invalid native session')
    const saved = path ? await archivePath(entry.root, path, true) : undefined
    // Reserve the slot before the first asynchronous runtime operation.
    this.idle(slot); slot.opening = true; slot.error = undefined; this.changed(id)
    try {
      if (slot.runtime) { slot.off?.(); await slot.runtime.dispose(); slot.runtime = undefined }
      const runtime = await createAutofold({ cwd: entry.root, continue: !saved && !fresh, agentDir: this.options.agentDir,
        modelRuntime: await this.modelsRuntime(), model: this.options.model,
        ...(saved ? { sessionManager: SessionManager.open(saved, join(entry.root, '.autofold/sessions'), entry.root) } : {}) })
      slot.runtime = runtime
      slot.off = runtime.session.subscribe(event => this.event(entry.id, slot!, event))
      slot.text = ''; slot.tool = undefined
      } finally { slot.opening = false; this.changed(id) }
    return this.status(id)
  }
  private event(id: string, slot: Slot, event: AgentSessionEvent) {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      slot.text += event.assistantMessageEvent.delta
      slot.revision++; this.emit(id, { type: 'delta', text: event.assistantMessageEvent.delta, revision: slot.revision })
    } else if (event.type === 'message_start' && event.message.role === 'user') {
      this.changed(id)
    } else if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage) {
      slot.error = event.message.errorMessage; this.changed(id)
    } else if (event.type === 'message_start' && event.message.role === 'assistant') {
      slot.text = ''; this.changed(id)
    } else if (event.type === 'tool_execution_start') {
      slot.tool = event.toolName; this.changed(id)
    } else if (event.type === 'tool_execution_end') {
      slot.tool = undefined; this.changed(id); this.emit(id, { type: 'archive_changed' })
    }
  }
  async send(id: string, text: string, sessionId: string, attachments: string[] = []) {
    const entry = this.entry(id), slot = this.slots.get(entry.id)
    if (!slot?.runtime) throw new AppError('Open a scientist session first.', 409)
    this.idle(slot)
    if (slot.runtime.session.sessionId !== sessionId) throw new AppError('The active session changed. Refresh before sending.', 409)
    if (!text.trim() || text.length > 32000) throw new AppError('Enter a message of at most 32,000 characters.')
    if (attachments.length > 20) throw new AppError('Attach at most 20 campaign files.')
    for (const path of attachments) await archivePath(entry.root, path)
    this.idle(slot)
    if (slot.runtime.session.sessionId !== sessionId) throw new AppError('The active session changed. Refresh before sending.', 409)
    if (!slot.runtime.session.model) throw new AppError('Select a configured model before sending.')
    slot.running = true; slot.cancelled = false; slot.text = ''; slot.error = undefined; this.changed(id)
    const prompt = text + (attachments.length ? '\n\nAttached campaign files:\n' + attachments.map(path => `- ${path}`).join('\n') : '')
    slot.task = Promise.resolve().then(async () => {
      if (!slot.cancelled) await slot.runtime!.session.prompt(prompt)
    }).catch(error => { slot.error = error instanceof Error ? error.message : String(error) }).finally(() => {
      slot.running = false; slot.tool = undefined; slot.text = ''; this.changed(id); this.emit(id, { type: 'archive_changed' })
    })
    return this.status(id)
  }
  async stop(id: string) {
    const slot = this.slots.get(this.entry(id).id)
    if (slot?.runtime) { slot.cancelled = true; await slot.runtime.session.abort(); await slot.task }
    return this.status(id)
  }
  async configure(id: string, input: { provider?: string; model?: string; thinking?: string }) {
    const slot = this.slots.get(this.entry(id).id)
    if (!slot?.runtime) throw new AppError('Open a scientist session first.', 409)
    this.idle(slot); slot.opening = true
    try {
      if (input.provider && input.model) {
        const available = await this.models(), selected = available.find(model => model.provider === input.provider && model.id === input.model)
        const model = selected && (await this.modelsRuntime()).getModel(selected.provider, selected.id)
        if (!model) throw new AppError('This model is not configured in Pi. Configure provider credentials before selecting it.')
        await slot.runtime.session.setModel(model)
      }
      if (input.thinking !== undefined) {
        const levels = slot.runtime.session.getAvailableThinkingLevels()
        if (!levels.includes(input.thinking as typeof levels[number])) throw new AppError('Unsupported thinking level for this model.')
        slot.runtime.session.setThinkingLevel(input.thinking as typeof levels[number])
      }
      } finally { slot.opening = false; this.changed(id) }
    return this.status(id)
  }
  conversation(id: string): AppConversation {
    const slot = this.slots.get(this.entry(id).id), session = slot?.runtime?.session
    if (!session) return { id: '', path: '', title: 'Scientist conversation', messages: [] }
    const messages: ArchiveMessage[] = session.messages.flatMap((message, i) => {
      if (!['user', 'assistant', 'toolResult'].includes(message.role)) return []
      const m = message as unknown as Record<string, unknown>, content = m.content
      const parts = Array.isArray(content) ? content as Record<string, unknown>[] : []
      const text = typeof content === 'string' ? content : parts.filter(p => p.type === 'text').map(p => String(p.text || '')).join('\n')
      const tools = parts.filter(p => p.type === 'toolCall').map(p => ({ id: String(p.id), name: String(p.name), input: p.arguments }))
      if (!text && !tools.length) return []
      return [{ id: `${session.sessionId}-${i}`, role: message.role as ArchiveMessage['role'], text,
        timestamp: new Date(typeof m.timestamp === 'number' ? m.timestamp : Date.now()).toISOString(), tools,
        ...(message.role === 'toolResult' ? { toolCallId: String(m.toolCallId) } : {}) }]
    })
    return { id: session.sessionId, path: this.status(id).sessionPath || '', title: session.sessionName || 'Scientist conversation', messages }
  }
  async create(title: string, brief: string) {
    if (!this.options.archivesDirectory) throw new AppError('Configure an archive directory to create research workspaces.')
    if (!title.trim() || title.length > 120 || !brief.trim() || brief.length > 32000) throw new AppError('Provide a title and research objective.')
    const directory = await realpath(this.options.archivesDirectory), id = `research-${Date.now()}-${randomUUID().slice(0, 8)}`
    const root = join(directory, id, 'campaign')
    await makeDirectory(root, { recursive: true })
    await saveFile(join(root, 'campaign.md'), `# ${title.trim().replace(/[\r\n]/g, ' ')}\n\n${brief.trim()}\n`, { flag: 'wx' })
    this.catalog.entries.push({ id, title: title.trim(), root })
    this.catalog.publicCatalog.campaigns.push({ id, title: title.trim() })
    return { id }
  }
  async upload(id: string, name: string, bytes: Uint8Array) {
    const root = this.entry(id).root
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new AppError('Files must be between 1 byte and 20 MB.')
    const filename = basename(name).replace(/[^\w.\-]/g, '_').slice(-150) || 'attachment'
    const path = `inputs/attachments/${randomUUID()}-${filename}`
    // Resolve the destination through existing non-private directories, excluding outward symlinks.
    await makeDirectory(join(root, 'inputs'), { recursive: true })
    await archivePath(root, 'inputs')
    await makeDirectory(join(root, 'inputs/attachments'), { recursive: true })
    await archivePath(root, 'inputs/attachments')
    await saveFile(join(root, path), bytes, { flag: 'wx' })
    this.emit(id, { type: 'archive_changed' })
    return { path }
  }
  async dispose() { for (const slot of this.slots.values()) { slot.cancelled = true; await slot.runtime?.session.abort(); await slot.task; slot.off?.(); await slot.runtime?.dispose() }; this.slots.clear() }
}
