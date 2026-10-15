import {afterEach, expect, spyOn, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ResearchService} from '@autofold/science-core/service'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ScientificExecution, fileHash, ReceiptUnresolvedError} from './index'
import {RemoteWorkerTransport, RemoteProfile, RemoteCommandError, type RemoteCommandRunner} from './remote'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true}) })
const workerRoot = path.resolve(import.meta.dir, '../../../worker')
/** Exercise the real frozen worker/control protocol on local temporary files; never opens SSH. */
async function fixture() {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-worker-'))); roots.push(workspace)
  const projectId = 'remote_fixture', commands: string[][] = []
  let statusFailures = 0, launchFailure = false, launchCalls = 0, dropLaunchReceipt = false, interruptBeforeLaunch = false, beforeDispatch: (() => Promise<void>) | undefined, abortLaunch: (() => void) | undefined
  const runner: RemoteCommandRunner = async (argv, options) => {
    commands.push([...argv])
    if (argv[0] === 'scp') {
      const source = argv.at(-2)!.replace(/^fixture:/, ''), target = argv.at(-1)!.replace(/^fixture:/, '')
      await fs.cp(source, target, {recursive: true}); return ''
    }
    if (argv[0] !== 'ssh') throw new Error('Unexpected external command')
    const command = argv.at(-1)!
    if (command.includes("'status'") && statusFailures > 0) {statusFailures--;throw new RemoteCommandError('remote_connection_failed','Injected read-only status disconnect',255)}
    if (command.includes("'launch'")) {launchCalls++; if(launchFailure){launchFailure=false;throw new RemoteCommandError('remote_connection_failed','Injected launch connection timeout',255)}}
    const child = Bun.spawn(['/bin/sh', '-c', command], {stdout: 'pipe', stderr: 'pipe', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}})
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code) throw new Error(error)
    if (command.includes("'launch'") && abortLaunch) {const abort = abortLaunch; abortLaunch = undefined; abort()}
    options?.signal?.throwIfAborted()
    if (command.includes("'launch'") && dropLaunchReceipt) {dropLaunchReceipt = false; throw new Error('Simulated lost SSH receipt after durable launch')}
    return output
  }
  const profile = {host: 'fixture', root: path.join(workspace, 'remote'), python: '/usr/bin/python3'}
  const transport = new RemoteWorkerTransport({profile, workerRoot, run: runner, pollMs: 20, statusRetryMs: 1})
  const store = new StorageResearchStore({directory: path.join(workspace, 'research')})
  const research = new ResearchService.Service(store)
  const scopedTransport = {kind: 'remote' as const, preflight: transport.preflight.bind(transport), reconcile: transport.reconcile.bind(transport), dispatch: async (input: Parameters<typeof transport.dispatch>[0]) => {if (interruptBeforeLaunch) {interruptBeforeLaunch = false; throw new ReceiptUnresolvedError(input.runId, 'Simulated crash before remote launch attempt')} if (beforeDispatch) {const hook = beforeDispatch; beforeDispatch = undefined; await hook()} return transport.dispatch(input)}}
  const execution = new ScientificExecution({workspace, projectId, research, workerRoot, transport: scopedTransport, authorization: {remote: true}})
  const evaluator = (await execution.evaluators())[0]!
  const campaign = await research.createCampaign(projectId, {objective: 'Offline remote protocol acceptance'})
  await research.activateCampaign(projectId, campaign.id)
  const experiment = await research.createExperiment(projectId, campaign.id, {contract: {version: 1, objective: 'Plumbing only', targetArtifactHash: `sha256:${'a'.repeat(64)}`, modality: 'short_peptide', budget: {maximumCandidates: 3, gpuHours: 0, wallTimeMinutes: 1}, evaluator: {...evaluator, fixedSeeds: [7], submissionSize: 3}}})
  await research.activateExperiment(projectId, experiment.id)
  await fs.writeFile(path.join(workspace, 'trial.py'), 'raise RuntimeError("Mock does not execute authored code")\n')
  const trial = await research.createTrial(projectId, experiment.id, {hypothesis: 'Remote plumbing only', designAdapter: 'mock', programPath: 'trial.py', programHash: await fileHash(path.join(workspace, 'trial.py'))})
  return {workspace, execution, research, store, trial, projectId, transport, commands, runner, profile, failLaunch:()=>{launchFailure=true}, loseStatus:(count:number)=>{statusFailures=count}, launches: () => launchCalls, loseReceipt: () => {dropLaunchReceipt = true}, interruptBeforeLaunch: () => {interruptBeforeLaunch = true}, beforeDispatch: (hook: () => Promise<void>) => {beforeDispatch = hook}, abortLaunch: (abort: () => void) => {abortLaunch = abort}}
}

