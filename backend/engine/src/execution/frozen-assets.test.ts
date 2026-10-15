import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {freezeAssets,assertFrozenAssets} from './frozen-assets'
import {ScientificExecution,LocalWorkerTransport,ReceiptUnresolvedError,fileHash} from './index'
import {ResearchService} from '@autofold/science-core/service'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchPrograms} from '@autofold/science-core/programs'
import {nativeFixtureRoot} from './native-fixture'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const hash=(s:string)=>'sha256:'+crypto.createHash('sha256').update(s).digest('hex')
const binding='/projection/0/stages/0/constraints/0/config/reference'
const bytes='ATOM      1  N   ALA B   1      1.000  2.000  3.000  \nEND\n'

test('host asset authority rejects whitespace changes, malformed native pointers, duplicate identities and changed source',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'frozen-assets-'));roots.push(workspace);await fs.writeFile(path.join(workspace,'reference.pdb'),bytes)
 const spec={experimentId:'exp_current',id:'reference',path:'reference.pdb',contentHash:hash(bytes),nativeBindings:[binding]}
 const assets=await freezeAssets(workspace,'exp_current',[spec]);const descriptor={projection:[{stages:[{constraints:[{config:{reference:bytes}}]}]}]}
 expect(()=>assertFrozenAssets(assets,descriptor)).not.toThrow()
 expect(await freezeAssets(workspace,'exp_other',[spec])).toBeUndefined()
 descriptor.projection[0]!.stages[0]!.constraints[0]!.config.reference=bytes.replace(/ +\n/g,'\n')
 expect(()=>assertFrozenAssets(assets,descriptor)).toThrow('native input bytes differ')
 expect(()=>assertFrozenAssets([{...assets![0]!,contentBase64:Buffer.from('changed').toString('base64')}],descriptor)).toThrow('bundled bytes changed')
 expect(()=>assertFrozenAssets([{...assets![0]!,nativeBindings:['/projection/~2']}],descriptor)).toThrow('Invalid frozen asset')
 expect(()=>assertFrozenAssets([...assets!,...assets!],descriptor)).toThrow('unique')
 await fs.writeFile(path.join(workspace,'reference.pdb'),'changed')
 await expect(freezeAssets(workspace,'exp_current',[spec])).rejects.toThrow('source bytes changed')
})

async function fixture(mutate=false){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'native-frozen-assets-'));roots.push(workspace)
 const projectId='asset_test';const store=new StorageResearchStore({directory:path.join(workspace,'research')});const research=new ResearchService.Service(store);const evaluator=(await new ScientificExecution({workspace,projectId,research}).evaluators())[0]!
 const campaign=await research.createCampaign(projectId,{objective:'Offline CPU asset byte plumbing'});await research.activateCampaign(projectId,campaign.id)
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Asset plumbing only',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:2,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7],submissionSize:1}}});await research.activateExperiment(projectId,experiment.id)
 await fs.writeFile(path.join(workspace,'reference.pdb'),bytes)
 let source=ResearchPrograms.nativeProtoTemplate({hypothesis:'Exact reference plumbing',intent:'optimize'})
 source=source.replace('def _build_program(ctx, *, seed=None):',`def reference_constraint(inputs, config):\n    return protein_diversity_constraint(inputs, ProteinDiversityConfig(min_diversity=0.4))\n\ndef _build_program(ctx, *, seed=None):`)
 source=source.replace('function=protein_diversity_constraint,\n        function_config=ProteinDiversityConfig(min_diversity=0.4)',`function=reference_constraint,\n        function_config={"reference":ctx.read_asset("reference").decode("utf-8")${mutate?'.replace("  \\n", "\\n")':''}}`)
 const program=await ResearchPrograms.author(workspace,{hypothesis:'Exact reference plumbing',designAdapter:'proto',program:source})
 const commit=async(directory:string)=>(await Bun.$`git -C ${directory} rev-parse HEAD`.text()).trim()
 let nativeChecks=0;const local=new LocalWorkerTransport();let dispatches=0
 const options={workspace,projectId,research,proto:{root:nativeFixtureRoot,python:path.resolve(import.meta.dir,'../../../../.autofold/envs/proto/bin/python'),languageCommit:await commit(nativeFixtureRoot),toolsCommit:await commit(path.join(nativeFixtureRoot,'proto-tools'))},inspectionBoundary:{containment:async(command:string[])=>command,containmentName:'trusted_offline_cpu_fixture'},authorization:{localProto:true,maximumGpuSeconds:0,authorizeNative:({descriptor}:any)=>{nativeChecks++;expect(descriptor.projection[0].stages[0].constraints[0].config.reference).toBe(bytes)}},frozenAssets:[{experimentId:experiment.id,id:'reference',path:'reference.pdb',contentHash:hash(bytes),nativeBindings:[binding]}],transport:{kind:'local' as const,dispatch:async(input:any)=>{dispatches++;return local.dispatch(input)}}}
 return {workspace,projectId,research,store,campaign,experiment,program,options,execution:new ScientificExecution(options),counts:()=>({dispatches,nativeChecks})}
}

