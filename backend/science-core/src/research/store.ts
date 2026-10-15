import { OperationDomain,assertOperationHistory,operationHash } from "./operations"
import { ScientistReview } from "./scientist-review"
import { ExperimentBranches } from "./experiment-branches"
import z from "zod"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Lock } from "../util/lock"
import { ResearchDomain } from "./domain"

export const ResearchState = z.object({
  version: z.literal(1),
  scientistLanes: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  operations:z.record(z.string(),OperationDomain.Record).default({}),
  operationEvents:z.record(z.string(),OperationDomain.Event).default({}),
  operationOutbox:z.record(z.string(),OperationDomain.Outbox).default({}),
  scientistReviews: z.record(z.string(), ScientistReview.Record).default({}),
  experimentBranches: z.record(z.string(), ExperimentBranches.Record).default({}),
  branchCursors: z.record(z.string(), z.string()).default({}),
  branchDrafts: z.record(z.string(), z.string()).default({}),
  campaigns: z.record(z.string(), ResearchDomain.Campaign),
  experiments: z.record(z.string(), ResearchDomain.Experiment),
  trials: z.record(z.string(), ResearchDomain.Trial),
  evaluations: z.record(z.string(), ResearchDomain.Evaluation),
  runs: z.record(z.string(), ResearchDomain.Run).default({}),
  knowledge: z.record(z.string(), ResearchDomain.KnowledgeConcept).default({}),
  literature: z.record(z.string(), ResearchDomain.LiteratureRecord).default({}),
  claims: z.record(z.string(), ResearchDomain.KnowledgeClaim).default({}),
  alignments: z.record(z.string(), ResearchDomain.KnowledgeAlignment).default({}),
  knowledgeCycles: z.record(z.string(), ResearchDomain.KnowledgeCycle).default({}),
  campaignCharters: z.record(z.string(), ResearchDomain.CampaignCharter).default({}),
  hypotheses: z.record(z.string(), ResearchDomain.ResearchHypothesis).default({}),
  searchObservations: z.record(z.string(), ResearchDomain.SearchObservation).default({}),
  researchRequests: z.record(z.string(), ResearchDomain.ResearchRequestRecord).default({}),
  jobs: z.record(z.string(), ResearchDomain.Job).default({}),
  skillVersions: z.record(z.string(), ResearchDomain.SkillVersion).default({}),
  skillLibrary: z.record(z.string(), ResearchDomain.SkillLibraryEntry).default({}),
}).strict()
export type ResearchState = z.infer<typeof ResearchState>

export function emptyResearchState(): ResearchState {
  return {
    version: 1,
    scientistLanes: {},
    operations:{},
    operationEvents:{},
    operationOutbox:{},
    scientistReviews: {},
    experimentBranches: {},
    branchCursors: {},
    branchDrafts: {},
    campaigns: {},
    experiments: {},
    trials: {},
    evaluations: {},
    runs: {},
    knowledge: {},
    literature: {},
    claims: {},
    alignments: {},
    knowledgeCycles: {},
    campaignCharters: {},
    hypotheses: {},
    searchObservations: {},
    researchRequests: {},
    jobs: {},
    skillVersions: {},
    skillLibrary: {},
  }
}

export type RecordSelection = Partial<Record<Exclude<keyof ResearchState, 'version'>, readonly string[] | 'all'>>
export interface RecordScope { records: RecordSelection; jobAncestors?: string; operationNextEvent?: string }
function selected(scope: RecordScope, collection: string, id: string) {
  const ids = scope.records[collection as keyof RecordSelection]
  return ids === 'all' || Array.isArray(ids) && ids.includes(id)
}
function assertScopedWrites(before: ResearchState, after: ResearchState, scope: RecordScope) {
  if (after.version !== before.version) throw new Error('Scoped transaction cannot change the schema')
  for (const collection of Object.keys(after) as Array<keyof ResearchState>) {
    if (collection === 'version') continue
    for (const id of new Set([...Object.keys(before[collection]), ...Object.keys(after[collection])])) {
      if (!selected(scope, collection, id) && JSON.stringify(before[collection][id]) !== JSON.stringify(after[collection][id])) {
        throw new Error(`Scoped transaction cannot change ${collection}/${id}`)
      }
    }
  }
}
export interface ResearchStore {
  read(projectId: string): Promise<ResearchState>
  mutate<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>): Promise<T>
  readWithRevision?(projectId: string, priorRevision?: string): Promise<{revision?: string; state?: ResearchState}>
  readRecords?(projectId: string, scope: RecordScope): Promise<ResearchState>
  mutateRecords?<T>(projectId: string, scope: RecordScope, fn: (draft: ResearchState) => T | Promise<T>): Promise<T>
}

