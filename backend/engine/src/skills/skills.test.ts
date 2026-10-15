import { ResearchJobService } from "@autofold/science-core/job-service"
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { StorageResearchStore } from '@autofold/science-core/store'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchSkills } from '@autofold/science-core/research-skills'
import { ScientificExecution, LocalWorkerTransport } from '../execution'
import { DEFAULT_MODEL, SqliteSessionStore } from '../runtime'
import { PiJobController } from '../jobs'
import { ScientistLane } from '../scientist'
import { CampaignSkillService, CapabilityRefinementController, SkillShadowReplayController, aggregate, replayPassed } from './index'
const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
const message = (content: AssistantMessage['content'], reason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage => ({role: 'assistant', content, api: DEFAULT_MODEL.api, provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.id, timestamp: Date.now(), stopReason: reason,
  usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}})
const call = (id: string, name: string, args: any): ToolCall => ({type: 'toolCall', id, name, arguments: args})
function scripted(values: AssistantMessage[], inspect?: (context: any, index: number) => void): StreamFn {let index = 0; return (_model, context) => {
  inspect?.(context, index); const value = values[index++]; if (!value) throw new Error('Unexpected fixture model call')
  const stream = createAssistantMessageEventStream(); stream.push({type: 'start', partial: value}); stream.push({type: 'done', reason: value.stopReason as 'stop'|'toolUse', message: value}); stream.end(value); return stream
}}
async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-skill-replay-')); roots.push(workspace)
  const projectId = 'skills_offline', store = new StorageResearchStore({directory: path.join(workspace, 'research')}), research = new ResearchService.Service(store)
  const local = new LocalWorkerTransport(); let dispatches = 0
  const execution = new ScientificExecution({workspace, projectId, research, inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, transport: {kind: 'local', dispatch: async input => {dispatches++; return local.dispatch(input)}}})
  const evaluator = (await execution.evaluators())[0]!
  const campaign = await research.createCampaign(projectId, {objective: 'Offline paired skill validation'}); await research.activateCampaign(projectId, campaign.id)
  const contract = {version: 1 as const, objective: 'Deterministic plumbing only', targetArtifactHash: 'sha256:' + 'a'.repeat(64), modality: 'short_peptide' as const,
    budget: {maximumCandidates: 6, gpuHours: 0, wallTimeMinutes: 1}, evaluator: {...evaluator, fixedSeeds: [1, 7], submissionSize: 3}}
  const experiment = await research.createExperiment(projectId, campaign.id, {contract}); await research.activateExperiment(projectId, experiment.id)
  const options = {workspace, projectId, store, research, execution, sessionDirectory: path.join(workspace, 'pi'), allowMockPrograms: true}
  const skills = new CampaignSkillService({...options, allowPlumbingOnly: true}), bundled = await skills.initialize(campaign.id)
  const parent = bundled.find(value => value.skillId === 'skill_bionemo.predictor-interpretation')!
  const parentMarkdown = await fs.readFile(path.join(workspace, parent.path), 'utf8')
  const markdown = parentMarkdown.replace('version: 1', 'version: 2') + '\nFrozen computational evidence requires target-matched counterfactual checks.\n'
  return {...options, skills, bundled, campaign, experiment, parent, parentMarkdown, markdown, contract, dispatches: () => dispatches}
}
/** Select fixture byte strings using the actual trusted pure worker, then evaluate each through its real receipt pipeline. */
async function pairedPrograms(): Promise<string[]> {
  const worker = path.resolve(import.meta.dir, '../../../worker')
  const code = `import json,hashlib\nfrom autofold_worker.design import generate\nfrom autofold_worker.evaluate import evaluate\nvalues=[]\nfor i in range(100):\n p='"""Plumbing-only independent shadow program '+str(i)+'"""\\n'\n b={'runId':'fixture','trialId':'fixture','contractHash':'fixture','evaluator':{'sourceHash':'fixture'},'designAdapter':'mock','programHash':'sha256:'+hashlib.sha256(p.encode()).hexdigest(),'seeds':[1,7],'modality':'short_peptide','candidateBudget':6,'submissionSize':3}\n values.append((evaluate(b,generate(b))['score'],p))\nvalues.sort()\nprint(json.dumps([values[-1][1],values[0][1],values[-2][1],values[1][1],values[-3][1],values[2][1]]))`
  const child = Bun.spawn(['python3', '-c', code], {cwd: worker, stdout: 'pipe', stderr: 'pipe'})
  const [exit, text] = await Promise.all([child.exited, new Response(child.stdout).text()]); if(exit) throw new Error(await new Response(child.stderr).text()); return JSON.parse(text)
}

