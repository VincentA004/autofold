import {afterEach, expect, spyOn, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import type {ResearchDomain} from '@autofold/science-core/domain'
import {ScientificExecution} from '../execution'
import {PiJobController} from '../jobs'
import {captureJobAccountingBaseline, readJobAccounting} from '../jobs/accounting'
import {JobInterrupted} from '../jobs/lease'
import {createAgentRuntime, DEFAULT_MODEL_SELECTION, createSessionStore} from '../runtime'
import {CampaignController} from './index'
const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function host() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-accounting-')); roots.push(workspace)
  return {workspace, projectId: 'accounting_offline', sessionDirectory: path.join(workspace, 'pi')}
}
function job(h: Awaited<ReturnType<typeof host>>, kind = 'autoresearch'): ResearchDomain.Job {
  const now = new Date().toISOString()
  return {id: 'job_accounting', projectId: h.projectId, idempotencyKey: 'accounting', status: 'failed', attempts: 1, maxAttempts: 1,
    createdAt: now, updatedAt: now, checkpoints: {}, payload: {runtime: 'autofold-pi.v1', kind, sessionId: 'ses_accounting',
      experimentId: 'exp_accounting', campaignId: 'cmp_accounting', repetitions: 2, modelSelection: DEFAULT_MODEL_SELECTION}} as unknown as ResearchDomain.Job
}
async function usage(h: Awaited<ReturnType<typeof host>>, id: string, costUsd: number) {
  const sessions = createSessionStore(path.join(h.sessionDirectory, 'sessions.sqlite'))
  try {
    const runtime = createAgentRuntime({store: sessions, tools: [], modelSelection: DEFAULT_MODEL_SELECTION})
    const session = await sessions.get(id) ?? await runtime.create({id, metadata: {projectId: h.projectId, campaignId: 'cmp_accounting'}})
    session.usage.costUsd = costUsd; await sessions.save(session)
  } finally {sessions.close()}
}
function saved(j: ResearchDomain.Job, data: unknown, phase = 'pi:accounting:start') {
  j.checkpoints[phase] = {phase, data: data as Record<string, unknown>, completedAt: new Date().toISOString()}
}

test('effect-free pre-dispatch accounting does not create a SQLite database or lazy supervisor session', async () => {
  const h = await host(), j = job(h)
  const baseline = await captureJobAccountingBaseline(h, j); saved(j, baseline)
  expect((await readJobAccounting(h, j)).modelCostUsd).toBe(0)
  expect(await fs.access(path.join(h.sessionDirectory, 'sessions.sqlite')).then(() => true, () => false)).toBe(false)
})
for (const status of ['succeeded', 'failed', 'cancelled'] as const) test(`${status} children charge only their original job session delta on repeated recovery`, async () => {
  const h = await host(), j = job(h); j.status = status
  await usage(h, 'ses_accounting', 12)
  const baseline = await captureJobAccountingBaseline(h, j); saved(j, baseline)
  await usage(h, 'ses_accounting', 12.00451251)
  if (status === 'succeeded') j.result = {modelCostUsd: 0}
  const first = await readJobAccounting(h, j), second = await readJobAccounting(h, j)
  expect(first.modelCostUsd).toBeCloseTo(.00451251, 10); expect(second).toEqual(first)
  j.attempts = 2
  expect(await captureJobAccountingBaseline(h, j)).toEqual(baseline)
})

test('a migrated failed literature child recovers its persisted operation baseline', async () => {
  const h = await host(), j = job(h, 'knowledge_refresh')
  const key = hash(`${h.projectId}:${j.payload.campaignId}:${j.id}`), file = path.join(h.workspace, '.autofold/literature', key, 'review.json')
  await fs.mkdir(path.dirname(file), {recursive: true})
  await fs.writeFile(file, JSON.stringify({operationId: j.id, childSessionId: j.payload.sessionId, baselineCostUsd: 3}))
  await usage(h, 'ses_accounting', 3.00451251)
  expect((await readJobAccounting(h, j)).modelCostUsd).toBeCloseTo(.00451251, 10)
  j.attempts = 2
  expect((await captureJobAccountingBaseline(h, j)).sessions.ses_accounting!.costUsd).toBe(3)
})

