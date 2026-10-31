import type { ArchiveNode, ArchiveSnapshot } from './client'

export type NotebookGroup = 'notes' | 'trials' | 'sources'
export type NotebookNode = ArchiveNode & { group: NotebookGroup; label: string; openPath: string }
export type NotebookEdge = { source: string; target: string }
export type PositionedNode = NotebookNode & { x: number; y: number }

/** One trial stays one node, even when several captured files link to it. */
export function notebookGraph(snapshot: ArchiveSnapshot) {
  const nodes: NotebookNode[] = snapshot.nodes.map(node => {
    const trialIndex = snapshot.trials.findIndex(trial => trial.path === node.id)
    const trial = snapshot.trials[trialIndex]
    return { ...node, group: node.kind === 'trial' ? 'trials' : ['notebook', 'document'].includes(node.kind) ? 'notes' : 'sources',
      label: trial ? `Trial ${String(trialIndex + 1).padStart(2, '0')}` : node.path === 'notebook/index.md' ? 'Notebook' : node.path === 'campaign.md' ? 'Campaign' : node.path.split('/').at(-1) || node.title,
      openPath: trial?.assessmentPath || trial?.plan || node.files.find(path => snapshot.files.some(file => file.path === path)) || node.path }
  })
  const ids = new Set(nodes.map(node => node.id)), seen = new Set<string>()
  const edges: NotebookEdge[] = []
  for (const link of snapshot.links) {
    if (link.source === link.target || !ids.has(link.source) || !ids.has(link.target)) continue
    const key = JSON.stringify([link.source, link.target].sort())
    if (seen.has(key)) continue
    seen.add(key); edges.push({ source: link.source, target: link.target })
  }
  return { nodes, edges }
}

export function focusedGraph(graph: ReturnType<typeof notebookGraph>, path: string, mode: 'local' | 'all', filters: Record<NotebookGroup, boolean>) {
  const selected = graph.nodes.find(node => node.id === path || node.path === path || node.files.includes(path))
  const neighborhood = new Set(selected ? [selected.id] : [])
  for (const edge of graph.edges) {
    if (edge.source === selected?.id) neighborhood.add(edge.target)
    if (edge.target === selected?.id) neighborhood.add(edge.source)
  }
  const nodes = graph.nodes.filter(node => (mode === 'all' || neighborhood.has(node.id)) && (node.id === selected?.id || filters[node.group]))
  const ids = new Set(nodes.map(node => node.id))
  return { nodes, selected: selected?.id, edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) }
}

/** Deterministic, spaced graph layout; positions carry no scientific meaning. */
export function layoutNotebook(graph: ReturnType<typeof focusedGraph>, mode: 'local' | 'all'): PositionedNode[] {
  const ordered = [...graph.nodes].sort((a, b) => Number(b.id === graph.selected) - Number(a.id === graph.selected) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id))
  const nodes = ordered.map((node, i) => {
    const ring = i === 0 ? 0 : Math.ceil((Math.sqrt(1 + 4 * i / 3) - 1) / 2)
    const first = 1 + 3 * (ring - 1) * ring, count = Math.min(6 * ring, ordered.length - first)
    const angle = count ? (i - first) / count * Math.PI * 2 - Math.PI / 2 : 0
    const radius = ring * 125
    return { ...node, x: i ? Math.cos(angle) * radius : 0, y: i ? Math.sin(angle) * radius : 0 }
  })
  if (mode === 'local') return nodes
  const lookup = new Map(nodes.map((node, i) => [node.id, i]))
  // A bounded force pass lets connected notes cluster without adding a library.
  for (let step = 0; step < 140; step++) {
    const forces = nodes.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x || .1, dy = nodes[i].y - nodes[j].y || .1
      const d2 = Math.max(100, dx * dx + dy * dy), magnitude = 16000 / d2
      const x = dx / Math.sqrt(d2) * magnitude, y = dy / Math.sqrt(d2) * magnitude
      forces[i].x += x; forces[i].y += y; forces[j].x -= x; forces[j].y -= y
    }
    for (const edge of graph.edges) {
      const a = lookup.get(edge.source)!, b = lookup.get(edge.target)!, dx = nodes[b].x - nodes[a].x, dy = nodes[b].y - nodes[a].y
      const distance = Math.max(1, Math.hypot(dx, dy)), force = (distance - 125) * .012
      forces[a].x += dx / distance * force; forces[a].y += dy / distance * force
      forces[b].x -= dx / distance * force; forces[b].y -= dy / distance * force
    }
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].x += Math.max(-9, Math.min(9, forces[i].x - nodes[i].x * .0015))
      nodes[i].y += Math.max(-9, Math.min(9, forces[i].y - nodes[i].y * .0015))
    }
  }
  return nodes
}
