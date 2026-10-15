import type {MethodologyDeclaration} from '../scientific-methodology'
import type { CampaignKnowledgeReader } from '../knowledge'

/** Host binds one experiment, frozen contract, evaluator, and execution authorization. */
export interface DiscoverySciencePort {
  context(): Promise<unknown>
  queryKnowledge?(input: Parameters<CampaignKnowledgeReader['query']>[0]): Promise<unknown>
  readKnowledge?(input: Parameters<CampaignKnowledgeReader['read']>[0]): Promise<unknown>
  authorTrial(input: { program: string; hypothesis: string; intent?: 'optimize' | 'calibrate' | 'negative_control' | 'shadow_replay'; designAdapter?: 'mock' | 'proto' } & MethodologyDeclaration): Promise<unknown>
  evaluateTrial(input: { trialId: string; requestId: string; signal?: AbortSignal }): Promise<unknown>
  requestResearch(input: { question: string; competingExplanations: string[]; requiredEvidence: string; applicabilityChecks: string; decisionIfResolved: string; evidenceRefs?: string[] }): Promise<unknown>
  stop(input: { reason: string; rationale: string; evidenceRefs: string[] }): Promise<unknown>
}
