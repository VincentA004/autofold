import {afterEach,expect,spyOn,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {LocalWorkerTransport,ReceiptUnresolvedError, type Dispatch} from './transport'
import {processPlanHash} from './process-plan'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
async function fixture(timeoutMs=1000) {
  const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'independent-local-')));roots.push(workspace)
  const input:Dispatch={runId:'run_independent_local',requestId:'independent-local',workspace,bundlePath:path.join(workspace,'unused'),outputPath:path.join(workspace,'output'),timeoutMs,
    command:['python3','-c',"from pathlib import Path;import time;Path('count').write_text('x');time.sleep(30)"]}
  const root=path.join(workspace,'.local-control-'+input.runId)
  return {workspace,input,root}
}
test('host SIGKILL leaves independent original local deadline and recoverable receipt',async()=>{
  const f=await fixture(1500)
  const file=path.join(f.workspace,'host.ts')
  await fs.writeFile(file,`import {LocalWorkerTransport} from ${JSON.stringify(path.join(import.meta.dir,'transport.ts'))};await new LocalWorkerTransport().dispatch(${JSON.stringify(f.input)});`)
  const child=Bun.spawn([process.execPath,file],{stdout:'pipe',stderr:'pipe'})
  try {
    let receipt:any
    for(let n=0;n<200;n++){receipt=await Bun.file(path.join(f.root,'remote-receipt.json')).json().catch(()=>undefined);if(receipt?.state==='running')break;await Bun.sleep(10)}
    expect(receipt?.state).toBe('running')
    child.kill('SIGKILL');await child.exited
    const transport=new LocalWorkerTransport()
    let result=await transport.reconcile(f.input)
    for(let n=0;result.status==='pending'&&n<200;n++){await Bun.sleep(20);result=await transport.reconcile(f.input)}
    expect(result).toMatchObject({status:'failed',error:'Frozen wall-time budget exceeded'})
    expect(await fs.readFile(path.join(f.workspace,'count'),'utf8')).toBe('x')
    expect((await transport.reconcile(f.input)).status).toBe('failed')
    expect((await Bun.file(path.join(f.root,'remote-receipt.json')).json()).state).toBe('timed_out')
  }finally{child.kill('SIGKILL');await child.exited}
},15000)
test('local original process plan cannot be rebound to changed command or timeout',async()=>{
  const f=await fixture()
  const transport=new LocalWorkerTransport()
  await transport.preflight(f.input)
  await expect(transport.preflight({...f.input,timeoutMs:f.input.timeoutMs+1})).rejects.toThrow('binding differs')
  await expect(transport.preflight({...f.input,command:['python3','-c','pass']})).rejects.toThrow('binding differs')
  expect(await Bun.file(path.join(f.workspace,'count')).exists()).toBe(false)
})

test('ordinary local observation does not repeatedly adopt the original supervisor',async()=>{
 const {DurableLocalTransport}=await import('./local')
 const {spyOn}=await import('bun:test')
 const f=await fixture(),transport=new DurableLocalTransport()
 const preflight=spyOn(transport,'preflight').mockImplementation(async()=>{await fs.mkdir(f.root,{recursive:true});await fs.writeFile(path.join(f.root,'remote-plan.json'),'{}')})
 let statuses=0
 const actions:string[]=[]
 const control=spyOn(transport as any,'control').mockImplementation(async(_input:unknown,action:string)=>{
  actions.push(action);if(action==='status')return {state:++statuses>=3?'succeeded':'running'}
  return {state:'running'}
 })
 try {expect(await transport.dispatch(f.input)).toEqual({status:'succeeded'});expect(actions.filter(action=>action==='adopt')).toHaveLength(0);expect(statuses).toBe(3)}finally{preflight.mockRestore();control.mockRestore()}
})

