import {Database} from 'bun:sqlite'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {checkedPath} from '../execution/paths'

type Row = Record<string, any>
type Issue = {code: string; recordId?: string}
const id = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,255}$/.test(v) ? v : null
const digest = (v: unknown): string | null => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v) ? v : null
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const choice = (v: unknown, allowed: string[]): string | null => typeof v === 'string' && allowed.includes(v) ? v : null
const time = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null
const leaseIdentifier = (v: unknown) => id(v) !== null || typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const statuses = ['draft','active','paused','completed','archived','proposed','queued','running','evaluating','succeeded','failed','cancelled','retry_wait','idle','limit_reached','candidate','rejected','superseded','reviewed','contested','deprecated']
const kinds = ['autoresearch','knowledge_refresh','knowledge_review','campaign_loop','capability_refinement','skill_shadow_replay','run_trial']
const grants = ['maximumTrajectories','maximumDiscoveryTrajectories','reservedReplayTrajectories','discoveryBatchSize'] as const
const intents = ['optimize','calibrate','negative_control','shadow_replay']
const count = (rows: Row[], field: string, allowed: string[]) => Object.fromEntries([...allowed, 'unknown'].map(key => [key, rows.filter(row => (choice(row[field], allowed) ?? 'unknown') === key).length]))
async function stat(file: string) {return fs.stat(file).catch(error => {if(error.code === 'ENOENT') return undefined; throw error})}

/** Read-only logical state; SQLite may coordinate readers through WAL shared memory.
 * Each DB has its own short coherent transaction. No initialization or checkpoint.
 */
async function withSnapshot<T>(workspace: string, relative: string, issues: Issue[], read: (db: Database) => T) {
  const source = await checkedPath(workspace, relative)
  const initial = await stat(source)
  const sizes = {databaseBytes: initial?.size ?? null, walBytes: (await stat(await checkedPath(workspace, relative + '-wal')))?.size ?? 0}
  if (!initial?.isFile()) {issues.push({code: 'database_missing'}); return {sizes, window: null, data: null}}
  let db: Database | undefined
  const startedAt = new Date().toISOString()
  try {
    db = new Database(source, {readonly: true, create: false})
    db.exec('PRAGMA query_only=ON; BEGIN')
    const data = read(db)
    db.exec('ROLLBACK')
    return {sizes, window: {startedAt, completedAt: new Date().toISOString()}, data}
  } catch {issues.push({code: 'database_read_failed'}); return {sizes, window: {startedAt, completedAt: new Date().toISOString()}, data: null}}
  finally {db?.close()}
}

// SQL projects only named scalar fields. Whole records, journal events, checkpoint
// blobs and message bodies never enter the monitor process.
function records(db: Database, collection: string, fields: string[]): Row[] {
  const projections = fields.map((field, i) => `json_extract(value, '$.${field}') AS f${i}`)
  const rows = db.query(`SELECT id, ${projections.join(',')} FROM records WHERE collection=? AND json_valid(value)`).all(collection) as Row[]
  return rows.map(row => Object.fromEntries([['id', id(row.id)], ...fields.map((field, i) => [field, row[`f${i}`]])]))
}
function payload(db: Database, jobId: string, issues: Issue[]): Row {
  const row = db.query("SELECT json_extract(value,'$.payload') AS inline, CASE WHEN json_valid(refs) THEN json_extract(refs,'$.payload') END AS hash FROM records WHERE collection='jobs' AND id=?").get(jobId) as Row
  let raw = row?.inline
  if(row?.hash) {
    if(typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) {issues.push({code: 'payload_blob_invalid_ref', recordId: jobId}); return {}}
    const blob = db.query('SELECT CASE WHEN length(CAST(value AS BLOB)) <= 2097152 THEN value END AS value FROM blobs WHERE hash=?').get(row.hash) as Row | null
    if(!blob) {issues.push({code: 'payload_blob_missing', recordId: jobId}); return {}}
    if(typeof blob.value !== 'string') {issues.push({code: 'payload_blob_too_large', recordId: jobId}); return {}}
    if(createHash('sha256').update(blob.value).digest('hex') !== row.hash) {issues.push({code: 'payload_blob_corrupt', recordId: jobId}); return {}}
    raw = blob.value
  }
  try {const v = JSON.parse(raw ?? '{}');
    // Direct campaign moves can finish without creating a model-supervisor session.
    // Check only intent key metadata; checkpoint bodies and journals stay unread.
    const intent = v.kind === 'campaign_loop' ? db.query(`SELECT
      EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(refs) THEN refs ELSE '{}' END) WHERE key GLOB 'checkpoint:campaign:step:*:supervisor-intent') OR
      EXISTS(SELECT 1 FROM json_each(value, '$.checkpoints') WHERE key GLOB 'campaign:step:*:supervisor-intent') AS expected
      FROM records WHERE collection='jobs' AND id=?`).get(jobId) as Row : undefined
    return {sessionRequired: v.kind !== 'campaign_loop' || Boolean(intent?.expected), kind: choice(v.kind, kinds), campaignId: id(v.campaignId), experimentId: id(v.experimentId), sessionId: id(v.sessionId), parentJobId: id(v.parentJobId), grants: Object.fromEntries(grants.map(key => [key, number(v[key])]))}}
  catch {issues.push({code: 'payload_invalid_json', recordId: jobId}); return {}}
}

