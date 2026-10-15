import {nativeFixtureRoot} from '../execution/native-fixture'
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Type } from 'typebox'
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { StorageResearchStore } from '@autofold/science-core/store'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchJobService } from '@autofold/science-core/job-service'
import { ResearchPrograms } from '@autofold/science-core/programs'
import { ResearchScientistMemory } from '@autofold/science-core/scientist-memory'
import { ResearchTrajectoryCloseout } from '@autofold/science-core/trajectory-closeout'
import { ScientificExecution, LocalWorkerTransport } from '../execution'
import { DEFAULT_MODEL, createSessionStore } from '../runtime'
import { JobLease, JobInterrupted } from './lease'
import { PiJobController, PI_JOB_RUNTIME, type PiJobControllerOptions, type JobScientist, type ScientistJobStatus } from './index'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const digest = (c: string) => `sha256:${c.repeat(64)}`
const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop', cost = 0): AssistantMessage => ({
  role: 'assistant', content, api: DEFAULT_MODEL.api, provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.id,
  timestamp: Date.now(), stopReason, usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
})
const call = (id: string, name: string, args: unknown = {}): ToolCall => ({ type: 'toolCall', id, name, arguments: args as Record<string, any> })
const stream = (value: AssistantMessage) => {
  const output = createAssistantMessageEventStream(); output.push({ type: 'start', partial: value })
  output.push({ type: 'done', reason: value.stopReason as 'stop' | 'toolUse' | 'length', message: value }); output.end(value); return output
}
const script = (...values: AssistantMessage[]): StreamFn => {
  let index = 0
  return () => { const value = values[index++]; if (!value) throw new Error('Unexpected model turn'); return stream(value) }
}

/** Canonical, receipt-bound failed software outcome; no worker or model is invoked. */
async function settledStopEvidence(f:{projectId:string;research:ResearchService.Service;experiment:{id:string}}){
 const trial=await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:'Offline settled failure fixture',designAdapter:'mock',programPath:'fixture.py',programHash:'sha256:'+'b'.repeat(64)})
 const run=await f.research.beginRun(f.projectId,trial.id,{bundlePath:'fixture/bundle.json',outputPath:'fixture/output'})
 await f.research.failRun(f.projectId,run.id,'Verified offline fixture outcome',undefined,{failureReceiptHash:'sha256:'+'f'.repeat(64)})
 return run.id
}

async function fixture(extra: Partial<PiJobControllerOptions> = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-pi-jobs-')); roots.push(workspace)
  const projectId = 'jobs_offline'
  const store = new StorageResearchStore({ directory: path.join(workspace, 'research') })
  const research = new ResearchService.Service(store)
  const execution = new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, workspace, projectId, research })
  const campaign = await research.createCampaign(projectId, { objective: 'Offline durable discovery acceptance' })
  await research.activateCampaign(projectId, campaign.id)
  const evaluator = (await execution.evaluators())[0]!
  const experiment = await research.createExperiment(projectId, campaign.id, { contract: {
    version: 1, objective: 'Plumbing only', targetArtifactHash: digest('a'), modality: 'short_peptide',
    budget: { maximumCandidates: 8, gpuHours: 0, wallTimeMinutes: 1 },
    evaluator: { ...evaluator, fixedSeeds: [7, 11], submissionSize: 3 },
  } })
  await research.activateExperiment(projectId, experiment.id)
  const options: PiJobControllerOptions = { workspace, projectId, store, research, execution, sessionDirectory: path.join(workspace, 'pi'), ...extra }
  return { ...options, experiment, campaign, controller: new PiJobController(options), options }
}
const inertScientist = (state: ScientistJobStatus = { completedEvaluations: 0, stopped: false, researchRequested: false }): JobScientist => ({
  initialize: async () => {}, status: async () => structuredClone(state), context: async () => state,
  tools: () => [], systemPrompt: 'Offline scientist fixture',
})
const nativeRoot = nativeFixtureRoot
const nativePython = path.resolve(import.meta.dir, '../../../../.autofold/envs/proto/bin/python')
const nativeInstalled = await Promise.all([fs.access(nativePython), fs.access(path.join(nativeRoot, 'proto-tools'))]).then(() => true, () => false)
async function commit(root: string) {
  const child = Bun.spawn(['git', '-C', root, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code) throw new Error('Cannot pin native CPU fixture'); return output.trim()
}
function program(experimentId: string, label: string) {
  const plan = { question: `Does ${label} preserve the frozen panel?`, alternatives: [
    { id: 'cpu', experiment: 'Native CPU sequence generation', expectedInformation: 'Worker boundary', estimatedGpuHours: 0 },
    { id: 'stop', experiment: 'Stop without new compute', expectedInformation: 'Existing evidence', estimatedGpuHours: 0 },
  ], selectedAlternativeId: 'cpu', rationale: 'Verify native infrastructure only', evidenceRefs: [experimentId],
    outcomeBranches: [{ observation: 'Valid', nextDecision: 'Inspect trusted result' }, { observation: 'Failed', nextDecision: 'Repair execution' }] }
  return ResearchPrograms.templates().proto + `\nfrom autofold_worker.proto_trial import ProtoTrial\nimport json\ndef build_trial(ctx):\n    return ProtoTrial(program=_build_program(ctx), search=_native_search(ctx), hypothesis=${JSON.stringify(label)}, decision_plan=json.loads(${JSON.stringify(JSON.stringify(plan))}), evidence_refs=(${JSON.stringify(experimentId)},))\n`
}

;(nativeInstalled ? test : test.skip)('real Pi Agent, two native CPU workers and SQLite persist one scientist with trusted closeout before next intervention', async () => {
  const f = await fixture()
  let dispatches = 0, turns = 0
  const local = new LocalWorkerTransport()
  const execution = new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, workspace: f.workspace, projectId: f.projectId, research: f.research,
    proto: { root: nativeRoot, python: nativePython, languageCommit: await commit(nativeRoot), toolsCommit: await commit(path.join(nativeRoot, 'proto-tools')) },
    authorization: { localProto: true, maximumGpuSeconds: 0, maximumCandidates: 8, maximumWallTimeMinutes: 1 },
    transport: { kind: 'local', dispatch: async input => { dispatches++; return local.dispatch(input) } },
  })
  const streamFn: StreamFn = async () => {
    const index = turns++
    if (index === 0) return stream(message([call('write1', 'write', { path: 'trial.py', content: program(f.experiment.id, 'First native panel') })], 'toolUse'))
    if (index === 1) return stream(message([call('evaluate1', 'evaluate_trial', { requestId: 'native-job-evaluation-1' })], 'toolUse'))
    if (index === 2) {
      const state = await f.store.read(f.projectId)
      expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
      expect(Object.values(state.searchObservations)).toHaveLength(1)
      expect(await ResearchScientistMemory.read(f.workspace, f.experiment.id)).toHaveLength(0)
      expect(ResearchTrajectoryCloseout.events(state, [], f.experiment.id)).toHaveLength(1)
      expect(await Bun.file(path.join(f.workspace, `.autofold/autoresearch/${f.experiment.id}/latest-result.json`)).json()).toMatchObject({ status: 'succeeded', closeoutVersion: 2, observationId: expect.any(String), commitHash: expect.any(String) })
      return stream(message([call('read-outcome', 'read_context')], 'toolUse'))
    }
    if (index === 3) return stream(message([call('write2', 'write', { path: 'programs/revised.py', content: program(f.experiment.id, 'Revised native panel') })], 'toolUse'))
    if (index === 4) return stream(message([call('evaluate2', 'evaluate_trial', { programPath: 'programs/revised.py', requestId: 'native-job-evaluation-2' })], 'toolUse'))
    return stream(message([{ type: 'text', text: 'Both trusted outcomes have been inspected.' }]))
  }
  const controller = new PiJobController({ ...f.options, execution, runtimeOptions: { streamFn } })
  const job = await controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'two-native-panels', iterations: 2 })
  const result = await controller.runOnce()
  expect(result?.id).toBe(job.id)
  expect(result?.status).toBe('succeeded')
  expect(result?.result).toMatchObject({ completedEvaluations: 2, reason: 'iteration_limit_reached' })
  expect(dispatches).toBe(2)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.trials)).toHaveLength(2)
  expect(Object.values(state.evaluations)).toHaveLength(2)
  expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
  expect(Object.values(state.searchObservations)).toHaveLength(2)
  expect(await ResearchScientistMemory.read(f.workspace, f.experiment.id)).toHaveLength(0)
  expect(ResearchTrajectoryCloseout.events(state, [], f.experiment.id)).toHaveLength(2)
  expect(Object.values(state.trials).every(trial => trial.decisionPlan && trial.origin?.jobId === job.id)).toBe(true)
  const restored = new PiJobController({ ...f.options, execution, store: new StorageResearchStore({ directory: path.join(f.workspace, 'research') }), runtimeOptions: { streamFn: () => { throw new Error('Must not rerun completed job') } } })
  expect((await restored.get(job.id)).result).toEqual(result?.result)
  expect(await restored.runOnce()).toBeUndefined()
  expect(await restored.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'two-native-panels', iterations: 2 })).toMatchObject({ id: job.id })
  const chat = new PiJobController({...f.options, execution, runtimeOptions: {streamFn: script(message([call('chat-read-result', 'read_context')], 'toolUse'), message([{type: 'text', text: 'The existing trusted result supports reviewing the next intervention.'}]))}})
  const followup = await chat.enqueueDiscovery(f.experiment.id, {idempotencyKey: 'trusted-result-chat', iterations: 1, conversation: true, prompt: 'Explain the trusted result and current guidance without spending compute.'})
  expect(followup.payload.sessionId).toBe(job.payload.sessionId)
  expect((await chat.runOnce({jobId: followup.id}))?.result).toMatchObject({reason: 'conversation_completed', completedEvaluations: 0, scientist: {completedEvaluations: 2}})
  expect(dispatches).toBe(2)
  expect(Object.values((await f.store.read(f.projectId)).trials).every(trial => trial.skills.length === 5)).toBe(true)
}, 60_000)

