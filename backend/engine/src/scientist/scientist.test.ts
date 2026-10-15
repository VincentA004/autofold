import {nativeFixtureRoot} from '../execution/native-fixture'
import {ScientistAuthority} from './authority'
import {FrozenTargetReferences,FrozenTargetPublicationError} from './target-references'
import {CampaignSkillService} from '../skills/service'
import {createAssistantMessageEventStream,type AssistantMessage,type ToolCall} from '@earendil-works/pi-ai'
import {DEFAULT_MODEL} from '../runtime'
import {createHash} from 'node:crypto'
import {PiRuntime, MemorySessionStore} from '../runtime'
import {Value} from 'typebox/value'
import { ResearchJobService } from '@autofold/science-core/job-service'
import { PI_JOB_RUNTIME } from '../jobs'
import {afterEach, expect, spyOn, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchArtifacts } from '@autofold/science-core/artifacts'
import { ResearchPrograms } from '@autofold/science-core/programs'
import { StorageResearchStore } from '@autofold/science-core/store'
import { ResearchScientistKernel } from '@autofold/science-core/scientist-kernel'
import { ResearchScientistMemory } from '@autofold/science-core/scientist-memory'
import { ResearchTrajectoryCloseout } from '@autofold/science-core/trajectory-closeout'
import { ScientificExecution, LocalWorkerTransport, ReceiptUnresolvedError, type ExecutionTransport } from '../execution'
import { ScientistLane, type ScientistLifecycle } from './index'
import z from 'zod'
import { TrialReasoning } from '@autofold/science-core/trial-reasoning'
import { ExecutionPreflightUnavailableError } from '../execution/errors'
import { HostCapabilitiesUnavailableError } from '../execution/capabilities'
import {operationHash} from '@autofold/science-core/operations'
import {toolProjectionBytes} from '../runtime/artifacts'
const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
const nativeRoot = nativeFixtureRoot
const nativePython = path.resolve(import.meta.dir, '../../../../.autofold/envs/proto/bin/python')
const nativeInstalled = await Promise.all([fs.access(nativePython), fs.access(path.join(nativeRoot, 'proto-tools'))]).then(() => true, () => false)
async function commit(directory: string) {
  const child = Bun.spawn(['git', '-C', directory, 'rev-parse', 'HEAD'], {stdout: 'pipe', stderr: 'pipe'})
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code) throw new Error('Cannot pin native CPU fixture')
  return stdout.trim()
}

/** Canonical, receipt-bound failed software outcome; no worker or model is invoked. */
async function settledStopEvidence(f:{projectId:string;research:ResearchService.Service;experiment:{id:string}}){
 const trial=await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:'Offline settled failure fixture',designAdapter:'mock',programPath:'fixture.py',programHash:'sha256:'+'b'.repeat(64)})
 const run=await f.research.beginRun(f.projectId,trial.id,{bundlePath:'fixture/bundle.json',outputPath:'fixture/output'})
 await f.research.failRun(f.projectId,run.id,'Verified offline fixture outcome',undefined,{failureReceiptHash:'sha256:'+'f'.repeat(64)})
 return run.id
}

async function fixture(options: {transport?: ExecutionTransport; lifecycle?: ScientistLifecycle; native?: boolean; maximumEvaluations?: number; target?: {artifact: ResearchArtifacts.TargetArtifact; structure?: Uint8Array}} = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'scientist-lane-')); roots.push(workspace)
  const projectId = 'scientist_offline'
  const store = new StorageResearchStore({directory: path.join(workspace, 'store')})
  const research = new ResearchService.Service(store)
  const proto = options.native ? {root: nativeRoot, python: nativePython, languageCommit: await commit(nativeRoot), toolsCommit: await commit(path.join(nativeRoot, 'proto-tools'))} : undefined
  const execution = new ScientificExecution({workspace, projectId, research, proto, transport: options.transport, inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},
    authorization: {localProto: !!proto, maximumGpuSeconds: 0, maximumCandidates: 8, maximumWallTimeMinutes: 1}})
  const target = options.target && await ResearchArtifacts.authorTarget(workspace,options.target.artifact,options.target.structure)
  const evaluator = (await execution.evaluators())[0]!
  const campaign = await research.createCampaign(projectId, {objective: 'CPU scientist plumbing acceptance'})
  await research.activateCampaign(projectId, campaign.id)
  const experiment = await research.createExperiment(projectId, campaign.id, {contract: {version: 1, objective: 'CPU heuristic only',
    targetArtifactHash: target?.targetArtifactHash ?? 'sha256:' + 'a'.repeat(64), modality: 'short_peptide', budget: {maximumCandidates: 8, gpuHours: 0, wallTimeMinutes: 1},
    evaluator: {...evaluator, fixedSeeds: [7, 11], submissionSize: 3}}})
  await research.activateExperiment(projectId, experiment.id)
  const optionsBase = {workspace, projectId, experimentId: experiment.id, sessionId: 'ses_cpu_scientist', research, store, execution,
    maximumEvaluations: options.maximumEvaluations ?? 2, lifecycle: options.lifecycle}
  const lane = new ScientistLane(optionsBase)
  await lane.initialize()
  return {workspace, projectId, store, research, execution, experiment, campaign, lane, optionsBase}
}
/** These old checkpoint compatibility fixtures now seed the canonical authority, not its JSON export. */
async function fixtureState(f:Awaited<ReturnType<typeof fixture>>,file:string,value:any){
 const authority=new ScientistAuthority(f.optionsBase);await authority.read();const revision=await authority.save(value)
 await Bun.write(file,JSON.stringify({...value,authorityRevision:revision}))
}
async function stopLifecycle(f: Awaited<ReturnType<typeof fixture>>) {
  let now = Date.parse('2026-01-01T00:00:00.000Z')
  const jobs = new ResearchJobService.Service(f.store, {now: () => new Date(now).toISOString()})
  const job = await jobs.enqueue(f.projectId, {idempotencyKey: 'stop-recovery', payload: {kind: 'autoresearch', runtime: PI_JOB_RUNTIME,
    experimentId: f.experiment.id, sessionId: f.optionsBase.sessionId, iterations: 1, agent: 'ml'}})
  let claimed = (await jobs.claim(f.projectId, 30000))!
  await jobs.checkpoint(f.projectId, job.id, claimed.leaseId!, 'host:lifecycle:start', {version:1,payloadHash:createHash('sha256').update(JSON.stringify(job.payload)).digest('hex'),deadlineMs:now+600000})
  const lifecycle = (): ScientistLifecycle => {
    const leaseId = claimed.leaseId!
    const checkCancelled = async () => {
      const current = await jobs.get(f.projectId, job.id)
      if (current.status !== 'running' || current.leaseId !== leaseId) throw new Error('Stop fixture lease lost')
    }
    return {checkCancelled, readCheckpoint: async phase => {await checkCancelled(); return (await jobs.get(f.projectId, job.id)).checkpoints[phase]?.data},
      checkpoint: (phase, data) => jobs.checkpoint(f.projectId, job.id, leaseId, phase, data as Record<string, unknown>)}
  }
  return {job, jobs, lifecycle, reclaim: async () => {now += 31000; claimed = (await jobs.claim(f.projectId, 30000))!; return lifecycle()},
    checkpoints: async () => Object.fromEntries(Object.entries((await jobs.get(f.projectId, job.id)).checkpoints).filter(([phase])=>!phase.startsWith('host:')))}
}
function plan(evidenceRefs: string[] = []) {return {question: 'Does this bounded program provide a reproducible heuristic panel?',
  alternatives: [{id: 'run', experiment: 'Evaluate the edited bounded program', expectedInformation: 'Obtain locked heuristic result', estimatedGpuHours: 0},
    {id: 'stop', experiment: 'Inspect saved evidence and stop', expectedInformation: 'Avoid redundant compute', estimatedGpuHours: 0}], selectedAlternativeId: 'run',
  rationale: 'The file represents the declared intervention', evidenceRefs,
  outcomeBranches: [{observation: 'Valid panel', nextDecision: 'Inspect the score and generation receipt'}, {observation: 'Invalid panel', nextDecision: 'Repair the exact workflow failure'}]}}
function program(options: {evidenceRefs?: string[]; intent?: string; decision?: boolean; minimumDiversity?: number; prediction?: unknown; decisionPlan?: unknown} = {}) {
  const declaration = {intent: options.intent ?? 'optimize', ...(options.decision === false ? {} : {decisionPlan: options.decisionPlan ?? plan(options.evidenceRefs)}),
    evidenceRefs: options.evidenceRefs ?? [], ...(options.prediction ? {prediction: options.prediction} : {})}
  const literal = JSON.stringify(declaration).replaceAll('true', 'True').replaceAll('false', 'False').replaceAll('null', 'None')
  return ResearchPrograms.templates().proto.replace('min_diversity=0.4', 'min_diversity=' + (options.minimumDiversity ?? 0.4)) + `\nfrom autofold_worker.proto_trial import ProtoTrial\nDECLARATION = ${literal}\ndef build_trial(ctx):\n    return ProtoTrial(program=_build_program(ctx), search=_native_search(ctx), hypothesis="Bounded CPU panel exposes the authored diversity intervention", intent=DECLARATION["intent"], decision_plan=DECLARATION.get("decisionPlan"), evidence_refs=tuple(DECLARATION.get("evidenceRefs", [])), prediction=DECLARATION.get("prediction"))\n`
}
test('authoring API documents the actual Python TrialContext fields and worker entry points', async () => {
  const f = await fixture(), api = (await f.lane.readFile({path: 'API.md', limit: 200})).content
  const worker = path.resolve(import.meta.dir, '../../../worker/autofold_worker/proto_trial.py')
  const python = Bun.spawn(['python3', '-c', 'import ast,json,sys; tree=ast.parse(open(sys.argv[1]).read()); cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=="TrialContext"); print(json.dumps([n.target.id for n in cls.body if isinstance(n,ast.AnnAssign) and isinstance(n.target,ast.Name) and not n.target.id.startswith("_")]))', worker], {stdout: 'pipe', stderr: 'pipe'})
  const [code, output] = await Promise.all([python.exited, new Response(python.stdout).text()])
  expect(code).toBe(0)
  for (const field of JSON.parse(output) as string[]) expect(api).toContain('ctx.' + field)
  expect(api).not.toMatch(/ctx\.(experiment|target|evaluator)\b/)
  expect(api).toContain('/autofold_worker/proto_generators.py')
  expect(api).toContain('validate_trial')
  expect(api).toContain('not the read_context JSON response')
  expect(api).toContain('omit ProtoTrial.prediction or set it to Python None')
  expect(api).toContain('valid locked evaluation in this experiment')
  expect(api).toContain('search authority and independently reserved frozen scoring')
})

;(nativeInstalled ? test : test.skip)('validated native declarations survive schema key reordering at execution admission', async () => {
  const f = await fixture({native: true, maximumEvaluations: 1})
  const decisionPlan = {...plan([f.experiment.id]), changedVariables: ['Generation diversity'], controlledVariables: ['Frozen target', 'Frozen seeds']}
  await f.lane.writeFile({path: 'trial.py', content: program({evidenceRefs: [f.experiment.id], decisionPlan})})
  const inspectedSeeds:number[]=[]
  const originalInspect=f.execution.inspectProgram.bind(f.execution)
  const inspect=spyOn(f.execution,'inspectProgram').mockImplementation(async input=>{if(input.generationSeed!==undefined)inspectedSeeds.push(input.generationSeed);return originalInspect(input)})
  const validation=await f.lane.validateTrial({})
  expect(validation.valid).toBe(true)
  const result = await f.lane.evaluateTrial({requestId: 'schema-reordered-native'})
  inspect.mockRestore()
  expect(result.status).toBe('succeeded')
  expect((await f.lane.status()).completedEvaluations).toBe(1)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.trials)[0]?.decisionPlan).toEqual(decisionPlan)
  const trial=Object.values(state.trials)[0]!
  expect(trial.generationSeed).toBe((validation as any).declaration.generationSeed)
  expect(inspectedSeeds.length).toBeGreaterThanOrEqual(2)
  expect(new Set(inspectedSeeds).size).toBe(1) // synthetic validation and final preflight share the slot seed
  expect(Object.values(state.runs)).toHaveLength(1)
  expect(Object.values(state.evaluations)).toHaveLength(1)
  const nativeRun = Object.values(state.runs)[0]!
  const bundle = await Bun.file(path.join(f.workspace, nativeRun.bundlePath)).json()
  expect(bundle.format).toBe('autofold.trial-bundle.v2'); expect(bundle.pipeline).toBeUndefined()
  expect(bundle.generationSeed).toBe(trial.generationSeed)
  expect(bundle.seeds).toEqual([7,11]) // fixed evaluator seeds remain independent
  expect(bundle.nativeExecution).toMatchObject({protocol: 'native_search_v1', resources: {maximumWorkerWallSeconds: 60, maximumComputeReservationSeconds: 0, reservedSearchComputeSeconds: 0, reservedEvaluationComputeSeconds: 0}})
  expect(bundle.worker.sourceHash).toMatch(/^sha256:/)
  const receipt = await f.execution.artifacts(nativeRun.id)
  expect(receipt.nativeSearch?.counts.proposals).toBeGreaterThan(0)
  expect(Object.values(state.trials)[0]?.executionProtocol).toBe('native_search_v1')
}, 60000)

;(nativeInstalled ? test : test.skip)('meaningful native decision changes still fail before worker launch', async () => {
  const f = await fixture({native: true})
  await f.lane.writeFile({path: 'trial.py', content: program({evidenceRefs: [f.experiment.id], decisionPlan: {...plan([f.experiment.id]), changedVariables: ['Generation diversity']}})})
  const create = f.research.createTrial.bind(f.research)
  const fault = spyOn(f.research, 'createTrial').mockImplementation(async (...args) => {
    const trial = await create(...args)
    await f.store.mutate(f.projectId, state => {state.trials[trial.id]!.decisionPlan!.rationale = 'Changed after native admission'})
    return trial
  })
  try {await expect(f.lane.evaluateTrial({requestId: 'meaningful-native-change'})).rejects.toThrow('Native decisionPlan differs from frozen trial')}
  finally {fault.mockRestore()}
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.runs)).toHaveLength(0)
  expect(Object.values(state.evaluations)).toHaveLength(0)
}, 60000)

test('review tool publishes authoritative typed fields through the real Pi provider adapter', async () => {
  const f = await fixture(), review = f.lane.tools().find(tool => tool.name === 'review_result')!
  const valid = {runId: 'run_fixture', expectedRevision: 0, finding: 'Verified computational outcome', interpretation: 'Bounded interpretation', predictionAssessment: 'unresolved', remainingExplanations: ['Limited evidence'], limitations: ['Single seed'], nextDecision: 'Inspect next intervention', evidenceRefs: ['run_fixture']}
  expect(Value.Check(review.parameters, valid)).toBe(true)
  expect(Value.Check(review.parameters, {...valid, expectedRevision: '0', remainingExplanations: '["Limited evidence"]'})).toBe(false)
  let captured = false
  const runtime = new PiRuntime({store: new MemorySessionStore(), tools: [review], getApiKey: () => 'offline-fixture-key', streamOptions: {onPayload: payload => {
    const request = payload as any, parameters = request.tools.find((entry: any) => entry.function.name === 'review_result').function.parameters
    expect(parameters.properties.expectedRevision.type).toBe('integer')
    expect(parameters.properties.remainingExplanations.type).toBe('array')
    expect(parameters.properties.evidenceRefs.type).toBe('array')
    expect(parameters.properties.predictionAssessment.enum).toContain('supported_for_tested_predicate')
    captured = true
    throw new Error('Offline review schema captured before transport')
  }}})
  const result = await runtime.run((await runtime.create()).id, 'Review the saved outcome')
  expect(result.error).toContain('Offline review schema captured before transport')
  expect(captured).toBe(true)
})

