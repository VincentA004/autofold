import fs from "node:fs/promises"
import path from "node:path"

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Resolve existing links before touching a scientific artifact. Missing leaves
 * are anchored to their nearest existing real ancestor. The returned canonical
 * path avoids following an already checked symlink again during the operation.
 * Call again after creating directories and immediately before later I/O.
 */
export async function confinedPath(workspace: string, relative: string): Promise<string> {
  const root = path.resolve(workspace)
  const target = path.resolve(root, relative)
  const escape = () => new Error(`Research path escapes the project: ${relative}`)
  if (!contains(root, target)) throw escape()
  const realRoot = await fs.realpath(root)
  let existing = target
  const missing: string[] = []
  for (;;) {
    try {
      await fs.lstat(existing)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      if (existing === root) throw error
      missing.unshift(path.basename(existing))
      existing = path.dirname(existing)
      continue
    }
    // A dangling link is present but cannot be resolved: reject it rather than
    // treating it as an absent directory and following it during mkdir/write.
    const realExisting = await fs.realpath(existing)
    if (!contains(realRoot, realExisting)) throw escape()
    const canonical = path.resolve(realExisting, ...missing)
    if (!contains(realRoot, canonical)) throw escape()
    return canonical
  }
}
