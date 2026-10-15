import type { Static, TSchema } from 'typebox'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { SessionHeader, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { Message, Usage } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai/models'

export type PiRunStatus = 'completed' | 'cancelled' | 'failed' | 'limit_reached'
export interface PiRuntimeEvent {
  sessionId: string
  sequence: number
  timestamp: number
  type: string
  data: unknown
}
export interface PiContextPolicy {
  /** Optional host input ceiling, bounded by the selected model's context window. */
  maxInputTokens?: number
  reserveTokens?: number
  keepRecentTokens?: number
  /** Optional retained projection ceiling for older large tool-result groups. */
  retainedToolBytes?: number
  /** Generic tool-name groups whose latest complete snapshot should remain in context. */
  retainLatestToolGroups?: string[][]
}
export interface PiContextCheckpoint {
  format: 'autofold.pi-context-compaction.v1'
  id: string
  createdAt: number
  model: {provider: string; modelId: string}
  /** Zero-based half-open source message range, including retained anchors. */
  originalRange: {start: number; end: number}
  sha256: string
  retainedAnchors: number[]
  scientificSnapshots?:import('./scientific-context').ScientificContextSnapshot[]
  summarization?:{format:'autofold.pi-summary-fragments.v1';weightUnit?:'estimated_tokens';nativeCapacity?:{sourceByteBudget:number;reservedOutputTokens:number;framingByteAllowance:number};summaryRequests:number;recompressionRequests:number;chunkBudget:number;cutAdvanced?:boolean;fragments:Array<Omit<import('./summary-fragments').SummaryFragment,'sourceText'>>;fallback?:PiArchiveContinuityFallback}
  anchors: {originalUserIndex: number; latestUserIndex: number; latestActionIndex: number}
  constraintExcerpts: {index: number; excerpt: string}[]
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  fixedInputTokens: number
  inputBudget: number
  reserveTokens: number
  /** Measured post-compaction target; the hard input ceiling remains inputBudget. */
  compactionTargetTokens?:number
  /** Future ordinary-input growth reserved after the exact payload and summary. */
  continuationHeadroomTokens?:number
  summaryReserveTokens?:number
  summary?: string
  usage?: Usage
}
export interface PiArchiveContinuityFallback {
  format:'autofold.pi-archive-continuity-fallback.v1'
  reason:'nonshrinking_summary'|'recompression_allowance'
  semanticCoverage:'unavailable'
  archive:{id:string;sha256:string;originalRange:{start:number;end:number}}
  sourceGroupCount:number
  attemptedFragmentCount:number
  unprocessedGroupCount:number
  unprocessedGroups:Array<{group:number;offsetBytes:number;totalBytes:number}>
  unprocessedGroupsOmitted:number
  sourceManifestHash:string
  unprocessedManifestHash:string
  rejectedContinuity:{sha256:string;bytes:number}
  lastReturnedSummary?:{source:'native_compaction_result';requestOrdinal:number;sha256:string;bytes:number}
}
export interface PiSession {
  id: string
  runtime: 'pi'
  version: 1
  piVersion: '1.0.1'
  metadata: Record<string, unknown>
  modelSelection: { provider: string; modelId: string }
  status: 'idle' | 'running' | PiRunStatus
  createdAt: number
  updatedAt: number
  sequence: number
  messages: Message[]
  /** Authoritative SDK session tree; persisted atomically with each host event. */
  sdk?: {format: 'autofold.pi-sdk-session.v1'; header: SessionHeader; entries: SessionEntry[]; leafId: string | null}
  /** Audited projections; original messages and boundary journal remain intact. */
  contextCompactions?: PiContextCheckpoint[]
  pendingTools: Record<string, { name: string; args: unknown; startedAt: number }>
  /** Provider dispatch is an external effect. Missing final usage is unknown, never a measured zero.
   * Optional only for transcripts written before the request ledger was introduced. */
  modelRequests?: Record<string, PiModelRequest>
  usage: { turns: number; toolCalls: number; costUsd: number }
  error?: string
}
export interface PiProviderBilling {
  source:'openrouter_stream'; upstreamRequestId?:string; routedProvider?:string; reportedCostUsd:number|null; status:'reported'|'unknown'; evidenceHash?:string
  finishReason?:string; observedModelId?:string
}
export interface PiModelRequest {
  /** Original owning grant reference; attribution never supplies authority. */
  owningBinding?: PiOwningBinding
  status: 'dispatched' | 'settled' | 'unknown' | 'not_dispatched'
  model: {provider: string; modelId: string}
  /** Frozen OpenRouter routing identity; dated aliases are accepted only through an explicit host binding. */
  modelBinding?: {provider:'openrouter';requestedModelId:string;canonicalModelId:string;source:'selected_model_id'|'explicit_host_alias'}
  /** Delivery state is independent of provider billing/accounting settlement. */
  delivery?: {status:'completed'|'failed';stopReason?:string;errorMessage?:string;partialToolCallCount:number;recordedAt:number}
  purpose: 'turn' | 'compaction'
  startedAt: number
  completedAt?: number
  /** Compatibility canonical ledger amount. New records label its semantics. */
  reportedCostUsd?: number
  costKind?:'sdk_estimate'|'provider_reported'
  estimatedCostUsd?:number
  providerBilling?:PiProviderBilling
  error?: string
  usageEvidence?: {receiptId: string; sha256: string; upstreamRequestId: string; source: string}
}
/** Host verification must attribute original provider evidence, never estimate missing usage. */
export interface PiVerifiedUsageReceipt {
  sessionId: string; requestId: string; model: {provider: string; modelId: string}; startedAt: number
  terminal: 'completed'; costUsd: number; receiptId: string; sha256: string; upstreamRequestId: string; source: string
  routedProvider?:string;canonicalModelId?:string;finishReason?:string
}
export type PiUsageReceiptVerifier = (input: {sessionId: string; requestId: string; request: Readonly<PiModelRequest>}) => Promise<PiVerifiedUsageReceipt>
/** Shared fence for job, campaign and direct controller accounting. Legacy completed usage remains readable. */
export function assertSessionAccountingComplete(session: PiSession) {
  const unresolved = Object.entries(session.modelRequests ?? {}).filter(([, request]) => !['settled', 'not_dispatched'].includes(request.status))
  if (unresolved.length) throw new Error(`Model accounting unavailable: ${unresolved.length} dispatched provider request(s) have unresolved usage`)
}
/** save atomically commits session state and its boundary event. Store is separate from research data. */
export interface PiSessionStore {
  get(id: string): Promise<PiSession | undefined>
  acquireLease(id: string, owner: string, ttlMs: number): Promise<boolean>
  renewLease(id: string, owner: string, ttlMs: number): Promise<boolean>
  releaseLease(id: string, owner: string): Promise<void>
  save(session: PiSession, event?: PiRuntimeEvent, leaseOwner?: string): Promise<void>
  events?(id: string): Promise<PiRuntimeEvent[]>
}
export interface PiLimits {
  maxTurns: number
  maxToolCalls: number
  maxDurationMs: number
  maxCostUsd: number
}
export interface PiModelSelection {
  provider: string
  modelId: string
  /** Explicit host metadata for a custom model, never a replacement model. */
  model?: Model<Api>
}
export interface RuntimeSkillResource {
  name:string;description:string;filePath:string;baseDir:string
}
export interface RuntimeResources {cwd:string;skills:RuntimeSkillResource[]}
export interface PiRuntimeOptions {
  store: PiSessionStore
  tools?: RuntimeTool<any>[]
  toolExecution?:'sequential'|'parallel'
  /** End after a successful host stop tool and its complete result boundary. */
  stopToolNames?: string[]
  systemPrompt?: string
  resources?:(signal?:AbortSignal)=>Promise<RuntimeResources>
  modelSelection?: PiModelSelection
  models?: MutableModels
  /** Explicit offline fixture provenance; custom provider streams alone never establish billing. */
  accountingProvenance?: 'offline_fixture'
  streamFn?: RuntimeStreamFn
  /** Transport options only. Response length is owned by Pi/model/provider, not an Autofold cap. */
  streamOptions?: Omit<SimpleStreamOptions, 'signal' | 'maxTokens'>
  limits?: Partial<PiLimits>
  /** Short renewable ownership, independent of long scientific worker deadlines. */
  leaseDurationMs?: number
  leaseHeartbeatMs?: number
  modelRequestTimeoutMs?: number
  /** Input context management only; never imposes an output-token cap. */
  contextPolicy?: PiContextPolicy
  /** Require explicit original upstream billing before another paid request or tool effect.
   * Built-in OpenRouter transport enables this; injected adapters must opt in explicitly. */
  requireProviderReportedUsage?:boolean
  /** Explicit bindings for dated/provider aliases; no automatic alias inference is allowed. */
  openRouterModelAliases?:Record<string,string>
  /** Optional transport injection for read-only OpenRouter generation recovery tests. */
  openRouterGenerationFetch?:typeof fetch
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  /** Host authority fence for every ordinary and compaction provider request.
   * Checked before intent and again after its durable write, at the provider boundary. */
  authorizeModelRequest?: (request: {sessionId: string; modelSelection: {provider: string; modelId: string}; purpose: 'turn' | 'compaction'}, signal: AbortSignal) => void | Promise<void>
  /** Rechecked after native tool interception and immediately before invocation. */
  authorizeToolCall?: (request: {sessionId:string;toolCallId:string;toolName:string;args:unknown}, signal:AbortSignal) => void | Promise<void>
  /** Actual ordinary inference after original response and usage settlement. */
  onInferenceContext?: (request:{sessionId:string;requestId:string;messages:import('@earendil-works/pi-ai').Message[]}) => void | Promise<void>
  /** Trusted scoped extensions only; ambient/operator extension discovery remains disabled. */
  extensions?: import('@earendil-works/pi-coding-agent').Extension[]
}
export interface PiRunResult {
  sessionId: string
  status: PiRunStatus
  session: PiSession
  error?: string
}
export interface PiRunOptions {
  owningBinding?: PiOwningBinding
  /** Only new trusted host snapshots may omit exact-human retention. */
  promptOrigin?: 'host_context'
  /** Literal human requirements, appended once to the original SDK tree. */
  exactInstructions?: Array<{id:string;text:string}>
  signal?: AbortSignal
  onEvent?: (event: PiRuntimeEvent) => void | Promise<void>
}
export interface PiOwningBinding {operationId:string;jobId?:string;bindingHash:string}
export interface RuntimeToolDelivery {
  phase:'published'|'inference'
  content:RuntimeToolResult['content']; details:unknown; isError:boolean
  projection:'full'|'artifact_reference'
  /** Host-only source order in this settled ordinary inference; absent on publication. */
  inference?:{requestId:string;position:number;toolCallId:string}
}

/** Host-owned executable scientific tool contract. No operator discovery or filesystem access is implied. */
export interface RuntimeTool<T extends TSchema = TSchema, TDetails = any> {
  /** Final normalized model-facing publication; hidden details are not exposure. */
  onDelivery?: (delivery:RuntimeToolDelivery) => void | Promise<void>
  name: string
  label: string
  description: string
  parameters: T
  executionMode?: 'sequential' | 'parallel'
  replay?: 'never' | 'safe'
  prepareArguments?: (args: unknown) => unknown
  execute: (id: string, args: Static<T>, signal?: AbortSignal,
    onUpdate?: (result: RuntimeToolResult<TDetails>) => void) => Promise<RuntimeToolResult<TDetails>>
}
export interface RuntimeToolResult<TDetails = any> {
  /** Successful host request to return control after this tool batch settles. */
  terminate?: boolean
  isError?: boolean
  content: ({type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string})[]
  details: TDetails
}
export type RuntimeMessage = Message
export type RuntimeModel = Model<Api>
/** Provider streaming compatibility is confined to runtime injection; science tools need only RuntimeTool. */
export type RuntimeStreamFn = (model: RuntimeModel, context: import('@earendil-works/pi-ai').TranscriptContext,
  options?: SimpleStreamOptions) => import('@earendil-works/pi-ai').AssistantMessageEventStream | Promise<import('@earendil-works/pi-ai').AssistantMessageEventStream>
export type AgentRuntimeOptions = PiRuntimeOptions
export interface AgentRuntime {
  create(input?: {id?: string; metadata?: Record<string, unknown>}): Promise<PiSession>
  get(id: string): Promise<PiSession | undefined>
  resume(id: string): Promise<PiSession>
  run(id: string, prompt: string, options?: PiRunOptions): Promise<PiRunResult>
  cancel(id: string): void
  readContextArchive(id: string, input: {archiveId: string; offset?: number; limit?: number}, signal?: AbortSignal): Promise<{
    archiveId: string; originalRange: {start: number; end: number}; sha256: string; encoding: string;
    offset: number; totalCharacters: number; content: string; nextOffset: number | null; authority: string
  }>
}