;(nativeInstalled ? test : test.skip)('a fresh discovery job reports and admits renewed empirical slots after the previous job iteration limit', async () => {
  const f = await fixture()
  let dispatches = 0
  const local = new LocalWorkerTransport()
  const execution = new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},workspace: f.workspace, projectId: f.projectId, research: f.research,
    proto: {root: nativeRoot, python: nativePython, languageCommit: await commit(nativeRoot), toolsCommit: await commit(path.join(nativeRoot, 'proto-tools'))},
    authorization: {localProto: true, maximumGpuSeconds: 0, maximumCandidates: 8, maximumWallTimeMinutes: 1},
    transport: {kind: 'local', dispatch: async input => {dispatches++; return local.dispatch(input)}},
  })
  const firstController = new PiJobController({...f.options, execution, runtimeOptions: {streamFn: script(
    message([call('write-prior', 'write', {path: 'trial.py', content: program(f.experiment.id, 'Initial bounded panel')})], 'toolUse'),
    message([call('evaluate-prior', 'evaluate_trial', {requestId: 'previous-job-limit'})], 'toolUse'),
  )}})
  const first = await firstController.enqueueDiscovery(f.experiment.id, {idempotencyKey: 'previous-limit', iterations: 1})
  expect((await firstController.runOnce({jobId: first.id}))?.result).toMatchObject({reason: 'iteration_limit_reached', completedEvaluations: 1})
  let stage=0,pages='',artifactPages=0
  let artifact:Record<string,any>|undefined
  const contexts:any[]=[]
  const controller=new PiJobController({...f.options,execution,runtimeOptions:{streamFn:(_model,context)=>{
    if(stage===0||stage===3){stage++;return stream(message([call('read-renewed-'+stage,'read_context')],'toolUse'))}
    if(stage===1||stage===4){
      const result=context.messages.findLast(entry=>entry.role==='toolResult'&&entry.toolName===(artifact?'read_tool_artifact':'read_context'))
      if(!result||result.role!=='toolResult'||result.isError)throw new Error('Missing successful original context response')
      let data=JSON.parse(result.content.filter(part=>part.type==='text').map(part=>part.text).join(''))
      if(data.toolArtifact){artifact=data.toolArtifact;pages='';return stream(message([call('page-context-'+artifactPages++,'read_tool_artifact',{...artifact,offsetBytes:0,limitBytes:8000})],'toolUse'))}
      if(artifact){
        pages+=data.text
        if(data.nextOffsetBytes!==null)return stream(message([call('page-context-'+artifactPages++,'read_tool_artifact',{...artifact,offsetBytes:data.nextOffsetBytes,limitBytes:8000})],'toolUse'))
        const original=JSON.parse(pages);data=JSON.parse(original.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join(''));artifact=undefined
      }
      const initial=contexts.length===0;contexts.push(data)
      expect(data.budgets.currentJob).toMatchObject({baselineCompletedEvaluations:1,maximumEvaluations:2,completedEvaluations:initial?0:1,reservedEvaluations:initial?0:1,remainingEvaluations:initial?2:1})
      expect(data.lane.completedEvaluations).toBe(initial?1:2)
      expect(data.budgets.perTrial).toMatchObject({gpuHours:0,maximumCandidates:8,wallTimeMinutes:1})
      expect(data.budgets.campaign).toMatchObject({trialCount:initial?1:2,maximumTrials:null,remainingTrials:null})
      stage++
      if(initial)return stream(message([call('write-renewed','write',{path:'programs/renewed.py',content:program(f.experiment.id,'Renewed intervention')})],'toolUse'))
      expect(data.decisionMemory.coverage.totalRecords).toBe(2)
      const latest=data.decisionMemory.facts.toSorted((a:any,b:any)=>a.createdAt.localeCompare(b.createdAt)).at(-1)
      return stream(message([call('stop-renewed','stop_discovery',{basis:'no_justified_intervention',reason:'No further justified intervention',rationale:'The renewed job has one slot left, but the observed panel supplies no reason to spend it.',evidenceRefs:[latest.runId]})],'toolUse'))
    }
    if(stage===2){stage++;return stream(message([call('evaluate-renewed','evaluate_trial',{programPath:'programs/renewed.py',requestId:'renewed-job-evaluation'})],'toolUse'))}
    throw new Error('Unexpected renewed discovery turn')
  }}})
  const renewed = await controller.enqueueDiscovery(f.experiment.id, {idempotencyKey: 'renewed-limit', iterations: 2})
  expect(renewed.payload.sessionId).toBe(first.payload.sessionId)
  const result = await controller.runOnce({jobId: renewed.id})
  expect(result?.recovery).toBeUndefined()
  expect(result?.status).toBe('succeeded')
  expect(result?.result).toMatchObject({reason: 'scientist_stopped', completedEvaluations: 1, scientist: {completedEvaluations: 2, stopped: true}})
  expect(contexts).toHaveLength(2)
  expect(dispatches).toBe(2)
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(2)
}, 60_000)

test('fresh discovery scope uses its own frozen objective and scientist context without inheriting acceptance milestones', async () => {
  const f = await fixture({runtimeOptions: {streamFn: script(message([{type: 'text', text: 'The old objective is the two-trial acceptance milestone.'}]))}})
  const acceptance = await f.research.createExperiment(f.projectId, f.campaign.id, {contract: {...f.experiment.contract, objective: 'Complete the two-trial acceptance milestone'}})
  await f.research.activateExperiment(f.projectId, acceptance.id)
  const old = await f.controller.enqueueDiscovery(acceptance.id, {idempotencyKey: 'old-acceptance', iterations: 2,
    prompt: 'Complete the two-trial acceptance milestone.', conversation: true})
  expect((await f.controller.runOnce({jobId: old.id}))?.status).toBe('succeeded')
  const campaign = await f.research.createCampaign(f.projectId, {objective: 'Discover which intervention resolves target uncertainty'})
  await f.research.activateCampaign(f.projectId, campaign.id)
  const experiment = await f.research.createExperiment(f.projectId, campaign.id, {contract: {...f.experiment.contract,
    objective: 'Explore target uncertainty using measured interventions; stop when no justified information gain remains'}})
  await f.research.activateExperiment(f.projectId, experiment.id)
  let inspected = false
  const controller = new PiJobController({...f.options, runtimeOptions: {streamFn: (_model, context) => {
    const result = context.messages.findLast(entry => entry.role === 'toolResult' && entry.toolName === 'read_context')
    if (!result || result.role !== 'toolResult') return stream(message([call('fresh-discovery-context', 'read_context')], 'toolUse'))
    const data = JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join(''))
    expect(data.experiment.id).toBe(experiment.id)
    expect(data.experiment.contract.objective).toBe(experiment.contract.objective)
    expect(data.campaign.objective).toBe(campaign.objective)
    expect(data.decisionMemory.facts).toHaveLength(0)
    expect(data.decisionMemory.coverage.totalRecords).toBe(0)
    expect(data.decisionMemory.sourceManifest.scope.experimentId).toBe(experiment.id)
    expect(data.lane.completedEvaluations).toBe(0)
    expect(data.budgets.currentJob).toMatchObject({maximumEvaluations: 0, remainingEvaluations: 0, computeAuthorized: false})
    expect(JSON.stringify(context.messages)).not.toContain('two-trial acceptance milestone')
    expect(data.experiment.contractHash).not.toBe(acceptance.contractHash)
    inspected = true
    return stream(message([{type: 'text', text: 'The discovery objective has its own frozen scope.'}]))
  }}})
  const fresh = await controller.enqueueDiscovery(experiment.id, {idempotencyKey: 'fresh-discovery', iterations: 2, conversation: true})
  expect(fresh.payload.sessionId).not.toBe(old.payload.sessionId)
  expect((await controller.runOnce({jobId: fresh.id}))?.status).toBe('succeeded')
  expect(inspected).toBe(true)
  expect((await f.research.history(f.projectId, acceptance.id)).experiment.contract).toEqual(acceptance.contract)
  expect((await f.controller.get(old.id)).payload.prompt).toBe('Complete the two-trial acceptance milestone.')
})

test('explicit stop finishes promptly and advisory research continues until an explicit stop without consuming empirical slots', async () => {
  for (const kind of ['stop', 'research'] as const) {
    const f = await fixture(),stopEvidence=await settledStopEvidence(f)
    const tool = kind === 'stop' ? call('stop', 'stop_discovery', { basis:'no_justified_intervention',reason: 'Enough evidence', rationale: 'No compute is justified', evidenceRefs: [stopEvidence] }) :
      call('research', 'request_research', { question: 'Which mechanism applies?', competingExplanations: ['A', 'B'], requiredEvidence: 'Comparative literature', applicabilityChecks: 'Same target', decisionIfResolved: 'Choose next native program', evidenceRefs: [stopEvidence] })
    const controller = new PiJobController({ ...f.options, runtimeOptions: { streamFn: script(message([tool], 'toolUse'), ...(kind === 'research' ? [message([call('explicit-stop', 'stop_discovery', {basis:'no_justified_intervention',reason:'Offline fixture complete',rationale:'Advisory lookup did not end the scientist turn',evidenceRefs:[stopEvidence]})], 'toolUse')] : [])) } })
    const input = { idempotencyKey: kind, iterations: 2 }
    const job = await controller.enqueueDiscovery(f.experiment.id, input)
    const result = await controller.runOnce()
    expect(result?.status).toBe('succeeded')
    expect(result?.result).toMatchObject({ completedEvaluations: 0, reason: 'scientist_stopped' })
    if (kind === 'research') expect((await f.research.campaignResearchState(f.projectId,f.experiment.campaignId)).researchQuestions[0]).toMatchObject({status:'open',request:{purpose:'empirical_test'}})
    expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(1)
    expect((await controller.enqueueDiscovery(f.experiment.id, input)).id).toBe(job.id)
  }
})

test('one Pi prompt owns the cumulative model budget and fresh jobs preserve session accounting', async () => {
  const state = {completedEvaluations: 0, stopped: false, researchRequested: false}
  const scientist = () => ({...inertScientist(state), tools: () => [{name: 'inspect', label: 'Inspect', description: 'Offline diagnostic', parameters: Type.Object({}), execute: async () => ({content:[{type:'text' as const,text:'No effects'}],details:{}})}]})
  const f = await fixture({scientistFactory: scientist})
  const spent = new PiJobController({...f.options, scientistFactory: scientist, runtimeOptions: {streamFn: script(
    message([call('inspect-budget', 'inspect')], 'toolUse', 0.07), message([{type:'text',text:'Done'}], 'stop', 0.07))}})
  const first = await spent.enqueueDiscovery(f.experiment.id, {idempotencyKey:'cost-one',iterations:1,modelBudgetUsd:0.1})
  const result = await spent.runOnce()
  expect(result?.result).toMatchObject({reason:'model_budget_exhausted',modelCostUsd:expect.closeTo(0.14)})
  expect(result?.checkpoints['pi:turn:1:result'].data).toMatchObject({cumulativeModelCostUsd:expect.closeTo(0.14)})
  expect(result?.checkpoints['pi:turn:2:intent']).toBeUndefined()
  const next = new PiJobController({...f.options,scientistFactory:scientist,runtimeOptions:{limits:{maxTurns:1},streamFn:script(message([{type:'text',text:'Fresh job analysis'}],'stop',0.04))}})
  await next.enqueueDiscovery(f.experiment.id,{idempotencyKey:'cost-two',iterations:1,modelBudgetUsd:0.1})
  const second = await next.runOnce()
  expect(second?.result).toMatchObject({reason:'runtime_limit_reached',modelCostUsd:expect.closeTo(0.04)})
  expect(second?.checkpoints['pi:job:start'].data).toMatchObject({costUsd:expect.closeTo(0.14)})
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  expect((await sessions.get(first.payload.sessionId))?.usage.costUsd).toBeCloseTo(0.18)
  sessions.close()
})