test('file tools confine mutation and evidence; session binding is persistent', async () => {
  const f = await fixture()
  await f.lane.writeFile({path: 'programs/alternative.py', content: '# native alternative\n'})
  expect((await f.lane.readFile({path: 'programs/alternative.py'})).content).toContain('native alternative')
  await expect(f.lane.writeFile({path: 'CONTRACT.json', content: '{}'})).rejects.toThrow('Mutable scientist')
  await expect(f.lane.writeFile({path: '../../outside.py', content: '# escape'})).rejects.toThrow('Mutable scientist')
  await expect(f.lane.readFile({path: '/etc/passwd'})).rejects.toThrow('outside this scientist')
  await fs.symlink('/tmp', path.join(f.workspace, f.lane.root, 'programs', 'link'))
  await expect(f.lane.writeFile({path: 'programs/link/x.py', content: '# escape'})).rejects.toThrow('symbolic link')
  await expect(new ScientistLane({...f.optionsBase, sessionId: 'ses_another'}).initialize()).rejects.toThrow('different persistent scientist')
})
test('native local inspection requires explicit host grant even with remote transport', async () => {
  const f = await fixture({transport: {kind: 'remote', dispatch: async () => {throw new Error('No dispatch')}}})
  await f.lane.writeFile({path: 'trial.py', content: program()})
  const validation = await f.lane.validateTrial({})
  expect(validation.valid).toBe(false)
  expect('error' in validation && validation.error).toContain('explicit host localProto')
  expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0)
})
;(nativeInstalled ? test : test.skip)('same persistent scientist performs two real CPU evaluations, consumes evidence, and calibration cannot promote', async () => {
  let calls = 0
  const local = new LocalWorkerTransport()
  const f = await fixture({native: true, transport: {kind: 'local', dispatch: async input => {calls++; return local.dispatch(input)}}})
  await f.lane.writeFile({path: 'programs/first.py', content: program()})
  const validation = await f.lane.validateTrial({programPath: 'programs/first.py'})
  expect(validation.valid).toBe(true)
  const firstSlotSeed=(validation as any).declaration.generationSeed
  expect(firstSlotSeed).toBeInteger()
  await f.lane.writeFile({path: 'programs/first.py', content: program({minimumDiversity: 0.45})})
  const editedValidation=await f.lane.validateTrial({programPath: 'programs/first.py'})
  expect(editedValidation.valid).toBe(true)
  expect((editedValidation as any).declaration.generationSeed).toBe(firstSlotSeed)
  expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0)
  const first = await f.lane.evaluateTrial({programPath: 'programs/first.py', requestId: 'first'})
  expect(first.status).toBe('succeeded')
  expect(first.evidenceKind).toBe('plumbing_only')
  const firstSavedState=await Bun.file(path.join(f.workspace,f.lane.root,'scientist.json')).json()
  const firstIntent=Object.values(firstSavedState.requests).find((item:any)=>item.requestId==='first') as any
  expect(firstIntent.input.generationSeed).toBe(firstSlotSeed)
  const review = await f.lane.reviewResult({runId: first.runId, expectedRevision: 0, finding: 'A verified CPU heuristic panel completed',
    interpretation: 'This checks infrastructure only', predictionAssessment: 'unresolved', remainingExplanations: ['Generation effects are not isolated'],
    limitations: ['No physical binding evidence'], nextDecision: 'Run the declared calibration fixture', evidenceRefs: [first.runId]})
  expect(review.epistemicStatus).toBe('scientist_interpretation')
  await expect(f.lane.reviewResult({runId: first.runId, expectedRevision: 1, finding: 'Invented confidence metric',
    interpretation: 'Untrusted fabricated value', predictionAssessment: 'unresolved', remainingExplanations: ['Unknown'], limitations: ['No receipts'],
    nextDecision: 'Stop', evidenceRefs: [first.runId], measuredClaims: [{kind: 'candidate_metric', candidateId: 'invented', modelId: 'invented', metric: 'confidence', seedMean: 1, rank: 1}]})).rejects.toThrow('unknown identity')
  const refs = [first.runId, first.trialId, first.observationId]
  expect((await f.lane.context()).evidenceRefs).toContain(first.runId)
  const decisionContext = await f.lane.context()
  expect(decisionContext.decisionMemory.interpretations.some(item=>item.id===review.id)).toBe(true)
  expect(decisionContext.decisionMemory.interpretations.every(item=>item.epistemicStatus==='attributed_interpretation')).toBe(true)
  expect(decisionContext.decisionMemory.expansion.ledgerPath).toBe('evidence/decisionEvidence.json')
  expect(decisionContext.decisionMemory.coverage.gaps).toEqual([])
  const decisionLedger = JSON.parse(await fs.readFile(path.join(f.workspace, f.lane.root, 'evidence/decisionEvidence.json'), 'utf8'))
  expect(decisionLedger.experimentId).toBe(f.experiment.id)
  const candidateArchive = JSON.parse(await fs.readFile(path.join(f.workspace, f.lane.root, 'evidence/candidateArchive.json'), 'utf8'))
  expect(candidateArchive.runs.map((item: any) => item.runId)).toContain(first.runId)
  await f.lane.tools().find(tool=>tool.name==='read_graph_node')!.execute('explicit-original-graph',{id:first.runId})

  await f.lane.writeFile({path: 'programs/control.py', content: program({intent: 'calibrate', evidenceRefs: refs, minimumDiversity: 0.5})})
  const second = await f.lane.evaluateTrial({programPath: 'programs/control.py', requestId: 'control'})
  expect(second.status).toBe('succeeded')
  expect(second.decision).toBe('observed')
  const secondTrial=(await f.store.read(f.projectId)).trials[second.trialId]!
  expect(secondTrial.generationSeed).not.toBe(firstSlotSeed)
  expect(secondTrial.graphEvidenceUse).toEqual(expect.arrayContaining([expect.objectContaining({id:first.runId,recordHash:expect.stringMatching(/^sha256:/),snapshotHash:expect.stringMatching(/^sha256:/)})]))

  expect((await f.research.history(f.projectId, f.experiment.id)).experiment.incumbentTrialId).toBe(first.trialId)
  const reopened = new ScientistLane({...f.optionsBase, research: new ResearchService.Service(new StorageResearchStore({directory: path.join(f.workspace, 'store')}))})
  expect((await reopened.status()).completedEvaluations).toBe(2) // status does not reconcile or bind
  await reopened.initialize()
  expect((await reopened.evaluateTrial({programPath: 'programs/first.py', requestId: 'first'})).runId).toBe(first.runId)
  expect(calls).toBe(2)
  expect((await ResearchScientistKernel.read(f.workspace, f.lane.root + '/scientist.json'))?.format).toBe('autofold.scientist-state.v2')
  const state = await f.store.read(f.projectId)
  expect(state.trials[first.trialId]?.generationSeed).toBe(firstSlotSeed)
  expect(Object.values(state.knowledgeCycles).filter(cycle => cycle.trigger === 'run_completed')).toHaveLength(0)
  expect(Object.values(state.searchObservations)).toHaveLength(2)
  expect(await ResearchScientistMemory.read(f.workspace, f.experiment.id)).toHaveLength(0)
  expect(ResearchTrajectoryCloseout.events(state,[],f.experiment.id)).toHaveLength(2)
  expect(JSON.parse(await fs.readFile(path.join(f.workspace, f.lane.root, 'latest-result.json'), 'utf8')).runId).toBe(second.runId)
  await expect(reopened.evaluateTrial({programPath: 'programs/control.py', requestId: 'extra'})).rejects.toThrow('budget exhausted')
  await f.lane.writeFile({path: 'programs/first.py', content: program({minimumDiversity: 0.6})})
  await expect(f.lane.evaluateTrial({programPath: 'programs/first.py', requestId: 'first'})).rejects.toThrow('earlier captured bytes')
}, 60000)
;(nativeInstalled ? test : test.skip)('validation exploration permits absent plan; evaluation rejects missing plan and invented evidence before scientific trial creation', async () => {
  const f = await fixture({native: true})
  await f.lane.writeFile({path: 'trial.py', content: program({decision: false})})
  expect((await f.lane.validateTrial({})).valid).toBe(true)
  await expect(f.lane.evaluateTrial({requestId: 'missing-plan'})).rejects.toThrow('Declare decision_plan')
  await f.lane.writeFile({path: 'trial.py', content: program({evidenceRefs: ['run_invented']})})
  await expect(f.lane.evaluateTrial({requestId: 'invented'})).rejects.toThrow('unknown')
  await f.lane.writeFile({path: 'trial.py', content: program({prediction: {comparatorTrialId: 'trl_other', metric: 'locked_score', relation: 'lower', minimumDifference: 0}})})
  const invalidPrediction = await f.lane.validateTrial({})
  expect(invalidPrediction.valid).toBe(false)
  expect(invalidPrediction.error).toContain('omit optional ProtoTrial.prediction')
  await expect(f.lane.evaluateTrial({requestId: 'bad-comparator'})).rejects.toThrow('comparator')
  expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0)
  expect(Object.keys((await f.store.read(f.projectId)).runs)).toHaveLength(0)
}, 60000)
;(nativeInstalled ? test : test.skip)('restart after verified closeout interrupted response commits one trajectory and never redispatches', async () => {
  let calls = 0, reject = true
  const local = new LocalWorkerTransport()
  const f = await fixture({native: true, transport: {kind: 'local', dispatch: async input => {calls++; return local.dispatch(input)}},
    lifecycle: {checkCancelled() {}, readCheckpoint: async () => undefined, checkpoint: async phase => {if (reject && phase.endsWith(':closeout')) {reject = false; throw new Error('Injected post-closeout process interruption')}}}})
  await f.lane.writeFile({path: 'trial.py', content: program()})
  await expect(f.lane.evaluateTrial({requestId: 'recover'})).rejects.toThrow('post-closeout')
  expect((await f.lane.status()).pending?.requestId).toBe('recover')
  const restarted = new ScientistLane({...f.optionsBase, lifecycle: undefined})
  expect((await restarted.status()).completedEvaluations).toBe(0)
  await restarted.initialize()
  expect((await restarted.status()).completedEvaluations).toBe(1)
  expect(calls).toBe(1)
  expect(Object.values((await f.store.read(f.projectId)).searchObservations)).toHaveLength(1)
  expect(await ResearchScientistMemory.read(f.workspace, f.experiment.id)).toHaveLength(0)
  expect(ResearchTrajectoryCloseout.events(await f.store.read(f.projectId), [], f.experiment.id)).toHaveLength(1)
}, 60000)
test('stop is durable and no later evaluation is admitted', async () => {
  const f = await fixture()
  await f.lane.stop({basis:'futility' as const, reason: 'bounded_fixture_complete', rationale: 'The infrastructure task is complete', evidenceRefs: [await settledStopEvidence(f)]})
  expect((await f.lane.status()).stopped).toBe(true)
  const reopened = new ScientistLane(f.optionsBase); await reopened.initialize()
  await expect(reopened.evaluateTrial({requestId: 'after-stop'})).rejects.toThrow('stopped')
})
test('scientific stop requires typed cited support and an exhausted batch cannot pause the experiment',async()=>{
  const f=await fixture({maximumEvaluations:0}),input={basis:'futility' as const,reason:'A scientific assessment',rationale:'A supported intervention cannot be identified',evidenceRefs:[f.experiment.id]}
  await expect(f.lane.stop(input)).rejects.toThrow('host completes this batch')
  expect((await f.lane.status()).stopped).toBe(false)
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('active')
  const saved=await Bun.file(path.join(f.workspace,f.lane.root,'scientist.json')).json()
  expect(saved.operation).toBeUndefined()
  const available=new ScientistLane({...f.optionsBase,maximumEvaluations:2})
  await expect(available.stop({reason:input.reason,rationale:input.rationale,evidenceRefs:input.evidenceRefs})).rejects.toThrow('basis')
  await expect(available.stop({...input,evidenceRefs:[]})).rejects.toThrow()
  await expect(available.stop(input)).rejects.toThrow('canonical settled')
  const settledEvidence=await settledStopEvidence(f)
  await expect(available.stop({...input,basis:'objective_satisfied',evidenceRefs:[settledEvidence]})).rejects.toThrow('canonical settled')
  await available.stop({...input,evidenceRefs:[settledEvidence]})
  expect((await available.status()).stopped).toBe(true)
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.piStopDecision).toMatchObject({basis:'futility',authority:'scientist_interpretation'})
})
test('fixed host completion policy is visible in context and system guidance and cannot be bypassed through direct stop',async()=>{
 const f=await fixture(),lane=new ScientistLane({...f.optionsBase,allowScientificStop:false})
 expect(lane.tools().some(tool=>tool.name==='stop_discovery')).toBe(false)
 expect(lane.tools({legacyAliases:true}).some(tool=>tool.name==='stop_discovery')).toBe(false)
 expect(lane.systemPrompt).toContain('fixed host protocol reserves batch and campaign completion authority')
 expect((await lane.context()).budgets.completion).toMatchObject({scientificStopAuthorized:false,authority:'host_fixed_protocol'})
 await expect(lane.stop({basis:'futility',reason:'Not authorized',rationale:'A model cannot end the fixed protocol',evidenceRefs:[await settledStopEvidence(f)]})).rejects.toThrow('completion authority')
 expect((await lane.status()).stopped).toBe(false)
 expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('active')
})
test('invalid stop evidence leaves no intent; corrected and distinct stops replay across a reclaimed lease', async () => {
  const f = await fixture(), lease = await stopLifecycle(f)
  const lane = new ScientistLane({...f.optionsBase, lifecycle: lease.lifecycle()})
  await lane.initialize()
  const input = {basis:'futility' as const, reason: 'bounded_fixture_complete', rationale: 'The infrastructure task is complete', evidenceRefs: ['srv_unregistered_review']}
  await expect(lane.stop(input)).rejects.toThrow('srv_unregistered_review (unknown; not persisted')
  const foreign = await f.research.createCampaign(f.projectId, {objective: 'Other campaign'})
  await expect(lane.stop({...input, evidenceRefs: [foreign.id]})).rejects.toThrow('outside_campaign')
  const file = path.join(f.workspace, lane.root, 'scientist.json')
  expect((await Bun.file(file).json()).operation).toBeUndefined()
  expect((await lane.status()).pending).toBeUndefined()
  expect((await lease.checkpoints())).toEqual({})
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('active')
  const corrected = {...input, evidenceRefs: [await settledStopEvidence(f)]}
  await lane.stop(corrected)
  const distinct = {...corrected, rationale: 'The scoped record supports this updated stop rationale'}
  const result = await lane.stop(distinct), checkpoints = await lease.checkpoints()
  expect(Object.keys(checkpoints)).toHaveLength(4)
  expect(Object.keys(checkpoints).every(phase => /^scientist:stop:[a-f0-9]{64}:(intent|result)$/.test(phase))).toBe(true)
  const before = (await f.store.read(f.projectId)).experiments[f.experiment.id]!
  expect(before.status).toBe('paused')
  const reopened = new ScientistLane({...f.optionsBase, lifecycle: await lease.reclaim()})
  await reopened.initialize()
  expect(await reopened.stop({basis:distinct.basis,evidenceRefs: distinct.evidenceRefs, rationale: distinct.rationale, reason: distinct.reason})).toEqual(result)
  expect(await lease.checkpoints()).toEqual(checkpoints)
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]).toEqual(before)
})

