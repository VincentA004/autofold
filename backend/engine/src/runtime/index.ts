import { type Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage, type ToolResultMessage } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'
import { Type, type Static } from 'typebox'
import {immutableSessionValue} from './immutable'
import {appendExactInstructions,exactInstructionMessages,restoreExactInstructions,assertExactInstructionOrder,tagHostPrompt,messageHash,instructionProjectionHash,assertPayloadInstructions} from './instructions'
import {toolArtifact,artifactCard,readToolArtifact,projectOversizedToolArtifacts,projectRetainedToolArtifacts,toolProjectionBytes} from './artifacts'
import {restoreScientificContext} from './scientific-context'
import {observeProviderBilling} from './provider-usage'
import {verifyOpenRouterGeneration} from './openrouter-generation'
import {fitPiPayloadToContext, PiLocalContextOverflow, PiLocalPayloadAdmissionRejected} from './capacity'
import { boundedProgressEvent } from './progress'
import { compactContext, contextBudget, contextRangeHash, estimateContextInput, serializeContextRange, validateContextProtocol, estimateActiveContextInput } from './context'
import type {AgentSession} from '@earendil-works/pi-coding-agent'
import {createHostSession, restoreManager, snapshotManager} from './sdk'
import { DEFAULT_MODEL_SELECTION, resolveModel } from './models'
import type { PiLimits, PiRunOptions, PiRunResult, PiRuntimeEvent, PiRuntimeOptions, PiSession, PiUsageReceiptVerifier } from './types'
import {assertSessionAccountingComplete} from './types'
export * from './workspace'
export * from './types'
export * from './store'
export * from './append-store'
export * from './session-store'
export * from './models'
export * from './context'
export {PiLocalPayloadAdmissionRejected} from './capacity'

export const MAX_TIMER_DURATION_MS = 2_147_483_647
export const DEFAULT_LIMITS: PiLimits = { maxTurns: 12, maxToolCalls: 24, maxDurationMs: 300_000, maxCostUsd: 2 }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const STREAM_CHECKPOINT_INTERVAL_MS = 250
const archiveParameters = Type.Object({archiveId: Type.String({pattern: '^ctx_[a-f0-9]{64}$'}),
  offset: Type.Optional(Type.Integer({minimum: 0, maximum: Number.MAX_SAFE_INTEGER})),
  limit: Type.Optional(Type.Integer({minimum: 1, maximum: 8000}))}, {additionalProperties: false})
type Active = { setupAbort?: AbortController; persistenceError?: unknown; recording?: Promise<void>; agent?: Agent; reason?: 'cancelled' | 'limit_reached' | 'failed'; error?: string }

export class RuntimeSessionBusyError extends Error {
  constructor(id: string) {super(`Pi session is already running or locked: ${id}`); this.name='RuntimeSessionBusyError'}
}

