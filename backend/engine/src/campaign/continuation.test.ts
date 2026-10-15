import {afterEach, expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchJobService} from '@autofold/science-core/job-service'
import {ScientificExecution} from '../execution'
import {PiJobController} from '../jobs'
import {CampaignController} from './index'

const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})

// Resource-admission fixtures, separate from the mandatory native/public workflow
// acceptance tests. These literal settled receipts do not claim real inference.
async function fixture(input: {reported?: number; unknown?: boolean; expired?: boolean; reason?: string; inactiveExperiment?: boolean} = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-continuation-')); roots.push(workspace)
  const projectId = 'continuation_offline', store = new StorageResearchStore({directory: path.join(workspace, 'research')})
  const research = new ResearchService.Service(store), execution = new ScientificExecution({workspace, projectId, research})
  const options = {workspace, projectId, store, research, execution, sessionDirectory: path.join(workspace, 'sessions')}
  const jobs = new PiJobController(options), campaign = new CampaignController({...options, jobs})
  jobs.registerOperation('campaign_loop', campaign.operation)
  const scope = await research.createCampaign(projectId, {objective: 'Offline resource admission only'})
  await research.activateCampaign(projectId, scope.id)
  const evaluator = (await execution.evaluators())[0]!
  const experiment = await research.createExperiment(projectId, scope.id, {contract: {version: 1, objective: 'Resource fixture', targetArtifactHash: 'sha256:'+'a'.repeat(64),
    modality: 'short_peptide', budget: {maximumCandidates: 8, gpuHours: 0, wallTimeMinutes: 1}, evaluator: {...evaluator, fixedSeeds: [7,11], submissionSize: 3}}})
  if(!input.inactiveExperiment) await research.activateExperiment(projectId, experiment.id)
  const source = await campaign.enqueueCampaign(scope.id, {idempotencyKey: 'original', experimentId: experiment.id, maxSteps: 4, maximumTrajectories: 3,
    maximumDiscoveryTrajectories: 3, reservedReplayTrajectories: 0, maximumKnowledgeRefreshes: 0,
    modelBudgetUsd: 1, perChildModelBudgetUsd: .5, maximumDurationMs: 60_000})
  const service = new ResearchJobService.Service(store), owner = (await service.claim(projectId, 30_000, {eligible: row => row.id === source.id}))!
  const deadlineMs = Date.now() + (input.expired ? -1000 : 60_000)
  await service.checkpoint(projectId, source.id, owner.leaseId!, 'campaign:job:start', {deadlineMs})
  const reported = input.reported ?? .3
  const result = {runtime: 'autofold-pi.v1', campaignId: scope.id, status: 'deferred', boundary: 'receipt_only_recovery_no_continuation',
    completedSteps: 1, modelCostUsd: .1, remainingTrajectories: 3, remainingDiscoveryTrajectories: 3, remainingReservedReplayTrajectories: 0,
    knowledgeRefreshes: 0, providerAccounting: {status: input.unknown ? 'unknown' : 'reported', reportedCostUsd: input.unknown ? null : reported,
      knownReportedCostUsd: reported, originalRequestIds: ['fixture:request'], upstreamRequestIds: ['fixture:invoice'], unknownRequestIds: input.unknown ? ['fixture:request'] : []},
    steps: [{step: 1, observationAt: new Date().toISOString(), proposal: {kind: 'iterate_experiment'}, decision: {}, modelCostUsd: .1,
      consumedTrajectories: 0, consumedDiscoveryTrajectories: 0, consumedReplayTrajectories: 0,
      result: {status: 'superseded_stale_observation', modelCostUsd: 0, ...(input.reason ? {reason: input.reason} : {})}}]}
  const completed = await service.succeed(projectId, source.id, owner.leaseId!, result)
  const supervise = async (original=completed) => (campaign.operation as typeof campaign.operation & {continue?: (job: typeof completed, signal: AbortSignal) => Promise<void>}).continue?.(original, new AbortController().signal)
  return {...options, jobs, campaign, scope, source: completed, deadlineMs, supervise}
}