test('invalid uncommitted canonical stop is audited on reopen and corrected stop preserves its immutable checkpoint', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle()
  const input = {reason: 'bounded_fixture_complete', rationale: 'Review interpretation is insufficient evidence', evidenceRefs: ['srv_unregistered_review']}
  await lifecycle.checkpoint('scientist:stop:intent', input)
  const file = path.join(f.workspace, f.lane.root, 'scientist.json'), saved = await Bun.file(file).json()
  const operation = {kind: 'stop', input}
  await fixtureState(f,file,{...saved,operation})
  const reopened = new ScientistLane({...f.optionsBase, lifecycle})
  await reopened.initialize()
  const recovered = await Bun.file(file).json()
  expect(recovered.operation).toBeUndefined()
  expect(recovered.stopped).toBe(false)
  expect(recovered.rejectedOperations).toHaveLength(1)
  expect(recovered.rejectedOperations[0].operation).toEqual(operation)
  expect(recovered.rejectedOperations[0].issues).toEqual([{id: input.evidenceRefs[0], reason: 'unknown', expected: {campaignId: f.campaign.id, experimentId: f.experiment.id}}])
  expect(recovered.rejectedOperations[0].rejectedAt).toMatch(/^\d{4}-/)
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('active')
  await reopened.stop({...input,basis:'futility', evidenceRefs: [await settledStopEvidence(f)]})
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('paused')
  expect((await lease.checkpoints())['scientist:stop:intent']!.data).toEqual(input)
  expect((await Bun.file(file).json()).rejectedOperations).toEqual(recovered.rejectedOperations)
})

test('valid canonical saved stop retains fixed checkpoint recovery', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle()
  const input = {reason: 'bounded_fixture_complete', rationale: 'The scoped experiment supports stopping', evidenceRefs: [f.experiment.id]}
  await lifecycle.checkpoint('scientist:stop:intent', input)
  const file = path.join(f.workspace, f.lane.root, 'scientist.json'), saved = await Bun.file(file).json()
  await fixtureState(f,file,{...saved,operation:{kind:'stop',input}})
  const reopened = new ScientistLane({...f.optionsBase, lifecycle})
  await reopened.initialize()
  expect((await reopened.status()).stopped).toBe(true)
  expect((await lease.checkpoints())['scientist:stop:result']!.data).toEqual({status: 'stopped', continuation: 'yield', decision: input})
  expect((await Bun.file(file).json()).rejectedOperations).toBeUndefined()
})

test('legacy invalid stop recovery preserves cancelled and previously committed operations', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle()
  const input = {reason: 'bounded_fixture_complete', rationale: 'Rejected legacy interpretation', evidenceRefs: ['srv_unregistered_review']}
  const file = path.join(f.workspace, f.lane.root, 'scientist.json'), saved = await Bun.file(file).json()
  const operation = {kind: 'stop', input}
  await fixtureState(f,file,{...saved,operation})
  const cancelled = new ScientistLane({...f.optionsBase, lifecycle: {...lifecycle, checkCancelled: () => {throw new Error('Injected lease cancellation')}}})
  await expect(cancelled.initialize()).rejects.toThrow('Injected lease cancellation')
  expect((await Bun.file(file).json()).operation).toEqual(operation)
  expect((await Bun.file(file).json()).rejectedOperations).toBeUndefined()
  await f.store.mutate(f.projectId, state => {
    const experiment = state.experiments[f.experiment.id]!
    experiment.status = 'paused'
    experiment.piStopDecision = {reason: 'prior_committed_stop', rationale: 'A committed stop must be preserved', evidenceRefs: [f.experiment.id], authority: 'scientist_interpretation'}
  })
  const reopened = new ScientistLane({...f.optionsBase, lifecycle})
  await expect(reopened.initialize()).rejects.toThrow('Saved scientist stop intent evidence')
  expect((await Bun.file(file).json()).operation).toEqual(operation)
  expect((await Bun.file(file).json()).rejectedOperations).toBeUndefined()
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.piStopDecision).toEqual({reason: 'prior_committed_stop', rationale: 'A committed stop must be preserved', evidenceRefs: [f.experiment.id], authority: 'scientist_interpretation'})
})

test('saved input-specific stop survives interruption before its scientific mutation', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle()
  let checks = 0
  const lane = new ScientistLane({...f.optionsBase, lifecycle: {...lifecycle, checkCancelled: async () => {
    await lifecycle.checkCancelled()
    if (++checks === 2) throw new Error('Injected stop interruption')
  }}})
  await lane.initialize()
  const input = {basis:'futility' as const, reason: 'bounded_fixture_complete', rationale: 'The scoped experiment supports stopping', evidenceRefs: [await settledStopEvidence(f)]}
  await expect(lane.stop(input)).rejects.toThrow('Injected stop interruption')
  const file = path.join(f.workspace, lane.root, 'scientist.json'), saved = await Bun.file(file).json()
  expect(saved.operation.checkpointPhase).toMatch(/^scientist:stop:[a-f0-9]{64}$/)
  expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('active')
  const reopened = new ScientistLane({...f.optionsBase, lifecycle: await lease.reclaim()})
  await reopened.initialize()
  expect((await reopened.status()).stopped).toBe(true)
  expect((await lease.checkpoints())[saved.operation.checkpointPhase + ':result']!.data.decision).toEqual(input)
  expect((await Bun.file(file).json()).operation).toBeUndefined()
})

;(nativeInstalled ? test : test.skip)('cancelled execution clears pending and never creates scientific failure evidence', async () => {
  let calls = 0
  const f = await fixture({native: true, transport: {kind: 'local', dispatch: async () => {calls++; return {status: 'cancelled', error: 'User cancelled the bounded CPU fixture'}}}})
  await f.lane.writeFile({path: 'trial.py', content: program()})
  const cancelled = await f.lane.evaluateTrial({requestId: 'cancelled'})
  expect(cancelled.status).toBe('cancelled')
  expect((await f.lane.status()).pending).toBeUndefined()
  const reopened = new ScientistLane(f.optionsBase); await reopened.initialize()
  expect((await reopened.status()).completedEvaluations).toBe(1)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
  expect(Object.values(state.searchObservations)).toHaveLength(0)
  expect(await ResearchScientistMemory.read(f.workspace, f.experiment.id)).toHaveLength(0)
  expect(calls).toBe(1)
}, 60000)

;(nativeInstalled ? test : test.skip)('captured validation survives draft changes and branches follow each named file independently', async () => {
  const f = await fixture({native: true})
  const authored = program({decision: false})
  await f.lane.writeFile({path: 'programs/a.py', content: authored})
  const inspect = f.execution.inspectProgram.bind(f.execution)
  const mutate = spyOn(f.execution, 'inspectProgram').mockImplementationOnce(async input => {
    await f.lane.writeFile({path: 'programs/a.py', content: 'raise RuntimeError("changed mutable draft")\n'})
    return inspect(input)
  })
  const first = await f.lane.validateTrial({programPath: 'programs/a.py'})
  mutate.mockRestore()
  expect(first.valid).toBe(true)
  expect((await f.lane.readFile({path: 'programs/a.py'})).content).toContain('changed mutable draft')
  expect((await f.lane.validateTrial({programPath: 'programs/a.py'})).valid).toBe(false)
  await f.lane.writeFile({path: 'programs/b.py', content: authored + '# separate alternative\n'})
  const alternative = await f.lane.validateTrial({programPath: 'programs/b.py'})
  expect(alternative.valid).toBe(true)
  await f.lane.writeFile({path: 'programs/a.py', content: authored + '# repaired independent revision\n'})
  const repaired = await f.lane.validateTrial({programPath: 'programs/a.py'})
  expect(repaired.valid).toBe(true)
  const branches = await f.research.experimentBranches(f.projectId, f.experiment.id)
  const revision = branches.find(branch => branch.id === ('branchId' in repaired && repaired.branchId))!
  const other = branches.find(branch => branch.id === ('branchId' in alternative && alternative.branchId))!
  expect(revision.parentBranchId).toBe('branchId' in first ? first.branchId : undefined)
  expect(other.parentBranchId).toBeUndefined()
  expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0)
}, 60000)

function researchInput(evidenceRefs: string[] = []) {
  return {question: 'Which control separates target specificity?', competingExplanations: ['Target specificity', 'Nonspecific effect'],
    requiredEvidence: 'Matched control evidence', applicabilityChecks: 'Frozen target and same panel cardinality',
    decisionIfResolved: 'Select a matched comparison', evidenceRefs}
}

test('invalid research evidence and declarations leave no intent; corrected inputs replay across a reclaimed lease', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lane = new ScientistLane({...f.optionsBase, lifecycle: lease.lifecycle()})
  await lane.initialize()
  await expect(lane.requestResearch(researchInput(['srv_unknown_review']))).rejects.toThrow('srv_unknown_review (unknown; not persisted')
  await expect(lane.requestResearch({...researchInput(), competingExplanations: ['Only one explanation']})).rejects.toThrow()
  const foreign = await f.research.createCampaign(f.projectId, {objective: 'Other campaign'})
  await expect(lane.requestResearch(researchInput([foreign.id]))).rejects.toThrow('outside_campaign')
  const file = path.join(f.workspace, lane.root, 'scientist.json')
  expect((await Bun.file(file).json()).operation).toBeUndefined()
  expect((await lane.status()).researchRequested).toBe(false)
  expect(await lease.checkpoints()).toEqual({})
  expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(0)
  const input = researchInput([f.experiment.id]), first = await lane.requestResearch(input)
  const distinct = {...input, decisionIfResolved: 'Choose a different bounded matched comparison'}
  const result = await lane.requestResearch(distinct), checkpoints = await lease.checkpoints()
  expect(result.requestId).toBe(first.requestId)
  expect(Object.keys(checkpoints)).toHaveLength(4)
  expect(Object.keys(checkpoints).every(phase => /^scientist:research:[a-f0-9]{64}:(intent|result)$/.test(phase))).toBe(true)
  const before = (await f.store.read(f.projectId)).researchRequests
  const reopened = new ScientistLane({...f.optionsBase, lifecycle: await lease.reclaim()})
  await reopened.initialize()
  expect(await reopened.requestResearch({evidenceRefs: distinct.evidenceRefs, decisionIfResolved: distinct.decisionIfResolved,
    applicabilityChecks: distinct.applicabilityChecks, requiredEvidence: distinct.requiredEvidence,
    competingExplanations: distinct.competingExplanations, question: distinct.question})).toEqual(result)
  expect(await lease.checkpoints()).toEqual(checkpoints)
  expect((await f.store.read(f.projectId)).researchRequests).toEqual(before)
})

test.each(['evidence', 'declaration'])('invalid uncommitted canonical research %s is audited and corrected on reopen', async failure => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle()
  const input = failure === 'evidence' ? researchInput(['srv_unknown_review']) : {...researchInput(), competingExplanations: ['Only one explanation']}
  await lifecycle.checkpoint('scientist:research:intent', input)
  const file = path.join(f.workspace, f.lane.root, 'scientist.json'), saved = await Bun.file(file).json(), operation = {kind: 'research', input}
  await fixtureState(f,file,{...saved,operation})
  const reopened = new ScientistLane({...f.optionsBase, lifecycle})
  await reopened.initialize()
  const recovered = await Bun.file(file).json()
  expect(recovered.operation).toBeUndefined()
  expect(recovered.rejectedOperations).toHaveLength(1)
  expect(recovered.rejectedOperations[0].operation).toEqual(operation)
  if (failure === 'evidence') expect(recovered.rejectedOperations[0].issues[0]).toMatchObject({id: 'srv_unknown_review', reason: 'unknown'})
  else expect(recovered.rejectedOperations[0].validationError).toContain('competingExplanations')
  const result = await reopened.requestResearch(researchInput([f.experiment.id]))
  expect(result.status).toBe('open')
  expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(1)
  expect((await lease.checkpoints())['scientist:research:intent']!.data).toEqual(input)
  expect((await Bun.file(file).json()).rejectedOperations).toEqual(recovered.rejectedOperations)
})

test('valid canonical research intent recovers through its original fixed result checkpoint', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle(), input = researchInput([f.experiment.id])
  await lifecycle.checkpoint('scientist:research:intent', input)
  const file = path.join(f.workspace, f.lane.root, 'scientist.json'), saved = await Bun.file(file).json()
  await fixtureState(f,file,{...saved,operation:{kind:'research',input}})
  const reopened = new ScientistLane({...f.optionsBase, lifecycle})
  await reopened.initialize()
  expect((await reopened.status()).researchRequested).toBe(false)
  expect((await lease.checkpoints())['scientist:research:result']!.data).toMatchObject({status: 'open', continuation: 'continue', blocking: false, processing: 'separate_research'})
  expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(1)
  expect((await Bun.file(file).json()).rejectedOperations).toBeUndefined()
})

test.each(['evidence', 'declaration'])('invalid canonical research %s recovery preserves cancellation and matching committed requests', async failure => {
  const f = await fixture(), lease = await stopLifecycle(f), lifecycle = lease.lifecycle()
  const input = failure === 'evidence' ? researchInput(['srv_unknown_review']) : {...researchInput(), competingExplanations: ['Only one explanation']}
  const file = path.join(f.workspace, f.lane.root, 'scientist.json'), saved = await Bun.file(file).json(), operation = {kind: 'research', input}
  await fixtureState(f,file,{...saved,operation})
  const cancelled = new ScientistLane({...f.optionsBase, lifecycle: {...lifecycle, checkCancelled: () => {throw new Error('Injected research lease cancellation')}}})
  await expect(cancelled.initialize()).rejects.toThrow('Injected research lease cancellation')
  expect((await Bun.file(file).json()).operation).toEqual(operation)
  expect((await Bun.file(file).json()).rejectedOperations).toBeUndefined()
  await f.research.requestResearch(f.projectId, f.experiment.id, {request: {...researchInput(), action: 'create'},
    evidenceRefs: [f.experiment.id], generatedBy: 'committed-request-fixture'})
  const before = (await f.store.read(f.projectId)).researchRequests
  const reopened = new ScientistLane({...f.optionsBase, lifecycle})
  if (failure === 'evidence') await expect(reopened.initialize()).rejects.toThrow('Saved scientist research intent evidence')
  else await expect(reopened.initialize()).rejects.toThrow('competingExplanations')
  expect((await Bun.file(file).json()).operation).toEqual(operation)
  expect((await Bun.file(file).json()).rejectedOperations).toBeUndefined()
  expect((await f.store.read(f.projectId)).researchRequests).toEqual(before)
})

