import {test,expect} from 'bun:test'
import {Database} from 'bun:sqlite'
import fs from 'node:fs/promises'
import {AppendOnlySessionStore} from './append-store'
import {SqliteSessionStore} from './store'
import {PiRuntime} from './index'
import {openSessionReader} from './session-store'
import {createHandler} from '../server'
import {readSessionTranscriptPage} from './session-pages'

async function fixture(legacy=false,fixtureFile?:string){const file=fixtureFile??'/private/tmp/autofold-page-'+crypto.randomUUID()+'.sqlite',store=legacy?new SqliteSessionStore(file):new AppendOnlySessionStore(file),session=await new PiRuntime({store}).create();return {file,store,session,close:async()=>{store.close();await Promise.all(['','-wal','-shm'].map(s=>fs.rm(file+s,{force:true})))}}}
test('indexed transcript cursor reconstructs all exact originals without unrelated SDK entries',async()=>{
 const f=await fixture()
 try{f.session.messages=Array.from({length:237},(_,index)=>({role:'user',content:`Original ${index}`,timestamp:index}));await f.store.save(f.session)
  const db=new Database(f.file);db.query("INSERT INTO pi_records VALUES (?,'entry',999,'invalid unrelated SDK entry')").run(f.session.id);db.close()
  const reader=openSessionReader(f.file)!,messages:unknown[]=[];let offset=0,anchor:string|undefined
  try{for(;;){const page=(await reader.messages(f.session.id,offset,31,anchor))!;expect(page.messages.length).toBeLessThanOrEqual(31);messages.push(...page.messages);if(!page.hasMore)break;offset=page.nextOffset;anchor=page.anchor}expect(messages).toEqual(f.session.messages)
   const reset=(await reader.messages(f.session.id,31,31,'wrong-original-anchor'))!;expect(reset.reset).toBe(true);expect(reset.offset).toBe(0)
   await expect(reader.get(f.session.id)).rejects.toThrow('archive is incomplete')
  }finally{reader.close()}
 }finally{await f.close()}
})
test('giant originals use bounded exact UTF-8 JSON fragments and require original byte identity',async()=>{
 const f=await fixture()
 try{const giant={role:'user' as const,content:'Protein 🧬 αβ '.repeat(25_000),timestamp:1};f.session.messages=[giant,{role:'user',content:'Small original',timestamp:2}];await f.store.save(f.session)
  const reader=openSessionReader(f.file)!
  try{const page=(await reader.messages(f.session.id))!,descriptor=page.messages[0] as any;expect(descriptor.transcriptFragment.totalBytes).toBeGreaterThan(65_536);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65_536);expect(page.messages[1]).toEqual(f.session.messages[1])
   let offset=0,reconstructed=''
   for(;;){const fragment=(await reader.messageContent(f.session.id,0,offset,32767,descriptor.transcriptFragment.messageHash))!;expect(Buffer.byteLength(fragment.text)).toBeLessThanOrEqual(32767);expect(fragment.nextOffsetBytes).toBeGreaterThan(offset);reconstructed+=fragment.text;if(!fragment.hasMore)break;offset=fragment.nextOffsetBytes}
   expect(JSON.parse(reconstructed)).toEqual(giant);expect(reconstructed).toBe(JSON.stringify(giant));await expect(reader.messageContent(f.session.id,0,0,100,'sha256:'+'f'.repeat(64))).rejects.toThrow('byte identity changed')
   await expect(reader.messageContent(f.session.id,0,1_000_000_000)).rejects.toThrow('cursor exceeds')
   const db=new Database(f.file);const plan=db.query("EXPLAIN QUERY PLAN SELECT ordinal FROM pi_records WHERE session_id=? AND kind='message' AND ordinal>=? AND ordinal<? ORDER BY ordinal").all(f.session.id,0,2) as {detail:string}[];expect(plan.some(row=>row.detail.includes('SEARCH')&&row.detail.includes('INDEX'))).toBe(true);db.close()
  }finally{reader.close()}
 }finally{await f.close()}
})
test('legacy and existing append readers do not migrate original files when paging',async()=>{
 for(const legacy of [true,false]){const f=await fixture(legacy)
  try{f.session.messages=[{role:'user',content:'Legacy exact αβ'.repeat(20_000),timestamp:1}];await f.store.save(f.session);if(!legacy){const db=new Database(f.file);db.exec('DROP TABLE pi_record_metadata');db.close()}f.store.close()
   const before=await fs.readFile(f.file),reader=openSessionReader(f.file)!
   try{const page=(await reader.messages(f.session.id))!,item=page.messages[0] as any;expect(item.transcriptFragment).toBeDefined();const fragment=(await reader.messageContent(f.session.id,0,0,1024,item.transcriptFragment.messageHash))!;expect(fragment.text.startsWith('{')).toBe(true)}finally{reader.close()}
   expect(await fs.readFile(f.file)).toEqual(before)
  }finally{await Promise.all(['','-wal','-shm'].map(s=>fs.rm(f.file+s,{force:true})))}
 }
})
test('requested missing archive row is held and event cursor uses original composite index',async()=>{
 const f=await fixture()
 try{f.session.messages=[{role:'user',content:'Original',timestamp:1}];await f.store.save(f.session);const reader=openSessionReader(f.file)!,db=new Database(f.file)
  try{db.query('INSERT INTO pi_journal VALUES (?,?,?)').run(f.session.id,2,JSON.stringify({sequence:2,sessionId:f.session.id,type:'fixture',timestamp:1,data:{original:true}}));db.query('INSERT INTO pi_journal VALUES (?,?,?)').run(f.session.id,3,JSON.stringify({sequence:3,sessionId:f.session.id,type:'fixture',timestamp:2,data:{original:true}}));const first=(await reader.eventPage(f.session.id,1,1))!;expect(first.events).toHaveLength(1);expect(first.hasMore).toBe(true);const second=(await reader.eventPage(f.session.id,first.nextSequence,1))!;expect(second.events[0].sequence).toBe(3);expect(second.hasMore).toBe(false)
   db.query("DELETE FROM pi_records WHERE session_id=? AND kind='message' AND ordinal=0").run(f.session.id);await expect(reader.messages(f.session.id)).rejects.toThrow('archive is incomplete');await expect(reader.messageContent(f.session.id,0)).rejects.toThrow('archive is incomplete');expect(await reader.messageContent(f.session.id,1)).toBeUndefined()
  }finally{reader.close();db.close()}
 }finally{await f.close()}
})
test('readonly HTTP transcript and fragment routes retrieve originals without session initialization',async()=>{
 const directory='/private/tmp/autofold-page-route-'+crypto.randomUUID();await fs.mkdir(directory)
 const f=await fixture(false,directory+'/sessions.sqlite')
 try{f.session.messages=[{role:'user',content:'🧬'.repeat(30_000),timestamp:1}];await f.store.save(f.session)
  const configured=createHandler({sessionDirectory:directory} as any),response=await configured(new Request(`http://localhost/research/sessions/${f.session.id}/messages`));expect(response.status).toBe(200);const page=await response.json() as any;const fragment=await configured(new Request(`http://localhost/research/sessions/${f.session.id}/messages/0/content?limitBytes=4096&expectedHash=${page.messages[0].transcriptFragment.messageHash}`));expect(fragment.status).toBe(200);expect(Buffer.byteLength((await fragment.json() as any).text)).toBeLessThanOrEqual(4096)
 }finally{await f.close();await fs.rm(directory,{recursive:true,force:true})}
})

