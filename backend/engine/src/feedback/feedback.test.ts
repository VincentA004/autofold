import {afterEach, expect, test} from 'bun:test'
import {createAssistantMessageEventStream, type AssistantMessage} from '@earendil-works/pi-ai'
import {DEFAULT_MODEL} from '../runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ResearchSkills} from '@autofold/science-core/research-skills'
import {ResearchDomain} from '@autofold/science-core/domain'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchJobService} from '@autofold/science-core/job-service'
import {ResearchTrajectoryCloseout} from '@autofold/science-core/trajectory-closeout'
import {ScientificExecution} from '../execution'
import {PiJobController} from '../jobs'
import {CampaignController} from '../campaign'
import {CampaignPolicy, directActiveExperimentProposal, proceduralFeedbackProposal} from '../campaign/policy'
import {NativeFeedbackController, predictorDisagreement, reconcileSkillFeedback} from './index'
const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
const digest = (letter: string) => 'sha256:' + letter.repeat(64)
async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-feedback-')); roots.push(workspace)
  await fs.mkdir(path.join(workspace,'fixture'));for(const version of [1,2])await fs.writeFile(path.join(workspace,'fixture/SKILL-'+version+'.md'),fixtureGuide(version))
  const projectId = 'feedback_fixture', store = new StorageResearchStore({directory: path.join(workspace, 'research')})
  const research = new ResearchService.Service(store), base = new ScientificExecution({workspace, projectId, research}), jobs = new ResearchJobService.Service(store)
  const campaign = await research.createCampaign(projectId, {objective: 'Offline trusted feedback projection fixture'}); await research.activateCampaign(projectId, campaign.id)
  const evaluator = {...(await base.evaluators())[0]!, id: 'offline-scientific-receipt-fixture'}
  const contract: ResearchDomain.ExperimentContract = {version: 1, objective: 'Explicit offline normalized receipt fixture', targetArtifactHash: digest('a'), modality: 'short_peptide',
    budget: {maximumCandidates: 8, gpuHours: 0, wallTimeMinutes: 1}, evaluator: {...evaluator, fixedSeeds: [1, 7], submissionSize: 3}}
  const experiment = await research.createExperiment(projectId, campaign.id, {contract}); await research.activateExperiment(projectId, experiment.id)
  const receipts = new Map<string, Awaited<ReturnType<ScientificExecution['artifacts']>>>()
  const failureReceipts = new Map<string,string>()
  const execution = Object.assign(base, {artifacts: async (id: string) => {const receipt = receipts.get(id); if (!receipt) throw new Error('Fixture receipt unavailable'); return receipt},
    failureReceipt:async(id:string)=>{const receiptHash=failureReceipts.get(id);if(!receiptHash)throw new Error('Fixture failure receipt unavailable');return {receiptHash} as Awaited<ReturnType<ScientificExecution['failureReceipt']>>}})
  const feedback = new NativeFeedbackController({projectId, store, execution})
  async function job(native = true, experimentId = experiment.id) {
    const queued = await jobs.enqueue(projectId, {idempotencyKey: crypto.randomUUID(), payload: {kind: 'autoresearch', experimentId, sessionId: 'ses_feedback_' + crypto.randomUUID().replaceAll('-', ''), iterations: 10, agent: 'task', ...(native ? {runtime: 'autofold-pi.v1'} : {})}})
    return (await jobs.claim(projectId, 60000, candidate => candidate.id === queued.id))!
  }
  async function trajectory(owner: ResearchDomain.Job, iteration: number, fail = false, exp = experiment) {
    const native = owner.payload.runtime === 'autofold-pi.v1', origin = {jobId:owner.id,phase:'trial:' + iteration}
    // This core/feedback fixture supplies an admitted native search identity;
    // receipt normalization below replaces construction and worker execution.
    const trial = await research.createTrial(projectId, exp.id, {hypothesis: 'Trusted offline execution outcome', designAdapter: 'proto', executionProtocol: 'native_search_v1', programPath: 'fixture.py',
      programHash: digest(String(iteration)), origin:native ? origin : undefined}, native ? {jobId:owner.id,leaseId:owner.leaseId!} : undefined)
    // Legacy provenance is stored historical evidence, not a current Pi admission.
    if (!native) await store.mutate(projectId,state => {state.trials[trial.id]!.origin=origin})
    const run = await research.beginRun(projectId, trial.id, {bundlePath: 'fixture/bundle.json', outputPath: 'fixture/output'})
    await research.attachRunJob(projectId, run.id, 'fixture_worker_' + iteration)
    if (fail) {failureReceipts.set(run.id,digest('f'));await research.failRun(projectId, run.id, 'Frozen fixture generator allocation failed',undefined,{failureReceiptHash:digest('f'),iteration})}
    else await research.completeRun(projectId, run.id, {contractHash: exp.contractHash, evaluatorHash: exp.contract.evaluator.sourceHash, valid: true, score: iteration, diagnostics: {}}, digest('b'))
    const finalRun = await research.getRun(projectId, run.id), finalTrial = (await research.history(projectId, exp.id)).trials.find(item => item.id === trial.id)!
    const closeout = await ResearchTrajectoryCloseout.run({campaignId: exp.campaignId, experimentId: exp.id, sessionId: String(owner.payload.sessionId), iteration,
      trialId: trial.id, runId: run.id, status: fail ? 'run_failed' : 'succeeded', score: fail ? null : iteration, error: fail ? finalRun.error : undefined}, {
      commit:input=>research.recordTrajectoryObservation(projectId,input),project:async()=>{},acknowledge:(id,hash)=>research.acknowledgeTrajectoryProjection(projectId,id,hash),
    })
    expect(closeout.status).toBe('completed')
    const phase = 'scientist:evaluation:' + String(iteration).repeat(64)
    await jobs.checkpoint(projectId, owner.id, owner.leaseId!, phase + ':trial', {iteration, trialId: trial.id})
    await jobs.checkpoint(projectId, owner.id, owner.leaseId!, phase + ':closeout', closeout)
    if (!fail) receipts.set(run.id, {run: finalRun, trial: finalTrial, scientific: true, evidenceKind: 'scientific', candidates: {candidates: []},
      modelEvidence: [{candidateId: 'fixture_candidate', modelId: 'predictor_a', stage: 'boltz2-score', seed: 1, status: 'completed', parametersHash: digest('a'), metrics: {iptm: .2}},
        {candidateId: 'fixture_candidate', modelId: 'predictor_b', stage: 'chai1-score', seed: 1, status: 'completed', parametersHash: digest('a'), metrics: {iptm: .8}}],
      evidenceCompleteness: {status: 'partial_optional', totalDecisions: 3, completedDecisions: 2, skippedOptionalDecisions: 1,
        requiredDecisions: 2, completedRequiredDecisions: 2, skippedStages: ['optional_fixture']}} as unknown as Awaited<ReturnType<ScientificExecution['artifacts']>>)
    return {trial: finalTrial, run: finalRun, closeout}
  }
  const piJobs = new PiJobController({workspace, projectId, store, research, execution, sessionDirectory: path.join(workspace, 'pi'), runtimeOptions: {getApiKey: () => 'offline-fixture-only', streamFn: () => {throw new Error('Offline fixture forbids model/network inference')}}})
  const controller = new CampaignController({workspace, projectId, store, research, execution, sessionDirectory: path.join(workspace, 'pi'), jobs: piJobs})
  return {workspace, projectId, store, research, campaign, experiment, contract, jobs, job, trajectory, receipts, execution, feedback, controller}
}
function fixtureGuide(version:number){return `---
id: skill_bionemo.predictor-interpretation
version: ${version}
title: Offline procedural feedback fixture
capabilities: [evidence_reasoning]
applies_to: []
source:
  repository: offline-fixture
  commit: original
  paths: [fixture]
  license: fixture
  attribution: Controlled engineering fixture, not scientific guidance
---
## Guidance
Compare exact matched measurements without upgrading biological confidence.
## Failure modes
An incomplete receipt does not establish a method advantage.
## Falsifying questions
Would independent matched evidence reverse the interpretation?
`}
function skill(campaignId: string, id = 'skv_parent', status: ResearchDomain.SkillVersion['status'] = 'active', refs: string[] = []): ResearchDomain.SkillVersion {
  return ResearchDomain.SkillVersion.parse({id, campaignId, skillId: 'skill_bionemo.predictor-interpretation', version: id === 'skv_parent' ? 1 : 2,
    path: 'fixture/SKILL-'+(id==='skv_parent'?1:2)+'.md', contentHash: ResearchSkills.parseMarkdown(fixtureGuide(id==='skv_parent'?1:2)).contentHash, capabilities: ['evidence_reasoning'], appliesToToolKeys: [], status,
    source: id === 'skv_parent' ? 'bundled' : 'campaign_refinement', trajectoryRefs: refs, createdBy: 'trusted-fixture', createdAt: new Date().toISOString()})
}

