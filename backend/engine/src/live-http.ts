import { AppError, type LiveWorkspace } from './live.ts'

async function body(request: Request, limit = 128 * 1024) {
  const reader = request.body?.getReader()
  if (!reader) throw new AppError('Missing request body')
  let size = 0; const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read(); if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); throw new AppError('Request is too large', 413) }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/** Same-origin local UI commands. Reading the app never creates a scientist or runs a prompt. */
export function liveHandler(workspace?: LiveWorkspace) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return Response.json({ error: 'Local workspace access only' }, { status: 403 })
    const origin = request.headers.get('origin')
    if ((origin && origin !== url.origin) || (request.method !== 'GET' && origin !== url.origin)) return Response.json({ error: 'Same-origin workspace requests required' }, { status: 403 })
    if (!workspace) return url.pathname === '/api/app/status' ? Response.json({ revision: 0, enabled: false, connected: false, running: false, streamText: '', thinkingLevels: [] }) : Response.json({ error: 'Live scientist access is disabled for this archive viewer.' }, { status: 403 })
    const id = url.searchParams.get('campaign') || ''
    try {
      if (request.method === 'GET') {
        if (url.pathname === '/api/app/status') return Response.json(workspace.status(id), { headers: { 'Cache-Control': 'no-store' } })
        if (url.pathname === '/api/app/models') return Response.json(await workspace.models())
        if (url.pathname === '/api/app/conversation') return Response.json(workspace.conversation(id), { headers: { 'Cache-Control': 'no-store' } })
        if (url.pathname === '/api/app/events') {
          workspace.entry(id)
          let off = () => {}, heartbeat: ReturnType<typeof setInterval> | undefined, closed = false
          const encoder = new TextEncoder()
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (event: unknown) => { if (!closed) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { closed = true } } }
              off = workspace.subscribe(id, send)
              send({ type: 'state', state: workspace.status(id) })
              heartbeat = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(': heartbeat\n\n')) } catch { closed = true; off(); clearInterval(heartbeat) } } }, 15000)
            },
            cancel() { closed = true; off(); clearInterval(heartbeat) },
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } })
        }
      }
      if (request.method === 'POST') {
        if (url.pathname === '/api/app/attachments') {
          const bytes = await body(request, 20 * 1024 * 1024)
          return Response.json(await workspace.upload(id, url.searchParams.get('name') || 'attachment', bytes), { status: 201 })
        }
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('JSON request required', 415)
        const data: unknown = JSON.parse(new TextDecoder().decode(await body(request)))
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('Expected an object')
        const row = data as Record<string, unknown>
        const string = (key: string) => typeof row[key] === 'string' ? row[key] as string : ''
        if (url.pathname === '/api/app/campaigns') return Response.json(await workspace.create(string('title'), string('brief')), { status: 201 })
        if (url.pathname === '/api/app/session') return Response.json(await workspace.start(id, row.new === true ? undefined : string('path') || undefined, row.new === true))
        if (url.pathname === '/api/app/message') {
          const attachments = row.attachments === undefined ? [] : row.attachments
          if (!Array.isArray(attachments) || !attachments.every(value => typeof value === 'string')) throw new AppError('Invalid attachments')
          return Response.json(await workspace.send(id, string('text'), string('sessionId'), attachments), { status: 202 })
        }
        if (url.pathname === '/api/app/stop') return Response.json(await workspace.stop(id))
        if (url.pathname === '/api/app/model') return Response.json(await workspace.configure(id, { provider: string('provider') || undefined, model: string('model') || undefined, thinking: string('thinking') || undefined }))
      }
      return Response.json({ error: 'Unknown app route or method' }, { status: 404 })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Workspace request failed' }, { status: error instanceof AppError ? error.status : 400 })
    }
  }
}