test('input-specific research intent recovers its committed effect across lease reclamation', async () => {
  const f = await fixture(), lease = await stopLifecycle(f), lane = new ScientistLane({...f.optionsBase, lifecycle: lease.lifecycle()})
  await lane.initialize()
  const original = f.research.requestResearch.bind(f.research)
  const fault = spyOn(f.research, 'requestResearch').mockImplementationOnce(async (...args) => {
    await original(...args); throw new Error('Injected interruption after committed research request')
  })
  const input = researchInput([f.experiment.id])
  try {await expect(lane.requestResearch(input)).rejects.toThrow('Injected interruption after committed')}
  finally {fault.mockRestore()}
  const file = path.join(f.workspace, lane.root, 'scientist.json'), saved = await Bun.file(file).json()
  expect(saved.operation.checkpointPhase).toMatch(/^scientist:research:[a-f0-9]{64}$/)
  const before = (await f.store.read(f.projectId)).researchRequests
  const reopened = new ScientistLane({...f.optionsBase, lifecycle: await lease.reclaim()})
  await reopened.initialize()
  expect((await reopened.status()).researchRequested).toBe(false)
  expect((await f.store.read(f.projectId)).researchRequests).toEqual(before)
  expect((await lease.checkpoints())[saved.operation.checkpointPhase + ':result']!.data).toMatchObject({status: 'open', continuation: 'continue', purpose: 'empirical_test'})
  expect((await Bun.file(file).json()).operation).toBeUndefined()
})

test('historical unresolved research does not gate discovery and later real assessments remain provenance bound',async()=>{
 const f=await fixture()
 const request=await installLegacyResearchIntent(f,{question:'Which mechanism applies?',competingExplanations:['Target effect','Panel effect'],requiredEvidence:'Independent target-specific evidence',applicabilityChecks:'Match the frozen target',decisionIfResolved:'Choose falsifying intervention',evidenceRefs:[f.experiment.id]})
 expect((await f.lane.status()).researchRequested).toBe(false)
 await f.store.mutate(f.projectId,state=>{(state.researchRequests[request.requestId] as any).status='answered'})
 await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'unrelated-cycle',sources:[],claims:[],unresolvedQuestions:['Physical confirmation remains unresolved.']})
 const unrelated=new ScientistLane(f.optionsBase);await unrelated.initialize();expect((await unrelated.status()).researchRequested).toBe(false)
 await unrelated.writeFile({path:'trial.py',content:'# advisory research regression\n'})
 const inspect=spyOn(f.execution,'inspectProgram').mockRejectedValue(new Error('Research did not gate native inspection'))
 try { await expect(unrelated.evaluateTrial({requestId:'no-assessment'})).rejects.toThrow('Research did not gate native inspection') } finally {inspect.mockRestore()}
 expect((await unrelated.context()).researchPolicy).toMatchObject({blocking:false,processing:'separate_research'})
 const review=await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'answered-bound-question',sources:[{key:'frozen-source',database:'pubmed',sourceId:'fixture',title:'Offline frozen source',query:'Mechanism applicability',excerpts:['Independent fixture evidence is bounded to the declared question.']}],claims:[],unresolvedQuestions:['Physical confirmation remains unresolved.'],researchRequestUpdates:[{requestId:request.requestId,expectedRevision:null,status:'answered',assessment:'A source-linked assessment was recorded.',remainingGap:'Physical confirmation remains absent.',nextAction:'Choose a bounded falsification.',sourceKeys:['frozen-source']}]})
 const resumed=new ScientistLane(f.optionsBase);await resumed.initialize()
 expect((await resumed.status()).researchRequested).toBe(false)
 expect((await resumed.status()).researchAcknowledgement).toMatchObject({requestId:request.requestId,revision:review.cycle.id,status:'answered',literatureIds:[review.records[0]!.id]})
 const context=await resumed.context();expect(context.decisionMemory.openQuestions).toEqual([])
 expect((await Bun.file(path.join(f.workspace,resumed.root,'QUESTIONS.json')).json())[0]).toMatchObject({status:'answered',assessment:'A source-linked assessment was recorded.'})
 expect(await Bun.file(path.join(f.workspace,resumed.root,'scientist.json')).json()).toMatchObject({researchRequested:false,researchAcknowledgement:{revision:review.cycle.id}})
 expect((await Bun.file(path.join(f.workspace,resumed.root,'QUESTIONS.json')).json())[0].requestId).toBe(request.requestId)
 const again=new ScientistLane(f.optionsBase);await again.initialize();expect((await again.status()).researchAcknowledgement).toEqual((await resumed.status()).researchAcknowledgement)
})
;(nativeInstalled?test:test.skip)('a scientist resumes authorized native CPU compute after a committed blocked literature assessment',async()=>{
 const f=await fixture({native:true,maximumEvaluations:1})
 const request=await installLegacyResearchIntent(f,{question:'Can literature distinguish this generation effect?',competingExplanations:['Generator change','Panel variation'],requiredEvidence:'Independent comparison',applicabilityChecks:'The same target and seed scope',decisionIfResolved:'Evaluate a bounded same-contract intervention',evidenceRefs:[f.experiment.id]})
 const review=await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'blocked-assessment',sources:[],claims:[],unresolvedQuestions:['Physical confirmation remains unresolved.'],researchRequestUpdates:[{requestId:request.requestId,expectedRevision:null,status:'blocked',assessment:'Available evidence cannot resolve this distinction.',remainingGap:'A direct frozen comparison is needed.',nextAction:'Run one bounded comparison if authorized.',sourceKeys:[]}]})
 const resumed=new ScientistLane(f.optionsBase);await resumed.initialize();expect((await resumed.status()).researchRequested).toBe(false)
 await resumed.writeFile({path:'trial.py',content:program({evidenceRefs:[request.requestId,review.cycle.id]})})
 const result=await resumed.evaluateTrial({requestId:'after-literature'})
 expect(result.status).toBe('succeeded');expect((await resumed.status()).completedEvaluations).toBe(1)
 expect(result.evidenceRefs).toContain(review.cycle.id);expect((await resumed.status()).researchAcknowledgement).toMatchObject({status:'blocked',revision:review.cycle.id})
},60000)


test('interrupted research request effect recovers its exact assessed question without creating or reopening another request',async()=>{
 const f=await fixture(),original=f.research.requestResearch.bind(f.research)
 const fault=spyOn(f.research,'requestResearch').mockImplementation(async(...args)=>{await original(...args);throw new Error('Interrupted after durable research request effect')})
 const input={question:'Which control separates target specificity?',competingExplanations:['Target specificity','Nonspecific effect'],requiredEvidence:'Matched control evidence',applicabilityChecks:'Frozen target and same panel cardinality',decisionIfResolved:'Select a matched comparison',evidenceRefs:[]}
 await expect(f.lane.requestResearch(input)).rejects.toThrow('Interrupted after durable')
 fault.mockRestore()
 const question=(await f.research.campaignResearchState(f.projectId,f.campaign.id)).researchQuestions[0]!
 const review=await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'assessed-before-lane-recovery',sources:[],claims:[],unresolvedQuestions:['Independent control remains missing.'],researchRequestUpdates:[{requestId:question.requestId,expectedRevision:null,status:'blocked',assessment:'No matched control evidence is available.',remainingGap:'A matched control',nextAction:'Use the blocked assessment to choose a bounded comparison.',sourceKeys:[]}]})
 const reopened=new ScientistLane(f.optionsBase);await reopened.initialize()
 expect((await reopened.status()).researchRequested).toBe(false);expect((await reopened.status()).researchAcknowledgement).toMatchObject({requestId:question.requestId,revision:review.cycle.id,status:'blocked'})
 expect((await reopened.context()).decisionMemory.openQuestions[0]).toMatchObject({requestId:question.requestId,revision:review.cycle.id,status:'blocked'})
 expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(1)
 await expect(reopened.requestResearch(input)).rejects.toThrow('already assessed')
})

;(nativeInstalled ? test : test.skip)('scientist context starts with guides while full pinned API remains readable', async () => {
  const f = await fixture({native: true})
  const context = await f.lane.context(), allFiles = await f.lane.listFiles()
  expect(context.referenceFileCount).toBeGreaterThan(100)
  expect(context.files.length).toBeLessThan(40)
  expect(allFiles.length).toBeGreaterThan(context.files.length)
  expect(context.files.some(file=>file.endsWith('/API.md'))).toBe(true)
  expect(context.files.some(file=>file.includes('/proto-source/')&&file.endsWith('.py'))).toBe(false)
  expect(context.files.some(file=>file.includes('/worker-source/')&&file.endsWith('.py'))).toBe(false)
  const readme = allFiles.find(file => /\/language\/README\.md$/.test(file))!
  expect((await f.lane.readFile({path: readme, limit: 20})).content.length).toBeGreaterThan(0)
  const nativeSource = allFiles.find(file => file.endsWith('/language/proto_language/__init__.py'))!
  expect((await f.lane.readFile({path: nativeSource})).path).toBe(nativeSource)
  await expect(f.lane.writeFile({path: nativeSource, content: '# forbidden'})).rejects.toThrow('Mutable scientist')
})

test('list_files paginates beyond the former inventory cap with bounded live-scope pages',async()=>{
 const f=await fixture(),directory=path.join(f.workspace,f.lane.root,'references','pagination-fixture')
 await fs.mkdir(directory,{recursive:true})
 for(let index=0;index<1105;index++)await fs.writeFile(path.join(directory,`source-${String(index).padStart(4,'0')}.py`),`# pinned source ${index}\n`)
 const list=f.lane.tools().find(item=>item.name==='list_files')!,all:string[]=[]
 const rootPage=await list.execute('list-default-root',{limit:3})
 expect((rootPage.details as {hasMore:boolean;files:string[]}).files).toHaveLength(3)
 expect((rootPage.details as {hasMore:boolean}).hasMore).toBe(true)
 let cursor:string|undefined,pages=0
 do{
  const page=await list.execute(`list-page-${pages}`,{path:'references/pagination-fixture',limit:70,maxBytes:6000,...(cursor?{cursor}:{})})
  const value=page.details as {files:string[];hasMore:boolean;nextCursor?:string;omissions?:{kind:string;count:number}|null;consistency:string}
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(6000)
  expect(value.consistency).toBe('live_workspace')
  if(value.hasMore)expect(value.omissions).toMatchObject({kind:'remaining_files',count:expect.any(Number)})
  all.push(...value.files);cursor=value.nextCursor;pages++
  expect(pages).toBeLessThan(30)
 }while(cursor)
 expect(pages).toBeGreaterThan(10);expect(all).toHaveLength(1105);expect(all.at(-1)).toEndWith('source-1104.py')
 await expect(list.execute('wrong-filter-cursor',{path:'references',cursor:Buffer.from(JSON.stringify({kind:'list',base:'other',after:'x'})).toString('base64url')})).rejects.toThrow('does not match')
})

test('search_files filters literal case/glob paths, pages matches and preserves distant match excerpts',async()=>{
 const f=await fixture(),directory=path.join(f.workspace,f.lane.root,'references','search-fixture')
 await fs.mkdir(directory,{recursive:true})
 const lines=['before context',...Array.from({length:7},(_,index)=>`Needle result ${index}`),'after context']
 await fs.writeFile(path.join(directory,'records.txt'),lines.join('\n')+'\n')
 await fs.writeFile(path.join(directory,'ignored.py'),'Needle should not match the .txt glob\n')
 await fs.writeFile(path.join(directory,'long.txt'),'x'.repeat(3000)+'TargetMarker at distant column\n')
 await fs.writeFile(path.join(directory,'wide.txt'),'a'.repeat(1000)+'\n'+'a'.repeat(1000)+'\nNeedle small match\n'+'b'.repeat(1000)+'\n'+'b'.repeat(1000)+'\n')
 const search=f.lane.tools().find(item=>item.name==='search_files')!
 const first=await search.execute('search-page-1',{query:'needle',path:'references/search-fixture',glob:'**/*.txt',caseSensitive:false,limit:3,maxBytes:4000,context:1})
 const page1=first.details as {matches:{path:string;line:number;text:string;column:number;truncatedBefore:boolean;truncatedAfter:boolean;context?:unknown[]}[];hasMore:boolean;nextCursor?:string;omissions:unknown;consistency:string}
 expect(page1.matches).toHaveLength(3);expect(page1.matches[0]!.path).toEndWith('records.txt');expect(page1.matches[0]!.context).toBeDefined();expect(page1.hasMore).toBe(true);expect(page1.consistency).toBe('live_workspace')
 const second=await search.execute('search-page-2',{query:'needle',path:'references/search-fixture',glob:'**/*.txt',caseSensitive:false,limit:3,maxBytes:4000,context:1,cursor:page1.nextCursor})
 const page2=second.details as typeof page1
 expect(page2.matches).toHaveLength(3);expect(page2.matches[0]!.line).toBeGreaterThan(page1.matches.at(-1)!.line)
 const sensitive=await search.execute('search-case-sensitive-default',{query:'needle',path:'references/search-fixture',glob:'**/*.txt'})
 expect((sensitive.details as typeof page1).matches).toEqual([])
 const long=await search.execute('search-long-line',{query:'TargetMarker',path:'references/search-fixture',glob:'long.txt',limit:3,maxBytes:4000})
 const longResult=(long.details as typeof page1).matches[0]!
 expect(longResult.truncatedBefore).toBe(true);expect(longResult.text).toContain('TargetMarker');expect(longResult.column).toBe(3001)
 const exactFile=await search.execute('search-exact-file-glob',{query:'TargetMarker',path:'references/search-fixture/long.txt',glob:'long.txt'})
 expect((exactFile.details as typeof page1).matches).toHaveLength(1)
 const narrow=await search.execute('search-context-byte-fallback',{query:'Needle',path:'references/search-fixture',glob:'wide.txt',caseSensitive:false,maxBytes:2048,context:2})
 const narrowResult=narrow.details as {matches:{contextOmitted?:boolean}[]}
 expect(Buffer.byteLength(JSON.stringify(narrow.details))).toBeLessThanOrEqual(2048);expect(narrowResult.matches[0]?.contextOmitted).toBe(true)
 await expect(search.execute('mismatched-cursor',{query:'other',path:'references/search-fixture',glob:'**/*.txt',caseSensitive:false,cursor:page1.nextCursor})).rejects.toThrow('does not match')
 await expect(search.execute('changed-case-mode-cursor',{query:'needle',path:'references/search-fixture',glob:'**/*.txt',caseSensitive:true,cursor:page1.nextCursor})).rejects.toThrow('does not match')
})

test('workspace file pages and search remain confined and refuse symlink traversal',async()=>{
 const f=await fixture(),directory=path.join(f.workspace,f.lane.root,'references','scope-fixture')
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(f.workspace,'outside-private.txt'),'secret_marker\n')
 await fs.symlink(path.join(f.workspace,'outside-private.txt'),path.join(directory,'linked.txt'))
 const list=f.lane.tools().find(item=>item.name==='list_files')!,search=f.lane.tools().find(item=>item.name==='search_files')!
 await expect(list.execute('list-symlink',{path:'references/scope-fixture'})).rejects.toThrow('symbolic link')
 await expect(search.execute('search-outside',{query:'secret_marker',path:path.join(f.workspace,'outside-private.txt')})).rejects.toThrow('outside this scientist experiment')
})

