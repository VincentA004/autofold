/** Test-only preload: real provider/connector traffic fails locally. */
const localFetch = globalThis.fetch.bind(globalThis)
// Keep the user's shell and credentials untouched; this process is offline.
delete process.env.OPENROUTER_API_KEY
const guardedFetch: typeof fetch = ((input: RequestInfo | URL, options?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('External network is disabled in offline software tests; inject a provider or connector fixture')
  }
  return localFetch(input, {...options, redirect: 'error'})
}) as typeof fetch
Object.assign(guardedFetch, {offlineSoftwareTests: true, preconnect: () => {throw new Error('Network preconnect is disabled in offline tests')}})
globalThis.fetch = guardedFetch

export {}
