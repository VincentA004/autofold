import {nativeFixtureRoot} from '../execution/native-fixture'
import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createAssistantMessageEventStream,type AssistantMessage,type ToolCall} from '@earendil-works/pi-ai'
import type {StreamFn} from '@earendil-works/pi-agent-core'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchPrograms} from '@autofold/science-core/programs'
import {ScientificExecution,LocalWorkerTransport} from '../execution'
import {PiJobController} from '../jobs'
import {DEFAULT_MODEL} from '../runtime'
import {NativeAcceptanceRunner,runNativeAcceptance} from './index'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const nativeRoot=nativeFixtureRoot,nativePython=path.resolve(import.meta.dir,'../../../../.autofold/envs/proto/bin/python')
const installed=await Promise.all([fs.access(nativePython),fs.access(path.join(nativeRoot,'proto-tools'))]).then(()=>true,()=>false)
async function commit(root:string){const child=Bun.spawn(['git','-C',root,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'});const [exit,text]=await Promise.all([child.exited,new Response(child.stdout).text()]);if(exit)throw new Error('Missing pinned fixture');return text.trim()}
const message=(content:AssistantMessage['content'],reason:AssistantMessage['stopReason']='toolUse'):AssistantMessage=>({role:'assistant',content,api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:reason,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})
const call=(id:string,name:string,args:any={}):ToolCall=>({type:'toolCall',id,name,arguments:args})
function stream(value:AssistantMessage){const output=createAssistantMessageEventStream();output.push({type:'start',partial:value});output.push({type:'done',reason:value.stopReason as 'stop'|'toolUse',message:value});output.end(value);return output}
function program(experimentId:string,evidenceRefs:string[],revised=false){const plan={question:revised?'Does a stronger diversity threshold preserve the locked panel?':'Can the bounded native program construct a locked panel?',alternatives:[{id:'run',experiment:'Run the declared diversity intervention',expectedInformation:'Observe candidate panel',estimatedGpuHours:0},{id:'stop',experiment:'Stop without more compute',expectedInformation:'Conserve authorized resources',estimatedGpuHours:0}],selectedAlternativeId:'run',rationale:'Use the prior trusted outcome to change one declared threshold',evidenceRefs,outcomeBranches:[{observation:'Valid',nextDecision:'Inspect the trusted outcome'},{observation:'Invalid',nextDecision:'Repair from actual feedback'}]}
 const hypothesis=revised?'Higher diversity threshold tests the observed panel':'Baseline native fixture tests the worker boundary'
 return ResearchPrograms.templates().proto.replace('min_diversity=0.4',revised?'min_diversity=0.5':'min_diversity=0.4')+`\nfrom autofold_worker.proto_trial import ProtoTrial\nimport json\ndef build_trial(ctx):\n    return ProtoTrial(program=_build_program(ctx), search=_native_search(ctx), hypothesis=${JSON.stringify(hypothesis)}, decision_plan=json.loads(${JSON.stringify(JSON.stringify(plan))}), evidence_refs=tuple(json.loads(${JSON.stringify(JSON.stringify(evidenceRefs))})))\n`
}
async function fixture(native=false){const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-native-acceptance-'));roots.push(workspace)
 const projectId='acceptance_offline',store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
 let dispatches=0;const local=new LocalWorkerTransport(),proto=native?{root:nativeRoot,python:nativePython,languageCommit:await commit(nativeRoot),toolsCommit:await commit(path.join(nativeRoot,'proto-tools'))}:undefined
 const execution=new ScientificExecution({workspace,projectId,research,proto,inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},authorization:{localProto:native,maximumGpuSeconds:0,maximumCandidates:8,maximumWallTimeMinutes:1},transport:{kind:'local',dispatch:async input=>{dispatches++;return local.dispatch(input)}}})
 const campaign=await research.createCampaign(projectId,{objective:'Offline acceptance report verification'});await research.activateCampaign(projectId,campaign.id)
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'CPU heuristic fixture only',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...(await execution.evaluators())[0]!,fixedSeeds:[7,11],submissionSize:3}}});await research.activateExperiment(projectId,experiment.id)
 const sourcePath=path.join(workspace,'host-execution.json');await fs.writeFile(sourcePath,JSON.stringify({authorization:{localProto:native,maximumGpuSeconds:0},proto}))
 const base={workspace,projectId,store,research,execution,sessionDirectory:path.join(workspace,'pi'),profile:{id:'offline_cpu_fixture',mode:'local' as const,sourcePath}}
 const jobs=new PiJobController(base)
 return{...base,jobs,experiment,campaign,dispatches:()=>dispatches}
}

test('native acceptance rejects mock contracts and false transport profiles before job/model/worker effects',async()=>{
 const f=await fixture()
 await expect(runNativeAcceptance(f,f.experiment.id,{idempotencyKey:'reject-fixture'})).rejects.toThrow('rejects mock')
 expect((await f.jobs.list()).length).toBe(0);expect(f.dispatches()).toBe(0)
 expect(()=>new NativeAcceptanceRunner({...f,profile:{...f.profile,mode:'remote'}})).toThrow('actual execution transport')
})