test('portable skill versions preserve attributed files, idempotent origin, confined paths and exact scientist context', async () => {
  const f = await fixture()
  expect(f.bundled).toHaveLength(5)
  const input = {parentVersionId: f.parent.id, markdown: f.markdown, trajectoryRefs: [f.experiment.id], createdBy: 'fixture', origin: {jobId: 'job_refinement', phase: 'proposal'}}
  const proposed = await f.skills.propose(f.campaign.id, f.parent.skillId, input)
  expect((await f.skills.propose(f.campaign.id, f.parent.skillId, input)).id).toBe(proposed.id)
  await expect(f.skills.propose(f.campaign.id, f.parent.skillId, {...input, trajectoryRefs: [f.campaign.id]})).rejects.toMatchObject({data: {code: 'skill_origin_conflict'}})
  const lane = new ScientistLane({...f, experimentId: f.experiment.id, sessionId: 'ses_fixture_scientist', maximumEvaluations: 0})
  const context = await lane.context()
  expect(context.decisionMemory.proceduralGuidance).toHaveLength(5)
  expect(context.decisionMemory.proceduralGuidance.find(value => value.skillId === f.parent.skillId)?.versionId).toBe(f.parent.id)
  await fs.writeFile(path.join(f.workspace, f.parent.path), f.parentMarkdown + '\nTampered guidance\n')
  await expect(lane.context()).rejects.toMatchObject({data: {code: 'skill_integrity_mismatch'}})
  await fs.rm(path.join(f.workspace, '.autofold/campaigns'), {recursive: true})
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-outside-skills-')); roots.push(outside)
  await fs.symlink(outside, path.join(f.workspace, '.autofold/campaigns'))
  await expect(f.skills.loadVersion(f.campaign.id, f.parent.id)).rejects.toThrow('symbolic link')
})

test('Pi refinement freezes evidence and attribution, reopens a saved proposal without model calls', async () => {
  const f = await fixture(), input = {campaignId: f.campaign.id, skillId: f.parent.skillId, trajectoryRefs: [f.experiment.id], operationId: 'refine-one'}
  let calls = 0
  const controller = new CapabilityRefinementController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: scripted([message([call('submit', 'submit_skill', {markdown: f.markdown})])], context => {calls++; expect(JSON.stringify(context)).toContain(f.experiment.id)})}})
  const candidate = await controller.run(input)
  expect(candidate.status).toBe('candidate'); expect(candidate.trajectoryRefs).toEqual([f.experiment.id]); expect(calls).toBe(1)
  const restored = new CapabilityRefinementController({...f, store: new StorageResearchStore({directory: path.join(f.workspace, 'research')}), runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: () => {throw new Error('No extra inference')}}})
  expect((await restored.run(input)).id).toBe(candidate.id)
  await expect(restored.run({...input, trajectoryRefs: [f.campaign.id]})).rejects.toThrow('Original operation identity cannot change')
  const another = await f.research.createCampaign(f.projectId, {objective: 'Outside evidence'})
  await expect(controller.run({...input, operationId: 'invalid-scope', trajectoryRefs: [another.id]})).rejects.toThrow('outside_campaign')
  const unsafe = f.markdown.replace('attribution:', 'attribution:') + '\ncurl remote endpoint\n'
  await expect(new CapabilityRefinementController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: scripted([message([call('bad', 'submit_skill', {markdown: unsafe})]), message([{type: 'text', text: 'Rejected'}], 'stop')])}}).run({...input, operationId: 'unsafe-guidance'})).rejects.toThrow('without an accepted')
  expect((await f.skills.list(f.campaign.id)).filter(value => value.status === 'candidate')).toHaveLength(1)
})

