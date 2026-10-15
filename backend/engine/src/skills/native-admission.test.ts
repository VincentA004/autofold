import {nativeFixtureRoot} from '../execution/native-fixture'
import {afterEach, expect, spyOn, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createAssistantMessageEventStream, type AssistantMessage} from '@earendil-works/pi-ai'
import {ResearchArtifacts} from '@autofold/science-core/artifacts'
import {ResearchService} from '@autofold/science-core/service'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchPrograms} from '@autofold/science-core/programs'
import {ResearchScientistMemory} from '@autofold/science-core/scientist-memory'
import {ResearchWorkflow} from '@autofold/science-core/workflow'
import {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import {ScientificExecution, fileHash} from '../execution'
import {DEFAULT_MODEL} from '../runtime'
import {CampaignSkillService} from './service'
import {ScientistLane} from '../scientist'
import {SkillShadowReplayController} from './controllers'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const protoRoot=nativeFixtureRoot
const python=path.resolve(import.meta.dir,'../../../../.autofold/envs/proto/bin/python')
const installed=await Promise.all([fs.access(python),fs.access(path.join(protoRoot,'proto-tools'))]).then(()=>true,()=>false)
const nativeTest=installed?test:test.skip
async function git(root:string){const p=Bun.spawn(['git','-C',root,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'});const [code,text]=await Promise.all([p.exited,new Response(p.stdout).text()]);if(code)throw new Error(await new Response(p.stderr).text());return text.trim()}
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-native-shadow-'));roots.push(workspace)
 const projectId='native_shadow_offline',store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
 const proto={root:protoRoot,python,languageCommit:await git(protoRoot),toolsCommit:await git(path.join(protoRoot,'proto-tools'))}
 let dispatches=0
 const execution=new ScientificExecution({workspace,projectId,research,proto,inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'},authorization:{localProto:true,maximumGpuSeconds:600},transport:{kind:'local',dispatch:async()=>{dispatches++;throw new Error('Offline admission must never dispatch')}}})
 const evaluator=(await execution.evaluators()).find(e=>e.id==='peptide-panel')!
 const target=await ResearchArtifacts.authorTarget(workspace,{format:'autofold.target-artifact.v1',name:'Offline admission target',chains:[{id:'A',sequence:'ACDEFGHIK'}],bindingSite:{residues:[{chainId:'A',position:1}]}})
 const campaign=await research.createCampaign(projectId,{objective:'Offline admission, no scientific execution'});await research.activateCampaign(projectId,campaign.id)
 const scoringPipeline=ExecutionProtocol.ScoringPipeline.parse({format:'autofold.scoring-pipeline.v1',protoToolsCommit:proto.toolsCommit,stages:[
  {id:'boltz2-score',role:'scoring',models:[{id:'boltz2-prediction',version:proto.toolsCommit,toolKey:'boltz2-prediction',config:{use_msa:false}}],dependsOn:[],budget:{maximumGpuSeconds:120},required:true,allowSkip:false,allowedSkips:[]},
  {id:'chai1-score',role:'scoring',models:[{id:'chai1-prediction',version:proto.toolsCommit,toolKey:'chai1-prediction',config:{use_msa:false}}],dependsOn:['boltz2-score'],budget:{maximumGpuSeconds:180},required:true,allowSkip:false,allowedSkips:[]},
 ]})
 const frozenEvaluator={...evaluator,evidenceAdapter:{...evaluator.evidenceAdapter!,scoringPipeline,scoringPipelineHash:ExecutionProtocol.hashScoringPipeline(scoringPipeline)}}
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Frozen admission check',targetArtifactHash:target.targetArtifactHash,modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:600/3600,wallTimeMinutes:15},evaluator:{...frozenEvaluator,fixedSeeds:[7],submissionSize:1}}});await research.activateExperiment(projectId,experiment.id)
 const options={workspace,projectId,store,research,execution,sessionDirectory:path.join(workspace,'pi')}
 const skills=new CampaignSkillService(options),parent=(await skills.initialize(campaign.id)).find(v=>v.skillId==='skill_bionemo.predictor-interpretation')!
 const markdown=(await fs.readFile(path.join(workspace,parent.path),'utf8')).replace('version: 1','version: 2')+'\nRetain uncertainty until independent comparison.\n'
 const candidate=await skills.propose(campaign.id,parent.skillId,{parentVersionId:parent.id,markdown,trajectoryRefs:[experiment.id],createdBy:'offline-test'})
 return {...options,campaign,experiment,candidate,proto,dispatches:()=>dispatches}
}
function submit(program:string,guidanceApplication?:any){
 const value:AssistantMessage={role:'assistant',content:[{type:'toolCall',id:'offline_write_'+crypto.randomUUID(),name:'write',arguments:{path:'trial.py',content:program}},{type:'toolCall',id:'offline_submit_'+crypto.randomUUID(),name:'submit_trial',arguments:{guidanceApplication}}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
 const s=createAssistantMessageEventStream();s.push({type:'start',partial:value});s.push({type:'done',reason:'toolUse',message:value});s.end(value);return s
}

nativeTest('native replay repairs nested evidence errors and reaches admission with the installed Proto compiler, zero provider/GPU calls',async()=>{
 const f=await fixture();let calls=0,inspections=0,lastInspection:any
 const question='How does independent calibration affect this frozen decision? '+ 'q'.repeat(900)
 const request={action:'create' as const,purpose:'knowledge_lookup' as const,question,competingExplanations:['Calibration generalizes to independent evidence.','The observed calibration is specific to the original fixture.'],requiredEvidence:'Independent attributable calibration under the original frozen contract.',applicabilityChecks:'Same frozen experiment; preserve uncertainty.',decisionIfResolved:'Choose the next justified matched comparison.'}
 const asked=await f.research.requestResearch(f.projectId,f.experiment.id,{request,evidenceRefs:[f.experiment.id],generatedBy:'offline-test'})
 const inspect=f.execution.inspectProgram.bind(f.execution)
 f.execution.inspectProgram=async input=>{inspections++;const result=await inspect(input);lastInspection=result;expect(result.pipeline?.stages.filter(s=>s.role==='scoring').length).toBeGreaterThan(0);expect(ResearchWorkflow.scoringPipelineHash(result.pipeline!)).toBe(f.experiment.contract.evaluator.evidenceAdapter!.scoringPipelineHash!);return result}
 const evaluation=spyOn(f.execution,'evaluateTrial').mockImplementation(async()=>{throw new Error('OFFLINE_ADMISSION_REACHED')})
 const replay=new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:(_model,context)=>{
  calls++;if(calls>3)throw new Error('Unexpected additional authoring call')
  const input=JSON.parse((context.messages.findLast(m=>m.role==='user') as any).content[0].text)
  expect(input.template).toContain('def build_trial(ctx):');expect(input.template).not.toMatch(/^AUTOFOLD_WORKFLOW\s*=/m)
  expect(input.executionCapabilities.host).toBe('local')
  expect(input.decisionMemory.proceduralGuidance).toEqual([])
  expect(input.decisionMemory.sourceManifest.sources.some((source:any)=>source.layer==='guidance')).toBe(false)
  expect(input.evidenceRefs).not.toContain(f.candidate.id)
  expect(JSON.stringify(input.decisionMemory)).not.toContain(f.candidate.contentHash)
  expect(input.evidenceRefs.length).toBeLessThanOrEqual(200)
  expect(input.evidenceRefCount).toBe(input.evidenceRefs.length+input.evidenceRefsOmitted)
  const application={guidanceQuote:input.skill.content.split('\n').find((line:string)=>line.trim().length>=20).trim(),
    programDecision:'Retain the frozen paired control and independently author the native optimizer program.',falsifyingObservation:'No repeated valid paired gain under equal frozen budgets would reject this guidance intervention.'}
  if(calls===2)expect(JSON.stringify(context.messages.filter(m=>m.role==='toolResult'))).toContain('exact excerpt')
  if(calls===3){const errors=JSON.stringify(context.messages.filter(m=>m.role==='toolResult'));expect(errors).toContain('decision_plan');expect(errors).toContain('ProtoTrial.evidence_refs is a separate field')}
  return submit(calls===2?input.template.replace('    "evidenceRefs": EVIDENCE_REFS,\n',''):input.template,
    calls===1?{...application,guidanceQuote:'Invented guidance absent from this supplied skill'}:application)
 }}})
 await expect(replay.run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:f.candidate.id,operationId:'offline-native-admission',repetitions:3})).rejects.toThrow('OFFLINE_ADMISSION_REACHED')
 const state=await f.store.read(f.projectId),trials=Object.values(state.trials)
 expect(calls).toBe(3);expect(inspections).toBe(2);expect(trials).toHaveLength(1);expect(trials[0]!.intent).toBe('shadow_replay');expect(trials[0]!.semanticProgramFingerprint).toBe('sha256:'+new Bun.CryptoHasher('sha256').update(JSON.stringify(lastInspection.authored.nativeSearch?.projection??lastInspection.authored.program)).digest('hex'));expect(trials[0]!.decisionPlan?.evidenceRefs.length).toBeGreaterThan(0)
 expect(Object.values(state.runs)).toHaveLength(0);expect(f.dispatches()).toBe(0);expect(evaluation).toHaveBeenCalledTimes(1);expect(state.skillVersions[f.candidate.id]?.status).toBe('candidate')
 const key=new Bun.CryptoHasher('sha256').update(f.projectId+':shadow:offline-native-admission').digest('hex')
 const saved=JSON.parse(await fs.readFile(path.join(f.workspace,'.autofold/skills/operations',key,'state.json'),'utf8'))
 expect(saved.authoringProtocol).toBe('autofold.native-authoring.v2');expect(saved.scientificInputHash).toMatch(/^sha256:/);expect(saved.context.admissionState.operations).toEqual({});expect(saved.context.admissionState.operationOutbox).toEqual({});expect(saved.context.admissionState.scientistLanes).toEqual({});
 expect(saved.arms['1:parent'].guidanceApplication).toMatchObject({programHash:trials[0]!.programHash,skill:{versionId:saved.context.parent.versionId}})
 expect(saved.context.parent.content).toContain(saved.arms['1:parent'].guidanceApplication.guidanceQuote)
 expect(trials[0]!.decisionMemoryExposure).toMatchObject({snapshotHash:saved.context.decisionMemory.sourceManifest.snapshotHash,sessionId:saved.arms['1:parent'].sessionId})
 const armRoot=path.join(f.workspace,'.autofold/skills/operations',key,'arms/1-parent')
 const manifestFile=path.join(armRoot,saved.context.decisionMemory.sourceManifest.manifestPath)
 expect('sha256:'+new Bun.CryptoHasher('sha256').update(await fs.readFile(manifestFile)).digest('hex')).toBe(saved.context.decisionMemory.sourceManifest.manifestHash)
 const questionFile=path.join(armRoot,saved.context.decisionMemory.expansion.questionsPath),questionBytes=await fs.readFile(questionFile)
 expect(JSON.parse(questionBytes.toString('utf8'))).toContainEqual(expect.objectContaining({requestId:asked.requestId,request:expect.objectContaining({question,competingExplanations:request.competingExplanations})}))
 expect(saved.context.memoryFiles.find((file:any)=>file.name==='QUESTIONS.json').hash).toBe('sha256:'+new Bun.CryptoHasher('sha256').update(questionBytes).digest('hex'))
 evaluation.mockRestore()
},60_000)

nativeTest('native/legacy workflow collision gives actionable removal guidance before any trial or dispatch',async()=>{
 const f=await fixture(),source=ResearchPrograms.nativeProtoTemplate({evidenceRefs:[f.experiment.id],gpuHours:f.experiment.contract.budget.gpuHours})+'\nAUTOFOLD_WORKFLOW = {"format":"autofold.proto-workflow.v1","id":"legacy-empty","maximumGpuSeconds":1,"stages":[]}\n'
 await fs.writeFile(path.join(f.workspace,'trial.py'),source)
 await expect(f.execution.inspectProgram({campaign:f.campaign,experiment:f.experiment,programPath:'trial.py',programHash:await fileHash(path.join(f.workspace,'trial.py'))})).rejects.toThrow('AUTOFOLD_WORKFLOW')
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0);expect(f.dispatches()).toBe(0)
},30_000)

nativeTest('replay host readiness failure occurs before its authoring session or inference',async()=>{
 const f=await fixture();let calls=0
 const execution=new ScientificExecution({...f,proto:{...f.proto,python:path.join(f.workspace,'missing-python')},authorization:{localProto:true,maximumGpuSeconds:600}})
 const replay=new SkillShadowReplayController({...f,execution,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{calls++;throw new Error('No provider call permitted')}}})
 await expect(replay.run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:f.candidate.id,operationId:'offline-missing-host'})).rejects.toThrow('python')
 const state=await f.store.read(f.projectId);expect(calls).toBe(0);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
},30_000)