test('actual trusted core closeouts produce scoped feedback, native durable checkpoints and identical reopen projection', async () => {
  const f = await fixture(), owner = await f.job(), first = await f.trajectory(owner, 1), second = await f.trajectory(owner, 2)
  const projection = await f.feedback.collect(f.campaign.id)
  expect(projection.records).toHaveLength(2); expect(projection.recentAuthoringAttempts).toHaveLength(2)
  expect(projection.recentSkillFeedback.filter(item => item.trigger === 'predictor_disagreement')).toHaveLength(2)
  expect(projection.recentSkillFeedback.every(item => item.trajectoryRefs.some(ref => ref.startsWith('sobs_')))).toBe(true)
  expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(0)
  const origin = {jobId: owner.id, leaseId: owner.leaseId!}
  expect((await f.feedback.recordRun(origin, first.run.id))?.runId).toBe(first.run.id)
  expect(Object.keys((await f.store.read(f.projectId)).jobs[owner.id]!.checkpoints).filter(key => key.startsWith('native:feedback:'))).toHaveLength(1)
  await f.feedback.persist(origin, f.campaign.id, projection.records)
  await f.feedback.persist(origin, f.campaign.id, projection.records)
  const stored = await f.store.read(f.projectId), checkpointKeys = Object.keys(stored.jobs[owner.id]!.checkpoints).filter(key => key.startsWith('native:feedback:'))
  expect(checkpointKeys).toHaveLength(2)
  const reopened = new NativeFeedbackController({...f, store: new StorageResearchStore({directory: path.join(f.workspace, 'research')})})
  expect(await reopened.collect(f.campaign.id)).toEqual(projection)
  expect((await f.controller.observe(f.campaign.id)).recentSkillFeedback).toEqual(projection.recentSkillFeedback)
  expect(new Set(projection.records.map(record => record.runId))).toEqual(new Set([first.run.id, second.run.id]))
})

