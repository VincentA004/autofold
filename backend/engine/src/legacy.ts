import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Read only: no legacy globals, schema changes, migrations, or old runtime initialization. */
export function inspectLegacy(file: string) {
  const database = new Database(path.resolve(file), { readonly: true })
  try {
    const schema = database.query("SELECT value FROM metadata WHERE key='schema'").get() as { value: string } | null
    if (schema?.value !== '1') throw new Error('Unsupported legacy scientific database schema')
    const integrity = database.query('PRAGMA integrity_check').get() as Record<string, string>
    if (Object.values(integrity)[0] !== 'ok') throw new Error('Legacy database integrity check failed')
    const collections = database.query('SELECT collection,count(*) AS count FROM records GROUP BY collection ORDER BY collection').all()
    let checkedBlobs = 0
    for (const blob of database.query('SELECT hash,value FROM blobs').all() as Array<{ hash: string; value: string }>) {
      if (createHash('sha256').update(blob.value).digest('hex') !== blob.hash) throw new Error(`Legacy blob hash mismatch: ${blob.hash}`)
      checkedBlobs++
    }
    const experiments = (database.query("SELECT value FROM records WHERE collection='experiments'").all() as Array<{ value: string }>).map(row => {
      const value = JSON.parse(row.value)
      return { id: value.id, campaignId: value.campaignId, status: value.status, contractHash: value.contractHash, incumbentTrialId: value.incumbentTrialId }
    })
    return { database: path.resolve(file), schema: 1, mode: 'read_only', integrity: 'ok', collections, checkedBlobs, experiments }
  } finally { database.close() }
}
