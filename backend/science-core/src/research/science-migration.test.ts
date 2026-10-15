import {createHash} from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ResearchDomain } from './domain'
import { ResearchService } from './service'
import { ResearchJobService } from './job-service'
import { StorageResearchStore } from './store'
import { ResearchTrajectoryCloseout } from './trajectory-closeout'
import { ResearchScientistMemory } from './scientist-memory'
import { ResearchScientistKernel } from './scientist-kernel'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const digest = (c: string) => `sha256:${c.repeat(64)}`
const plan = {
  question: 'Does a repair improve the family?',
  alternatives: [
    { id: 'repair', experiment: 'Repair', expectedInformation: 'Family effect', estimatedGpuHours: 1 },
    { id: 'replicate', experiment: 'Replicate', expectedInformation: 'Variance', estimatedGpuHours: 1 },
  ], selectedAlternativeId: 'repair', rationale: 'Test one repair', evidenceRefs: ['trl_reference'],
  outcomeBranches: [{ observation: 'Improves', nextDecision: 'Replicate' }, { observation: 'Worsens', nextDecision: 'Stop' }],
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-science-migration-')); roots.push(root)
  const options = { directory: path.join(root, 'db') }
  const project = 'project-migration'
  let sequence = 0, seconds = 0
  const store = new StorageResearchStore(options)
  const service = new ResearchService.Service(store, {
    id: prefix => `${prefix}_${++sequence}`,
    now: () => new Date(Date.UTC(2026, 9, 3, 0, 0, seconds++)).toISOString(),
  })
  const campaign = await service.createCampaign(project, { objective: 'Improve locked score' })
  await service.activateCampaign(project, campaign.id)
  const experiment = await service.createExperiment(project, campaign.id, { contract: {
    version: 1, objective: 'Improve locked score', targetArtifactHash: digest('a'), modality: 'linear_minibinder',
    budget: { maximumCandidates: 10, gpuHours: 1, wallTimeMinutes: 30 },
    evaluator: { id: 'locked', version: '1', sourceHash: digest('b'), direction: 'minimize', fixedSeeds: [1], submissionSize: 2 },
  } })
  await service.activateExperiment(project, experiment.id)
  return { root, options, project, store, service, campaign, experiment }
}

const basic = { hypothesis: 'Test repair', designAdapter: 'mock' as const, programPath: 'trial.py', programHash: digest('c') }

test('native trial metadata survives SQLite reopen and origin retries reject changed immutable plans', async () => {
  const { options, project, service, experiment } = await fixture()
  const metadata = {
    decisionPlan: plan, prediction: { comparatorTrialId: 'trl_reference', metric: 'locked_score' as const, relation: 'lower' as const, minimumDifference: 0 },
    evidenceRefs: ['trl_reference'], calibrationClass: 'known_negative' as const, replicateOfTrialId: 'trl_reference',
    configurationFamilyFingerprint: digest('d'), semanticProgramFingerprint: digest('e'), workflowFingerprint: digest('f'),
  }
  const input = { ...basic, ...metadata, origin: { jobId: 'job_owner', phase: 'iteration:1' } }
  const trial = await service.createTrial(project, experiment.id, input)
  const reopened = new ResearchService.Service(new StorageResearchStore(options))
  expect((await reopened.getTrialContext(project, trial.id)).trial).toMatchObject(metadata)
  expect(await reopened.createTrial(project, experiment.id, input)).toEqual(trial)
  const changes = [
    { decisionPlan: { ...plan, rationale: 'Changed rationale' } },
    { prediction: { ...metadata.prediction, minimumDifference: 0.1 } },
    { evidenceRefs: ['run_other'] }, { calibrationClass: 'known_positive' as const },
    { replicateOfTrialId: 'trl_other' }, { configurationFamilyFingerprint: digest('a') },
    { semanticProgramFingerprint: digest('a') }, { workflowFingerprint: digest('a') },
  ]
  for (const change of changes) {
    await expect(reopened.createTrial(project, experiment.id, { ...input, ...change })).rejects.toMatchObject({ data: { code: 'trial_origin_conflict' } })
  }
  // Former arbitrary durable fields remain readable and survive transitions.
  expect(ResearchDomain.Trial.parse({ ...trial, previousRuntimeExtension: { retained: true } }).previousRuntimeExtension).toEqual({ retained: true })
})

