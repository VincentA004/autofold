import fs from "node:fs/promises"
import path from "node:path"

export function inside(root: string, relative: string): string {
  const target = path.resolve(root, relative)
  const relation = path.relative(path.resolve(root), target)
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Research path escapes workspace: ${relative}`)
  }
  return target
}
/** Reject aliases below the host workspace, including existing ancestors of new paths. */
export async function checkedPath(root: string, relative: string): Promise<string> {
  const target = inside(root, relative)
  const realRoot = await fs.realpath(root)
  const parts = path.relative(path.resolve(root), target).split(path.sep).filter(Boolean)
  let current = path.resolve(root)
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fs.lstat(current).catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) break
    if (stat.isSymbolicLink()) throw new Error(`Research path contains a symbolic link: ${current}`)
    inside(realRoot, await fs.realpath(current))
  }
  return target
}
export async function assertSafeTree(root: string, file: string): Promise<void> {
  await checkedPath(root, file)
  const stat = await fs.lstat(file)
  if (!stat.isDirectory()) return
  for (const entry of await fs.readdir(file, {withFileTypes: true})) {
    if (entry.isSymbolicLink()) throw new Error(`Research artifact contains a symbolic link: ${entry.name}`)
    if (entry.isDirectory()) await assertSafeTree(root, path.join(file, entry.name))
  }
}
