import {test,expect} from 'bun:test'
import {Database} from 'bun:sqlite'
import fs from 'node:fs/promises'
import {AppendOnlySessionStore} from './append-store'
import {PiRuntime,DEFAULT_MODEL,SqliteSessionStore} from './index'
import {readSessionSnapshot} from './store'
import {restoreManager,snapshotManager} from './sdk'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
const reply=()=>{const m:any={role:'assistant',content:[{type:'text',text:'Offline.'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.01,output:0,cacheRead:0,cacheWrite:0,total:.01}}};const s=createAssistantMessageEventStream();s.push({type:'done',reason:'stop',message:m});s.end(m);return s}
test('fresh append store keeps original native tree, messages and journal through repeated runs/reopen',async()=>{
 const file='/private/tmp/autofold-runtime-candidate-'+crypto.randomUUID()+'.sqlite';let store=new AppendOnlySessionStore(file)
 try {let effects=0;const rt=new PiRuntime({store,streamFn:()=>{effects++;return reply()}});const initial=await rt.create();await rt.run(initial.id,'First');const before=await store.get(initial.id);const eventBefore=await store.events(initial.id)
  await rt.run(initial.id,'Second');const after=await store.get(initial.id);expect(after!.messages.slice(0,before!.messages.length)).toEqual(before!.messages);expect(after!.sdk!.entries.slice(0,before!.sdk!.entries.length)).toEqual(before!.sdk!.entries);expect(after!.usage.costUsd).toBe(.02)
  const events=await store.events(initial.id);expect(events.slice(0,eventBefore.length)).toEqual(eventBefore);store.close();store=new AppendOnlySessionStore(file);expect(await store.get(initial.id)).toEqual(after);expect(await store.events(initial.id)).toEqual(events);expect(effects).toBe(2)
  const db=new Database(file);const head=JSON.parse((db.query('SELECT state FROM pi_sessions').get() as any).state);expect(head.messages).toEqual([]);expect(head.sdk.entries).toEqual([]);db.close()
 }finally{store.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))}
})
test('failed CAS, truncated or rewritten original archive roll back head, journal and appends',async()=>{
 const store=new AppendOnlySessionStore(':memory:');const rt=new PiRuntime({store,streamFn:reply});const s=await rt.create();await rt.run(s.id,'Original');const before=(await store.get(s.id))!;const originalEvents=await store.events(s.id)
 for(const mode of ['cas','rewrite','truncate']){const bad=structuredClone(before);if(mode==='cas')bad.sequence++;if(mode==='rewrite')(bad.messages[0] as any).content='Changed original';if(mode==='truncate')bad.messages=[];await expect(store.save(bad)).rejects.toThrow();expect(await store.get(s.id)).toEqual(before);expect(await store.events(s.id)).toEqual(originalEvents)}store.close()
})
test('legacy snapshots are refused rather than implicitly migrated or changed',async()=>{
 const file='/private/tmp/autofold-runtime-legacy-'+crypto.randomUUID()+'.sqlite';const old=new SqliteSessionStore(file);const rt=new PiRuntime({store:old,streamFn:reply});const s=await rt.create();await rt.run(s.id,'Original legacy');const before=await old.get(s.id);old.close()
 expect(()=>new AppendOnlySessionStore(file)).toThrow('Legacy Pi snapshots require');const reopened=new SqliteSessionStore(file);expect(await reopened.get(s.id)).toEqual(before);reopened.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))
})

