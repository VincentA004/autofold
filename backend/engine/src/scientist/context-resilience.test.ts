import {afterEach,expect,spyOn,test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {ResearchService} from '@autofold/science-core/service'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchArtifacts} from '@autofold/science-core/artifacts'
import {ScientistLane} from './index'
import {ScientificExecution} from '../execution'
import type {FrozenAssetInput} from '../execution/frozen-assets'
import {HostCapabilitiesUnavailableError} from '../execution/capabilities'
import {PiRuntime,MemorySessionStore,DEFAULT_MODEL} from '../runtime'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'scientist-context-resilience-'));roots.push(workspace)
 const projectId='context_resilience_offline',store=new StorageResearchStore({directory:path.join(workspace,'store')}),research=new ResearchService.Service(store),frozenAssets:FrozenAssetInput[]=[]
 const execution=new ScientificExecution({workspace,projectId,research,frozenAssets,authorization:{localProto:false,maximumGpuSeconds:0,maximumCandidates:1,maximumWallTimeMinutes:1}})
 const target=await ResearchArtifacts.authorTarget(workspace,{format:'autofold.target-artifact.v1',name:'Verified context target',chains:[{id:'A',sequence:'AC'}],bindingSite:{residues:[{chainId:'A',position:2}]}})
 const evaluator=(await execution.evaluators())[0]!,campaign=await research.createCampaign(projectId,{objective:'Offline trusted context resilience'});await research.activateCampaign(projectId,campaign.id)
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Return trusted context without optional host metadata',targetArtifactHash:target.targetArtifactHash,modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7],submissionSize:1}}});await research.activateExperiment(projectId,experiment.id)
 const relative='references/frozen/bootstrap.txt',bytes=Buffer.from('Exact host asset 原始🧬\n');await fs.mkdir(path.dirname(path.join(workspace,relative)),{recursive:true});await fs.writeFile(path.join(workspace,relative),bytes,{mode:0o400})
 frozenAssets.push({experimentId:experiment.id,id:'bootstrap',path:relative,contentHash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),nativeBindings:['/projection/0/asset']})
 const options={workspace,projectId,store,research,execution,experimentId:experiment.id,sessionId:'ses_context_resilience',maximumEvaluations:1,allowCompute:false},lane=new ScientistLane(options);await lane.initialize()
 return {workspace,projectId,store,execution,experiment,lane,options,frozenAssets}
}
const answer=(content:AssistantMessage['content'],reason:AssistantMessage['stopReason']='stop')=>{
 const message:AssistantMessage={role:'assistant',content,stopReason:reason,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
 const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:reason as 'stop'|'toolUse',message});stream.end(message);return stream
}
test('optional registry and capability failures preserve trusted context and full memory delivery while validation stays closed',async()=>{
 const f=await fixture(),healthy=await f.lane.context(),registryPath=path.join(f.workspace,f.lane.root,'MODEL_REGISTRY.json'),registryBefore=await fs.readFile(registryPath),stateBefore=await f.store.read(f.projectId)
 const registry=spyOn(f.execution,'modelRegistry').mockRejectedValue(new Error('OpenBLAS resource failure '+ '🧬'.repeat(2000))),capabilities=spyOn(f.execution,'capabilities').mockRejectedValue(new HostCapabilitiesUnavailableError('Host runtime cannot be inspected')),inspection=spyOn(f.execution,'inspectProgram').mockRejectedValue(new HostCapabilitiesUnavailableError('Actual validator host preflight unavailable'))
 try{
  const context=await f.lane.context()
  expect(context.experiment).toEqual(healthy.experiment);expect(context.campaign).toEqual(healthy.campaign);expect(context.frozenAssets).toEqual(healthy.frozenAssets);expect(context.decisionMemory.sourceManifest.scope).toEqual(healthy.decisionMemory.sourceManifest.scope)
  expect(context.evidenceRefs).toContain(f.experiment.id);expect(context.budgets).toEqual(healthy.budgets)
  expect(context.modelRegistry).toMatchObject({inventoryStatus:'unavailable',entryCount:null,entries:[]});expect(context.executionCapabilities).toMatchObject({inventoryStatus:'unavailable',runtime:[],generators:[],registeredGenerators:[]})
  expect(context.hostConfigurationGaps.map(gap=>gap.source)).toEqual(['model_registry','execution_capabilities']);expect(context.hostConfigurationGaps.every(gap=>gap.category==='host_configuration'&&gap.status==='unavailable'&&Array.from(gap.error).length<=800)).toBe(true);expect(context.hostConfigurationGaps[0]!.errorTruncated).toBe(true)
  expect(await fs.readFile(registryPath)).toEqual(registryBefore)
  let requests=0
  const runtime=new PiRuntime({store:new MemorySessionStore(),tools:[f.lane.tools().find(tool=>tool.name==='read_context')!],streamFn:(_model,input)=>{
   if(requests++===0)return answer([{type:'toolCall',id:'trusted_context',name:'read_context',arguments:{}}],'toolUse')
   const result=input.messages.findLast(message=>message.role==='toolResult')!;if(result.role!=='toolResult')throw Error('Context receipt absent');expect(result.isError).toBe(false)
   const delivered=JSON.parse((result.content[0] as {text:string}).text);expect(delivered.experiment.id).toBe(f.experiment.id);expect(delivered.hostConfigurationGaps).toHaveLength(2);expect(delivered.decisionMemory.sourceManifest.scope.experimentId).toBe(f.experiment.id);expect(delivered.frozenAssets).toEqual(healthy.frozenAssets)
   return answer([{type:'text',text:'Trusted setup is available; unavailable metadata has not admitted scientific work.'}])
  }})
  const session=await runtime.create(),result=await runtime.run(session.id,'Read trusted context through the actual tool boundary');expect(result.status).toBe('completed');expect(result.error).toBeUndefined();expect(requests).toBe(2)
  expect((f.lane as any).contextReader.exposure({})).toBeDefined()
  await f.lane.writeFile({path:'trial.py',content:'# Explicit offline authored draft; no execution\n'})
  expect(await f.lane.validateTrial({})).toMatchObject({valid:false,category:'host_configuration',error:'Actual validator host preflight unavailable'})
  const after=await f.store.read(f.projectId);expect(after.trials).toEqual(stateBefore.trials);expect(after.runs).toEqual(stateBefore.runs);expect(after.evaluations).toEqual(stateBefore.evaluations);expect(after.jobs).toEqual(stateBefore.jobs)
 }finally{registry.mockRestore();capabilities.mockRestore();inspection.mockRestore()}
})
test('metadata and capabilities degrade independently and recovered context clears gaps',async()=>{
 const f=await fixture(),healthy=await f.lane.context(),capabilities=spyOn(f.execution,'capabilities').mockRejectedValue(new Error('Optional capability request failed'))
 try{const context=await f.lane.context();expect(context.modelRegistry.inventoryStatus).toBe('available');expect(context.executionCapabilities.inventoryStatus).toBe('unavailable');expect(context.hostConfigurationGaps.map(gap=>gap.source)).toEqual(['execution_capabilities'])}finally{capabilities.mockRestore()}
 const registry=spyOn(f.execution,'modelRegistry').mockRejectedValue(new Error('Optional metadata request failed'))
 try{const context=await f.lane.context();expect(context.modelRegistry.inventoryStatus).toBe('unavailable');expect(context.executionCapabilities.inventoryStatus).toBe('available');expect(context.hostConfigurationGaps.map(gap=>gap.source)).toEqual(['model_registry'])}finally{registry.mockRestore()}
 const recovered=await new ScientistLane(f.options).context();expect(recovered.hostConfigurationGaps).toEqual([]);expect(recovered.modelRegistry.inventoryStatus).toBe('available');expect(recovered.modelRegistry.entries).toEqual(healthy.modelRegistry.entries)
})
test('metadata resilience never masks frozen target or asset integrity failures or owner cancellation',async()=>{
 const f=await fixture(),registry=spyOn(f.execution,'modelRegistry').mockRejectedValue(new Error('Optional metadata unavailable'))
 try{
  await fs.chmod(path.join(f.workspace,f.frozenAssets[0]!.path),0o600);await fs.writeFile(path.join(f.workspace,f.frozenAssets[0]!.path),'changed asset bytes')
  await expect(f.lane.context()).rejects.toThrow('Frozen asset bootstrap source bytes changed');expect(registry).not.toHaveBeenCalled()
 }finally{registry.mockRestore()}
 const targetFixture=await fixture(),targetPath=path.join(targetFixture.workspace,targetFixture.lane.root,'references/frozen-target/target.json');await fs.chmod(targetPath,0o600);await fs.writeFile(targetPath,'{}')
 await expect(targetFixture.lane.context()).rejects.toThrow('Frozen target reference hash changed')
 const cancelled=await fixture(),metadata=spyOn(cancelled.execution,'modelRegistry'),lane=new ScientistLane({...cancelled.options,lifecycle:{checkCancelled:async()=>{throw Error('Original context owner cancelled')}} as any})
 try{await expect(lane.context()).rejects.toThrow('Original context owner cancelled');expect(metadata).not.toHaveBeenCalled()}finally{metadata.mockRestore()}
})