test('SQLite closeout retries preserve cycle, observation and event identities and prior evaluation chronology', async () => {
  const { root, options, project, service, campaign, experiment } = await fixture()
  const finish = async (hypothesis: string, score: number, intent: ResearchDomain.Trial['intent'] = 'optimize') => {
    const trial = await service.createTrial(project, experiment.id, { ...basic, hypothesis, intent })
    const run = await service.beginRun(project, trial.id, { bundlePath: 'bundle', outputPath: 'output' })
    await service.attachRunJob(project, run.id, `compute-${run.id}`)
    await service.completeRun(project, run.id, { contractHash: experiment.contractHash, evaluatorHash: experiment.contract.evaluator.sourceHash, valid: true, score, diagnostics: {} }, digest('d'))
    return { trial, run }
  }
  await finish('Prior optimum', 0.5)
  const current = await finish('Repair result', 0.4)
  await finish('Later optimum', 0.1)
  const input = { campaignId: campaign.id, experimentId: experiment.id, sessionId: 'ses_scientist', iteration: 2, status: 'succeeded' as const, trialId: current.trial.id, runId: current.run.id }
  const dependencies = (host: ResearchService.Service): ResearchTrajectoryCloseout.Dependencies => ({
    commit:input=>host.recordTrajectoryObservation(project,input),acknowledge:(id,hash)=>host.acknowledgeTrajectoryProjection(project,id,hash),
    project:projection=>projection.kind==='campaign_knowledge'?host.publishCampaignKnowledge(project,projection.campaignId,root):ResearchTrajectoryCloseout.projectJournalV2(projection,root),
  })
  const first = await ResearchTrajectoryCloseout.run(input, dependencies(service))
  if(first.status!=='completed')throw new Error('Expected original factual commit')
  const reopened = new ResearchService.Service(new StorageResearchStore(options))
  expect(await ResearchTrajectoryCloseout.run(input, dependencies(reopened))).toEqual({...first,outboxIds:[]})
  const state = await new StorageResearchStore(options).read(project)
  expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
  expect(Object.values(state.searchObservations)).toHaveLength(3)
  expect(Object.values(state.searchObservations).find(item=>item.runId===current.run.id)).toMatchObject({ priorBestScore: 0.5, score: 0.4 })
  expect(Object.values(state.searchObservations).find(item=>item.runId===current.run.id)?.scoreDeltaFromPriorBest).toBeCloseTo(.1)
  expect(ResearchTrajectoryCloseout.events(state,await ResearchScientistMemory.read(root,experiment.id),experiment.id)).toHaveLength(3)
  const control = await finish('Matched negative control', 0.01, 'negative_control')
  await ResearchTrajectoryCloseout.run({ ...input, iteration: 4, trialId: control.trial.id, runId: control.run.id, calibrationClass: 'known_negative' }, dependencies(reopened))
  expect((await reopened.history(project, experiment.id)).experiment.incumbentTrialId).not.toBe(control.trial.id)
  const controlEvent = ResearchTrajectoryCloseout.events(await new StorageResearchStore(options).read(project),await ResearchScientistMemory.read(root,experiment.id),experiment.id).find(event => event.trialId === control.trial.id)
  expect(controlEvent).toMatchObject({ intent: 'negative_control', decision: 'observed' })
})