;(installed?test:test.skip)('offline CPU fixture captures autonomous trace, grounded intervention and exact receipts without claiming native science; reopen has no effects',async()=>{
 const f=await fixture(true);let turns=0
 const streamFn:StreamFn=async()=>{
  const index=turns++
  if(index===0)return stream(message([call('write-first','write',{path:'trial.py',content:program(f.experiment.id,[f.experiment.id])+'\n# first draft\n'}),call('repair-first','edit',{path:'trial.py',edits:[{oldText:'# first draft',newText:'# repaired draft'}]})]))
  if(index===1)return stream(message([call('eval-first','evaluate_trial',{requestId:'acceptance-first'})]))
  if(index===2)return stream(message([call('read-trusted','read_context')]))
  if(index===3){const state=await f.store.read(f.projectId),run=Object.values(state.runs)[0]!,observation=Object.values(state.searchObservations)[0]!
   expect(observation.closeoutVersion).toBe(2);expect(Object.values(state.searchObservations)).toHaveLength(1);expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
   return stream(message([call('write-second','write',{path:'programs/revised.py',content:program(f.experiment.id,[run.id,observation.id],true)})]))}
  if(index===4)return stream(message([call('eval-second','evaluate_trial',{programPath:'programs/revised.py',requestId:'acceptance-second'})]))
  return stream(message([{type:'text',text:'The two verified computational fixture outcomes were inspected.'}],'stop'))
 }
 const jobs=new PiJobController({...f,runtimeOptions:{streamFn}}),deps={...f,jobs,allowFixtureEvidence:true}
 const input={idempotencyKey:'offline-source-bound-two',iterations:2 as const},report=await runNativeAcceptance(deps,f.experiment.id,input)
 expect(report.status).toBe('fixture_only');expect(report.nativeSoftwareAcceptancePassed).toBe(false);expect(report.fullTwoIterationAcceptancePassed).toBe(false)
 expect(report.receipts).toHaveLength(2);expect(report.checks.allReceiptsReverified).toBe(true);expect(report.checks.autonomousPrograms).toBe(true)
 expect(report.checks.trustedCloseoutBeforeFurtherAction).toBe(true);expect(report.checks.groundedNextInterventionOrStop).toBe(true)
 expect(report.methodImprovementEstablished).toBe(false);expect(report.biologicalValidationEstablished).toBe(false);expect(f.dispatches()).toBe(2)
 expect(await Bun.file(path.join(f.workspace,report.paths.transcript)).json()).toMatchObject({id:report.sessionId,modelSelection:report.modelSelection})
 const closeout=await Bun.file(path.join(f.workspace,report.paths.closeout)).json();expect(closeout.cycles).toHaveLength(0);expect(closeout.observations).toHaveLength(2);expect(closeout.events).toHaveLength(2)
 const sources=await Bun.file(path.join(f.workspace,report.paths.sources)).json();expect(sources.initial.files.some((entry:any)=>entry.path==='scientist/index.ts')).toBe(true)
 const before=turns,restored=new PiJobController({...f,runtimeOptions:{streamFn:()=>{throw new Error('No inference on acceptance reopen')}}})
 const reopened=await runNativeAcceptance({...deps,jobs:restored},f.experiment.id,input)
 expect(reopened.jobId).toBe(report.jobId);expect(reopened.checks).toEqual(report.checks);expect(turns).toBe(before);expect(f.dispatches()).toBe(2)
 await fs.appendFile(f.profile.sourcePath,'\n ')
 await expect(runNativeAcceptance({...deps,jobs:restored},f.experiment.id,input)).rejects.toThrow('frozen contract, host profile')
},60000)

;(installed?test:test.skip)('autonomous program provenance rejects unjournaled edits in a model repair chain',async()=>{
 const f=await fixture(true);let turns=0
 const streamFn:StreamFn=async()=>{
  const index=turns++
  if(index===0)return stream(message([call('write-draft','write',{path:'trial.py',content:program(f.experiment.id,[f.experiment.id])+'\n# first draft\n'})]))
  if(index===1){
   await fs.appendFile(path.join(f.workspace,'.autofold/autoresearch',f.experiment.id,'trial.py'),'# unjournaled edit\n')
   return stream(message([call('repair-draft','edit',{path:'trial.py',edits:[{oldText:'# first draft',newText:'# repaired draft'}]})]))
  }
  if(index===2)return stream(message([call('eval-untrusted-chain','evaluate_trial',{requestId:'unjournaled-chain'})]))
  return stream(message([{type:'text',text:'Inspect the saved outcome.'}],'stop'))
 }
 const jobs=new PiJobController({...f,runtimeOptions:{streamFn}})
 const report=await runNativeAcceptance({...f,jobs,allowFixtureEvidence:true},f.experiment.id,{idempotencyKey:'unjournaled-author-chain',iterations:1})
 expect(report.receipts).toHaveLength(1)
 expect(report.receipts[0]!.verifiedLocally).toBe(true)
 expect(report.checks.autonomousPrograms).toBe(false)
 expect(report.receipts[0]!.autonomouslyAuthored).toBe(false)
},60000)