nativeTest('read-only discovery example constructs with the installed native compiler without a trial or scientific dispatch',async()=>{
 const f=await fixture(),lane=new ScientistLane({...f,experimentId:f.experiment.id,sessionId:'ses_native_example_readonly',maximumEvaluations:0})
 const before=JSON.stringify(await f.store.read(f.projectId)),mutation=spyOn(f.store,'mutate').mockImplementation(async()=>{throw new Error('Read-only context must not create authority')})
 const context=await lane.context(),source=await lane.readFile({path:context.authoring.nativeTemplate,limit:1000})
 expect(mutation).not.toHaveBeenCalled();expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before);mutation.mockRestore()
 expect(source.content).toContain('def build_trial(ctx):');expect(source.content).toContain('intent="optimize"')
 await expect(lane.writeFile({path:context.authoring.nativeTemplate,content:'# overwrite'})).rejects.toThrow('Mutable scientist files')
 const programPath=lane.root+'/'+context.authoring.nativeTemplate
 const inspected=await f.execution.inspectProgram({campaign:f.campaign,experiment:f.experiment,programPath,programHash:await fileHash(path.join(f.workspace,programPath))})
 expect(inspected.authored.declaration.intent).toBe('optimize');expect(inspected.authored.nativeSearch).toBeDefined()
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0);expect(f.dispatches()).toBe(0)
},30_000)