test('prose completion continues with one human instruction under the same cumulative job turn allowance',async()=>{
  const prompts:string[]=[],humanInstructions:string[][]=[],instruction='Own the complete inspect, repair, validate and evaluate cycle.'
  const f=await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{limits:{maxTurns:3},streamFn:(_model,context)=>{
    const user=context.messages.findLast(entry=>entry.role==='user'),content=user?.content
    prompts.push(typeof content==='string'?content:(content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n'))
    humanInstructions.push(context.messages.filter(entry=>entry.role==='user').map(entry=>typeof entry.content==='string'?entry.content:entry.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')).filter(text=>text===instruction))
    return stream(message([{type:'text',text:'No informative empirical evaluation is justified.'}],'stop',0.01))
  }}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'agent-owned-instruction',iterations:2,prompt:instruction,modelBudgetUsd:0.1})
  const result=await f.controller.runOnce({jobId:job.id})
  expect(prompts).toHaveLength(3);expect(humanInstructions).toEqual([[instruction],[instruction],[instruction]]);expect(prompts[0]).not.toContain(instruction)
  expect(prompts[0]).toContain('at most 2 more empirical evaluations')
  expect(prompts[0]).toContain('Never repeat an unresolved execution request')
  expect(result?.checkpoints['pi:turn:2:intent']).toBeDefined()
  expect(result?.checkpoints['pi:turn:4:intent']).toBeUndefined()
  expect(result?.result).toMatchObject({reason:'runtime_limit_reached',completedEvaluations:0,modelCostUsd:expect.closeTo(0.03)})
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  try{
    const session=(await sessions.get(job.payload.sessionId))!
    const baseline=result?.checkpoints['pi:job:start'].data
    expect(baseline).toMatchObject({costUsd:0,turns:0,toolCalls:0,originalRequestIds:[],binding:{jobId:job.id,sessionId:job.payload.sessionId}})
    expect(Object.values(session.modelRequests!).every(request=>request.owningBinding?.jobId===job.id&&request.owningBinding?.bindingHash===(baseline?.binding as any).bindingHash)).toBe(true)
    expect(session.messages.filter(entry=>entry.role==='user'&&typeof entry.content==='string'&&entry.content===instruction)).toHaveLength(1)
  }finally{sessions.close()}
})

test('scientific jobs preserve the host context transform at the generic runtime boundary', async () => {
  let transformations = 0, requests = 0
  const f = await fixture({ scientistFactory: () => inertScientist(), runtimeOptions: {
    transformContext: async messages => { transformations++; return messages },
    streamFn: () => { requests++; return stream(message([{type: 'text', text: 'Host context policy applied.'}])) },
  } })
  const job = await f.controller.enqueueDiscovery(f.experiment.id, {
    idempotencyKey: 'host-context-owner', iterations: 1, conversation: true,
  })
  const result = await f.controller.runOnce({jobId: job.id})
  expect(result?.status).toBe('succeeded')
  expect(result?.result).toMatchObject({reason: 'conversation_completed', completedEvaluations: 0})
  expect(requests).toBe(1)
  expect(transformations).toBe(requests)
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
})

test('discovery delegates response length to Pi and preserves cumulative inference bounds', async () => {
  let calls = 0
  const f = await fixture({scientistFactory: () => inertScientist(), runtimeOptions: {streamFn: (_model, _context, options) => {
    calls++
    expect(options?.maxTokens).toBeUndefined()
    return stream(message([{type: 'text', text: 'Provider-owned response length.'}], 'stop', 0.02))
  }}})
  const job = await f.controller.enqueueDiscovery(f.experiment.id, {idempotencyKey: 'output-override', iterations: 2, modelBudgetUsd: 0.01})
  const result = await f.controller.runOnce({jobId: job.id})
  expect(calls).toBe(1)
  expect(result?.result).toMatchObject({reason: 'model_budget_exhausted', completedEvaluations: 0, modelCostUsd: expect.closeTo(0.02)})
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})

test('foreign jobs and expired foreign leases remain untouched and concurrent Pi scopes admit one owner', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = await fixture({ scientistFactory: () => inertScientist(), runtimeOptions: { streamFn: () => { started(); return createAssistantMessageEventStream() } } })
  const legacyJobs = new ResearchJobService.Service(f.store)
  const legacy = await legacyJobs.enqueue(f.projectId, { idempotencyKey: 'old', payload: { kind: 'autoresearch', experimentId: f.experiment.id, sessionId: 'ses_old', iterations: 1, agent: 'biology' } })
  const prior = await legacyJobs.claim(f.projectId, 1)
  await Bun.sleep(3)
  await f.controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'new-one', iterations: 1 })
  await f.controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'new-two', iterations: 1 })
  const shutdown = new AbortController()
  const running = f.controller.runOnce({ signal: shutdown.signal }); await ready
  const other = new PiJobController({ ...f.options, store: new StorageResearchStore({ directory: path.join(f.workspace, 'research') }) })
  expect(await other.runOnce()).toBeUndefined()
  expect(await legacyJobs.get(f.projectId, legacy.id)).toEqual(prior!)
  await expect(other.cancel(legacy.id)).rejects.toThrow('not owned')
  shutdown.abort(); expect((await running)?.status).toBe('interrupted')
  expect((await f.controller.list()).every(job => job.payload.runtime === PI_JOB_RUNTIME)).toBe(true)
})

test('cancellation from a separate SQLite process aborts a live Pi model and is terminal', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = await fixture({ scientistFactory: () => inertScientist(), cancelPollMs: 10, runtimeOptions: { streamFn: () => { started(); return createAssistantMessageEventStream() } } })
  const job = await f.controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'cancel-remote', iterations: 1 })
  const promise = f.controller.runOnce(); await ready
  const source = `import { StorageResearchStore } from ${JSON.stringify(path.resolve(import.meta.dir, '../../../science-core/src/research/store.ts'))}; import { ResearchJobService } from ${JSON.stringify(path.resolve(import.meta.dir, '../../../science-core/src/research/job-service.ts'))}; const jobs = new ResearchJobService.Service(new StorageResearchStore({directory:${JSON.stringify(path.join(f.workspace, 'research'))}})); await jobs.cancel(${JSON.stringify(f.projectId)},${JSON.stringify(job.id)});`
  const child = Bun.spawn([process.execPath, '--eval', source], { stdout: 'pipe', stderr: 'pipe' })
  expect(await child.exited).toBe(0)
  expect((await promise)?.status).toBe('cancelled')
  expect((await f.controller.get(job.id)).result).toBeUndefined()
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
}, 10_000)

test('queued frozen-contract and model mismatches fail before scientist or model effects', async () => {
  for (const mismatch of ['contract', 'model'] as const) {
    let modelCalls = 0, initialized = 0
    const f = await fixture({ scientistFactory: () => ({ ...inertScientist(), initialize: async () => { initialized++ } }), runtimeOptions: { streamFn: () => { modelCalls++; throw new Error('must not execute') } } })
    const job = await f.controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: mismatch, iterations: 1 })
    await f.store.mutate(f.projectId, state => { const queued = state.jobs[job.id]; queued.payload = { ...queued.payload, ...(mismatch === 'contract' ? { contractHash: digest('f') } : { modelSelection: { provider: 'openrouter', modelId: 'different' } }) } })
    expect((await f.controller.runOnce())?.status).toBe('failed')
    expect(initialized).toBe(0); expect(modelCalls).toBe(0)
  }
})

test('reopening a checkpointed job reconciles its previous empirical result before requesting any new model turn', async () => {
  const status: ScientistJobStatus = { completedEvaluations: 1, stopped: false, researchRequested: false }
  let initialized = 0, modelCalls = 0
  const f = await fixture({ scientistFactory: () => ({ ...inertScientist(status), initialize: async () => { initialized++ } }), runtimeOptions: { streamFn: () => { modelCalls++; throw new Error('must use prior result') } } })
  const job = await f.controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'recovered-result', iterations: 1 })
  const sessions = createSessionStore(path.join(f.sessionDirectory, 'sessions.sqlite'))
  const { PiRuntime } = await import('../runtime')
  const runtime = new PiRuntime({ store: sessions })
  await runtime.create({ id: job.payload.sessionId, metadata: { projectId: f.projectId, experimentId: f.experiment.id, contractHash: f.experiment.contractHash } })
  sessions.close()
  const jobs = new ResearchJobService.Service(f.store)
  const claimed = await jobs.claim(f.projectId, 50)
  await jobs.checkpoint(f.projectId, job.id, claimed!.leaseId!, 'pi:job:start', { completedEvaluations: 0, costUsd: 0, deadlineMs: Date.now() + 30000 })
  await Bun.sleep(60)
  const reopened = new PiJobController({ ...f.options, store: new StorageResearchStore({ directory: path.join(f.workspace, 'research') }) })
  const result = await reopened.runOnce()
  expect(result?.status).toBe('succeeded')
  expect(result?.result).toMatchObject({ completedEvaluations: 1 })
  expect(initialized).toBe(1); expect(modelCalls).toBe(0)
})