test('normalized snapshots remain readable by compatibility readers but reject legacy writes/new mixed rows',async()=>{
 const file='/private/tmp/autofold-append-reader-'+crypto.randomUUID()+'.sqlite';const fresh=new AppendOnlySessionStore(file)
 try {const rt=new PiRuntime({store:fresh,streamFn:reply});const s=await rt.create();await rt.run(s.id,'Original');const before=(await fresh.get(s.id))!;const legacy=new SqliteSessionStore(file)
  try {expect(await legacy.get(s.id)).toEqual(before);await expect(legacy.save(before)).rejects.toThrow('append-only writer');await expect(legacy.save({...before,id:'ses_mixed'})).rejects.toThrow('append-only writer');expect(await fresh.get(s.id)).toEqual(before);expect(await fresh.get('ses_mixed')).toBeUndefined()}finally{legacy.close()}
 }finally{fresh.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))}
})
test('upstream identity binds one original request and failed receipt binding rolls back the new head',async()=>{
 const store=new AppendOnlySessionStore(':memory:');const rt=new PiRuntime({store,streamFn:reply});const a=await rt.create();const b=await rt.create();a.modelRequests!.req_a={status:'settled',model:a.modelSelection,purpose:'turn',startedAt:1,reportedCostUsd:.01,providerBilling:{source:'openrouter_stream',status:'reported',upstreamRequestId:'gen_unique',reportedCostUsd:.01}};await store.save(a)
 b.modelRequests!.req_b={...a.modelRequests!.req_a};await expect(store.save(b)).rejects.toThrow('Upstream request is already bound');expect((await store.get(b.id))!.modelRequests).toEqual({});expect((await store.get(a.id))!.modelRequests).toEqual(a.modelRequests);store.close()
})
test('missing archive rows are held rather than silently restored as a shorter transcript',async()=>{
 const file='/private/tmp/autofold-append-missing-'+crypto.randomUUID()+'.sqlite';const store=new AppendOnlySessionStore(file)
 try {const rt=new PiRuntime({store,streamFn:reply});const s=await rt.create();await rt.run(s.id,'Original');const db=new Database(file);db.query("DELETE FROM pi_records WHERE session_id=? AND kind='message' AND ordinal=0").run(s.id);db.close();await expect(store.get(s.id)).rejects.toThrow('Original Pi archive is incomplete')}finally{store.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))}
})


test('readonly decoder keeps head and archives in one snapshot while another connection commits an append',async()=>{
 const file='/private/tmp/autofold-append-snapshot-'+crypto.randomUUID()+'.sqlite',writer=new AppendOnlySessionStore(file),reader=new Database(file,{readonly:true})
 try{
  const original=await new PiRuntime({store:writer}).create(),next=structuredClone(original)
  next.messages.push({role:'user',content:'New original message committed after reader gets old head',timestamp:Date.now()})
  snapshotManager(next,restoreManager(next))
  const query=reader.query.bind(reader);let append:Promise<void>|undefined,committed=false
  const instrumented=new Proxy(reader,{get(target,key){
    if(key==='query')return (sql:string)=>{
      const statement=query(sql)
      if(sql!=='SELECT state FROM pi_sessions WHERE id=?')return statement
      return new Proxy(statement,{get(statement,key){
        if(key==='get')return (...bindings:unknown[])=>{const head=Reflect.apply(statement.get,statement,bindings);if(!committed){append=writer.save(next);committed=true}return head}
        const value=Reflect.get(statement,key);return typeof value==='function'?value.bind(statement):value
      }})
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  expect(readSessionSnapshot(instrumented,original.id)).toEqual(original)
  expect(committed).toBe(true);await append
  expect(readSessionSnapshot(reader,original.id)).toEqual(next)
  expect(reader.inTransaction).toBe(false)
  reader.transaction(()=>{expect(reader.inTransaction).toBe(true);expect(readSessionSnapshot(reader,original.id)).toEqual(next);expect(reader.inTransaction).toBe(true)}).deferred()
  expect(reader.inTransaction).toBe(false)
 }finally{reader.close();writer.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))}
})

test('append store rejects raw/verified upstream disagreement and same-request rebind atomically',async()=>{
 const store=new AppendOnlySessionStore(':memory:')
 try{const original=await new PiRuntime({store}).create()
  original.modelRequests={req_original:{status:'settled',model:original.modelSelection,purpose:'turn',startedAt:1,providerBilling:{source:'openrouter_stream',status:'reported',upstreamRequestId:'gen_original',reportedCostUsd:.01}}};await store.save(original)
  for(const mode of ['rebind','contradiction'] as const){const bad=structuredClone(original)
   if(mode==='rebind')bad.modelRequests!.req_original!.providerBilling!.upstreamRequestId='gen_changed'
   else bad.modelRequests!.req_original!.usageEvidence={receiptId:'receipt_original',sha256:'sha256:'+'a'.repeat(64),upstreamRequestId:'gen_changed',source:'offline_verified_fixture'}
   await expect(store.save(bad)).rejects.toThrow();expect(await store.get(original.id)).toEqual(original)
  }
 }finally{store.close()}
})
