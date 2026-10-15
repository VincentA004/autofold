import { afterEach, expect, test } from "bun:test"
import { ResearchDomain } from "./domain"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StorageResearchStore, MemoryResearchStore, ResearchState, emptyResearchState } from "./store"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-store-test-")); roots.push(root)
  const options = { directory: path.join(root, "db"), legacyDirectory: path.join(root, "legacy") }
  await fs.mkdir(options.legacyDirectory)
  return { root, options, store: new StorageResearchStore(options), project: "prj_test" }
}

test("legacy import is explicitly offline, lossless, and never reimported", async () => {
  const { options, store, project } = await fixture()
  const initial = emptyResearchState(); initial.branchCursors.exp_test = "branch_original"
  const legacy = path.join(options.legacyDirectory, `${project}.json`)
  const bytes = JSON.stringify(initial)
  await fs.writeFile(legacy, bytes)
  await expect(store.read(project)).rejects.toThrow("offline SQLite migration")
  expect(await fs.readFile(legacy, "utf8")).toBe(bytes)
  const migration = new StorageResearchStore({ ...options, allowLegacyImport: true })
  await expect(migration.read(project)).rejects.toThrow("offline SQLite migration")
  await migration.initialize(project)
  expect(await migration.read(project)).toEqual(initial)
  await fs.writeFile(legacy, "invalid later legacy write")
  expect(await store.read(project)).toEqual(initial)
})

test("failed imports and failed callbacks do not commit partial state", async () => {
  const { options, project } = await fixture()
  const store = new StorageResearchStore({ ...options, allowLegacyImport: true })
  const legacy = path.join(options.legacyDirectory, `${project}.json`)
  await fs.writeFile(legacy, '{"version":99}')
  await expect(store.initialize(project)).rejects.toThrow()
  await fs.writeFile(legacy, JSON.stringify(emptyResearchState()))
  await expect(store.mutate(project, async state => {
    state.branchCursors.exp_test = "uncommitted"
    await Bun.sleep(1)
    throw new Error("abort")
  })).rejects.toThrow("abort")
  expect((await store.read(project)).branchCursors).toEqual({})
})

test("memory and SQLite serialize asynchronous writers without lost updates", async () => {
  const { store, project } = await fixture()
  for (const candidate of [store, new MemoryResearchStore()]) {
    await Promise.all(Array.from({ length: 5 }, () => candidate.mutate(project, async state => {
      const previous = Number(state.branchCursors.count ?? "0")
      await Bun.sleep(2)
      state.branchCursors.count = String(previous + 1)
    })))
    expect((await candidate.read(project)).branchCursors.count).toBe("5")
  }
})

function child(options: { directory: string; legacyDirectory: string }, body: string) {
  return Bun.spawn([process.execPath, "--eval", `import { StorageResearchStore } from ${JSON.stringify(import.meta.dir + "/store.ts")}; const store = new StorageResearchStore(${JSON.stringify(options)}); ${body}`],
    { cwd: path.resolve(import.meta.dir, "../.."), env: process.env, stdout: "pipe", stderr: "pipe" })
}

test("separate processes serialize writers against the same committed snapshot", async () => {
  const { options, store, project } = await fixture()
  await store.read(project)
  const workers = Array.from({ length: 3 }, () => child(options, `for (let i=0;i<3;i++) await store.mutate("prj_test", async s => {const n=Number(s.branchCursors.count??"0"); await Bun.sleep(5); s.branchCursors.count=String(n+1)});`))
  const results = await Promise.all(workers.map(async worker => ({ code: await worker.exited, error: await new Response(worker.stderr).text() })))
  expect(results).toEqual(results.map(() => ({ code: 0, error: "" })))
  expect((await store.read(project)).branchCursors.count).toBe("9")
}, 15000)

test("killing a process during mutation preserves the previous committed state", async () => {
  const { root, options, store, project } = await fixture()
  await store.mutate(project, s => { s.branchCursors.count = "committed" })
  const marker = path.join(root, "ready")
  const worker = child(options, `await store.mutate("prj_test", async s => {s.branchCursors.count="lost"; await Bun.write(${JSON.stringify(marker)}, "ready"); await Bun.sleep(60000)});`)
  try {
    const deadline = Date.now() + 5000
    while (!await Bun.file(marker).exists()) {
      if (Date.now() > deadline) throw new Error("Child did not acquire transaction")
      await Bun.sleep(10)
    }
  } finally { worker.kill("SIGKILL"); await worker.exited }
  expect((await store.read(project)).branchCursors.count).toBe("committed")
}, 10000)