test('scientist knowledge tools retrieve old campaign records without scientific write or compute effects', async () => {
  const f = await fixture()
  const at = '2026-01-01T00:00:00.000Z'
  await f.store.mutate(f.projectId, state => {
    for (let index = 0; index < 35; index++) {
      const id = 'lit_old_' + index
      state.literature[id] = {id, campaignId: f.campaign.id, database: 'pubmed', sourceId: String(index), title: index === 0 ? 'Earliest applicable hotspot needle' : 'Recent unrelated paper ' + index,
        query: 'fixture', contentHash: 'sha256:' + 'b'.repeat(64), excerpts: ['Scoped source observation.'], retrievedAt: new Date(Date.parse(at) + index * 1000).toISOString()}
    }
    state.literature.lit_foreign = {...state.literature.lit_old_0!, id: 'lit_foreign', campaignId: 'cmp_foreign', title: 'Private foreign record'}
  })
  await f.lane.context() // Existing bundled-skill bootstrap is outside the read-only knowledge calls.
  const before = JSON.stringify(await f.store.read(f.projectId))
  const mutation = spyOn(f.store, 'mutate').mockImplementation(async () => {throw new Error('Knowledge query must not write science')})
  const dispatch = spyOn(f.execution, 'evaluateTrial').mockImplementation(async () => {throw new Error('No compute')})
  try {
    const query = f.lane.tools().find(tool => tool.name === 'query_knowledge')!, read = f.lane.tools().find(tool => tool.name === 'read_knowledge')!
    const answer = await query.execute('lookup-old', {query: 'Earliest applicable hotspot needle'}, new AbortController().signal)
    expect((answer.details as any).items[0].id).toBe('lit_old_0')
    const source = await read.execute('read-old', {id: 'lit_old_0'}, new AbortController().signal)
    expect((source.details as any).sources.items[0].contentHash).toBe('sha256:' + 'b'.repeat(64))
    await expect(read.execute('foreign', {id: 'lit_foreign'}, new AbortController().signal)).rejects.toThrow('outside this campaign')
    await expect(query.execute('injected-scope', {query: '', campaignId: 'cmp_foreign'}, new AbortController().signal)).rejects.toThrow()
    const context = await f.lane.context()
    expect(context.decisionMemory.sourceManifest.cutoff.sourceCount).toBeGreaterThanOrEqual(35)
    expect(Object.hasOwn(context,'applicableKnowledge')).toBe(false)
    expect(mutation).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled()
    expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
  } finally {mutation.mockRestore(); dispatch.mockRestore()}
})

test('host validation captures durable procedural feedback and cancelled job cannot append another attempt', async () => {
  const f = await fixture(), jobs = new ResearchJobService.Service(f.store)
  const job = await jobs.enqueue(f.projectId, {idempotencyKey: 'validation-feedback', payload: {kind: 'autoresearch', runtime: PI_JOB_RUNTIME,
    experimentId: f.experiment.id, sessionId: f.optionsBase.sessionId, iterations: 2, agent: 'ml'}})
  const claimed = (await jobs.claim(f.projectId, 30000))!
  expect(claimed.id).toBe(job.id)
  const lane = new ScientistLane({...f.optionsBase, origin: {jobId: claimed.id, leaseId: claimed.leaseId!}})
  await lane.writeFile({path: 'trial.py', content: '# Real captured native preflight fails without host Proto authority.\n'})
  const first = await lane.validateTrial({}), second = await lane.validateTrial({})
  expect(first.valid).toBe(false); expect(second.valid).toBe(false)
  const state = await f.store.read(f.projectId), checkpoints = state.jobs[job.id]!.checkpoints
  expect(checkpoints['scientist:authoring:1:1']!.data.status).toBe('failed')
  expect(checkpoints['scientist:authoring:1:1']!.data.programFingerprint).toMatch(/^sha256:/)
  expect(checkpoints['scientist:authoring:1:2']!.data.error).toContain('explicit host localProto')
  expect(Object.keys(state.trials)).toHaveLength(0); expect(Object.keys(state.runs)).toHaveLength(0)
  await jobs.cancel(f.projectId, job.id)
  await expect(lane.validateTrial({})).rejects.toThrow()
  expect((await f.store.read(f.projectId)).jobs[job.id]!.checkpoints['scientist:authoring:1:3']).toBeUndefined()
})


async function installLegacyResearchIntent(f: Awaited<ReturnType<typeof fixture>>, input: ReturnType<typeof researchInput>) {
 const file=path.join(f.workspace,f.lane.root,'scientist.json'),saved=await Bun.file(file).json()
 await fixtureState(f,file,{...saved,operation:{kind:'research',input}})
 const lane=new ScientistLane(f.optionsBase);await lane.initialize();f.lane=lane
 return (await lane.status()).researchRequest as {requestId:string}
}

test('new advisory research continues without terminating tools, preserves restart identity and current batch limits',async()=>{
 const f=await fixture({maximumEvaluations:0}),input=researchInput([f.experiment.id])
 const tool=f.lane.tools().find(tool=>tool.name==='request_research')!
 const receipt:any=await tool.execute('offline-request',input)
 expect(receipt.terminate).toBeUndefined();expect(receipt.details).toMatchObject({purpose:'empirical_test',continuation:'continue',scheduledAction:'iterate_experiment'})
 expect((await f.lane.status()).researchRequested).toBe(false)
 const replay=new ScientistLane(f.optionsBase);await replay.initialize()
 expect(await replay.requestResearch(input)).toEqual(receipt.details)
 expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(1)
 expect((await replay.context()).decisionMemory.openQuestions[0]).toMatchObject({status:'open',request:{purpose:'empirical_test'}})
 await expect(replay.evaluateTrial({requestId:'still-no-budget'})).rejects.toThrow('evaluation budget exhausted')
 const lookup=await replay.requestResearch({...input,purpose:'knowledge_lookup'})
 expect(lookup.continuation).toBe('continue');expect((await replay.status()).researchRequested).toBe(false)
 expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(2)
})

test('unresolved and failed branch-scoped knowledge remains advisory across parents, edited drafts and restart',async()=>{
 const f=await fixture(),source='# validated host alternative\n'
 const branch=await f.research.saveExperimentBranch(f.projectId,f.experiment.id,{program:source,draftPath:f.lane.root+'/trial.py',title:'host validated',rationale:'Offline fixture',revisitWhen:'Knowledge is answered',evidenceRefs:[]})
 await f.lane.writeFile({path:'trial.py',content:source})
 const inspect=spyOn(f.execution,'inspectProgram').mockImplementation(async()=>{throw new Error('independent alternative reached inspection')})
 try {
 const request=await f.lane.requestResearch({...researchInput([f.experiment.id]),purpose:'knowledge_lookup',prerequisiteBranchId:branch.id})
 expect(request.continuation).toBe('continue');expect((await f.lane.status()).researchRequested).toBe(false)
 expect((await f.lane.validateTrial({parentBranchId:null})).error).toContain('independent alternative reached inspection')
 await expect(f.lane.evaluateTrial({requestId:'blocked',parentBranchId:null})).rejects.toThrow('independent alternative reached inspection')
 expect(inspect).toHaveBeenCalledTimes(2)
 await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'blocked-scoped-fixture',sources:[],claims:[],unresolvedQuestions:['Evidence remains missing.'],researchRequestUpdates:[{requestId:request.requestId,expectedRevision:null,status:'blocked',assessment:'No matching evidence',remainingGap:'Independent evidence',nextAction:'Inspect another alternative',sourceKeys:[]}]})
 const restarted=new ScientistLane(f.optionsBase);await restarted.initialize()
 expect((await restarted.validateTrial({})).error).toContain('independent alternative reached inspection')
 await restarted.writeFile({path:'programs/independent.py',content:'# independent bounded alternative\n'})
 expect((await restarted.validateTrial({programPath:'programs/independent.py',parentBranchId:null})).error).toContain('independent alternative reached inspection')
 await restarted.writeFile({path:'trial.py',content:'# edited continuation attempts to evade the prerequisite\n'})
 expect((await restarted.validateTrial({parentBranchId:null})).error).toContain('independent alternative reached inspection')
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
 await expect(restarted.requestResearch({...researchInput(),purpose:'empirical_test',prerequisiteBranchId:branch.id})).rejects.toThrow('only for knowledge_lookup')
 await expect(restarted.requestResearch({...researchInput(),purpose:'knowledge_lookup',prerequisiteBranchId:'brn_missing'})).rejects.toThrow('host-validated')
 const question=(await restarted.context()).decisionMemory.openQuestions.find(question=>question.requestId===request.requestId)!
 await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'answered-scoped-fixture',sources:[{key:'matched',database:'pubmed',sourceId:'offline-matched',title:'Matched offline evidence',query:'Frozen target applicability',excerpts:['A source-linked fixture assessment resolves only the bounded prerequisite.']}],claims:[],unresolvedQuestions:['Biological confirmation remains unknown.'],researchRequestUpdates:[{requestId:request.requestId,expectedRevision:question.revision,status:'answered',assessment:'Matching source evidence assessed',remainingGap:'Biological confirmation remains absent',nextAction:'Evaluate only if current batch admits it',sourceKeys:['matched']}]})
 await restarted.writeFile({path:'trial.py',content:source})
 expect((await restarted.validateTrial({})).error).toContain('independent alternative reached inspection')
 expect((await restarted.context()).budgets.currentJob.remainingEvaluations).toBe(2)

 } finally {inspect.mockRestore()}
})


;(nativeInstalled?test:test.skip)('native CPU trial executes with an unanswered branch research annotation and no literature job',async()=>{
 const f=await fixture({native:true,maximumEvaluations:1})
 const source=program({evidenceRefs:[f.experiment.id]})
 await f.lane.writeFile({path:'trial.py',content:source})
 const branch=await f.research.saveExperimentBranch(f.projectId,f.experiment.id,{program:source,draftPath:f.lane.root+'/trial.py',title:'CPU bounded branch',rationale:'Nonblocking research regression',revisitWhen:'Independent evidence available',evidenceRefs:[]})
 const request=await f.lane.requestResearch({...researchInput([f.experiment.id]),purpose:'knowledge_lookup',prerequisiteBranchId:branch.id})
 expect(request).toMatchObject({continuation:'continue',blocking:false,processing:'separate_research'})
 const result=await f.lane.evaluateTrial({requestId:'without-research',parentBranchId:branch.id})
 expect(result.status).toBe('succeeded')
 expect((await f.lane.status()).completedEvaluations).toBe(1)
 expect((await f.lane.context()).decisionMemory.openQuestions.find(q=>q.requestId===request.requestId)).toMatchObject({status:'open',revision:null})
 const state=await f.store.read(f.projectId)
 expect(Object.values(state.knowledgeCycles).filter(c=>c.trigger!=='run_completed')).toHaveLength(0)
 expect(Object.values(state.jobs)).toHaveLength(0)
},60000)

test('frozen target references expose exact bytes and explicit residue identifiers, reject source and reference tampering',async()=>{
 const pdb=Buffer.from('ATOM      1  CA  ALA A  42      11.000  12.000  13.000  1.00 20.00           C\nATOM      2  CA  CYS A  43A     11.000  12.000  13.000  1.00 20.00           C\nEND\n')
 const digest=(bytes:Uint8Array)=>'sha256:'+new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
 const f=await fixture({target:{artifact:{format:'autofold.target-artifact.v1',name:'Exact frozen source',chains:[{id:'A',sequence:'AC'}],structure:{format:'pdb',contentHash:digest(pdb)},bindingSite:{residues:[{chainId:'A',position:2}]}},structure:pdb}})
 const directory=f.lane.root+'/references/frozen-target',context=await f.lane.context()
 for(const name of ['target.json','structure.pdb','residue-map.json','manifest.json']) expect(context.files).toContain(directory+'/'+name)
 const source=path.join(f.workspace,ResearchArtifacts.targetPath(f.experiment.contract.targetArtifactHash))
 expect(await fs.readFile(path.join(f.workspace,directory,'target.json'))).toEqual(await fs.readFile(source))
 expect(await fs.readFile(path.join(f.workspace,directory,'structure.pdb'))).toEqual(pdb)
 const map=await Bun.file(path.join(f.workspace,directory,'residue-map.json')).json()
 expect(map).toMatchObject({targetArtifactHash:f.experiment.contract.targetArtifactHash,structureHash:digest(pdb)})
 expect(map.chains[0]).toMatchObject({mapping:'exact_observed_chain_sequence',residues:[{sequencePosition:1,aminoAcid:'A',pdb:{residueNumber:'42',insertionCode:''}},{sequencePosition:2,aminoAcid:'C',bindingSite:true,pdb:{residueNumber:'43',insertionCode:'A'}}]})
 await expect(f.lane.writeFile({path:directory+'/structure.pdb',content:'changed'})).rejects.toThrow('Mutable scientist files')
 await fs.writeFile(source,(await fs.readFile(source,'utf8'))+' ')
 await expect(f.lane.readFile({path:directory+'/target.json'})).rejects.toThrow('Target artifact no longer matches')
 await fs.writeFile(source,await fs.readFile(path.join(f.workspace,directory,'target.json')))
 const reference=path.join(f.workspace,directory,'structure.pdb');await fs.chmod(reference,0o600);await fs.writeFile(reference,'changed')
 await expect(f.lane.context()).rejects.toThrow('Frozen target reference hash changed')
 await expect(new ScientistLane(f.optionsBase).initialize()).rejects.toThrow('Frozen target reference bytes changed')
})

test('frozen residue map leaves partial or mismatching PDB chain correspondence unresolved',async()=>{
 const pdb=Buffer.from('ATOM      1  CA  ALA A  42      11.000  12.000  13.000  1.00 20.00           C\nEND\n')
 const f=await fixture({target:{artifact:{format:'autofold.target-artifact.v1',name:'Missing coordinates',chains:[{id:'A',sequence:'AC'}],structure:{format:'pdb',contentHash:'sha256:'+new Bun.CryptoHasher('sha256').update(pdb).digest('hex')},bindingSite:{residues:[{chainId:'A',position:2}]}},structure:pdb}})
 const map=await Bun.file(path.join(f.workspace,f.lane.root,'references/frozen-target/residue-map.json')).json()
 expect(map.chains[0].mapping).toBe('unresolved');expect(map.chains[0].residues.every((residue:any)=>residue.pdb===null)).toBe(true)
 expect(map.chains[0].observedPdbResidues[0].residueNumber).toBe('42')
})

