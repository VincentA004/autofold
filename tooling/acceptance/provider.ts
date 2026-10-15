import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'

export const OFFLINE_API_KEY='autofold-offline-acceptance-key'
export type WireMessage={role:string;content?:unknown;tool_call_id?:string;tool_calls?:{id:string;type:'function';function:{name:string;arguments:string}}[];[key:string]:unknown}
export type WireRequest={model:string;messages:WireMessage[];tools?:unknown[];stream?:boolean;[key:string]:unknown}
export type ActorReply={text?:string;reasoning?:string;calls?:{id?:string;name:string;arguments:Record<string,unknown>}[];reportedCostUsd?:number|null;finishReason?:'stop'|'tool_calls'}
/** The actor gets exactly the HTTP request. No research store, job or host state. */
export type WireActor=(request:Readonly<WireRequest>)=>ActorReply|Promise<ActorReply>
export type ProviderJournalEntry={sequence:number;at:string;event:'request'|'response'|'invoice'|'generation_lookup'|'fixture_error';requestId:string;[key:string]:unknown}
const hash=(bytes:string)=>'sha256:'+createHash('sha256').update(bytes).digest('hex')

export async function createProviderFixture(options:{journalPath:string;actor:WireActor;maximumRequests?:number}){
 await fs.mkdir(path.dirname(options.journalPath),{recursive:true})
 const file=await fs.open(options.journalPath,'wx'),entries:ProviderJournalEntry[]=[],invoices=new Map<string,Record<string,unknown>>()
 let tail=Promise.resolve(),sequence=0
 const record=(event:ProviderJournalEntry['event'],requestId:string,data:Record<string,unknown>)=>{
  const entry={sequence:++sequence,at:new Date().toISOString(),event,requestId,...data} as ProviderJournalEntry
  entries.push(entry);tail=tail.then(async()=>{await file.write(JSON.stringify(entry)+'\n');await file.sync()});return tail
 }
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:60,async fetch(request){
  const url=new URL(request.url)
  if(request.headers.get('authorization')!==`Bearer ${OFFLINE_API_KEY}`)return new Response('Fixture requires the explicit fake key',{status:403})
  if(url.pathname==='/api/v1/generation'&&request.method==='GET'){
   const requestId=url.searchParams.get('id')??'';await record('generation_lookup',requestId,{})
   const data=invoices.get(requestId);return Response.json(data?{data}:{error:'Unknown original generation'},{status:data?200:404})
  }
  if(url.pathname!=='/api/v1/chat/completions'||request.method!=='POST')return new Response('Unsupported fixture endpoint',{status:404})
  const raw=await request.text(),requestId='gen_offline_'+randomUUID()
  // Do not record credentials, even the fake one. Preserve all non-secret wire semantics.
  const headers=Object.fromEntries([...request.headers].filter(([name])=>!['authorization','cookie','proxy-authorization'].includes(name)))
  await record('request',requestId,{method:request.method,path:url.pathname,headers,rawBody:raw,bodyHash:hash(raw)})
  try{
   const body=JSON.parse(raw) as WireRequest
   if(typeof body.model!=='string'||!Array.isArray(body.messages)||body.stream!==true)throw Error('Expected a real streamed OpenAI chat-completions request')
   if(entries.filter(row=>row.event==='request').length>(options.maximumRequests??128))throw Error('Offline provider request allowance exhausted')
   const reply=await options.actor(structuredClone(body)),finishReason=reply.finishReason??(reply.calls?.length?'tool_calls':'stop'),cost=reply.reportedCostUsd===undefined?.0001:reply.reportedCostUsd
   if(cost!==null&&(!Number.isFinite(cost)||cost<0))throw Error('Invalid fixture invoice')
   const envelope={id:requestId,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model,provider:'offline-acceptance'}
   const chunks:unknown[]=[{...envelope,choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]}]
   if(reply.reasoning)chunks.push({...envelope,choices:[{index:0,delta:{reasoning:reply.reasoning},finish_reason:null}]})
   if(reply.text)for(let i=0;i<reply.text.length;i+=47)chunks.push({...envelope,choices:[{index:0,delta:{content:reply.text.slice(i,i+47)},finish_reason:null}]})
   for(const [index,call] of (reply.calls??[]).entries()){
    const args=JSON.stringify(call.arguments),id=call.id??'call_'+randomUUID()
    chunks.push({...envelope,choices:[{index:0,delta:{tool_calls:[{index,id,type:'function',function:{name:call.name,arguments:''}}]},finish_reason:null}]})
    for(let i=0;i<args.length;i+=31)chunks.push({...envelope,choices:[{index:0,delta:{tool_calls:[{index,function:{arguments:args.slice(i,i+31)}}]},finish_reason:null}]})
   }
   chunks.push({...envelope,choices:[{index:0,delta:{},finish_reason:finishReason}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,...cost===null?{}:{cost}}})
   const invoice={id:requestId,model:body.model,provider_name:'offline-acceptance',total_cost:cost,finish_reason:finishReason,created_at:envelope.created}
   // Persist response bytes and the independent invoice before handing any bytes to the client.
   const responseBytes=chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n'
   await record('response',requestId,{status:200,bodyHash:hash(responseBytes),rawBody:responseBytes})
   await record('invoice',requestId,{costUsd:cost,model:body.model,finishReason,provider:'offline-acceptance'});invoices.set(requestId,invoice)
   const encoded=new TextEncoder().encode(responseBytes)
   return new Response(new ReadableStream({start(controller){for(let i=0;i<encoded.length;i+=113)controller.enqueue(encoded.slice(i,i+113));controller.close()}}),{headers:{'content-type':'text/event-stream','cache-control':'no-cache'}})
  }catch(error){await record('fixture_error',requestId,{message:error instanceof Error?error.message:String(error)});return Response.json({error:{message:String(error)}},{status:500})}
 }})
 return {url:`http://127.0.0.1:${server.port}`,journalPath:options.journalPath,entries:()=>structuredClone(entries),async close(){server.stop(true);await tail;await file.close()}}
}
