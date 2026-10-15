import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createProviderFixture,OFFLINE_API_KEY} from './provider'

test('real Pi SDK serializes tool context, parses fragmented HTTP SSE and records independent invoices before reply',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-wire-provider-'))
 let actual:any
 const fixture=await createProviderFixture({journalPath:path.join(directory,'provider.jsonl'),actor:request=>{actual=request;return {text:'Visible answer π🧬',calls:[{id:'wire_call',name:'inspect_fixture',arguments:{query:'evidence π🧬',limit:3}}]}}})
 try{
  const script=`import {stream} from '@earendil-works/pi-ai/compat';
   const model={id:'offline/wire-model',name:'Wire model',provider:'openrouter',api:'openai-completions',baseUrl:'https://openrouter.ai/api/v1',reasoning:false,input:['text'],contextWindow:100000,maxTokens:10000,cost:{input:1,output:2,cacheRead:0,cacheWrite:0}};
   const events=[];const response=stream(model,{messages:[{role:'user',content:'Inspect visible evidence only',timestamp:1}],tools:[{name:'inspect_fixture',description:'Inspect evidence',parameters:{type:'object',properties:{query:{type:'string'},limit:{type:'number'}},required:['query']}}]},{apiKey:${JSON.stringify(OFFLINE_API_KEY)}});
   for await(const event of response)events.push(event.type);const result=await response.result();
   let denied=false;try{await fetch('https://provider.invalid/private')}catch(error){denied=String(error).includes('OFFLINE_NETWORK_DENIED')}
   console.log(JSON.stringify({result,events,denied}));if(result.stopReason!=='toolUse'||!denied)process.exit(1);`
  const childHome=path.join(directory,'isolated-home');await fs.mkdir(childHome)
  const child=Bun.spawn([process.execPath,'--no-env-file','--preload',path.join(import.meta.dir,'provider-preload.ts'),'-e',script],{cwd:path.resolve(import.meta.dir,'../..'),env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:childHome,TMPDIR:process.env.TMPDIR??'/tmp',LANG:'en_US.UTF-8',OPENROUTER_API_KEY:OFFLINE_API_KEY,AUTOFOLD_TEST_PROVIDER_URL:fixture.url},stdout:'pipe',stderr:'pipe'})
  const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(stderr).toBe('');expect(status).toBe(0)
  const result=JSON.parse(stdout.trim());expect(result.denied).toBe(true);expect(result.result.content).toContainEqual({type:'text',text:'Visible answer π🧬'});expect(result.result.content).toContainEqual({type:'toolCall',id:'wire_call',name:'inspect_fixture',arguments:{query:'evidence π🧬',limit:3}})
  expect(actual.model).toBe('offline/wire-model');expect(actual.stream).toBe(true);expect(actual.messages.some((message:any)=>message.content==='Inspect visible evidence only')).toBe(true);expect(actual.tools[0].function.name).toBe('inspect_fixture')
  const journal=fixture.entries();expect(journal.map(row=>row.event)).toEqual(['request','response','invoice']);expect(journal[2]).toMatchObject({costUsd:.0001,finishReason:'tool_calls',provider:'offline-acceptance'});expect(JSON.stringify(journal)).not.toContain(OFFLINE_API_KEY)
  const persisted=(await fs.readFile(fixture.journalPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(persisted).toEqual(journal)
  const metadata=await fetch(fixture.url+'/api/v1/generation?id='+journal[0]!.requestId,{headers:{Authorization:'Bearer '+OFFLINE_API_KEY}});expect(await metadata.json()).toMatchObject({data:{id:journal[0]!.requestId,total_cost:.0001,finish_reason:'tool_calls'}})
 }finally{await fixture.close();await fs.rm(directory,{recursive:true,force:true})}
},30_000)

test('wire provider represents missing billing as unknown, never free usage',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-wire-unknown-')),fixture=await createProviderFixture({journalPath:path.join(directory,'wire.jsonl'),actor:()=>({text:'Stopped with unknown bill',reportedCostUsd:null})})
 try{const response=await fetch(fixture.url+'/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+OFFLINE_API_KEY,'content-type':'application/json'},body:JSON.stringify({model:'offline/model',messages:[{role:'user',content:'test'}],stream:true})});const bytes=await response.text();expect(bytes).not.toContain('"cost":0');expect(fixture.entries().find(row=>row.event==='invoice')?.costUsd).toBeNull()}finally{await fixture.close();await fs.rm(directory,{recursive:true,force:true})}
})