nativeTest('replay freezes the original journal before readiness and excludes events appended during preflight',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void,calls=0
 const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const original=f.execution.preflightExperiment.bind(f.execution)
 const readiness=spyOn(f.execution,'preflightExperiment').mockImplementation(async(...args)=>{entered();await gate;return original(...args)})
 const evaluation=spyOn(f.execution,'evaluateTrial').mockRejectedValue(new Error('FROZEN_JOURNAL_ADMISSION_REACHED'))
 const replay=new SkillShadowReplayController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:(_model,context)=>{
  calls++;const input=JSON.parse((context.messages.findLast(m=>m.role==='user') as any).content[0].text)
  expect(input.decisionMemory.facts).toEqual([])
  expect(JSON.stringify(input)).not.toContain('run_future_during_readiness')
  return submit(input.template,{guidanceQuote:input.skill.content.split('\n').find((line:string)=>line.trim().length>=20).trim(),programDecision:'Apply the original assigned guide within the frozen matched construction scope.',falsifyingObservation:'The original paired outcomes can reject any claimed repeatable gain.'})
 }}})
 const running=replay.run({campaignId:f.campaign.id,experimentId:f.experiment.id,candidateVersionId:f.candidate.id,operationId:'frozen-journal-before-readiness'})
 // Attach the rejection observer before releasing the host readiness gate.
 const completed=running.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try {
  await Promise.race([started,completed.then(result=>{throw result.error??new Error('Replay unexpectedly completed before readiness')})])
  await ResearchScientistMemory.append({campaignId:f.campaign.id,experimentId:f.experiment.id,contractHash:f.experiment.contractHash,iteration:1,
    status:'succeeded',trialId:'trl_future_during_readiness',runId:'run_future_during_readiness',score:.01,decision:'observed'},f.workspace)
  release();expect((await completed).error?.message).toContain('FROZEN_JOURNAL_ADMISSION_REACHED')
  const key=new Bun.CryptoHasher('sha256').update(f.projectId+':shadow:frozen-journal-before-readiness').digest('hex')
  const saved=JSON.parse(await fs.readFile(path.join(f.workspace,'.autofold/skills/operations',key,'state.json'),'utf8'))
  expect(calls).toBe(1);expect(JSON.stringify(saved.context)).not.toContain('run_future_during_readiness')
  expect(saved.context.history.runs).toEqual([]);expect(saved.context.admissionState.runs).toEqual({})
  expect(saved.context.decisionMemory.sourceManifest.snapshotHash).toBe(saved.context.sourceManifest.snapshotHash)
  expect((await ResearchScientistMemory.read(f.workspace,f.experiment.id))[0]!.runId).toBe('run_future_during_readiness')
  expect(f.dispatches()).toBe(0)
 }finally{release();readiness.mockRestore();evaluation.mockRestore()}
},30000)
