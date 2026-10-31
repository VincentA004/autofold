import { For, Show, createMemo, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { useTheme } from '@synsci/ui/theme/context'
import { archiveClient, appRequest, type ArchiveCatalog } from './client'
import './chooser.css'

// The original OpenScience home layout, backed only by the Autofold catalog.
// No directory picker, server selector, GlobalSync or legacy project state.
export default function CampaignChooser() {
  const theme = useTheme()
  const [state, set] = createStore({ catalog: null as ArchiveCatalog | null, loading: true, error: '', query: '',
    view: readView(), enabled: false, creating: false })
  const filtered = createMemo(() => {
    const query = state.query.trim().toLowerCase()
    return state.catalog?.campaigns.filter(campaign => `${campaign.title} ${campaign.id}`.toLowerCase().includes(query)) || []
  })
  const load = async (signal: AbortSignal) => {
    set({ loading: true, error: '' })
    try {
      const catalog = await archiveClient.catalog(signal)
      if (!signal.aborted) set({ catalog, loading: false })
    } catch (error) { if (!signal.aborted) set({ loading: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  let abort = new AbortController()
  onMount(() => {
    void load(abort.signal)
    void appRequest<{ enabled: boolean }>('status').then(status => { if (!abort.signal.aborted) set('enabled', status.enabled) }).catch(() => {})
  })
  onCleanup(() => abort.abort())
  const changeView = (view: 'grid' | 'list') => {
    set('view', view)
    try { localStorage.setItem('autofold-campaigns-view', view) } catch { /* Storage may be disabled. */ }
  }

  return <div class="atlas-root campaign-chooser">
    <header class="g-strip chooser-header">
      <div class="chooser-wordmark"><img src="/autofold-logo.png" alt="" /><span>Autofold</span></div>
      <div class="chooser-spacer" />
      <label class="chooser-search"><Glyph kind="search" /><input aria-label="Search campaigns" placeholder="search campaigns…" value={state.query} onInput={event => set('query', event.currentTarget.value)} /></label>
      <Show when={state.enabled}><button class="chooser-primary" onClick={() => set('creating', true)}><Glyph kind="plus" />new campaign</button></Show>
      <button class="chooser-icon" aria-label="Toggle theme" title="toggle theme" onClick={() => theme.setColorScheme(theme.mode() === 'dark' ? 'light' : 'dark')}><Glyph kind={theme.mode() === 'dark' ? 'sun' : 'moon'} /></button>
    </header>
    <main class="chooser-main">
      <div class="chooser-heading"><h1>Campaigns</h1><span class="chooser-count">{state.catalog?.campaigns.length ?? '—'}</span><div class="chooser-spacer" /><div class="chooser-view" role="group" aria-label="Campaign layout"><For each={['grid', 'list'] as const}>{view => <button aria-label={`${view === 'grid' ? 'Grid' : 'List'} view`} aria-pressed={state.view === view} onClick={() => changeView(view)}><Glyph kind={view} /></button>}</For></div></div>
      <Show when={!state.loading} fallback={<p class="chooser-message" role="status">Loading campaigns…</p>}>
        <Show when={!state.error} fallback={<div class="chooser-empty"><p role="alert">{state.error}</p><button class="chooser-secondary" onClick={() => { abort.abort(); abort = new AbortController(); void load(abort.signal) }}>Try again</button></div>}>
          <Show when={filtered().length} fallback={<div class="chooser-empty"><Show when={state.query.trim()} fallback={<><img src="/autofold-logo.png" alt="" /><h2>Start a campaign</h2><p>Your research, conversations and notebook stay organized around it.</p><Show when={state.enabled}><button class="chooser-primary" onClick={() => set('creating', true)}>new campaign <Glyph kind="plus" /></button></Show></>}><h2>No matching campaigns</h2><p>No campaigns match “{state.query}”.</p><button class="chooser-secondary" onClick={() => set('query', '')}>Clear search</button></Show></div>}>
            <div classList={{ 'chooser-grid': state.view === 'grid', 'chooser-list': state.view === 'list' }}>
              <For each={filtered()}>{campaign => <a class="chooser-card" href={`/?campaign=${encodeURIComponent(campaign.id)}`} title={campaign.title}>
                <div class="chooser-card-heading"><Glyph kind="folder" /><div class="chooser-card-copy"><span class="chooser-card-title">{campaign.title}</span><span class="chooser-card-id">{campaign.id}</span></div></div>
                <div class="chooser-card-footer"><span>Saved campaign</span><span class="chooser-open">open <Glyph kind="arrow" /></span></div>
              </a>}</For>
              <Show when={state.enabled && state.view === 'grid'}><button class="chooser-new-card" onClick={() => set('creating', true)}><Glyph kind="plus" />new campaign</button></Show>
            </div>
          </Show>
        </Show>
      </Show>
    </main>
    <Show when={state.creating}><NewCampaign onClose={() => set('creating', false)} /></Show>
  </div>
}

function readView(): 'grid' | 'list' {
  try { return localStorage.getItem('autofold-campaigns-view') === 'list' ? 'list' : 'grid' } catch { return 'grid' }
}

function NewCampaign(props: { onClose: () => void }) {
  let dialog!: HTMLDialogElement
  const [state, set] = createStore({ title: '', brief: '', pending: false, error: '' })
  onMount(() => dialog.showModal())
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.pending) return
    set({ pending: true, error: '' })
    try {
      const result = await appRequest<{ id: string }>('campaigns', { title: state.title, brief: state.brief })
      archiveClient.openCampaign(result.id)
    } catch (error) { set({ pending: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  return <dialog ref={dialog} class="chooser-dialog" aria-labelledby="new-campaign-title" onClose={props.onClose} onCancel={event => { if (state.pending) event.preventDefault() }}>
    <div class="chooser-dialog-heading"><h2 id="new-campaign-title">New campaign</h2><button class="chooser-icon" aria-label="Close new campaign" disabled={state.pending} onClick={() => dialog.close()}>×</button></div>
    <form onSubmit={submit}><label>Research title<input autofocus required maxlength="120" value={state.title} disabled={state.pending} onInput={event => set('title', event.currentTarget.value)} /></label><label>Objective, constraints and stopping conditions<textarea required rows="7" maxlength="32000" value={state.brief} disabled={state.pending} onInput={event => set('brief', event.currentTarget.value)} placeholder="What should the scientist investigate? Include the target, molecular class, evidence, compute budget and deliverable." /></label><p>Creates a campaign and notebook. The scientist begins when you send a message.</p><Show when={state.error}><p role="alert">{state.error}</p></Show><button class="chooser-primary" type="submit" disabled={state.pending}>{state.pending ? 'Creating…' : 'Create campaign'} <Glyph kind="arrow" /></button></form>
  </dialog>
}

function Glyph(props: { kind: 'folder' | 'search' | 'plus' | 'arrow' | 'grid' | 'list' | 'sun' | 'moon' }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <Show when={props.kind === 'folder'}><path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5h4l1.8 2H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" /></Show>
    <Show when={props.kind === 'search'}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></Show>
    <Show when={props.kind === 'plus'}><path d="M12 5v14M5 12h14" /></Show>
    <Show when={props.kind === 'arrow'}><path d="M5 12h14m-6-6 6 6-6 6" /></Show>
    <Show when={props.kind === 'grid'}><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><rect x="14" y="14" width="7" height="7" rx="1.2" /></Show>
    <Show when={props.kind === 'list'}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Show>
    <Show when={props.kind === 'sun'}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></Show>
    <Show when={props.kind === 'moon'}><path d="M20.9 13.1A9 9 0 0 1 10.9 3.1a9 9 0 1 0 10 10Z" /></Show>
  </svg>
}
