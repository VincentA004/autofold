import {afterEach,expect,spyOn,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ResearchService} from '@autofold/science-core/service'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ScientificExecution} from '../execution'
import {ScientistLane,type ScientistProspectiveCandidate} from './index'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const decisionPlan=()=>({question:'Which bounded program should provide the next observation?',
 alternatives:[{id:'run',experiment:'Run captured program',expectedInformation:'A comparable observation',estimatedGpuHours:0},{id:'inspect',experiment:'Inspect existing evidence',expectedInformation:'Avoid redundant compute',estimatedGpuHours:0}],
 selectedAlternativeId:'run',rationale:'The declaration matches the authored intervention',evidenceRefs:[],
 outcomeBranches:[{observation:'Valid observation',nextDecision:'Compare the frozen score'},{observation:'Invalid observation',nextDecision:'Repair the exact failure'}]})
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'scientist-prospective-'));roots.push(workspace)
 const projectId='prospective_offline',store=new StorageResearchStore({directory:path.join(workspace,'store')}),research=new ResearchService.Service(store)
 const execution=new ScientificExecution({workspace,projectId,research,authorization:{maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1}})
 const evaluator=(await execution.evaluators())[0]!,campaign=await research.createCampaign(projectId,{objective:'Offline prospective admission boundaries'})
 await research.activateCampaign(projectId,campaign.id)
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'CPU-only admission fixture',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7,11],submissionSize:3}}})
 await research.activateExperiment(projectId,experiment.id)
 const options={workspace,projectId,store,research,execution,experimentId:experiment.id,sessionId:'ses_prospective',maximumEvaluations:3}
 const lane=new ScientistLane(options);await lane.initialize();await lane.writeFile({path:'trial.py',content:'# Captured offline program A\n'})
 let plan:any=decisionPlan()
 const descriptor={fixture:'native-descriptor',temperature:0.05}
 const inspect=spyOn(execution,'inspectProgram').mockImplementation(async()=>({authored:{executionProtocol:'native_search_v1',program:{fixture:'offline'},hypothesis:'Unmodified normalized hypothesis',declaration:{intent:'optimize',decisionPlan:plan,evidenceRefs:[]}},nativeExecution:{descriptor},tools:[]} as any))
 return {workspace,projectId,store,research,execution,experiment,options,lane,inspect,descriptor,setPlan:(value:any)=>{plan=value}}
}
async function register(f:Awaited<ReturnType<typeof fixture>>){return JSON.stringify((await f.store.read(f.projectId)).scientistLanes)}

test('prospective rejection sees strict normalized exposure before immutable authoring, trial or branch creation',async()=>{
 const f=await fixture(),seen:ScientistProspectiveCandidate[]=[],lane=new ScientistLane({...f.options,prospectiveAdmission:candidate=>{seen.push(candidate);throw Error('Host requires both baseline receipts')}})
 await lane.initialize()
 const exposure={fixture:'scoped delivered exposure'},exposureSpy=spyOn((lane as any).contextReader,'exposure').mockReturnValue(exposure)
 const stateBefore=JSON.stringify(await f.store.read(f.projectId)),registerBefore=await register(f),dispatch=spyOn(f.execution,'evaluateTrial').mockRejectedValue(Error('No dispatch expected'))
 try{
  expect(await lane.validateTrial({})).toMatchObject({valid:false,error:'Host requires both baseline receipts'})
  await expect(lane.evaluateTrial({requestId:'rejected'})).rejects.toThrow('Host requires both baseline receipts')
  expect(seen.map(candidate=>candidate.phase)).toEqual(['validate','evaluate'])
  expect(seen[0]).not.toHaveProperty('requestId');expect(seen[1]).toMatchObject({requestId:'rejected',iteration:1,programHash:seen[0]!.programHash,generationSeed:seen[0]!.generationSeed,nativeDescriptor:f.descriptor,declaration:{hypothesis:'Unmodified normalized hypothesis',decisionMemoryExposure:exposure}})
  expect(seen[1]).toMatchObject({projectId:f.projectId,experimentId:f.experiment.id,sessionId:f.options.sessionId,contractHash:f.experiment.contractHash,draftPath:lane.root+'/trial.py'})
  expect(exposureSpy).toHaveBeenCalledTimes(2);expect(dispatch).not.toHaveBeenCalled()
  expect(JSON.stringify(await f.store.read(f.projectId))).toBe(stateBefore);expect(await register(f)).toBe(registerBefore)
  expect(await fs.stat(path.join(f.workspace,'.autofold/programs')).then(()=>true,()=>false)).toBe(false)
  expect((await lane.status()).pending).toBeUndefined()
 }finally{exposureSpy.mockRestore();dispatch.mockRestore();f.inspect.mockRestore()}
})