/** Authoritative research records use SQLite transactions. JSON is a legacy import/export,
 * never a second writable authority. Job payloads/checkpoints/results are immutable blobs,
 * so a lease heartbeat updates only a small record rather than rewriting transcript history.
 */
export class StorageResearchStore implements ResearchStore {
  constructor(private readonly options: {
    directory: string
    legacyDirectory?: string
    /** Explicit offline migration only; the former server must be stopped first. */
    allowLegacyImport?: boolean
  }) {
    if (!options.directory || !path.isAbsolute(options.directory)) {
      throw new Error("Research store requires an explicit absolute directory")
    }
    if (options.legacyDirectory && !path.isAbsolute(options.legacyDirectory)) {
      throw new Error("Legacy research import requires an explicit absolute directory")
    }
  }

  private location(projectId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid research project ID")
    return path.join(this.options.directory, `${projectId}.sqlite`)
  }

  private async open(projectId: string): Promise<Database> {
    const file = this.location(projectId)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const db = new Database(file, { create: true })
    db.exec("PRAGMA busy_timeout=50; PRAGMA synchronous=FULL;")
    try {
      await retryBusy(() => db.exec("PRAGMA journal_mode=WAL"))
      await retryBusy(() => db.exec("BEGIN IMMEDIATE"))
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL,
            value TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(collection,id));`)
        const initialized = db.query("SELECT value FROM metadata WHERE key='schema'").get() as { value: string } | null
        if (initialized && initialized.value !== "1") throw new Error("Unsupported research database version")
        if (!initialized) {
          const legacy = this.options.legacyDirectory ? path.join(this.options.legacyDirectory, `${projectId}.json`) : undefined
          const bytes = legacy ? await fs.readFile(legacy, "utf8").catch(error => {
            if (error.code === "ENOENT") return undefined
            throw error
          }) : undefined
          if (bytes !== undefined && !this.options.allowLegacyImport) {
            throw new Error(`Research state requires offline SQLite migration: stop the old server, then run script/migrate-research-store.ts --offline ${projectId}. Legacy JSON is unchanged.`)
          }
          const initial = bytes === undefined ? emptyResearchState() : ResearchState.parse(JSON.parse(bytes))
          this.persist(db, initial)
          db.query("INSERT INTO metadata(key,value) VALUES ('schema','1')").run()
          if (bytes !== undefined) db.query("INSERT INTO metadata(key,value) VALUES ('legacy_sha256',?)").run(hash(bytes))
        }
        db.exec("COMMIT")
      } catch (error) { db.exec("ROLLBACK"); throw error }
      return db
    } catch (error) { db.close(); throw error }
  }

  private rows(db: Database, scope?: RecordScope) {
    const query = "SELECT collection,id,value,refs FROM records"
    if (!scope) return db.query(query).all() as Array<{collection: string; id: string; value: string; refs: string}>
    const rows: Array<{collection: string; id: string; value: string; refs: string}> = []
    for (const [collection, ids] of Object.entries(scope.records)) {
      if (!(collection in ResearchState.shape) || collection === 'version') throw new Error('Unknown scoped collection')
      if (ids === 'all') rows.push(...db.query(query + ' WHERE collection=?').all(collection) as typeof rows)
      else for (const id of new Set(ids)) rows.push(...db.query(query + ' WHERE collection=? AND id=?').all(collection, id) as typeof rows)
    }
    return rows
  }

  /** Resolve the next immutable event slot only AFTER acquiring the original
   * database writer. A concurrent revision cannot widen the caller's authority. */
  private resolveScope(db: Database, scope?: RecordScope): RecordScope | undefined {
    if (!scope?.operationNextEvent) return scope
    if (!selected(scope,'operations',scope.operationNextEvent)) throw new Error('Next event requires its exact operation scope')
    const row = db.query("SELECT value FROM records WHERE collection='operations' AND id=?").get(scope.operationNextEvent) as {value: string} | null
    const revision = row ? JSON.parse(row.value).revision : undefined
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Original operation revision is missing or invalid')
    const eventId = `ope_${operationHash([scope.operationNextEvent, revision + 1])}`
    const previous = scope.records.operationEvents
    return {...scope, records: {...scope.records, operationEvents: previous === 'all' ? 'all' : [...(previous ?? []), eventId]}}
  }

  private snapshot(db: Database, scope?: RecordScope): ResearchState {
    const state = emptyResearchState() as Record<string, unknown>
    const blobs = new Map<string, unknown>()
    const rows = this.rows(db, scope)
    for (const row of rows) {
      if (!(row.collection in state) || row.collection === "version") throw new Error(`Unknown research collection ${row.collection}`)
      const value = JSON.parse(row.value)
      for (const [field, digest] of Object.entries(JSON.parse(row.refs)) as Array<[string,string]>) {
        if (!blobs.has(digest)) {
          const blob = db.query("SELECT value FROM blobs WHERE hash=?").get(digest) as { value: string } | null
          if (!blob || hash(blob.value) !== digest) throw new Error(`Corrupt research blob ${digest}`)
          blobs.set(digest, JSON.parse(blob.value))
        }
        if (field.startsWith("checkpoint:")) {
          value.checkpoints ??= {}
          value.checkpoints[field.slice("checkpoint:".length)] = structuredClone(blobs.get(digest))
        } else value[field] = structuredClone(blobs.get(digest))
      }
      ;(state[row.collection] as Record<string, unknown>)[row.id] = value
      if (scope?.jobAncestors && row.collection === 'jobs' && typeof value.payload?.parentJobId === 'string' && !rows.some(item => item.collection === 'jobs' && item.id === value.payload.parentJobId)) {
        rows.push(...this.rows(db, {records: {jobs: [value.payload.parentJobId]}}))
      }
    }
    return ResearchState.parse(state)
  }

  private persist(db: Database, raw: ResearchState, scope?: RecordScope) {
    const state = ResearchState.parse(raw)
    const existing = new Map(this.rows(db, scope).map(row => [JSON.stringify([row.collection,row.id]), row]))
    const putBlob = db.query("INSERT OR IGNORE INTO blobs(hash,value) VALUES (?,?)")
    const put = db.query("INSERT INTO records(collection,id,value,refs) VALUES (?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,refs=excluded.refs")
    for (const [collection, records] of Object.entries(state)) {
      if (collection === "version") continue
      for (const [id, item] of Object.entries(records)) {
        if (scope && !selected(scope, collection, id)) continue
        const value = typeof item === "object" && item !== null ? { ...item } as Record<string, unknown> : item
        const refs: Record<string,string> = {}
        if (collection === "jobs" && typeof value === "object" && value !== null) {
          for (const field of ["payload", "result"]) {
            if (value[field] === undefined) continue
            const serialized = JSON.stringify(value[field])
            const digest = hash(serialized)
            putBlob.run(digest, serialized)
            refs[field] = digest
            delete value[field]
          }
          for (const [phase, checkpoint] of Object.entries(value.checkpoints as Record<string, unknown> ?? {})) {
            const serialized = JSON.stringify(checkpoint)
            const digest = hash(serialized)
            putBlob.run(digest, serialized)
            refs[`checkpoint:${phase}`] = digest
          }
          value.checkpoints = {}
        }
        const serialized = JSON.stringify(value), references = JSON.stringify(refs)
        const key = JSON.stringify([collection,id]), previous = existing.get(key)
        if (!previous || previous.value !== serialized || previous.refs !== references) put.run(collection,id,serialized,references)
        existing.delete(key)
      }
    }
    const remove = db.query("DELETE FROM records WHERE collection=? AND id=?")
    for (const row of existing.values()) remove.run(row.collection,row.id)
    // Keep shared immutable data until its last owning record disappears.
    // This runs inside the same transaction as record replacement/deletion.
    if (!scope) db.exec("DELETE FROM blobs WHERE hash NOT IN (SELECT ref.value FROM records, json_each(records.refs) AS ref)")
  }

  /** Explicit database creation/offline legacy migration. Observation never initializes state. */
  async initialize(projectId: string): Promise<void> {
    using _ = await Lock.write(`research-sqlite:${this.location(projectId)}`)
    const db = await this.open(projectId)
    db.close()
  }

  private async openRead(projectId: string): Promise<Database | undefined> {
    const file = this.location(projectId)
    try { await fs.access(file) } catch (error: any) {
      if (error.code !== "ENOENT") throw error
      const legacy = this.options.legacyDirectory ? path.join(this.options.legacyDirectory, `${projectId}.json`) : undefined
      if (legacy && await fs.access(legacy).then(() => true, (error: any) => {if (error.code === "ENOENT") return false; throw error}))
        throw new Error("Research state requires explicit offline SQLite migration; reads never import legacy JSON")
      return undefined
    }
    const db = new Database(file, {readonly: true})
    try {
      db.exec("PRAGMA busy_timeout=50")
      const initialized = db.query("SELECT value FROM metadata WHERE key='schema'").get() as {value: string} | null
      if (initialized?.value !== "1") throw new Error("Research database requires explicit initialization or unsupported schema")
      return db
    } catch (error) {db.close(); throw error}
  }

  async readWithRevision(projectId: string, priorRevision?: string): Promise<{revision?: string; state?: ResearchState}> {
    const db = await this.openRead(projectId)
    if (!db) return {state: emptyResearchState()}
    try {
      db.exec('BEGIN')
      const revision = (db.query("SELECT value FROM metadata WHERE key='read_revision'").get() as {value: string} | null)?.value
      // Unknown historical tokens always reconstruct; observation never converts them.
      const result = revision !== undefined && revision === priorRevision
        ? {revision} : {revision, state: this.snapshot(db)}
      db.exec('COMMIT')
      return result
    } finally {db.close()}
  }

  async readRecords(projectId: string, scope: RecordScope) { return this.readSnapshot(projectId, scope) }
  async read(projectId: string): Promise<ResearchState> { return this.readSnapshot(projectId) }
  private async readSnapshot(projectId: string, scope?: RecordScope): Promise<ResearchState> {
    // WAL readers observe the last committed snapshot without taking writer/schema authority.
    // No process-local writer lock: it would unnecessarily block readers behind a valid writer.
    const db = await this.openRead(projectId)
    if (!db) return emptyResearchState()
    try {
      db.exec("BEGIN")
      const state = this.snapshot(db, scope)
      db.exec("COMMIT")
      return state
    } finally { db.close() }
  }

  async mutateRecords<T>(projectId: string, scope: RecordScope, fn: (draft: ResearchState) => T | Promise<T>) { return this.transaction(projectId, fn, scope) }
  async mutate<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>): Promise<T> { return this.transaction(projectId, fn) }
  private async transaction<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>, scope?: RecordScope): Promise<T> {
    using _ = await Lock.write(`research-sqlite:${this.location(projectId)}`)
    const db = await this.open(projectId)
    try {
      // Acquire the cross-process writer before reading. The callback runs exactly once;
      // retrying it after optimistic conflicts could repeat external side effects.
      await retryBusy(() => db.exec("BEGIN IMMEDIATE"))
      try {
        scope = this.resolveScope(db, scope)
        const draft = this.snapshot(db, scope)
        const scopedBefore = scope ? structuredClone(draft) : undefined
        const previous=structuredClone({operations:draft.operations,operationEvents:draft.operationEvents,operationOutbox:draft.operationOutbox})
        const result = await fn(draft)
        if (scope) assertScopedWrites(scopedBefore!, draft, scope)
        assertOperationHistory(previous,draft)
        this.persist(db, draft, scope)
        // Derivative cache invalidation is part of the same canonical commit.
        db.query("INSERT INTO metadata(key,value) VALUES ('read_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(crypto.randomUUID())
        db.exec("COMMIT")
        return result
      } catch (error) { db.exec("ROLLBACK"); throw error }
    } finally { db.close() }
  }
}

function hash(text: string) { return createHash("sha256").update(text).digest("hex") }

async function retryBusy<T>(operation: () => T): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try { return operation() } catch (error) {
      if (!(error instanceof Error) || !["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as Error & { code?: string }).code)) || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

export class MemoryResearchStore implements ResearchStore {
  private readonly projects = new Map<string, ResearchState>()
  private readonly lockId = crypto.randomUUID()
  private readonly revisions = new Map<string,string>()

  async read(projectId: string): Promise<ResearchState> {
    using _ = await Lock.read(`memory-research:${this.lockId}:${projectId}`)
    return structuredClone(this.projects.get(projectId) ?? emptyResearchState())
  }

  async readWithRevision(projectId: string, priorRevision?: string) {
    using _ = await Lock.read(`memory-research:${this.lockId}:${projectId}`)
    const revision = this.revisions.get(projectId)
    return revision !== undefined && revision === priorRevision ? {revision}
      : {revision, state: structuredClone(this.projects.get(projectId) ?? emptyResearchState())}
  }

  async mutate<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>): Promise<T> {
    using _ = await Lock.write(`memory-research:${this.lockId}:${projectId}`)
    const draft = structuredClone(this.projects.get(projectId) ?? emptyResearchState())
    const previous=structuredClone({operations:draft.operations,operationEvents:draft.operationEvents,operationOutbox:draft.operationOutbox})
    const result = await fn(draft)
    assertOperationHistory(previous,draft)
    this.projects.set(projectId, ResearchState.parse(draft))
    this.revisions.set(projectId,crypto.randomUUID())
    return result
  }
}