test('missing baselines, vanished sessions, reset usage and unaccounted recovery fail closed', async () => {
  const h = await host(), j = job(h)
  await expect(readJobAccounting(h, j)).rejects.toThrow('no durable usage baseline')
  j.attempts = 2; await usage(h, 'ses_accounting', 2)
  await expect(captureJobAccountingBaseline(h, j)).rejects.toThrow('no original job baseline')
  j.attempts = 1; saved(j, {jobId: j.id, sessions: {ses_accounting: {costUsd: 3, existed: true}}})
  await expect(readJobAccounting(h, j)).rejects.toThrow('usage reset')
  await fs.rm(path.join(h.sessionDirectory, 'sessions.sqlite'))
  await expect(readJobAccounting(h, j)).rejects.toThrow('session missing')
})

test('paired replay includes every actual arm session once, including failure before all arms run', async () => {
  const h = await host(), j = job(h, 'skill_shadow_replay')
  const baseline = await captureJobAccountingBaseline(h, j); saved(j, baseline)
  const ids = Object.keys(baseline.sessions); expect(ids).toHaveLength(4)
  await usage(h, ids[0]!, .04); await usage(h, ids[1]!, .06)
  expect((await readJobAccounting(h, j)).modelCostUsd).toBeCloseTo(.1, 10)
  const receipt = await readJobAccounting(h, j)
  saved(j, {jobId: j.id, leaseId: 'lease_one'}, 'pi:accounting:lease:lease_one')
  saved(j, receipt, 'pi:accounting:settlement:lease_one')
  await usage(h, ids[0]!, 20)
  expect(await readJobAccounting(h, j)).toEqual(receipt)
  // A retry gets a distinct lease, so the older terminal snapshot cannot hide new usage.
  saved(j, {jobId: j.id, leaseId: 'lease_two'}, 'pi:accounting:lease:lease_two')
  expect((await readJobAccounting(h, j)).modelCostUsd).toBeCloseTo(20.06, 10)
})