test('legacy jobs, cross-campaign trajectories, missing native closeouts and unavailable successful receipts are excluded', async () => {
  const f = await fixture(), legacy = await f.job(false); await f.trajectory(legacy, 1)
  const other = await f.research.createCampaign(f.projectId, {objective: 'Foreign campaign fixture'})
  await f.research.activateCampaign(f.projectId, other.id)
  const experiment = await f.research.createExperiment(f.projectId, other.id, {contract: f.contract}); await f.research.activateExperiment(f.projectId, experiment.id)
  const foreign = await f.job(true, experiment.id); await f.trajectory(foreign, 2, false, experiment)
  const native = await f.job(), current = await f.trajectory(native, 3)
  f.receipts.delete(current.run.id)
  expect((await f.feedback.collect(f.campaign.id)).records).toHaveLength(0)
  expect((await f.feedback.collect(f.campaign.id)).recentSkillFeedback).toHaveLength(0)
})

test('authoritative failed native runs produce workflow feedback; model-authored checkpoint feedback is ignored', async () => {
  const f = await fixture(), owner = await f.job(), failed = await f.trajectory(owner, 1, true)
  await f.jobs.checkpoint(f.projectId, owner.id, owner.leaseId!, 'model:feedback', {skillFeedback: [{trigger: 'predictor_disagreement', rationale: 'Invented by a model', trajectoryRefs: ['run_foreign']}]})
  const projection = await f.feedback.collect(f.campaign.id)
  expect(projection.recentSkillFeedback).toHaveLength(1)
  expect(projection.recentSkillFeedback[0]).toMatchObject({trigger: 'run_failure', skillId: 'skill_bionemo.binder-workflow-strategy'})
  expect(projection.recentSkillFeedback[0]!.trajectoryRefs).toContain(failed.run.id)
})