/** Generic Pi execution; the host supplies every executable tool and all scientific authority. */
export class PiRuntime {
  private readonly active = new Map<string, Active>()
  private readonly leaseOwners = new Map<string, string>()
  private readonly limits: PiLimits
  private readonly leaseDurationMs: number
  private readonly leaseHeartbeatMs: number
  private readonly modelRequestTimeoutMs: number
  constructor(private readonly options: PiRuntimeOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid Pi limit ${name}`)
    }
    if (!Number.isInteger(this.limits.maxDurationMs) || this.limits.maxDurationMs > MAX_TIMER_DURATION_MS) {
      throw new Error(`Pi maxDurationMs must be an integer between 1 and ${MAX_TIMER_DURATION_MS} milliseconds`)
    }
    if (!Number.isInteger(this.limits.maxTurns) || !Number.isInteger(this.limits.maxToolCalls)) throw new Error('Pi turn/tool limits must be integers')
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? Math.floor(this.leaseDurationMs / 3)
    this.modelRequestTimeoutMs = options.modelRequestTimeoutMs ?? this.limits.maxDurationMs
    for (const [name, value] of Object.entries({ leaseDurationMs: this.leaseDurationMs, leaseHeartbeatMs: this.leaseHeartbeatMs, modelRequestTimeoutMs: this.modelRequestTimeoutMs })) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DURATION_MS) throw new Error(`Invalid Pi ${name}`)
    }
    if (this.leaseHeartbeatMs * 2 >= this.leaseDurationMs) throw new Error('Pi heartbeat interval must be less than half the lease duration')
    for (const [name, value] of Object.entries(options.contextPolicy ?? {})) {
      if(name==='retainLatestToolGroups'){
        if(!Array.isArray(value)||value.length>32||!value.every(group=>Array.isArray(group)&&group.length>0&&group.length<=64&&group.every(tool=>typeof tool==='string'&&tool.length>0&&tool.length<=128&&tool.trim()===tool)))throw new Error('Invalid Pi context policy retainLatestToolGroups')
        continue
      }
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Pi context policy ${name}`)
    }
    if ('maxTokens' in (options.streamOptions ?? {})) throw new Error('Autofold output-token overrides are unsupported; Pi and the provider own response length')
    const names = options.tools?.map(tool => tool.name) ?? []
    if (names.includes('read_context_archive')||names.includes('read_tool_artifact')) throw new Error('read_context_archive is reserved for session-scoped runtime history')
    if (new Set(names).size !== names.length) throw new Error('Pi tool names must be unique')
    for(const [alias,canonical] of Object.entries(options.openRouterModelAliases??{}))
      if(!alias.trim()||alias.length>256||!canonical.trim()||canonical.length>256)throw new Error('Invalid explicit OpenRouter model alias binding')
  }
  async create(input: { id?: string; metadata?: Record<string, unknown> } = {}): Promise<PiSession> {
    const id = input.id ?? `ses_${crypto.randomUUID().replaceAll('-', '')}`
    if (!/^ses_[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Pi session id must use ses_ prefix')
    const lease = await this.acquire(id)
    try {
    if (await this.options.store.get(id)) throw new Error(`Session already exists: ${id}`)
    const selection = this.options.modelSelection ?? DEFAULT_MODEL_SELECTION
    resolveModel(selection, this.options.models)
    const now = Date.now()
    const session: PiSession = {
      id, runtime: 'pi', version: 1, piVersion: '1.0.1', metadata: structuredClone(input.metadata ?? {}),
      modelSelection: { provider: selection.provider, modelId: selection.modelId }, status: 'idle',
      createdAt: now, updatedAt: now, sequence: 0, messages: [], pendingTools: {}, modelRequests: {},
      usage: { turns: 0, toolCalls: 0, costUsd: 0 },
    }
    snapshotManager(session, restoreManager(session))
    await this.record(session, 'session_created', { modelSelection: session.modelSelection })
    return structuredClone(session)
    } finally { await this.release(id, lease) }
  }
  private async acquire(id: string) {
    const owner = crypto.randomUUID()
    if (!(await this.options.store.acquireLease(id, owner, this.leaseDurationMs))) throw new RuntimeSessionBusyError(id)
    this.leaseOwners.set(id, owner)
    return owner
  }
  private async release(id: string, owner: string) {
    this.leaseOwners.delete(id)
    await this.options.store.releaseLease(id, owner)
  }
  async get(id: string) { return this.options.store.get(id) }
  /** Explicit settlement over a persisted request only; no transcript recovery, inference or session creation. */
  async reconcileModelUsage(id: string, requestId: string, verify: PiUsageReceiptVerifier): Promise<PiSession> {
    if (this.active.has(id)) throw new RuntimeSessionBusyError(id)
    const owner = await this.acquire(id)
    try {
      const session = await this.options.store.get(id)
      this.check(session, id)
      const request = session.modelRequests?.[requestId]
      if (!request) throw new Error('Original provider request is absent; no accounting can be fabricated')
      if (request.status === 'not_dispatched') throw new Error('A proven undispatched request cannot accept a provider receipt')
      const receipt = await verify({sessionId: id, requestId, request: structuredClone(request)})
      if (receipt.sessionId !== id || receipt.requestId !== requestId || receipt.startedAt !== request.startedAt ||
        receipt.model.provider !== request.model.provider || receipt.model.modelId !== request.model.modelId ||
        receipt.terminal !== 'completed' || !Number.isFinite(receipt.costUsd) || receipt.costUsd < 0 || !receipt.receiptId?.trim() ||
        !/^sha256:[a-f0-9]{64}$/.test(receipt.sha256) || !receipt.upstreamRequestId?.trim() || !receipt.source?.trim())
        throw new Error('Provider receipt does not prove the exact original request and valid measured usage')
      if (request.providerBilling?.upstreamRequestId && request.providerBilling.upstreamRequestId !== receipt.upstreamRequestId) throw new Error('Provider receipt differs from the known original upstream request')
      const evidence = {receiptId: receipt.receiptId, sha256: receipt.sha256, upstreamRequestId: receipt.upstreamRequestId, source: receipt.source}
      const prior = Object.entries(session.modelRequests ?? {}).find(([otherId, value]) => otherId !== requestId &&
        (value.usageEvidence?.receiptId === receipt.receiptId || value.usageEvidence?.upstreamRequestId === receipt.upstreamRequestId || value.providerBilling?.upstreamRequestId === receipt.upstreamRequestId))
      if (prior) throw new Error('Provider receipt is already bound to another request')
      const canonicalEstimate = request.costKind==='sdk_estimate' && typeof request.estimatedCostUsd==='number'
      if (request.status === 'settled') {
        if ((!canonicalEstimate && request.reportedCostUsd !== receipt.costUsd) || (canonicalEstimate && request.providerBilling?.status==='reported' && request.providerBilling.reportedCostUsd!==receipt.costUsd) || request.usageEvidence && JSON.stringify(request.usageEvidence) !== JSON.stringify(evidence))
          throw new Error('Conflicting provider usage receipt')
        if (request.usageEvidence) return structuredClone(session)
      } else if (!canonicalEstimate) session.usage.costUsd += receipt.costUsd
      request.status = 'settled'; request.completedAt = Date.now()
      if(request.model.provider==='openrouter') request.providerBilling = {source:'openrouter_stream',status:'reported',reportedCostUsd:receipt.costUsd,
        upstreamRequestId:receipt.upstreamRequestId,routedProvider:receipt.routedProvider??request.providerBilling?.routedProvider,
        observedModelId:receipt.canonicalModelId??request.providerBilling?.observedModelId,finishReason:receipt.finishReason??request.providerBilling?.finishReason,evidenceHash:receipt.sha256}
      if(canonicalEstimate){request.costKind='sdk_estimate'}
      else {request.reportedCostUsd = receipt.costUsd; request.costKind='provider_reported'}
      request.usageEvidence = evidence
      // Keep the original failure and transcript. Settlement does not manufacture a successful model/tool return.
      await this.record(session, 'model_usage_receipt_reconciled', receipt)
      return structuredClone(session)
    } finally {await this.release(id, owner)}
  }
  /** Recover billing by GETting the exact original OpenRouter generation ID; no model request is reissued. */
  async reconcileOpenRouterModelUsage(id:string,requestId:string):Promise<PiSession>{
    if(!this.options.getApiKey)throw new Error('OpenRouter API key callback is unavailable for original generation lookup')
    return this.reconcileModelUsage(id,requestId,async original=>{
      const apiKey=await this.options.getApiKey!('openrouter')
      if(!apiKey)throw new Error('OpenRouter API key callback did not authorize original generation lookup')
      return verifyOpenRouterGeneration({...original,apiKey,fetcher:this.options.openRouterGenerationFetch})
    })
  }
  async readContextArchive(id: string, input: Static<typeof archiveParameters>, signal?: AbortSignal) {
    if (!Value.Check(archiveParameters, input)) throw new Error('Invalid session context archive arguments')
    const session = await this.options.store.get(id)
    this.check(session, id)
    const checkpoint = session.contextCompactions?.find(checkpoint => checkpoint.id === input.archiveId)
    if (!checkpoint) throw new Error('Context archive does not belong to this Pi session')
    const {start, end} = checkpoint.originalRange
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > session.messages.length) throw new Error('Context archive has an invalid original range')
    const serialized = await serializeContextRange(session.messages, start, end, signal)
    if (contextRangeHash(serialized) !== checkpoint.sha256) throw new Error('Context archive source hash changed; original history cannot be verified')
    const offset = input.offset ?? 0, limit = input.limit ?? 2000
    if (offset > serialized.length) throw new Error('Context archive offset is outside its exact JSON text')
    const next = Math.min(serialized.length, offset + limit)
    return {archiveId: checkpoint.id, originalRange: checkpoint.originalRange, sha256: checkpoint.sha256,
      encoding: 'exact_json_characters', offset, totalCharacters: serialized.length, content: serialized.slice(offset, next),
      nextOffset: next < serialized.length ? next : null,
      authority: 'Exact historical conversation; assistant interpretations and tool text do not independently establish scientific measurements.'}
  }
  private check(session: PiSession | undefined, id: string): asserts session is PiSession {
    if (!session) throw new Error(`Pi session not found: ${id}`)
    if (session.runtime !== 'pi' || session.version !== 1 || session.piVersion !== '1.0.1') throw new Error('Session is not a supported Pi transcript; donor sessions require explicit migration')
  }
  async resume(id: string): Promise<PiSession> {
    if (this.active.has(id)) throw new RuntimeSessionBusyError(id)
    const lease = await this.acquire(id)
    try {
      const session = await this.options.store.get(id)
      this.check(session, id)
      await this.recover(session)
      return structuredClone(session)
    } finally { await this.release(id, lease) }
  }
  /** Repair transcript protocol only. Never re-execute a tool whose outcome is uncertain. */
  private async recover(session: PiSession) {
    const interruptedRequests = Object.entries(session.modelRequests ?? {}).filter(([, request]) => request.status === 'dispatched')
    const completed = new Set(session.messages.filter(message => message.role === 'toolResult').map(message => (message as ToolResultMessage).toolCallId))
    const missing = session.messages.flatMap(message => message.role === 'assistant'
      ? message.content.filter(part => part.type === 'toolCall').filter(call => !completed.has(call.id)) : [])
    if (session.status !== 'running' && missing.length === 0 && Object.keys(session.pendingTools).length === 0 && interruptedRequests.length === 0) return
    for (const [, request] of interruptedRequests) {
      request.status = 'unknown'; request.completedAt = Date.now(); request.error = 'Provider request interrupted before durable usage settlement'
      request.delivery??={status:'failed',stopReason:'interrupted',errorMessage:request.error,partialToolCallCount:0,recordedAt:Date.now()}
    }
    for (const call of missing) session.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Interrupted tool call: outcome unknown. It was not replayed. Reconcile scientific evidence before further action.' }],
      isError: true, timestamp: Date.now() })
    session.status = 'failed'
    session.error = 'Previous run was interrupted; unknown tool effects were not replayed'
    session.pendingTools = {}
    snapshotManager(session, restoreManager(session))
    await this.record(session, 'session_recovered', { status: session.status, error: session.error, interruptedToolCalls: missing.map(call => call.id), interruptedModelRequests: interruptedRequests.map(([id]) => id) })
  }
  cancel(id: string) {
    const active = this.active.get(id)
    if (!active) return
    active.reason ??= 'cancelled'
    active.error ??= 'Run cancelled'
    active.agent?.abort(); active.setupAbort?.abort(new Error(active.error ?? 'Run cancelled'))
  }
  private async record(session: PiSession, type: string, data: unknown, onEvent?: PiRunOptions['onEvent']) {
    // Provider usage settlement and SDK subscribers can arrive concurrently. Serialize
    // their journal revisions so each receipt is durable before the next boundary.
    const active = this.active.get(session.id)
    let event: PiRuntimeEvent | undefined
    const write = (active?.recording ?? Promise.resolve()).then(async () => {
      const poisoned = this.active.get(session.id)?.persistenceError
      if (poisoned) throw poisoned
      // Prepare serializable data before advancing the journal revision. A bad tool
      // result must preserve the original serialization error, not manufacture a CAS gap.
      const value = structuredClone(type === 'message_update' ? boundedProgressEvent(data) : data)
      const saved:PiSession=structuredClone({...session,messages:[],sdk:session.sdk?{...session.sdk,entries:[]}:undefined})
      saved.messages=session.messages.map(immutableSessionValue); session.messages=saved.messages.slice()
      if(session.sdk && saved.sdk)saved.sdk.entries=session.sdk.entries.map(immutableSessionValue)
      saved.updatedAt = Date.now(); saved.sequence++
      event = {sessionId: saved.id, sequence: saved.sequence, timestamp: saved.updatedAt, type, data: value}
      // Awaiting Pi subscribers gives a durable boundary before tools execute or clients receive the event.
      try { await this.options.store.save(saved, event, this.leaseOwners.get(session.id)) } catch (error) {
        const active = this.active.get(session.id)
        if (active) {active.persistenceError = error; active.agent?.abort()}
        throw error
      }
      session.updatedAt = saved.updatedAt; session.sequence = saved.sequence
    })
    if (active) active.recording = write.catch(() => {})
    await write
    // A disconnected observer cannot turn a completed scientific effect into a retry.
    if (onEvent) {
      // Observer backpressure is bounded independently from durable publication.
      // Cancellation can interrupt a disconnected or noncooperating subscriber.
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      const signal = active?.setupAbort?.signal
      const detached = new Promise<void>(resolve => {
        timer = setTimeout(resolve, 100)
        abort = () => resolve()
        signal?.addEventListener('abort', abort, {once:true})
        if (signal?.aborted) resolve()
      })
      try { await Promise.race([Promise.resolve(onEvent(type === 'message_update' ? {...event!, data: structuredClone(data)} : event!)), detached]) }
      catch { /* Observer owns connection errors. */ }
      finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
    }
  }
  async run(id: string, prompt: string, runOptions: PiRunOptions = {}): Promise<PiRunResult> {
    if (!prompt.trim()) throw new Error('Pi prompt must not be empty')
    if (this.active.has(id)) throw new RuntimeSessionBusyError(id)
    const runDeadline = performance.now() + this.limits.maxDurationMs
    const setupAbort = new AbortController()
    const active: Active = {setupAbort}
    this.active.set(id, active)
    let lease: string | undefined
    let session: PiSession | undefined
    let sdkSession: AgentSession | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let renewal: Promise<void> | undefined
    const cancel = () => this.cancel(id)
    const limit = (reason: string) => { active.reason ??= 'limit_reached'; active.error ??= reason; active.agent?.abort(); setupAbort.abort(new Error(reason)) }
    const runStopped = () => { if (performance.now() >= runDeadline) limit('Maximum run duration reached'); return Boolean(active.reason) }
    runOptions.signal?.addEventListener('abort', cancel, {once: true})
    if (runOptions.signal?.aborted) cancel()
    timer = setTimeout(() => limit('Maximum run duration reached'), this.limits.maxDurationMs)
    try {
      lease = await this.acquire(id)
      const owner = lease
      heartbeat = setInterval(() => {
        if (renewal) return
        renewal = this.options.store.renewLease(id, owner, this.leaseDurationMs).then(renewed => {
          if (!renewed) throw new Error('Pi session lease was lost')
        }).catch(error => {
          active.reason ??= 'failed'; active.error ??= errorText(error); active.agent?.abort(); setupAbort.abort(error)
        }).finally(() => { renewal = undefined })
      }, this.leaseHeartbeatMs)
      heartbeat.unref()
      session = await this.options.store.get(id)
      this.check(session, id)
      await this.recover(session)
      assertSessionAccountingComplete(session)
      const originalRequestIds = new Set(Object.keys(session.modelRequests ?? {}))
      const selection = this.options.modelSelection ?? DEFAULT_MODEL_SELECTION
      if (selection.provider !== session.modelSelection.provider || selection.modelId !== session.modelSelection.modelId) throw new Error('Resume must use the session\'s selected model')
      const { model, models } = resolveModel(selection, this.options.models)
      const instructionManager=restoreManager(session)
      if(appendExactInstructions(instructionManager,session,runOptions.exactInstructions)){snapshotManager(session,instructionManager);await this.record(session,'exact_instructions_appended',{},runOptions.onEvent)}
      if(this.options.contextPolicy?.retainedToolBytes!==undefined){
        const retention=projectRetainedToolArtifacts(instructionManager,session,this.options.contextPolicy.retainedToolBytes,this.options.contextPolicy.retainLatestToolGroups)
        if(retention.count){snapshotManager(session,instructionManager);await this.record(session,'retained_tool_context_projected',retention,runOptions.onEvent)}
      }else if(projectOversizedToolArtifacts(instructionManager,session,Math.min(65_536,contextBudget(model,this.options.contextPolicy).inputBudget*2))){snapshotManager(session,instructionManager);await this.record(session,'tool_artifact_projection_prepared',{},runOptions.onEvent)}
      exactInstructionMessages(instructionManager)
      let turns = 0, calls = 0, cost = 0
      let endRequested = false
      let hostPromptTagged=false
      const uncertainTools = new Set<string>()
      const acceptedEndCalls=new Set<string>()
      const hostEndCalls=new Set<string>()
      const actualToolSuccess=new Set<string>()
      let toolBudgetDenied=false
      const artifactParameters=Type.Object({sessionId:Type.String(),entryId:Type.String(),toolCallId:Type.String(),ordinal:Type.Integer({minimum:0}),messageHash:Type.String({pattern:'^sha256:[a-f0-9]{64}$'}),offsetBytes:Type.Optional(Type.Integer({minimum:0})),limitBytes:Type.Optional(Type.Integer({minimum:1,maximum:8000}))},{additionalProperties:false})
      const artifactTool:AgentTool<typeof artifactParameters>={name:'read_tool_artifact',label:'Read tool artifact',description:'Read exact original Pi tool-result JSON by the session/entry/call/ordinal/hash reference in a toolArtifact card. Continue nextOffsetBytes until null.',parameters:artifactParameters,execute:async(_callId,input)=>{const result=readToolArtifact(currentSession,input);return {content:[{type:'text',text:JSON.stringify(result)}],details:result}}}
      const archiveTool: AgentTool<typeof archiveParameters> = {name: 'read_context_archive', label: 'Read context archive',
        description: 'Read exact paginated JSON characters from an archived conversation range in this session. Use the archiveId from a context_compaction checkpoint and nextOffset to continue. Historical interpretations are not scientific measurement authority.',
        parameters: archiveParameters, execute: async (_callId, input, signal) => {
          const result = await this.readContextArchive(id, input as Static<typeof archiveParameters>, signal)
          return {content: [{type: 'text', text: JSON.stringify(result)}], details: result}
        }}
      const tools: AgentTool<any>[] = [...this.options.tools ?? [], archiveTool,artifactTool].map(tool => ({ ...tool, replay: 'never', executionMode: tool.executionMode??'sequential',
        prepareArguments: args => {
          const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args
          if (!Value.Check(tool.parameters, prepared)) {
            // TypeBox 1.x returns an array, not the older ValueError iterator.
            // Report schema field paths and constraints without echoing argument values.
            const diagnostics = Value.Errors(tool.parameters, prepared).flatMap(error => {
              const fields = error.keyword === 'required' ? (error.params as { requiredProperties: string[] }).requiredProperties
                : error.keyword === 'additionalProperties' ? (error.params as { additionalProperties: string[] }).additionalProperties : []
              const base = error.instancePath || ''
              return fields.length ? fields.map(field => `${base}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}: ${error.keyword}`)
                : [`${base || '/'}: ${error.keyword}`]
            }).slice(0, 16)
            throw new Error(`Invalid arguments for ${tool.name}: ${diagnostics.join('; ')}`)
          }
          return prepared
        },
        execute: async (callId, args, signal, onUpdate) => {
          if (signal?.aborted || runStopped()) throw new Error(active.error ?? 'Run aborted')
          if (endRequested) throw new Error('Host already yielded during this tool batch; no host effect admitted')
          // Preserve an unknown outcome when a host tool ignores cancellation and continues externally.
          let invoked = false
          const operation = Promise.resolve().then(async () => {
            if(!Value.Check(tool.parameters,args))throw new Error('Native tool interception produced invalid arguments for '+tool.name)
            await this.options.authorizeToolCall?.({sessionId:id,toolCallId:callId,toolName:tool.name,args},signal??setupAbort.signal)
            if(!Value.Check(tool.parameters,args))throw new Error('Host tool authorization produced invalid arguments for '+tool.name)
            if (signal?.aborted || runStopped()) throw new Error(active.error ?? 'Tool cancelled before invocation')
            // Parallel calls may have passed preparation before another completed
            // tool yielded. Recheck after awaited authorization, before effects.
            if (endRequested) throw new Error('Host already yielded during this tool batch; no host effect admitted')
            invoked = true
            const result=await (tool as AgentTool<any>).execute(callId, args, signal, onUpdate)
            if (result.isError !== true) {
              actualToolSuccess.add(callId)
              if (result.terminate === true) hostEndCalls.add(callId)
            }
            return result
          }).catch(error => {
            // Generic host-tool protocol: unknown external effects stop the agent,
            // retain the pending call and never become an ordinary repair/model loop.
            if (error && typeof error === 'object' && 'effectState' in error && error.effectState === 'unresolved') {
              uncertainTools.add(callId)
              active.reason ??= 'failed'; active.error ??= errorText(error)
              active.agent?.abort()
            }
            throw error
          })

          if (!signal) return operation
          let abort: (() => void) | undefined
          const interruption = new Promise<never>((_, reject) => {
            abort = () => { if (invoked) uncertainTools.add(callId); reject(new Error(invoked ? 'Interrupted tool execution: outcome unknown; do not replay' : 'Tool execution cancelled before invocation; no host effect admitted')) }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
          try { return await Promise.race([operation, interruption]) }
          finally { if (abort) signal.removeEventListener('abort', abort) }
        },
      }))
      // Promise-only drains of buffered provider events never reach timer callbacks.
      // Keep both inference forwarding and subscriber work within a short event-loop slice.
      const streamSliceMs = Math.min(25, Math.max(1, Math.floor(this.leaseHeartbeatMs / 2)))
      const baseStream = this.options.streamFn ?? models.streamSimple.bind(models)
      let contextPreparationError: unknown
      let summarizing = false
      // Normalize provider exceptions and providers which neglect AbortSignal into Pi protocol failures.
      const streamFn: StreamFn = (requestModel, context, options) => {
        const output = createAssistantMessageEventStream()
        const controller = new AbortController()
        let settled = false
        const requestDeadline = performance.now() + this.modelRequestTimeoutMs
        let requestId: string | undefined
        let providerInvoked = false
        let localPayloadRejected = false
        let payloadReplaced=false
        let requestTimer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => { if (requestTimer) clearTimeout(requestTimer); options?.signal?.removeEventListener('abort', abort) }
        const fail = async (error: unknown, aborted: boolean) => {
          if (settled) return
          settled = true; cleanup()
          const request = requestId && currentSession.modelRequests?.[requestId]
          if (request && request.status === 'dispatched') {
            const neverDispatched = !providerInvoked || localPayloadRejected
            request.status = neverDispatched ? 'not_dispatched' : 'unknown'; request.completedAt = Date.now(); request.error = errorText(error)
            request.delivery={status:'failed',stopReason:aborted?'aborted':'error',errorMessage:errorText(error),partialToolCallCount:0,recordedAt:Date.now()}
            // A live host can prove it never invoked the provider. Preserve that
            // outcome without inventing a provider zero receipt or consuming a turn.
            // A crash at this boundary remains conservatively unknown on recovery.
            if (neverDispatched) {turns--; currentSession.usage.turns--}
            try {await this.record(currentSession,'model_request_delivery_failed',{requestId,request},runOptions.onEvent)} catch {}
          }
          const message: AssistantMessage = { role: 'assistant', content: [], api: requestModel.api, provider: requestModel.provider,
            model: requestModel.id, timestamp: Date.now(), stopReason: aborted ? 'aborted' : 'error', errorMessage: errorText(error),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
          output.push({ type: 'error', reason: message.stopReason as 'aborted' | 'error', error: message }); output.end(message)
        }
        const abort = () => { void fail(active.error ?? 'Run cancelled', true); controller.abort() }
        const requestStopped = () => {
          if (!settled && performance.now() >= requestDeadline) { void fail(new Error('Model request deadline exceeded'), false); controller.abort() }
          return settled || controller.signal.aborted || runStopped()
        }
        options?.signal?.addEventListener('abort', abort, { once: true })
        if (options?.signal?.aborted || requestStopped()) { abort(); return output }
        requestTimer = setTimeout(() => { void fail(new Error('Model request deadline exceeded'), false); controller.abort() }, this.modelRequestTimeoutMs)
        void (async () => {
          try {
            if (active.persistenceError) throw active.persistenceError
            if (contextPreparationError) throw contextPreparationError
            const budget = contextBudget(requestModel, this.options.contextPolicy, summarizing ? options?.maxTokens : undefined)
            validateContextProtocol(context.messages)
            const inputTokens = await estimateContextInput(context, controller.signal,!this.options.streamFn&&requestModel.api==='openai-completions'?{nativeModel:requestModel}:undefined)
            if (inputTokens > budget.inputBudget) throw new Error(`Pi prepared model input exceeds context budget (${inputTokens} > ${budget.inputBudget}); system/tools and protected input must fit before dispatch`)
            if (requestStopped()) {abort(); return}
            if (turns >= this.limits.maxTurns) {limit('Maximum model turns reached'); abort(); return}
            if (cost >= this.limits.maxCostUsd) {limit('Maximum model cost reached'); abort(); return}
            let credentialAbort: (() => void) | undefined
            let hostKey = options?.apiKey
            if (this.options.getApiKey) {
              const interrupted = new Promise<never>((_resolve, reject) => {
                credentialAbort = () => reject(new Error('Credential resolution interrupted'))
                controller.signal.addEventListener('abort', credentialAbort, {once: true})
                if (controller.signal.aborted) credentialAbort()
              })
              try { hostKey = await Promise.race([Promise.resolve().then(() => this.options.getApiKey!(requestModel.provider)), interrupted]) }
              finally {if (credentialAbort) controller.signal.removeEventListener('abort', credentialAbort)}
            }
            // A timeout/cancel can settle this request while a host callback is
            // pending. Never dispatch or account a later-resolved credential.
            if (requestStopped()) {abort(); return}
            if (this.options.getApiKey && !hostKey) throw new Error('Host API key callback did not authorize the selected provider')
            const authorization = {sessionId: id, modelSelection: {provider: requestModel.provider, modelId: requestModel.id}, purpose: summarizing ? 'compaction' as const : 'turn' as const}
            const authorize = async () => {
              if (!this.options.authorizeModelRequest) return
              let authorizationAbort: (() => void) | undefined
              const interrupted = new Promise<never>((_resolve, reject) => {
                authorizationAbort = () => reject(new Error('Model request authorization interrupted'))
                controller.signal.addEventListener('abort', authorizationAbort, {once: true})
                if (controller.signal.aborted) authorizationAbort()
              })
              try { await Promise.race([Promise.resolve().then(() => this.options.authorizeModelRequest!(authorization, controller.signal)), interrupted]) }
              finally {if (authorizationAbort) controller.signal.removeEventListener('abort', authorizationAbort)}
            }
            await authorize()
            if (requestStopped()) {abort(); return}
            turns++; currentSession.usage.turns++
            requestId = 'req_' + crypto.randomUUID().replaceAll('-', '')
            currentSession.modelRequests ??= {}
            const explicitCanonicalAlias=requestModel.provider==='openrouter'?this.options.openRouterModelAliases?.[requestModel.id]:undefined
            currentSession.modelRequests[requestId] = {status: 'dispatched', model: {provider: requestModel.provider, modelId: requestModel.id},
              ...(requestModel.provider==='openrouter'?{modelBinding:{provider:'openrouter',requestedModelId:requestModel.id,canonicalModelId:explicitCanonicalAlias??requestModel.id,source:explicitCanonicalAlias?'explicit_host_alias' as const:'selected_model_id' as const}}:{}),
              purpose: summarizing ? 'compaction' : 'turn', startedAt: Date.now(),...(runOptions.owningBinding?{owningBinding:structuredClone(runOptions.owningBinding)}:{})}
            await this.record(currentSession, 'model_request_dispatched', {requestId, ...currentSession.modelRequests[requestId]}, runOptions.onEvent)
            if (requestStopped()) {abort(); return}
            await authorize()
            if (requestStopped()) {abort(); return}
            const settleUsage = async (message: AssistantMessage) => {
              // Once the provider terminal receipt arrived, timeouts cannot discard
              // it while its atomic usage checkpoint is being committed.
              settled = true; cleanup()
              if (performance.now() >= requestDeadline) {active.reason ??= 'failed';active.error ??= 'Model request deadline exceeded'}
              const request = currentSession.modelRequests![requestId!]!
              if (localPayloadRejected) {
                request.status = 'not_dispatched'; request.completedAt = Date.now(); request.error = message.errorMessage
                turns--; currentSession.usage.turns--
                await this.record(currentSession, 'model_request_not_dispatched', {requestId, ...request}, runOptions.onEvent)
                return
              }
              const reported = message.usage?.cost?.total
              const failedDelivery=['error','aborted'].includes(message.stopReason)
              request.delivery={status:failedDelivery?'failed':'completed',stopReason:message.stopReason,
                ...(message.errorMessage?{errorMessage:message.errorMessage}:{}),
                partialToolCallCount:failedDelivery?message.content.filter(part=>part.type==='toolCall').length:0,recordedAt:Date.now()}
              // SDK transport failures initialize an all-zero Usage object without
              // a provider billing receipt. Successful free responses are distinct.
              const emptyFailureUsage = ['error', 'aborted'].includes(message.stopReason) && reported === 0 &&
                ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => (message.usage as any)?.[key] === 0)
              request.completedAt = Date.now()
              if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && !emptyFailureUsage) {
                request.status = 'settled'; request.reportedCostUsd = reported; request.estimatedCostUsd = reported; request.costKind='sdk_estimate'
                cost += reported; currentSession.usage.costUsd += reported
                if (summarizing && cost >= this.limits.maxCostUsd) limit('Maximum model cost reached')
              } else {
                request.status = 'unknown'; request.error = emptyFailureUsage ? 'Provider failure has only synthetic zero usage, not a billing receipt' : 'Provider terminal receipt has no valid model usage cost'
                active.reason ??= 'failed'; active.error ??= message.errorMessage ?? 'Model accounting unavailable: provider terminal usage is unresolved'
              }
              const requireActual = this.options.requireProviderReportedUsage ?? (!this.options.streamFn && requestModel.provider==='openrouter')
              if (requestModel.provider==='openrouter') request.providerBilling ??= {source:'openrouter_stream',reportedCostUsd:null,status:'unknown'}
              if (requireActual && request.providerBilling?.status !== 'reported') {
                request.status='unknown'; request.error='Original provider billing is unknown; SDK static-price estimate is not a reported bill'
                active.reason ??= 'failed'; active.error ??= request.error
              }
              if (request.providerBilling?.reportedCostUsd !== null && request.providerBilling?.reportedCostUsd !== undefined) {
                const actualSpent = Object.entries(currentSession.modelRequests ?? {}).filter(([requestId])=>!originalRequestIds.has(requestId)).reduce((n,[,r])=>n+(r.providerBilling?.reportedCostUsd??0),0)
                if (actualSpent >= this.limits.maxCostUsd) limit('Maximum reported provider cost reached')
              }
              await this.record(currentSession, 'model_request_settled', {requestId, ...request}, runOptions.onEvent)
              if(!summarizing&&request.status==='settled'&&!active.reason&&['stop','toolUse'].includes(message.stopReason)){
                await this.options.onInferenceContext?.({sessionId:id,requestId:requestId!,messages:payloadReplaced?[]:structuredClone(context.messages)})
                for(const [position,message] of context.messages.entries())if(message.role==='toolResult'){
                  const definition=this.options.tools?.find(tool=>tool.name===message.toolName)
                  if(definition?.onDelivery)await definition.onDelivery({phase:'inference',content:payloadReplaced?[]:structuredClone(message.content),details:undefined,isError:message.isError,projection:JSON.stringify(message.content).includes('artifact_reference_only')?'artifact_reference':'full',inference:{requestId:requestId!,position,toolCallId:message.toolCallId}})
                }
              }
            }
            providerInvoked = true
            const input = await baseStream(requestModel, context, { ...options, ...this.options.streamOptions,
              apiKey: hostKey, signal: controller.signal, maxRetries:0,
              onPayload: async (payload, observedModel) => {
                try {
                  // Apply capacity admission before observers see the reservation,
                  // then recheck any observer replacement at Pi's final boundary.
                  const admit = (value: unknown) => {
                    try {return fitPiPayloadToContext(value, observedModel)}
                    catch (error) {if (error instanceof PiLocalContextOverflow && !this.options.streamFn) localPayloadRejected = true; throw error}
                  }
                  const initial = admit(payload)
                  const beforeObserver=structuredClone(initial?.payload??payload)
                  const observer = this.options.streamOptions?.onPayload ?? options?.onPayload
                  const replacement = await observer?.(initial?.payload ?? payload, observedModel)
                  const final = admit(replacement ?? initial?.payload ?? payload)
                  const finalPayload=final?.payload??replacement??initial?.payload??payload
                  if(JSON.stringify(beforeObserver)!==JSON.stringify(finalPayload))payloadReplaced=true
                  try {assertPayloadInstructions(beforeObserver,finalPayload,summarizing?[]:exactInstructionMessages(sdk.sessionManager))}
                  catch(error){if(!this.options.streamFn)localPayloadRejected=true;throw error}
                  if (final) await this.record(currentSession, 'model_request_capacity_admitted', {requestId, ...final.sizing}, runOptions.onEvent)
                  return final?.payload ?? replacement
                } catch (error) {
                  // Only the built-in adapter guarantees that this supported hook
                  // runs before HTTP dispatch. A custom stream can call it later.
                  if (!this.options.streamFn && error instanceof PiLocalPayloadAdmissionRejected) localPayloadRejected = true
                  throw error
                }
              },
              onProviderStreamEvent: async (data, observedModel) => {
                // Late transport callbacks have no authority after their original
                // request ends or ownership changes. Verified receipt recovery is
                // the separate path for later accounting evidence.
                if (settled || controller.signal.aborted || active.reason || this.active.get(id)!==active || this.leaseOwners.get(id)!==owner) return
                if (requestModel.provider==='openrouter') {
                  const request=currentSession.modelRequests![requestId!]!
                  const billing=observeProviderBilling(request.providerBilling,data)
                  if (billing && JSON.stringify(billing)!==JSON.stringify(request.providerBilling)) {
                    request.providerBilling=billing
                    await this.record(currentSession,'provider_billing_observed',{requestId,billing},runOptions.onEvent)
                  }
                }
                await (this.options.streamOptions?.onProviderStreamEvent ?? options?.onProviderStreamEvent)?.(data,observedModel)
              } })
            let nextYield = performance.now() + streamSliceMs
            for await (const event of input) {
              if (performance.now() >= nextYield) {
                await new Promise<void>(resolve => setTimeout(resolve, 0))
                nextYield = performance.now() + streamSliceMs
              }
              if (settled) break
              if (event.type === 'done' || event.type === 'error') {
                await settleUsage(event.type === 'done' ? event.message : event.error)
              }
              if(event.type==='error'){
                // An errored terminal may contain a partially assembled tool call.
                // Persist only the failed-delivery summary and never hand that call
                // to Pi's tool dispatcher.
                output.push({...event,error:{...event.error,content:[]}})
              }else output.push(event)
              if (event.type === 'done' || event.type === 'error') break
            }
            if (!settled) {
              const message = await input.result()
              if (!settled) {
                await settleUsage(message)
                const delivered=message.stopReason==='error'||message.stopReason==='aborted'?{...message,content:[]}:message
                output.end(delivered)
              }
            }
            else output.end()
          } catch (error) { if (active.persistenceError || settled) settled = false; await fail(error, controller.signal.aborted) }
          finally { cleanup() }
        })()
        return output
      }
      const currentSession = session
      let effectiveSystemMessages:import('@earendil-works/pi-agent-core').AgentMessage[]=[]
      const captureSystems=(messages:import('@earendil-works/pi-agent-core').AgentMessage[])=>{
        const unique=new Map([...effectiveSystemMessages,...messages.filter(message=>message.role==='system')].map(message=>[instructionProjectionHash(message),message]))
        effectiveSystemMessages=[...unique.values()]
      }
      const preserveSystems=(messages:import('@earendil-works/pi-agent-core').AgentMessage[])=>restoreExactInstructions(messages,effectiveSystemMessages)
      let setupListener: (() => void) | undefined
      const interruptedSetup = new Promise<never>((_, reject) => {
        setupListener = () => reject(setupAbort.signal.reason ?? new Error('Pi setup interrupted'))
        setupAbort.signal.addEventListener('abort', setupListener, {once: true})
        if (setupAbort.signal.aborted) setupListener()
      })
      let sdk: AgentSession
      const compactionHooks: import('./sdk').HostCompactionHooks = {
        before: async (event, manager) => {
          // The supported Pi lifecycle owns triggering, omission of failed attempts,
          // retry and entry publication. One science hook selects the safe cut.
          summarizing = true
          try {
            if (active.reason) return {cancel:true}
            captureSystems(sdk.agent.state.messages)
            const projection = await compactContext({sessionId:id,manager,messages:manager.buildSessionProjection().messages,
              archive:currentSession.messages,session:currentSession,model,policy:this.options.contextPolicy,
              fixedContext:{systemMessages:effectiveSystemMessages},streamFn,signal:event.signal,preparation:event.preparation,force:event.reason==='overflow',nativePromptSizing:!this.options.streamFn && model.api==='openai-completions'})
            if (!projection) return {cancel:true}
            return {compaction:{...projection.result,details:{...projection.result.details as object,...projection.checkpoint}}}
          } catch (error) {
            // Pi logs extension exceptions and otherwise falls back to its default
            // summarizer. Return cancel explicitly so a rejected science cut can
            // never dispatch an unguarded second summarization policy.
            if (!errorText(error).includes('no safely compactable history')) {active.reason??='failed';active.error??=errorText(error)}
            return {cancel:true}
          } finally {summarizing=false}
        },
        after: async (event, manager) => {
          const checkpoint=event.compactionEntry.details as import('./types').PiContextCheckpoint
          if (checkpoint?.format!=='autofold.pi-context-compaction.v1') throw new Error('Pi compaction is missing scoped archive evidence')
          const science=restoreScientificContext({manager,messages:manager.buildSessionProjection().messages,session:currentSession,groups:this.options.contextPolicy?.retainLatestToolGroups})
          checkpoint.retainedAnchors=science.retainedAnchors;checkpoint.scientificSnapshots=science.snapshots
          checkpoint.estimatedTokensAfter=await estimateActiveContextInput(science.messages,exactInstructionMessages(manager),undefined,{systemMessages:effectiveSystemMessages},!this.options.streamFn&&model.api==='openai-completions'?{nativeModel:model}:undefined)
          if (checkpoint.estimatedTokensAfter>checkpoint.inputBudget) {active.reason='failed';active.error='Pi semantic summary exceeds context input budget';return}
          currentSession.contextCompactions=[...currentSession.contextCompactions??[],checkpoint]
          snapshotManager(currentSession,manager)
          await this.record(currentSession,'context_compacted',checkpoint,runOptions.onEvent)
        },
      }
      runStopped()
      try { sdk = await Promise.race([createHostSession(currentSession, model, models, this.options, tools, setupAbort.signal, compactionHooks), interruptedSetup]) }
      finally { if (setupListener) setupAbort.signal.removeEventListener('abort', setupListener) }
      sdkSession = sdk
      const agent = sdk.agent
      agent.streamFunction = streamFn
      agent.toolExecution = this.options.toolExecution??'sequential'
      agent.getApiKey = undefined
      sdk.subscribe(event=>{
        if(event.type==='compaction_end' && event.errorMessage && !active.reason) {active.reason='failed';active.error=event.errorMessage}
      })
      // Pi's ordinary threshold can be usage-backed (and therefore stale after
      // edits or growing tool receipts). Its public request preparation hook and
      // native overflow hook use this same safe-cut/summarization policy; the
      // default native summarizer is never a second competing policy.
      let lastScienceProjection:string|undefined
      const restoreScience=async(messages:import('@earendil-works/pi-agent-core').AgentMessage[])=>{
        const science=restoreScientificContext({manager:sdk.sessionManager,messages,session:currentSession,groups:this.options.contextPolicy?.retainLatestToolGroups})
        const signature=JSON.stringify({snapshots:science.snapshots,superseded:science.superseded})
        if((science.snapshots.some(snapshot=>snapshot.restored)||science.superseded.length)&&signature!==lastScienceProjection){
          await this.record(currentSession,'scientific_context_reprojected',{retainedAnchors:science.retainedAnchors,snapshots:science.snapshots,superseded:science.superseded,authority:'Pure model-facing projection of exact original current scientific call/result; no tool intent, execution or new evidence.'},runOptions.onEvent)
          lastScienceProjection=signature
        }
        return science.messages
      }
      const nativePrepare=agent.prepareRequest
      agent.prepareRequest=async(request,signal)=>{
        if(active.reason) throw new Error(active.error??'Run interrupted')
        if(this.options.contextPolicy?.retainedToolBytes!==undefined){
          const retention=projectRetainedToolArtifacts(sdk.sessionManager,currentSession,this.options.contextPolicy.retainedToolBytes,this.options.contextPolicy.retainLatestToolGroups)
          if(retention.count){
            snapshotManager(currentSession,sdk.sessionManager)
            await this.record(currentSession,'retained_tool_context_projected',retention,runOptions.onEvent)
            agent.state.messages=sdk.sessionManager.buildSessionProjection().messages
          }
        }
        const prepared=await nativePrepare?.(request,signal)
        let context=prepared?.context??request.context
        captureSystems(context.messages)
        context={...context,messages:preserveSystems(await restoreScience(context.messages))}
        summarizing=true
        let projection:Awaited<ReturnType<typeof compactContext>>
        try {projection=await compactContext({sessionId:id,manager:sdk.sessionManager,messages:context.messages,
          archive:currentSession.messages,session:currentSession,model,policy:this.options.contextPolicy,
          fixedContext:{systemMessages:effectiveSystemMessages},streamFn,signal,nativePromptSizing:!this.options.streamFn && model.api==='openai-completions'})} finally {summarizing=false}
        if(projection){
          if(active.reason||signal?.aborted) throw new Error(active.error??'Compaction cancelled')
          const {result,checkpoint}=projection
          const entryId=sdk.sessionManager.appendCompaction(result.summary,result.firstKeptEntryId,result.tokensBefore,{...result.details as object,...checkpoint},true,result.usage)
          const entry=sdk.sessionManager.getEntry(entryId)
          if(!entry||entry.type!=='compaction') throw new Error('Pi compaction entry publication failed')
          await compactionHooks.after({type:'session_compact',compactionEntry:entry,fromExtension:true,reason:'threshold',willRetry:false},sdk.sessionManager)
          context={...context,messages:preserveSystems(await restoreScience(sdk.sessionManager.buildSessionProjection().messages))}
          agent.state.messages=context.messages
        }
        return {...prepared,context}
      }
      // SDK compaction projection carries the summary, while user intent remains exact.
      const nativeTransform = agent.transformContext
      agent.transformContext = async (messages, signal) => {
        contextPreparationError = undefined
        try {
          let projected = await nativeTransform?.(messages, signal) ?? messages
          const anchors=exactInstructionMessages(sdk.sessionManager)
          captureSystems(projected)
          projected=restoreExactInstructions(preserveSystems(await restoreScience(projected)),anchors)
          if (!this.options.transformContext) return projected
          const transformed = await this.options.transformContext(structuredClone(projected), signal)
          assertExactInstructionOrder(transformed,anchors)
          if (JSON.stringify(projected.filter(m => m.role === 'system')) !== JSON.stringify(transformed.filter(m => m.role === 'system'))) throw new Error('Pi context transform removed or changed protected system/tool declarations')
          return transformed
        } catch (error) {contextPreparationError = error; return messages}
      }
      const nativeBefore=agent.beforeToolCall,nativeAfter=agent.afterToolCall
      agent.beforeToolCall = async (context,signal) => {
          if(endRequested)return {block:true,reason:'Host already yielded during this tool batch; no host effect admitted',terminate:true}
          if(cost>=this.limits.maxCostUsd)limit('Maximum model cost reached')
          if(active.reason)return {block:true,reason:active.error,terminate:true}
          const intercepted=await nativeBefore?.(context,signal)
          if(intercepted?.block)return {...intercepted,terminate:false}
          const definition=tools.find(tool=>tool.name===context.toolCall.name)
          if(!definition||!Value.Check(definition.parameters,context.args))throw new Error('Native tool interception produced invalid arguments for '+context.toolCall.name)
          await this.options.authorizeToolCall?.({sessionId:id,toolCallId:context.toolCall.id,toolName:context.toolCall.name,args:context.args},signal??setupAbort.signal)
          if(signal?.aborted||runStopped())return {block:true,reason:active.error??'Tool cancelled before invocation',terminate:true}
          if(endRequested)return {block:true,reason:'Host already yielded during this tool batch; no host effect admitted',terminate:true}
          // Reserve synchronously after all awaited interception/gates. Parallel
          // callbacks cannot both observe the final available tool allowance.
          if(calls>=this.limits.maxToolCalls){toolBudgetDenied=true;return {block:true,reason:'Maximum tool calls reached',terminate:true}}
          calls++;currentSession.usage.toolCalls++
          await this.record(currentSession,'tool_call_admitted',{toolCallId:context.toolCall.id,toolName:context.toolCall.name},runOptions.onEvent)
          if(signal?.aborted||runStopped())return {block:true,reason:active.error??'Tool cancelled before invocation',terminate:true}
          if(endRequested)return {block:true,reason:'Host already yielded during this tool batch; no host effect admitted',terminate:true}
          return intercepted
        }
      agent.afterToolCall = async (context,signal) => {
          const originalError=context.isError
          const normalized=await nativeAfter?.(context,signal)
          const finalError=normalized?.isError??originalError
          // Only an actual successful host invocation can request completion.
          // Model-visible content and extension normalization cannot invent it,
          // nor can a mixed batch erase a host's successful yield.
          const accepted=actualToolSuccess.has(context.toolCall.id)&&!originalError&&!finalError&&
            (hostEndCalls.has(context.toolCall.id)||Boolean(this.options.stopToolNames?.includes(context.toolCall.name)))
          if(accepted){endRequested=true;acceptedEndCalls.add(context.toolCall.id)}
          return {...normalized,terminate:accepted}
        }
      const hostFinish: NonNullable<Agent['finishTurn']> = async turn => {
          if(toolBudgetDenied)limit('Maximum tool calls reached')
          if (turn.toolResults.some(result => !result.isError && acceptedEndCalls.has(result.toolCallId))) {sdk.setAutoCompactionEnabled(false); return { action: 'end' }}
          if (cost >= this.limits.maxCostUsd) limit('Maximum model cost reached')
          // Pi owns length/overflow recovery and rejects truncated tool calls.
          // Only actual host grant exhaustion can stop its continuation here.
          if (!active.reason && turn.message.content.some(part => part.type === 'toolCall') && turns >= this.limits.maxTurns) limit('Maximum model turns reached')
          if (active.reason) return { action: 'end' }
        }
      const nativeFinish = agent.finishTurn
      agent.finishTurn = async (turn, signal) => {
        const decision = await hostFinish(turn)
        return (decision ?? await nativeFinish?.(turn, signal)) || undefined
      }
      active.agent = agent
      let nextStreamCheckpoint = 0
      let nextSubscriberYield = performance.now() + streamSliceMs
      agent.subscribe(async event => {
        if (event.type === 'message_update') {
          if (performance.now() >= nextSubscriberYield) {
            await new Promise<void>(resolve => setTimeout(resolve, 0))
            nextSubscriberYield = performance.now() + streamSliceMs
          }
          // Partial messages grow with every delta. Coalesce before cloning the
          // complete transcript or journal payload; boundaries below always save.
          const now = performance.now()
          if (now < nextStreamCheckpoint) return
          nextStreamCheckpoint = now + STREAM_CHECKPOINT_INTERVAL_MS
        } else if (event.type === 'message_start' && event.message.role === 'assistant') {
          nextStreamCheckpoint = 0
        }
        if (event.type === 'message_end') {
          currentSession.messages.push(structuredClone(event.message) as PiSession['messages'][number])
          const entry=sdk.sessionManager.getBranch().findLast(entry=>entry.type==='message'&&messageHash(entry.message)===messageHash(event.message))
          if(entry?.type==='message'&&event.message.role==='user'&&!hostPromptTagged){
            const text=typeof event.message.content==='string'?event.message.content:event.message.content.filter(part=>part.type==='text').map(part=>part.text).join('')
            if(text===prompt){tagHostPrompt(sdk.sessionManager,entry,runOptions);hostPromptTagged=true}
          }
          if(entry?.type==='message'&&event.message.role==='toolResult'){
            const threshold=Math.min(65_536,contextBudget(model,this.options.contextPolicy).inputBudget*2)
            const totalBytes=Buffer.byteLength(JSON.stringify(event.message))
            let content=event.message.content,projection:'full'|'artifact_reference'='full'
            const toolName=event.message.toolName
            const retainedBudget=this.options.contextPolicy?.retainedToolBytes
            const currentSnapshot=!event.message.isError&&this.options.contextPolicy?.retainLatestToolGroups?.some(names=>names.includes(toolName))
            // Keep current scientific snapshots full. Ordinary bulk results use
            // exact archive cards even in the newest complete call/result group.
            const oversized=retainedBudget===undefined?totalBytes>threshold:
              !currentSnapshot&&toolProjectionBytes(event.message)>Math.min(threshold,retainedBudget)
            if(oversized){
              content=artifactCard(toolArtifact(sdk.sessionManager,currentSession,event.message),totalBytes)
              sdk.sessionManager.appendContextEdit(entry.id,{content});projection='artifact_reference'
            }
            // Publication can clear a prepared exposure. Confirmation waits for
            // actual ordinary inference, never hidden details or summarization.
            const definition=this.options.tools?.find(tool=>tool.name===toolName)
            await definition?.onDelivery?.({phase:'published',content:structuredClone(content),details:undefined,isError:event.message.isError,projection})
          }
        }
        snapshotManager(currentSession, sdk.sessionManager)
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          if (cost >= this.limits.maxCostUsd) limit('Maximum model cost reached')
        }
        if (event.type === 'tool_execution_start') {
          currentSession.pendingTools[event.toolCallId] = { name: event.toolName, args: structuredClone(event.args), startedAt: Date.now() }
        }
        if (event.type === 'tool_execution_end' && !uncertainTools.has(event.toolCallId)) delete currentSession.pendingTools[event.toolCallId]
        await this.record(currentSession, event.type, event, runOptions.onEvent)
      })
      session.status = 'running'; delete session.error
      await this.record(session, 'run_started', { limits: this.limits }, runOptions.onEvent)
      if (!runStopped()) {
        await sdk.prompt(prompt, {expandPromptTemplates: false})
      }
      await sdk.waitForIdle()
      runStopped()
      if (active.persistenceError) throw active.persistenceError
      // Native overflow recovery can omit a failed attempt from the active projection.
      // Its exact archived outcome remains authoritative when no retry could run.
      const last = session.messages.findLast(message => message.role === 'assistant') as AssistantMessage | undefined
      snapshotManager(session, sdk.sessionManager)

      const incomplete = !last || !['stop', 'toolUse'].includes(last.stopReason)
      session.status = active.reason ?? (last?.stopReason === 'aborted' ? 'cancelled' : incomplete ? 'failed' : 'completed')
      session.error = active.error ?? (session.status === 'failed' || session.status === 'cancelled' ? last?.errorMessage ?? agent.state.errorMessage ?? (last?.stopReason === 'length' ? 'Provider response remained truncated after native Pi recovery' : 'Model turn did not complete') : undefined)
      await this.record(session, 'run_finished', { status: session.status, error: session.error }, runOptions.onEvent)
      return { sessionId: id, status: session.status, session: structuredClone(session), error: session.error }
    } catch (error) {
      if (!session || active.persistenceError) throw active.persistenceError ?? error
      session.status = active.reason ?? 'failed'; session.error = active.error ?? errorText(error)
      await this.record(session, 'run_finished', { status: session.status, error: session.error }, runOptions.onEvent)
      return { sessionId: id, status: session.status, session: structuredClone(session), error: session.error }
    } finally {
      sdkSession?.dispose()
      if (timer) clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      if (renewal) await renewal
      runOptions.signal?.removeEventListener('abort', cancel)
      this.active.delete(id)
      if (lease) await this.release(id, lease)
    }
  }
}

/** The science engine depends on this host runtime contract, independent of its Pi adapter. */
export function createAgentRuntime(options: import('./types').AgentRuntimeOptions): import('./types').AgentRuntime { return new PiRuntime(options) }