test('three real paired workers use independent programs/sessions, activate deterministically, never promote incumbent and reopen with no inference', async () => {
  const f = await fixture(), candidate = await f.skills.propose(f.campaign.id, f.parent.skillId, {parentVersionId: f.parent.id, markdown: f.markdown, trajectoryRefs: [f.experiment.id], createdBy: 'fixture'})
  const programs = await pairedPrograms(); let calls = 0
  const contents=[ResearchSkills.parseMarkdown(f.parentMarkdown).content,ResearchSkills.parseMarkdown(f.markdown).content]
  const values = programs.map((program, i) => message([call('write'+i,'write',{path:'trial.py',content:program}),call('arm' + i, 'submit_trial', {hypothesis: 'Independent fixture arm ' + i,
    guidanceApplication:{guidanceQuote:contents[i%2]!.split('\n').find(line=>line.trim().length>=20)!.trim(),programDecision:'Apply supplied control guidance to this independently authored CPU fixture program.',falsifyingObservation:'Lack of repeated valid paired gains would reject this prospective procedural interpretation.'}})]))
  const replay = new SkillShadowReplayController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: scripted(values, (context, i) => {
    calls++; const user = JSON.parse(context.messages.findLast((item: any) => item.role === 'user').content[0].text)
    expect(user.skill.versionId).toBe(i % 2 ? candidate.id : f.parent.id)
    expect(user.decisionMemory.facts).toHaveLength(0);expect(user.decisionMemory.coverage.totalRecords).toBe(0);expect(user.decisionMemory.proceduralGuidance).toEqual([]);expect(user).not.toHaveProperty('history')
    expect(user).not.toHaveProperty(i % 2 ? 'parent' : 'candidate')
  })}})
  const input = {campaignId: f.campaign.id, experimentId: f.experiment.id, candidateVersionId: candidate.id, operationId: 'six-independent-arms', repetitions: 3}
  const result = await replay.run(input)
  expect(result.pairs).toHaveLength(3); expect(calls).toBe(6); expect(f.dispatches()).toBe(6)
  expect(result.guidanceApplications).toHaveLength(6)
  for(const [i,trace] of result.guidanceApplications.entries()){expect(trace.application?.skill.versionId).toBe(i%2?candidate.id:f.parent.id);expect(trace.application?.programHash).toMatch(/^sha256:/);expect(trace.authority).toBe('prospective_scientist_interpretation')}
  expect(result.capabilityEvidence).toHaveLength(18)
  for(const trace of result.capabilityEvidence){
    const application=result.guidanceApplications.find(value=>value.arm===trace.arm)!
    expect(trace).toMatchObject({skill:{versionId:application.application!.skill.versionId,contentHash:application.application!.skill.contentHash},runId:application.runId,
      programHash:application.application!.programHash,status:'needs_independent_review',score:null,authority:'descriptive_guidance_trace_only',
      application:{guidanceQuote:application.application!.guidanceQuote,programDecision:application.application!.programDecision,falsifyingObservation:application.application!.falsifyingObservation}})
  }
  expect(result.validation!.passed).toBe(true); expect(result.finalStatus).toBe('active')
  expect(result.validation!.candidate.lockedObjectiveUtility).toBeGreaterThan(result.validation!.baseline.lockedObjectiveUtility!)
  const state = await f.store.read(f.projectId), trials = Object.values(state.trials)
  expect(trials).toHaveLength(6); expect(new Set(trials.map(trial => trial.programHash)).size).toBe(6)
  expect(trials.every(trial => trial.intent === 'shadow_replay' && trial.skills.length === 1)).toBe(true)
  expect(trials.every(trial=>Number.isInteger(trial.generationSeed))).toBe(true)
  expect(new Set(trials.map(trial=>trial.generationSeed)).size).toBe(6)
  for(let pair=0;pair<3;pair++)expect(trials[pair*2]!.generationSeed).not.toBe(trials[pair*2+1]!.generationSeed)
  expect(state.experiments[f.experiment.id]?.incumbentTrialId).toBeUndefined()
  expect(state.skillVersions[f.parent.id]?.status).toBe('superseded')
  const followup=new ScientistLane({...f,experimentId:f.experiment.id,sessionId:'ses_after_activation',maximumEvaluations:0})
  const context=await followup.context()
  expect(context.decisionMemory.proceduralGuidance.find(v=>v.skillId===f.parent.skillId)?.versionId).toBe(candidate.id)
  expect(context.decisionMemory.proceduralGuidance.find(v=>v.versionId===candidate.id)?.contentHash).toBe(candidate.contentHash)
  const resources=await followup.resources(),updated=resources.skills.find(skill=>skill.name===f.parent.skillId)!
  expect(updated.description).toContain('version 2');expect(updated.filePath).toContain(candidate.id)
  expect(updated.filePath).not.toContain(f.parent.id)

  await expect(f.skills.promoteToLibrary(f.campaign.id, candidate.id)).rejects.toMatchObject({data: {code: 'skill_cross_campaign_validation_required'}})
  const reopened = new SkillShadowReplayController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: () => {throw new Error('Reopen must not call model')}}})
  expect((await reopened.run(input)).finalStatus).toBe('active'); expect(f.dispatches()).toBe(6)
  const sessions = new SqliteSessionStore(path.join(f.sessionDirectory, 'sessions.sqlite'))
  await expect(f.skills.evaluate(f.campaign.id, candidate.id, {benchmarkId: 'fabricated-campaign-proof', campaignId: f.campaign.id, experimentId: f.experiment.id, pairs: result.pairs}, f.execution, sessions)).rejects.toMatchObject({data: {code: 'replay_scientific_evidence_required'}})
  await expect(f.skills.evaluate(f.campaign.id, candidate.id, {benchmarkId: result.validation!.benchmarkId, campaignId: f.campaign.id, experimentId: f.experiment.id, pairs: [result.pairs[0]!, result.pairs[0]!, result.pairs[0]!]}, f.execution, sessions, {allowPlumbingOnly: true})).rejects.toMatchObject({data: {code: 'replay_not_independent'}})
  sessions.close()
  expect((await f.skills.rollback(f.campaign.id, f.parent.id)).status).toBe('active')
  expect((await f.skills.list(f.campaign.id)).find(value => value.id === candidate.id)?.status).toBe('superseded')
}, 30000)

