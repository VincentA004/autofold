import {expect, test} from 'bun:test'
import {ExecutionProtocol} from './execution-protocol'
import {ResearchWorkflow} from './workflow'
import {ResearchDomain} from './domain'

const commit = 'a'.repeat(40)
const contract = {budget: {maximumCandidates: 2, gpuHours: 0, wallTimeMinutes: 1}, evaluator: {submissionSize: 1, fixedSeeds: [7]}}
function authored(): ResearchWorkflow.AuthoredTrial {
  return {executionProtocol: 'native_search_v1', nativeObservation: 'scoped_native_lifecycle_v1', hypothesis: 'Bounded native candidate pool', declaration: {intent: 'optimize'}, diagnostics: [],
    program: {kind: 'native', optimizerCount: 1, constructCount: 2, generatorCount: 0, proposalSources: ['existing_results'], fixedSequences: ['ACDE', 'CDEF'], programResultCount: 1, optimizerSamples: [{numSamples: 1, numResults: 1, proposalBatchSize: 1}]},
    nativeSearch: {format: 'autofold.native-search.v1', budget: {maximumCandidates: 2, maximumProposals: 4, maximumSamplingCalls: 4, maximumToolCalls: 4, maximumWallSeconds: 1, allowedTools: [], outputs: [{construct: 'panel', segment: null, lane: 0}]},
      projection: [{lane: 0, programSeed: 7, externalInputs: [], numResults: 1, constructs: [{label: 'panel'}], stages: [{instanceId: 'stage', optimizer: 'RejectionSamplingOptimizer', config: {}, settings: {}, targetSegment: null, customLogging: null, conditioning: null, numResults: 1, generators: [], constraints: []}]}]}}
}
const compile = (trial: ResearchWorkflow.AuthoredTrial, frozen = contract) => ResearchWorkflow.compileNative({trial, contract: frozen, tools: [], generators: [], protoToolsCommit: commit, protoLanguageCommit: commit})

test('native CPU authority is finite without a GPU reservation or duplicate pipeline driver', () => {
  const result = compile(authored())
  expect(result.nativeExecution).toMatchObject({protocol: 'native_search_v1', resources: {maximumSearchWallSeconds: 1, maximumWorkerWallSeconds: 60, reservedEvaluationWallSeconds: 0}})
  expect(result.pipeline.nativeSearch).toBeUndefined(); expect(result.pipeline.generation).toBeUndefined(); expect(result.pipeline.executionBudget).toBeUndefined()
  expect(() => compile({...authored(), diagnostics: [{id: 'route'}]})).toThrow('diagnostic DAG')
  expect(() => compile({...authored(), executionProtocol: undefined})).toThrow('native execution protocol')
  expect(() => compile({...authored(), nativeObservation: undefined})).toThrow('scoped native lifecycle capability')
  expect(result.nativeExecution.observation).toBe('scoped_native_lifecycle_v1')
  expect(()=>compile(authored(),{...contract,budget:{...contract.budget,maximumCandidates:4},evaluator:{...contract.evaluator,submissionSize:3}})).toThrow('final selection')
  const tooLong = authored(); tooLong.nativeSearch!.budget.maximumWallSeconds = 61
  expect(() => compile(tooLong)).toThrow('worker wall-time authority')
})

