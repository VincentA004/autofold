import { onMount, onCleanup } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { AppStatus, AppEvent, AppModel, AppConversation } from '../../../../backend/engine/src/app-types'
import { archiveClient, appRequest, scoped } from './client'

export function useScientist(callbacks: { selectedSession: () => string; onConversation: (session: AppConversation) => void; onArchive: () => void }) {
  const [state, set] = createStore<AppStatus & { ready: boolean; pending: boolean; requestError: string; models: AppModel[]; connectionLost: boolean }>({ revision: 0, enabled: false, connected: false, running: false, streamText: '', thinkingLevels: [], ready: false, pending: false, requestError: '', models: [], connectionLost: false })
  let source: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined, disposed = false, generation = 0
  const conversation = async () => {
    const request = ++generation
    try { const result = await appRequest<AppConversation>('conversation'); if (!disposed && request === generation) callbacks.onConversation(result) } catch (error) { if (!disposed) set('requestError', String(error)) }
  }
  const apply = (status: AppStatus) => { if (status.revision < state.revision) return; set({ model: undefined, thinking: undefined, tool: undefined, error: undefined, sessionId: undefined, sessionPath: undefined, ...status }); if (status.connected) void conversation() }
  const run = async <T,>(task: () => Promise<T>) => {
    set({ pending: true, requestError: '' })
    try { return await task() } catch (error) { set('requestError', error instanceof Error ? error.message : String(error)); throw error }
    finally { if (!disposed) set('pending', false) }
  }
  onMount(async () => {
    try {
      const status = await appRequest<AppStatus>('status')
      if (disposed) return
      apply(status); set('ready', true)
      if (!status.enabled) return
      source = new EventSource(scoped('/api/app/events'))
      source.onopen = () => set('connectionLost', false)
      source.onerror = () => set('connectionLost', true)
      source.onmessage = message => {
        const event = JSON.parse(message.data) as AppEvent
        if (event.type === 'state') apply(event.state)
        else if (event.type === 'delta' && event.revision > state.revision) { set('streamText', text => text + event.text); set('revision', event.revision) }
        else if (event.type === 'archive_changed') { clearTimeout(timer); timer = setTimeout(callbacks.onArchive, 400) }
      }
    } catch { if (!disposed) set('ready', true) }
  })
  onCleanup(() => { disposed = true; generation++; source?.close(); clearTimeout(timer) })
  const connect = async (path = callbacks.selectedSession(), fresh = false) => {
    const status = await appRequest<AppStatus>('session', { path: fresh ? undefined : path || undefined, new: fresh }); apply(status); return status
  }
  return { state,
    resume: (path: string) => run(() => connect(path)),
    newConversation: () => run(() => connect('', true)),
    send: (text: string, attachments: string[]) => run(async () => {
      const status = state.connected ? state : await connect()
      apply(await appRequest<AppStatus>('message', { text, attachments, sessionId: status.sessionId }))
    }),
    stop: () => run(async () => apply(await appRequest<AppStatus>('stop', {}))),
    configure: (input: { provider?: string; model?: string; thinking?: string }) => run(async () => { if (!state.connected) await connect(); apply(await appRequest<AppStatus>('model', input)) }),
    loadModels: () => run(async () => set('models', await appRequest<AppModel[]>('models'))),
    create: (title: string, brief: string) => run(async () => { const result = await appRequest<{ id: string }>('campaigns', { title, brief }); archiveClient.openCampaign(result.id) }),
    upload: (file: File) => run(async () => {
      if (!file.size || file.size > 20 * 1024 * 1024) throw Error('Files must be between 1 byte and 20 MB.')
      return appRequest<{ path: string }>(`attachments&name=${encodeURIComponent(file.name)}`, file)
    }),
  }
}