test('fenced authoring failures persist idempotently, repaired attempts reconcile, and cancelled ancestors cannot append', async () => {
  const f = await fixture(), owner = await f.job(), origin = {jobId: owner.id, leaseId: owner.leaseId!}
  const attempt = {experimentId: f.experiment.id, iteration: 1, attempt: 1, status: 'failed' as const, programFingerprint: digest('c'), error: 'Actual native parser error'}
  const first = await f.feedback.recordAuthoring(origin, attempt)
  expect(await f.feedback.recordAuthoring(origin, attempt)).toEqual(first)
  expect((await f.feedback.collect(f.campaign.id)).recentSkillFeedback[0]).toMatchObject({trigger: 'authoring_failure', programFingerprint: digest('c')})
  await f.feedback.recordAuthoring(origin, {...attempt, attempt: 2, status: 'ready', error: undefined, programFingerprint: digest('d')})
  expect((await f.feedback.collect(f.campaign.id)).recentSkillFeedback).toHaveLength(0)
  await f.store.mutate(f.projectId, state => {state.jobs[owner.id]!.payload.parentJobId = 'job_cancelled_parent'; state.jobs.job_cancelled_parent = ResearchDomain.Job.parse({
    ...owner, id: 'job_cancelled_parent', payload: {kind: 'campaign_loop', campaignId: f.campaign.id, maxSteps: 1, sessionId: 'ses_cancelled_parent', agent: 'task', runtime: 'autofold-pi.v1'}, status: 'cancelled'})})
  await expect(f.feedback.recordAuthoring(origin, {...attempt, attempt: 3})).rejects.toThrow('ancestor fence')
  await expect(f.feedback.persist(origin, f.campaign.id, [])).rejects.toThrow('ancestor fence')
  await expect(f.feedback.recordAuthoring({...origin, leaseId: 'stale-owner'}, {...attempt, attempt: 3})).rejects.toThrow('fence')
  expect(Object.keys((await f.store.read(f.projectId)).jobs[owner.id]!.checkpoints).filter(key => key.startsWith('scientist:authoring'))).toHaveLength(2)
})

test('optional gaps reconcile only the exact verified run and refinements cannot match by shared experiment alone', async () => {
  const f = await fixture(), owner = await f.job(), first = await f.trajectory(owner, 1), second = await f.trajectory(owner, 2)
  const projection = await f.feedback.collect(f.campaign.id)
  const recovered = projection.trajectories.map(item => item.run?.id === first.run.id ? {...item, evidenceCompleteness: {...item.evidenceCompleteness!, status: 'complete' as const}} : item)
  const unrelated = skill(f.campaign.id, 'skv_unrelated', 'candidate', [f.experiment.id])
  const candidate = skill(f.campaign.id, 'skv_candidate', 'candidate', [first.trial.id, first.run.id])
  const foreign = skill('cmp_other', 'skv_foreign', 'candidate', [second.run.id])
  const reconciled = reconcileSkillFeedback(projection.recentSkillFeedback, recovered, [unrelated, candidate, foreign], f.campaign.id)
  expect(reconciled.filter(item => item.trigger === 'optional_evidence_gap')).toHaveLength(1)
  expect(reconciled.find(item => item.trajectoryRefs.includes(second.run.id))?.refinement).toBeUndefined()
  expect(reconciled.find(item => item.trajectoryRefs.includes(first.run.id))?.refinement?.versionId).toBe(candidate.id)
})