test('read_context separates residual parent ordinary and protected replay grants from current batch without double counting',async()=>{
 const f=await fixture(),jobs=new ResearchJobService.Service(f.store)
 const parent=await jobs.enqueue(f.projectId,{idempotencyKey:'parent-budget-fixture',payload:{kind:'campaign_loop',runtime:PI_JOB_RUNTIME,campaignId:f.campaign.id,sessionId:'ses_parent',maxSteps:5,maximumTrajectories:10,maximumDiscoveryTrajectories:6,reservedReplayTrajectories:4,discoveryBatchSize:2}})
 const claimed=(await jobs.claim(f.projectId,30000))!
 await jobs.checkpoint(f.projectId,parent.id,claimed.leaseId!,'campaign:job:start',{maximumTrajectories:10,maximumDiscoveryTrajectories:6,reservedReplayTrajectories:4,discoveryBatchSize:2})
 await jobs.checkpoint(f.projectId,parent.id,claimed.leaseId!,'campaign:step:1:completed',{step:1,proposal:{kind:'iterate_experiment'},consumedTrajectories:1,consumedDiscoveryTrajectories:1,consumedReplayTrajectories:0,result:{jobId:'job_old_ordinary'}})
 await jobs.checkpoint(f.projectId,parent.id,claimed.leaseId!,'campaign:step:2:completed',{step:2,proposal:{kind:'replay_skill'},consumedTrajectories:2,consumedDiscoveryTrajectories:0,consumedReplayTrajectories:2,result:{jobId:'job_old_replay'}})
 const child=await jobs.enqueue(f.projectId,{idempotencyKey:'current-batch-fixture',parentLeaseId:claimed.leaseId!,payload:{kind:'autoresearch',runtime:PI_JOB_RUNTIME,parentJobId:parent.id,experimentId:f.experiment.id,sessionId:f.optionsBase.sessionId,iterations:2,agent:'ml',conversation:false,allowCompute:false}})
 const lane=new ScientistLane({...f.optionsBase,origin:{jobId:child.id}}),budgets=(await lane.context()).budgets
 expect(budgets.currentJob).toMatchObject({maximumEvaluations:2,remainingEvaluations:2,reservedEvaluations:0})
 expect(budgets.parentCampaign).toMatchObject({jobId:parent.id,aggregateGrant:10,ordinaryGrant:6,reservedReplayGrant:4,consumedTrajectories:3,activeOrdinaryAdmissions:2,activeReplayAdmissions:0,remainingTrajectories:5,remainingOrdinaryTrajectories:3,remainingReservedReplayTrajectories:2})
 await jobs.checkpoint(f.projectId,parent.id,claimed.leaseId!,'campaign:step:3:completed',{step:3,proposal:{kind:'iterate_experiment'},consumedTrajectories:2,consumedDiscoveryTrajectories:2,consumedReplayTrajectories:0,result:{jobId:child.id}})
 const settled=(await lane.context()).budgets
 expect(settled.parentCampaign).toMatchObject({consumedTrajectories:5,activeOrdinaryAdmissions:0,remainingTrajectories:5,remainingOrdinaryTrajectories:3,remainingReservedReplayTrajectories:2})
 expect(settled.currentJob.remainingEvaluations).toBe(2)
 expect((await f.lane.context()).budgets.parentCampaign).toBeNull()
})

test('new prospective program requests cannot silently recreate a historical whole-experiment dependency',async()=>{
 const f=await fixture();await f.lane.writeFile({path:'trial.py',content:'# Offline captured declaration fixture only\n'})
 const request={action:'create',question:'Would repeats separate conditioning from stochastic variation?',competingExplanations:['Conditioning effect','Sampling variation'],requiredEvidence:'Same-budget independent repeats',applicabilityChecks:'Frozen target and evaluator',decisionIfResolved:'Compare the arms'}
 let current:any=request
 const inspector=spyOn(f.execution,'inspectProgram').mockImplementation(async()=>({authored:{program:{},hypothesis:'Typed request admission fixture',declaration:{intent:'optimize',decisionPlan:{...plan(),researchRequest:current}}},tools:[]} as any))
 try {
  expect(await f.lane.validateTrial({})).toMatchObject({valid:false,error:expect.stringContaining('researchRequest.purpose')})
  current={...request,purpose:'knowledge_lookup',prerequisiteBranchId:'brn_missing'}
  expect(await f.lane.validateTrial({})).toMatchObject({valid:false,error:expect.stringContaining('researchRequest.prerequisiteBranchId')})
  current={...request,purpose:'empirical_test'}
  expect(await f.lane.validateTrial({})).toMatchObject({valid:true,declaration:{decisionPlan:{researchRequest:{purpose:'empirical_test'}}}})
  expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0)
 } finally {inspector.mockRestore()}
})


test('historical yielded state is released without answering its question or rewriting the immutable yield receipt',async()=>{
 const f=await fixture(),lease=await stopLifecycle(f),lifecycle=lease.lifecycle()
 const request=await f.research.requestResearch(f.projectId,f.experiment.id,{request:{...researchInput(),action:'create'},generatedBy:'historical-yield'})
 const file=path.join(f.workspace,f.lane.root,'scientist.json'),saved=await Bun.file(file).json()
 const phase='scientist:research:old-result',receipt={...request,scheduledAction:'knowledge_refresh',continuation:'yield'}
 await lifecycle.checkpoint(phase,receipt)
 await fixtureState(f,file,{...saved,researchRequested:true,researchRequest:request,researchRequestRevision:null})
 const restarted=new ScientistLane({...f.optionsBase,lifecycle});await restarted.initialize()
 expect((await restarted.status()).researchRequested).toBe(false)
 expect((await restarted.status()).researchAcknowledgement).toBeUndefined()
 expect((await restarted.context()).decisionMemory.openQuestions[0]).toMatchObject({status:'open',revision:null})
 expect(await lifecycle.readCheckpoint(phase)).toEqual(receipt)
 expect(Object.values((await f.store.read(f.projectId)).researchRequests)).toHaveLength(1)
 await restarted.writeFile({path:'trial.py',content:'# historical research regression\n'})
 const inspect=spyOn(f.execution,'inspectProgram').mockRejectedValue(new Error('Unanswered historical question permits inspection'))
 try { expect((await restarted.validateTrial({})).error).toContain('Unanswered historical question permits inspection') } finally {inspect.mockRestore()}
})

test('native scientist exposes bounded project graph tools without allocating inference or compute',async()=>{
 const f=await fixture(),prior=await f.research.createCampaign(f.projectId,{objective:'Earlier cyclic evidence'})
 await f.research.activateCampaign(f.projectId,prior.id)
 await f.store.mutate(f.projectId,state=>{state.literature.lit_previous={id:'lit_previous',campaignId:prior.id,database:'pubmed',sourceId:'12345',title:'Earlier cyclic paper',query:'cyclic',contentHash:'sha256:'+'b'.repeat(64),excerpts:['Evidence does not establish binding.'],retrievedAt:'2026-01-01T00:00:00.000Z'}})
 const context=await f.lane.context();expect(context.decisionMemory.sourceManifest.scope.experimentId).toBe(f.experiment.id)
 const before=JSON.stringify(await f.store.read(f.projectId)),mutation=spyOn(f.store,'mutate').mockImplementation(async()=>{throw new Error('Graph tools cannot write')}),dispatch=spyOn(f.execution,'evaluateTrial').mockImplementation(async()=>{throw new Error('Graph tools cannot compute')})
 try{
  const search=f.lane.tools().find(t=>t.name==='search_graph')!,read=f.lane.tools().find(t=>t.name==='read_graph_node')!,traverse=f.lane.tools().find(t=>t.name==='traverse_graph')!
  const result:any=(await search.execute('find-prior',{query:'Earlier cyclic paper'})).details;expect(result.items[0].id).toBe('lit_previous')
  const source:any=(await read.execute('read-prior',{id:'lit_previous',expectedHash:result.items[0].recordHash})).details;expect(source.node.data.contentHash).toBe('sha256:'+'b'.repeat(64))
  const tree:any=(await traverse.execute('target',{id:f.experiment.id,maxHops:2,maxNodes:10})).details;expect(tree.nodes.length).toBeGreaterThan(1)
  expect(mutation).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
 }finally{mutation.mockRestore();dispatch.mockRestore()}
})

;(nativeInstalled?test:test.skip)('an unavailable graph returns an advisory gap and independent native CPU discovery still succeeds',async()=>{
 const f=await fixture({native:true,maximumEvaluations:1});await f.lane.context()
 // Fault the graph's actual revision-aware read port, not a brittle nth canonical read.
 const fault=spyOn(f.store,'readWithRevision').mockRejectedValue(new Error('Temporary graph read failure'))
 try{
  const lookup=f.lane.tools().find(t=>t.name==='search_graph')!
  const answer:any=(await lookup.execute('unavailable',{query:'cyclic'})).details
  expect(answer).toMatchObject({available:false,advisory:true});expect(answer.error).toContain('Temporary graph read failure')
 }finally{fault.mockRestore()}
 await f.lane.writeFile({path:'trial.py',content:program({evidenceRefs:[f.experiment.id]})})
 const result=await f.lane.evaluateTrial({requestId:'after-advisory-graph-failure'})
 expect(result.status).toBe('succeeded')
 const state=await f.store.read(f.projectId);expect(Object.values(state.runs)).toHaveLength(1);expect(Object.values(state.jobs)).toHaveLength(0)
 expect((await f.lane.context()).budgets.currentJob.remainingEvaluations).toBe(0)
},60000)

test.skipIf(!nativeInstalled)('scientist exposes pinned model metadata without scientific effects and forbids edits to its snapshot', async () => {
 const f=await fixture({native:true,maximumEvaluations:0})
 await f.lane.context() // Existing context initializes bundled skill versions; registry reads must add no further effects.
 const before=JSON.stringify(await f.store.read(f.projectId))
 const context=await f.lane.context(), registry=await f.execution.modelRegistry()
 expect(context.modelRegistry.entries.length).toBeGreaterThan(0)
 expect(registry.provenance?.languageCommit).toBe(await commit(nativeRoot))
 expect(registry.provenance?.toolsCommit).toBe(await commit(path.join(nativeRoot,'proto-tools')))
 expect(registry.provenance?.workerHash).toMatch(/^sha256:/)
 expect(registry.entries.find(card=>card.key==='boltz2-prediction')?.bridgeFeatures.cyclic_bonds).toBe(false)
 expect(context.modelRegistry.entryCount).toBe(registry.entries.length)
 expect(context.modelRegistry.entries.length).toBeLessThanOrEqual(12)
 expect(JSON.stringify(context.modelRegistry).length).toBeLessThan(16000)
 const originalToolResult={role:'toolResult',toolCallId:'context-bound-check',toolName:'read_context',content:[{type:'text',text:JSON.stringify(context)}],details:context,isError:false,timestamp:0}
 expect(Buffer.byteLength(JSON.stringify(originalToolResult))).toBeLessThan(65_536-1_024)
 expect(originalToolResult.content[0]!.text).toContain(JSON.stringify(context.decisionMemory))
 expect(context.modelRegistry.entries.every(e=>!('resourceProfile' in e)&&!('nativeFeatures' in e))).toBe(true)
 expect(registry.entries.some(card=>card.kind==='constraint'&&card.key==='protein-length')).toBe(true)
 expect(registry.entries.some(card=>card.kind==='optimizer'&&card.key==='mcmc')).toBe(true)
 const tool=f.lane.tools().find(tool=>tool.name==='read_model_card')!
 const read=await tool.execute('metadata-only',{key:'boltz2-prediction',kind:'tool',section:'configSchema',limit:400})
 const page=read.details as {content:string; contentHash:string}
 expect(page.content.length).toBeLessThanOrEqual(400)
 expect(page.contentHash).toBe(registry.contentHash)
 const persisted=JSON.parse(await fs.readFile(path.join(f.workspace,f.lane.root,'MODEL_REGISTRY.json'),'utf8'))
 expect(persisted.contentHash).toBe(registry.contentHash)
 expect(persisted.entries.map((card:any)=>[card.kind,card.key])).toEqual(registry.entries.map(card=>[card.kind,card.key]))
 await expect(f.lane.writeFile({path:'MODEL_REGISTRY.json',content:'{}'})).rejects.toThrow('Mutable scientist files')
 expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
 expect(await fs.access(path.join(f.workspace,'pi/sessions.sqlite')).then(()=>true,()=>false)).toBe(false)
})


test('scientist exposes the actual prospective schema as immutable progressive guidance', async () => {
  const f = await fixture(), context = await f.lane.context()
  expect(context.authoring).toEqual({nativeTemplate:'NATIVE_TEMPLATE.py',decisionPlanSchema: 'DECISION_PLAN.schema.json', validationCreatesTrial: false, evaluationRequiresDecisionPlan: true})
  const template=(await f.lane.readFile({path:context.authoring.nativeTemplate,limit:1000})).content
  expect(template).toContain('def build_trial(ctx):');expect(template).toContain('intent="optimize"')
  expect(template).toContain('Replace the hypothesis, intervention and reasoning')
  expect(context.files).toContain(f.lane.root+'/NATIVE_TEMPLATE.py')
  await expect(f.lane.writeFile({path:context.authoring.nativeTemplate,content:'# altered template'})).rejects.toThrow('Mutable scientist files')
  const schema = JSON.parse((await f.lane.readFile({path: context.authoring.decisionPlanSchema, limit: 1000})).content)
  expect(schema).toEqual(z.toJSONSchema(TrialReasoning.DecisionPlan, {io: 'input', unrepresentable: 'any'}))
  expect(schema.required).toContain('selectedAlternativeId')
  expect(schema.properties.alternatives.items.required).toContain('expectedInformation')
  expect(schema.properties.researchRequest.required).toContain('competingExplanations')
  await expect(f.lane.writeFile({path: 'DECISION_PLAN.schema.json', content: '{}'})).rejects.toThrow('Mutable scientist files')
  const api = (await f.lane.readFile({path: 'API.md', limit: 200})).content
  expect(api).toContain('at least one meaningful Constraint')
  expect(api).toContain('not an evaluation or a measured result')
})

test('validation separates host integration gaps from authored program repair without admitting work', async () => {
  const f = await fixture()
  await f.lane.writeFile({path: 'trial.py', content: '# scripted offline validation fixture\n'})
  const inspect = spyOn(f.execution, 'inspectProgram')
  try {
    for (const error of [new ExecutionPreflightUnavailableError('Remote scientific transport lacks exact generator design-spec preflight'), new HostCapabilitiesUnavailableError('Selected executable unavailable')]) {
      inspect.mockRejectedValue(error)
      const result = await f.lane.validateTrial({})
      expect(result).toMatchObject({valid: false, category: 'host_configuration', error: error.message})
      expect(result.repair).toContain('missing host transport hook requires a host repair')
    }
    inspect.mockRejectedValue(new Error('Cannot import ProteinLengthConfig'))
    expect(await f.lane.validateTrial({})).toMatchObject({valid: false, category: 'program', decisionPlanSchema: 'DECISION_PLAN.schema.json'})
    const state = await f.store.read(f.projectId)
    expect(Object.values(state.trials)).toHaveLength(0); expect(Object.values(state.runs)).toHaveLength(0)
  } finally {inspect.mockRestore()}
})


test('citation repairs expose the scoped persisted IDs without accepting hashes as evidence',async()=>{
  const f=await fixture();await f.lane.writeFile({path:'trial.py',content:'# scripted scoped citation fixture\n'})
  const inspect=spyOn(f.execution,'inspectProgram').mockResolvedValue({authored:{program:{},hypothesis:'Bounded scoped fixture',declaration:{intent:'optimize',decisionPlan:plan(['sha256:'+'a'.repeat(64)]),evidenceRefs:['sha256:'+'a'.repeat(64)]}},tools:[]} as any)
  try{
    const result=await f.lane.validateTrial({})
    expect(result).toMatchObject({valid:false,category:'program',evidenceFile:'EVIDENCE.json',evidenceScope:{campaignId:f.campaign.id,experimentId:f.experiment.id}})
    expect(result.allowedEvidenceRefs).toContain(f.experiment.id)
    expect(result.allowedEvidenceRefs).not.toContain('sha256:'+'a'.repeat(64))
    expect(result.issues[0].reason).toBe('unknown')
    expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
  }finally{inspect.mockRestore()}
})