test('frozen SSH protocol stages, runs and locally verifies actual worker; durable retry never relaunches', async () => {
  const f = await fixture()
  const result = await f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'remote-one'})
  expect(result.run.status).toBe('succeeded')
  expect(result.scientific).toBe(false)
  expect(f.launches()).toBe(1)
  expect((await f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'remote-one'})).run.id).toBe(result.run.id)
  expect(f.launches()).toBe(1)
  expect((await f.execution.artifacts(result.run.id)).evaluation.runId).toBe(result.run.id)
  expect(f.commands.every(argv => !argv.join(' ').includes('API_KEY'))).toBe(true)
}, 30_000)

test('lost remote launch receipt reconciles the same run without repeating compute or inventing failure evidence', async () => {
  const f = await fixture(); f.loseReceipt()
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'lost'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  let result: Awaited<ReturnType<ScientificExecution['evaluateTrial']>> | undefined
  for (let i = 0; i < 100; i++) {
    try { result = await f.execution.reconcile({trialId: f.trial.id, requestId: 'lost'}); break }
    catch (error) { if (!(error instanceof ReceiptUnresolvedError)) throw error; await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  expect(result?.run.status).toBe('succeeded')
  expect(f.launches()).toBe(1)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.runs)).toHaveLength(1)
  expect(Object.values(state.evaluations)).toHaveLength(1)
  expect(Object.values(state.knowledge).filter(item => item.type === 'Research Failure')).toHaveLength(0)
}, 30_000)

test('remote profile rejects shell syntax, option hosts and non-normalized paths', () => {
  const valid = {host: 'gpu-node', root: '/srv/autofold', python: '/usr/bin/python3'}
  expect(RemoteProfile.parse(valid)).toEqual(valid)
  for (const patch of [{host: '-oProxyCommand=x'}, {host: 'gpu;echo'}, {root: '/srv/../etc'}, {python: '/usr/bin/python3;echo'}, {root: '/'}, {root: '/srv//autofold'}]) expect(RemoteProfile.safeParse({...valid, ...patch}).success).toBe(false)
})