test('repeated distinct same-trigger native signals select refinement then existing chain, evaluated signals do not repeat replay', async () => {
  const f = await fixture(), owner = await f.job(), first = await f.trajectory(owner, 1), second = await f.trajectory(owner, 2)
  await f.store.mutate(f.projectId, state => {state.skillVersions.skv_parent = skill(f.campaign.id)})
  const observation = await f.controller.observe(f.campaign.id)
  observation.knowledge.due = false; observation.knowledge.reasons = []; observation.activeJobs = []
  expect(proceduralFeedbackProposal({...observation, recentSkillFeedback: observation.recentSkillFeedback.filter(item => item.trajectoryRefs.includes(first.run.id))})).toBeUndefined()
  expect(directActiveExperimentProposal(observation, 12, undefined, true, {maximumDiscoveryTrajectories: 6, reservedReplayTrajectories: 6})?.kind).toBe('iterate_experiment')
  expect(directActiveExperimentProposal(observation, 6, undefined, true, {maximumDiscoveryTrajectories: 0, reservedReplayTrajectories: 6})?.kind).toBe('refine_skill')
  const mixed = observation.recentSkillFeedback.filter(item => item.trigger === 'optional_evidence_gap' && item.trajectoryRefs.includes(first.run.id) || item.trigger === 'predictor_disagreement' && item.trajectoryRefs.includes(second.run.id))
  expect(proceduralFeedbackProposal({...observation, recentSkillFeedback: mixed})).toBeUndefined()
  const candidate = skill(f.campaign.id, 'skv_candidate', 'candidate', [first.run.id, second.run.id])
  observation.skills.recentRefinements = [candidate]
  expect(directActiveExperimentProposal(observation, 6, undefined, true, {maximumDiscoveryTrajectories: 0, reservedReplayTrajectories: 6})).toMatchObject({kind: 'replay_skill', candidateVersionId: candidate.id, repetitions: 3})
  candidate.status = 'active'
  observation.recentSkillFeedback = reconcileSkillFeedback(observation.recentSkillFeedback, observation.recentTrajectories, [candidate], f.campaign.id)
  expect(proceduralFeedbackProposal(observation)).toBeUndefined()
  const repeated = CampaignPolicy.Move.parse({kind: 'refine_skill', skillId: candidate.skillId, experimentId: f.experiment.id, trajectoryRefs: [first.run.id, second.run.id], rationale: 'Repeat evaluated work', expectedInformationGain: 'Unknown'})
  expect(CampaignPolicy.compile(observation, repeated)).toMatchObject({status: 'rejected'})
})

test('cross-predictor signal averages seeds per model and ignores skipped, nonfinite and unnormalized confidence', () => {
  const metric = (modelId: string, value: number) => ({candidateId: 'candidate', modelId, status: 'completed' as const, seed:1, metrics: {iptm: value}})
  expect(predictorDisagreement([metric('same', .1), metric('same', .9)])).toBeUndefined()
  expect(predictorDisagreement([metric('a', .1), metric('a', .9), metric('b', .5)])).toBeUndefined()
  expect(predictorDisagreement([metric('a', .2), metric('b', .8)])?.confidenceRange).toBeCloseTo(.6)
  expect(predictorDisagreement([metric('a', NaN), metric('b', 70), {candidateId: 'candidate', modelId: 'c', status: 'skipped'}])).toBeUndefined()
})


