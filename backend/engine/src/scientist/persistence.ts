import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export async function atomicJSON(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700})
  const temp = file + '.' + crypto.randomUUID() + '.tmp'
  const handle = await fs.open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  await fs.rename(temp, file)
  const directory = await fs.open(path.dirname(file), 'r')
  try { await directory.sync() } finally { await directory.close() }
}