test('native Pi file tools preserve normalized multi-edits and confinement without a second mutation queue',async()=>{
 const f=await fixture({maximumEvaluations:0}),tools=f.lane.tools()
 const write=tools.find(t=>t.name==='write')!,edit=tools.find(t=>t.name==='edit')!,read=tools.find(t=>t.name==='read')!
 await write.execute('write',{path:'trial.py',content:'\ufeffalpha = 1\r\nbeta = 2\r\n'})
 await edit.execute('edit',{path:'trial.py',edits:[{oldText:'alpha = 1',newText:'alpha = 3'},{oldText:'beta = 2',newText:'beta = 4'}]})
 expect(await fs.readFile(path.join(f.workspace,f.lane.root,'trial.py'),'utf8')).toBe('\ufeffalpha = 3\r\nbeta = 4\r\n')
 await f.lane.editFile({path:'trial.py',oldText:'alpha = 3',newText:'alpha = 5'})
 expect(JSON.stringify(await read.execute('read',{path:'trial.py'}))).toContain('alpha = 5')
 const before=await fs.readFile(path.join(f.workspace,f.lane.root,'trial.py'),'utf8')
 await expect(edit.execute('bad',{path:'trial.py',edits:[{oldText:'missing',newText:'rewrite'}]})).rejects.toThrow()
 expect(await fs.readFile(path.join(f.workspace,f.lane.root,'trial.py'),'utf8')).toBe(before)
 await expect(write.execute('readonly',{path:'CONTRACT.json',content:'{}'})).rejects.toThrow('Mutable scientist')
 await expect(edit.execute('readonly',{path:'CONTRACT.json',edits:[{oldText:'version',newText:'changed'}]})).rejects.toThrow('Mutable scientist')
 await expect(read.execute('escape',{path:'/etc/passwd'})).rejects.toThrow('outside this scientist')
 await fs.symlink('/tmp',path.join(f.workspace,f.lane.root,'programs','escape'))
 await expect(write.execute('symlink',{path:'programs/escape/x.py',content:'x=1'})).rejects.toThrow('symbolic link')
 const abort=new AbortController();abort.abort()
 await expect(write.execute('abort',{path:'trial.py',content:'not committed'},abort.signal)).rejects.toThrow()
 expect(await fs.readFile(path.join(f.workspace,f.lane.root,'trial.py'),'utf8')).toBe(before)
 expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0)
})

test('Pi SDK loads only approved scoped skill cards and reads bodies through verified native tools',async()=>{
 const f=await fixture({maximumEvaluations:0}),service=new CampaignSkillService(f.optionsBase)
 const context=await f.lane.context(),state=await f.store.read(f.projectId),parent=Object.values(state.skillVersions)[0]!
 const markdown=await fs.readFile(path.join(f.workspace,parent.path),'utf8')
 const candidate=await service.propose(f.campaign.id,parent.skillId,{parentVersionId:parent.id,markdown:markdown.replace('version: 1','version: 2')+'\nCandidate-only guidance sentinel.\n',trajectoryRefs:[f.experiment.id],createdBy:'offline-skill-loader-test'})
 const resources=await f.lane.resources(),skill=resources.skills.find(s=>s.name===parent.skillId)!
 expect(resources.cwd).toBe(path.join(f.workspace,f.lane.root));expect(resources.skills).toHaveLength(5)
 expect(resources.skills.some(s=>s.filePath.includes(candidate.id))).toBe(false)
 expect(context.decisionMemory.proceduralGuidance.every(s=>!('content' in s))).toBe(true)
 expect(await fs.readFile(skill.filePath,'utf8')).toBe(markdown)
 let turns=0
 const runtime=new PiRuntime({store:new MemorySessionStore(),tools:f.lane.tools(),systemPrompt:f.lane.systemPrompt,resources:()=>f.lane.resources(),streamFn:(_model,transcript)=>{
   const encoded=JSON.stringify(transcript)
   if(turns===0){expect(encoded).toContain(skill.filePath);expect(encoded).not.toContain('Candidate-only guidance sentinel.');expect(encoded).not.toContain('## Falsifying questions')}
   else {expect(encoded).toContain('## Falsifying questions');expect(encoded).toContain(parent.skillId)}
   const value:AssistantMessage={role:'assistant',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:turns++===0?'toolUse':'stop',
     content:turns===1?[{type:'toolCall',id:'read-scoped-skill',name:'read',arguments:{path:skill.filePath}}]:[{type:'text',text:'Read approved procedural guidance.'}],
     usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
   const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:value.stopReason as 'toolUse'|'stop',message:value});stream.end(value);return stream
 }})
 const session=await runtime.create();expect((await runtime.run(session.id,'Inspect the approved skill.')).status).toBe('completed');expect(turns).toBe(2)
 const snapshot=await fs.readFile(skill.filePath,'utf8');await fs.chmod(skill.filePath,0o600);await fs.writeFile(skill.filePath,snapshot+'\nChanged immutable copy.\n')
 await expect(f.lane.readFile({path:skill.filePath})).rejects.toThrow('snapshot changed')
 await expect(f.lane.resources()).rejects.toThrow('snapshot changed')
 expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})

test('native read_context confirms memory exposure only after actual inference delivery',async()=>{
 const f=await fixture({maximumEvaluations:0}),read=f.lane.tools().find(tool=>tool.name==='read_context')!
 const result=await read.execute('context-delivery',{}),reader=(f.lane as any).contextReader
 expect(read.onDelivery).toBeDefined();expect(reader.exposure({evidenceRefs:[]})).toBeUndefined()
 await read.onDelivery!({...result,isError:false,projection:'full',phase:'published'})
 expect(reader.exposure({evidenceRefs:[]})).toBeUndefined()
 await read.onDelivery!({...result,isError:false,projection:'full',phase:'inference'})
 expect(reader.exposure({evidenceRefs:[]})?.snapshotHash).toBe((result.details as any).decisionMemory.sourceManifest.snapshotHash)
 const refreshed=await read.execute('context-card-retry',{}) // New preparation clears the previous full-delivery exposure.
 await read.onDelivery!({...refreshed,isError:false,projection:'artifact_reference',phase:'inference',content:[{type:'text',text:'Original result is archived.'}]})
 expect(reader.exposure({evidenceRefs:[]})).toBeUndefined()
 expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
 expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})
test('decision-memory delivery bounds count visible content once, preserve raw details, and hold truly oversized packets without acknowledgement',async()=>{
 const f=await fixture({maximumEvaluations:0}),read=f.lane.tools().find(tool=>tool.name==='read_decision_memory')!,reader=(f.lane as any).contextReader
 const original=reader.refreshDecisionMemory.bind(reader);let padding=28_000
 const refresh=spyOn(reader,'refreshDecisionMemory').mockImplementation(async(query:any)=>{
  const value=await original(query)
  // Explicitly synthetic continuity text exercises realistic packet sizes; no
  // scientific facts, source identities or original receipts are manufactured.
  value.decisionMemory.limitation+='\nSize-only fixture '+ 'x'.repeat(padding)
  reader.prepared.packet=structuredClone(value.decisionMemory)
  return value
 })
 try{
  const delivered=await read.execute('visible-packet',{maxFacts:4,maxInterpretations:1})
  expect((delivered.details as any).status).toBe('available')
  expect(Buffer.byteLength(JSON.stringify(delivered))).toBeGreaterThan(60_000)
  const visible={role:'toolResult' as const,toolCallId:'visible-packet',toolName:read.name,content:delivered.content,details:delivered.details,isError:false,timestamp:0}
  expect(toolProjectionBytes(visible)).toBeLessThan(60_000)
  expect((delivered.details as any).decisionMemory.limitation).toContain('x'.repeat(padding))
  await read.onDelivery!({...delivered,isError:false,projection:'full',phase:'published'})
  expect(reader.exposure({evidenceRefs:[]})).toBeUndefined()
  await read.onDelivery!({...delivered,isError:false,projection:'full',phase:'inference'})
  expect(reader.exposure({evidenceRefs:[]})).toBeDefined()
  padding=65_000
  const held=await read.execute('oversized-packet',{maxFacts:4,maxInterpretations:1})
  expect(held.details).toMatchObject({status:'unavailable',maximumBytes:60_000,readTool:'read_decision_memory'})
  expect((held.details as any).decisionMemory).toBeUndefined()
  await read.onDelivery!({...held,isError:false,projection:'full',phase:'inference'})
  expect(reader.exposure({evidenceRefs:[]})).toBeUndefined()
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
 }finally{refresh.mockRestore()}
})
test('read_context keeps a bounded opening packet across24 historical outcomes while preserving full source inventory and history',async()=>{
 const f=await fixture({maximumEvaluations:0})
 for(let index=0;index<24;index++)await settledStopEvidence(f)
 const before=await f.store.read(f.projectId),context=await f.lane.context()
 expect(context.decisionMemory.facts).toHaveLength(4)
 expect(context.decisionMemory.coverage).toMatchObject({totalRecords:24,deliveredFacts:4,omittedFacts:20})
 expect(context.decisionMemory.sourceManifest.cutoff.sourceCount).toBeGreaterThan(24)
 expect(context.decisionMemory.sourceManifest.sources.length).toBeLessThan(context.decisionMemory.sourceManifest.cutoff.sourceCount)
 expect(context.decisionMemory.retrieval.query).toMatchObject({maxFacts:4,maxInterpretations:4})
 const history=await Bun.file(path.join(f.workspace,f.lane.root,'HISTORY.json')).json()
 expect(history.runs).toHaveLength(24);expect(history.trials).toHaveLength(24)
 const manifest=await Bun.file(path.join(f.workspace,f.lane.root,context.decisionMemory.sourceManifest.manifestPath)).json()
 expect(manifest.sources).toHaveLength(context.decisionMemory.sourceManifest.cutoff.sourceCount)
 const after=await f.store.read(f.projectId)
 expect(after.trials).toEqual(before.trials);expect(after.runs).toEqual(before.runs);expect(after.searchObservations).toEqual(before.searchObservations)
})

;(nativeInstalled?test:test.skip)('native Pi scientist repairs a draft and commits one CPU receipt in the same agent loop',async()=>{
 const f=await fixture({native:true,maximumEvaluations:2}),source=program(),store=new MemorySessionStore();let turns=0,artifactReads=0,artifactCursor=0,artifactBytes='',context:any,artifactRef:any
 const runtime=new PiRuntime({store,tools:f.lane.tools(),systemPrompt:f.lane.systemPrompt,resources:()=>f.lane.resources(),stopToolNames:['stop_discovery'],limits:{maxTurns:24,maxToolCalls:24},streamFn:(_model,transcript)=>{
  const result=()=>{const last=transcript.messages.findLast(m=>m.role==='toolResult');return JSON.parse((last as any).content[0].text)}
  let name:string,args:ToolCall['arguments']
  switch(turns){
   case 0:name='write';args={path:'trial.py',content:source+'\ninvalid syntax here\n'};break
   case 1:name='validate_trial';args={};break
   case 2:expect(result()).toMatchObject({valid:false,category:'program'});name='edit';args={path:'trial.py',edits:[{oldText:'invalid syntax here',newText:'# repaired in the same Pi session'}]};break
   case 3:name='validate_trial';args={};break
   case 4:expect(result().valid).toBe(true);name='evaluate_trial';args={requestId:'one-native-repaired-evaluation'};break
   case 5:expect(result().status).toBe('succeeded');name='read_context';args={};break
   case 6:{
    const delivered=result()
    if(delivered.toolArtifact){
     artifactRef=delivered.toolArtifact;expect(delivered.exposure).toBe('artifact_reference_only');expect(artifactRef.toolCallId).toBe('native-step-5-0')
     name='read_tool_artifact';args={...artifactRef,offsetBytes:artifactCursor,limitBytes:8000};break
    }
    if(artifactRef&&!context){
     expect(delivered.encoding).toBe('original_message_json_utf8');expect(delivered.messageHash).toBe(artifactRef.messageHash);expect(delivered.offsetBytes).toBe(artifactCursor)
     artifactBytes+=delivered.text
     if(delivered.nextOffsetBytes!==null){artifactCursor=delivered.nextOffsetBytes;name='read_tool_artifact';args={...artifactRef,offsetBytes:artifactCursor,limitBytes:8000};break}
     expect(Buffer.byteLength(artifactBytes)).toBe(delivered.totalBytes)
     expect('sha256:'+createHash('sha256').update(artifactBytes).digest('hex')).toBe(artifactRef.messageHash)
     const original=JSON.parse(artifactBytes);expect(original.toolName).toBe('read_context');expect(original.toolCallId).toBe(artifactRef.toolCallId)
     context=JSON.parse(original.content[0].text)
    }
    context??=delivered
    expect(context.lane.completedEvaluations).toBe(1);expect(context.budgets.currentJob.remainingEvaluations).toBe(1)
    name='stop_discovery';args={basis:'objective_satisfied',reason:'bounded_cpu_acceptance_complete',rationale:'One verified heuristic fixture establishes the native integration only.',evidenceRefs:[context.decisionMemory.facts[0].runId]};break
   }
   default:throw new Error('The host must not request another turn after the committed stop')
  }
  const value:AssistantMessage={role:'assistant',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',
   content:[{type:'toolCall',id:'native-step-'+turns+'-'+artifactReads,name,arguments:args}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
  if(name==='read_tool_artifact')artifactReads++;else turns++
  const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'toolUse',message:value});stream.end(value);return stream
 }})
 const session=await runtime.create(),result=await runtime.run(session.id,'Repair and evaluate one bounded CPU fixture.')
 expect(result.error).toBeUndefined();expect(result.status).toBe('completed');expect(turns).toBe(7);expect(result.session.pendingTools).toEqual({})
 const fullDeliveryExposure=!artifactRef?(f.lane as any).contextReader.exposure({evidenceRefs:[context.decisionMemory.facts[0].runId]}):undefined
 if(artifactRef){
  expect(artifactReads).toBeGreaterThan(0)
  const original=result.session.messages[artifactRef.ordinal];expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe(artifactRef.messageHash.slice(7))
 }else{
  expect(artifactReads).toBe(0)
  const delivered=result.session.messages.findLast(message=>message.role==='toolResult'&&(message as any).toolName==='read_context') as any
  expect(delivered).toBeDefined()
  expect(JSON.parse(delivered.content[0].text)).toEqual(context)
 }
 expect(result.session.usage.turns).toBe(7+artifactReads);expect(result.session.usage.toolCalls).toBe(7+artifactReads);expect(7+artifactReads).toBeLessThanOrEqual(24)
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(1);expect(Object.values(state.runs)).toHaveLength(1);expect(Object.values(state.evaluations)).toHaveLength(1)
 if(!artifactRef){
  const citedRunId=context.decisionMemory.facts[0].runId
  expect(fullDeliveryExposure).toMatchObject({packetHash:'sha256:'+operationHash(context.decisionMemory),manifestHash:context.decisionMemory.sourceManifest.manifestHash,
   snapshotHash:context.decisionMemory.sourceManifest.snapshotHash,sessionId:f.optionsBase.sessionId})
  expect(fullDeliveryExposure.citedSources.map((source:any)=>source.id)).toContain(citedRunId)
 }
 expect(Object.values(state.runs)[0]?.status).toBe('succeeded');expect((await f.lane.status()).stopped).toBe(true)
},60000)