async function campaignFixture() {
  const h = await host(), store = new StorageResearchStore({directory: path.join(h.workspace, 'research')}), research = new ResearchService.Service(store)
  const execution = new ScientificExecution({...h, research}), campaign = await research.createCampaign(h.projectId, {objective: 'Offline consumption accounting'})
  await research.activateCampaign(h.projectId, campaign.id)
  const evaluator = (await execution.evaluators())[0]!
  const contract: ResearchDomain.ExperimentContract = {version: 1, objective: 'Offline accounting fixture', targetArtifactHash: 'sha256:' + 'a'.repeat(64), modality: 'short_peptide',
    budget: {maximumCandidates: 8, gpuHours: 0, wallTimeMinutes: 1}, evaluator: {...evaluator, fixedSeeds: [7,11], submissionSize: 3}}
  const experiment = await research.createExperiment(h.projectId, campaign.id, {contract}); await research.activateExperiment(h.projectId, experiment.id)
  const options = {...h, store, research, execution}, jobs = new PiJobController(options), controller = new CampaignController({...options, jobs})
  jobs.registerHandler('campaign_loop', controller.handleJob)
  return {...options, jobs, controller, campaign, experiment}
}
for (const terminal of ['failed', 'cancelled'] as const) test(`campaign charges ${terminal} child inference and admitted trials with no result, once after parent interruption`, async () => {
  const f = await campaignFixture(), original = f.jobs.runOnce.bind(f.jobs); let children = 0, interrupt = true
  const dispatch = spyOn(f.jobs, 'runOnce').mockImplementation(async input => {
    const current = input?.jobId ? await f.jobs.get(input.jobId) : undefined
    if (current?.payload.kind !== 'autoresearch') return original(input)
    children++
    const {ResearchJobService}=await import('@autofold/science-core/job-service')
    const childOwner=(await new ResearchJobService.Service(f.store).claim(f.projectId,30000,{eligible:job=>job.id===current.id}))!
    const sessionId = String(current.payload.sessionId)
    await usage(f, sessionId, .00451251)
    await f.research.createTrial(f.projectId, f.experiment.id, {hypothesis: 'Failure still consumed an empirical slot', designAdapter: 'mock', programPath: 'fixture.json', programHash: 'sha256:' + 'b'.repeat(64), origin: {jobId: current.id, phase: 'dispatch'}}, {jobId:current.id,leaseId:childOwner.leaseId!})
    await f.store.mutate(f.projectId, state => {
      const child = state.jobs[current.id]!
      child.status = terminal; child.error = 'Offline terminal failure'; child.completedAt = new Date().toISOString(); child.updatedAt = child.completedAt
      child.checkpoints['pi:job:start'] = {phase: 'pi:job:start', data: {costUsd: 0, completedEvaluations: 0, deadlineMs: Date.now() + 10000}, completedAt: new Date().toISOString()}
    })
    return f.jobs.get(current.id)
  })
  // Interrupt after the immutable child receipt but before the step settles.
  const handler = new CampaignController({...f, jobs: f.jobs})
  const otherJobs = new PiJobController(f)
  otherJobs.registerHandler('campaign_loop', ctx => handler.handleJob({...ctx, lifecycle: {...ctx.lifecycle, checkpoint: async (phase, data) => {
    if (phase === 'campaign:step:1:completed' && interrupt) {interrupt = false; throw new JobInterrupted('shutdown', 'Offline interrupted step settlement')}
    return ctx.lifecycle.checkpoint(phase, data)
  }}}))
  const parent = await f.controller.enqueueCampaign(f.campaign.id, {idempotencyKey: 'failed-child', maxSteps: 2, maximumTrajectories: 2, maximumDiscoveryTrajectories: 2, maximumKnowledgeRefreshes: 0})
  await f.store.mutate(f.projectId, state => {state.jobs[parent.id]!.maxAttempts = 1})
  expect((await otherJobs.runOnce({jobId: parent.id}))?.status).toBe('interrupted')
  const completed = await otherJobs.reconcile(parent.id)
  expect(completed?.status).toBe('succeeded')
  expect(completed?.result).toMatchObject({boundary: 'child_job_requires_attention', modelCostUsd: .00451251, remainingTrajectories: 1, remainingDiscoveryTrajectories: 1, completedSteps: 1})
  expect(children).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(1)
  expect(await fs.access(path.join(f.sessionDirectory, 'sessions.sqlite')).then(() => true, () => false)).toBe(true)
  const sessions = createSessionStore(path.join(f.sessionDirectory, 'sessions.sqlite'))
  try {expect(await sessions.get(String(parent.payload.sessionId))).toBeUndefined()} finally {sessions.close()}
  // Continuation admission must audit a legacy cached zero charge without reviving a closed operation.
  await f.store.mutate(f.projectId, state => {
    const origin = state.jobs[parent.id]!, checkpoint = origin.checkpoints['campaign:step:1:completed']!
    const step = checkpoint.data as any
    checkpoint.data = {...step, modelCostUsd: 0, consumedTrajectories: 0, consumedDiscoveryTrajectories: 0, result: {...step.result, modelCostUsd: 0, consumedTrajectories: 0}}
  })
  await expect(otherJobs.retry(parent.id)).rejects.toMatchObject({data:{code:'new_operation_required'}})
  // Continuation admission also audits a migrated source result instead of inheriting its undercharge.
  await f.store.mutate(f.projectId, state => {
    const origin = state.jobs[parent.id]!, result = origin.result as any
    origin.result = {...result, modelCostUsd: 0, remainingTrajectories: 2, remainingDiscoveryTrajectories: 2,
      steps: [origin.checkpoints['campaign:step:1:completed']!.data]}
  })
  const continuation = await f.controller.enqueueCampaign(f.campaign.id, {idempotencyKey: 'audited-continuation', maxSteps: 1, continuedFromJobId: parent.id})
  expect(continuation.payload.maximumTrajectories).toBe(1)
  expect(continuation.payload.maximumDiscoveryTrajectories).toBe(1)
  expect(continuation.payload.modelBudgetUsd).toBeCloseTo(Number(parent.payload.modelBudgetUsd) - .00451251, 10)
  dispatch.mockRestore()
})