test('held-out library promotion requires three actual passing campaign receipt sets, not invented campaign ids', async () => {
  const f = await fixture(), candidate = await f.skills.propose(f.campaign.id, f.parent.skillId, {parentVersionId: f.parent.id, markdown: f.markdown, createdBy: 'fixture'})
  const programs = await pairedPrograms(), campaigns = [f.campaign.id]
  for(let index=0; index<3; index++) {
    let campaignId = f.campaign.id, experimentId = f.experiment.id
    if(index) {const campaign = await f.research.createCampaign(f.projectId, {objective: 'Held-out fixture campaign ' + index}); await f.research.activateCampaign(f.projectId, campaign.id); campaignId = campaign.id; campaigns.push(campaignId)
      const experiment = await f.research.createExperiment(f.projectId, campaignId, {contract: f.contract}); await f.research.activateExperiment(f.projectId, experiment.id); experimentId = experiment.id}
    const replay = new SkillShadowReplayController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: scripted(programs.map((program,i) => message([call('write'+i,'write',{path:'trial.py',content:program}),call('arm'+i, 'submit_trial', {hypothesis: 'Paired fixture'})])))}})
    const result = await replay.run({campaignId: f.campaign.id, validationCampaignId: campaignId, experimentId, candidateVersionId: candidate.id, operationId: 'held-out-' + index})
    expect(result.validation!.passed).toBe(true)
    if(index<2) await expect(f.skills.promoteToLibrary(f.campaign.id, candidate.id)).rejects.toMatchObject({data: {code: 'skill_cross_campaign_validation_required'}})
  }
  const entry = await f.skills.promoteToLibrary(f.campaign.id, candidate.id)
  expect(new Set(entry.promotedFromCampaignIds)).toEqual(new Set(campaigns))
  expect((await f.skills.promoteToLibrary(f.campaign.id, candidate.id)).id).toBe(entry.id)
  expect(f.dispatches()).toBe(18)
}, 30000)

