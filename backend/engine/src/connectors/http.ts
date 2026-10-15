import type { RateLimit } from './types'
const allowed = new Map([
  ['eutils.ncbi.nlm.nih.gov', '/entrez/eutils/'], ['www.ebi.ac.uk', '/europepmc/webservices/rest/'],
  ['api.openalex.org', '/works'], ['api.semanticscholar.org', '/graph/v1/paper'], ['api.crossref.org', '/works'],
  ['api.biorxiv.org', '/details/'], ['export.arxiv.org', '/api/query'],
])
export interface HttpOptions { signal?: AbortSignal; timeout?: number; retries?: number; headers?: Record<string, string>; rateLimit?: RateLimit; looksValid?: (body: string) => boolean }
export type HttpTransport = (url: string | URL, options?: RequestInit) => Promise<Response>
export interface HttpClientOptions { transport?: HttpTransport; timeoutMs?: number; maximumResponseBytes?: number; retries?: number }
export class HttpClient {
  private readonly next = new Map<string, number>()
  constructor(private readonly options: HttpClientOptions = {}) {}
  private validate(value: string) {
    const url = new URL(value), prefix = allowed.get(url.hostname)
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !prefix || !url.pathname.startsWith(prefix)) throw new Error('Literature HTTP destination is outside registered public source APIs')
    return url
  }
  async request(value: string, opts: HttpOptions = {}) {
    const url = this.validate(value)
    const maximum = this.options.maximumResponseBytes ?? 2 * 1024 * 1024
    const timeout = opts.timeout ?? this.options.timeoutMs ?? 30_000
    const retries = Math.min(2, Math.max(0, opts.retries ?? this.options.retries ?? 1))
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024 || !Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('Invalid bounded literature HTTP policy')
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted()
      const pause = Math.max(0, (this.next.get(url.hostname) ?? 0) - Date.now())
      this.next.set(url.hostname, Date.now() + pause + (opts.rateLimit?.minIntervalMs ?? 0))
      if (pause) await wait(pause, opts.signal)
      const controller = new AbortController()
      const abort = () => controller.abort(opts.signal?.reason)
      opts.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error('Literature request deadline exceeded')), timeout)
      try {
        const response = await abortable(Promise.resolve().then(() => (this.options.transport ?? fetch)(url, { method: 'GET', redirect: 'error', headers: { 'User-Agent': 'autofold-literature/1.0', Accept: '*/*', ...opts.headers }, signal: controller.signal })), controller.signal)
        const length = Number(response.headers.get('content-length'))
        if (Number.isFinite(length) && length > maximum) throw new Error('Literature response exceeds byte limit')
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < retries) { await response.body?.cancel(); await wait(Math.min(1000 * 2 ** attempt, 5000), opts.signal); continue }
          throw new Error(`Literature source HTTP ${response.status}`)
        }
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []; let bytes = 0
        if (reader) try {
          for (;;) {
            const chunk = await abortable(reader.read(), controller.signal)
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > maximum) throw new Error('Literature response exceeds byte limit')
            chunks.push(chunk.value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        const body = Buffer.concat(chunks).toString('utf8')
        if (!body.trim() || opts.looksValid && !opts.looksValid(body)) throw new Error('Literature source returned an empty or invalid record')
        return { text: () => body, json: <T = unknown>() => JSON.parse(body) as T }
      } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort) }
    }
  }
  getJSON = async <T = unknown>(url: string, opts?: HttpOptions): Promise<T> => (await this.request(url, { ...opts, headers: { Accept: 'application/json', ...opts?.headers } })).json<T>()
  getText = async (url: string, opts?: HttpOptions) => (await this.request(url, opts)).text()
  orFallback = async <T>(promise: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> => { try { return await promise } catch (error) { signal?.throwIfAborted(); return fallback } }
}
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Literature operation cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Literature operation cancelled')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
async function wait(ms: number, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }), signal) } finally { clearTimeout(timer) }
}