;(nativeInstalled ? test : test.skip)('worker shutdown after a real committed result reopens without repeating dispatch or the Pi tool', async () => {
  const f = await fixture()
  const { ScientistLane } = await import('../scientist')
  const shutdown = new AbortController()
  let dispatches = 0, modelCalls = 0
  const local = new LocalWorkerTransport()
  const execution = new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, workspace: f.workspace, projectId: f.projectId, research: f.research,
    proto: { root: nativeRoot, python: nativePython, languageCommit: await commit(nativeRoot), toolsCommit: await commit(path.join(nativeRoot, 'proto-tools')) },
    authorization: { localProto: true, maximumGpuSeconds: 0, maximumCandidates: 8, maximumWallTimeMinutes: 1 },
    transport: { kind: 'local', dispatch: async input => { dispatches++; return local.dispatch(input) } },
  })
  const planned = script(
    message([call('shutdown-write', 'write', { path: 'trial.py', content: program(f.experiment.id, 'Recover committed native outcome') })], 'toolUse'),
    message([call('shutdown-evaluate', 'evaluate_trial', { requestId: 'shutdown-native-result' })], 'toolUse'),
  )
  const controller = new PiJobController({ ...f.options, execution, leaseMs: 1000, heartbeatMs: 100, cancelPollMs: 10,
    runtimeOptions: { streamFn: (...args) => { modelCalls++; return planned(...args) } },
    scientistFactory: options => {
      const lane = new ScientistLane(options)
      return { initialize: () => lane.initialize(), status: () => lane.status(), context: () => lane.context(),
        systemPrompt: lane.systemPrompt,
        tools: () => lane.tools().map(tool => tool.name !== 'evaluate_trial' ? tool : { ...tool,
          execute: async (...args) => { const result = await tool.execute(...args); shutdown.abort(); return result },
        }),
      }
    },
  })
  const job = await controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'shutdown-after-commit', iterations: 1 })
  expect((await controller.runOnce({ signal: shutdown.signal }))?.status).toBe('interrupted')
  expect(dispatches).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).knowledgeCycles)).toHaveLength(0)
  await Bun.sleep(1100)
  const reopened = new PiJobController({ ...f.options, execution,
    store: new StorageResearchStore({ directory: path.join(f.workspace, 'research') }),
    runtimeOptions: { streamFn: () => { throw new Error('Committed result must settle job without another model call') } },
  })
  const completed = await reopened.runOnce()
  expect(completed?.id).toBe(job.id)
  expect(completed?.status).toBe('succeeded')
  expect(completed?.result).toMatchObject({ completedEvaluations: 1 })
  expect(dispatches).toBe(1); expect(modelCalls).toBe(2)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.trials)).toHaveLength(1)
  expect(Object.values(state.evaluations)).toHaveLength(1)
  expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
  expect(await ResearchScientistMemory.read(f.workspace, f.experiment.id)).toHaveLength(0)
  expect(ResearchTrajectoryCloseout.events(state, [], f.experiment.id)).toHaveLength(1)
}, 60_000)

test('first-session conversation preserves scientist scope and blocks compute without empirical progress requirements', async () => {
  const f = await fixture()
  const controller = new PiJobController({ ...f.options, runtimeOptions: { streamFn: script(
    message([call('chat-read', 'read_context'), call('chat-denied', 'evaluate_trial', { requestId: 'not-authorized' })], 'toolUse'),
    message([{ type: 'text', text: 'The frozen experiment has no empirical evidence yet.' }]),
  ) } })
  const job = await controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'scientist-chat', iterations: 1, conversation: true, prompt: 'Explain current evidence without spending compute.' })
  const result = await controller.runOnce({ jobId: job.id })
  expect(result?.status).toBe('succeeded'); expect(result?.result).toMatchObject({ reason: 'conversation_completed', completedEvaluations: 0 })
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
  const sessions = createSessionStore(path.join(f.sessionDirectory, 'sessions.sqlite'))
  const session = await sessions.get(job.payload.sessionId)
  expect(session?.messages.some(message => message.role === 'toolResult' && message.toolName === 'evaluate_trial' && message.isError)).toBe(true)
  expect(session?.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Explain current evidence'))).toBe(true)
  sessions.close()
})

test('legacy JSON-only pending authority holds a no-compute conversation before inference without changing original intent', async () => {
  let calls=0
  const f = await fixture(), controller = new PiJobController({ ...f.options, runtimeOptions: { streamFn: ()=>{calls++;throw new Error('Legacy authority must hold before inference')} } })
  const job = await controller.enqueueDiscovery(f.experiment.id, { idempotencyKey: 'pending-chat', iterations: 1, conversation: true })
  const trial = await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:'Prepared intent',designAdapter:'mock',programPath:'captured.py',programHash:digest('c')})
  const run = await f.research.beginRun(f.projectId,trial.id,{bundlePath:'bundle.json',outputPath:'output'})
  const root = path.join(f.workspace,'.autofold/autoresearch',f.experiment.id);await fs.mkdir(root,{recursive:true})
  const intent={requestId:'prepared',trialId:trial.id,programHash:digest('c'),programPath:'captured.py',draftPath:'.autofold/autoresearch/'+f.experiment.id+'/trial.py',iteration:1,input:{hypothesis:trial.hypothesis,designAdapter:'mock',programPath:trial.programPath,programHash:trial.programHash},phase:'trial'}
  await fs.writeFile(path.join(root,'scientist.json'),JSON.stringify({format:'autofold.scientist-state.v2',experimentId:f.experiment.id,contractHash:f.experiment.contractHash,sessionId:job.payload.sessionId,completedEvaluations:0,stopped:false,researchRequested:false,requests:{prepared:intent},pending:{trialId:trial.id,requestId:'prepared',programHash:digest('c'),programPath:'captured.py',iteration:1}}))
  const originalBytes=await fs.readFile(path.join(root,'scientist.json'),'utf8')
  const settled=await controller.runOnce({jobId:job.id});expect(settled?.status).not.toBe('succeeded');expect(settled?.error).toContain('Legacy scientist authority unresolved')
  expect(calls).toBe(0);expect(await fs.readFile(path.join(root,'scientist.json'),'utf8')).toBe(originalBytes)
  expect((await f.research.getRun(f.projectId,run.id)).status).toBe('queued')
  expect(Object.values((await f.store.read(f.projectId)).evaluations)).toHaveLength(0)
})

test('generic campaign handler drives only its authorized child and parent cancellation cascades atomically', async () => {
  const f = await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{limits:{maxTurns:1},streamFn:script(message([{type:'text',text:'Child context read.'}]))}})
  f.controller.registerHandler('campaign_loop',async ({job,controller,lifecycle})=>{
    await lifecycle.checkpoint('campaign:start',{campaignId:f.campaign.id})
    const child=await controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'campaign-child',iterations:1,parentJobId:job.id,parentLeaseId:job.leaseId!})
    const result=await controller.runOnce({jobId:child.id})
    return {childJobId:child.id,childStatus:result?.status}
  })
  const parent=await f.controller.enqueueJob({idempotencyKey:'campaign-parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_campaign',maxSteps:1}})
  expect((await f.controller.runOnce({jobId:parent.id}))?.result).toMatchObject({childStatus:'succeeded'})
  const pendingParent=await f.controller.enqueueJob({idempotencyKey:'cancel-parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_cancel_campaign',maxSteps:1}})
  await new ResearchJobService.Service(f.store).claim(f.projectId,30000,candidate=>candidate.id===pendingParent.id)
  const child=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'cancel-child',iterations:1,parentJobId:pendingParent.id,parentLeaseId:(await f.controller.get(pendingParent.id)).leaseId!})
  await f.controller.cancel(pendingParent.id)
  expect((await f.controller.get(pendingParent.id)).status).toBe('cancelled')
  expect((await f.controller.get(child.id)).status).toBe('cancelled')
})


test('parent cancellation between host guard and child enqueue creates no orphan inference or compute',async()=>{
 let calls=0
 const f=await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{streamFn:()=>{calls++;throw new Error('No orphan inference')}}})
 const parent=await f.controller.enqueueJob({idempotencyKey:'cancel-enqueue-race',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_parent_race',maxSteps:1}})
 const owner=await new ResearchJobService.Service(f.store).claim(f.projectId,30000,candidate=>candidate.id===parent.id)
 await f.controller.cancel(parent.id)
 await expect(f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'orphan-after-cancel',iterations:1,parentJobId:parent.id,parentLeaseId:owner!.leaseId!})).rejects.toMatchObject({data:{code:'parent_job_fence'}})
 expect(await f.controller.runOnce()).toBeUndefined()
 expect(calls).toBe(0);expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
 expect((await f.controller.list()).filter(job=>job.payload.parentJobId===parent.id)).toHaveLength(0)
})

test('unknown external tool effect stops the real Pi agent before another model call and exposes recovery',async()=>{
  const {ReceiptUnresolvedError}=await import('../execution')
  let modelCalls=0, pending=false
  const f=await fixture({scientistFactory:()=>({...inertScientist(),status:async()=>({completedEvaluations:0,stopped:false,researchRequested:false,...(pending?{pending:{requestId:'original',programHash:digest('a'),programPath:'trial.py',iteration:1}}:{})}),
    tools:()=>[{name:'evaluate_trial',label:'Fault injection',description:'Unknown external receipt',parameters:Type.Object({}),execute:async()=>{pending=true;throw new ReceiptUnresolvedError('run_original','Simulated SSH acknowledgement loss')}}]}),
    runtimeOptions:{streamFn:()=>{modelCalls++;return stream(message([call('original-evaluation','evaluate_trial')],'toolUse',.03))}}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'unknown-tool',iterations:1})
  const held=await f.controller.runOnce({jobId:job.id})
  expect(held?.status).toBe('recovery_required');expect(held?.recovery?.accounting).toBe('unsettled');expect(held?.result).toBeUndefined()
  expect(modelCalls).toBe(1)
  expect(await f.controller.runOnce()).toBeUndefined();expect(modelCalls).toBe(1)
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  const session=await sessions.get(job.payload.sessionId)
  expect(session?.status).toBe('failed');expect(session?.usage.costUsd).toBeCloseTo(.03)
  expect(Object.keys(session?.pendingTools??{})).toEqual(['original-evaluation']);sessions.close()
  const followup=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'must-not-overlap',iterations:1})
  expect(await f.controller.runOnce({jobId:followup.id})).toBeUndefined();expect(modelCalls).toBe(1)
})

test('heartbeat failure detaches the owner promptly and keeps the exact failure diagnosis',async()=>{
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r})
  const f=await fixture({leaseMs:200,heartbeatMs:20,cancelPollMs:10,scientistFactory:()=>inertScientist(),runtimeOptions:{streamFn:()=>{started();return createAssistantMessageEventStream()}}})
  const {spyOn}=await import('bun:test')
  let heartbeat: ReturnType<typeof spyOn> | undefined
  try {
    const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'lease-fault',iterations:1})
    const running=f.controller.runOnce({jobId:job.id});await ready
    heartbeat=spyOn(ResearchJobService.Service.prototype,'heartbeat').mockRejectedValue(new Error('Injected storage renewal failure'))
    const held=await running
    expect(held?.status).toBe('interrupted');expect(held?.recovery?.reason).toBe('lease_lost');expect(held?.error).toContain('Injected storage renewal failure')
    expect(held?.leaseId).toBeUndefined();expect(held?.completedAt).toBeUndefined()
  } finally {heartbeat?.mockRestore()}
})

