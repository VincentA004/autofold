import fs from 'node:fs/promises'
import path from 'node:path'
import type {ManifestObservation} from './oracle'

const artifactPaths:Record<string,string>={bundle:'../bundle.json',program:'../trial.py',result:'result.json',candidates:'candidates.json',generation_runs:'generation-runs/index.json',model_runs:'model-runs/index.json'}
const contained=(root:string,file:string)=>file===root||file.startsWith(root+path.sep)
/** Evidence collection only: paths come from the public run and immutable
 * manifest, never a research database. The oracle separately hashes the bytes. */
export async function collectManifestEvidence(input:{runId:string;workspace:string;outputPath:string;expectedSha?:string}):Promise<ManifestObservation>{
 const workspace=await fs.realpath(input.workspace),output=await fs.realpath(path.resolve(workspace,input.outputPath)),runRoot=await fs.realpath(path.dirname(output))
 if(!contained(workspace,output)||!contained(workspace,runRoot))throw Error('Artifact output escapes the disposable workspace')
 async function read(file:string,root:string){const real=await fs.realpath(file);if(!contained(root,real))throw Error('Artifact path or symlink escapes its permitted root');return new Uint8Array(await fs.readFile(real))}
 const bytes=await read(path.join(output,'manifest.json'),output),manifest=JSON.parse(new TextDecoder().decode(bytes))
 if(manifest.runId!==input.runId||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw Error('Manifest identity or artifact inventory is invalid')
 const files:Record<string,Uint8Array>={},linkedFiles:Record<string,Uint8Array>={}
 for(const key of Object.keys(manifest.files)){
  const relative=artifactPaths[key];if(!relative)throw Error('Unsupported manifest artifact key: '+key)
  files[key]=await read(path.resolve(output,relative),['bundle','program'].includes(key)?runRoot:output)
 }
 if(files.generation_runs){
  const index=JSON.parse(new TextDecoder().decode(files.generation_runs))
  if(!Array.isArray(index.entries))throw Error('Generation index entries unavailable')
  const references=[...index.entries.map((entry:any)=>entry.artifactPath),...(index.nativeSearch?[index.nativeSearch.path]:[])]
  for(const relative of references){
   if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Unsafe linked artifact path')
   linkedFiles[relative]=await read(path.resolve(output,relative),output)
  }
 }
 return {runId:input.runId,bytes,files,linkedFiles,...input.expectedSha?{sha256:input.expectedSha}:{}}
}
