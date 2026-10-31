import { For, Show, createEffect, createMemo, onCleanup, onMount, untrack } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { ArchiveSnapshot } from './client'
import { focusedGraph, layoutNotebook, notebookGraph, type NotebookGroup } from './notebook-graph'
import { RecordView } from './RecordView'

export function NotebookPane(props: { snapshot: ArchiveSnapshot; path: string }) {
  const [history, setHistory] = createStore({ paths: [props.path], index: 0 })
  let document!: HTMLElement
  const path = () => history.paths[history.index]
  const navigate = (next: string) => {
    if (next === path()) return
    const paths = history.paths.slice(0, history.index + 1).concat(next)
    setHistory({ paths, index: paths.length - 1 })
  }
  createEffect(() => { const next = props.path; untrack(() => navigate(next)) })
  createEffect(() => { path(); if (document) document.scrollTop = 0 })
  const backlinks = createMemo(() => props.snapshot.links.filter(link => link.targetPath === path()).filter((link, i, all) => all.findIndex(other => other.sourcePath === link.sourcePath) === i))
  return <>
    <NotebookGraph snapshot={props.snapshot} selected={path()} onSelect={navigate} />
    <div class="document-pane"><div class="document-path mono"><button aria-label="Previous notebook document" disabled={history.index === 0} onClick={() => setHistory('index', index => index - 1)}>←</button><button aria-label="Next notebook document" disabled={history.index === history.paths.length - 1} onClick={() => setHistory('index', index => index + 1)}>→</button><span title={path()}>{path()}</span></div>
      <article ref={document} class="document"><RecordView bare path={path()} onOpen={navigate} /><div class="backlinks">LINKED DOCUMENTS<For each={backlinks()}>{link => <button onClick={() => navigate(link.sourcePath)}>{props.snapshot.nodes.find(node => node.files.includes(link.sourcePath))?.title || link.sourcePath} ↗</button>}</For><Show when={!backlinks().length}><p class="faint tiny">No incoming document links.</p></Show></div></article>
    </div>
  </>
}

