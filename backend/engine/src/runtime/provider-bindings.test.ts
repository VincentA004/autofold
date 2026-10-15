import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import {MemorySessionStore,SqliteSessionStore,PiRuntime} from './index'
import type {PiModelRequest} from './types'
const raw=(session:{modelSelection:PiModelRequest['model']},upstream='gen_original'):PiModelRequest=>({status:'settled',model:session.modelSelection,purpose:'turn',startedAt:1,
 providerBilling:{source:'openrouter_stream',status:'reported',upstreamRequestId:upstream,reportedCostUsd:.01}})
for(const kind of ['memory','sqlite'] as const){
 test(`${kind}: raw upstream identity binds exact original session/request before receipt reconciliation`,async()=>{
  const store=kind==='memory'?new MemorySessionStore():new SqliteSessionStore(':memory:')
  try{
   const runtime=new PiRuntime({store,streamFn:()=>{throw new Error('Forbidden inference')}}),a=await runtime.create(),b=await runtime.create()
   a.modelRequests={req_a:raw(a)};await store.save(a);await store.save(a)
   const before=await store.get(b.id),journal=await store.events(b.id)
   b.modelRequests={req_b:raw(b)};b.sequence++
   await expect(store.save(b,{sessionId:b.id,sequence:b.sequence,timestamp:1,type:'receipt_attempt',data:{}})).rejects.toThrow('another session or original provider request')
   expect(await store.get(b.id)).toEqual(before);expect(await store.events(b.id)).toEqual(journal)
   const duplicate=structuredClone(a);duplicate.modelRequests!.req_second=raw(a)
   await expect(store.save(duplicate)).rejects.toThrow('another session or original provider request');expect(await store.get(a.id)).toEqual(a)
   const second=structuredClone(a);second.modelRequests!.req_second=raw(a,'gen_independent');await store.save(second)
   expect(Object.keys((await store.get(a.id))!.modelRequests!)).toHaveLength(2)
  }finally{if(store instanceof SqliteSessionStore)store.close()}
 })
 test(`${kind}: raw binding cannot change/disappear and verified compatibility receipt keeps exact original identity`,async()=>{
  const store=kind==='memory'?new MemorySessionStore():new SqliteSessionStore(':memory:')
  try{
   const runtime=new PiRuntime({store,streamFn:()=>{throw new Error('Forbidden inference')}}),a=await runtime.create()
   a.modelRequests={req_a:raw(a)};await store.save(a)
   for(const mode of ['remove','replace','contradiction'] as const){const bad=structuredClone(a)
    if(mode==='remove')bad.modelRequests={}
    if(mode==='replace')bad.modelRequests!.req_a=raw(a,'gen_changed')
    if(mode==='contradiction')bad.modelRequests!.req_a!.usageEvidence={receiptId:'receipt_bad',sha256:'sha256:'+'a'.repeat(64),upstreamRequestId:'gen_changed',source:'offline_verified_fixture'}
    await expect(store.save(bad)).rejects.toThrow();expect(await store.get(a.id)).toEqual(a)
   }
   a.modelRequests!.req_a!.usageEvidence={receiptId:'receipt_original',sha256:'sha256:'+'a'.repeat(64),upstreamRequestId:'gen_original',source:'offline_verified_fixture'}
   await store.save(a);await store.save(a);expect(await store.get(a.id)).toEqual(a)
   const b=await runtime.create();b.modelRequests={req_b:{...raw(b),providerBilling:undefined,usageEvidence:{...a.modelRequests!.req_a!.usageEvidence}}}
   await expect(store.save(b)).rejects.toThrow('another session or original provider request')
  }finally{if(store instanceof SqliteSessionStore)store.close()}
 })
}
test('legacy raw binding survives reopen without new tables or implicit migration',async()=>{
 const file='/private/tmp/autofold-legacy-raw-bindings-'+crypto.randomUUID()+'.sqlite';let store=new SqliteSessionStore(file)
 try{
  const a=await new PiRuntime({store}).create();a.modelRequests={req_a:raw(a)};await store.save(a);store.close();store=new SqliteSessionStore(file)
  const original=await store.get(a.id);expect(original).toEqual(a)
  const b=await new PiRuntime({store}).create();b.modelRequests={req_b:raw(b)}
  await expect(store.save(b)).rejects.toThrow('another session or original provider request');expect(await store.get(a.id)).toEqual(original)
 }finally{store.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))}
})