;(nativeInstalled?test:test.skip)('Pi refreshes the committed packet between CPU evaluations and replay adds no work or receipt data',async()=>{
 const local=new LocalWorkerTransport();let dispatches=0
 const f=await fixture({native:true,maximumEvaluations:3,transport:{kind:'local',dispatch:async input=>{dispatches++;return local.dispatch(input)}}})
 const store=new MemorySessionStore();let turns=0,firstRunId='',secondRunId='',secondTrialId='',secondEvaluationId=''
 const runtime=new PiRuntime({store,tools:f.lane.tools(),systemPrompt:f.lane.systemPrompt,resources:()=>f.lane.resources(),stopToolNames:['stop_discovery'],limits:{maxTurns:16,maxToolCalls:16},streamFn:async(_model,transcript)=>{
  const last=transcript.messages.findLast(m=>m.role==='toolResult') as any
  const result=()=>JSON.parse(last.content[0].text)
  let name:string,args:ToolCall['arguments']
  switch(turns){
   case 0:name='write';args={path:'programs/first.py',content:program()};break
   case 1:name='validate_trial';args={programPath:'programs/first.py'};break
   case 2:expect(result().valid).toBe(true);name='evaluate_trial';args={programPath:'programs/first.py',requestId:'memory-chain-first'};break
   case 3:{
    const evaluated=result();expect(evaluated.status).toBe('succeeded');firstRunId=evaluated.runId
    expect(evaluated.decisionMemoryRefresh.status).toBe('available')
    expect(evaluated.decisionMemoryRefresh.decisionMemory.facts.map((fact:any)=>fact.runId)).toContain(firstRunId)
    name='write';args={path:'programs/second.py',content:program({intent:'calibrate',evidenceRefs:[firstRunId],minimumDiversity:0.5})};break
   }
   case 4:name='validate_trial';args={programPath:'programs/second.py'};break
   case 5:expect(result().valid).toBe(true);name='evaluate_trial';args={programPath:'programs/second.py',requestId:'memory-chain-second'};break
   case 6:{
    const evaluated=result();expect(evaluated.status).toBe('succeeded');secondRunId=evaluated.runId;secondTrialId=evaluated.trialId;secondEvaluationId=evaluated.evaluationId
    const state=await f.store.read(f.projectId),trial=state.trials[secondTrialId]!
    expect(trial.decisionMemoryExposure?.citedSources.map((source:any)=>source.id)).toContain(firstRunId)
    expect(trial.decisionMemoryExposure?.citedSources.map((source:any)=>source.id)).not.toContain(secondRunId)
    expect(evaluated.decisionMemoryRefresh.decisionMemory.facts.map((fact:any)=>fact.runId)).toContain(firstRunId)
    name='evaluate_trial';args={programPath:'programs/second.py',requestId:'memory-chain-second'};break
   }
   case 7:{
    const replay=result();expect(replay.status).toBe('succeeded');expect(replay.runId).toBe(secondRunId);expect(replay.evaluationId).toBe(secondEvaluationId)
    expect(replay.decisionMemoryRefresh.status).toBe('available')
    expect(replay.decisionMemoryRefresh.decisionMemory.facts.map((fact:any)=>fact.runId)).toEqual(expect.arrayContaining([firstRunId,secondRunId]))
    const state=await f.store.read(f.projectId)
    expect(Object.values(state.trials)).toHaveLength(2);expect(Object.values(state.runs)).toHaveLength(2);expect(Object.values(state.evaluations)).toHaveLength(2)
    const saved=(await new ScientistAuthority(f.optionsBase).read())!
    const intent=Object.values(saved.requests as Record<string,any>).find((request:any)=>request.requestId==='memory-chain-second')!
    expect(intent.result).not.toHaveProperty('decisionMemoryRefresh')
    name='stop_discovery';args={basis:'objective_satisfied',reason:'fresh_packet_cpu_regression_complete',rationale:'The second admission used the delivered first receipt; replay refreshed the current packet without another evaluation.',evidenceRefs:[secondRunId]};break
   }
   default:throw new Error('The host must not request another turn after the committed stop')
  }
  const message:AssistantMessage={role:'assistant',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',
   content:[{type:'toolCall',id:'memory-chain-'+turns,name,arguments:args}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
  turns++;const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'toolUse',message});stream.end(message);return stream
 }})
 const session=await runtime.create(),result=await runtime.run(session.id,'Evaluate once, use the refreshed receipt for a second decision, and verify replay is read-only.')
 expect(result.error).toBeUndefined();expect(result.status).toBe('completed');expect(turns).toBe(8);expect(dispatches).toBe(2)
 expect(secondTrialId).toBeTruthy();expect(firstRunId).not.toBe(secondRunId)
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(2);expect(Object.values(state.runs)).toHaveLength(2);expect(Object.values(state.evaluations)).toHaveLength(2)
 expect((await f.lane.status()).stopped).toBe(true)
},60000)

test('derivative context destinations stay advisory and repaired hydration never executes original work',async()=>{
 const f=await fixture(),root=path.join(f.workspace,f.lane.root),before=await f.store.read(f.projectId)
 for(const file of ['HISTORY.json','MODEL_REGISTRY.json','evidence/candidateArchive.json']){
  await fs.rm(path.join(root,file),{recursive:true,force:true});await fs.mkdir(path.join(root,file),{recursive:true})
 }
 const lane=new ScientistLane(f.optionsBase);await lane.initialize();const context=await lane.context()
 expect(context.publicationGaps).toHaveProperty('workspaceViews');expect(Object.hasOwn(context.publicationGaps,'MODEL_REGISTRY.json')).toBe(true)
 expect(Object.hasOwn(context.publicationGaps,'evidence/candidateArchive.json')).toBe(true)
 for(const file of ['HISTORY.json','MODEL_REGISTRY.json','evidence/candidateArchive.json'])await fs.rm(path.join(root,file),{recursive:true})
 const repaired=await lane.context();expect(repaired.publicationGaps).toEqual({});
 const after=await f.store.read(f.projectId);expect(after.trials).toEqual(before.trials);expect(after.runs).toEqual(before.runs);expect(after.jobs).toEqual(before.jobs)
})
test('mandatory original journal corruption stays fenced while JSON exports cannot override canonical effects',async()=>{
 const f=await fixture(),file=path.join(f.workspace,f.lane.root,'scientist.json'),saved=await Bun.file(file).json()
 await Bun.write(file,JSON.stringify({...saved,requests:{unknown:{requestId:'unknown'}}}))
 await expect(new ScientistLane(f.optionsBase).initialize()).rejects.toThrow('unknown original requests')
 expect(await Bun.file(file).json()).toEqual({...saved,requests:{unknown:{requestId:'unknown'}}})
 await Bun.write(file,JSON.stringify(saved));await Bun.write(path.join(f.workspace,f.lane.root,'events.jsonl'),'invalid journal\n')
 await expect(new ScientistLane(f.optionsBase).initialize()).rejects.toThrow('Invalid scientist memory event')
 expect(Object.keys((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})
test('legacy JSON-only pending identities remain held and unchanged without automatic migration',async()=>{
 const f=await fixture(),file=path.join(f.workspace,f.lane.root,'scientist.json'),saved=await Bun.file(file).json()
 const legacy={...saved,requests:{pending:{requestId:'legacy-original',programHash:'sha256:'+'a'.repeat(64)}}};delete legacy.authorityRevision
 await f.store.mutate(f.projectId,state=>{state.scientistLanes={}});await Bun.write(file,JSON.stringify(legacy))
 const reopened=new ScientistLane(f.optionsBase);expect((await reopened.status()).originalIntentAuthority).toMatchObject({status:'held_legacy_unknown',requestCount:1})
 await expect(reopened.initialize()).rejects.toThrow('Legacy scientist authority unresolved')
 expect(await Bun.file(file).json()).toEqual(legacy);expect((await f.store.read(f.projectId)).scientistLanes).toEqual({})
})


test('context and graph reads cannot replay a pending canonical scientist intent',async()=>{
 const f=await fixture()
 const file=path.join(f.workspace,f.lane.root,'scientist.json'),saved=await Bun.file(file).json()
 await fixtureState(f,file,{...saved,operation:{kind:'stop',input:{reason:'original_pending',rationale:'Original pending stop remains under owner control.',evidenceRefs:[f.experiment.id]}}})
 const before=await f.store.read(f.projectId),lane=new ScientistLane(f.optionsBase)
 await lane.context();await lane.queryKnowledge({});await (lane as any).graphOperation('search',{limit:1});await lane.resources();await lane.tools().find(tool=>tool.name==='list_files')!.execute('readonly-inventory',{})
 const after=await f.store.read(f.projectId);expect(after.experiments[f.experiment.id]!.status).toBe('active');expect(after.trials).toEqual(before.trials);expect(after.runs).toEqual(before.runs)
 expect((await new ScientistAuthority(f.optionsBase).read())!.operation).toEqual(saved.operation??{kind:'stop',input:{reason:'original_pending',rationale:'Original pending stop remains under owner control.',evidenceRefs:[f.experiment.id]}})
 await lane.initialize();expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('paused')
})
test('canonical scientist register CAS refuses concurrent original-intent replacement',async()=>{
 const f=await fixture(),a=new ScientistAuthority(f.optionsBase),b=new ScientistAuthority(f.optionsBase),original=await a.read();await b.read()
 await a.save({...original,researchRequested:true});await expect(b.save({...original,stopped:true})).rejects.toThrow('changed concurrently')
 const current=await new ScientistAuthority(f.optionsBase).read();expect(current!.researchRequested).toBe(true);expect(current!.stopped).toBe(false)
})


test('target publication classifies destination IO as advisory and source IO as mandatory',async()=>{
 const f=await fixture({target:{artifact:{format:'autofold.target-artifact.v1',name:'Frozen source IO boundary',chains:[{id:'A',sequence:'AC'}],bindingSite:{residues:[{chainId:'A',position:2}]}}}})
 const root='fresh-target-projection';await fs.mkdir(path.join(f.workspace,root,'references'),{recursive:true});await Bun.write(path.join(f.workspace,root,'references/frozen-target'),'blocked destination')
 const refs=new FrozenTargetReferences(f.optionsBase,root)
 await expect(refs.publish(f.experiment)).rejects.toBeInstanceOf(FrozenTargetPublicationError)
 const read=spyOn(ResearchArtifacts,'readTarget').mockRejectedValue(Object.assign(new Error('Original source unavailable'),{code:'EIO'}))
 try{await expect(new ScientistLane(f.optionsBase).initialize()).rejects.toThrow('Original source unavailable')}finally{read.mockRestore()}
 expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0)
})


test('actual native scientist read tool defaults to a small page and explicit ranges remain available',async()=>{
 const f=await fixture(),body=Array.from({length:700},(_,i)=>`evidence_line_${String(i+1).padStart(4,'0')}`).join('\n')
 await f.lane.writeFile({path:'LAB.md',content:body})
 const read=f.lane.tools().find(t=>t.name==='read')!
 const first=await read.execute('compact-default',{path:'LAB.md'})
 const text=(r:any)=>r.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')
 expect(text(first)).toContain('evidence_line_0200');expect(text(first)).not.toContain('evidence_line_0201')
 const next=await read.execute('explicit-page',{path:'LAB.md',offset:201,limit:400})
 expect(text(next)).toContain('evidence_line_0201');expect(text(next)).toContain('evidence_line_0600');expect(text(next)).not.toContain('evidence_line_0601')
 expect((await f.lane.readFile({path:'LAB.md',offset:601,limit:100})).content).toContain('evidence_line_0700')
 expect((await f.store.read(f.projectId)).trials).toEqual({});expect((await f.store.read(f.projectId)).runs).toEqual({})
})

test('brand-new graph and knowledge reads never manufacture a scientist session or mutate authority',async()=>{
 const f=await fixture()
 await f.store.mutate(f.projectId,state=>{delete state.experiments[f.experiment.id]!.piScientistSessionId;state.scientistLanes={}})
 await fs.rm(path.join(f.workspace,f.lane.root,'scientist.json'))
 const before=JSON.stringify(await f.store.read(f.projectId)),mutation=spyOn(f.store,'mutate').mockImplementation(async()=>{throw new Error('Read-only retrieval must not create authority')})
 try {
  const graph=new ScientistLane(f.optionsBase),query=new ScientistLane(f.optionsBase)
  await graph.tools().find(tool=>tool.name==='search_graph')!.execute('graph-only',{query:'CPU'})
  await query.queryKnowledge({query:'CPU'})
  expect(mutation).not.toHaveBeenCalled();expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
 }finally{mutation.mockRestore()}
})

;(nativeInstalled?test:test.skip)('ephemeral read_context promotes through owner initialization before the same original evaluation',async()=>{
 const f=await fixture({native:true,maximumEvaluations:1})
 await f.store.mutate(f.projectId,state=>{delete state.experiments[f.experiment.id]!.piScientistSessionId;state.scientistLanes={}})
 await fs.rm(path.join(f.workspace,f.lane.root,'scientist.json'))
 const before=JSON.stringify(await f.store.read(f.projectId)),lane=new ScientistLane(f.optionsBase)
 const mutation=spyOn(f.store,'mutate').mockImplementation(async()=>{throw new Error('Read-only context must not create authority')})
 try {
  const context=await lane.context();expect(context.decisionMemory.coverage.totalRecords).toBe(0)
  expect(mutation).not.toHaveBeenCalled();expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
 }finally{mutation.mockRestore()}
 await lane.initialize()
 expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.piScientistSessionId).toBe(f.optionsBase.sessionId)
 await lane.writeFile({path:'trial.py',content:program({evidenceRefs:[f.experiment.id]})})
 const result=await lane.evaluateTrial({requestId:'after-ephemeral-owner-promotion'})
 expect(result.status).toBe('succeeded');expect((await lane.status()).completedEvaluations).toBe(1)
 expect((await f.store.read(f.projectId)).trials[result.trialId]!.decisionMemoryExposure?.sessionId).toBe(f.optionsBase.sessionId)
},60000)

test('owner initialization waits for an in-flight read-only authority load before promotion',async()=>{
 const f=await fixture()
 await f.store.mutate(f.projectId,state=>{delete state.experiments[f.experiment.id]!.piScientistSessionId;state.scientistLanes={}})
 await fs.rm(path.join(f.workspace,f.lane.root,'scientist.json'))
 const lane=new ScientistLane(f.optionsBase),original=f.store.read.bind(f.store)
 let release!:()=>void,entered!:()=>void,first=true
 const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const read=spyOn(f.store,'read').mockImplementation(async id=>{const state=await original(id);if(first){first=false;entered();await gate}return state})
 try {
  const context=lane.context();await started
  const initialize=lane.initialize();release()
  await Promise.all([context,initialize])
  const state=await original(f.projectId)
  expect(state.experiments[f.experiment.id]!.piScientistSessionId).toBe(f.optionsBase.sessionId)
  expect(Object.values(state.scientistLanes)).toHaveLength(1)
  expect((await new ScientistAuthority(f.optionsBase).read())?.sessionId).toBe(f.optionsBase.sessionId)
  expect((await lane.status()).originalIntentAuthority).toMatchObject({status:'canonical'})
 }finally{release();read.mockRestore()}
})
