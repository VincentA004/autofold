import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {ResearchArtifacts} from '@autofold/science-core/artifacts'
import type {ResearchDomain} from '@autofold/science-core/domain'
import type {ScientistLaneOptions} from './index'
import {checkedPath} from '../execution/paths'
const hash=(bytes:Uint8Array|string)=>crypto.createHash('sha256').update(bytes).digest('hex')

export class FrozenTargetPublicationError extends Error {
  constructor(error:unknown){super(error instanceof Error?error.message:String(error));this.name='FrozenTargetPublicationError'}
}
/** Copies and verifies frozen target bytes; never authors science or grants execution. */
export class FrozenTargetReferences {
  private targetManifestHash?:string
  constructor(private readonly options:Pick<ScientistLaneOptions,'workspace'|'projectId'|'experimentId'|'store'>,private readonly root:string) {}
  async verifyPublished(){if(this.targetManifestHash)await this.verify()}
  async verifyRead(relative:string,bytes:Buffer){
    if(!relative.startsWith(this.root+'/references/frozen-target/'))return
    const manifest=await this.verify()
    const expected=relative.endsWith('/manifest.json')?this.targetManifestHash:manifest.entries.find(entry=>entry.path===relative)?.sourceHash
    if(!expected||'sha256:'+hash(bytes)!==expected)throw new Error('Frozen target reference changed during read')
  }
  async publish(experiment: ResearchDomain.Experiment) {
    const source = ResearchArtifacts.targetPath(experiment.contract.targetArtifactHash)
    // Offline heuristic fixtures historically have no target artifact. Real files are never ignored.
    if (!await Bun.file(await checkedPath(this.options.workspace, source)).exists()) {
      if (await Bun.file(await checkedPath(this.options.workspace, this.root+'/references/frozen-target/manifest.json')).exists()) throw new Error('Frozen target source disappeared')
      return
    }
    const target = await ResearchArtifacts.readTarget(this.options.workspace, experiment.contract.targetArtifactHash)
    const directory = this.root + '/references/frozen-target'
    try{await fs.mkdir(await checkedPath(this.options.workspace, directory), {recursive: true, mode: 0o700})}catch(error){throw new FrozenTargetPublicationError(error)}
    const entries: {path: string; sourcePath?: string; sourceHash: string}[] = []
    for (const relative of [target.targetArtifactPath, target.structureArtifactPath].filter((value): value is string => !!value)) {
      const bytes = await fs.readFile(await checkedPath(this.options.workspace, relative))
      const expected = relative === target.targetArtifactPath ? target.targetArtifactHash : target.artifact.structure!.contentHash
      if ('sha256:' + hash(bytes) !== expected) throw new Error('Frozen target changed during reference capture')
      const destination = directory + '/' + path.basename(relative)
      await this.writeReference(destination, bytes)
      entries.push({path: destination, sourcePath: relative, sourceHash: expected})
    }
    const structure = target.structureArtifactPath && target.artifact.structure?.format === 'pdb'
      ? await fs.readFile(await checkedPath(this.options.workspace, target.structureArtifactPath), 'utf8') : undefined
    const amino: Record<string, string> = {ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V'}
    const observed = new Map<string, {residueNumber: string; insertionCode: string; residueName: string}[]>()
    const seen = new Map<string,string>(), ambiguousChains = new Set<string>()
    // Preserve explicit PDB identifiers in file order; do not align partial chains or guess numbering.
    for (const line of (structure ?? '').split('\n')) {
      if (line.startsWith('ENDMDL')) break
      if (!line.startsWith('ATOM  ')) continue
      const chainId = line.slice(21,22).trim(), residueNumber = line.slice(22,26).trim(), insertionCode = line.slice(26,27).trim()
      const key = JSON.stringify([chainId,residueNumber,insertionCode])
      if (seen.has(key)) {if (seen.get(key) !== line.slice(17,20).trim()) ambiguousChains.add(chainId); continue}
      seen.set(key,line.slice(17,20).trim())
      const residues = observed.get(chainId) ?? []
      residues.push({residueNumber,insertionCode,residueName:line.slice(17,20).trim()}); observed.set(chainId,residues)
    }
    const map = {format:'autofold.frozen-target-residue-map.v1', targetArtifactHash:target.targetArtifactHash,
      structureHash:target.artifact.structure?.contentHash ?? null,
      numbering:'sequencePosition is one-based in target.json; PDB identifiers are literal source fields, never sequence indexes.',
      chains:target.artifact.chains.map(chain => {
        const residues = observed.get(chain.id) ?? []
        const exact = !!structure && !ambiguousChains.has(chain.id) && residues.map(residue => amino[residue.residueName] ?? '?').join('') === chain.sequence
        return {chainId:chain.id, mapping:exact ? 'exact_observed_chain_sequence' : 'unresolved', observedPdbResidues:residues,
          residues:[...chain.sequence].map((aminoAcid,index) => ({sequencePosition:index+1,aminoAcid,
            bindingSite:target.artifact.bindingSite.residues.some(residue => residue.chainId === chain.id && residue.position === index+1),
            pdb:exact ? residues[index] : null}))}
      })}
    const mapPath = directory + '/residue-map.json', mapBytes = Buffer.from(JSON.stringify(map,null,2)+'\n')
    await this.writeReference(mapPath,mapBytes); entries.push({path:mapPath,sourceHash:'sha256:'+hash(mapBytes)})
    await ResearchArtifacts.readTarget(this.options.workspace, experiment.contract.targetArtifactHash)
    const manifestBytes = Buffer.from(JSON.stringify({targetArtifactHash:target.targetArtifactHash,entries},null,2)+'\n')
    await this.writeReference(directory + '/manifest.json', manifestBytes)
    this.targetManifestHash = 'sha256:'+hash(manifestBytes)
  }
  private async writeReference(relative: string, bytes: Uint8Array) {
    const file = await checkedPath(this.options.workspace, relative)
    let existing:Buffer|undefined
    try{existing=await fs.readFile(file)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new FrozenTargetPublicationError(error)}
    if (existing) {if (!Buffer.from(bytes).equals(existing)) throw new Error('Frozen target reference bytes changed'); return}
    try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o400})}catch(error){throw new FrozenTargetPublicationError(error)}
  }
  async verify() {
    const state=await this.options.store.read(this.options.projectId),experiment=state.experiments[this.options.experimentId]
    if(!experiment)throw new Error('Frozen experiment disappeared')
    await ResearchArtifacts.readTarget(this.options.workspace,experiment.contract.targetArtifactHash)
    const directory = this.root + '/references/frozen-target'
    const manifestBytes = await fs.readFile(await checkedPath(this.options.workspace,directory+'/manifest.json'))
    if ('sha256:'+hash(manifestBytes) !== this.targetManifestHash) throw new Error('Frozen target reference manifest changed')
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (manifest.targetArtifactHash !== experiment.contract.targetArtifactHash) throw new Error('Frozen target reference binding changed')
    for (const entry of manifest.entries) {
      if (!entry.path.startsWith(directory+'/') || 'sha256:'+hash(await fs.readFile(await checkedPath(this.options.workspace,entry.path))) !== entry.sourceHash) throw new Error('Frozen target reference hash changed')
      if (entry.sourcePath && 'sha256:'+hash(await fs.readFile(await checkedPath(this.options.workspace,entry.sourcePath))) !== entry.sourceHash) throw new Error('Frozen target source hash changed')
    }
    return manifest as {entries:{path:string;sourceHash:string}[]}
  }
}
