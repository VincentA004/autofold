import {test,expect} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {PiWorkspaceTools} from './workspace'
import {PiRuntime,MemorySessionStore} from './index'

test('native Pi serializes shared-file edits across tool instances over injected filesystem operations',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-edit-queue-')),file=path.join(root,'trial.py')
 try {
  await fs.writeFile(file,'one = 1\ntwo = 2\n');let inFlight=0,maximum=0
  const policy={cwd:root,resolve:async(input:string)=>{const absolute=path.resolve(root,input);if(absolute!==file)throw new Error('Scope');return{relative:'trial.py',absolute}},
   read:(file:string)=>fs.readFile(file),mkdir:async()=>{},write:async(file:string,content:string)=>{inFlight++;maximum=Math.max(maximum,inFlight);await new Promise(resolve=>setTimeout(resolve,10));await fs.writeFile(file,content);inFlight--}}
  const first=new PiWorkspaceTools(policy),second=new PiWorkspaceTools(policy)
  await Promise.all([first.edit({path:'trial.py',edits:[{oldText:'one = 1',newText:'one = 3'}]}),second.edit({path:'trial.py',oldText:'two = 2',newText:'two = 4'})])
  expect(maximum).toBe(1);expect(await fs.readFile(file,'utf8')).toBe('one = 3\ntwo = 4\n')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('session inspection and data-only recovery do not load scientific resources or initialize a workspace',async()=>{
 let resources=0,inference=0
 const runtime=new PiRuntime({store:new MemorySessionStore(),resources:async()=>{resources++;throw new Error('Unexpected scientific initialization')},streamFn:()=>{inference++;throw new Error('Unexpected inference')}})
 const session=await runtime.create();expect(await runtime.get('ses_missing')).toBeUndefined()
 expect((await runtime.get(session.id))?.id).toBe(session.id)
 expect((await runtime.resume(session.id)).id).toBe(session.id)
 expect(resources).toBe(0);expect(inference).toBe(0)
})