test('campaign persists trusted procedural feedback before a bounded stop decision without model inference', async () => {
  const f = await fixture(), owner = await f.job(); await f.trajectory(owner, 1)
  await f.jobs.succeed(f.projectId, owner.id, owner.leaseId!, {})
  await f.research.campaignResearchState(f.projectId, f.campaign.id)
  await f.store.mutate(f.projectId, state => {state.campaignCharters[f.campaign.id]!.constraints.maximumCampaignTrials = 1})
  const controller = f.controller, piJobs = controller.options.jobs
  piJobs.registerHandler('campaign_loop', controller.handleJob)
  const parent = await controller.enqueueCampaign(f.campaign.id, {idempotencyKey: 'feedback-only-boundary', maxSteps: 1, maximumKnowledgeRefreshes: 0})
  const completed = await piJobs.runOnce({jobId: parent.id})
  expect(completed?.status).toBe('succeeded')
  expect(completed?.result).toMatchObject({status: 'stopped', boundary: 'campaign_stop'})
  const checkpoints = (await f.store.read(f.projectId)).jobs[parent.id]!.checkpoints
  expect(Object.keys(checkpoints).filter(key => key.startsWith('native:feedback:'))).toHaveLength(1)
  expect(checkpoints['campaign:step:1:observation']?.data.recentSkillFeedback).toHaveLength(2)
  expect(await piJobs.runOnce({jobId: parent.id})).toBeUndefined()
})

test('feedback checkpoint refuses cross-scope references and expired exact leases atomically', async () => {
  const f = await fixture(), owner = await f.job(); await f.trajectory(owner, 1)
  const projection = await f.feedback.collect(f.campaign.id), record = projection.records[0]!
  await expect(f.feedback.persist({jobId: owner.id, leaseId: owner.leaseId!}, f.campaign.id, [{...record,
    feedback: record.feedback.map(item => ({...item, trajectoryRefs: [...item.trajectoryRefs, 'run_foreign']}))}])).rejects.toThrow('Native procedural feedback')
  expect(Object.keys((await f.store.read(f.projectId)).jobs[owner.id]!.checkpoints).some(key => key.startsWith('native:feedback:'))).toBe(false)
  await f.store.mutate(f.projectId, state => {state.jobs[owner.id]!.leaseExpiresAt = new Date(Date.now() - 1).toISOString()})
  await expect(f.feedback.persist({jobId: owner.id, leaseId: owner.leaseId!}, f.campaign.id, projection.records)).rejects.toThrow('fence')
})


test('real Boltz2/Chai stage labels expose five recorded matched-seed contrasts without inventing evidence', () => {
  const values = [[.9118597507476807,.4316297173500061],[.9348639845848083,.7668836116790771],
    [.9248403310775757,.3898765444755554],[.5959503054618835,.4114203453063965],
    [.8032068014144897,.6819266080856323],[.8032324314117432,.348784863948822]]
  const contrast = (left:number,right:number,seed=20260809) => predictorDisagreement([
    {candidateId:'same_candidate',modelId:'boltz2-prediction',stage:'boltz2-score',seed:20260809,status:'completed',metrics:{iptm:left,protein_iptm:left}},
    {candidateId:'same_candidate',modelId:'chai1-prediction',stage:'chai1-score',seed,status:'completed',metrics:{iptm:right}},
  ])
  expect(values.map(([a,b]) => !!contrast(a!,b!))).toEqual([true,true,true,true,false,true])
  expect(predictorDisagreement([
    {candidateId:'a',modelId:'one',seed:1,status:'completed',metrics:{iptm:.2,protein_iptm:.3}},
    {candidateId:'a',modelId:'two',seed:1,status:'completed',metrics:{iptm:.8}},
  ])).toBeUndefined()
  expect(contrast(.8,.2,3)).toBeUndefined() // Unmatched seeds cannot form a comparison.
  expect(predictorDisagreement([
    {candidateId:'a',modelId:'one',stage:'first',seed:1,status:'completed',metrics:{iptm:.2}},
    {candidateId:'a',modelId:'one',stage:'duplicate',seed:1,status:'completed',metrics:{iptm:.3}},
    {candidateId:'a',modelId:'two',stage:'other',seed:1,status:'completed',metrics:{iptm:.8}},
  ])).toBeUndefined() // Ambiguous repeated model/seed remains fenced, across stages too.
  expect(predictorDisagreement([
    {candidateId:'a',modelId:'one',stage:'first',seed:1,status:'completed',metrics:{iptm:.2}},
    {candidateId:'b',modelId:'two',stage:'other',seed:1,status:'completed',metrics:{iptm:.8}},
  ])).toBeUndefined()
})

