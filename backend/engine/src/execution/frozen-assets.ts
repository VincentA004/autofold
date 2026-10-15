import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import {checkedPath} from './paths'

export interface FrozenAssetInput {
  experimentId:string
  id:string
  path:string
  contentHash:string
  /** JSON pointers into the native descriptor whose string bytes must equal this asset. */
  nativeBindings:string[]
}
const hash=(value:Buffer)=>'sha256:'+crypto.createHash('sha256').update(value).digest('hex')

export async function freezeAssets(workspace:string,experimentId:string,inputs:readonly FrozenAssetInput[]=[]) {
  const selected=inputs.filter(input=>input.experimentId===experimentId)
  if(!selected.length)return undefined
  if(selected.length>32||new Set(selected.map(input=>input.id)).size!==selected.length)throw new Error('Frozen asset identities must be unique and bounded')
  const assets:ExecutionProtocol.FrozenAsset[]=[]
  for(const input of selected){
    const source=await checkedPath(workspace,input.path),stat=await fs.stat(source)
    if(!stat.isFile()||stat.size>16*1024*1024)throw new Error('Frozen asset must be a bounded regular scoped file')
    const bytes=await fs.readFile(source)
    if(bytes.length>16*1024*1024)throw new Error('Frozen asset exceeds byte ceiling')
    if(hash(bytes)!==input.contentHash)throw new Error(`Frozen asset ${input.id} source bytes changed`)
    assets.push(ExecutionProtocol.FrozenAsset.parse({id:input.id,contentHash:input.contentHash,contentBase64:bytes.toString('base64'),nativeBindings:input.nativeBindings}))
  }
  if(assets.length>32||new Set(assets.map(asset=>asset.id)).size!==assets.length)throw new Error('Frozen asset identities must be unique and bounded')
  return assets
}

function atPointer(value:unknown,pointer:string):unknown {
  for(const encoded of pointer.slice(1).split('/')){
    if(/~(?![01])/u.test(encoded))throw new Error('Invalid frozen asset native binding pointer')
    const key=encoded.replace(/~1/g,'/').replace(/~0/g,'~')
    if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw new Error(`Frozen asset native binding is absent: ${pointer}`)
    value=(value as Record<string,unknown>)[key]
  }
  return value
}

/** Also validates original bundled authorities on reopen; current host defaults do not replace them. */
export function assertFrozenAssets(assets:readonly ExecutionProtocol.FrozenAsset[]|undefined,descriptor:unknown) {
  if(assets===undefined)return
  if(new Set(assets.map(asset=>asset.id)).size!==assets.length)throw new Error('Frozen asset identities must be unique')
  for(const source of assets){
    const asset=ExecutionProtocol.FrozenAsset.parse(source),bytes=Buffer.from(asset.contentBase64,'base64')
    if(bytes.length>16*1024*1024||bytes.toString('base64')!==asset.contentBase64||hash(bytes)!==asset.contentHash)throw new Error(`Frozen asset ${asset.id} bundled bytes changed`)
    for(const pointer of asset.nativeBindings){
      const actual=atPointer(descriptor,pointer)
      if(typeof actual!=='string'||hash(Buffer.from(actual,'utf8'))!==asset.contentHash)throw new Error(`Frozen asset ${asset.id} native input bytes differ at ${pointer}`)
    }
  }
}