test('a post-launch bookkeeping failure remains an unresolved effect and does not relaunch',async()=>{
  const f=await fixture(),transport=new LocalWorkerTransport(),actions:string[]=[]
  const preflight=spyOn(transport,'preflight').mockResolvedValue(undefined)
  const control=spyOn(transport as any,'control').mockImplementation(async(_input:unknown,action:string)=>{
    actions.push(action);return {runId:f.input.runId,state:'running'}
  })
  try {
    await expect(transport.dispatch({...f.input,onStarted:async()=>{throw new Error('Canonical projection temporarily unavailable')}})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
    expect(actions).toEqual(['launch'])
  }finally{preflight.mockRestore();control.mockRestore()}
})

test('missing local receipt stops observation as unresolved instead of polling forever',async()=>{
  const f=await fixture(),transport=new LocalWorkerTransport(),actions:string[]=[]
  const preflight=spyOn(transport,'preflight').mockImplementation(async()=>{await fs.mkdir(f.root,{recursive:true});await fs.writeFile(path.join(f.root,'remote-plan.json'),'{}')})
  const control=spyOn(transport as any,'control').mockImplementation(async(_input:unknown,action:string)=>{
    actions.push(action);return {runId:f.input.runId,state:action==='launch'?'running':'absent'}
  })
  try {
    await expect(transport.dispatch(f.input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
    expect(actions).toEqual(['launch','status'])
    await expect(transport.reconcile(f.input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
    expect(actions).toEqual(['launch','status','status'])
  }finally{preflight.mockRestore();control.mockRestore()}
})

test('malformed or unknown-state local supervisor receipts cannot assert a worker failure or success',async()=>{
  for(const malformed of [true,false]){
    const f=await fixture(),python=path.join(f.workspace,'control-python'),transport=new LocalWorkerTransport()
    // Exercise the real subprocess parser; this fixture launches no worker.
    const input={...f.input,command:[python,'-c','unused']}
    await transport.preflight(input)
    const plan=await Bun.file(path.join(f.root,'remote-plan.json')).json()
    const raw=malformed?'not json':JSON.stringify({runId:input.runId,bundleHash:plan.bundleHash,workerHash:plan.workerHash,planHash:processPlanHash(plan),state:'finished'})
    await fs.writeFile(python,'#!/bin/sh\ncat <<\'RECEIPT\'\n'+raw+'\nRECEIPT\n',{mode:0o700})
    await expect((transport as any).control(input,'launch')).rejects.toMatchObject({name:'ReceiptUnresolvedError',effectState:'unresolved'})
    expect(await Bun.file(path.join(f.workspace,'count')).exists()).toBe(false)
  }
})

test('local cancellation cannot manufacture a terminal receipt when the original launch receipt is missing',async()=>{
  const f=await fixture(),transport=new LocalWorkerTransport()
  await transport.preflight(f.input)
  // The transport cannot tell this apart from a lost post-launch receipt.
  // A real controller must acknowledge the request before cancellation settles.
  const receipt=await (transport as any).control(f.input,'cancel')
  expect(receipt.state).toBe('absent')
  expect(await Bun.file(path.join(f.root,'cancel.request')).exists()).toBe(true)
  expect(await Bun.file(path.join(f.root,'remote-receipt.json')).exists()).toBe(false)
  await expect(transport.reconcile(f.input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(await Bun.file(path.join(f.workspace,'count')).exists()).toBe(false)
})

test('receipt-only local recovery classifies damaged plans and failed control subprocesses as unresolved',async()=>{
  const f=await fixture(),transport=new LocalWorkerTransport()
  await transport.preflight(f.input)
  const file=path.join(f.root,'remote-plan.json'),plan=await Bun.file(file).json()
  await fs.chmod(file,0o600);await fs.writeFile(file,'invalid plan json')
  await expect(transport.reconcile(f.input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await fs.writeFile(file,JSON.stringify({...plan,controlPython:path.join(f.workspace,'missing-python')}))
  await expect(transport.reconcile(f.input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(await Bun.file(path.join(f.workspace,'count')).exists()).toBe(false)
})

test('terminal local success requires attributable completion and zero exit while missing-manifest failure may exit zero',async()=>{
  const f=await fixture(),python=path.join(f.workspace,'control-python'),transport=new LocalWorkerTransport(),input={...f.input,command:[python,'-c','unused']}
  await transport.preflight(input)
  const plan=await Bun.file(path.join(f.root,'remote-plan.json')).json()
  const identity={runId:input.runId,bundleHash:plan.bundleHash,workerHash:plan.workerHash,planHash:processPlanHash(plan)}
  for(const terminal of [{state:'succeeded',exitCode:1,completedAt:1},{state:'succeeded',exitCode:0},{state:'failed',exitCode:1,completedAt:-1}]){
    await fs.writeFile(python,'#!/bin/sh\ncat <<\'RECEIPT\'\n'+JSON.stringify({...identity,...terminal})+'\nRECEIPT\n',{mode:0o700})
    await expect(transport.reconcile(input)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  }
  await fs.writeFile(python,'#!/bin/sh\ncat <<\'RECEIPT\'\n'+JSON.stringify({...identity,state:'failed',exitCode:0,completedAt:1})+'\nRECEIPT\n',{mode:0o700})
  expect(await transport.reconcile(input)).toMatchObject({status:'failed'})
})
