import { describe, expect, test } from 'bun:test'
import type { ArchiveSnapshot } from './client'
import { focusedGraph, layoutNotebook, notebookGraph } from './notebook-graph'

const snapshot = {
  nodes: [
    { id: 'notebook/index.md', path: 'notebook/index.md', title: 'Index', kind: 'notebook', files: ['notebook/index.md'] },
    { id: 'notebook/search.md', path: 'notebook/search.md', title: 'Search', kind: 'notebook', files: ['notebook/search.md'] },
    { id: 'output/trials/t-1', path: 'output/trials/t-1/plan.md', title: 'A long trial hypothesis', kind: 'trial', files: ['output/trials/t-1/plan.md', 'output/trials/t-1/assessment.md'] },
    { id: 'sources/paper.pdf', path: 'sources/paper.pdf', title: 'Paper', kind: 'source', files: ['sources/paper.pdf'] },
  ],
  files: ['notebook/index.md', 'notebook/search.md', 'output/trials/t-1/plan.md', 'output/trials/t-1/assessment.md', 'sources/paper.pdf'].map(path => ({ path, bytes: 1 })),
  trials: [{ path: 'output/trials/t-1', assessmentPath: 'output/trials/t-1/assessment.md', plan: 'output/trials/t-1/plan.md' }],
  links: [
    { source: 'notebook/index.md', target: 'notebook/search.md' },
    { source: 'notebook/search.md', target: 'output/trials/t-1' },
    { source: 'output/trials/t-1', target: 'notebook/search.md' },
    { source: 'output/trials/t-1', target: 'sources/paper.pdf' },
    { source: 'output/trials/t-1', target: 'output/trials/t-1' },
  ],
} as ArchiveSnapshot
const all = { notes: true, trials: true, sources: true }

describe('notebook navigation graph', () => {
  test('a trial opens its actual assessment and merges repeated file references', () => {
    const graph = notebookGraph(snapshot)
    expect(graph.nodes.find(node => node.group === 'trials')).toMatchObject({ label: 'Trial 01', openPath: 'output/trials/t-1/assessment.md' })
    expect(graph.edges).toHaveLength(3)
    const local = focusedGraph(graph, 'output/trials/t-1/assessment.md', 'local', all)
    expect(local.selected).toBe('output/trials/t-1')
    expect(local.nodes.map(node => node.id).sort()).toEqual(['notebook/search.md', 'output/trials/t-1', 'sources/paper.pdf'])
  })
  test('local views include incoming links but exclude documents two hops away', () => {
    const local = focusedGraph(notebookGraph(snapshot), 'notebook/search.md', 'local', all)
    expect(local.nodes.map(node => node.id).sort()).toEqual(['notebook/index.md', 'notebook/search.md', 'output/trials/t-1'])
    expect(local.edges).toHaveLength(2)
  })
  test('filters preserve the selected document and never leave dangling edges', () => {
    const local = focusedGraph(notebookGraph(snapshot), 'output/trials/t-1/plan.md', 'local', { notes: false, trials: false, sources: true })
    expect(local.nodes.map(node => node.id).sort()).toEqual(['output/trials/t-1', 'sources/paper.pdf'])
    expect(local.edges).toEqual([{ source: 'output/trials/t-1', target: 'sources/paper.pdf' }])
    expect(focusedGraph(notebookGraph(snapshot), 'notebook/index.md', 'all', all).nodes).toHaveLength(4)
  })
  test('large campaign layouts keep finite distinct node positions', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ ...notebookGraph(snapshot).nodes[0], id: `note-${i}` }))
    for (const mode of ['local', 'all'] as const) {
      const layout = layoutNotebook({ nodes, selected: 'note-0', edges: nodes.slice(1).map(node => ({ source: 'note-0', target: node.id })) }, mode)
      expect(layout.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
      expect(new Set(layout.map(node => `${node.x},${node.y}`)).size).toBe(100)
    }
  })
})