test("heartbeat changes a small job header without rewriting immutable checkpoint blobs", async () => {
  const { options, store, project } = await fixture()
  const time = "2026-09-12T00:00:00.000Z"
  await store.mutate(project, s => {
    s.jobs.job_test = ResearchDomain.Job.parse({ id: "job_test", projectId: project, idempotencyKey: "test", status: "queued", attempts: 0, maxAttempts: 3,
      createdAt: time, updatedAt: time, payload: { kind: "autoresearch", experimentId: "exp_test", sessionId: "ses_test", iterations: 1, agent: "biology" },
      checkpoints: { trace: { phase: "trace", completedAt: time, data: { text: "x".repeat(100_000) } } } })
  })
  const db = new Database(path.join(options.directory, `${project}.sqlite`))
  try {
    const before = db.query("SELECT * FROM blobs ORDER BY hash").all()
    db.exec("CREATE TRIGGER forbid_blob_update BEFORE UPDATE ON blobs BEGIN SELECT RAISE(ABORT,'immutable'); END")
    await store.mutate(project, s => { s.jobs.job_test.heartbeatAt = "2026-09-12T00:01:00.000Z" })
    expect(db.query("SELECT * FROM blobs ORDER BY hash").all()).toEqual(before)
    const header = db.query("SELECT value FROM records WHERE collection='jobs'").get() as { value: string }
    expect(header.value.length).toBeLessThan(1000)
    expect((await store.read(project)).jobs.job_test.checkpoints.trace.data.text).toHaveLength(100_000)
    await store.mutate(project, s => { s.jobs.job_test.checkpoints.next = { phase: "next", completedAt: time, data: { small: true } } })
    const after = db.query("SELECT * FROM blobs ORDER BY hash").all()
    expect(after.length).toBe(before.length + 1)
    expect((await store.read(project)).jobs.job_test.checkpoints.trace.data.text).toHaveLength(100_000)
  } finally { db.close() }
})

test("production job claims across processes admit exactly one lease owner", async () => {
  const { options, store, project } = await fixture()
  const time = new Date().toISOString()
  await store.mutate(project, s => {
    s.jobs.job_test = ResearchDomain.Job.parse({ id: "job_test", projectId: project, idempotencyKey: "claim-race", status: "queued",
      attempts: 0, maxAttempts: 1, createdAt: time, updatedAt: time,
      payload: { kind: "autoresearch", experimentId: "exp_test", sessionId: "ses_test", iterations: 1, agent: "biology" } })
  })
  const workers = Array.from({ length: 3 }, () => child(options,
    `import { ResearchJobService } from ${JSON.stringify(import.meta.dir + "/job-service.ts")};
     const jobs=new ResearchJobService.Service(store); console.log(JSON.stringify((await jobs.claim("prj_test",30000))?.leaseId ?? null));`))
  const results = await Promise.all(workers.map(async worker => ({ code: await worker.exited,
    owner: JSON.parse(await new Response(worker.stdout).text()), error: await new Response(worker.stderr).text() })))
  expect(results.every(result => result.code === 0 && !result.error)).toBe(true)
  expect(results.filter(result => result.owner !== null)).toHaveLength(1)
  const job = (await store.read(project)).jobs.job_test
  expect(job.attempts).toBe(1)
  expect(job.leaseId).toBe(results.find(result => result.owner !== null)!.owner)
}, 15000)


test("blob collection retains shared checkpoints until their last reference is deleted", async () => {
  const { options, store, project } = await fixture()
  const time = "2026-09-12T00:00:00.000Z"
  await store.mutate(project, state => {
    for (const id of ["job_a", "job_b"]) state.jobs[id] = ResearchDomain.Job.parse({ id,
      projectId: project, idempotencyKey: id, status: "queued", attempts: 0, maxAttempts: 1,
      createdAt: time, updatedAt: time, payload: { kind: "autoresearch", experimentId: "exp_test", sessionId: "ses_test", iterations: 1, agent: "biology" },
      checkpoints: { shared: { phase: "shared", completedAt: time, data: { text: "evidence".repeat(1000) } } } })
  })
  const db = new Database(path.join(options.directory, `${project}.sqlite`))
  try {
    const before = db.query("SELECT hash FROM blobs ORDER BY hash").all()
    await store.mutate(project, state => { delete state.jobs.job_a })
    expect(db.query("SELECT hash FROM blobs ORDER BY hash").all()).toEqual(before)
    expect((await store.read(project)).jobs.job_b.checkpoints.shared.data.text).toHaveLength(8000)
    await store.mutate(project, state => { delete state.jobs.job_b })
    expect(db.query("SELECT hash FROM blobs").all()).toEqual([])
  } finally { db.close() }
})


test("constructing persistent storage requires an explicit absolute location", () => {
  expect(() => new StorageResearchStore({ directory: "relative" })).toThrow("explicit absolute directory")
  expect(() => new StorageResearchStore(undefined as never)).toThrow()
})