export interface MonitorOptions {workspace: string; project: string; campaign?: string; now?: number; idleThresholdMs?: number}
export async function longRunSnapshot(options: MonitorOptions) {
  if(!path.isAbsolute(options.workspace) || !/^[A-Za-z0-9_-]+$/.test(options.project) || (options.campaign && !/^cmp_[A-Za-z0-9_-]+$/.test(options.campaign))) throw new Error('Monitor requires absolute workspace and valid project/campaign identities')
  const now = options.now ?? Date.now(), idleThresholdMs = options.idleThresholdMs ?? 15 * 60_000
  if(!Number.isFinite(now) || !Number.isFinite(idleThresholdMs) || idleThresholdMs < 60_000) throw new Error('Invalid monitor timing')
  const issues: Issue[] = []
  const research = await withSnapshot(options.workspace, `.autofold/research/${options.project}.sqlite`, issues, db => {
    const campaigns = records(db, 'campaigns', ['status']).filter(row => !options.campaign || row.id === options.campaign)
    const experiments = records(db, 'experiments', ['campaignId','status','contractHash','contract.evaluator.direction','contract.budget.gpuHours','piScientistSessionId']).filter(row => !options.campaign || row.campaignId === options.campaign)
    const experimentIds = new Set(experiments.map(row => row.id))
    const trials = records(db, 'trials', ['experimentId','status','intent']).filter(row => experimentIds.has(row.experimentId))
    const trialIds = new Set(trials.map(row => row.id))
    const evaluations = records(db, 'evaluations', ['trialId','contractHash','valid','score','evaluatedAt']).filter(row => trialIds.has(row.trialId))
    const runs = records(db, 'runs', ['trialId','status','startedAt','completedAt']).filter(row => trialIds.has(row.trialId))
    const jobs = records(db, 'jobs', ['status','attempts','updatedAt','leaseExpiresAt','leaseId']).filter(row => row.id).map(row => ({...row, ...payload(db, row.id, issues)})).filter(row => !options.campaign || row.campaignId === options.campaign || experimentIds.has(row.experimentId))
    const scoped = (collection: string, fields: string[]) => records(db, collection, ['campaignId', ...fields]).filter(row => !options.campaign || row.campaignId === options.campaign)
    return {campaigns, experiments, trials, evaluations, runs, jobs,
      cycles: scoped('knowledgeCycles', ['trigger']), claims: scoped('claims', ['status']), requests: scoped('researchRequests', ['experimentId']),
      skills: scoped('skillVersions', ['status','version','replay.passed','replay.campaignIds']),
      library: records(db,'skillLibrary',['status','sourceVersionId','promotedFromCampaignIds']).filter(row => !options.campaign || (typeof row.promotedFromCampaignIds === 'string' && JSON.parse(row.promotedFromCampaignIds).includes(options.campaign)))}
  })
  const r = research.data
  const selectedSessions = new Set<string>((r?.jobs ?? []).map(row => id(row.sessionId)).filter((v): v is string => v !== null))
  const expectedSessions = new Set<string>((r?.jobs ?? []).filter(row => row.sessionRequired !== false).map(row => id(row.sessionId)).filter((v): v is string => v !== null))
  for(const row of r?.experiments ?? []) {const session = id(row.piScientistSessionId); if(session) {selectedSessions.add(session); expectedSessions.add(session)}}
  const experimentIds = new Set(r?.experiments.map(row => row.id) ?? [])
  const pi = await withSnapshot(options.workspace, `.autofold/pi/${options.project}/sessions.sqlite`, issues, db => {
    // No pi_journal query: pilot journals can contain hundreds of MB of deltas.
    const rows = db.query(`SELECT s.id, json_extract(state,'$.status') AS status,
      json_extract(state,'$.metadata.projectId') AS projectId, json_extract(state,'$.metadata.campaignId') AS campaignId,
      json_extract(state,'$.metadata.experimentId') AS experimentId, json_extract(state,'$.metadata.jobId') AS jobId,
      json_extract(state,'$.updatedAt') AS updatedAt, json_extract(state,'$.usage.costUsd') AS costUsd,
      json_extract(state,'$.usage.turns') AS turns, json_extract(state,'$.usage.toolCalls') AS toolCalls,
      length(CAST(json_extract(state,'$.messages') AS BLOB)) AS transcriptBytes,
      CASE WHEN json_type(state,'$.contextCompactions')='array' THEN json_array_length(state,'$.contextCompactions') ELSE 0 END AS compactions,
      l.expires_at AS leaseExpiresAt FROM pi_sessions s LEFT JOIN pi_leases l ON l.session_id=s.id WHERE json_valid(state)`).all() as Row[]
    const jobIds = new Set(r?.jobs.map(row => row.id) ?? [])
    return rows.filter(row => selectedSessions.has(row.id) || (row.projectId === options.project && (!options.campaign || row.campaignId === options.campaign || experimentIds.has(row.experimentId) || jobIds.has(row.jobId)))).map(row => {
      const updatedAt = number(row.updatedAt), expires = number(row.leaseExpiresAt)
      return {id: id(row.id), status: choice(row.status,statuses), recordedCompletedResponseCostUsd: number(row.costUsd), turns: number(row.turns), toolCalls: number(row.toolCalls), transcriptSerializedBytes: number(row.transcriptBytes), compactionCount: number(row.compactions), updatedAt,
        lease: expires === null ? 'missing' : expires <= now ? 'expired' : 'active', leaseExpiresAt: expires,
        idleFlag: row.status === 'running' && updatedAt !== null && now - updatedAt >= idleThresholdMs}
    })
  })
  const experiments = []
  for(const exp of r?.experiments ?? []) {
    const direction = choice(exp['contract.evaluator.direction'], ['minimize','maximize'])
    const contractHash = digest(exp.contractHash)
    const expTrials = (r?.trials ?? []).filter(row => row.experimentId === exp.id)
    const ids = new Set(expTrials.map(row => row.id))
    const evals = (r?.evaluations ?? []).filter(row => ids.has(row.trialId))
    let best: number | null = null
    const curves = Object.fromEntries(intents.map(intent => [intent, evals.filter(row => row.valid === 1 && contractHash !== null && row.contractHash === contractHash && finite(row.score) !== null && time(row.evaluatedAt) !== null && expTrials.find(trial => trial.id === row.trialId)?.intent === intent).sort((a,b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || String(a.id).localeCompare(String(b.id))).map(row => {
      const score = finite(row.score)!
      if(intent === 'optimize' && direction) best = best === null ? score : direction === 'minimize' ? Math.min(best,score) : Math.max(best,score)
      return {evaluationId: row.id, trialId: id(row.trialId), evaluatedAt: time(row.evaluatedAt), score, bestOptimizeScore: intent === 'optimize' ? best : null}
    })]))
    const expRuns = (r?.runs ?? []).filter(row => ids.has(row.trialId))
    const measured = expRuns.map(row => {const start=time(row.startedAt), end=time(row.completedAt); return start && end && Date.parse(end)>=Date.parse(start) ? (Date.parse(end)-Date.parse(start))/1000 : null})
    const ceiling = number(exp['contract.budget.gpuHours'])
    let scientist: Row | null = null
    try {
      const file = await checkedPath(options.workspace, `.autofold/autoresearch/${exp.id}/scientist.json`)
      const s = await stat(file)
      if(s && s.size <= 2_097_152) {
        const v = JSON.parse(await fs.readFile(file,'utf8'))
        if(v.format === 'autofold.scientist-state.v2' && v.experimentId === exp.id && v.contractHash === exp.contractHash) scientist = {completedEvaluations:number(v.completedEvaluations), stopped:typeof v.stopped==='boolean'?v.stopped:null,researchRequested:typeof v.researchRequested==='boolean'?v.researchRequested:null,pendingOperationKind:choice(v.operation?.kind,['stop','research']) ?? (v.pending ? 'evaluation' : null)}
        else issues.push({code:'scientist_binding_mismatch',recordId:exp.id})
      } else if(s) issues.push({code:'scientist_state_too_large',recordId:exp.id})
    } catch {issues.push({code:'scientist_read_failed',recordId:exp.id})}
    experiments.push({id:exp.id,campaignId:id(exp.campaignId),status:choice(exp.status,statuses),contractHash,direction,
      trialCounts:count(expTrials,'intent',intents),trialStatuses:count(expTrials,'status',statuses),reportedValidScoreCurves:curves,
      excludedEvaluations:evals.length-Object.values(curves).reduce((sum,curve)=>sum+curve.length,0),
      runs:expRuns.map((row,i)=>({id:row.id,trialId:id(row.trialId),status:choice(row.status,statuses),startedAt:time(row.startedAt),completedAt:time(row.completedAt),measuredWallSeconds:measured[i]})),
      measuredCompletedRunWallSeconds:measured.some(v=>v!==null)?measured.reduce<number>((sum,v)=>sum+(v??0),0):null,unmeasuredRunCount:measured.filter(v=>v===null).length,
      reservedGpuContractCeilingHoursPerRun:ceiling,reservedGpuContractCeilingHoursForRecordedRuns:ceiling===null?null:ceiling*expRuns.length,scientist})
  }
  const sessions = pi.data
  const knownSessionIds = new Set(sessions?.map(row => row.id) ?? [])
  const missingSessionIds = sessions === null ? [] : [...expectedSessions].filter(sessionId => !knownSessionIds.has(sessionId))
  for(const sessionId of missingSessionIds) issues.push({code:'missing_session',recordId:sessionId})
  const completeCosts = sessions !== null && missingSessionIds.length === 0 && sessions.every(row => row.recordedCompletedResponseCostUsd !== null)
  return {format:'autofold.long-run-snapshot.v1',projectId:options.project,campaignId:options.campaign??null,capturedAt:new Date(now).toISOString(),
    provenance:{evidence:'Reported database facts; receipts have not been independently verified.',costs:'Recorded completed-response costs, counted once per persistent session; not invoices.',snapshots:'Independent read-only SQLite transaction windows; not a globally atomic snapshot. SQLite WAL shared-memory reader coordination may occur.',idle:'Session inactivity only; does not establish GPU progress.',journal:'Not loaded; result/checkpoint blobs and transcript bodies are excluded.',researchRequests:'Raw record count only; canonical unresolved question status is unavailable.'},
    databases:{research:{...research.sizes,window:research.window,available:r!==null},pi:{...pi.sizes,window:pi.window,available:sessions!==null}},
    campaigns:r?.campaigns.map(row=>({id:row.id,status:choice(row.status,statuses)}))??null,experiments:r?experiments:null,
    jobs:r?.jobs.map(row=>({id:row.id,kind:row.kind??null,status:choice(row.status,statuses),experimentId:id(row.experimentId),campaignId:id(row.campaignId),sessionId:id(row.sessionId),grants:row.grants??null,attempts:number(row.attempts),updatedAt:time(row.updatedAt),
      runningLeaseFlag:row.status==='running' ? !leaseIdentifier(row.leaseId)||!time(row.leaseExpiresAt)?'missing':Date.parse(row.leaseExpiresAt)<=now?'expired':null:null}))??null,
    knowledge:r?{cycleCount:r.cycles.length,cycleTriggers:count(r.cycles,'trigger',['manual','run_completed','scheduled','literature_review']),claimStatuses:count(r.claims,'status',['proposed','reviewed','contested','deprecated']),totalResearchRequestCount:r.requests.length,unresolvedResearchRequestCount:null}:null,
    skills:r?{versions:r.skills.map(row=>({id:row.id,version:number(row.version),status:choice(row.status,statuses),replayPassed:row['replay.passed']===1?true:row['replay.passed']===0?false:null,replayCampaignIds:typeof row['replay.campaignIds']==='string'?JSON.parse(row['replay.campaignIds']).map(id).filter(Boolean):null})),library:r.library.map(row=>({id:row.id,sourceVersionId:id(row.sourceVersionId),status:choice(row.status,statuses)}))}:null,
    sessions,recordedCompletedResponseCostUsd:completeCosts?sessions!.reduce((sum,row)=>sum+row.recordedCompletedResponseCostUsd!,0):null,idleThresholdMs,issues}
}
