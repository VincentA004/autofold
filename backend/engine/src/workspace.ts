import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type {ResearchStore, ResearchState} from '@autofold/science-core/store'
import {ResearchDomain} from '@autofold/science-core/domain'
import {checkedPath} from './execution/paths'
const digest = (value: string) => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex')
/** Human workspace adapter never initializes or reconciles a scientist execution. */
export class ExperimentWorkspace {
  constructor(private readonly options: {workspace: string; projectId: string; store: ResearchStore}) {}
  private scope(state: ResearchState, experimentId: string) {
    const experiment = state.experiments[experimentId]
    if (!experiment || state.campaigns[experiment.campaignId]?.projectId !== this.options.projectId) throw new Error('Experiment is outside this project')
    ResearchDomain.assertContractIntegrity(experiment)
    return experiment
  }
  private root(id: string) {
    if (!/^exp_[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid experiment identity')
    return `.autofold/autoresearch/${id}`
  }
  private async location(id: string, file: string) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(part => part === '..' || part === '.' || !part) || file.includes('\0')) throw new Error('File must remain inside this experiment workspace')
    return checkedPath(this.options.workspace, this.root(id) + '/' + file)
  }
  async view(experimentId: string) {
    const state = await this.options.store.read(this.options.projectId), experiment = this.scope(state, experimentId)
    const root = this.root(experimentId), files: {path: string; bytes: number; mutable: boolean}[] = []
    let visited=0
    const visit = async (relative: string) => {
      if(++visited>2000)return
      const absolute = await checkedPath(this.options.workspace, relative)
      for (const entry of await fs.readdir(absolute, {withFileTypes: true}).catch(error => {if (error.code === 'ENOENT') return []; throw error})) {
        if(visited++>=2000||files.length>=1000)break
        if (entry.isSymbolicLink()) throw new Error('Workspace contains a symbolic link')
        const child = relative + '/' + entry.name
        if (entry.isDirectory()) await visit(child)
        else if (entry.isFile() && files.length < 1000) {
          const file = child.slice(root.length + 1)
          files.push({path: file, bytes: (await fs.stat(await checkedPath(this.options.workspace, child))).size, mutable: this.mutable(file)})
        }
      }
    }
    await visit(root)
    let kernelGap:string|undefined
    const kernel = await Bun.file(await this.location(experimentId, 'scientist.json')).json().catch(error => {kernelGap=error instanceof Error?error.message:String(error);return null})
    return {inventoryTruncated:visited>=2000||files.length>=1000,experiment, root, sessionId: experiment.piScientistSessionId ?? null, files, kernel,kernelProjection:{authority:'derivative_export',status:kernelGap?'unavailable':'available',...(kernelGap?{error:kernelGap}:{})}}
  }
  private mutable(file: string) { return file === 'trial.py' || file === 'LAB.md' || file.startsWith('programs/') && file.endsWith('.py') }
  async read(experimentId: string, file: string) {
    this.scope(await this.options.store.read(this.options.projectId), experimentId)
    const location = await this.location(experimentId, file), stat = await fs.stat(location)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Workspace reads require a regular text file of at most 4 MiB')
    const content = await fs.readFile(location, 'utf8')
    if (content.includes('\0')) throw new Error('Binary artifacts are available through verified run receipts')
    return {path: file, content, hash: digest(content), mutable: this.mutable(file)}
  }
  async write(experimentId: string, input: {path: string; content: string; expectedHash: string | null}) {
    if (!this.mutable(input.path) || !input.content.length || Buffer.byteLength(input.content) > 262144 || input.content.includes('\0')) throw new Error('Edit a native Python program or LAB.md with 1–262144 UTF-8 bytes')
    return this.options.store.mutate(this.options.projectId, async state => {
      const experiment = this.scope(state, experimentId)
      if (Object.values(state.jobs).some(job => ['queued', 'running', 'retry_wait', 'interrupted', 'recovery_required'].includes(job.status) && (job.payload.experimentId === experimentId || job.payload.focusExperimentId === experimentId || job.payload.kind === 'campaign_loop' && job.payload.campaignId === experiment.campaignId))) throw new Error('Cancel, finish or reconcile unfinished scientist work before editing its programs')
      const location = await this.location(experimentId, input.path)
      const previous = await fs.readFile(location, 'utf8').catch(error => {if (error.code === 'ENOENT') return null; throw error})
      if ((previous === null ? null : digest(previous)) !== input.expectedHash) throw new Error('Program changed since it was opened; reload before saving')
      await fs.mkdir(path.dirname(location), {recursive: true, mode: 0o700})
      const temporary = location + '.' + crypto.randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600)
      try {await handle.writeFile(input.content); await handle.sync()} finally {await handle.close()}
      await fs.rename(temporary, location)
      return {path: input.path, hash: digest(input.content), mutable: true}
    })
  }
}