test("durable extensions survive schema parsing, blob encoding, and store reconstruction", async () => {
  const { store, options, project } = await fixture()
  const now = "2026-10-03T00:00:00.000Z"
  const record = ResearchDomain.Job.parse({
    id: "job_extension", projectId: project, idempotencyKey: "extended", status: "queued",
    attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now,
    futureRecord: { annotation: ["retained"] },
    payload: { kind: "autoresearch", experimentId: "exp_extension", sessionId: "ses_extension", iterations: 1,
      agent: "biology", futurePayload: { source: "future-runtime" } },
    checkpoints: { scientific_phase: { phase: "scientific_phase", completedAt: now,
      futureCheckpoint: { schema: 2 }, data: { nested: { retained: true } } } },
    result: { futureResult: { retained: true } },
  })
  for (const candidate of [store, new MemoryResearchStore()]) {
    await candidate.mutate(project, state => { state.jobs[record.id] = record })
    await candidate.mutate(project, state => { state.jobs[record.id].updatedAt = now })
    expect((await candidate.read(project)).jobs[record.id]).toEqual(record)
  }
  expect((await new StorageResearchStore(options).read(project)).jobs[record.id]).toEqual(record)
})

test("unsupported state collections, versions, and job formats are rejected", () => {
  expect(() => ResearchState.parse({ ...emptyResearchState(), futureCollection: {} })).toThrow()
  expect(() => ResearchState.parse({ ...emptyResearchState(), version: 2 })).toThrow()
  expect(() => ResearchDomain.JobPayload.parse({ kind: "future_job_v2" })).toThrow()
})

test('scoped lease transaction reads exact ancestry, skips unrelated blobs and cannot write outside its scope', async () => {
  const {options,store,project}=await fixture()
  const now=new Date().toISOString(), expires=new Date(Date.now()+60000).toISOString()
  await store.mutate(project, state => {
    for(const id of ['job_parent','job_child','job_unrelated']) state.jobs[id]=ResearchDomain.Job.parse({id,projectId:project,idempotencyKey:id,
      status:'running',attempts:1,maxAttempts:1,leaseId:'lease_'+id,leaseExpiresAt:expires,createdAt:now,updatedAt:now,
      payload:{kind:'autoresearch',agent:'biology',experimentId:'exp_test',sessionId:'ses_test',iterations:1,
        ...(id==='job_child'?{parentJobId:'job_parent'}:{})},checkpoints:{}})
  })
  const db=new Database(path.join(options.directory,project+'.sqlite'))
  try {
    // A targeted ownership read must not fetch an unrelated checkpoint blob.
    db.query("UPDATE records SET refs=? WHERE collection='jobs' AND id='job_unrelated'").run(JSON.stringify({'checkpoint:corrupt':'f'.repeat(64)}))
    const scope={records:{jobs:['job_child']},jobAncestors:'job_child'}
    const view=await store.readRecords(project,scope)
    expect(Object.keys(view.jobs).sort()).toEqual(['job_child','job_parent'])
    await store.mutateRecords(project,scope,state=>{state.jobs.job_child.heartbeatAt=now})
    expect((await store.readRecords(project,scope)).jobs.job_child.heartbeatAt).toBe(now)
    await expect(store.mutateRecords(project,scope,state=>{state.jobs.job_parent.status='cancelled'})).rejects.toThrow('cannot change jobs/job_parent')
    await expect(store.mutateRecords(project,scope,state=>{state.branchCursors.exp_test='unscoped'})).rejects.toThrow('cannot change branchCursors')
    expect((await store.readRecords(project,scope)).jobs.job_parent.status).toBe('running')
    await expect(store.read(project)).rejects.toThrow('Corrupt research blob')
  }finally{db.close()}
})


test('missing read is effect-free and initialized WAL readers do not wait for a writer', async () => {
  const {options, store, project} = await fixture()
  expect(await store.read(project)).toEqual(emptyResearchState())
  await expect(fs.access(path.join(options.directory, project + '.sqlite'))).rejects.toMatchObject({code: 'ENOENT'})
  await store.mutate(project, state => {state.branchCursors.exp_test = 'committed'})
  const db = new Database(path.join(options.directory, project + '.sqlite'))
  db.exec('BEGIN IMMEDIATE')
  db.query("UPDATE records SET value=? WHERE collection='branchCursors' AND id='exp_test'").run(JSON.stringify('uncommitted'))
  try {
    // A valid uncommitted writer remains active throughout these reads. A writer-locking
    // observation would time out; WAL must expose exactly the old committed snapshot.
    expect((await store.read(project)).branchCursors.exp_test).toBe('committed')
    expect((await store.readRecords(project, {records: {branchCursors: ['exp_test']}})).branchCursors.exp_test).toBe('committed')
  } finally {db.exec('ROLLBACK'); db.close()}
})
