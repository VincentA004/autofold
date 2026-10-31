import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const templates = fileURLToPath(new URL('../notebook', import.meta.url))

/** Create missing notebook pages; existing scientific notes always stay intact. */
export async function initializeNotebook(cwd: string) {
  const directory = join(cwd, 'notebook')
  await mkdir(directory, { recursive: true })
  for (const name of ['index.md', 'findings.md', 'questions.md']) {
    try {
      await copyFile(join(templates, name), join(directory, name), constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
