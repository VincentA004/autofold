import { parseArgs } from 'node:util'
import { realpath, stat, mkdir, writeFile } from 'node:fs/promises'
import { extname, resolve, join } from 'node:path'
import { archivePath, readArchive, readArchiveSession, readArchiveText } from './archive.ts'
import { campaignCatalog } from './archives.ts'
import { LiveWorkspace } from './live.ts'
import { liveHandler } from './live-http.ts'

/** A configured campaign catalog, GET only. No agent creation, mutation, or execution routes. */
export function archiveHandler(defaultRoot: string, webRoot?: string, catalog?: Awaited<ReturnType<typeof campaignCatalog>>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return Response.json({ error: 'Local archive access only' }, { status: 403 })
    // Keep the file service local; Vite accesses it through its same-origin development proxy.
    if (request.method !== 'GET') return Response.json({ error: 'This campaign is open read only' }, { status: 405, headers: { Allow: 'GET' } })
    const origin = request.headers.get('origin')
    if (origin && origin !== url.origin) return Response.json({ error: 'Cross-origin access is not permitted' }, { status: 403 })
    try {
      if (url.pathname === '/api/archives') return Response.json(catalog?.publicCatalog || { defaultId: '', campaigns: [] }, { headers: { 'Cache-Control': 'no-store' } })
      const campaign = url.searchParams.get('campaign')
      const root = campaign ? catalog?.entries.find(entry => entry.id === campaign)?.root : defaultRoot
      if (url.pathname.startsWith('/api/archive') && !root) return Response.json({ error: 'Unknown campaign' }, { status: 404 })
      if (url.pathname === '/api/archive') return Response.json(await readArchive(root!), { headers: { 'Cache-Control': 'no-store' } })
      if (url.pathname === '/api/archive/session') return Response.json(await readArchiveSession(root!, url.searchParams.get('path') || ''), { headers: { 'Cache-Control': 'no-store' } })
      if (url.pathname === '/api/archive/file') {
        const path = url.searchParams.get('path') || ''
        if (url.searchParams.get('raw') === '1') {
          const absolute = await archivePath(root!, path), info = await stat(absolute)
          if (!info.isFile()) throw new Error('Not a file')
          return new Response(Bun.file(absolute), { headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
        }
        return Response.json({ path, text: await readArchiveText(root!, path) }, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (webRoot && !url.pathname.startsWith('/api/')) {
        const path = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
        try {
          const file = await archivePath(webRoot, path)
          if ((await stat(file)).isFile()) return new Response(Bun.file(file), { headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' } })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (!extname(path)) return new Response(Bun.file(await archivePath(webRoot, 'index.html')))
        }
      }
      return Response.json({ error: 'Not found' }, { status: 404 })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Cannot read campaign record' }, { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400 })
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'archives-dir': { type: 'string' }, live: { type: 'boolean' }, 'web-root': { type: 'string' }, port: { type: 'string', default: '4096' }, help: { type: 'boolean' } } })
  if (values.help || (!values.workspace && !values.live)) {
    console.log('Read-only campaign browser: bun run backend/engine/src/web.ts --workspace /path/to/campaign [--archives-dir /path/to/archive-parent] [--port 4096] [--web-root frontend/workspace/dist] [--live]')
    if (!values.help) process.exitCode = 1
  } else {
    const candidate = resolve(values.workspace || join(values['archives-dir'] || '.autofold', 'workspace', 'campaign'))
    if (!values.workspace && values.live) {
      await mkdir(candidate, { recursive: true })
      try { await writeFile(join(candidate, 'campaign.md'), '# Research workspace\n\nInvestigate the user’s objective using the native scientist, linked notebook and captured Proto trials. Establish a bounded plan and budget before scientific execution.\n', { flag: 'wx' }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const root = await realpath(candidate)
    await readArchiveText(root, 'campaign.md')
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
    const webRoot = values['web-root'] ? await realpath(resolve(values['web-root'])) : undefined
    const catalog = await campaignCatalog(root, values['archives-dir'] ? resolve(values['archives-dir']) : undefined)
    const workspace = values.live ? new LiveWorkspace(catalog, { archivesDirectory: values['archives-dir'] ? resolve(values['archives-dir']) : undefined }) : undefined
    const app = liveHandler(workspace), archive = archiveHandler(root, webRoot, catalog)
    const server = Bun.serve({ hostname: '127.0.0.1', port, fetch(request, server) {
      if (new URL(request.url).pathname === '/api/app/events') server.timeout(request, 0)
      return new URL(request.url).pathname.startsWith('/api/app/') ? app(request) : archive(request)
    } })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await workspace?.dispose(); await server.stop(true); process.exit(0) })
    console.log(`Campaign archive: ${root}\n${values.live ? 'Live workspace' : 'Read-only API'}: ${server.url}`)
  }
}