test('actual native authoring rejects a copied whitespace-damaged input before trial/run/transport',async()=>{
 const f=await fixture(true)
 await expect(f.execution.inspectProgram({...f,programPath:f.program.programPath,programHash:f.program.programHash})).rejects.toThrow('native input bytes differ')
 expect(f.counts()).toEqual({dispatches:0,nativeChecks:0});expect(Object.keys((await f.store.read(f.projectId)).trials)).toHaveLength(0);expect(Object.keys((await f.store.read(f.projectId)).runs)).toHaveLength(0)
},60000)

test('changed host asset after successful inspection cannot create a run or dispatch',async()=>{
 const f=await fixture();const admitted=await f.execution.inspectProgram({...f,programPath:f.program.programPath,programHash:f.program.programHash})
 const trial=await f.research.createTrial(f.projectId,f.experiment.id,{...f.program,...admitted.authored.declaration,hypothesis:'Exact reference plumbing',designAdapter:'proto',executionProtocol:admitted.authored.executionProtocol})
 await fs.writeFile(path.join(f.workspace,'reference.pdb'),bytes.replace(/ +\n/g,'\n'))
 await expect(f.execution.evaluateTrial({trialId:trial.id,requestId:'changed-source-no-launch'})).rejects.toThrow('source bytes changed')
 expect(f.counts().dispatches).toBe(0);expect(Object.keys((await f.store.read(f.projectId)).runs)).toHaveLength(0)
},60000)

test('actual native CPU execution reads bundled bytes, snapshots them, and reopens after original source disappears without dispatch',async()=>{
 const f=await fixture();const admitted=await f.execution.inspectProgram({...f,programPath:f.program.programPath,programHash:f.program.programHash});const trial=await f.research.createTrial(f.projectId,f.experiment.id,{...f.program,...admitted.authored.declaration,hypothesis:'Exact reference plumbing',designAdapter:'proto',executionProtocol:admitted.authored.executionProtocol})
 const input={trialId:trial.id,requestId:'exact-asset-once'};const receipt=await f.execution.evaluateTrial(input);expect(receipt.run.status).toBe('succeeded');expect(f.counts().dispatches).toBe(1);expect(f.counts().nativeChecks).toBeGreaterThanOrEqual(3)
 const bundlePath=path.join(f.workspace,receipt.run.bundlePath);const bundle=await Bun.file(bundlePath).json();expect(Buffer.from(bundle.frozenAssets[0].contentBase64,'base64').toString()).toBe(bytes)
 await fs.rm(path.join(f.workspace,'reference.pdb'))
 const forbid=async():Promise<never>=>{throw Error('No new launch on reopen')};const reopened=new ScientificExecution({workspace:f.workspace,projectId:f.projectId,research:f.research,transport:{kind:'local',dispatch:forbid,reconcile:forbid}})
 expect((await reopened.evaluateTrial(input)).run.id).toBe(receipt.run.id);expect((await reopened.artifacts(receipt.run.id)).run.id).toBe(receipt.run.id)
},60000)