test('automatic handoff retains the original deadline, identity and both cost ceilings', async () => {
  const f = await fixture(), original = JSON.stringify(f.source)
  await f.supervise()
  const successors = (await f.jobs.list()).filter(job => job.payload.continuedFromJobId === f.source.id)
  expect(successors).toHaveLength(1)
  const next = successors[0]!
  expect(next.payload).toMatchObject({maxSteps: 3, maximumTrajectories: 3, maximumDiscoveryTrajectories: 3,
    reservedReplayTrajectories: 0, modelBudgetUsd: .7, perChildModelBudgetUsd: .5, originDeadlineMs: f.deadlineMs,
    sessionId: f.source.payload.sessionId, modelSelection: f.source.payload.modelSelection})
  expect(Number(next.payload.maximumDurationMs)).toBeLessThanOrEqual(60_000)
  expect(JSON.stringify(await f.jobs.get(f.source.id))).toBe(original)
  await Promise.all([f.supervise(), f.supervise()])
  expect((await f.jobs.list()).filter(job => job.payload.continuedFromJobId === f.source.id)).toHaveLength(1)
})

test('cancelling the terminal original revokes residual admission', async () => {
  const f = await fixture()
  await f.jobs.cancel(f.source.id)
  await expect(f.campaign.enqueueCampaign(f.scope.id, {idempotencyKey: 'cannot-replenish', maxSteps: 1, continuedFromJobId: f.source.id})).rejects.toThrow(/cancel|revok/i)
  await f.supervise()
  expect(await f.jobs.list()).toHaveLength(1)
})

test('cancelling the original also cancels an already admitted continuation chain', async () => {
  const f = await fixture()
  const next = await f.campaign.enqueueCampaign(f.scope.id, {idempotencyKey: 'explicit-residual', maxSteps: 1, continuedFromJobId: f.source.id})
  await f.jobs.cancel(f.source.id)
  expect((await f.jobs.get(next.id)).status).toBe('cancelled')
  expect((await f.jobs.get(f.source.id)).result).toEqual(f.source.result)
})

for (const input of [{unknown: true}, {expired: true}, {reported: 1}, {reason: 'runtime_limit_reached'}, {reason: 'scientist_stopped'}, {inactiveExperiment: true}]) {
  test('automatic handoff holds exhausted, unknown or stopped authority ' + JSON.stringify(input), async () => {
    const f = await fixture(input)
    await f.supervise().catch(() => {})
    expect(await f.jobs.list()).toHaveLength(1)
  })
}

test('an explicit existing continuation wins without an automatic fork', async () => {
  const f = await fixture()
  const next = await f.campaign.enqueueCampaign(f.scope.id, {idempotencyKey: 'explicit-residual', maxSteps: 1, continuedFromJobId: f.source.id})
  await f.supervise()
  expect((await f.jobs.list()).map(job => job.id).sort()).toEqual([f.source.id, next.id].sort())
})

test('automatic handoff requires canonical settlement instead of trusting a legacy succeeded label', async () => {
  const f = await fixture()
  const legacy = {...f.source, id: 'job_legacy_unsettled', idempotencyKey: 'legacy-unsettled'}
  await f.store.mutate(f.projectId, state => {state.jobs[legacy.id]=legacy})
  await f.supervise(legacy)
  expect((await f.jobs.list()).filter(job=>job.payload.continuedFromJobId===legacy.id)).toHaveLength(0)
})

test('an unknown-billing hold does not starve an unrelated campaign queue', async () => {
  const f = await fixture({unknown: true}), shutdown = new AbortController()
  const other = await f.research.createCampaign(f.projectId, {objective: 'Independent zero-inference work'})
  await f.research.activateCampaign(f.projectId, other.id)
  f.jobs.registerHandler('knowledge_review', async () => ({modelCostUsd: 0, fixture: 'independent zero-inference result'}))
  const queued = await f.jobs.enqueueJob({idempotencyKey: 'independent-work', payload: {kind: 'knowledge_review', campaignId: other.id,
    sessionId: 'ses_independent', claimIds: [], alignmentIds: [], question: 'Zero-inference host fixture', maxRequests: 1, modelBudgetUsd: .1}})
  const worker = f.jobs.runWorker({signal: shutdown.signal, pollMs: 1})
  try {
    const deadline = Date.now()+3000
    while((await f.jobs.get(queued.id)).status!=='succeeded'&&Date.now()<deadline) await Bun.sleep(10)
    expect((await f.jobs.get(queued.id)).status).toBe('succeeded')
    expect((f.jobs.workerState as unknown as {continuationHolds?: {jobId:string}[]}).continuationHolds?.some(hold=>hold.jobId===f.source.id)).toBe(true)
    expect((await f.jobs.list()).filter(job=>job.payload.continuedFromJobId===f.source.id)).toHaveLength(0)
  } finally {shutdown.abort();await worker}
})
