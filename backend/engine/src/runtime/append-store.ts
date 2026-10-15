import {Database} from 'bun:sqlite'
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import type {PiSession,PiSessionStore,PiRuntimeEvent} from './types'
import {readSessionSnapshot,assertOriginalRequestAttribution} from './store'
import {immutableSessionValue,sessionRecordJson} from './immutable'
/** Append-only native entries and exact compatibility messages; small CAS head.
 * Legacy snapshot stores require their original writer; no implicit conversion is permitted. */
export class AppendOnlySessionStore implements PiSessionStore {
  private readonly db: Database
  private readonly fragmentMetadata: boolean
  private readonly prefixes = new Map<string, unknown[]>()
  constructor(path: string) {
    // Reject legacy before creating a schema or changing the existing file.
    if (path!==':memory:' && existsSync(path)) {
      const read=new Database(path,{readonly:true})
      try {
        const table=read.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_sessions'").get()
        if (table && read.query("SELECT 1 FROM pi_sessions WHERE json_extract(state,'$.storageFormat') IS NULL LIMIT 1").get()) throw new Error('Legacy Pi snapshots require the original store; no implicit migration is permitted')
      } finally {read.close()}
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_journal (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id, sequence));
      CREATE TABLE IF NOT EXISTS pi_leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_records (session_id TEXT NOT NULL, kind TEXT NOT NULL, ordinal INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(session_id, kind, ordinal));
      CREATE TABLE IF NOT EXISTS pi_record_metadata (session_id TEXT NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,role TEXT,fragment_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_id,kind,ordinal));
      CREATE TABLE IF NOT EXISTS pi_record_fragments (session_id TEXT NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,fragment INTEGER NOT NULL,bytes BLOB NOT NULL,digest TEXT NOT NULL,
        PRIMARY KEY(session_id,kind,ordinal,fragment));
      CREATE TABLE IF NOT EXISTS pi_upstream_requests (upstream_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,UNIQUE(session_id,request_id));
      CREATE TABLE IF NOT EXISTS pi_provider_receipts (receipt_id TEXT PRIMARY KEY, upstream_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL, request_id TEXT NOT NULL, UNIQUE(session_id,request_id));`)
    this.fragmentMetadata = (this.db.query('PRAGMA table_info(pi_record_metadata)').all() as {name:string}[]).some(column=>column.name==='fragment_count')
    const legacy = this.db.query("SELECT 1 FROM pi_sessions WHERE json_extract(state,'$.storageFormat') IS NULL LIMIT 1").get()
    if (legacy) {this.db.close();throw new Error('Legacy Pi snapshots require the original store; no implicit migration is permitted')}
  }
  private bindReceipts(session: PiSession) {
    for (const [id,request] of Object.entries(session.modelRequests??{})) {
      const raw=request.providerBilling?.upstreamRequestId,verified=request.usageEvidence?.upstreamRequestId
      if(raw&&verified&&raw!==verified)throw new Error('Conflicting original provider request identity')
      const upstream=raw??verified
      if(upstream) {
        const prior=this.db.query('SELECT upstream_id,session_id,request_id FROM pi_upstream_requests WHERE upstream_id=? OR (session_id=? AND request_id=?)').all(upstream,session.id,id) as {upstream_id:string;session_id:string;request_id:string}[]
        if(prior.some(row=>row.upstream_id!==upstream||row.session_id!==session.id||row.request_id!==id))throw new Error('Upstream request is already bound to another original provider request')
        this.db.query('INSERT OR IGNORE INTO pi_upstream_requests VALUES (?,?,?)').run(upstream,session.id,id)
      }
      if(!request.usageEvidence)continue
      const evidence = request.usageEvidence
      const conflict = this.db.query(`SELECT session_id, request_id FROM pi_provider_receipts
        WHERE receipt_id=? OR upstream_id=? OR (session_id=? AND request_id=?)`).all(evidence.receiptId,evidence.upstreamRequestId,session.id,id) as {session_id:string;request_id:string}[]
      if (conflict.some(row => row.session_id !== session.id || row.request_id !== id)) throw new Error('Provider receipt is already bound to another session or request')
      const prior = this.db.query('SELECT receipt_id, upstream_id FROM pi_provider_receipts WHERE session_id=? AND request_id=?').get(session.id,id) as {receipt_id:string;upstream_id:string}|null
      if (prior && (prior.receipt_id !== evidence.receiptId || prior.upstream_id !== evidence.upstreamRequestId)) throw new Error('Conflicting provider receipt binding')
      this.db.query('INSERT OR IGNORE INTO pi_provider_receipts VALUES (?,?,?,?)').run(evidence.receiptId,evidence.upstreamRequestId,session.id,id)
    }
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
  private appendRecords(id:string, kind:string, values:unknown[]) {
    const key = id + ':' + kind
    const count = (this.db.query('SELECT COUNT(*) AS n FROM pi_records WHERE session_id=? AND kind=?').get(id,kind) as {n:number}).n
    if (values.length < count) throw new Error('Original Pi archive cannot be truncated')
    const cached = this.prefixes.get(key) ?? []
    for (let index=0; index<values.length; index++) {
      if (index < count && cached[index] === values[index]) continue
      const serialized = sessionRecordJson(values[index])
      if (index < count) {
        const prior = this.db.query('SELECT value FROM pi_records WHERE session_id=? AND kind=? AND ordinal=?').get(id,kind,index) as {value:string}
        if (prior.value !== serialized) throw new Error('Original Pi archive entry cannot be changed')
      } else {
        this.db.query('INSERT INTO pi_records VALUES (?,?,?,?)').run(id,kind,index,serialized)
        const raw=Buffer.from(serialized),digest='sha256:'+createHash('sha256').update(raw).digest('hex')
        const fragmentCount=this.fragmentMetadata && kind==='message' && raw.length>65_536 ? Math.ceil(raw.length/65_536) : 0
        if(this.fragmentMetadata){
          for(let fragment=0;fragment<fragmentCount;fragment++){
            const chunk=raw.subarray(fragment*65_536,(fragment+1)*65_536)
            this.db.query('INSERT INTO pi_record_fragments VALUES (?,?,?,?,?,?)').run(id,kind,index,fragment,chunk,'sha256:'+createHash('sha256').update(chunk).digest('hex'))
          }
          this.db.query('INSERT INTO pi_record_metadata(session_id,kind,ordinal,digest,bytes,role,fragment_count) VALUES (?,?,?,?,?,?,?)').run(id,kind,index,digest,raw.length,(values[index] as {role?:string})?.role??null,fragmentCount)
        }else this.db.query('INSERT INTO pi_record_metadata(session_id,kind,ordinal,digest,bytes) VALUES (?,?,?,?,?)').run(id,kind,index,digest,raw.length)
      }
    }
  }
  async save(session: PiSession, event?: PiRuntimeEvent, leaseOwner?: string) {
    const messages = session.messages.map(immutableSessionValue)
    const entries = session.sdk?.entries.map(immutableSessionValue) ?? []
    const head = {...session, storageFormat:'autofold.pi-store.v2', archiveCounts:{message:messages.length,entry:entries.length}, messages:[], sdk:session.sdk ? {...session.sdk,entries:[]} : undefined}
    this.db.transaction(() => {
      if (leaseOwner && !this.db.query('SELECT 1 FROM pi_leases WHERE session_id = ? AND owner = ? AND expires_at > ?').get(session.id, leaseOwner, Date.now())) throw new Error('Pi session lease was lost')
      const previous=this.db.query('SELECT state FROM pi_sessions WHERE id=?').get(session.id) as {state:string}|null
      if(previous){const old=JSON.parse(previous.state);if(JSON.stringify(old.modelSelection)!==JSON.stringify(session.modelSelection)||old.createdAt!==session.createdAt||old.sdk && JSON.stringify(old.sdk.header)!==JSON.stringify(session.sdk?.header))throw new Error('Original Pi session identity/header cannot change')}
      assertOriginalRequestAttribution(session,previous?JSON.parse(previous.state):undefined)
      this.bindReceipts(session)
      // CAS and append both roll back on failure; a stale writer cannot append.
      const updated = this.db.query("INSERT INTO pi_sessions(id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state WHERE json_extract(pi_sessions.state, '$.sequence') = ?").run(session.id, JSON.stringify(head), session.sequence - (event ? 1 : 0))
      if (updated.changes !== 1) throw new Error('Concurrent Pi session update rejected')
      this.appendRecords(session.id,'message',messages)
      this.appendRecords(session.id,'entry',entries)
      if (event) this.db.query('INSERT INTO pi_journal(session_id, sequence, event) VALUES (?, ?, ?)').run(session.id, event.sequence, JSON.stringify(event))
    })()
    // Cache only committed immutable prefixes, never a rolled-back candidate.
    this.prefixes.set(session.id+':message',messages)
    this.prefixes.set(session.id+':entry',entries)
  }
  async events(id: string): Promise<PiRuntimeEvent[]> {
    const rows = this.db.query('SELECT event FROM pi_journal WHERE session_id = ? ORDER BY sequence').all(id) as { event: string }[]
    return rows.map(row => JSON.parse(row.event))
  }
  close() { this.prefixes.clear(); this.db.close() }
}