test('deterministic replay policy rejects regression, equal outcomes, unequal budgets and arbitrary score input', async () => {
  const baseline = {lockedObjectiveUtility: 2, areaUnderImprovementCurve: 6, validDiverseYield: 8, predictorDisagreement: 0, failureRate: 0, computeCost: 3}
  expect(replayPassed({sameBudget: true, baseline, candidate: baseline})).toBe(false)
  expect(replayPassed({sameBudget: false, baseline, candidate: {...baseline, lockedObjectiveUtility: 3}})).toBe(false)
  expect(replayPassed({sameBudget: true, baseline, candidate: {...baseline, lockedObjectiveUtility: 3, failureRate: 0.1}})).toBe(false)
  expect(replayPassed({sameBudget: true, baseline, candidate: {...baseline, lockedObjectiveUtility: 3}})).toBe(true)
  expect(aggregate([baseline, baseline]).areaUnderImprovementCurve).toBe(4)
  const f = await fixture()
  await expect(f.skills.service.evaluate(f.projectId, f.campaign.id, f.parent.id, {benchmarkId: 'forged', sameBudget: true, baseline, candidate: baseline, campaignIds: [f.campaign.id]} as any, f.execution, new SqliteSessionStore(':memory:'))).rejects.toThrow()
})

test('skill job handlers obey cancellation and accepted proposals recover without another Pi model', async () => {
  const f = await fixture(); let reject = true
  const refinement = new CapabilityRefinementController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: scripted([message([call('submit', 'submit_skill', {markdown: f.markdown})])])}})
  const controller = new PiJobController(f).registerSkills({refinement, replay: new SkillShadowReplayController(f)})
  const job = await controller.enqueueRefinement({idempotencyKey: 'durable-refinement', campaignId: f.campaign.id, skillId: f.parent.skillId, trajectoryRefs: [f.experiment.id]})
  expect((await controller.runOnce({jobId: job.id}))?.status).toBe('succeeded')
  expect((await controller.get(job.id)).result?.version).toMatchObject({status: 'candidate'})
  const cancellation = new AbortController(); cancellation.abort(new Error('Operator cancelled'))
  await expect(refinement.run({campaignId: f.campaign.id, skillId: f.parent.skillId, trajectoryRefs: [f.experiment.id], operationId: 'cancel-refinement'}, undefined, {signal: cancellation.signal})).rejects.toThrow('Operator cancelled')
  expect((await f.skills.list(f.campaign.id)).filter(value => value.status === 'candidate')).toHaveLength(1)
})


