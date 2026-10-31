import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readArchiveText } from './archive.ts'
import type { ArchiveCatalog } from './archive-types'

export interface CampaignEntry { id: string; title: string; root: string }

/** Direct campaign children only: never recursively import prior runs or follow symlinks. */
export async function campaignCatalog(defaultRoot: string, archivesDirectory?: string) {
  const entries: CampaignEntry[] = [], roots = new Set<string>()
  const add = async (root: string, id: string) => {
    const canonical = await realpath(root)
    if (roots.has(canonical)) return
    if (entries.some(entry => entry.id === id)) throw new Error(`Duplicate campaign identifier: ${id}`)
    const brief = await readArchiveText(canonical, 'campaign.md')
    roots.add(canonical)
    entries.push({ id, root: canonical, title: /^#\s+(.+)$/m.exec(brief)?.[1]?.trim() || id })
  }
  const defaultId = basename(defaultRoot) === 'campaign' ? basename(dirname(defaultRoot)) : basename(defaultRoot)
  await add(defaultRoot, defaultId)
  if (archivesDirectory) {
    const directory = await realpath(archivesDirectory)
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.')) continue
      const candidate = join(directory, item.name, 'campaign')
      try {
        // realpath equality excludes outward campaign-directory symlinks as well.
        if (await realpath(candidate) !== candidate || !(await stat(candidate)).isDirectory()) continue
        await add(candidate, item.name)
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      }
    }
  }
  const publicCatalog: ArchiveCatalog = { defaultId, campaigns: entries.map(({ id, title }) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)) }
  return { entries, publicCatalog }
}
