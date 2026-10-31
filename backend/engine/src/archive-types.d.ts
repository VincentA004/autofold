/** Read-only projections. Campaign-relative paths always identify the underlying records. */
export interface ArchiveCatalog { defaultId: string; campaigns: { id: string; title: string }[] }
export interface ArchiveFile { path: string; bytes: number }
export interface DisplayMetric {
  label: string
  path: string
  pointer: string
  unit?: string
  meaning?: string
  value?: number | string | boolean | null
  error?: string
}
export interface DisplayArtifact { path: string; label: string; kind: 'protein-structure' | 'chem-3d' | 'chem-2d' }
export interface TrialDisplay {
  path: string
  title?: string
  metrics: DisplayMetric[]
  artifacts: DisplayArtifact[]
}
export interface ArchiveTrial {
  id: string
  path: string
  title: string
  createdAt: string | null
  execution: Record<string, unknown> | null
  assessment: 'recorded' | 'pending' | 'incomplete'
  plan: string | null
  assessmentPath: string | null
  files: ArchiveFile[]
  display: TrialDisplay
}
export interface ArchiveNode {
  id: string
  path: string
  title: string
  kind: 'notebook' | 'trial' | 'source' | 'document' | 'artifact'
  files: string[]
}
export interface ArchiveLink {
  source: string
  target: string
  sourcePath: string
  targetPath: string
  label: string
  section: string
  line: number
  kind: 'cites' | 'uses' | 'current-notebook'
  capturedPath?: string
}
export interface ArchiveMessage {
  id: string
  role: 'user' | 'assistant' | 'toolResult'
  text: string
  timestamp: string
  tools: { id: string; name: string; input: unknown }[]
  toolCallId?: string
}
export interface ArchiveSession { path: string; id: string; title: string; messages: ArchiveMessage[] }
export interface ArchiveSnapshot {
  title: string
  campaign: string
  files: ArchiveFile[]
  trials: ArchiveTrial[]
  nodes: ArchiveNode[]
  links: ArchiveLink[]
  sessions: { path: string; id: string; title: string }[]
  warnings: string[]
}