test('shutdown detaches a noncooperating handler; late completion cannot overwrite the recovery state',async()=>{
  let started!:()=>void,finish!:()=>void;const ready=new Promise<void>(r=>{started=r}),release=new Promise<void>(r=>{finish=r})
  const f=await fixture(),shutdown=new AbortController()
  f.controller.registerHandler('campaign_loop',async({lifecycle})=>{started();await release;await lifecycle.checkpoint('late-effect',{done:true});return {status:'incorrect-success'}})
  const job=await f.controller.enqueueJob({idempotencyKey:'noncooperating',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_noncooperative',agent:'task',maxSteps:1,modelBudgetUsd:1,maximumTrajectories:1,maximumDurationMs:10000}})
  const running=f.controller.runOnce({jobId:job.id,signal:shutdown.signal});await ready;shutdown.abort()
  const held=await running
  expect(held?.status).toBe('interrupted');expect(held?.result).toBeUndefined();finish();await Bun.sleep(20)
  expect(await f.controller.get(job.id)).toMatchObject({status:'interrupted',recovery:{reason:'shutdown'}})
  expect((await f.controller.get(job.id)).checkpoints['late-effect']).toBeUndefined()
})

test('actual controller process death reopens the original SQLite job without repeating checkpointed work',async()=>{
  const f=await fixture();const job=await f.controller.enqueueJob({idempotencyKey:'process-crash',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_crash',agent:'task',maxSteps:1,modelBudgetUsd:1,maximumTrajectories:1,maximumDurationMs:30000}})
  const root=path.resolve(import.meta.dir,'..'),core=path.resolve(import.meta.dir,'../../../science-core/src/research')
  const source=`import {StorageResearchStore} from ${JSON.stringify(path.join(core,'store.ts'))};import {ResearchService} from ${JSON.stringify(path.join(core,'service.ts'))};import {ScientificExecution} from ${JSON.stringify(path.join(root,'execution/index.ts'))};import {PiJobController} from ${JSON.stringify(path.join(root,'jobs/index.ts'))};
const workspace=${JSON.stringify(f.workspace)},projectId=${JSON.stringify(f.projectId)},store=new StorageResearchStore({directory:${JSON.stringify(path.join(f.workspace,'research'))}}),research=new ResearchService.Service(store),execution=new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},workspace,projectId,research});
const c=new PiJobController({workspace,projectId,store,research,execution,sessionDirectory:${JSON.stringify(f.sessionDirectory)},leaseMs:500,heartbeatMs:100});
c.registerHandler('campaign_loop',async({lifecycle})=>{await lifecycle.checkpoint('durable-work',{effectId:'original-effect'});console.log('READY');await new Promise(()=>{});return {}});await c.runOnce({jobId:${JSON.stringify(job.id)}});`
  const child=Bun.spawn([process.execPath,'--eval',source],{stdout:'pipe',stderr:'pipe'})
  const reader=child.stdout.getReader();let ready=''
  try {while(!ready.includes('READY')){const next=await reader.read();if(next.done)throw new Error(await new Response(child.stderr).text());ready+=new TextDecoder().decode(next.value)}} finally {reader.releaseLock()}
  child.kill('SIGKILL');await child.exited;await Bun.sleep(550)
  const restored=new PiJobController({...f.options,store:new StorageResearchStore({directory:path.join(f.workspace,'research')})})
  let repeated=0
  restored.registerHandler('campaign_loop',async({lifecycle})=>{const saved=await lifecycle.readCheckpoint('durable-work');if(!saved)repeated++;expect(saved).toEqual({effectId:'original-effect'});return {status:'recovered'}})
  const result=await restored.runOnce({jobId:job.id})
  expect(result?.id).toBe(job.id);expect(result?.status).toBe('succeeded');expect(result?.attempts).toBe(1);expect(result?.recoveryCount).toBe(1);expect(repeated).toBe(0)
  expect(result?.checkpoints['host:lifecycle:start'].data.deadlineMs).toBe((await f.controller.get(job.id)).checkpoints['host:lifecycle:start'].data.deadlineMs)
  expect(await restored.runOnce({jobId:job.id})).toBeUndefined()
},10000)

test('expired original deadline can settle observed usage but cannot allocate another provider turn or reset time',async()=>{
  const {createHash}=await import('node:crypto')
  let calls=0
  const f=await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{streamFn:()=>{calls++;throw new Error('Expired grant cannot infer')}}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'expired-deadline',iterations:1})
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  const {createAgentRuntime}=await import('../runtime')
  await createAgentRuntime({store:sessions}).create({id:job.payload.sessionId,metadata:{projectId:f.projectId,experimentId:f.experiment.id,contractHash:f.experiment.contractHash}});sessions.close()
  const jobs=new ResearchJobService.Service(f.store),owner=(await jobs.claim(f.projectId,30000))!,deadlineMs=Date.now()-1
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'host:lifecycle:start',{version:1,payloadHash:createHash('sha256').update(JSON.stringify(owner.payload)).digest('hex'),deadlineMs})
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'pi:job:start',{completedEvaluations:0,costUsd:0,deadlineMs})
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'pi:accounting:start',{jobId:job.id,sessions:{[job.payload.sessionId]:{costUsd:0,existed:true}}})
  await jobs.interrupt(f.projectId,job.id,owner.leaseId!,{reason:'shutdown',detail:'Controller stopped before grant expired'})
  const recovered=await f.controller.runOnce({jobId:job.id})
  expect(recovered?.status).toBe('succeeded');expect(recovered?.result).toMatchObject({reason:'job_deadline_reached',completedEvaluations:0,modelCostUsd:0})
  expect(recovered?.checkpoints['host:lifecycle:start'].data.deadlineMs).toBe(deadlineMs);expect(calls).toBe(0)
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})

test('an unresolved unlaunched scientist intent is held before any recovery SDK initialization',async()=>{
  let calls=0
  const f=await fixture({scientistFactory:()=>inertScientist({completedEvaluations:0,stopped:false,researchRequested:false,pending:{requestId:'prepared-original',programHash:digest('a'),programPath:'trial.py',iteration:1}}),runtimeFactory:()=>{calls++;throw new Error('Unknown intent cannot initialize a session')}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'unlaunched-original',iterations:1})
  const jobs=new ResearchJobService.Service(f.store),owner=(await jobs.claim(f.projectId,30000))!
  await jobs.interrupt(f.projectId,job.id,owner.leaseId!,{reason:'execution_unresolved',detail:'Original intent is pending'})
  const held=await f.controller.reconcile(job.id)
  expect(held.status).toBe('recovery_required');expect(held.error).toContain('no receipt-bound run');expect(calls).toBe(0)
  expect(await Bun.file(path.join(f.sessionDirectory,'sessions.sqlite')).exists()).toBe(false)
})


test('cancelling a job cannot release another compute job past its unresolved original run', async () => {
  let modelCalls = 0
  const f = await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{streamFn:()=>{modelCalls++;throw new Error('Unknown execution must block replacement compute')}}})
  const original = await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'cancelled-unknown-owner',iterations:1})
  const originalOwner = (await new ResearchJobService.Service(f.store).claim(f.projectId,30000,{eligible:job=>job.id===original.id}))!
  const trial = await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:'Original fenced execution',designAdapter:'mock',programPath:'captured.py',programHash:digest('c'),origin:{jobId:original.id,phase:'fixture:original'}},{jobId:original.id,leaseId:originalOwner.leaseId!})
  const run = await f.research.beginRun(f.projectId,trial.id,{bundlePath:'bundle.json',outputPath:'output'})
  await f.controller.cancel(original.id)
  const replacement = await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'replacement-after-cancel',iterations:1})
  expect(await f.controller.runOnce({jobId:replacement.id})).toBeUndefined()
  expect((await f.controller.get(replacement.id)).status).toBe('queued')
  expect((await f.store.read(f.projectId)).runs[run.id]?.status).toBe('queued')
  expect(modelCalls).toBe(0)
})


test('explicit receipt recovery reclaims an expired parent and its expired child under their original identities', async () => {
  const {createHash} = await import('node:crypto')
  let modelCalls = 0
  const f = await fixture({runtimeFactory:()=>{modelCalls++;throw new Error('Saved settlement cannot initialize another agent')}})
  f.controller.registerHandler('campaign_loop',async()=>{throw new Error('Saved parent settlement cannot replay the supervisor')})
  const parent = await f.controller.enqueueJob({idempotencyKey:'expired-tree-parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_expired_tree',maxSteps:1,maximumDurationMs:30000}})
  const jobs = new ResearchJobService.Service(f.store), owner = (await jobs.claim(f.projectId,30000))!
  const child = await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'expired-tree-child',iterations:1,parentJobId:parent.id,parentLeaseId:owner.leaseId!})
  const childOwner = (await jobs.claim(f.projectId,30000,{eligible:job=>job.id===child.id}))!
  const deadlineMs = Date.now()+30000
  for (const job of [owner,childOwner]) await jobs.checkpoint(f.projectId,job.id,job.leaseId!,'host:lifecycle:start',{version:1,payloadHash:createHash('sha256').update(JSON.stringify(job.payload)).digest('hex'),deadlineMs})
  await jobs.checkpoint(f.projectId,child.id,childOwner.leaseId!,'pi:accounting:start',{jobId:child.id,sessions:{[child.payload.sessionId]:{costUsd:0,existed:false}}})
  await jobs.checkpoint(f.projectId,child.id,childOwner.leaseId!,'pi:job:result',{reason:'saved_complete',completedEvaluations:0,modelCostUsd:0})
  await jobs.checkpoint(f.projectId,parent.id,owner.leaseId!,'pi:job:result',{status:'original_complete'})
  await f.store.mutate(f.projectId,state=>{for(const id of [parent.id,child.id])state.jobs[id]!.leaseExpiresAt=new Date(Date.now()-1).toISOString()})
  const completed = await f.controller.reconcile(parent.id)
  expect(completed).toMatchObject({id:parent.id,status:'succeeded',attempts:1,recoveryCount:1,result:{status:'original_complete'}})
  expect(await f.controller.get(child.id)).toMatchObject({status:'succeeded',attempts:1,recoveryCount:1,result:{modelCostUsd:0}})
  expect(completed.checkpoints['host:lifecycle:start'].data.deadlineMs).toBe(deadlineMs)
  expect(modelCalls).toBe(0);expect(await Bun.file(path.join(f.sessionDirectory,'sessions.sqlite')).exists()).toBe(false)
})