test('recovered run creates one failure and one authoritative success amendment after SQLite reopen', async () => {
  const { root, options, project, service, campaign, experiment } = await fixture()
  const trial = await service.createTrial(project, experiment.id, basic)
  const run = await service.beginRun(project, trial.id, { bundlePath: 'bundle', outputPath: 'output' })
  await service.attachRunJob(project, run.id, 'compute-original')
  await service.failRun(project, run.id, 'Artifact retrieval failed',undefined,{failureReceiptHash:digest('e')})
  const dependencies = (host: ResearchService.Service): ResearchTrajectoryCloseout.Dependencies => ({
    commit:input=>host.recordTrajectoryObservation(project,input),acknowledge:(id,hash)=>host.acknowledgeTrajectoryProjection(project,id,hash),
    project:projection=>ResearchTrajectoryCloseout.projectJournalV2(projection,root),
  })
  const input = { campaignId: campaign.id, experimentId: experiment.id, sessionId: 'ses_recovery', iteration: 1, trialId: trial.id, runId: run.id }
  await ResearchTrajectoryCloseout.run({ ...input, status: 'run_failed' }, dependencies(service))
  const reopened = new ResearchService.Service(new StorageResearchStore(options))
  await reopened.reopenRunFinalization(project, run.id)
  await reopened.completeRun(project, run.id, { contractHash: experiment.contractHash, evaluatorHash: experiment.contract.evaluator.sourceHash, valid: true, score: 0.2, diagnostics: {} }, digest('d'))
  await reopened.supersedeRecoveredFailures(project, run.id)
  await ResearchTrajectoryCloseout.run({ ...input, status: 'succeeded' }, dependencies(reopened))
  await ResearchTrajectoryCloseout.run({ ...input, status: 'succeeded' }, dependencies(reopened))
  const canonical=await new StorageResearchStore(options).read(project)
  const events = ResearchTrajectoryCloseout.events(canonical,await ResearchScientistMemory.read(root,experiment.id),experiment.id)
  expect(events).toHaveLength(1)
  expect(Object.values(canonical.searchObservations)).toHaveLength(2)
  expect(Object.values(canonical.searchObservations).find(item=>item.decision!=='failed')?.supersedesObservationId).toBe(Object.values(canonical.searchObservations).find(item=>item.decision==='failed')?.id)
  expect(ResearchScientistMemory.project(events, 'minimize').failures).toEqual([])
  expect(Object.values((await new StorageResearchStore(options).read(project)).knowledgeCycles)).toHaveLength(0)
})

test('two Pi hosts atomically apply runtime and experiment eligibility without taking legacy jobs', async () => {
  const { options, store, project, experiment } = await fixture()
  const ownerA = new ResearchJobService.Service(store)
  const ownerB = new ResearchJobService.Service(new StorageResearchStore(options))
  const payload = { kind: 'autoresearch' as const, experimentId: experiment.id, sessionId: 'ses_host', iterations: 1, agent: 'biology' as const }
  const legacy = await ownerA.enqueue(project, { idempotencyKey: 'legacy', payload })
  await ownerA.enqueue(project, { idempotencyKey: 'pi:first', payload: { ...payload, runtime: 'autofold-pi.v1' } })
  await ownerA.enqueue(project, { idempotencyKey: 'pi:second', payload: { ...payload, runtime: 'autofold-pi.v1' } })
  const eligible: ResearchJobService.Eligibility = (candidate, state) => candidate.payload.runtime === 'autofold-pi.v1' && candidate.payload.kind === 'autoresearch' &&
    !Object.values(state.jobs).some(other => other.status === 'running' && other.payload.runtime === 'autofold-pi.v1' && other.payload.kind === 'autoresearch' && other.payload.experimentId === candidate.payload.experimentId)
  const claimed = await Promise.all([ownerA.claim(project, 5000, eligible), ownerB.claim(project, 5000, eligible)])
  expect(claimed.filter(Boolean)).toHaveLength(1)
  expect((await ownerA.get(project, legacy.id)).status).toBe('queued')
  expect(await ownerB.claim(project, 5000, eligible)).toBeUndefined()
  const running = claimed.find(Boolean)!
  await ownerA.succeed(project, running.id, running.leaseId!, {})
  expect(await ownerB.claim(project, 5000, eligible)).toBeDefined()
  expect((await ownerA.claim(project, 5000))?.id).toBe(legacy.id)
})

test('scientist kernel rejects escapes and symlink destinations against caller workspace', async () => {
  const { root } = await fixture()
  await expect(ResearchScientistKernel.read(root, '../outside.json')).rejects.toThrow('escapes the project')
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-kernel-outside-')); roots.push(outside)
  await fs.symlink(outside, path.join(root, 'linked'))
  await expect(ResearchScientistKernel.write(root, 'linked/state.json', {
    format: 'autofold.scientist-state.v2', experimentId: 'exp_kernel', contractHash: digest('a'), sessionId: 'ses_kernel', iteration: 1,
    mutableTrialPath: 'trial.py', memoryRevision: digest('b'), updatedAt: new Date().toISOString(), phase: 'authoring',
  })).rejects.toThrow('escapes the project')
  expect(await fs.readdir(outside)).toEqual([])
})