test('host-configured validation uses evaluation methodology while generic exploratory validation remains permissive',async()=>{
 const f=await fixture();f.setPlan(undefined)
 let hookCalls=0
 const lane=new ScientistLane({...f.options,prospectiveAdmission:()=>{hookCalls++}})
 try{
  expect(await f.lane.validateTrial({})).toMatchObject({valid:true})
  expect(await lane.validateTrial({})).toMatchObject({valid:false,error:expect.stringContaining('Declare decision_plan')})
  expect(hookCalls).toBe(0);expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
 }finally{f.inspect.mockRestore()}
})

test('rejected drafts retain the prospective slot and request identity; host callback mutation cannot alter accepted input',async()=>{
 const f=await fixture(),seen:ScientistProspectiveCandidate[]=[];let accept=false
 const lane=new ScientistLane({...f.options,prospectiveAdmission:candidate=>{seen.push(structuredClone(candidate));if(!accept)throw Error('Repair comparator before admission');(candidate.declaration as any).hypothesis='Forged callback mutation';(candidate.nativeDescriptor as any).temperature=999}})
 await lane.initialize()
 const dispatch=spyOn(f.execution,'evaluateTrial').mockRejectedValue(Error('Original accepted effect unresolved'))
 try{
  await expect(lane.evaluateTrial({requestId:'same-id'})).rejects.toThrow('Repair comparator')
  await lane.writeFile({path:'trial.py',content:'# Captured offline program B\n'})
  await expect(lane.evaluateTrial({requestId:'same-id'})).rejects.toThrow('Repair comparator')
  expect(seen[1]!.iteration).toBe(1);expect(seen[1]!.generationSeed).toBe(seen[0]!.generationSeed);expect(seen[1]!.programHash).not.toBe(seen[0]!.programHash)
  expect((await lane.status()).originalIntentAuthority).toMatchObject({requestCount:0})
  accept=true
  await expect(lane.evaluateTrial({requestId:'same-id'})).rejects.toThrow('Original accepted effect unresolved')
  const state=await f.store.read(f.projectId),trial=Object.values(state.trials)[0]!
  expect(Object.values(state.trials)).toHaveLength(1);expect(Object.values(state.runs)).toHaveLength(0)
  expect(trial).toMatchObject({hypothesis:'Unmodified normalized hypothesis',generationSeed:seen[0]!.generationSeed,programHash:seen[1]!.programHash})
  expect(f.descriptor.temperature).toBe(0.05);expect(dispatch).toHaveBeenCalledTimes(1)
  expect((await lane.status()).pending).toMatchObject({requestId:'same-id',iteration:1,trialId:trial.id})
 }finally{dispatch.mockRestore();f.inspect.mockRestore()}
})

test('accepted unresolved identity blocks new candidates before inspection and preserves original resume binding',async()=>{
 const f=await fixture(),candidates:ScientistProspectiveCandidate[]=[],lane=new ScientistLane({...f.options,prospectiveAdmission:candidate=>{candidates.push(candidate)}})
 await lane.initialize()
 const dispatch=spyOn(f.execution,'evaluateTrial').mockRejectedValue(Error('Accepted original awaits receipt'))
 try{
  await expect(lane.evaluateTrial({requestId:'original-accepted'})).rejects.toThrow('awaits receipt')
  const before=JSON.stringify(await f.store.read(f.projectId)),registerBefore=await register(f),originalDispatch=structuredClone(dispatch.mock.calls[0]![0]),inspections=f.inspect.mock.calls.length
  await lane.writeFile({path:'programs/another.py',content:'# A different candidate must not bypass the accepted intent\n'})
  await expect(lane.evaluateTrial({programPath:'programs/another.py',requestId:'replacement'})).rejects.toThrow('original-accepted')
  expect(await lane.validateTrial({programPath:'programs/another.py'})).toMatchObject({valid:false,category:'execution_unresolved',error:expect.stringContaining('original-accepted'),repair:expect.stringContaining('Do not repair its seed')})
  expect(f.inspect).toHaveBeenCalledTimes(inspections);expect(candidates).toHaveLength(1);expect(dispatch).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before);expect(await register(f)).toBe(registerBefore)
  await expect(lane.evaluateTrial({requestId:'original-accepted'})).rejects.toThrow('awaits receipt')
  expect(dispatch).toHaveBeenCalledTimes(2);expect(dispatch.mock.calls[1]![0]).toEqual(originalDispatch);expect(candidates).toHaveLength(1)
  expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(1)
  // The canonical request register also blocks admission if a stale derived pending field is absent.
  delete (lane as any).state.pending
  await expect(lane.evaluateTrial({programPath:'programs/another.py',requestId:'another-new'})).rejects.toThrow('original-accepted')
  expect(f.inspect).toHaveBeenCalledTimes(inspections);expect(dispatch).toHaveBeenCalledTimes(2)
 }finally{dispatch.mockRestore();f.inspect.mockRestore()}
})
