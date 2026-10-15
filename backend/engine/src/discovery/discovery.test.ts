import {test, expect} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Application} from '../application'
import {createHandler} from '../server'

async function fixture() {
 const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-discovery-'))
 let calls = 0
 const app = new Application({workspace, jobs: {runtimeFactory: () => ({
   get: async () => undefined,
   create: async () => {calls++; throw new Error('offline-dispatch-sentinel')},
   resume: async () => {throw new Error('unexpected resume')},
   run: async () => {throw new Error('unexpected inference')}, cancel: async () => {},
 })}})
 const experiment = await app.createMockExperiment()
 return {app, workspace, experiment, calls: () => calls}
}
test('synchronous discovery creates a managed autoresearch job and preserves its failed boundary', async () => {
 const f=await fixture()
 try {
  const result=await f.app.discover(f.experiment.id, 'Inspect the context', {idempotencyKey:'sync-test'})
  expect(result.status).toBe('failed')
  expect(result.job.payload.kind).toBe('autoresearch')
  expect(result.job.payload.runtime).toBe('autofold-pi.v1')
  expect(result.job.error).toContain('offline-dispatch-sentinel')
  expect(f.calls()).toBe(1)
  const again=await f.app.discover(f.experiment.id, 'Inspect the context', {idempotencyKey:'sync-test'})
  expect(again.jobId).toBe(result.jobId)
  expect(f.calls()).toBe(1)
 } finally {await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('both HTTP discovery interfaces bind the same managed scientist session', async () => {
 const f=await fixture()
 try {
  const handler=createHandler(f.app)
  const post=(action:string, input:any)=>handler(new Request(`http://localhost/research/experiments/${f.experiment.id}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}))
  const sync=await (await post('discovery',{prompt:'Inspect saved context'})).json() as any
  const asyncJob=await (await post('autoresearch',{idempotencyKey:'async-test',iterations:1})).json() as any
  expect(sync.job.payload.sessionId).toBe(asyncJob.payload.sessionId)
  expect(sync.job.payload.kind).toBe(asyncJob.payload.kind)
 } finally {await fs.rm(f.workspace,{recursive:true,force:true})}
})