test('free model responses cannot reset the persisted authoring turn budget on retry', async () => {
  const f = await fixture(), input = {campaignId: f.campaign.id, skillId: f.parent.skillId, trajectoryRefs: [f.experiment.id], operationId: 'bounded-zero-cost'}
  const controller = new CapabilityRefinementController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',limits: {maxTurns: 1}, streamFn: scripted([message([{type: 'text', text: 'No attributed proposal'}], 'stop')])}})
  await expect(controller.run(input)).rejects.toThrow('without an accepted')
  let calls = 0
  await expect(new CapabilityRefinementController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',limits: {maxTurns: 1}, streamFn: () => {calls++; throw new Error('Should not infer')}}}).run(input)).rejects.toThrow('without an accepted')
  expect(calls).toBe(0)
})

test('paired replay resumes a saved sixth receipt before activation without new model or execution calls', async () => {
  const f = await fixture(), candidate = await f.skills.propose(f.campaign.id, f.parent.skillId, {parentVersionId: f.parent.id, markdown: f.markdown, createdBy: 'fixture'})
  const programs = await pairedPrograms(), replay = new SkillShadowReplayController({...f, runtimeOptions: {accountingProvenance:'offline_fixture',streamFn: scripted(programs.map((program,i)=>message([call('write'+i,'write',{path:'trial.py',content:program}),call('arm'+i,'submit_trial',{hypothesis:'Fixture arm'})])))}})
  const input = {campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'resume-before-activation'}
  let interrupted = false
  await expect(replay.run(input,{readCheckpoint:async()=>undefined,checkCancelled:()=>{},checkpoint:async(phase)=>{if(phase.endsWith(':3:candidate:result')){interrupted=true;throw new Error('Simulated interrupted owner')}}})).rejects.toThrow('Simulated interrupted owner')
  expect(interrupted).toBe(true);expect(f.dispatches()).toBe(6)
  expect((await f.skills.list(f.campaign.id)).find(value=>value.id===candidate.id)?.status).toBe('candidate')
  const result=await new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{throw new Error('Should not infer saved receipt')}}}).run(input)
  expect(result.finalStatus).toBe('active');expect(f.dispatches()).toBe(6)
},30000)

 test('real regressing paired outcomes reject the candidate and retain its active parent', async()=>{
  const f=await fixture(),candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,createdBy:'fixture'})
  const ordered=await pairedPrograms(),programs=ordered.map((_,i)=>ordered[i%2?i-1:i+1]!)
  const result=await new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:scripted(programs.map((program,i)=>message([call('write'+i,'write',{path:'trial.py',content:program}),call('arm'+i,'submit_trial',{hypothesis:'Regressing fixture arm'})])))}}).run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'reject-regression'})
  expect(result.finalStatus).toBe('rejected');expect(result.validation!.passed).toBe(false)
  expect((await f.skills.list(f.campaign.id)).find(value=>value.id===f.parent.id)?.status).toBe('active')
  await expect(f.skills.rollback(f.campaign.id,candidate.id)).rejects.toMatchObject({data:{code:'skill_not_rollback_target'}})
},30000)


test('skill proposal mutation rejects cancelled and replacement-leased origins atomically',async()=>{
 const f=await fixture(),jobs=new ResearchJobService.Service(f.store)
 const job=await jobs.enqueue(f.projectId,{idempotencyKey:'proposal-fence',payload:{kind:'capability_refinement',campaignId:f.campaign.id,sessionId:'ses_fenced_refinement',skillId:f.parent.skillId,trajectoryRefs:[f.experiment.id],runtime:'autofold-pi.v1'}})
 const owner=await jobs.claim(f.projectId,30000)
 const input={parentVersionId:f.parent.id,markdown:f.markdown,trajectoryRefs:[f.experiment.id],createdBy:'fixture',origin:{jobId:job.id,phase:'proposal'}}
 await f.store.mutate(f.projectId,state=>{state.jobs[job.id]!.leaseId='another-owner'})
 await expect(f.skills.propose(f.campaign.id,f.parent.skillId,input,{jobId:job.id,leaseId:owner!.leaseId!})).rejects.toMatchObject({data:{code:'skill_job_commit_fence'}})
 await jobs.cancel(f.projectId,job.id)
 await expect(f.skills.propose(f.campaign.id,f.parent.skillId,input,{jobId:job.id,leaseId:owner!.leaseId!})).rejects.toMatchObject({data:{code:'skill_job_cancelled'}})
 expect((await f.skills.list(f.campaign.id)).filter(value=>value.status==='candidate')).toHaveLength(0)
})


