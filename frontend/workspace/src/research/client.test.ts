import {expect, test} from 'bun:test'
import {apiURL, ResearchClient, ResearchHTTPError, refreshNeeds, messageText, ongoing, blocksDiscovery, type ResearchFetch} from './client'
test('Pi research client posts only scoped job options and keeps access token out of URL/body', async () => {
  const requests: Request[] = []
  const fetcher: ResearchFetch = async (input, init) => {const request = new Request(input, init); requests.push(request); return Response.json({id: 'job_fixture', status: 'queued'})}
  const client = new ResearchClient('http://127.0.0.1:4096/', 'fixture-token', fetcher)
  const result = await client.request<{status: string}>('/research/experiments/exp_fixture/autoresearch', {idempotencyKey: 'message-fixture', iterations: 1, conversation: true, prompt: 'Explain the last result', allowCompute: false})
  expect(result.status).toBe('queued')
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer fixture-token')
  const body = await requests[0]!.json()
  expect(body.allowCompute).toBe(false)
  expect(JSON.stringify(body)).not.toContain('fixture-token')
  expect(requests[0]!.url).not.toContain('fixture-token')
  expect(requests[0]!.method).toBe('POST')
})
test('backend errors remain visible and endpoint credentials are rejected', async () => {
  const client = new ResearchClient('http://localhost:4096', '', async () => Response.json({error: 'Program changed since it was opened'}, {status: 400}))
  await expect(client.request('/research/experiments/exp_fixture/workspace/file', {})).rejects.toThrow('Program changed')
  for (const value of ['javascript:alert(1)', 'http://user:password@localhost:4096', 'http://localhost:4096/?key=secret']) expect(() => apiURL(value)).toThrow()
})
test('Pi messages and durable running states project without old SDK event types', () => {
  expect(messageText({role: 'assistant', content: [{type: 'text', text: 'Use the committed result'}, {type: 'toolCall', name: 'read_context', arguments: {}}]})).toContain('read_context')
  expect(ongoing({id: 'job_fixture', status: 'retry_wait', payload: {kind: 'autoresearch'}})).toBe(true)
  expect(ongoing({id: 'job_fixture', status: 'interrupted', payload: {kind: 'autoresearch'}})).toBe(true)
  expect(ongoing({id: 'job_fixture', status: 'recovery_required', payload: {kind: 'autoresearch'}})).toBe(true)
  expect(ongoing({id: 'job_fixture', status: 'cancelled', payload: {kind: 'autoresearch'}})).toBe(false)
  expect(blocksDiscovery({id:'job_held_compute',status:'recovery_required',payload:{kind:'autoresearch'}})).toBe(true)
  expect(blocksDiscovery({id:'job_optional_lookup',status:'recovery_required',payload:{kind:'knowledge_refresh'}})).toBe(false)
  expect(blocksDiscovery({id:'job_optional_review',status:'interrupted',payload:{kind:'knowledge_review'}})).toBe(false)
})
test('default native fetch is invoked without binding it to the client instance', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = function(this: unknown, ..._args: Parameters<typeof fetch>) {
    if (this && this !== globalThis) throw new Error('Illegal native fetch receiver')
    return Promise.resolve(Response.json({runtime: 'pi'}))
  } as typeof fetch
  try {expect(await new ResearchClient('http://localhost:4096').request<{runtime:string}>('/health')).toEqual({runtime: 'pi'})}
  finally {globalThis.fetch = prior}
})

test('Research API exposes typed errors and requests only current bounded cursor pages',async()=>{
 const routes:string[]=[],client=new ResearchClient('http://localhost:4096','',async(input)=>{routes.push(String(input));return Response.json({messages:[],trials:[],runs:[],evaluations:[],knowledge:[]})})
 await client.sessionPage('ses_cursor',100,'sha256:original');await client.history('exp_cursor',50)
 expect(routes[0]).toContain('/research/sessions/ses_cursor/messages?limit=100&offset=100&anchor=');expect(routes[1]).toContain('/history?limit=50&offset=50')
 const failed=new ResearchClient('http://localhost:4096','',async()=>Response.json({error:'Session storage unavailable'},{status:500}))
 try{await failed.sessionPage('ses_cursor');throw new Error('expected error')}catch(error){expect(error).toBeInstanceOf(ResearchHTTPError);expect((error as ResearchHTTPError).status).toBe(500)}
 expect(refreshNeeds('scientist')).toEqual({knowledge:false,skills:false,workspace:false,history:false,session:true})
 expect(refreshNeeds('evidence').history).toBe(true);expect(refreshNeeds('programs').workspace).toBe(true)
})

test('large original message retrieval is a bounded hash-bound byte page',async()=>{
 const routes:string[]=[],client=new ResearchClient('http://localhost:4096','',async(input)=>{routes.push(String(input));return Response.json({text:'{"role":"assistant"',offsetBytes:0,nextOffsetBytes:19,totalBytes:300000,hasMore:true,messageHash:'sha256:bound'})})
 const page=await client.messageFragment('ses_cursor',7,0,'sha256:bound')
 expect(routes[0]).toContain('/messages/7/content?offsetBytes=0&limitBytes=32768&expectedHash=sha256%3Abound');expect(page.hasMore).toBe(true)
})

test('transcript window remains bounded while reset replaces stale observations',async()=>{
 const {appendTranscriptPage}=await import('./client')
 const original={id:'ses_window',messages:Array.from({length:399},(_,i)=>({role:'assistant',content:String(i)}))}
 const page={session:{id:'ses_window'},messages:[{role:'assistant',content:'399'},{role:'assistant',content:'400'}],offset:399,nextOffset:401,totalMessages:900,hasMore:true,reset:false}
 const view=appendTranscriptPage(original,page);expect(view.messages).toHaveLength(400);expect(view.messages[0]!.content).toBe('1');expect(view.messages.at(-1)!.content).toBe('400')
 expect(appendTranscriptPage(view,{...page,reset:true}).messages).toHaveLength(2)
})
