import type { SummaryMetricSource } from './summary-values'
/** Optional, campaign-authored display copy. Scientific values still come from captured files. */
export interface WorkspacePresentation {
  title?: string
  topic?: string
  atlasSubtitle?: string
  atlasNote?: string
  campaignSummary?: string
  conversation?: string
  conversationDetail?: string
  direction?: string
  handoff?: string
  shortlist?: string
  overview?: { question: string; paragraphs: string[]; caution: string; next: string }
  documents?: Record<string, string>
  graph?: Array<{ path: string; label: string; x: number; y: number }>
  trials?: Record<string, { kind?: string; caption?: string; question?: string; result?: string; note?: string; files?: string[]; metrics?: SummaryMetricSource[] }>
}

export function presentationFrom(value: unknown): WorkspacePresentation {
  // The manifest is campaign data, not executable UI. Drop malformed fields.
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>, result: WorkspacePresentation = {}
  for (const key of ['title', 'topic', 'atlasSubtitle', 'atlasNote', 'campaignSummary', 'conversation', 'conversationDetail', 'direction', 'handoff', 'shortlist'] as const) if (typeof row[key] === 'string') result[key] = row[key]
  if (row.documents && typeof row.documents === 'object') result.documents = Object.fromEntries(Object.entries(row.documents).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  if (Array.isArray(row.graph)) result.graph = row.graph.filter(n => n && typeof n.path === 'string' && typeof n.label === 'string' && Number.isFinite(n.x) && Number.isFinite(n.y))
  if (row.overview && typeof row.overview === 'object') {
    const o = row.overview as Record<string, unknown>
    if (typeof o.question === 'string' && Array.isArray(o.paragraphs) && o.paragraphs.every(p => typeof p === 'string') && typeof o.caution === 'string' && typeof o.next === 'string') result.overview = o as unknown as NonNullable<WorkspacePresentation['overview']>
  }
  if (row.trials && typeof row.trials === 'object') result.trials = Object.fromEntries(Object.entries(row.trials).filter(([, v]) => v && typeof v === 'object').map(([id, v]) => {
    const entry = v as Record<string, unknown>, trial: NonNullable<WorkspacePresentation['trials']>[string] = {}
    for (const key of ['kind', 'caption', 'question', 'result', 'note'] as const) if (typeof entry[key] === 'string') trial[key] = entry[key]
    if (Array.isArray(entry.metrics)) trial.metrics = entry.metrics.filter(m => m && typeof m.label === 'string' && typeof m.path === 'string' && typeof m.pointer === 'string' && (m.filter === undefined || (m.filter && typeof m.filter === 'object' && typeof m.filter.pointer === 'string' && ['string', 'number', 'boolean'].includes(typeof m.filter.equals))))
    if (Array.isArray(entry.files)) trial.files = entry.files.filter(f => typeof f === 'string')
    return [id, trial]
  }))
  return result
}