test('an independent live session lease holds its job without false failure or another model call', async () => {
  let modelCalls = 0
  const f = await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{streamFn:()=>{modelCalls++;throw new Error('Session is already owned')}}})
  const job = await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'live-session-owner',iterations:1})
  const sessions = createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  const {createAgentRuntime} = await import('../runtime')
  await createAgentRuntime({store:sessions}).create({id:job.payload.sessionId,metadata:{projectId:f.projectId,experimentId:f.experiment.id,contractHash:f.experiment.contractHash}})
  expect(await sessions.acquireLease(job.payload.sessionId,'original-session-owner',30000)).toBe(true)
  try {
    const held = await f.controller.runOnce({jobId:job.id})
    expect(held).toMatchObject({status:'recovery_required',recovery:{reason:'accounting_unresolved'}})
    expect(held?.error).toContain('already running or locked');expect(held?.result).toBeUndefined();expect(modelCalls).toBe(0)
    expect(await sessions.acquireLease(job.payload.sessionId,'replacement-owner',30000)).toBe(false)
  } finally {await sessions.releaseLease(job.payload.sessionId,'original-session-owner');sessions.close()}
})

for (const selected of ['parent','child'] as const) {
  ;(nativeInstalled ? test : test.skip)(`receipt-only recovery selected by ${selected} survives controller SIGKILL during a native CPU evaluation`, async () => {
    const f = await fixture()
    const {CampaignController}=await import('../campaign')
    const campaignController=new CampaignController({...f.options,jobs:f.controller})
    const parent=await campaignController.enqueueCampaign(f.campaign.id,{idempotencyKey:'cpu-crash-parent',experimentId:f.experiment.id,maxSteps:2,maximumTrajectories:2,maximumDiscoveryTrajectories:2,discoveryBatchSize:1,maximumKnowledgeRefreshes:0,maximumDurationMs:60000})
    const engine = path.resolve(import.meta.dir,'..'),core = path.resolve(import.meta.dir,'../../../science-core/src/research')
    const proto = {root:nativeRoot,python:nativePython,languageCommit:await commit(nativeRoot),toolsCommit:await commit(path.join(nativeRoot,'proto-tools'))}
    const marker = path.join(f.workspace,'cpu-receipt-ready.json')
    const source = `
import fs from 'node:fs/promises';
import path from 'node:path';
import {StorageResearchStore} from ${JSON.stringify(path.join(core,'store.ts'))};
import {ResearchService} from ${JSON.stringify(path.join(core,'service.ts'))};
import {ScientificExecution,LocalWorkerTransport} from ${JSON.stringify(path.join(engine,'execution/index.ts'))};
import {PiJobController} from ${JSON.stringify(path.join(engine,'jobs/index.ts'))};
import {CampaignController} from ${JSON.stringify(path.join(engine,'campaign/index.ts'))};
import {DEFAULT_MODEL} from ${JSON.stringify(path.join(engine,'runtime/index.ts'))};
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
const workspace=${JSON.stringify(f.workspace)},projectId=${JSON.stringify(f.projectId)};
const store=new StorageResearchStore({directory:${JSON.stringify(path.join(f.workspace,'research'))}}),research=new ResearchService.Service(store),local=new LocalWorkerTransport();
const execution=new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},workspace,projectId,research,proto:${JSON.stringify(proto)},authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1},transport:{kind:'local',dispatch:async input=>{
 const result=await local.dispatch(input);if(result.status!=='succeeded')throw new Error(result.error);
 const saved=input.outputPath+'.completed-cpu';await fs.rename(input.outputPath,saved);
 await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({runId:input.runId,outputPath:input.outputPath,saved}));
 console.log('CPU_RECEIPT_READY');await new Promise(()=>{});return result;
}}});
let turns=0;
const c=new PiJobController({workspace,projectId,store,research,execution,sessionDirectory:${JSON.stringify(f.sessionDirectory)},leaseMs:500,heartbeatMs:100,runtimeOptions:{leaseDurationMs:500,leaseHeartbeatMs:100,streamFn:()=>{
 const content=turns++===0?[{type:'toolCall',id:'write-original',name:'write',arguments:{path:'trial.py',content:${JSON.stringify(program(f.experiment.id,'Crash recovery CPU fixture'))}}}]:[{type:'toolCall',id:'evaluate-original',name:'evaluate_trial',arguments:{requestId:'original-cpu-crash'}}];
 const message={role:'assistant',content,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',usage:{input:2,output:2,cacheRead:0,cacheWrite:0,totalTokens:4,cost:{input:0.01,output:0,cacheRead:0,cacheWrite:0,total:0.01}}};
 const output=createAssistantMessageEventStream();output.push({type:'start',partial:message});output.push({type:'done',reason:'toolUse',message});output.end(message);return output;
}}});
const campaignController=new CampaignController({workspace,projectId,store,research,execution,jobs:c,sessionDirectory:${JSON.stringify(f.sessionDirectory)},propose:async()=>{throw new Error('CPU recovery fixture cannot invoke a supervisor')}});
c.registerHandler('campaign_loop',campaignController.handleJob);
await c.runOnce({jobId:${JSON.stringify(parent.id)}});`
    const child = Bun.spawn([process.execPath,'--eval',source],{cwd:path.resolve(import.meta.dir,'../../../..'),stdout:'pipe',stderr:'pipe'})
    const readOutput = new Response(child.stdout).text(),readError = new Response(child.stderr).text()
    try {
      const until=Date.now()+30000
      while (!await Bun.file(marker).exists()) {
        if(child.exitCode!==null)throw new Error(`CPU fixture exited: ${await readOutput}\n${await readError}`)
        if(Date.now()>until)throw new Error('CPU receipt marker did not arrive')
        await Bun.sleep(25)
      }
      child.kill('SIGKILL');expect(await child.exited).toBe(137);await Bun.sleep(600)
    } finally {
      if(child.exitCode===null){child.kill('SIGKILL');await child.exited}
      await Promise.all([readOutput,readError])
    }
    const before = await f.store.read(f.projectId)
    const originalChild = Object.values(before.jobs).find(j=>j.payload.parentJobId===parent.id)!
    const originalRun = Object.values(before.runs)[0]!
    expect(originalChild.status).toBe('running');expect(before.jobs[parent.id]!.status).toBe('running')
    expect(originalRun.status).toBe('running');expect(Object.values(before.evaluations)).toHaveLength(0)
    const sessionStore = createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
    const interrupted = await sessionStore.get(originalChild.payload.sessionId)
    expect(interrupted?.pendingTools['evaluate-original']?.name).toBe('evaluate_trial')
    const usageBefore = interrupted!.usage
    sessionStore.close()
    // Receipt recovery remains allowed after spending authority expires; no new turn or compute may follow.
    await f.store.mutate(f.projectId,state=>{for(const job of Object.values(state.jobs)){
      job.checkpoints['host:lifecycle:start']!.data.deadlineMs=Date.now()-1
      if(job.checkpoints['campaign:job:start'])job.checkpoints['campaign:job:start']!.data.deadlineMs=Date.now()-1
    }})
    let dispatches=0,modelCalls=0,collections=0
    const saved=await Bun.file(marker).json()
    const execution=new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},workspace:f.workspace,projectId:f.projectId,research:f.research,proto,
      authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1},
      transport:{kind:'local',dispatch:async()=>{dispatches++;throw new Error('Recovery cannot dispatch')},reconcile:async input=>{
        expect(input.runId).toBe(originalRun.id);expect(input.allowFirstRemoteLaunch).toBe(false);expect(input.authorizeStart).toBeUndefined()
        collections++;await fs.rename(saved.saved,saved.outputPath);return {status:'succeeded'}
      }},
    })
    const restored=new PiJobController({...f.options,execution,runtimeOptions:{streamFn:()=>{modelCalls++;throw new Error('Recovery cannot infer')}}})
    const campaignRecovery=new CampaignController({...f.options,execution,jobs:restored,propose:async()=>{modelCalls++;throw new Error('Recovery cannot invoke a supervisor')}})
    restored.registerHandler('campaign_loop',campaignRecovery.handleJob)
    await restored.reconcile(selected==='parent'?parent.id:originalChild.id)
    const after=await f.store.read(f.projectId),settled=after.jobs[originalChild.id]!
    expect(settled.status).toBe('succeeded');expect(settled.attempts).toBe(1);expect(settled.recoveryCount).toBe(1)
    expect(settled.result).toMatchObject({completedEvaluations:1,modelCostUsd:usageBefore.costUsd,consumedTrajectories:1})
    expect(after.jobs[parent.id]?.status).toBe('succeeded')
    expect(after.jobs[parent.id]?.result).toMatchObject({status:'deferred',boundary:'campaign_deadline_reached',completedSteps:1,modelCostUsd:usageBefore.costUsd,remainingTrajectories:1,remainingDiscoveryTrajectories:1})
    expect(after.runs[originalRun.id]?.status).toBe('succeeded')
    expect(Object.keys(after.jobs).sort()).toEqual(Object.keys(before.jobs).sort())
    expect(Object.keys(after.trials)).toEqual(Object.keys(before.trials));expect(Object.keys(after.runs)).toEqual(Object.keys(before.runs))
    expect(Object.values(after.evaluations)).toHaveLength(1);expect(Object.values(after.knowledgeCycles)).toHaveLength(0)
    expect(await ResearchScientistMemory.read(f.workspace,f.experiment.id)).toHaveLength(0)
    expect(ResearchTrajectoryCloseout.events(after, [], f.experiment.id)).toHaveLength(1)
    const receipt=await execution.artifacts(originalRun.id)
    expect(receipt.run.manifestHash).toBeTruthy();expect(receipt.scientific).toBe(false)
    const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
    const recovered=await sessions.get(originalChild.payload.sessionId)
    expect(recovered?.pendingTools).toEqual({});expect(recovered?.usage).toEqual(usageBefore)
    expect(recovered?.messages.some(m=>m.role==='toolResult'&&m.toolCallId==='evaluate-original')).toBe(true)
    const events=await sessions.events(originalChild.payload.sessionId)
    expect(events.filter(e=>e.type==='turn_start')).toHaveLength(2);sessions.close()
    expect(dispatches).toBe(0);expect(modelCalls).toBe(0);expect(collections).toBe(1)
    expect((await restored.reconcile(originalChild.id)).status).toBe('succeeded');expect(collections).toBe(1)
  },120000)
}