test('successful complete trajectories get a native Pi refinement assessment even without automatic problem signals', async () => {
  const f=await fixture(),owner=await f.job(),first=await f.trajectory(owner,1),second=await f.trajectory(owner,2)
  await f.jobs.succeed(f.projectId,owner.id,owner.leaseId!,{})
  for (const receipt of f.receipts.values()) {
    const model=receipt.modelEvidence[1]!
    if(model.status!=='completed')throw new Error('Expected completed predictor fixture')
    model.metrics={iptm:.25}
    receipt.evidenceCompleteness={...receipt.evidenceCompleteness!,status:'complete',skippedOptionalDecisions:0,skippedStages:[]}
  }
  await f.store.mutate(f.projectId,state=>{state.skillVersions.skv_parent=skill(f.campaign.id)})
  const observation=await f.controller.observe(f.campaign.id)
  expect(observation.recentSkillFeedback).toEqual([])
  expect(directActiveExperimentProposal(observation,8,f.experiment.id,false,{maximumDiscoveryTrajectories:2,reservedReplayTrajectories:6})).toMatchObject({kind:'iterate_experiment'})
  expect(directActiveExperimentProposal(observation,6,f.experiment.id,false,{maximumDiscoveryTrajectories:0,reservedReplayTrajectories:6})).toBeUndefined()
  expect(directActiveExperimentProposal(observation,8,f.experiment.id,false,{maximumDiscoveryTrajectories:2,reservedReplayTrajectories:6,assistanceDue:true})).toBeUndefined()
  expect(directActiveExperimentProposal(observation,5,f.experiment.id,false,{maximumDiscoveryTrajectories:0,reservedReplayTrajectories:5})).toMatchObject({kind:'stop'})
  const pending=skill(f.campaign.id,'skv_pending','candidate',[first.run.id,second.run.id])
  expect(proceduralFeedbackProposal({...observation,skills:{...observation.skills,recentRefinements:[pending]}},f.experiment.id)).toMatchObject({kind:'replay_skill',candidateVersionId:pending.id})
  let calls=0
  const controller=new CampaignController({...f.controller.options,runtimeOptions:{streamFn:(_model,context)=>{
    calls++
    const prompt=context.messages.findLast(message=>message.role==='user')!
    const text=typeof prompt.content==='string'?prompt.content:prompt.content.filter(part=>part.type==='text').map(part=>part.text).join('')
    const packet=JSON.parse(text.slice(text.indexOf('{')))
    expect(packet.authorization).toMatchObject({remainingTrajectories:6,remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6,ordinaryIterations:0,pairedReplayRepetitions:3})
    expect(packet.observation.recentSkillFeedback).toEqual([])
    const value:AssistantMessage={role:'assistant',content:[{type:'toolCall',id:'assessment',name:'submit_move',arguments:{kind:'stop',reason:'no_testable_refinement',rationale:'Successful measurements provide no concrete testable guidance change in this offline fixture.',unresolvedQuestions:[]}}],
      api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
    const out=createAssistantMessageEventStream();out.push({type:'start',partial:value});out.push({type:'done',reason:'toolUse',message:value});out.end(value);return out
  }}})
  const jobs=controller.options.jobs;jobs.registerHandler('campaign_loop',controller.handleJob)
  const parent=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'success-assessment',maxSteps:1,maximumTrajectories:6,maximumDiscoveryTrajectories:0,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:0})
  const completed=await jobs.runOnce({jobId:parent.id})
  expect(completed?.result).toMatchObject({status:'stopped',remainingTrajectories:6,remainingReservedReplayTrajectories:6,steps:[{result:{authority:'scientist_interpretation'}}]})
  expect(completed?.result?.stopExplanation).toMatchObject({authority:'scientist_interpretation',reason:'no_testable_refinement',refinementAssessed:true,remainingReservedReplayTrajectories:6,unusedReplayReason:'assessment_found_no_testable_refinement'})
  expect(calls).toBe(1)
  expect(completed?.checkpoints['campaign:step:1:proposal']?.data.source).toBe('boundary_scientist')
  expect((await jobs.list()).filter(job=>job.payload.parentJobId===parent.id)).toHaveLength(0)
})


