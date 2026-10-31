import { readFile, realpath, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { parseSessionEntries, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ArchiveFile, ArchiveLink, ArchiveMessage, ArchiveNode, ArchiveSession, ArchiveSnapshot, ArchiveTrial, DisplayArtifact, DisplayMetric } from './archive-types'

const MAX_TEXT = 8 * 1024 * 1024
const MAX_SESSION = 64 * 1024 * 1024
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const title = (text: string, fallback: string) => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || fallback
const trialRoot = (path: string) => /^output\/trials\/t-[^/]+(?:\/|$)/.test(path) ? path.split('/').slice(0, 3).join('/') : null

/** Resolve both lexical and symlink boundaries. Only the explicitly opened campaign is exposed. */
export async function archivePath(root: string, path: string, sessions = false): Promise<string> {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error('Invalid campaign-relative path')
  const normalized = posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Path is outside this campaign')
  const parts = normalized.split('/')
  if (parts.some(p => p.startsWith('.')) && !(sessions && /^\.autofold\/sessions\/[^/]+\.jsonl$/.test(normalized))) {
    throw new Error('Private campaign files are not available through the archive browser')
  }
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(resolve(canonicalRoot, normalized))
  const rel = relative(canonicalRoot, canonical)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path is outside this campaign')
  return canonical
}

async function textFile(root: string, path: string, sessions = false) {
  const file = await archivePath(root, path, sessions)
  const info = await stat(file)
  if (!info.isFile() || info.size > (sessions ? MAX_SESSION : MAX_TEXT)) throw new Error(`File exceeds the ${sessions ? 'session' : 'text'} preview limit: ${path}`)
  return readFile(file, 'utf8')
}

async function inventory(root: string, directory = ''): Promise<ArchiveFile[]> {
  const result: ArchiveFile[] = []
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.isSymbolicLink() || item.name === '__pycache__') continue
    const path = posix.join(directory, item.name)
    if (item.isDirectory()) result.push(...await inventory(root, path))
    else if (item.isFile()) result.push({ path, bytes: (await stat(join(root, path))).size })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

/** This mirrors the notebook's documented inline-link convention, ignoring code examples. */
export function markdownLinks(text: string, path: string) {
  const result: { target: string; label: string; section: string; line: number }[] = []
  let fence: string | null = null, section = ''
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) section = heading[1]!
    const clean = line.replace(/(`+).*?\1/g, '')
    for (const match of clean.matchAll(/(?<!!)\[([^\]\n]*)\]\((<[^>\n]+>|[^\s()]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[2]!.replace(/^<|>$/g, '')
      if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(href) || href.startsWith('/')) continue
      let target: string
      try { target = decodeURIComponent(href.split(/[?#]/)[0]!) } catch { continue }
      target = target ? posix.normalize(posix.join(posix.dirname(path), target)) : path
      result.push({ target, label: match[1]!, section, line: index + 1 })
    }
  }
  return result
}

export function jsonPointer(data: unknown, pointer: string): unknown {
  if (pointer === '') return data
  if (!pointer.startsWith('/')) throw new Error('Metric pointer must be an RFC 6901 JSON pointer')
  let current = data
  for (const token of pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, token)) throw new Error(`Missing field at ${pointer}`)
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function nodeId(path: string) {
  const trial = trialRoot(path)
  if (trial) return trial
  if (path.startsWith('sources/')) return path.split('/').slice(0, path.split('/').length > 3 ? 3 : 2).join('/')
  return path
}

/** Native Pi tree projection in memory: never opens a writable session or creates a scientist. */
export async function readArchiveSession(root: string, path: string): Promise<ArchiveSession> {
  if (!/^\.autofold\/sessions\/[^/]+\.jsonl$/.test(path)) throw new Error('Invalid session path')
  const raw = await textFile(root, path, true)
  const entries = parseSessionEntries(raw)
  if (entries[0]?.type !== 'session') throw new Error('Not a native Pi session')
  const session = SessionManager.inMemory(root, undefined, entries)
  const messages: ArchiveMessage[] = []
  for (const entry of session.getBranch()) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') continue
    const content: unknown = message.content
    const parts = Array.isArray(content) ? content.filter(record) : []
    const text = typeof content === 'string' ? content : parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
    // Thinking/signatures are deliberately not part of the public conversation projection.
    const tools = parts.filter(p => p.type === 'toolCall').map(p => ({ id: String(p.id), name: String(p.name), input: p.arguments }))
    if (text || tools.length) messages.push({ id: entry.id, role: message.role, text, tools, timestamp: entry.timestamp,
      ...(message.role === 'toolResult' ? { toolCallId: message.toolCallId } : {}) })
  }
  const name = session.getSessionName() || messages.find(m => m.role === 'user')?.text.slice(0, 90) || 'Saved scientist session'
  return { path, id: session.getSessionId(), title: name, messages }
}

export async function readArchive(root: string): Promise<ArchiveSnapshot> {
  const campaign = await textFile(root, 'campaign.md')
  const files = await inventory(root), paths = new Set(files.map(f => f.path)), warnings: string[] = []
  const sessions: ArchiveSnapshot['sessions'] = []
  try {
    for (const item of await readdir(join(root, '.autofold/sessions'), { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue
      const path = `.autofold/sessions/${item.name}`
      try {
        const session = await readArchiveSession(root, path)
        sessions.push({ path, id: session.id, title: session.title })
        paths.add(path) // Navigable through the session projection, never the raw file service.
      } catch (error) { warnings.push(`${path}: ${String(error)}`) }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Sessions: ${String(error)}`) }
  const readJSON = async (path: string): Promise<Record<string, unknown> | null> => {
    if (!paths.has(path)) return null
    try {
      const value: unknown = JSON.parse(await textFile(root, path))
      if (!record(value)) throw new Error('Expected a JSON object')
      return value
    } catch (error) { warnings.push(`${path}: ${String(error)}`); return null }
  }
  const manifest = await readJSON('analysis/display.json')
  const displayRows = manifest?.version === 1 && Array.isArray(manifest.trials) ? manifest.trials.filter(record) : []
  if (manifest && (manifest.version !== 1 || !Array.isArray(manifest.trials))) warnings.push('Unsupported display manifest; showing the archive without curated previews.')
  const roots = [...new Set(files.map(f => trialRoot(f.path)).filter((v): v is string => !!v))]
  const trials: ArchiveTrial[] = []
  for (const path of roots) {
    const receipt = await readJSON(`${path}/execution.json`), spec = await readJSON(`${path}/trial.json`)
    const row = displayRows.find(d => d.path === path)
    const captured = new Set<string>()
    for (const list of [spec?.snapshot, receipt?.artifacts]) {
      if (Array.isArray(list)) for (const item of list.filter(record)) if (typeof item.path === 'string') captured.add(`${path}/${item.path}`)
    }
    const metrics: DisplayMetric[] = []
    for (const item of Array.isArray(row?.metrics) ? row.metrics.filter(record) : []) {
      if (typeof item.label !== 'string' || typeof item.path !== 'string' || typeof item.pointer !== 'string') { warnings.push(`${path}: invalid metric descriptor`); continue }
      const metric: DisplayMetric = { label: item.label, path: item.path, pointer: item.pointer }
      if (typeof item.unit === 'string') metric.unit = item.unit
      if (typeof item.meaning === 'string') metric.meaning = item.meaning
      try {
        // Metrics must reference a saved captured record, not an editable working result.
        if (!captured.has(metric.path)) throw new Error('Metric source is not inventoried in this trial')
        const value = jsonPointer(JSON.parse(await textFile(root, metric.path)), metric.pointer)
        if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) throw new Error('Metric is not a scalar')
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Metric is not finite')
        metric.value = value as DisplayMetric['value']
      } catch (error) { metric.error = String(error); warnings.push(`${path}: ${metric.label}: ${metric.error}`) }
      metrics.push(metric)
    }
    const artifacts: DisplayArtifact[] = []
    for (const item of Array.isArray(row?.artifacts) ? row.artifacts.filter(record) : []) {
      if (typeof item.path !== 'string' || typeof item.label !== 'string' || !['protein-structure', 'chem-3d', 'chem-2d'].includes(String(item.kind))) { warnings.push(`${path}: invalid artifact descriptor`); continue }
      if (!captured.has(item.path) || !paths.has(item.path)) { warnings.push(`${path}: preview is not an available captured artifact: ${item.path}`); continue }
      artifacts.push({ path: item.path, label: item.label, kind: item.kind as DisplayArtifact['kind'] })
    }
    // Unannotated archives can still preview a saved coordinate file. Do not infer
    // its chain identities, prediction status, metric meanings or scientific rank.
    if (!row && !artifacts.length) {
      const saved = files.find(f => captured.has(f.path) && f.path.startsWith(`${path}/output/`) && /\.(cif|mmcif|pdb)$/i.test(f.path))
      if (saved) artifacts.push({ path: saved.path, label: `Saved coordinates · ${saved.path.split('/').at(-1)}`, kind: 'protein-structure' })
    }
    const plan = paths.has(`${path}/plan.md`) ? `${path}/plan.md` : null
    const hasAssessment = paths.has(`${path}/assessment.md`), hasCommit = paths.has(`${path}/assessment.json`)
    const planTitle = plan ? title(await textFile(root, plan), path.split('/').at(-1)!) : path.split('/').at(-1)!
    trials.push({ id: path.split('/').at(-1)!, path, title: typeof row?.title === 'string' ? row.title : typeof spec?.intent === 'string' ? spec.intent : planTitle,
      createdAt: typeof spec?.created_at === 'string' ? spec.created_at : typeof receipt?.started_at === 'string' ? receipt.started_at : null,
      execution: receipt, assessment: hasAssessment && hasCommit ? 'recorded' : hasAssessment || hasCommit ? 'incomplete' : 'pending', plan,
      assessmentPath: hasAssessment ? `${path}/assessment.md` : null, files: files.filter(f => f.path.startsWith(`${path}/`)), display: { path, metrics, artifacts } })
  }
  trials.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.path.localeCompare(b.path))
  const nodes = new Map<string, ArchiveNode>(), links: ArchiveLink[] = []
  const addNode = (path: string, label?: string) => {
    const id = nodeId(path), existing = nodes.get(id)
    if (existing) {
      if (!existing.files.includes(path)) existing.files.push(path)
      if (label && existing.kind !== 'trial' && existing.id === path) existing.title = label
      return id
    }
    const kind: ArchiveNode['kind'] = trialRoot(path) ? 'trial' : path.startsWith('notebook/') ? 'notebook' : path.startsWith('sources/') ? 'source' : /\.md$/i.test(path) ? 'document' : 'artifact'
    nodes.set(id, { id, path, title: trials.find(t => t.path === id)?.title || label || path.split('/').at(-1)!, kind, files: [path] })
    return id
  }
  const markdown = files.filter(f => /\.md$/i.test(f.path) && (f.path === 'campaign.md' || f.path.startsWith('notebook/') || /^output\/trials\/[^/]+\/(plan|assessment)\.md$/.test(f.path)))
  for (const file of markdown) {
    const content = await textFile(root, file.path)
    addNode(file.path, title(content, file.path.split('/').at(-1)!))
    for (const link of markdownLinks(content, file.path)) {
      const directory = link.target.endsWith('/') && files.some(f => f.path.startsWith(link.target))
      if (!paths.has(link.target) && !directory) { warnings.push(`${file.path}:${link.line}: unresolved link ${link.target}`); continue }
      links.push({ source: addNode(file.path), target: addNode(link.target), sourcePath: file.path, targetPath: link.target,
        label: link.label, section: link.section, line: link.line, kind: /^notebook navigation$/i.test(link.section) ? 'current-notebook' : 'cites' })
    }
  }
  for (const trial of trials) {
    addNode(trial.assessmentPath || trial.plan || `${trial.path}/execution.json`)
    const spec = await readJSON(`${trial.path}/trial.json`)
    for (const input of Array.isArray(spec?.inputs) ? spec.inputs.filter(record) : []) {
      if (typeof input.source !== 'string' || typeof input.path !== 'string') continue
      const capturedPath = `${trial.path}/${input.path}`
      if (paths.has(input.source) && paths.has(capturedPath)) links.push({ source: trial.path, target: addNode(input.source), sourcePath: `${trial.path}/trial.json`, targetPath: input.source,
        label: input.path, section: 'Declared inputs', line: 0, kind: 'uses', capturedPath })
    }
  }
  return { title: title(campaign, 'Campaign'), campaign: 'campaign.md', files, trials, nodes: [...nodes.values()], links, sessions: sessions.sort((a, b) => b.path.localeCompare(a.path)), warnings: [...new Set(warnings)] }
}

export { textFile as readArchiveText }