test('contradictory present remote terminal fields remain unresolved and historical omitted fields stay compatible',async()=>{
  const profile={host:'fixture',root:'/tmp/remote-receipt-fixture',python:'/usr/bin/python3'}
  let commands=0,retrievals=0,raw=''
  const transport=new RemoteWorkerTransport({profile,workerRoot,run:async()=>{commands++;throw new Error('No remote commands permitted')}})
  const identity={runId:'run_terminal_fixture',bundleHash:'sha256:bundle',workerHash:'sha256:worker',planHash:'sha256:plan',directory:'/tmp/remote-receipt-fixture/runs/run_terminal_fixture'}
  const request={runId:identity.runId,requestId:'terminal-fixture',transportProfile:profile,command:[],workspace:'/tmp',bundlePath:'/tmp/unused',outputPath:'/tmp/unused-output',timeoutMs:1000}
  const bound=spyOn(transport as any,'identity').mockResolvedValue(identity),status=spyOn(transport as any,'status').mockImplementation(async()=>raw)
  const retrieve=spyOn(transport as any,'retrieve').mockImplementation(async()=>{retrievals++})
  try {
    for(const fields of [{state:'succeeded',exitCode:1},{state:'succeeded',exitCode:.5},{state:'succeeded',exitCode:null},
      {state:'succeeded',exitCode:0,completedAt:0},{state:'failed',exitCode:0,completedAt:-1},{state:'cancelled',completedAt:0},{state:'timed_out',completedAt:-1}]){
      raw=JSON.stringify({...identity,...fields})
      await expect(transport.reconcile(request)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
    }
    raw=JSON.stringify({...identity,state:'succeeded',exitCode:0,completedAt:1}).replace('"completedAt":1','"completedAt":1e999')
    await expect(transport.reconcile(request)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
    expect(retrievals).toBe(0)
    for(const state of ['succeeded','failed','cancelled','timed_out'] as const){
      raw=JSON.stringify({...identity,state})
      expect((await transport.reconcile(request)).status).toBe(state==='timed_out'?'failed':state)
    }
    // Exit zero can mean a missing required manifest or a cancellation/deadline race.
    for(const state of ['failed','cancelled','timed_out'] as const){
      raw=JSON.stringify({...identity,state,exitCode:0,completedAt:1})
      expect((await transport.reconcile(request)).status).toBe(state==='timed_out'?'failed':state)
    }
    expect(commands).toBe(0)
  }finally{bound.mockRestore();status.mockRestore();retrieve.mockRestore()}
})


test('crash after local fence but before remote launch resumes the same staged identity exactly once', async () => {
  const f = await fixture(); f.interruptBeforeLaunch()
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'before-launch'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(f.launches()).toBe(0)
  let result: Awaited<ReturnType<ScientificExecution['evaluateTrial']>> | undefined
  for (let i = 0; i < 100; i++) {
    try {result = await f.execution.reconcile({trialId: f.trial.id, requestId: 'before-launch'}); break}
    catch (error) {if (!(error instanceof ReceiptUnresolvedError)) throw error; await new Promise(resolve => setTimeout(resolve, 20))}
  }
  expect(result?.run.status).toBe('succeeded')
  expect(f.launches()).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(1)
}, 30_000)

test('old staged original first launch retains its own worker and remote profile after installed upgrades', async () => {
  const f = await fixture(); f.interruptBeforeLaunch()
  const request = {trialId: f.trial.id, requestId: 'historical-profile-upgrade'}
  await expect(f.execution.evaluateTrial(request)).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(f.launches()).toBe(0)
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  const original = await Bun.file(path.join(f.workspace, '.autofold/runs', run.id, 'request.json')).json()
  expect(original.transportProfile).toBeUndefined() // Exercise the actual older staged-plan evidence.
  const latestWorker = path.join(f.workspace, 'latest-worker')
  await fs.cp(workerRoot, latestWorker, {recursive: true, filter: file => !file.includes('/tests') && !file.includes('__pycache__')})
  await fs.appendFile(path.join(latestWorker, 'autofold_worker/evaluate.py'), '\n# Different current installation, never original launch authority\n')
  const replacement = {host: 'replacement', root: path.join(f.workspace, 'replacement'), python: '/unavailable/replacement-python'}
  const latestTransport = new RemoteWorkerTransport({profile: replacement, workerRoot: latestWorker, run: f.runner, pollMs: 20})
  const latest = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, workerRoot: latestWorker, transport: latestTransport, authorization: {remote: true}})
  let result: Awaited<ReturnType<ScientificExecution['evaluateTrial']>> | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    try {result = await latest.reconcile(request); break}
    catch (error) {if (!(error instanceof ReceiptUnresolvedError)) throw error; await new Promise(resolve => setTimeout(resolve, 20))}
  }
  expect(result?.run.id).toBe(run.id); expect(result?.run.status).toBe('succeeded'); expect(f.launches()).toBe(1)
  expect(await fs.access(replacement.root).then(() => true, () => false)).toBe(false)
  expect(f.commands.every(command => !command.includes('replacement') && !command.join(' ').includes(replacement.python))).toBe(true)
  const calls = f.commands.length
  const forbid = async (): Promise<never> => {throw new Error('Receipt-only reopen cannot call transport')}
  const receipts = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, workerRoot: latestWorker, transport: {kind: 'remote', dispatch: forbid, reconcile: forbid}})
  expect((await receipts.reconcile(request)).run.id).toBe(run.id)
  expect(f.commands.length).toBe(calls); expect(f.launches()).toBe(1)
}, 30_000)