test('durable held-out replay enqueue binds the actual validation campaign contract',async()=>{
 const f=await fixture(),candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,createdBy:'fixture'})
 const campaign=await f.research.createCampaign(f.projectId,{objective:'Held-out explicit frozen scope'});await f.research.activateCampaign(f.projectId,campaign.id)
 const experiment=await f.research.createExperiment(f.projectId,campaign.id,{contract:f.contract});await f.research.activateExperiment(f.projectId,experiment.id)
 const jobs=new PiJobController(f)
 const job=await jobs.enqueueShadowReplay({idempotencyKey:'held-out-queued',campaignId:f.campaign.id,validationCampaignId:campaign.id,experimentId:experiment.id,candidateVersionId:candidate.id})
 expect(job.payload).toMatchObject({campaignId:f.campaign.id,validationCampaignId:campaign.id,experimentId:experiment.id,contractHash:experiment.contractHash})
 expect(f.dispatches()).toBe(0)
})

test('known replay authoring exhaustion settles without a scientific receipt or guide activation and cannot reset on retry',async()=>{
 const f=await fixture(),candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,createdBy:'fixture'})
 const input={campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'known-authoring-exhaustion'}
 const controller=new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',limits:{maxTurns:1},streamFn:scripted([message([{type:'text',text:'No admitted prospective program'}],'stop')])}})
 await expect(controller.run(input)).rejects.toThrow('without an accepted program')
 const data=await f.store.read(f.projectId),record=Object.values(data.operations).find(record=>record.kind==='skill_shadow_replay')!
 expect(record).toMatchObject({outcome:'failed',effect:'none',accounting:'settled',settlement:'settled'})
 expect(record.state.terminalEvidence).toMatchObject({outcome:'failed',effects:{kind:'none'},accounting:{kind:'known',source:'fixture',modelCostUsd:0}})
 expect(Object.values(data.trials)).toHaveLength(0);expect(Object.values(data.runs)).toHaveLength(0);expect(f.dispatches()).toBe(0);expect(data.skillVersions[candidate.id]!.status).toBe('candidate')
 let calls=0
 await expect(new SkillShadowReplayController({...f,runtimeOptions:{streamFn:()=>{calls++;throw new Error('No new inference')}}}).run(input)).rejects.toThrow('without an accepted program')
 expect(calls).toBe(0)
})

test('an injected live provider seam is not fixture proof and preserves unknown billing after authoring failure',async()=>{
 const f=await fixture(),candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,createdBy:'fixture'})
 await expect(new SkillShadowReplayController({...f,runtimeOptions:{limits:{maxTurns:1},streamFn:scripted([message([{type:'text',text:'No admitted program'}],'stop')])}}).run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'unknown-provider-billing'})).rejects.toThrow('without an accepted program')
 const data=await f.store.read(f.projectId),record=Object.values(data.operations).find(record=>record.kind==='skill_shadow_replay')!
 expect(record).toMatchObject({outcome:'failed',effect:'none',accounting:'unknown',settlement:'unresolved'})
 expect(record.state.terminalEvidence).toMatchObject({accounting:{kind:'unknown'}})
 expect(f.dispatches()).toBe(0)
})

test('legacy replay with an accepted draft remains receipt-only and cannot create a new trial or session',async()=>{
 const f=await fixture(),candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,createdBy:'fixture'})
 const {OperationService}=await import('@autofold/science-core/operation-service'),{DEFAULT_MODEL_SELECTION}=await import('../runtime')
 const input={campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'legacy-accepted-shadow',repetitions:3,modelBudgetUsd:2,modelSelection:DEFAULT_MODEL_SELECTION}
 const key=new Bun.CryptoHasher('sha256').update(f.projectId+':shadow:'+input.operationId).digest('hex')
 await new OperationService.Service(f.store).open(f.projectId,{id:'op_'+key,kind:'skill_shadow_replay',identity:input,grant:{deadlineMs:Date.now()+600_000},state:{format:'autofold.pi-skills.v1',input,baselines:{},benchmarkId:'shadow-pi-v1:'+key,context:{},arms:{'1:parent':{sessionId:'ses_original',requestId:'original',originPhase:'shadow:1:parent:trial',proposal:{programPath:'old.py',programHash:'sha256:'+'a'.repeat(64)}}}}})
 let calls=0
 await expect(new SkillShadowReplayController({...f,runtimeOptions:{streamFn:()=>{calls++;throw new Error('No legacy authoring permitted')}}}).run(input)).rejects.toThrow('Legacy replay is receipt-only')
 const state=await f.store.read(f.projectId)
 expect(calls).toBe(0);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0);expect(f.dispatches()).toBe(0)
 const sessions=new SqliteSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'));expect(await sessions.get('ses_original')).toBeUndefined();sessions.close()
})

