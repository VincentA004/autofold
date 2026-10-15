import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {immutableSessionValue} from './immutable'
import type { PiModelRequest, PiRuntimeEvent, PiSession, PiSessionStore } from './types'

/** Pure decoder over an already-open connection; never opens, initializes,
 * migrates, leases or reconciles a scientific session. */
export function readSessionSnapshot(db:Database,id:string):PiSession|undefined {
  // A v2 head and both immutable archives must come from one WAL snapshot.
  // Deferred transactions take no writer lock; Bun uses a savepoint when the
  // caller already owns a transaction, preserving the caller's original snapshot.
  return db.transaction(() => {
  const row=db.query('SELECT state FROM pi_sessions WHERE id=?').get(id) as {state:string}|null
  if(!row)return undefined
  const state=JSON.parse(row.state)
  if(state.storageFormat && state.storageFormat!=='autofold.pi-store.v2')throw new Error('Unsupported original Pi storage format')
  if(state.storageFormat==='autofold.pi-store.v2') {
    delete state.storageFormat
    const records=(kind:string)=>{
      const rows=db.query('SELECT ordinal,value FROM pi_records WHERE session_id=? AND kind=? ORDER BY ordinal').all(id,kind) as {ordinal:number;value:string}[]
      if(rows.some((row,index)=>row.ordinal!==index)||typeof state.archiveCounts?.[kind]!=='number'||rows.length!==state.archiveCounts[kind])throw new Error('Original Pi archive is incomplete')
      return rows.map(row=>immutableSessionValue(JSON.parse(row.value)))
    }
    state.messages=records('message');if(state.sdk)state.sdk.entries=records('entry');delete state.archiveCounts
  }
  return state
  }).deferred()
}

/** Bind raw provider identities before continuation, including stores without
 * the fresh append-store's dedicated identity table. No schema/read migration. */
function originalProviderUpstream(request:PiModelRequest):string|undefined {
  const raw=request.providerBilling?.upstreamRequestId,verified=request.usageEvidence?.upstreamRequestId
  if(raw&&verified&&raw!==verified)throw new Error('Conflicting original provider request identity')
  return raw??verified
}
function providerBindings(session:PiSession,prior?:PiSession):Array<{requestId:string;upstream:string}> {
  assertOriginalRequestAttribution(session,prior)
  const bindings:Array<{requestId:string;upstream:string}>=[],seen=new Set<string>()
  for(const [requestId,request] of Object.entries(session.modelRequests??{})) {
    const upstream=originalProviderUpstream(request)
    if(!upstream)continue
    if(seen.has(upstream))throw new Error('Upstream request is already bound to another session or original provider request')
    seen.add(upstream);bindings.push({requestId,upstream})
  }
  for(const [id,request] of Object.entries(prior?.modelRequests??{})) {
    const upstream=originalProviderUpstream(request)
    if(upstream&&(!session.modelRequests?.[id]||originalProviderUpstream(session.modelRequests[id]!)!==upstream))
      throw new Error('Original provider request binding cannot change or be removed')
  }
  return bindings
}
/** Resume cannot move an original request between grants or relabel legacy work. */
export function assertOriginalRequestAttribution(session:PiSession,prior?:PiSession) {
  for(const [id,request]of Object.entries(prior?.modelRequests??{})){
    const next=session.modelRequests?.[id]
    if(JSON.stringify(request.owningBinding)!==JSON.stringify(next?.owningBinding))throw new Error('Original model request owning binding cannot change')
  }
}

export class MemorySessionStore implements PiSessionStore {
  private readonly sessions = new Map<string, PiSession>()
  private readonly journal = new Map<string, PiRuntimeEvent[]>()
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>()
  async acquireLease(id: string, owner: string, ttlMs: number) {
    const existing = this.leases.get(id)
    if (existing && existing.expiresAt > Date.now()) return false
    this.leases.set(id, { owner, expiresAt: Date.now() + ttlMs }); return true
  }
  async renewLease(id: string, owner: string, ttlMs: number) {
    const existing = this.leases.get(id)
    if (!existing || existing.owner !== owner || existing.expiresAt <= Date.now()) return false
    existing.expiresAt = Date.now() + ttlMs; return true
  }
  async releaseLease(id: string, owner: string) { if (this.leases.get(id)?.owner === owner) this.leases.delete(id) }
  async get(id: string) { const value = this.sessions.get(id); return value && structuredClone(value) }
  async save(session: PiSession, event?: PiRuntimeEvent, leaseOwner?: string) {
    if (leaseOwner && (this.leases.get(session.id)?.owner !== leaseOwner || this.leases.get(session.id)!.expiresAt <= Date.now())) throw new Error('Pi session lease was lost')
    const current = this.sessions.get(session.id)
    if (current && current.sequence !== session.sequence - (event ? 1 : 0)) throw new Error('Concurrent Pi session update rejected')
    const bindings=providerBindings(session,current)
    for(const other of this.sessions.values())for(const [requestId,request] of Object.entries(other.modelRequests??{})) {
      const upstream=originalProviderUpstream(request)
      if(upstream&&bindings.some(binding=>binding.upstream===upstream&&(other.id!==session.id||binding.requestId!==requestId)))
        throw new Error('Upstream request is already bound to another session or original provider request')
    }
    const evidence = Object.values(session.modelRequests ?? {}).flatMap(request => request.usageEvidence ? [request.usageEvidence] : [])
    for (const other of this.sessions.values()) if (other.id !== session.id && Object.values(other.modelRequests ?? {}).some(request =>
      request.usageEvidence && evidence.some(receipt => receipt.receiptId === request.usageEvidence!.receiptId || receipt.upstreamRequestId === request.usageEvidence!.upstreamRequestId)))
      throw new Error('Provider receipt is already bound to another session')
    this.sessions.set(session.id, structuredClone(session))
    if (event) this.journal.set(session.id, [...(this.journal.get(session.id) ?? []), structuredClone(event)])
  }
  async events(id: string) { return structuredClone(this.journal.get(id) ?? []) }
}