test('Pi host recovery reclaims its expired job and leaves expired legacy leases untouched', async () => {
  const { options, store, project, experiment } = await fixture()
  let milliseconds = Date.UTC(2026, 9, 3)
  const now = () => new Date(milliseconds).toISOString()
  const legacyOwner = new ResearchJobService.Service(store, { now })
  const piOwner = new ResearchJobService.Service(new StorageResearchStore(options), { now })
  const payload = { kind: 'autoresearch' as const, experimentId: experiment.id, sessionId: 'ses_recovery_host', iterations: 1, agent: 'biology' as const }
  const legacy = await legacyOwner.enqueue(project, { idempotencyKey: 'old-expired', payload })
  const originalLegacyLease = await legacyOwner.claim(project, 1000)
  const pi = await piOwner.enqueue(project, { idempotencyKey: 'pi-expired', payload: { ...payload, runtime: 'autofold-pi.v1' } })
  const recognized: ResearchJobService.Eligibility = job => job.payload.kind === 'autoresearch' && job.payload.runtime === 'autofold-pi.v1'
  const eligible: ResearchJobService.Eligibility = (job, state) => recognized(job, state) && !Object.values(state.jobs).some(other =>
    other.status === 'running' && recognized(other, state) && other.payload.experimentId === job.payload.experimentId)
  const claimedPi = await piOwner.claim(project, 1000, { eligible, recoverable: recognized })
  expect(claimedPi?.id).toBe(pi.id)
  await piOwner.checkpoint(project, pi.id, claimedPi!.leaseId!, 'host:lifecycle:start', {version:1,payloadHash:createHash('sha256').update(JSON.stringify(pi.payload)).digest('hex'),deadlineMs:milliseconds+60000})
  await piOwner.checkpoint(project, pi.id, claimedPi!.leaseId!, 'captured', { programHash: digest('c') })
  milliseconds += 2000
  const recovered = await piOwner.claim(project, 1000, { eligible, recoverable: recognized })
  expect(recovered?.id).toBe(pi.id)
  expect(recovered?.checkpoints.captured.data).toEqual({ programHash: digest('c') })
  expect((await legacyOwner.get(project, legacy.id))).toEqual(originalLegacyLease!)
  await piOwner.recover(project, recognized)
  expect((await legacyOwner.get(project, legacy.id))).toEqual(originalLegacyLease!)
  // Calls without host restrictions retain global recovery behavior.
  await legacyOwner.recover(project)
  expect((await legacyOwner.get(project, legacy.id)).status).toBe('failed')
})

test('trusted first closeout preserves a prospective plan with no evidence available before admission', async () => {
  const { root, project, service, campaign, experiment } = await fixture()
  const firstPlan = { ...plan, evidenceRefs: [] }
  const trial = await service.createTrial(project, experiment.id, { ...basic, decisionPlan: firstPlan })
  const run = await service.beginRun(project, trial.id, { bundlePath: 'bundle', outputPath: 'output' })
  await service.attachRunJob(project, run.id, 'compute-first')
  await service.completeRun(project, run.id, { contractHash: experiment.contractHash, evaluatorHash: experiment.contract.evaluator.sourceHash, valid: true, score: 0.2, diagnostics: {} }, digest('d'))
  const result = await ResearchTrajectoryCloseout.run({ campaignId: campaign.id, experimentId: experiment.id, sessionId: 'ses_first', iteration: 1,
    status: 'succeeded', trialId: trial.id, runId: run.id, decisionPlan: firstPlan,
  }, {commit:input=>service.recordTrajectoryObservation(project,input),acknowledge:(id,hash)=>service.acknowledgeTrajectoryProjection(project,id,hash),project:projection=>ResearchTrajectoryCloseout.projectJournalV2(projection,root)})
  expect(result).toMatchObject({ status: 'completed', trajectory: { decisionPlan: firstPlan } })
})