test('fixed native pool can exceed final Top N and reserves its actual model/candidate/seed census', () => {
  const base = authored(), projection = base.nativeSearch!
  const fixed = {...base, executionProtocol: 'native_fixed_control_v1' as const, declaration: {intent: 'calibrate' as const}, nativeSearch: undefined,
    nativeFixedControl: {maximumWallSeconds: 1, outputs: projection.budget.outputs},
    staticConstruction: ExecutionProtocol.StaticConstruction.parse({format: 'autofold.static-construction.v1', ...base.program, semantics: 'native_object_v2', nativeProjection: projection})}
  const stages = [{id: 'boltz', role: 'scoring' as const, models: [{id: 'boltz2-prediction', version: commit, config: {use_msa: false}}], dependsOn: [], budget: {maximumGpuSeconds: 120}, required: true, allowSkip: false, allowedSkips: []},
    {id: 'chai', role: 'scoring' as const, models: [{id: 'chai1-prediction', version: commit, config: {use_msa: false}}], dependsOn: ['boltz'], budget: {maximumGpuSeconds: 180}, required: true, allowSkip: false, allowedSkips: []}]
  const scoringPipeline = ExecutionProtocol.ScoringPipeline.parse({format: 'autofold.scoring-pipeline.v1', protoToolsCommit: commit, stages})
  const frozen = {...contract, budget: {...contract.budget, gpuHours: 600 / 3600, wallTimeMinutes: 15}, evaluator: {...contract.evaluator, evidenceAdapter: {id: 'native-panel', version: '1', sourceHash: `sha256:${'1'.repeat(64)}`, scoringPipeline}}}
  const result = ResearchWorkflow.compileNative({trial: fixed, contract: frozen, tools: [{key: 'boltz2-prediction', category: 'structure_prediction', usesGpu: true}, {key: 'chai1-prediction', category: 'structure_prediction', usesGpu: true}], generators: [], protoToolsCommit: commit, protoLanguageCommit: commit})
  expect(result.nativeExecution.resources.reservedEvaluationWallSeconds).toBe(600)
  expect(result.nativeExecution.resources.invocationReservations.map(item => item.maximumRequests)).toEqual([2, 2])
  expect(result.nativeExecution.resources.maximumWorkerWallSeconds).toBe(900)
  expect(result.nativeExecution.resources.reservedSearchComputeSeconds).toBe(0)
  expect(result.nativeExecution.resources.reservedEvaluationComputeSeconds).toBe(600)
  expect(result.pipeline.stages).toHaveLength(2); expect(result.pipeline.staticConstruction).toBeUndefined()
  const malformed = structuredClone(result.nativeExecution); malformed.resources.invocationReservations[0]!.maximumCandidates = 1
  expect(() => ExecutionProtocol.NativeExecution.parse(malformed)).toThrow('cardinality')
  const search = authored(); search.nativeSearch!.budget.maximumWallSeconds = 30
  const searched = ResearchWorkflow.compileNative({trial: search, contract: frozen, tools: [{key: 'boltz2-prediction', category: 'structure_prediction', usesGpu: true}, {key: 'chai1-prediction', category: 'structure_prediction', usesGpu: true}], generators: [], protoToolsCommit: commit, protoLanguageCommit: commit})
  expect(searched.nativeExecution.resources).toMatchObject({maximumSearchWallSeconds: 30, maximumWorkerWallSeconds: 900, maximumComputeReservationSeconds: 600, reservedSearchComputeSeconds: 0, reservedEvaluationComputeSeconds: 600})
  const hash = `sha256:${'1'.repeat(64)}`
  const bundle = ExecutionProtocol.TrialBundle.parse({format: 'autofold.trial-bundle.v4', runId: 'run_native', trialId: 'trl_native', intent: 'calibrate', contractHash: hash, designAdapter: 'proto', programPath: 'trial.py', programHash: hash, modality: 'short_peptide', targetArtifactHash: hash, targetArtifactPath: 'target.json', evaluator: {id: 'panel', version: '1', sourceHash: hash, direction: 'minimize'}, evidenceAdapter: {id: 'native-panel', version: '1', sourceHash: hash}, proto: {root: '/fixture', languageCommit: commit, toolsCommit: commit}, seeds: [7], candidateBudget: 2, submissionSize: 1, worker: {format: 'autofold.worker-tree.v1', sourceHash: hash}, nativeExecution: result.nativeExecution, pipeline: result.pipeline, pipelineHash: ExecutionProtocol.hashPipeline(result.pipeline)})
  const forged = structuredClone(bundle)
  for (const reserved of forged.nativeExecution!.resources.invocationReservations) {reserved.maximumCandidates = 1; reserved.maximumRequests = 1; reserved.reservedWallSeconds = reserved.perRequestTimeoutSeconds}
  forged.nativeExecution!.resources.reservedEvaluationWallSeconds = 300; forged.nativeExecution!.resources.reservedEvaluationComputeSeconds = 300
  expect(() => ExecutionProtocol.TrialBundle.parse(forged)).toThrow('frozen evaluation census')
})

test('historical trial decoding keeps marker absence and scientific intent remains separate from native mechanism', () => {
  const historical = ResearchDomain.Trial.parse({id: 'trl_old', experimentId: 'exp_old', hypothesis: 'Original bytes', designAdapter: 'proto', programPath: 'trial.py', programHash: `sha256:${'1'.repeat(64)}`, status: 'proposed', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z'})
  expect(Object.hasOwn(historical, 'executionProtocol')).toBe(false)
  expect(compile({...authored(), declaration: {intent: 'calibrate'}}).nativeExecution.protocol).toBe('native_search_v1')
  const old=ExecutionProtocol.NativeExecution.parse({...compile(authored()).nativeExecution,observation:'public_native_monitoring_v1'})
  expect(old.observation).toBe('public_native_monitoring_v1')
  if(old.protocol==='native_search_v1')expect(Object.hasOwn(old.descriptor.projection[0]!,'name')).toBe(false)
})
