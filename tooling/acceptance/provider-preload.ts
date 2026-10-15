/** Test-process I/O adapter only. Actual Pi serialization, HTTP and SSE parsing remain intact. */
import {OFFLINE_API_KEY} from './provider'
const rawFetch=globalThis.fetch,configured=process.env.AUTOFOLD_TEST_PROVIDER_URL
if(!configured)throw Error('Offline provider preload requires AUTOFOLD_TEST_PROVIDER_URL')
const fixture=new URL(configured)
if(fixture.protocol!=='http:'||fixture.hostname!=='127.0.0.1')throw Error('Offline provider must bind IPv4 loopback')
const redirect=(input:RequestInfo|URL)=>{
 const url=new URL(input instanceof Request?input.url:String(input))
 if(url.origin==='https://openrouter.ai'&&url.pathname.startsWith('/api/v1/'))return new URL(url.pathname+url.search,fixture).href
 if(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))return url.href
 throw Error(`OFFLINE_NETWORK_DENIED ${url.origin}`)
}
globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const target=redirect(input),original=new URL(input instanceof Request?input.url:String(input))
 if(original.origin==='https://openrouter.ai'){
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined))
  if(headers.get('authorization')!==`Bearer ${OFFLINE_API_KEY}`)throw Error('Offline acceptance refuses a non-fixture provider credential')
 }
 return rawFetch(input instanceof Request?new Request(target,input):target,{...init,redirect:'error'})
},{preconnect:(url:string|URL)=>{redirect(url)}}) as typeof fetch