test('child lease polling interrupts outstanding work when its ancestor loses ownership', async () => {
  const f=await fixture(),jobs=new ResearchJobService.Service(f.store)
  const parent=await f.controller.enqueueJob({idempotencyKey:'poll-tree-parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_poll_parent',maxSteps:1}})
  const parentOwner=(await jobs.claim(f.projectId,30000,{eligible:job=>job.id===parent.id}))!
  const child=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'poll-tree-child',iterations:1,parentJobId:parent.id,parentLeaseId:parentOwner.leaseId})
  const childOwner=(await jobs.claim(f.projectId,30000,{eligible:job=>job.id===child.id}))!
  const owner=new JobLease({jobs,projectId:f.projectId,job:childOwner,leaseMs:30000,heartbeatMs:10000,cancelPollMs:10})
  owner.start()
  try {
    const pending=owner.wait(new Promise<void>(()=>{}))
    await f.store.mutate(f.projectId,state=>{state.jobs[parent.id]!.leaseExpiresAt=new Date(Date.now()-1).toISOString()})
    await expect(pending).rejects.toBeInstanceOf(JobInterrupted)
    expect(owner.interruption?.reason).toBe('lease_lost')
    expect(owner.interruption?.message).toContain(parent.id)
    expect(owner.controller.signal.aborted).toBe(true)
  } finally {await owner.close()}
})


test('worker survives a transient admission-store failure with visible degradation and no duplicate job', async () => {
  const f=await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{limits:{maxTurns:1},streamFn:script(message([{type:'text',text:'Stop after context.'}]))}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'transient-admission',iterations:1})
  const original=f.store.mutate.bind(f.store), shutdown=new AbortController()
  let inject=true, degraded!:()=>void, resumed!:()=>void
  const failure=new Promise<void>(resolve=>{degraded=resolve}), success=new Promise<void>(resolve=>{resumed=resolve})
  f.store.mutate=async (project,fn)=>{
    if (inject) {inject=false;degraded();throw new Error('Injected one-shot SQLite admission failure')}
    const result=await original(project,fn)
    if ((await f.controller.get(job.id)).status==='succeeded') {resumed();shutdown.abort()}
    return result
  }
  const worker=f.controller.runWorker({signal:shutdown.signal,pollMs:1})
  try {
    await failure
    // Let the failed admission iteration publish its status before reading it.
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(f.controller.workerState).toMatchObject({status:'degraded',consecutiveFailures:1,lastError:'Injected one-shot SQLite admission failure'})
    expect((await f.controller.get(job.id)).attempts).toBe(0)
    await success;await worker
    expect(f.controller.workerState).toMatchObject({status:'stopped',consecutiveFailures:0})
    expect((await f.controller.get(job.id)).attempts).toBe(1)
    expect((await f.controller.list()).map(job=>job.id)).toEqual([job.id])
  } finally {shutdown.abort();await worker;f.store.mutate=original}
})


test('ancestor revocation at the provider boundary dispatches no request and spends no model turn', async () => {
  let providerCalls=0, boundaryChecks=0, parentId=''
  const f=await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{
    streamFn:()=>{providerCalls++;throw new Error('Revoked child must not dispatch a provider request')},
    authorizeModelRequest:async()=>{boundaryChecks++;await f.store.mutate(f.projectId,state=>{state.jobs[parentId]!.leaseExpiresAt=new Date(Date.now()-1).toISOString()})},
  }})
  const jobs=new ResearchJobService.Service(f.store)
  const parent=await f.controller.enqueueJob({idempotencyKey:'provider-boundary-parent',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_boundary_parent',maxSteps:1}})
  parentId=parent.id
  const parentOwner=(await jobs.claim(f.projectId,30000,{eligible:job=>job.id===parent.id}))!
  const child=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'provider-boundary-child',iterations:1,parentJobId:parent.id,parentLeaseId:parentOwner.leaseId})
  const result=await f.controller.runOnce({jobId:child.id})
  expect(result?.status).toBe('interrupted');expect(result?.recovery?.reason).toBe('lease_lost')
  expect(providerCalls).toBe(0);expect(boundaryChecks).toBe(1)
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  try {const session=await sessions.get(child.payload.sessionId);expect(session?.usage.turns).toBe(0);expect(session?.modelRequests??{}).toEqual({})}
  finally {sessions.close()}
})


test('cancelled queued operation settles its no-effect axis without changing native cancellation or invoking handlers', async () => {
  let calls=0
  const f=await fixture({runtimeOptions:{streamFn:()=>{calls++;throw new Error('Cancellation never dispatches')}}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'cancelled-no-effect-settlement',iterations:1})
  await f.controller.cancel(job.id)
  const result=await f.controller.reconcileDetailed(job.id)
  expect(result.job.status).toBe('cancelled');expect(result.job.leaseId).toBeUndefined();expect(result.outcomes[job.id]?.kind).toBe('complete')
  const canonical=await f.controller.operations.read(f.projectId,`op_job_${job.id.slice(4)}`)
  expect(canonical?.cancelledAt).toBeTruthy();expect(canonical?.settlement).toBe('settled');expect(canonical?.state.result).toMatchObject({modelCostUsd:0,consumedTrajectories:0})
  await expect(f.controller.operations.acquire(f.projectId,canonical!.id,{mode:'run',leaseMs:30000})).rejects.toThrow()
  expect(calls).toBe(0)
  const accounting=await (await import('./accounting')).readJobAccounting(f.options,result.job)
  expect(accounting.modelCostUsd).toBe(0);expect(accounting.consumedTrajectories).toBe(0)
  expect(canonical?.effect).toBe('none')
})

test('receipt-only planner leaves queued original state byte-equivalent and lists root before owned descendants', async () => {
  const f=await fixture(),parent=await f.controller.enqueueJob({idempotencyKey:'planner-original-root',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_plan_root',maxSteps:1}})
  const before=await f.store.read(f.projectId),queued=await f.controller.reconcileDetailed(parent.id)
  expect(queued.outcomes[parent.id]).toEqual({kind:'incomplete',boundary:'queued_not_admitted'});expect(await f.store.read(f.projectId)).toEqual(before)
  const jobs=new ResearchJobService.Service(f.store),owner=(await jobs.claim(f.projectId,30000,{eligible:job=>job.id===parent.id}))!
  const child=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'planner-child',iterations:1,parentJobId:parent.id,parentLeaseId:owner.leaseId})
  await jobs.interrupt(f.projectId,parent.id,owner.leaseId!,{reason:'shutdown',detail:'Original ownership interrupted'})
  const plan=await f.controller.planRecovery(child.id)
  expect(plan.rootJobId).toBe(parent.id);expect(plan.orderedJobIds).toEqual([parent.id,child.id]);expect(plan.mode).toBe('receipt_only')
})


test('canonical native diagnostics follow successful lifecycle with independent known settlement axes',async()=>{
  const f=await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{limits:{maxTurns:1},streamFn:script(message([{type:'text',text:'Read original context.'}]))}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'native-settlement-diagnostics',iterations:1})
  const result=await f.controller.runOnce({jobId:job.id});expect(result?.status).toBe('succeeded')
  const record=await f.controller.operations.read(f.projectId,`op_job_${job.id.slice(4)}`)
  expect(record).toMatchObject({phase:'succeeded',accounting:'settled',settlement:'settled',outcome:'succeeded'})
  expect(record?.owner).toBeUndefined();expect(record?.state.result).toMatchObject({modelCostUsd:0,consumedTrajectories:0})
})


test('typed original receipt recovery preserves an older immutable result checkpoint and never reenters run',async()=>{
  const f=await fixture(),jobs=new ResearchJobService.Service(f.store);let runCalls=0,recoveryCalls=0
  f.controller.registerOperation('campaign_loop',{inspect:async()=>({effects:[],accounting:[],blockers:[]}),recover:async()=>{recoveryCalls++;return {kind:'complete',receiptIds:['verified_original'],result:{status:'saved_original',verified:true,modelCostUsd:0}}},run:async()=>{runCalls++;throw new Error('Recovery cannot invoke ordinary run')}})
  const job=await f.controller.enqueueJob({idempotencyKey:'old-result-typed-recovery',payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_old_result',maxSteps:1}})
  const owner=(await jobs.claim(f.projectId,30000,{eligible:candidate=>candidate.id===job.id}))!
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'host:lifecycle:start',{version:1,payloadHash:(await import('node:crypto')).createHash('sha256').update(JSON.stringify(owner.payload)).digest('hex'),deadlineMs:Date.now()+30000})
  const original={status:'saved_original'};await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'pi:job:result',original)
  await jobs.interrupt(f.projectId,job.id,owner.leaseId!,{reason:'shutdown',detail:'Stopped after original result checkpoint'})
  const result=await f.controller.reconcileDetailed(job.id)
  expect(result.job.status).toBe('succeeded');expect(result.job.result).toMatchObject({verified:true,modelCostUsd:0});expect(result.job.checkpoints['pi:job:result']?.data).toEqual(original)
  expect(Object.keys(result.job.checkpoints).some(phase=>phase.startsWith('host:receipt-recovery:'))).toBe(true);expect(runCalls).toBe(0);expect(recoveryCalls).toBe(1)
})

