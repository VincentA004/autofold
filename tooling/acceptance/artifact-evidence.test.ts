import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {collectManifestEvidence} from './artifact-evidence'

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-artifact-collector-')),workspace=path.join(root,'workspace'),output=path.join(workspace,'run/output')
 await fs.mkdir(path.join(output,'generation-runs'),{recursive:true})
 const encode=(value:unknown)=>JSON.stringify(value),hash=(value:string)=>'sha256:'+createHash('sha256').update(value).digest('hex')
 const linked=encode({generation:'native'}),index=encode({runId:'run_fixture',entries:[{artifactPath:'generation-runs/draw.json',artifactHash:hash(linked)}]})
 const files={result:encode({runId:'run_fixture',valid:true}),candidates:encode(['native']),generation_runs:index}
 await fs.writeFile(path.join(output,'result.json'),files.result);await fs.writeFile(path.join(output,'candidates.json'),files.candidates);await fs.writeFile(path.join(output,'generation-runs/index.json'),index);await fs.writeFile(path.join(output,'generation-runs/draw.json'),linked)
 await fs.writeFile(path.join(output,'manifest.json'),encode({runId:'run_fixture',trialId:'trial_fixture',files:Object.fromEntries(Object.entries(files).map(([key,bytes])=>[key,hash(bytes)]))}))
 return {root,workspace,output,input:{runId:'run_fixture',workspace,outputPath:'run/output'}}
}
test('artifact collector reads independently bound scientific files and generation links',async()=>{
 const f=await fixture();try{const result=await collectManifestEvidence(f.input);expect(Object.keys(result.files!).sort()).toEqual(['candidates','generation_runs','result']);expect(Object.keys(result.linkedFiles!)).toEqual(['generation-runs/draw.json']);expect(new TextDecoder().decode(result.files!.result)).toContain('"valid":true')}finally{await fs.rm(f.root,{recursive:true,force:true})}
})
test('artifact collector rejects a missing scientific result file',async()=>{
 const f=await fixture();try{await fs.rm(path.join(f.output,'result.json'));await expect(collectManifestEvidence(f.input)).rejects.toThrow('ENOENT')}finally{await fs.rm(f.root,{recursive:true,force:true})}
})
test('artifact collector rejects linked path traversal and escaping symlinks',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.root,'outside-secret'),'private fixture')
  await fs.writeFile(path.join(f.output,'generation-runs/index.json'),JSON.stringify({entries:[{artifactPath:'../../../outside-secret'}]}))
  await expect(collectManifestEvidence(f.input)).rejects.toThrow('Unsafe linked artifact path')
  await fs.writeFile(path.join(f.output,'generation-runs/index.json'),JSON.stringify({entries:[{artifactPath:'generation-runs/escape'}]}));await fs.symlink(path.join(f.root,'outside-secret'),path.join(f.output,'generation-runs/escape'))
  await expect(collectManifestEvidence(f.input)).rejects.toThrow('escapes its permitted root')
 }finally{await fs.rm(f.root,{recursive:true,force:true})}
})
test('artifact collector rejects a substituted manifest scientific identity',async()=>{
 const f=await fixture();try{const target=path.join(f.output,'manifest.json'),manifest=JSON.parse(await fs.readFile(target,'utf8'));manifest.runId='run_other';await fs.writeFile(target,JSON.stringify(manifest));await expect(collectManifestEvidence(f.input)).rejects.toThrow('Manifest identity')}finally{await fs.rm(f.root,{recursive:true,force:true})}
})
