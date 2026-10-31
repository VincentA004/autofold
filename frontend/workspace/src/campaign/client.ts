import type { ArchiveCatalog, ArchiveSession, ArchiveSnapshot } from '../../../../backend/engine/src/archive-types'

export type { ArchiveCatalog, ArchiveFile, ArchiveLink, ArchiveMessage, ArchiveNode, ArchiveSession, ArchiveSnapshot, ArchiveTrial, DisplayArtifact, DisplayMetric } from '../../../../backend/engine/src/archive-types'

// A navigation remounts the workspace, disposing all old requests, viewers and caches.
const selectedCampaign = new URLSearchParams(window.location.search).get('campaign') || ''
export const scoped = (path: string) => selectedCampaign ? `${path}${path.includes('?') ? '&' : '?'}campaign=${encodeURIComponent(selectedCampaign)}` : path

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `Archive request failed (${response.status})`)
  return body as T
}
export const archiveClient = {
  catalog: (signal?: AbortSignal) => get<ArchiveCatalog>('/api/archives', signal),
  campaign: selectedCampaign,
  openCampaign: (id: string) => { window.location.assign(`/?campaign=${encodeURIComponent(id)}`) },
  snapshot: (signal?: AbortSignal) => get<ArchiveSnapshot>(scoped('/api/archive'), signal),
  session: (path: string, signal?: AbortSignal) => get<ArchiveSession>(scoped(`/api/archive/session?path=${encodeURIComponent(path)}`), signal),
  text: (path: string, signal?: AbortSignal) => get<{ path: string; text: string }>(scoped(`/api/archive/file?path=${encodeURIComponent(path)}`), signal),
  raw: (path: string) => scoped(`/api/archive/file?raw=1&path=${encodeURIComponent(path)}`),
}

/** Chat references are campaign-relative; document references resolve from their containing file. */
export function resolveArchiveLink(href: string, source = ''): string | null {
  if (/^(?:[a-z][\w+.-]*:|\/\/|\/)/i.test(href)) return null
  let path: string
  try { path = decodeURIComponent(href.split(/[?#]/)[0] || '') } catch { return null }
  if (!path) return source || null
  const parts = (source ? source.split('/').slice(0, -1) : []).concat(path.split('/')), result: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') { if (!result.length) return null; result.pop() }
    else result.push(part)
  }
  return result.join('/')
}

/** Commands and events go to the embedded scientist in this same application. */
export async function appRequest<T>(route: string, data?: object | File): Promise<T> {
  const [name, ...query] = route.split('&')
  const url = scoped(`/api/app/${name}${query.length ? '?' + query.join('&') : ''}`)
  const response = await fetch(url, data === undefined ? undefined : data instanceof File ? {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data,
  } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Workspace request failed (${response.status})`)
  return result as T
}
