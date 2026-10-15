import {Database} from 'bun:sqlite'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import type {ResearchStore} from '@autofold/science-core/store'
import {operationHash} from '@autofold/science-core/operations'
import type {ResearchDomain} from '@autofold/science-core/domain'
import type {PiSession} from '../runtime'
import {assertSessionAccountingComplete} from '../runtime/types'
import {readSessionSnapshot} from '../runtime/store'
import {checkedPath} from '../execution/paths'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface AccountingHost {workspace: string; projectId: string; sessionDirectory: string; store?:ResearchStore}
export interface JobAccountingBaseline {jobId: string; sessions: Record<string, {costUsd: number; existed: boolean; originalRequestIds?: string[]}>}
export interface JobAccounting {jobId: string; modelCostUsd: number; consumedTrajectories?: number; sessions: Record<string, {baselineCostUsd: number; costUsd: number}>; providerAccounting?: ProviderAccounting}
/** Reported provider receipts are a separate axis from the compatibility SDK estimate. */
export interface ProviderAccounting {
  status: 'reported' | 'unknown'
  reportedCostUsd: number | null
  knownReportedCostUsd: number
  originalRequestIds: string[]
  upstreamRequestIds: string[]
  unknownRequestIds: string[]
}
const emptyProviderAccounting=():ProviderAccounting=>({status:'reported',reportedCostUsd:0,knownReportedCostUsd:0,originalRequestIds:[],upstreamRequestIds:[],unknownRequestIds:[]})
export function aggregateProviderAccounting(values: Array<{identity:string;accounting?:ProviderAccounting}>):ProviderAccounting {
  const total=emptyProviderAccounting(), originals=new Set<string>(), upstream=new Set<string>(), unknown=new Set<string>()
  for(const {identity,accounting} of values){
    if(!accounting){unknown.add(identity+':provider_receipts_unknown');continue}
    money(accounting.knownReportedCostUsd,'known reported provider sum')
    if(accounting.status==='reported' && (accounting.reportedCostUsd===null || Math.abs(money(accounting.reportedCostUsd,'reported provider sum')-accounting.knownReportedCostUsd)>1e-12)) throw new Error('Model accounting unavailable: provider aggregate status conflicts with receipts')
    total.knownReportedCostUsd+=accounting.knownReportedCostUsd
    for(const id of accounting.originalRequestIds){if(originals.has(id)) throw new Error('Model accounting unavailable: duplicate original provider request attribution');originals.add(id)}
    for(const id of accounting.upstreamRequestIds){if(upstream.has(id)) throw new Error('Model accounting unavailable: duplicate upstream provider receipt attribution');upstream.add(id)}
    for(const id of accounting.unknownRequestIds) unknown.add(id)
    if(accounting.status==='unknown') unknown.add(identity+':provider_receipts_unknown')
  }
  total.originalRequestIds=[...originals].sort();total.upstreamRequestIds=[...upstream].sort();total.unknownRequestIds=[...unknown].sort()
  if(!Number.isFinite(total.knownReportedCostUsd)) throw new Error('Model accounting unavailable: reported provider sum invalid')
  total.status=unknown.size?'unknown':'reported';total.reportedCostUsd=unknown.size?null:total.knownReportedCostUsd
  return total
}
/** Exact host request IDs at admission prevent charging reused-session prior receipts twice. */
export function sessionProviderAccounting(sessionId:string,session:PiSession|undefined,originalRequestIds?:string[]):ProviderAccounting {
  if(!session) return emptyProviderAccounting()
  if(!originalRequestIds) return {...emptyProviderAccounting(),status:'unknown',reportedCostUsd:null,unknownRequestIds:[sessionId+':original_provider_baseline_unknown']}
  const baseline=new Set(originalRequestIds), result=emptyProviderAccounting(), upstream=new Set<string>()
  for(const id of originalRequestIds){const prior=session.modelRequests?.[id];if(!prior)result.unknownRequestIds.push(sessionId+':missing_original_request:'+id);if(prior?.providerBilling?.upstreamRequestId)upstream.add(prior.providerBilling.upstreamRequestId)}
  for(const [id,request] of Object.entries(session.modelRequests??{})){
    if(baseline.has(id)||request.status==='not_dispatched') continue
    const original=sessionId+':'+id;result.originalRequestIds.push(original)
    const receipt=request.providerBilling
    if(request.status!=='settled'||receipt?.status!=='reported'||!receipt.upstreamRequestId||!receipt.evidenceHash||receipt.reportedCostUsd===null){result.unknownRequestIds.push(original);continue}
    if(upstream.has(receipt.upstreamRequestId)) throw new Error('Model accounting unavailable: duplicate upstream provider receipt attribution')
    upstream.add(receipt.upstreamRequestId);result.upstreamRequestIds.push(receipt.upstreamRequestId);result.knownReportedCostUsd+=money(receipt.reportedCostUsd,'reported original provider receipt')
  }
  // Legacy messages with no request register never establish provider billing.
  if(!Object.keys(session.modelRequests??{}).length && (session.usage.turns>0 || session.usage.costUsd>0)) result.unknownRequestIds.push(sessionId+':legacy_provider_receipts_unknown')
  result.status=result.unknownRequestIds.length?'unknown':'reported';result.reportedCostUsd=result.status==='reported'?result.knownReportedCostUsd:null
  return result
}
const money = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Model accounting unavailable: invalid ${label}`)
  return value
}
/** Audit reads must never initialize a database or create a supervisor/child session. */
export async function readAccountingSession(host: AccountingHost, sessionId: string): Promise<PiSession | undefined> {
  const file = path.join(host.sessionDirectory, 'sessions.sqlite')
  try {await fs.access(file)} catch (error: any) {if (error.code === 'ENOENT') return undefined; throw error}
  const db = new Database(file, {readonly: true})
  try {
    return readSessionSnapshot(db, sessionId)
  } finally {db.close()}
}
function sessionIds(host: AccountingHost, job: ResearchDomain.Job): string[] {
  if (job.payload.kind === 'capability_refinement') return ['ses_refinement_' + hash(`${host.projectId}:refinement:${job.id}`)]
  if (job.payload.kind === 'skill_shadow_replay') {
    const key = hash(`${host.projectId}:shadow:${job.id}`), repetitions = job.payload.repetitions
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('Model accounting unavailable: invalid shadow repetition count')
    return Array.from({length: repetitions}, (_, i) => ['parent', 'candidate'].map(arm => 'ses_shadow_' + hash(`${key}:${i + 1}:${arm}`))).flat()
  }
  return typeof job.payload.sessionId === 'string' ? [job.payload.sessionId] : []
}
async function json(host: AccountingHost, relative: string) {
  try {return JSON.parse(await fs.readFile(await checkedPath(host.workspace, relative), 'utf8'))}
  catch (error: any) {if (error.code === 'ENOENT') return undefined; throw error}
}
/** Recover the original grant baseline, including all paired replay arm sessions. */
async function nativeBaselines(host: AccountingHost, job: ResearchDomain.Job): Promise<Record<string,{costUsd:number;originalRequestIds?:string[]}>|undefined> {
  if (job.payload.kind === 'autoresearch') {
    const value = job.checkpoints['pi:job:start']?.data
    return value ? {[String(job.payload.sessionId)]: {costUsd:money(value.costUsd,'scientist baseline'),...(Array.isArray(value.originalRequestIds)?{originalRequestIds:value.originalRequestIds as string[]}:{})}} : undefined
  }
  if (job.payload.kind === 'knowledge_review') {
    const canonical=host.store?(await host.store.read(host.projectId)).operations['op_'+hash(host.projectId+':'+job.id)]:undefined
    const value = canonical?(canonical.state.checkpoints as any)?.budget:job.checkpoints['knowledge-review:budget']?.data
    return value ? {[String(job.payload.sessionId)]: {costUsd:money(value.costUsd??value.cost,'review baseline'),...(Array.isArray(value.originalRequestIds)?{originalRequestIds:value.originalRequestIds as string[]}:{})}} : undefined
  }
  if (job.payload.kind === 'knowledge_refresh') {
    const key = hash(`${host.projectId}:${job.payload.campaignId}:${job.id}`)
    const canonical=host.store?(await host.store.read(host.projectId)).operations['op_'+key]:undefined
    const value = canonical?canonical.state as any:await json(host, `.autofold/literature/${key}/review.json`)
    if (!value) return undefined
    if (value.operationId !== job.id || value.childSessionId !== job.payload.sessionId) throw new Error('Model accounting unavailable: literature binding changed')
    const baseline=value.hostSession?.costUsd??value.baselineCostUsd
    return baseline === undefined ? {} : {[value.childSessionId]: {costUsd:money(baseline,'literature baseline'),...(Array.isArray(value.hostSession?.originalRequestIds)?{originalRequestIds:value.hostSession.originalRequestIds}:{})}}
  }
  if (job.payload.kind === 'capability_refinement' || job.payload.kind === 'skill_shadow_replay') {
    const key = hash(`${host.projectId}:${job.payload.kind === 'capability_refinement' ? 'refinement' : 'shadow'}:${job.id}`)
    const canonical=host.store?(await host.store.read(host.projectId)).operations['op_'+key]:undefined
    const value = canonical?canonical.state as any:await json(host, `.autofold/skills/operations/${key}/state.json`)
    if (!value) return undefined
    if (value.input?.jobId !== job.id || value.input?.campaignId !== job.payload.campaignId || !value.baselines) throw new Error('Model accounting unavailable: skill binding changed')
    return Object.fromEntries(Object.entries(value.baselines).map(([id, entry]: [string, any]) => [id,{costUsd:money(entry.costUsd,'skill baseline'),...(Array.isArray(entry.originalRequestIds)?{originalRequestIds:entry.originalRequestIds}:{})}]))
  }
  return undefined
}
function checkedBaseline(job: ResearchDomain.Job, raw: any): JobAccountingBaseline {
  if (raw?.jobId !== job.id || !raw.sessions || typeof raw.sessions !== 'object') throw new Error('Model accounting unavailable: job baseline binding changed')
  for (const value of Object.values(raw.sessions) as any[]) {money(value.costUsd, 'job baseline'); if (typeof value.existed !== 'boolean') throw new Error('Model accounting unavailable: invalid session existence baseline'); if(value.originalRequestIds!==undefined && (!Array.isArray(value.originalRequestIds)||value.originalRequestIds.some((id:unknown)=>typeof id!=='string')||new Set(value.originalRequestIds).size!==value.originalRequestIds.length)) throw new Error('Model accounting unavailable: invalid original provider request baseline')}
  return raw
}
/** Called under the job lease before dispatch. Recovery never rebases already consumed usage. */
export async function captureJobAccountingBaseline(host: AccountingHost, job: ResearchDomain.Job): Promise<JobAccountingBaseline> {
  if (job.projectId !== host.projectId) throw new Error('Model accounting unavailable: job belongs to another project')
  const saved = job.checkpoints['pi:accounting:start']?.data
  if (saved) return checkedBaseline(job, saved)
  const native = await nativeBaselines(host, job), ids = sessionIds(host, job), sessions: JobAccountingBaseline['sessions'] = {}
  for (const id of ids) {
    const session = await readAccountingSession(host, id)
    if (session) assertSessionAccountingComplete(session)
    if (native && native[id] !== undefined) sessions[id]={...native[id]!,existed:true}
    else if ((job.attempts > 1 || job.startedAt && job.startedAt !== job.updatedAt) && session) throw new Error('Model accounting unavailable: resumed session has no original job baseline')
    else sessions[id] = {costUsd: session ? money(session.usage.costUsd, 'session usage') : 0, existed: !!session, originalRequestIds:Object.keys(session?.modelRequests??{})}
  }
  return {jobId: job.id, sessions}
}
/** No-admission proves this job did not spend. A reused transcript can retain prior
 * spend only when exact original settled intervals cover its cumulative usage. */
export async function assertNoAdmissionUsage(host: AccountingHost, job: ResearchDomain.Job): Promise<void> {
  const state = host.store ? await host.store.read(host.projectId) : undefined
  for (const id of sessionIds(host, job)) {
    const session = await readAccountingSession(host, id)
    if (!session) continue
    assertSessionAccountingComplete(session)
    if (session.status === 'running') throw new Error('Model accounting unavailable: no-admission shared session is still running')
    const selection = job.payload.modelSelection as {provider?: string; modelId?: string} | undefined
    if (session.metadata.projectId !== host.projectId || session.modelSelection.provider !== selection?.provider || session.modelSelection.modelId !== selection?.modelId)
      throw new Error('Model accounting unavailable: no-admission shared session binding changed')
    const total = money(session.usage.costUsd, 'session usage')
    if (total === 0) continue
    const intervals: Array<{start: number; end: number}> = []
    for (const previous of Object.values(state?.jobs ?? {})) {
      if (previous.id === job.id || previous.projectId !== host.projectId || previous.attempts === 0 || !['succeeded', 'failed', 'cancelled'].includes(previous.status)) continue
      const lease = Object.keys(previous.checkpoints).filter(phase => phase.startsWith('pi:accounting:lease:')).at(-1)?.slice('pi:accounting:lease:'.length)
      const receipt = (lease ? previous.checkpoints[`pi:accounting:settlement:${lease}`]?.data : undefined) as unknown as JobAccounting | undefined
      const entry = receipt?.sessions?.[id]
      if (!entry || receipt?.jobId !== previous.id) continue
      const start = money(entry.baselineCostUsd, 'prior session baseline'), delta = money(entry.costUsd, 'prior attributed usage')
      if (money(receipt.modelCostUsd, 'prior job settlement') + 1e-12 < delta) throw new Error('Model accounting unavailable: prior session interval exceeds settled job usage')
      intervals.push({start, end: start + delta})
    }
    let covered = 0
    for (const interval of intervals.sort((a, b) => a.start - b.start)) {
      if (interval.start > covered + 1e-12 || interval.end > total + 1e-12) throw new Error('Model accounting unavailable: no-admission receipt conflicts with unattributed original transcript usage')
      covered = Math.max(covered, interval.end)
    }
    if (Math.abs(covered - total) > 1e-12) throw new Error('Model accounting unavailable: no-admission receipt conflicts with unattributed original transcript usage')
  }
}
export async function readJobAccounting(host: AccountingHost, job: ResearchDomain.Job, options: {baseline?: JobAccountingBaseline; ignoreSettlement?: boolean} = {}): Promise<JobAccounting> {
  if (job.projectId !== host.projectId) throw new Error('Model accounting unavailable: job belongs to another project')
  // Only an original canonical no-admission receipt can prove zero without a transcript baseline.
  if(job.status==='cancelled'&&job.attempts===0&&host.store){
    const record=(await host.store.read(host.projectId)).operations['op_job_'+job.id.slice(4)]
    const receipt=record?.state.result as Record<string,unknown>|undefined
    if(record?.projectId===host.projectId&&record.jobId===job.id&&record.kind==='native_job'&&record.identity.jobId===job.id&&record.identity.payloadHash===operationHash(job.payload)&&record.accounting==='settled'&&record.settlement==='settled'&&record.effect==='none'&&receipt?.reason==='cancelled_before_admission'&&receipt.modelCostUsd===0&&receipt.consumedTrajectories===0){
      await assertNoAdmissionUsage(host, job)
      return{jobId:job.id,modelCostUsd:0,consumedTrajectories:0,sessions:{}}
    }
  }
  const lastLease = Object.keys(job.checkpoints).filter(phase => phase.startsWith('pi:accounting:lease:')).at(-1)?.slice('pi:accounting:lease:'.length)
  const settled = !options.ignoreSettlement && lastLease && job.checkpoints[`pi:accounting:settlement:${lastLease}`]?.data as unknown as JobAccounting | undefined
  if (settled) {
    if (settled.jobId !== job.id) throw new Error('Model accounting unavailable: settlement belongs to another child')
    money(settled.modelCostUsd, 'settled cost'); return settled
  }
  const saved = options.baseline ?? job.checkpoints['pi:accounting:start']?.data
  const baseline = saved ? checkedBaseline(job, saved) : undefined, native = baseline ? undefined : await nativeBaselines(host, job)
  if (!baseline && native === undefined) {
    // An explicit scoped cost receipt is evidence, but zero cannot hide a transcript with unknown attribution.
    if (job.result?.modelCostUsd !== undefined) {
      const modelCostUsd = money(job.result.modelCostUsd, 'child result')
      for (const id of sessionIds(host, job)) {
        const session = await readAccountingSession(host, id)
        if (session) assertSessionAccountingComplete(session)
        if (modelCostUsd === 0 && session && money(session.usage.costUsd, 'session usage') > 0) throw new Error('Model accounting unavailable: zero child result has no original usage baseline')
      }
      return {jobId: job.id, modelCostUsd, sessions: {}}
    }
    throw new Error('Model accounting unavailable: child has no durable usage baseline or cost result')
  }
  const entries = baseline?.sessions ?? Object.fromEntries(Object.entries(native!).map(([id,entry])=>[id,{...entry,existed:true}]))
  const expected = sessionIds(host, job)
  if (Object.keys(entries).some(id => !expected.includes(id))) throw new Error('Model accounting unavailable: baseline includes an unrelated session')
  for (const id of expected.filter(id => !entries[id])) {
    const session = await readAccountingSession(host, id)
    if (session) throw new Error('Model accounting unavailable: child session has no original usage baseline')
  }
  const sessions: JobAccounting['sessions'] = {}; let total = 0
  const providers:Array<{identity:string;accounting?:ProviderAccounting}>=[]
  for (const [id, entry] of Object.entries(entries)) {
    const session = await readAccountingSession(host, id)
    if (!session) {
      if (entry.existed) throw new Error('Model accounting unavailable: persisted child session missing')
      sessions[id] = {baselineCostUsd: entry.costUsd, costUsd: 0};providers.push({identity:id,accounting:emptyProviderAccounting()});continue
    }
    const selection = job.payload.modelSelection as {provider?: string; modelId?: string} | undefined
    if (session.status === 'running') throw new Error('Model accounting unavailable: child session is still running')
    assertSessionAccountingComplete(session)
    if (session.metadata.projectId !== host.projectId || session.modelSelection.provider !== selection?.provider || session.modelSelection.modelId !== selection?.modelId)
      throw new Error('Model accounting unavailable: persisted child session binding changed')
    if (job.completedAt && !options.ignoreSettlement) {
      const db = new Database(path.join(host.sessionDirectory, 'sessions.sqlite'), {readonly: true})
      try {
        const later = db.query("SELECT 1 FROM pi_journal WHERE session_id = ? AND json_extract(event, '$.type') = 'run_started' AND json_extract(event, '$.timestamp') > ? LIMIT 1").get(id, Date.parse(job.completedAt))
        if (later) throw new Error('Model accounting unavailable: session reused after child termination without settlement')
      } finally {db.close()}
    }
    const current = money(session.usage.costUsd, 'session usage'), delta = current - entry.costUsd
    if (delta < 0) throw new Error('Model accounting unavailable: persisted child usage reset')
    total += delta; sessions[id] = {baselineCostUsd: entry.costUsd, costUsd: delta}
    providers.push({identity:id,accounting:sessionProviderAccounting(id,session,'originalRequestIds' in entry?entry.originalRequestIds as string[]|undefined:undefined)})
  }
  if (!Number.isFinite(total)) throw new Error('Model accounting unavailable: summed usage invalid')
  // A handler may include another explicitly accounted host cost; never discard a larger receipt.
  if (job.result?.modelCostUsd !== undefined) total = Math.max(total, money(job.result.modelCostUsd, 'child result'))
  return {jobId: job.id, modelCostUsd: total, sessions,providerAccounting:aggregateProviderAccounting(providers)}
}


/** Aggregate the original owner tree without comparing actual bills with SDK estimates.
 * Legacy settled receipts remain unchanged; an absent reported axis propagates unknown. */
export async function readTreeProviderAccounting(host:AccountingHost,job:ResearchDomain.Job,ancestry:readonly string[]=[]):Promise<ProviderAccounting>{
  if(ancestry.includes(job.id)) throw new Error('Model accounting unavailable: cyclic provider ownership tree')
  let own:ProviderAccounting|undefined
  if(job.payload.kind==='campaign_loop'){
    const baseline=job.checkpoints['campaign:provider:start']?.data as {jobId?:string;sessionId?:string;existed?:boolean;originalRequestIds?:string[]}|undefined
    const id=String(job.payload.sessionId),session=await readAccountingSession(host,id)
    if(baseline?.jobId===job.id && baseline.sessionId===id && Array.isArray(baseline.originalRequestIds)){
      if(session){
        const selection=job.payload.modelSelection as {provider?:string;modelId?:string}|undefined
        if(session.metadata.projectId!==host.projectId || session.modelSelection.provider!==selection?.provider || session.modelSelection.modelId!==selection?.modelId) throw new Error('Model accounting unavailable: campaign provider session binding changed')
        own=sessionProviderAccounting(id,session,baseline.originalRequestIds)
      }else if(!baseline.existed)own=emptyProviderAccounting()
    }
  }else{
    const receipt=await readJobAccounting(host,job)
    const provedNoAdmission=job.status==='cancelled'&&job.attempts===0&&receipt.modelCostUsd===0&&receipt.consumedTrajectories===0
    own=provedNoAdmission?emptyProviderAccounting():receipt.providerAccounting
  }
  const values:Array<{identity:string;accounting?:ProviderAccounting}>=[{identity:job.id,accounting:own}]
  const state=host.store?await host.store.read(host.projectId):undefined
  const children=Object.values(state?.jobs??{}).filter(child=>child.projectId===host.projectId&&child.payload.parentJobId===job.id)
  for(const child of children) values.push({identity:child.id,accounting:await readTreeProviderAccounting(host,child,[...ancestry,job.id])})
  return aggregateProviderAccounting(values)
}
