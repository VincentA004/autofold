import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'

export type CancellationArtifactSnapshot={runId:string;trialId:string;bundle:Uint8Array;program:Uint8Array;partialInventory:Array<{path:string;sha256:string;byteLength:number}>;partialCopies:Record<string,Uint8Array>}
const contained=(root:string,file:string)=>file===root||file.startsWith(root+path.sep)
const digest=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex')
/** Copies facts observed outside the engine. A cancelled effect need not invent
 * a successful manifest; already observed partial bytes still remain evidence. */
export async function collectCancellationSnapshot(input:{runId:string;trialId:string;workspace:string;outputPath:string}):Promise<CancellationArtifactSnapshot>{
 const workspace=await fs.realpath(input.workspace),logicalOutput=path.resolve(workspace,input.outputPath),runRoot=await fs.realpath(path.dirname(logicalOutput)),requestedOutput=path.join(runRoot,path.basename(logicalOutput))
 if(!contained(workspace,runRoot)||!contained(workspace,requestedOutput))throw Error('Cancellation artifact path escapes the disposable workspace')
 async function read(file:string,root:string){const real=await fs.realpath(file);if(!contained(root,real))throw Error('Cancellation artifact symlink escapes its permitted root');const stat=await fs.stat(real);if(!stat.isFile())throw Error('Cancellation artifact is not a regular file');return new Uint8Array(await fs.readFile(real))}
 const bundle=await read(path.join(runRoot,'bundle.json'),runRoot),program=await read(path.join(runRoot,'trial.py'),runRoot),identity=JSON.parse(new TextDecoder().decode(bundle))
 if(identity.runId!==input.runId||identity.trialId!==input.trialId||identity.programHash!==digest(program))throw Error('Cancellation frozen input identity or program hash differs')
 const partialInventory:CancellationArtifactSnapshot['partialInventory']=[],partialCopies:Record<string,Uint8Array>={}
 let output:string
 try{output=await fs.realpath(requestedOutput)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {runId:input.runId,trialId:input.trialId,bundle,program,partialInventory,partialCopies};throw error}
 if(!contained(workspace,output)||!contained(runRoot,output))throw Error('Cancellation output symlink escapes its permitted root')
 async function walk(directory:string){
  for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Cancellation partial output contains a symlink');if(entry.isDirectory()){await walk(file);continue}if(!entry.isFile())throw Error('Cancellation partial output contains a non-file entry');const bytes=await read(file,output),relative=path.relative(output,file).split(path.sep).join('/');partialInventory.push({path:relative,sha256:digest(bytes),byteLength:bytes.byteLength});partialCopies[relative]=bytes}
 }
 await walk(output)
 return {runId:input.runId,trialId:input.trialId,bundle,program,partialInventory,partialCopies}
}
