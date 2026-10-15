import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {checkedPath} from '../execution/paths'

export interface FrozenReferenceFile {path: string; contentHash: string; bytes: number}
const digest = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
/** Shared API source only: never another arm's program, transcript or outcome. */
export async function captureReferenceFiles(workspace: string, root: string): Promise<FrozenReferenceFile[]> {
  const files: FrozenReferenceFile[] = []; let total = 0
  const visit = async (relative: string) => {
    const directory = await checkedPath(workspace, relative)
    for (const entry of (await fs.readdir(directory, {withFileTypes: true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name = relative + '/' + entry.name
      if (entry.isSymbolicLink()) throw new Error('Frozen reference contains a symbolic link')
      if (entry.isDirectory()) {await visit(name); continue}
      if (!entry.isFile() || !/\.(py|md|json)$/.test(entry.name)) continue
      const file = await checkedPath(workspace, name), stat = await fs.stat(file)
      if (stat.size > 524288) throw new Error('Frozen reference exceeds file bound')
      const bytes = await fs.readFile(file); total += bytes.length
      if (files.length >= 2048 || total > 25165824) throw new Error('Frozen reference exceeds inventory bound')
      files.push({path: name, bytes: bytes.length, contentHash: digest(bytes)})
    }
  }
  await visit(root); return files
}
/** Integrity policy for the shared native scientific workspace reader. */
export function verifyFrozenReference(files:FrozenReferenceFile[],relative:string,bytes:Buffer) {
  const expected=files.find(file=>file.path===relative)
  if(!expected)throw new Error('Reference is outside the frozen API inventory')
  if(bytes.length!==expected.bytes||digest(bytes)!==expected.contentHash)throw new Error('Frozen API reference changed')
}