export function NotebookGraph(props: { snapshot: ArchiveSnapshot; selected: string; onSelect: (path: string) => void }) {
  const [state, set] = createStore({ mode: 'local' as 'local' | 'all', filters: { notes: true, trials: true, sources: true }, query: '', hover: '',
    width: 400, height: 400, x: 0, y: 0, zoom: 1, dragging: false })
  let viewport!: HTMLDivElement, drag: { id: number; x: number; y: number } | undefined
  const graph = createMemo(() => notebookGraph(props.snapshot))
  const focused = createMemo(() => focusedGraph(graph(), props.selected, state.mode, state.filters))
  const nodes = createMemo(() => layoutNotebook(focused(), state.mode))
  const lookup = createMemo(() => new Map(nodes().map(node => [node.id, node])))
  const emphasis = () => state.hover || (state.mode === 'local' ? focused().selected : '')
  const related = createMemo(() => {
    const id = emphasis(), ids = new Set([id])
    for (const edge of focused().edges) { if (edge.source === id) ids.add(edge.target); if (edge.target === id) ids.add(edge.source) }
    return ids
  })
  const matches = createMemo(() => state.query.trim() ? graph().nodes.filter(node => `${node.title} ${node.path} ${node.label}`.toLowerCase().includes(state.query.trim().toLowerCase())) : [])
  const selected = () => graph().nodes.find(node => node.id === focused().selected)
  const hovered = () => graph().nodes.find(node => node.id === state.hover)
  const fit = () => {
    const points = nodes()
    if (!points.length) { set({ x: 0, y: 0, zoom: 1 }); return }
    const minX = Math.min(...points.map(node => node.x)) - 72, maxX = Math.max(...points.map(node => node.x)) + 72
    const minY = Math.min(...points.map(node => node.y)) - 52, maxY = Math.max(...points.map(node => node.y)) + 52
    const zoom = Math.max(.15, Math.min(1.2, (state.width - 32) / (maxX - minX), (state.height - 44) / (maxY - minY)))
    set({ x: -(minX + maxX) / 2 * zoom, y: -(minY + maxY) / 2 * zoom, zoom })
  }
  createEffect(() => { nodes(); state.width; state.height; untrack(() => { set('hover', ''); fit() }) })
  const zoomAt = (value: number, x = 0, y = 0) => {
    const zoom = Math.max(.15, Math.min(3, value)), ratio = zoom / state.zoom
    set({ zoom, x: x - (x - state.x) * ratio, y: y - (y - state.y) * ratio })
  }
  const wheel = (event: WheelEvent) => {
    event.preventDefault()
    const rect = viewport.getBoundingClientRect()
    zoomAt(state.zoom * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .003), event.clientX - rect.left - state.width / 2, event.clientY - rect.top - state.height / 2)
  }
  onMount(() => {
    const observer = new ResizeObserver(entries => { const box = entries[0]?.contentRect; if (box) set({ width: box.width, height: box.height }) })
    observer.observe(viewport); viewport.addEventListener('wheel', wheel, { passive: false })
    onCleanup(() => { observer.disconnect(); viewport.removeEventListener('wheel', wheel) })
  })
  const open = (path: string) => { set({ query: '', hover: '' }); props.onSelect(path) }
  return <div class="knowledge-panel notebook-explorer">
    <div class="notebook-graph-toolbar"><div class="notebook-mode" role="group" aria-label="Graph scope"><button aria-pressed={state.mode === 'local'} onClick={() => set('mode', 'local')}>Local graph</button><button aria-pressed={state.mode === 'all'} onClick={() => set('mode', 'all')}>Full campaign</button></div><span class="tiny faint">{nodes().length} / {graph().nodes.length}</span></div>
    <div class="notebook-graph-filters" role="group" aria-label="Graph filters"><For each={['notes', 'trials', 'sources'] as NotebookGroup[]}>{group => <button class={`filter-${group}`} aria-pressed={state.filters[group]} onClick={() => set('filters', group, value => !value)}><i />{group === 'notes' ? 'Notes' : group === 'trials' ? 'Trials' : 'Sources'}</button>}</For></div>
    <div class="notebook-search"><input aria-label="Find notebook document" placeholder="Find a note, trial or source…" value={state.query} onInput={event => set('query', event.currentTarget.value)} /><Show when={state.query}><button aria-label="Clear notebook search" onClick={() => set('query', '')}>×</button></Show></div>
    <Show when={state.query.trim()}><div class="notebook-search-results" aria-label="Matching documents"><For each={matches()}>{node => <button onClick={() => open(node.openPath)}><span>{node.label}</span><small>{node.title}</small></button>}</For><Show when={!matches().length}><p>No matching documents.</p></Show></div></Show>
    <div ref={viewport} classList={{ 'notebook-graph-viewport': true, dragging: state.dragging }} role="group" aria-label={state.mode === 'local' ? 'Local document graph' : 'Full campaign document graph'}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; viewport.setPointerCapture(event.pointerId); set('dragging', true)
      }} onPointerMove={event => {
        if (!drag || drag.id !== event.pointerId) return
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y
        set({ x: state.x + dx, y: state.y + dy }); drag.x = event.clientX; drag.y = event.clientY
      }} onPointerUp={() => { drag = undefined; set('dragging', false) }} onPointerCancel={() => { drag = undefined; set('dragging', false) }}>
      <div class="notebook-graph-world" style={{ transform: `translate(${state.width / 2 + state.x}px,${state.height / 2 + state.y}px) scale(${state.zoom})`, '--notebook-node-scale': 1 / state.zoom }}>
        <svg class="notebook-graph-edges" width="1" height="1" aria-hidden="true"><For each={focused().edges}>{edge => {
          const a = () => lookup().get(edge.source)!, b = () => lookup().get(edge.target)!
          return <line x1={a().x} y1={a().y} x2={b().x} y2={b().y} classList={{ emphasized: edge.source === emphasis() || edge.target === emphasis(), faded: !!emphasis() && edge.source !== emphasis() && edge.target !== emphasis() }} />
        }}</For></svg>
        <For each={nodes()}>{node => <button classList={{ 'notebook-dot': true, [`notebook-dot-${node.group}`]: true, active: focused().selected === node.id, faded: !!emphasis() && !related().has(node.id), labelled: state.mode === 'local' && nodes().length <= 16 || focused().selected === node.id || state.hover === node.id }}
          style={{ left: `${node.x}px`, top: `${node.y}px` }} aria-label={`Open ${node.label}: ${node.title}`} aria-pressed={focused().selected === node.id} title={`${node.title}\n${node.openPath}`} onMouseEnter={() => set('hover', node.id)} onMouseLeave={() => set('hover', '')} onFocus={() => set('hover', node.id)} onBlur={() => set('hover', '')} onClick={() => open(node.openPath)}><i /><span>{node.label}</span></button>}</For>
      </div>
      <Show when={!nodes().length}><p class="notebook-graph-empty">No linked documents in this view.</p></Show>
      <div class="notebook-zoom" aria-label="Graph navigation"><button aria-label="Zoom out graph" onClick={() => zoomAt(state.zoom / 1.25)}>−</button><span>{Math.round(state.zoom * 100)}%</span><button aria-label="Zoom in graph" onClick={() => zoomAt(state.zoom * 1.25)}>+</button><button aria-label="Fit graph" onClick={fit}>Fit</button></div>
    </div>
    <div class="notebook-focus-detail"><span>{hovered() ? 'Preview' : 'Selected document'}</span><strong>{hovered()?.title || selected()?.title || props.selected}</strong><small>{hovered()?.openPath || props.selected}</small></div>
    <div class="graph-legend"><span>{state.mode === 'local' ? 'Direct links · click to explore' : 'Hover to focus · click to read'}</span><span class="spacer" /><span>Drag · scroll to zoom</span></div>
  </div>
}