test('replay authoring failure after an earlier successful arm settles its original receipts without activating guidance',async()=>{
 const f=await fixture(),candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,createdBy:'fixture'})
 const programs=await pairedPrograms()
 const controller=new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',limits:{maxTurns:1},streamFn:scripted([
  message([call('first-write','write',{path:'trial.py',content:programs[0]!}),call('first-submit','submit_trial',{hypothesis:'Independent original successful arm'})]),
  message([{type:'text',text:'No admitted candidate arm program'}],'stop')
 ])}})
 await expect(controller.run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'failure-after-earlier-receipt'})).rejects.toThrow('without an accepted program')
 const state=await f.store.read(f.projectId),record=Object.values(state.operations).find(record=>record.kind==='skill_shadow_replay')!,runs=Object.values(state.runs)
 expect(runs).toHaveLength(1);expect(runs[0]!.status).toBe('succeeded');expect(f.dispatches()).toBe(1)
 expect(record).toMatchObject({outcome:'failed',effect:'settled',accounting:'settled',settlement:'settled'})
 expect(record.state.terminalEvidence).toMatchObject({effects:{kind:'receipts',receiptIds:[runs[0]!.id]}})
 expect(state.skillVersions[candidate.id]!.status).toBe('candidate');expect(state.skillVersions[candidate.id]!.validations??[]).toHaveLength(0)
})

for(const stripContext of [false,true])test(`replay records memory exposure only from settled actual model input (${stripContext?'transformed context absent':'unmodified packet present'})`,async()=>{
 const f=await fixture(),programs=await pairedPrograms()
 const candidate=await f.skills.propose(f.campaign.id,f.parent.skillId,{parentVersionId:f.parent.id,markdown:f.markdown,trajectoryRefs:[f.experiment.id],createdBy:'fixture:actual-replay-context'})
 let contexts=0
 const controller=new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',limits:{maxTurns:1},
  ...(stripContext?{transformContext:async(messages:import('@earendil-works/pi-agent-core').AgentMessage[])=>messages.filter(message=>message.role!=='user')}:{}),
  onInferenceContext:()=>{contexts++},streamFn:scripted([
   message([call('write-observed','write',{path:'trial.py',content:programs[0]!}),call('submit-observed','submit_trial',{hypothesis:'Original context exposure fixture'})]),
   message([{type:'text',text:'No admitted candidate arm; preserve original receipt.'}],'stop')
  ])}})
 await expect(controller.run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:candidate.id,operationId:'actual-context-'+stripContext})).rejects.toThrow('without an accepted program')
 const state=await f.store.read(f.projectId),trials=Object.values(state.trials)
 expect(trials).toHaveLength(1);expect(f.dispatches()).toBe(1);expect(contexts).toBe(2)
 if(stripContext)expect(trials[0]!.decisionMemoryExposure).toBeUndefined()
  else expect(trials[0]!.decisionMemoryExposure).toMatchObject({sessionId:expect.stringMatching(/^ses_shadow_/),exposureScope:'opening_packet',scope:{projectId:f.projectId,experimentId:f.experiment.id},snapshotHash:expect.stringMatching(/^sha256:/)})
 expect(state.skillVersions[candidate.id]!.status).toBe('candidate')
},30000)
