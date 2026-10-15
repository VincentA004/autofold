import {afterEach,expect,spyOn,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchPrograms} from '@autofold/science-core/programs'
import {ResearchScientistMemory} from '@autofold/science-core/scientist-memory'
import {ScientificExecution,LocalWorkerTransport} from '../execution'
import {importHistoricalCloseoutFixture} from '../test-support/historical-closeout.fixture'
import {ScientistAuthority} from './authority'
import {ScientistLane} from './index'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
for(const missingJournal of [false,true])test(`historical scientist receipt recovery ${missingJournal?'restores missing original journal once':'preserves existing original journal bytes'} without new science or interpretation`,async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-historical-scientist-'));roots.push(workspace)
 const projectId='historical_scientist_offline',sourceStore=new StorageResearchStore({directory:path.join(workspace,'fresh-source')})
 const sourceResearch=new ResearchService.Service(sourceStore),local=new LocalWorkerTransport();let dispatches=0
 const transport={kind:'local' as const,dispatch:async(input:Parameters<LocalWorkerTransport['dispatch']>[0])=>{if(++dispatches>1)throw new Error('Original receipt recovery cannot redispatch');return local.dispatch(input)}}
 const sourceExecution=new ScientificExecution({workspace,projectId,research:sourceResearch,transport})
 const evaluator=(await sourceExecution.evaluators())[0]!,campaign=await sourceResearch.createCampaign(projectId,{objective:'Historical CPU receipt compatibility'})
 await sourceResearch.activateCampaign(projectId,campaign.id)
 const experiment=await sourceResearch.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Original immutable CPU fixture',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:3,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7],submissionSize:2}}});await sourceResearch.activateExperiment(projectId,experiment.id)
 const sessionId='ses_historical_scientist',requestId='original-historical-request',sourceOptions={workspace,projectId,experimentId:experiment.id,sessionId,store:sourceStore,research:sourceResearch,execution:sourceExecution,maximumEvaluations:1}
 const sourceLane=new ScientistLane(sourceOptions);await sourceLane.initialize()
 const program='"""Original mock fixture bytes; no authored Python executes."""\n'
 const captured=await sourceLane.writeFile({path:'trial.py',content:program})
 const authored=await ResearchPrograms.author(workspace,{hypothesis:'Original historical scientific question',program,intent:'optimize',designAdapter:'mock'})
 const input={hypothesis:'Original historical scientific question',intent:'optimize' as const,designAdapter:'mock' as const,...authored,
  semanticProgramFingerprint:'sha256:'+hash(program),workflowFingerprint:'sha256:'+hash('original-offline-mock-workflow'),
  origin:{jobId:'job_scientist_'+hash(sessionId),phase:'scientist:evaluation:'+hash(requestId)+':trial'}}
 const trial=await sourceResearch.createTrial(projectId,experiment.id,input)
 const authority=new ScientistAuthority(sourceOptions),state=(await authority.read())!
 await authority.save({...state,requests:{[hash(requestId)]:{requestId,programHash:authored.programHash,programPath:authored.programPath,draftPath:captured.path,iteration:1,input,trialId:trial.id,phase:'dispatched'}},pending:{trialId:trial.id,requestId,programHash:authored.programHash,programPath:authored.programPath,iteration:1}})
 const receipt=await sourceExecution.evaluateTrial({trialId:trial.id,requestId});expect(dispatches).toBe(1)
 const sourceSnapshot=JSON.stringify(await sourceStore.read(projectId))
 const historical=await importHistoricalCloseoutFixture({workspace,projectId,store:sourceStore},[receipt.run.id])
 expect(JSON.stringify(await sourceStore.read(projectId))).toBe(sourceSnapshot)
 const journal=ResearchScientistMemory.eventLogPath(workspace,experiment.id),originalBytes=await fs.readFile(journal)
 if(missingJournal)await fs.rm(journal)
 const before=await historical.store.read(projectId),originalFacts=JSON.stringify({runs:before.runs,evaluations:before.evaluations,knowledge:before.knowledge,cycles:before.knowledgeCycles,observations:before.searchObservations})
 const execution=new ScientificExecution({workspace,projectId,research:historical.research,transport})
 const noSemanticWrites=spyOn(historical.research,'ingestLiteratureReview').mockImplementation(async()=>{throw new Error('Historical receipt recovery cannot synthesize a new cycle')})
 try{
  const options={...sourceOptions,...historical,execution}
  const recovered=new ScientistLane(options);await recovered.initialize()
  expect((await recovered.status()).completedEvaluations).toBe(1)
  const events=await ResearchScientistMemory.read(workspace,experiment.id)
  expect(events).toHaveLength(1);expect(events[0]?.runId).toBe(receipt.run.id)
  if(!missingJournal)expect(await fs.readFile(journal)).toEqual(originalBytes)
  const repairedBytes=await fs.readFile(journal)
  const repeated=new ScientistLane(options);await repeated.initialize()
  const response=await repeated.evaluateTrial({requestId})
  expect(response).toMatchObject({status:'succeeded',runId:receipt.run.id,closeoutVersion:1})
  expect(await fs.readFile(journal)).toEqual(repairedBytes)
  expect(dispatches).toBe(1);expect(noSemanticWrites).not.toHaveBeenCalled()
  const after=await historical.store.read(projectId)
  expect(JSON.stringify({runs:after.runs,evaluations:after.evaluations,knowledge:after.knowledge,cycles:after.knowledgeCycles,observations:after.searchObservations})).toBe(originalFacts)
  expect(Object.values(after.searchObservations)).toHaveLength(1);expect(Object.values(after.knowledgeCycles)).toHaveLength(1)
 }finally{noSemanticWrites.mockRestore()}
},30000)
