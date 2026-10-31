import { Show, createEffect, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { marked } from 'marked'
import { sanitize } from '@synsci/ui/sanitize'
import { archiveClient, resolveArchiveLink } from './client'
import { ProteinStructure } from '@/science/renderers/molecular/ProteinStructure'
import { Chem2D } from '@/science/renderers/molecular/Chem2D'
import { DataTableView } from '@/data/DataTableView'

export function ArchiveMarkdown(props: { text: string; path?: string; onOpen: (path: string) => void }) {
  const html = () => {
    const template = document.createElement('template')
    template.innerHTML = sanitize(marked.parse(props.text, { async: false }) as string)
    template.content.querySelectorAll('img,iframe,style,form,input,video,audio').forEach(node => node.remove())
    return template.innerHTML
  }
  return <div class="archive-markdown" innerHTML={html()} onClick={event => {
    const link = (event.target as Element).closest('a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return }
    if (href.startsWith('#')) { document.getElementById(href.slice(1))?.scrollIntoView(); return }
    const path = resolveArchiveLink(href, props.path)
    if (path) props.onOpen(path)
  }} />
}

const escapeCode = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function sourceHtml(text: string, python: boolean) {
  return text.split('\n').map((line, index) => {
    const escaped = escapeCode(line)
    const highlighted = !python ? escaped : line.trim().startsWith('#') ? `<span class="comment">${escaped}</span>`
      : escaped.replace(/(&quot;.*?&quot;|&#39;.*?&#39;)|\b(from|import|def|return|if|for|in|with|as|class|True|False|None|and|not|else|raise)\b/g, (match, string) => `<span class="${string ? 'str' : 'kw'}">${match}</span>`)
    return `<span class="code-line"><span class="ln">${index + 1}</span>${highlighted}</span>`
  }).join('')
}

export function RecordView(props: { path: string; onOpen: (path: string) => void; height?: number; compact?: boolean; bare?: boolean; literal?: boolean; chainLabels?: Record<string, string> }) {
  const [state, set] = createStore({ text: '', error: '', loading: true, source: false, code: '' })
  createEffect(() => {
    const path = props.path, abort = new AbortController()
    set({ text: '', error: '', loading: true, source: false, code: '' })
    archiveClient.text(path, abort.signal).then(file => {
      if (abort.signal.aborted) return
      set({ text: file.text, loading: false })
      if (/\.(py|json|ts|sh|log)$/.test(path) && file.text.length < 200_000) {
        set('code', sourceHtml(file.text, path.endsWith('.py')))
      }
    }).catch(error => { if (!abort.signal.aborted) set({ error: String(error), loading: false }) })
    onCleanup(() => abort.abort())
  })
  const molecular = () => /\.(cif|mmcif|pdb|sdf|mol|mol2|xyz|smi|smiles)$/i.test(props.path)
  const tableFormat = () => /\.csv$/i.test(props.path) ? 'csv' : /\.tsv$/i.test(props.path) ? 'tsv' : undefined
  const data = () => ({ data: state.text, format: /\.(cif|mmcif)$/i.test(props.path) ? 'mmcif' : props.path.split('.').at(-1) })
  return <div class="archive-record">
    <Show when={!props.bare}><div class="record-toolbar"><span>{state.source ? 'Source' : /\.md$/i.test(props.path) ? 'Document' : molecular() ? 'Saved molecular artifact' : 'Captured file'}</span><span class="spacer" />
      <Show when={molecular() || tableFormat() || /\.md$/i.test(props.path)}><button onClick={() => set('source', !state.source)}>{state.source ? 'Rendered view' : 'Source'}</button></Show>
      <a href={archiveClient.raw(props.path)} download={props.path.split('/').at(-1)}>Download</a>
    </div></Show>
    <Show when={!state.loading} fallback={<p class="record-message">Loading saved record…</p>}>
      <Show when={!state.error} fallback={<p role="alert" class="record-message">{state.error}</p>}>
        <Show when={!state.source && !props.literal} fallback={<pre class="plain-code">{state.text}</pre>}>
          <Show when={/\.md$/i.test(props.path)} fallback={
            <Show when={molecular()} fallback={<Show when={tableFormat()} fallback={<Show when={state.code} fallback={<pre class="plain-code">{state.text}</pre>}><pre class="source-code"><code innerHTML={state.code} /></pre></Show>}><DataTableView text={state.text} format={tableFormat()!} name={props.path.split('/').at(-1)!} /></Show>}>
              <Show when={!/\.(smi|smiles)$/i.test(props.path)} fallback={<Chem2D kind="chem-2d" data={{ smiles: state.text.trim().split(/\s/)[0] }} height={props.height || 420} />}>
                <ProteinStructure kind={/\.(sdf|mol|mol2|xyz)$/i.test(props.path) ? 'chem-3d' : 'protein-structure'} data={data()} height={props.height || 420} compact={props.compact} chainLabels={props.chainLabels} />
              </Show>
            </Show>
          }><ArchiveMarkdown text={state.text} path={props.path} onOpen={props.onOpen} /></Show>
        </Show>
      </Show>
    </Show>
  </div>
}

export function ArchiveDialog(props: { title: string; subtitle: string; onClose: () => void; children: import('solid-js').JSX.Element; wide?: boolean; symbol?: string }) {
  let element!: HTMLDivElement, trigger: HTMLElement | null = null
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') props.onClose()
    if (event.key !== 'Tab') return
    const focusable = [...element.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea')].filter(el => el.getClientRects().length && !(el as HTMLButtonElement).disabled)
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  onMount(() => { trigger = document.activeElement as HTMLElement; element.querySelector<HTMLButtonElement>('button')?.focus(); document.addEventListener('keydown', key) })
  onCleanup(() => { document.removeEventListener('keydown', key); trigger?.isConnected && trigger.focus() })
  return <div class="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) props.onClose() }}><div ref={element} classList={{ window: true, 'notebook-window': props.wide }} role="dialog" aria-modal="true" aria-label={props.title}>
    <header class="window-head"><span class="muted">{props.symbol || '◈'}</span><div><h2>{props.title}</h2><small>{props.subtitle}</small></div><span class="spacer" /><button class="icon" onClick={props.onClose} aria-label="Close inspector">×</button></header><div classList={{ 'window-content': !props.wide, 'notebook-layout': props.wide }}>{props.children}</div>
  </div></div>
}