test('missing failed-child accounting blocks campaign completion and continuation grants', async () => {
  const f = await campaignFixture(), original = f.jobs.runOnce.bind(f.jobs)
  const dispatch = spyOn(f.jobs, 'runOnce').mockImplementation(async input => {
    const current = input?.jobId ? await f.jobs.get(input.jobId) : undefined
    if (current?.payload.kind !== 'autoresearch') return original(input)
    await f.store.mutate(f.projectId, state => {state.jobs[current.id]!.status = 'failed'; state.jobs[current.id]!.error = 'No accounting proof'})
    return f.jobs.get(current.id)
  })
  const parent = await f.controller.enqueueCampaign(f.campaign.id, {idempotencyKey: 'missing-child', maxSteps: 1, maximumTrajectories: 1, maximumKnowledgeRefreshes: 0})
  await f.store.mutate(f.projectId, state => {state.jobs[parent.id]!.maxAttempts = 1})
  const completed = await f.jobs.runOnce({jobId: parent.id})
  expect(completed?.status).toBe('recovery_required'); expect(completed?.recovery?.reason).toBe('accounting_unresolved'); expect(completed?.error).toContain('no durable usage baseline')
  await expect(f.controller.enqueueCampaign(f.campaign.id, {idempotencyKey: 'missing-continuation', maxSteps: 1, continuedFromJobId: parent.id})).rejects.toThrow('completed native originating job')
  dispatch.mockRestore()
})