for(const terminalStatus of ['failed','cancelled'] as const)test(`typed ${terminalStatus} receipt closes native recovery without success or retry`,async()=>{
  const f=await fixture(),jobs=new ResearchJobService.Service(f.store);let runs=0,recoveries=0
  const original={reason:'authoring_finished_without_scientific_dispatch',modelCostUsd:0,consumedTrajectories:0}
  f.controller.registerOperation('campaign_loop',{
    inspect:async()=>({effects:[],accounting:[],blockers:[]}),
    recover:async()=>{recoveries++;return {kind:'complete',terminalStatus,error:'Known original authoring end',receiptIds:['original_failure_receipt'],result:original}},
    run:async()=>{runs++;throw new Error('Terminal recovery must not author or dispatch')},
  })
  const job=await f.controller.enqueueJob({idempotencyKey:'terminal-receipt-'+terminalStatus,payload:{kind:'campaign_loop',campaignId:f.campaign.id,sessionId:'ses_terminal_'+terminalStatus,maxSteps:1}})
  const owner=(await jobs.claim(f.projectId,30000,{eligible:candidate=>candidate.id===job.id}))!
  await jobs.checkpoint(f.projectId,job.id,owner.leaseId!,'host:lifecycle:start',{version:1,payloadHash:(await import('node:crypto')).createHash('sha256').update(JSON.stringify(owner.payload)).digest('hex'),deadlineMs:Date.now()+30000})
  await jobs.interrupt(f.projectId,job.id,owner.leaseId!,{reason:'shutdown',detail:'Interrupted after original terminal evidence'})
  const recovered=(await f.controller.reconcileDetailed(job.id)).job
  expect(recovered).toMatchObject({status:terminalStatus,attempts:1,result:original,error:'Known original authoring end'})
  expect(recovered.nextAttemptAt).toBeUndefined();expect(recovered.leaseId).toBeUndefined()
  expect(recovered.checkpoints['host:receipt-terminal']?.data).toMatchObject({status:terminalStatus,receiptIds:['original_failure_receipt']})
  expect(runs).toBe(0);expect(recoveries).toBe(1)
  const again=await f.controller.reconcileDetailed(job.id)
  expect(again.job.status).toBe(terminalStatus);expect(runs).toBe(0);expect(recoveries).toBe(1)
})


test('explicit Pi request limits terminate one prompt without an automatic restart',async()=>{
  let requests=0
  const f=await fixture({scientistFactory:()=>({...inertScientist(),tools:()=>[{name:'inspect',label:'Inspect',description:'Offline diagnostic',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:'Still diagnosing'}],details:{}})}]}),runtimeOptions:{limits:{maxTurns:2},streamFn:()=>stream(message([call('bounded-'+(++requests),'inspect')],'toolUse'))}})
  const job=await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'one-request-grant',iterations:1})
  const result=await f.controller.runOnce({jobId:job.id})
  expect(requests).toBe(2);expect(result?.result).toMatchObject({reason:'runtime_limit_reached',completedEvaluations:0})
  expect(result?.checkpoints['pi:turn:2:intent']).toBeUndefined()
})

test('retired authoring policies are rejected on fresh admission instead of silently weakening a limit',async()=>{
  const f=await fixture()
  await expect(f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'retired-policy',iterations:1,maximumNoProgressAttempts:3})).rejects.toThrow('Authoring-attempt policies are retired')
  expect(Object.values((await f.store.read(f.projectId)).jobs)).toHaveLength(0)
})

;(nativeInstalled?test:test.skip)('one real Pi loop repairs a rejected native draft beyond 48 turns and evaluates its original CPU trial',async()=>{
  const f=await fixture(),local=new LocalWorkerTransport()
  const execution=new ScientificExecution({inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},workspace:f.workspace,projectId:f.projectId,research:f.research,
    proto:{root:nativeRoot,python:nativePython,languageCommit:await commit(nativeRoot),toolsCommit:await commit(path.join(nativeRoot,'proto-tools'))},
    authorization:{localProto:true,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1},transport:local})
  let requests=0
  const controller=new PiJobController({...f.options,execution,runtimeOptions:{streamFn:(_model,context)=>{
    const i=requests++
    if(i===0)return stream(message([call('broken-draft','write',{path:'trial.py',content:'from proto_language.constraint import ProteinLengthConfig\ndef build_trial(ctx):\n    return None\n'})],'toolUse'))
    if(i===1)return stream(message([call('diagnose-import','validate_trial')],'toolUse'))
    if(i===2){const last=context.messages.findLast(m=>m.role==='toolResult');expect(JSON.stringify(last)).toContain('ProteinLengthConfig')}
    if(i>=2&&i<54)return stream(message([call('inspect-'+i,'read',{path:'API.md',limit:1})],'toolUse'))
    if(i===54)return stream(message([call('fixed-draft','write',{path:'trial.py',content:program(f.experiment.id,'Repaired bounded native CPU panel')})],'toolUse'))
    if(i===55)return stream(message([call('validate-repair','validate_trial')],'toolUse'))
    if(i===56){expect((context.messages.findLast(m=>m.role==='toolResult') as any)?.details?.valid).toBe(true);return stream(message([call('evaluate-original','evaluate_trial',{requestId:'one-agent-repaired-trial'})],'toolUse'))}
    throw new Error('Host must not restart the agent')
  }}})
  const job=await controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'long-single-agent-repair',iterations:1})
  const result=await controller.runOnce({jobId:job.id})
  expect(result).toMatchObject({status:'succeeded'})
  expect(result?.result).toMatchObject({reason:'iteration_limit_reached',completedEvaluations:1})
  expect(requests).toBe(57);expect(result?.checkpoints['pi:turn:2:intent']).toBeUndefined()
  const db=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite')),events=await db.events(job.payload.sessionId)
  expect(events.filter(e=>e.type==='run_started')).toHaveLength(1)
  db.close()
  const state=await f.store.read(f.projectId)
  expect(Object.values(state.runs)).toHaveLength(1);expect(Object.values(state.evaluations)).toHaveLength(1)
},60000)


test('rejected discovery admission and idempotency conflict leave scientist ownership unchanged', async () => {
  const f = await fixture()
  const before = await f.store.read(f.projectId)
  await expect(f.controller.enqueueDiscovery(f.experiment.id, {idempotencyKey:'rejected-child-binding', iterations:1,
    sessionId:'ses_rejected_binding', parentJobId:'job_absent', parentLeaseId:'absent-lease'})).rejects.toMatchObject({data:{code:'parent_job_fence'}})
  expect(await f.store.read(f.projectId)).toEqual(before)
  const job = await f.controller.enqueueDiscovery(f.experiment.id, {idempotencyKey:'actual-scientist', iterations:1, sessionId:'ses_actual_scientist'})
  const bound = await f.store.read(f.projectId)
  await expect(f.controller.enqueueDiscovery(f.experiment.id, {idempotencyKey:'actual-scientist', iterations:2})).rejects.toMatchObject({data:{code:'idempotency_key_reused'}})
  expect(await f.store.read(f.projectId)).toEqual(bound)
  expect(bound.experiments[f.experiment.id].piScientistSessionId).toBe(job.payload.sessionId)
})

test('concurrent discovery admission admits only the scientist matching the durable binding', async () => {
  const f = await fixture()
  const results = await Promise.allSettled(['ses_one','ses_two'].map(sessionId => f.controller.enqueueDiscovery(f.experiment.id,
    {idempotencyKey:sessionId, iterations:1, sessionId})))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const state = await f.store.read(f.projectId), jobs = Object.values(state.jobs)
  expect(jobs).toHaveLength(1)
  expect(state.experiments[f.experiment.id].piScientistSessionId).toBe(jobs[0].payload.sessionId)
})

test('queued followup cancellation settles zero against an already attributed scientist transcript', async () => {
  const f = await fixture({scientistFactory:()=>inertScientist(),runtimeOptions:{limits:{maxTurns:1},streamFn:script(message([{type:'text',text:'Offline prior reasoning receipt.'}],'stop',.125))}})
  const prior = await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'prior-shared-receipt',iterations:1})
  const first = await f.controller.runOnce({jobId:prior.id})
  expect(first?.status).toBe('succeeded');expect(first?.result?.modelCostUsd).toBe(.125)
  const queued = await f.controller.enqueueDiscovery(f.experiment.id,{idempotencyKey:'unadmitted-shared-followup',iterations:1})
  expect(queued.payload.sessionId).toBe(prior.payload.sessionId)
  await f.controller.cancel(queued.id)
  const original = await f.controller.reconcileDetailed(queued.id)
  expect(original.outcomes[queued.id]).toMatchObject({kind:'complete',result:{reason:'cancelled_before_admission',modelCostUsd:0,consumedTrajectories:0}})
  expect((await (await import('./accounting')).readJobAccounting(f.options,original.job)).modelCostUsd).toBe(0)
  const sessions = createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  try {expect((await sessions.get(prior.payload.sessionId))?.usage.costUsd).toBe(.125)} finally {sessions.close()}
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})


test('terminal discovery results publish the exact original reported accounting separately from estimates', async () => {
  for (const reported of [0, .03]) {
    const f = await fixture({scientistFactory: () => inertScientist(), runtimeOptions: {limits:{maxTurns:1},requireProviderReportedUsage: true,
      streamFn: async (model, _context, options) => {
        await options!.onProviderStreamEvent!({id: 'gen_original_' + reported, provider: 'offline_route', choices:[{finish_reason:'stop'}], usage: {cost: reported}}, model)
        return stream(message([{type: 'text', text: 'Original completed response'}], 'stop', .1))
      }}})
    const job = await f.controller.enqueueDiscovery(f.experiment.id, {idempotencyKey: 'original_billing_' + reported, iterations: 1})
    const result = await f.controller.runOnce({jobId: job.id})
    expect(result?.status).toBe('succeeded'); expect(result?.result?.modelCostUsd).toBeCloseTo(.1)
    expect(result?.result?.providerAccounting).toMatchObject({status: 'reported', reportedCostUsd: reported, knownReportedCostUsd: reported, upstreamRequestIds: ['gen_original_' + reported], unknownRequestIds: []})
    const settlement = Object.entries(result!.checkpoints).find(([key]) => key.startsWith('pi:accounting:settlement:'))![1].data
    expect(result!.result!.providerAccounting).toEqual(settlement.providerAccounting)
    const {acceptanceCostSummary} = await import('../acceptance')
    expect(acceptanceCostSummary(result!.result)).toMatchObject({sdkEstimatedModelCostUsd: .1, providerReportedModelCostUsd: reported, actualModelCostUsd: reported})
    expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
  }
})


test('terminal parent projection preserves its trusted owned-tree reported receipts rather than substituting the supervisor bill', async () => {
  const f = await fixture(), tree = {status: 'reported', reportedCostUsd: .05, knownReportedCostUsd: .05, originalRequestIds: ['child_session:original_request'], upstreamRequestIds: ['gen_original_child'], unknownRequestIds: []}
  f.controller.registerHandler('campaign_loop', async () => ({modelCostUsd: .2, providerAccounting: tree}))
  const job = await f.controller.enqueueJob({idempotencyKey: 'owned_tree_projection', payload: {kind: 'campaign_loop', campaignId: f.campaign.id, sessionId: 'ses_unadmitted_supervisor', maxSteps: 1}})
  const result = await f.controller.runOnce({jobId: job.id})
  expect(result?.status).toBe('succeeded'); expect(result?.result?.providerAccounting).toEqual(tree)
  expect(result?.result?.modelCostUsd).toBeCloseTo(.2)
})
