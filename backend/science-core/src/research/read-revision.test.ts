import {test,expect} from 'bun:test'
import {Database} from 'bun:sqlite'
import fs from 'node:fs/promises'
import {MemoryResearchStore,StorageResearchStore} from './store'
import {OperationService} from './operation-service'

test('revision observations skip unchanged state but invalidate successful scoped/full commits and preserve rollback token',async()=>{
 const directory='/private/tmp/autofold-revision-'+crypto.randomUUID(),sqlite=new StorageResearchStore({directory})
 try{for(const store of [new MemoryResearchStore(),sqlite]){await store.mutate('project',state=>{state.branchCursors.original='one'});const first=await store.readWithRevision('project');expect(first.state?.branchCursors.original).toBe('one');expect(first.revision).toBeDefined();expect(await store.readWithRevision('project',first.revision)).toEqual({revision:first.revision});await expect(store.mutate('project',state=>{state.branchCursors.original='must-rollback';throw new Error('original failed commit')})).rejects.toThrow();expect(await store.readWithRevision('project',first.revision)).toEqual({revision:first.revision});await store.mutate('project',state=>{state.branchCursors.original='two'});const next=await store.readWithRevision('project',first.revision);expect(next.revision).not.toBe(first.revision);expect(next.state?.branchCursors.original).toBe('two')}
  const service=new OperationService.Service(sqlite);await service.open('project',{id:'op_original',kind:'fixture',identity:{original:true}});const before=await sqlite.readWithRevision('project');await service.acquire('project','op_original',{mode:'settle',leaseMs:30000});expect((await sqlite.readWithRevision('project',before.revision)).state?.operations.op_original?.owner?.mode).toBe('settle')
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})
test('historical missing revision stays a full readonly observation without conversion',async()=>{
 const directory='/private/tmp/autofold-revision-legacy-'+crypto.randomUUID(),store=new StorageResearchStore({directory})
 try{await store.mutate('project',state=>{state.branchCursors.original='legacy'});const db=new Database(directory+'/project.sqlite');db.exec("DELETE FROM metadata WHERE key='read_revision'");db.close();const before=await fs.readFile(directory+'/project.sqlite');for(let i=0;i<2;i++){const observed=await store.readWithRevision('project','invented-token');expect(observed.revision).toBeUndefined();expect(observed.state?.branchCursors.original).toBe('legacy')}expect(await fs.readFile(directory+'/project.sqlite')).toEqual(before)}finally{await fs.rm(directory,{recursive:true,force:true})}
})
test('one readonly WAL snapshot binds revision and canonical rows across another writer commit',async()=>{
 const directory='/private/tmp/autofold-revision-wal-'+crypto.randomUUID(),store=new StorageResearchStore({directory})
 try{await store.mutate('project',state=>{state.branchCursors.original='before'});const before=await store.readWithRevision('project'),originalOpen=(store as any).openRead.bind(store);let changed=false
  ;(store as any).openRead=async(project:string)=>{const reader=await originalOpen(project),query=reader.query.bind(reader);return new Proxy(reader,{get(target,key){if(key==='query')return(sql:string)=>{const statement=query(sql);if(!sql.includes("key='read_revision'"))return statement;return new Proxy(statement,{get(st,k){if(k==='get')return(...args:unknown[])=>{const token=Reflect.apply(st.get,st,args);if(!changed){const writer=new Database(directory+'/project.sqlite');writer.transaction(()=>{writer.query("UPDATE metadata SET value='after-token' WHERE key='read_revision'").run();writer.query("UPDATE records SET value=? WHERE collection='branchCursors' AND id='original'").run(JSON.stringify('after'))})();writer.close();changed=true}return token};const value=Reflect.get(st,k);return typeof value==='function'?value.bind(st):value}})};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})}
  const observed=await store.readWithRevision('project');expect(changed).toBe(true);expect(observed).toEqual(before);const after=await store.readWithRevision('project',before.revision);expect(after.revision).toBe('after-token');expect(after.state?.branchCursors.original).toBe('after')
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})
test('operation acquisition release and event pages exclude unrelated corrupt historical rows while retaining exact epoch',async()=>{
 const directory='/private/tmp/autofold-operation-page-'+crypto.randomUUID(),store=new StorageResearchStore({directory}),service=new OperationService.Service(store)
 try{await service.open('project',{id:'op_original',kind:'fixture',identity:{original:true}});await service.open('project',{id:'op_unrelated',kind:'fixture',identity:{unrelated:true}});const db=new Database(directory+'/project.sqlite');db.query("UPDATE records SET value='unparseable unrelated event' WHERE collection='operationEvents' AND json_extract(value,'$.operationId')='op_unrelated'").run();db.close()
  const owner=await service.acquire('project','op_original',{mode:'settle',leaseMs:30000});let page=await service.eventPage('project','op_original',-1,1);expect(page.events.map(e=>e.revision)).toEqual([0]);expect(page.hasMore).toBe(true);page=await service.eventPage('project','op_original',page.nextRevision,1);expect(page.events.map(e=>e.revision)).toEqual([1]);await service.release(owner);expect((await service.read('project','op_original'))?.owner).toBeUndefined();expect((await service.events('project','op_original')).map(e=>e.revision)).toEqual([0,1,2]);await expect(store.read('project')).rejects.toThrow()
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})