for (const proof of ['known','missing-proposal-cost','unbound-child'] as const) test(`receipt-only campaign closeout preserves ${proof} accounting without starting another step`, async () => {
  const f=await campaignFixture()
  const {ResearchJobService}=await import('@autofold/science-core/job-service')
  const {directActiveExperimentProposal}=await import('./index')
  const jobs=new ResearchJobService.Service(f.store)
  const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'receipt-closeout',experimentId:f.experiment.id,maxSteps:2,maximumTrajectories:2,maximumDiscoveryTrajectories:2,discoveryBatchSize:1,maximumKnowledgeRefreshes:0})
  const owner=(await jobs.claim(f.projectId,30000,{eligible:job=>job.id===parent.id}))!
  const deadlineMs=Date.now()+60000
  await jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'host:lifecycle:start',{version:1,payloadHash:hash(JSON.stringify(owner.payload)),deadlineMs})
  await jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'campaign:job:start',{deadlineMs})
  const observation=await f.controller.observe(f.campaign.id,parent.id)
  const proposal=directActiveExperimentProposal(observation,2,f.experiment.id,false,{discoveryBatchSize:1,maximumDiscoveryTrajectories:2,reservedReplayTrajectories:0})!
  expect(proposal.kind).toBe('iterate_experiment')
  await jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'campaign:step:1:observation',observation)
  await jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'campaign:step:1:proposal',{move:proposal,...(proof==='missing-proposal-cost'?{}:{modelCostUsd:0})})
  const child=await f.jobs.enqueueDiscovery(f.experiment.id,{idempotencyKey:proof==='unbound-child'?'unbound-original-child':`campaign:${parent.id}:step:1:discovery`,iterations:1,parentJobId:parent.id,parentLeaseId:owner.leaseId!})
  if(proof!=='unbound-child')await jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'campaign:step:1:child',{jobId:child.id})
  const childOwner=(await jobs.claim(f.projectId,30000,{eligible:job=>job.id===child.id}))!
  await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:'Original admitted accounting fixture',designAdapter:'mock',programPath:'fixture.py',programHash:'sha256:'+'c'.repeat(64),origin:{jobId:child.id,phase:'original'}},{jobId:child.id,leaseId:childOwner.leaseId!})
  await f.store.mutate(f.projectId,state=>{state.jobs[child.id]!.status='succeeded';state.jobs[child.id]!.result={modelCostUsd:.04,completedEvaluations:1};state.jobs[child.id]!.completedAt=new Date().toISOString()})
  await jobs.interrupt(f.projectId,parent.id,owner.leaseId!,{reason:'shutdown',detail:'Controller exited before recording its completed child'})
  let models=0,enqueues=0
  const recoveredJobs=new PiJobController({...f,runtimeOptions:{streamFn:()=>{models++;throw new Error('Closeout cannot infer')}}})
  const recoveredCampaign=new CampaignController({...f,jobs:recoveredJobs,propose:async()=>{models++;throw new Error('Closeout cannot propose')}})
  recoveredJobs.registerHandler('campaign_loop',recoveredCampaign.handleJob)
  const enqueue=spyOn(recoveredJobs,'enqueueDiscovery').mockImplementation(async()=>{enqueues++;throw new Error('Closeout cannot enqueue')})
  const completed=await recoveredJobs.reconcile(parent.id)
  if(proof==='known') {
    expect(completed.status).toBe('succeeded')
    expect(completed.result).toMatchObject({status:'deferred',boundary:'receipt_only_recovery_no_continuation',completedSteps:1,modelCostUsd:.04,remainingTrajectories:1,remainingDiscoveryTrajectories:1})
    expect((await recoveredJobs.reconcile(parent.id)).result).toEqual(completed.result)
  } else {
    expect(completed.status).toBe('recovery_required');expect(completed.result).toBeUndefined()
    expect(completed.recovery?.reason).toBe('accounting_unresolved')
  }
  expect(Object.values((await f.store.read(f.projectId)).jobs)).toHaveLength(2)
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(1)
  expect(models).toBe(0);expect(enqueues).toBe(0);enqueue.mockRestore()
  expect(await fs.access(path.join(f.sessionDirectory,'sessions.sqlite')).then(()=>true,()=>false)).toBe(false)
})


test('campaign cannot turn an interrupted unknown-cost supervisor request into another proposal or residual grant', async () => {
  const f=await campaignFixture()
  const second=await f.research.createExperiment(f.projectId,f.campaign.id,{contract:f.experiment.contract});await f.research.activateExperiment(f.projectId,second.id)
  const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'unknown-supervisor-cost',maxSteps:2,maximumTrajectories:2,maximumKnowledgeRefreshes:0})
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  try {
    const runtime=createAgentRuntime({store:sessions});const session=await runtime.create({id:String(parent.payload.sessionId),metadata:{projectId:f.projectId,campaignId:f.campaign.id}})
    session.modelRequests={original:{status:'unknown',model:session.modelSelection,purpose:'turn',startedAt:Date.now(),error:'Controller died after a provider request'}}
    await sessions.save(session)
  } finally {sessions.close()}
  let calls=0
  const controlledJobs=new PiJobController(f)
  const campaign=new CampaignController({...f,jobs:controlledJobs,runtimeOptions:{streamFn:()=>{calls++;throw new Error('Unknown spend must stop another model request')}}})
  controlledJobs.registerHandler('campaign_loop',campaign.handleJob)
  const held=await controlledJobs.runOnce({jobId:parent.id})
  expect(held?.status).toBe('recovery_required');expect(held?.recovery?.reason).toBe('accounting_unresolved')
  expect(held?.result).toBeUndefined();expect(calls).toBe(0)
  expect(Object.values((await f.store.read(f.projectId)).jobs)).toHaveLength(1)
  await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'no-unknown-cost-continuation',continuedFromJobId:parent.id,maxSteps:1})).rejects.toThrow('completed native originating job')
})