test('verified receipts and scoped scientist reviews reach refinement once and remain frozen on reopen',async()=>{
 const {CampaignSkillService}=await import('../skills/service'),{CapabilityRefinementController}=await import('../skills/controllers')
 const f=await fixture(),owner=await f.job(),one=await f.trajectory(owner,1),two=await f.trajectory(owner,2)
 await f.jobs.succeed(f.projectId,owner.id,owner.leaseId!,{})
 const reviewInput={runId:one.run.id,expectedRevision:0,finding:'The tested draw did not establish a method improvement.',interpretation:'A descriptive predictor contrast requires independent confirmation.',predictionAssessment:'unresolved' as const,
  remainingExplanations:['Uncontrolled generator variation remains.'],limitations:['No assay evidence.'],nextDecision:'Use matched independent controls before changing procedural guidance.',evidenceRefs:[one.run.id,one.trial.id]}
 const review=await f.research.recordScientistReview(f.projectId,f.experiment.id,reviewInput,{})
 const observation=await f.controller.observe(f.campaign.id)
 expect(observation.decisionMemory!.flatMap((packet:any)=>packet.interpretations)).toMatchObject([{id:review.id,runId:one.run.id,nextDecision:reviewInput.nextDecision,epistemicStatus:'attributed_interpretation'}])
 const skills=new CampaignSkillService(f),parent=(await skills.initialize(f.campaign.id)).find(s=>s.skillId==='skill_bionemo.predictor-interpretation')!
 const markdown=(await fs.readFile(path.join(f.workspace,parent.path),'utf8')).replace('version: 1','version: 2')+'\nReport matched independent controls before interpreting a predictor contrast.\n'
 let calls=0
 const refiner=new CapabilityRefinementController({...f,sessionDirectory:f.controller.options.sessionDirectory,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:(_model,context)=>{
  calls++
  const user=context.messages.findLast(m=>m.role==='user') as any,packet=JSON.parse(typeof user.content==='string'?user.content:user.content[0].text)
  const evidence=packet.context.proceduralEvidence
  expect(evidence.decisionMemory).toHaveLength(1);expect(evidence.decisionMemory[0].facts).toHaveLength(1);expect(evidence.decisionMemory[0].facts[0].runId).toBe(one.run.id)
  expect(evidence.decisionMemory[0].facts[0].rawModelEvidence.rows.map((m:any)=>m.stage)).toEqual(['boltz2-score','chai1-score'])
  expect(evidence.hostFeedback.some((item:any)=>item.trigger==='predictor_disagreement')).toBe(true)
  expect(evidence.decisionMemory[0].interpretations).toMatchObject([{nextDecision:reviewInput.nextDecision}])
  expect(JSON.stringify(evidence)).not.toContain(two.run.id)
  const message:AssistantMessage={role:'assistant',content:[{type:'toolCall',id:'scoped-refinement',name:'submit_skill',arguments:{markdown}}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
  const out=createAssistantMessageEventStream();out.push({type:'start',partial:message});out.push({type:'done',reason:'toolUse',message});out.end(message);return out
 }}})
 const input={campaignId:f.campaign.id,skillId:parent.skillId,trajectoryRefs:[one.run.id,one.trial.id],operationId:'review-handoff'}
 const candidate=await refiner.run(input)
 await f.research.recordScientistReview(f.projectId,f.experiment.id,{...reviewInput,expectedRevision:1,nextDecision:'Later interpretation must not rewrite admitted refinement context.'},{})
 const reopened=await refiner.run(input);expect(reopened.id).toBe(candidate.id);expect(calls).toBe(1)
 const key=new Bun.CryptoHasher('sha256').update(f.projectId+':refinement:review-handoff').digest('hex')
 const saved=JSON.parse(await fs.readFile(path.join(f.workspace,'.autofold/skills/operations',key,'state.json'),'utf8'))
 expect(saved.context.proceduralEvidence.decisionMemory[0].interpretations.find((item:any)=>item.id===review.id).reviewRevision).toBe(1)
})