test('fresh giant fragment retrieval rejects corruption without replacing the canonical original',async()=>{
 const f=await fixture()
 try{f.session.messages=[{role:'user',content:'Original protein αβ'.repeat(20_000),timestamp:1}];await f.store.save(f.session);const reader=openSessionReader(f.file)!,db=new Database(f.file)
  try{const descriptor=(await reader.messages(f.session.id))!.messages[0] as any
   db.query("UPDATE pi_record_fragments SET bytes=? WHERE session_id=? AND kind='message' AND ordinal=0 AND fragment=0").run(Buffer.from('corrupt'),f.session.id)
   await expect(reader.messageContent(f.session.id,0,0,1024,descriptor.transcriptFragment.messageHash)).rejects.toThrow('incomplete or corrupt')
   expect((await reader.get(f.session.id))!.messages).toEqual(f.session.messages)
   const plan=db.query("EXPLAIN QUERY PLAN SELECT fragment,bytes,digest FROM pi_record_fragments WHERE session_id=? AND kind='message' AND ordinal=? AND fragment>=? AND fragment<? ORDER BY fragment").all(f.session.id,0,0,1) as {detail:string}[]
   expect(plan.some(row=>row.detail.includes('SEARCH')&&row.detail.includes('INDEX'))).toBe(true)
  }finally{reader.close();db.close()}
 }finally{await f.close()}
})