test('reconciliation cannot start an absent remote launch after experiment scope is revoked', async () => {
  const f = await fixture(); f.interruptBeforeLaunch()
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'revoked'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await f.store.mutate(f.projectId, state => {state.experiments[f.trial.experimentId]!.status = 'paused'})
  await expect(f.execution.reconcile({trialId: f.trial.id, requestId: 'revoked'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(f.launches()).toBe(0)
}, 30_000)

test('cancel before remote launch records a terminal fenced cancellation and never starts compute', async () => {
  const f = await fixture(); f.interruptBeforeLaunch()
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'cancel-absent'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const controller = new AbortController(); controller.abort()
  await expect(f.execution.reconcile({trialId: f.trial.id, requestId: 'cancel-absent', signal: controller.signal})).rejects.toThrow()
  expect(f.launches()).toBe(0)
  expect(Object.values((await f.store.read(f.projectId)).runs)[0]?.status).toBe('cancelled')
}, 30_000)

test('lost or deleted remote registry after a host launch attempt is unresolved and can never launch twice', async () => {
  const f = await fixture(); f.loseReceipt()
  await expect(f.execution.evaluateTrial({trialId: f.trial.id, requestId: 'registry-lost'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  await fs.rm(path.join(f.workspace, 'remote/runs', run.id, 'remote-receipt.json'))
  await expect(f.execution.reconcile({trialId: f.trial.id, requestId: 'registry-lost'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(f.launches()).toBe(1)
  expect((await f.research.getRun(f.projectId, run.id)).status).not.toBe('succeeded')
}, 30_000)

test('pre-upgrade dispatch intents cannot treat a missing new host fence as authority to launch', async () => {
  const f = await fixture(); f.interruptBeforeLaunch()
  await expect(f.execution.evaluateTrial({trialId:f.trial.id,requestId:'old-protocol'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  const file = path.join(f.workspace,'.autofold/runs',run.id,'dispatch.json')
  const fence = await Bun.file(file).json(); delete fence.remoteLaunchProtocol
  await fs.chmod(file,0o600); await fs.writeFile(file,JSON.stringify(fence))
  await expect(f.execution.reconcile({trialId:f.trial.id,requestId:'old-protocol'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(f.launches()).toBe(0)
}, 30_000)

test('scope revoked after staging blocks initial launch before the host attempt fence', async () => {
  const f = await fixture()
  f.beforeDispatch(() => f.store.mutate(f.projectId,state => {state.experiments[f.trial.experimentId]!.status='paused'}))
  await expect(f.execution.evaluateTrial({trialId:f.trial.id,requestId:'paused-after-stage'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  expect(f.launches()).toBe(0)
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  expect(await Bun.file(path.join(f.workspace,'.autofold/runs',run.id,'remote-launch-attempt.json')).exists()).toBe(false)
}, 30_000)

test('abort during the initial SSH launch delivers cancellation and waits for a real terminal acknowledgement', async () => {
  const f = await fixture(), controller = new AbortController()
  f.abortLaunch(() => controller.abort())
  try {await f.execution.evaluateTrial({trialId:f.trial.id,requestId:'cancel-during-launch',signal:controller.signal})} catch (error) {expect(String(error)).toContain('cancelled')}
  expect(f.commands.some(argv=>argv.at(-1)?.includes("'cancel'")&&argv.at(-1)?.includes("'--require-cancel-ack'"))).toBe(true)
  expect(f.launches()).toBe(1)
  const run = Object.values((await f.store.read(f.projectId)).runs)[0]!
  expect(['cancelled','succeeded']).toContain(run.status)
}, 30_000)

async function interruptedOwnedJob(f: Awaited<ReturnType<typeof fixture>>) {
  const {PiJobController}=await import('../jobs')
  const {ResearchJobService}=await import('@autofold/science-core/job-service')
  const {createAgentRuntime,SqliteSessionStore}=await import('../runtime')
  const {createHash}=await import('node:crypto')
  const experiment=(await f.research.history(f.projectId,f.trial.experimentId)).experiment
  const sessionDirectory=path.join(f.workspace,'pi');let calls=0,initializations=0
  const controller=new PiJobController({workspace:f.workspace,projectId:f.projectId,store:f.store,research:f.research,execution:f.execution,sessionDirectory,
    runtimeFactory:options=>{initializations++;return createAgentRuntime(options)},
    scientistFactory:()=>({systemPrompt:'Receipt recovery fixture',initialize:async()=>{},context:async()=>({}),tools:()=>[],status:async()=>({completedEvaluations:Object.values((await f.store.read(f.projectId)).runs).filter(r=>r.status==='succeeded').length,stopped:false,researchRequested:false})}),
    runtimeOptions:{streamFn:()=>{calls++;throw new Error('Recovery must never request inference')}}})
  const job=await controller.enqueueDiscovery(experiment.id,{idempotencyKey:'original-owner',iterations:1})
  const sessions=new SqliteSessionStore(path.join(sessionDirectory,'sessions.sqlite')),runtime=createAgentRuntime({store:sessions})
  await runtime.create({id:job.payload.sessionId,metadata:{projectId:f.projectId,experimentId:experiment.id,contractHash:experiment.contractHash}});sessions.close()
  const jobs=new ResearchJobService.Service(f.store);const owner=(await jobs.claim(f.projectId,30000))!
  const deadlineMs=Date.now()+20000
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'host:lifecycle:start',{version:1,payloadHash:createHash('sha256').update(JSON.stringify(owner.payload)).digest('hex'),deadlineMs})
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'pi:job:start',{completedEvaluations:0,costUsd:0,deadlineMs})
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'pi:accounting:start',{jobId:job.id,sessions:{[job.payload.sessionId]:{costUsd:0,existed:true}}})
  await f.store.mutate(f.projectId,state=>{state.trials[f.trial.id]!.origin={jobId:job.id,leaseId:owner.leaseId!,phase:'fixture:original'}})
  return {controller,jobs,job,owner,deadlineMs,calls:()=>calls,initializations:()=>initializations}
}

test('lost acknowledgement plus controller interruption recovers a real worker receipt and settles the original job without inference or relaunch',async()=>{
  const f=await fixture(),j=await interruptedOwnedJob(f);f.loseReceipt()
  await expect(f.execution.evaluateTrial({trialId:f.trial.id,requestId:'owned-lost-ack',caller:{jobId:j.job.id,leaseId:j.owner.leaseId!}})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await j.jobs.interrupt(f.projectId,j.job.id,j.owner.leaseId!,{reason:'shutdown',detail:'Simulated controller death after acknowledged external effect'})
  f.loseStatus(1)
  let result=await j.controller.runOnce({jobId:j.job.id})
  const deadline=Date.now()+10000
  while(result?.status==='recovery_required'&&Date.now()<deadline){await Bun.sleep(20);result=await j.controller.reconcile(j.job.id)}
  expect(result?.status).toBe('succeeded');expect(result?.id).toBe(j.job.id);expect(result?.result).toMatchObject({completedEvaluations:1,modelCostUsd:0})
  expect(j.calls()).toBe(0);expect(f.launches()).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(1)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(1)
  expect(result?.checkpoints['host:lifecycle:start'].data.deadlineMs).toBe(j.deadlineMs)
  expect(result?.attempts).toBe(1)
},20000)

test('connection timeout before remote acknowledgement preserves the fenced absent identity and prevents agent/session initialization',async()=>{
  const f=await fixture(),j=await interruptedOwnedJob(f);f.failLaunch()
  await expect(f.execution.evaluateTrial({trialId:f.trial.id,requestId:'owned-absent',caller:{jobId:j.job.id,leaseId:j.owner.leaseId!}})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  await j.jobs.interrupt(f.projectId,j.job.id,j.owner.leaseId!,{reason:'shutdown',detail:'Interrupted connection before receipt'})
  const held=await j.controller.runOnce({jobId:j.job.id})
  expect(held?.status).toBe('recovery_required');expect(held?.recovery?.runId).toEqual(Object.values((await f.store.read(f.projectId)).runs)[0]!.id)
  expect(held?.error).toContain('never repeat uncertain compute');expect(held?.result).toBeUndefined()
  expect(j.initializations()).toBe(0);expect(j.calls()).toBe(0);expect(f.launches()).toBe(1)
  expect((await j.controller.reconcile(j.job.id)).status).toBe('recovery_required')
  expect(j.initializations()).toBe(0);expect(f.launches()).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(0)
},15000)

test('read-only status outages are bounded and never retry the launch command',async()=>{
  const f=await fixture();f.loseReceipt()
  await expect(f.execution.evaluateTrial({trialId:f.trial.id,requestId:'bounded-status'})).rejects.toBeInstanceOf(ReceiptUnresolvedError)
  f.loseStatus(10)
  const before=f.commands.length
  await expect(f.execution.reconcile({trialId:f.trial.id,requestId:'bounded-status'})).rejects.toThrow('remote_connection_failed')
  expect(f.commands.slice(before).filter(c=>c.at(-1)?.includes("'status'"))).toHaveLength(3)
  expect(f.launches()).toBe(1)
},15000)