/** One database per project, conventionally .autofold/pi/sessions.sqlite. */
export class SqliteSessionStore implements PiSessionStore {
  private readonly db: Database
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_journal (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id, sequence));
      CREATE TABLE IF NOT EXISTS pi_leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`)
  }
  async get(id: string): Promise<PiSession | undefined> {
    return readSessionSnapshot(this.db,id)
  }
  async acquireLease(id: string, owner: string, ttlMs: number) {
    return this.db.transaction(() => {
      this.db.query('DELETE FROM pi_leases WHERE session_id = ? AND expires_at <= ?').run(id, Date.now())
      return this.db.query('INSERT OR IGNORE INTO pi_leases(session_id, owner, expires_at) VALUES (?, ?, ?)').run(id, owner, Date.now() + ttlMs).changes === 1
    })()
  }
  async renewLease(id: string, owner: string, ttlMs: number) {
    return this.db.query('UPDATE pi_leases SET expires_at = ? WHERE session_id = ? AND owner = ? AND expires_at > ?').run(Date.now() + ttlMs, id, owner, Date.now()).changes === 1
  }
  async releaseLease(id: string, owner: string) { this.db.query('DELETE FROM pi_leases WHERE session_id = ? AND owner = ?').run(id, owner) }
  async save(session: PiSession, event?: PiRuntimeEvent, leaseOwner?: string) {
    this.db.transaction(() => {
      const append=this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_records'").get()
      if(append)throw new Error('Append-only sessions require their append-only writer; original archive preserved')
      if (leaseOwner && !this.db.query('SELECT 1 FROM pi_leases WHERE session_id = ? AND owner = ? AND expires_at > ?').get(session.id, leaseOwner, Date.now())) throw new Error('Pi session lease was lost')
      const prior=this.db.query('SELECT state FROM pi_sessions WHERE id=?').get(session.id) as {state:string}|null
      for(const {requestId,upstream} of providerBindings(session,prior?JSON.parse(prior.state):undefined)) {
        if(this.db.query(`SELECT 1 FROM pi_sessions, json_each(json_extract(pi_sessions.state,'$.modelRequests')) AS request
          WHERE (pi_sessions.id != ? OR request.key != ?) AND (json_extract(request.value,'$.providerBilling.upstreamRequestId') = ?
          OR json_extract(request.value,'$.usageEvidence.upstreamRequestId') = ?) LIMIT 1`).get(session.id,requestId,upstream,upstream))
          throw new Error('Upstream request is already bound to another session or original provider request')
      }
      for (const request of Object.values(session.modelRequests ?? {})) if (request.usageEvidence) {
        const receipt = request.usageEvidence
        if (this.db.query(`SELECT 1 FROM pi_sessions, json_each(json_extract(pi_sessions.state, '$.modelRequests')) AS request
          WHERE pi_sessions.id != ? AND (json_extract(request.value, '$.usageEvidence.receiptId') = ?
          OR json_extract(request.value, '$.usageEvidence.upstreamRequestId') = ?) LIMIT 1`).get(session.id, receipt.receiptId, receipt.upstreamRequestId))
          throw new Error('Provider receipt is already bound to another session')
      }
      const updated = this.db.query("INSERT INTO pi_sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state WHERE json_extract(pi_sessions.state, '$.sequence') = ?").run(session.id, JSON.stringify(session), session.sequence - (event ? 1 : 0))
      if (updated.changes !== 1) throw new Error('Concurrent Pi session update rejected')
      if (event) this.db.query('INSERT INTO pi_journal(session_id, sequence, event) VALUES (?, ?, ?)').run(session.id, event.sequence, JSON.stringify(event))
    })()
  }
  async events(id: string): Promise<PiRuntimeEvent[]> {
    const rows = this.db.query('SELECT event FROM pi_journal WHERE session_id = ? ORDER BY sequence').all(id) as { event: string }[]
    return rows.map(row => JSON.parse(row.event))
  }
  close() { this.db.close() }
}
