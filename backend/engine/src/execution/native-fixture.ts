/** Construction doubles for admission tests. These are never dispatched. */
import type {ResearchWorkflow} from '@autofold/science-core/workflow'
import path from 'node:path'
/** Fresh CPU fixtures require the actual reviewed lifecycle fork, never the historical base. */
export const nativeFixtureRoot = process.env.AUTOFOLD_TEST_PROTO_ROOT ?? path.resolve(import.meta.dir, '../../../../.autofold/cohesive-engine-refactor-20261012/upstream-proto/v4/source')
export function withNativeSearch(trial: ResearchWorkflow.AuthoredTrial, generator?: {key: string; toolsCalled?: string[]}) {
  const toolsCalled = generator?.toolsCalled ?? []
  const results = trial.program.programResultCount ?? 1
  return {...trial, executionProtocol: 'native_search_v1' as const, nativeObservation: 'scoped_native_lifecycle_v1' as const, generation: null, nativeSearch: {
    format: 'autofold.native-search.v1' as const,
    budget: {maximumCandidates: results, maximumProposals: 4, maximumSamplingCalls: 4, maximumToolCalls: 4, maximumWallSeconds: 1, allowedTools: toolsCalled, outputs: [{construct: 'candidate', segment: null, lane: 0}]},
    projection: [{lane: 0, programSeed: 7, name:null, externalInputs: [], numResults: results, constructs: [{label: 'candidate'}], stages: [{instanceId: 'lane0.stage0', optimizer: 'RejectionSamplingOptimizer', config: {}, settings: {}, numResults: results, conditioning: null, targetSegment: null, customLogging: null,
      generators: generator ? [{instanceId: 'lane0.stage0.generator0', key: generator.key, segments: [], config: {}, toolsCalled}] : [], constraints: []}]}],
  }} satisfies ResearchWorkflow.AuthoredTrial
}
