import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { StorageResearchStore } from "./store"
import { ResearchDomain } from "./domain"

const fixture = Bun.env.AUTOFOLD_LEGACY_COMPATIBILITY_FIXTURE

test.skipIf(!fixture)("real legacy SQLite snapshot retains all records, blobs, checkpoints and frozen contracts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-source-compatibility-"))
  try {
    const source = fixture!
    const projectId = path.basename(source, ".sqlite")
    const sourceHash = new Bun.CryptoHasher("sha256").update(await fs.readFile(source)).digest("hex")
    const copy = path.join(directory, `${projectId}.sqlite`)
    await fs.copyFile(source, copy)
    await fs.chmod(copy, 0o600)
    const raw = new Database(copy)
    let records: Array<{ collection: string; id: string; value: string; refs: string }>
    let blobRows: Array<{ hash: string; value: string }>
    try {
      expect(raw.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      records = raw.query("SELECT collection,id,value,refs FROM records ORDER BY collection,id").all() as typeof records
      blobRows = raw.query("SELECT hash,value FROM blobs ORDER BY hash").all() as typeof blobRows
    } finally { raw.close() }
    const blobs = new Map(blobRows.map(blob => [blob.hash, blob.value]))
    for (const blob of blobRows) {
      expect(new Bun.CryptoHasher("sha256").update(blob.value).digest("hex") === blob.hash).toBe(true)
    }
    const store = new StorageResearchStore({ directory })
    const state = await store.read(projectId)
    let checkpoints = 0
    for (const row of records) {
      const original = JSON.parse(row.value)
      for (const [field, digest] of Object.entries(JSON.parse(row.refs)) as Array<[string, string]>) {
        const serialized = blobs.get(digest)
        expect(serialized !== undefined).toBe(true)
        const value = JSON.parse(serialized!)
        if (field.startsWith("checkpoint:")) {
          original.checkpoints ??= {}
          original.checkpoints[field.slice("checkpoint:".length)] = value
          checkpoints++
        } else original[field] = value
      }
      const actual = (state as unknown as Record<string, Record<string, unknown>>)[row.collection][row.id] as Record<string, unknown>
      expect(actual !== undefined).toBe(true)
      for (const [field, value] of Object.entries(original)) {
        // Assertions print only booleans, keeping scientific fixture content private.
        expect(isDeepStrictEqual(actual[field], value)).toBe(true)
      }
    }
    const stateRecords = Object.entries(state).filter(([collection]) => collection !== "version")
      .reduce((count, [, items]) => count + Object.keys(items).length, 0)
    expect(stateRecords).toBe(records.length)
    for (const experiment of Object.values(state.experiments)) {
      expect(ResearchDomain.hashContract(experiment.contract) === experiment.contractHash).toBe(true)
    }
    await store.mutate(projectId, () => undefined)
    const checked = new Database(copy, { readonly: true })
    try {
      expect(isDeepStrictEqual(checked.query("SELECT collection,id,value,refs FROM records ORDER BY collection,id").all(), records)).toBe(true)
      expect(isDeepStrictEqual(checked.query("SELECT hash,value FROM blobs ORDER BY hash").all(), blobRows)).toBe(true)
    } finally { checked.close() }
    const reconstructed = await new StorageResearchStore({ directory }).read(projectId)
    expect(isDeepStrictEqual(reconstructed, state)).toBe(true)
    expect(new Bun.CryptoHasher("sha256").update(await fs.readFile(source)).digest("hex") === sourceHash).toBe(true)
    console.info(JSON.stringify({ compatibility: "verified", records: stateRecords, blobs: blobRows.length,
      checkpoints, contracts: Object.keys(state.experiments).length, sourceSha256: sourceHash }))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}, 60_000)
