import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {Type} from 'typebox'
import {createAssistantMessageEventStream,getCurrentTools,type AssistantMessage} from '@earendil-works/pi-ai'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchQuestions} from '@autofold/science-core/research-questions'
import {importHistoricalCloseoutFixture} from '../test-support/historical-closeout.fixture'
import {ResearchTrajectoryCloseout} from '@autofold/science-core/trajectory-closeout'
import {ScientificExecution,fileHash} from '../execution'
import {PiJobController,type JobScientist} from '../jobs'
import {LiteratureReviewController} from '../literature'
import {DEFAULT_MODEL,createSessionStore} from '../runtime'
import {CampaignController} from './index'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
function response(name:string|undefined,args:any,cost:number){
 const message:AssistantMessage={role:'assistant',content:name?[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args}]:[{type:'text',text:'Offline fixture interpretation; no biological claim.'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,stopReason:name?'toolUse':'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}}}
 const stream=createAssistantMessageEventStream();stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end(message);return stream
}
test('fresh discovery keeps historical v1 questions advisory and later consumes separately admitted receipt-bound reconciliation',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-knowledge-cycle-'));roots.push(workspace)
 const projectId='knowledge_cycle_offline';let store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
 let dispatches=0
 const {LocalWorkerTransport}=await import('../execution');const local=new LocalWorkerTransport()
 const makeExecution=()=>new ScientificExecution({workspace,projectId,research,transport:{kind:'local',dispatch:async input=>{dispatches++;return local.dispatch(input)}}});let execution=makeExecution()
 const evaluator=(await execution.evaluators())[0]!,campaign=await research.createCampaign(projectId,{objective:'Offline software continuation; no scientific efficacy evidence'})
 await research.activateCampaign(projectId,campaign.id)
 const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Frozen CPU heuristic fixture',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7,11],submissionSize:3}}})
 await research.activateExperiment(projectId,experiment.id)
 const programPath='fixture.py';await fs.writeFile(path.join(workspace,programPath),'raise RuntimeError("Mock worker must not execute authored Python")\n')
 const programHash=await fileHash(path.join(workspace,programPath))
 let completed=0,owner:string|undefined,ownerLease:string|undefined
 async function evaluate(){
  const number=completed+1
  const trial=await research.createTrial(projectId,experiment.id,{hypothesis:'Explicit offline receipt '+number,designAdapter:'mock',programPath,programHash,...(owner?{origin:{jobId:owner,phase:'fixture:'+number}}:{})},owner?{jobId:owner,leaseId:ownerLease!}:undefined)
  const receipt=await execution.evaluateTrial({trialId:trial.id,requestId:'offline-'+number,...(owner?{caller:{jobId:owner,leaseId:ownerLease!}}:{})})
  completed++
  expect(receipt.scientific).toBe(false)
  await ResearchTrajectoryCloseout.run({campaignId:campaign.id,experimentId:experiment.id,sessionId:'ses_fixture_closeout',iteration:number,trialId:trial.id,runId:receipt.run.id,status:'succeeded',score:receipt.evaluation.score},{commit:input=>research.recordTrajectoryObservation(projectId,input),acknowledge:(id,hash)=>research.acknowledgeTrajectoryProjection(projectId,id,hash),project:async()=>{}})
  return receipt
 }
 await evaluate();await evaluate()
 const historical=await importHistoricalCloseoutFixture({workspace,projectId,store},Object.values((await store.read(projectId)).runs).map(run=>run.id));store=historical.store;research=historical.research;execution=makeExecution()
 const initial=await store.read(projectId),originalQuestions=ResearchQuestions.project(Object.values(initial.searchObservations),Object.values(initial.knowledgeCycles),Object.values(initial.researchRequests))
 expect(originalQuestions.length).toBeGreaterThan(0)
 const originalMeasurements=Object.values(initial.knowledge).map(record=>record.id)
 let literatureTurns=0,schemaSeen=false,contextReads=0,assessedContextReads=0,scienceTurns=0,jobTurns=0,jobMaximumEvaluations=0
 const common={workspace,projectId,research,store,execution,sessionDirectory:path.join(workspace,'pi')}
 const literature=new LiteratureReviewController({...common,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:async(_model,context)=>{
  literatureTurns++
  const submit=getCurrentTools(context.messages).find(tool=>tool.name==='submit_review')!
  expect((submit.parameters as any).type).toBe('object');expect((submit.parameters as any).properties.researchRequestUpdates).toBeDefined();schemaSeen=true
  const errors=context.messages.filter((m:any)=>m.role==='toolResult'&&m.isError)
  if(errors.length)throw new Error('Offline scripted proposal rejected: '+JSON.stringify(errors).slice(-3000))
  const results=context.messages.filter((m:any)=>m.role==='toolResult') as any[]
  if(!results.some(m=>m.toolName==='query_knowledge'))return response('query_knowledge',{kinds:['knowledge'],limit:20},.005)
  const state=await store.read(projectId),measurements=Object.values(state.knowledge).map(record=>record.id)
  const read=new Set(results.filter(m=>m.toolName==='read_knowledge').map(m=>m.details.id))
  const next=measurements.find(id=>!read.has(id))
  if(next)return response('read_knowledge',{id:next},.005)
  const questions=ResearchQuestions.project(Object.values(state.searchObservations),Object.values(state.knowledgeCycles),Object.values(state.researchRequests)).filter(q=>q.status==='open')
  return response('submit_review',{sources:[],claims:[],campaignSummary:'Saved fixture measurements answer the bounded computational questions; no physical validation.',unresolvedQuestions:[],researchRequestUpdates:questions.map(q=>({requestId:q.requestId,expectedRevision:q.revision,status:'answered',assessment:'The saved same-contract receipt answers this bounded offline observation question.',remainingGap:'CPU fixture only; scientific and biological efficacy are unproven.',nextAction:'Continue the frozen fixture experiment only under remaining authorization.',sourceKeys:[],evidenceRefs:measurements}))},.005)
 }}})
 const scientistFactory=(options:any):JobScientist=>{
  owner=options.origin.jobId;ownerLease=options.origin.leaseId
  return {initialize:async()=>{jobTurns=0;jobMaximumEvaluations=options.maximumEvaluations},systemPrompt:'Offline scripted scientist: inspect committed assessment before any evaluation',status:async()=>({completedEvaluations:completed,stopped:false,researchRequested:false}),context:async()=>({completed}),tools:()=>[
   {name:'read_context',label:'Context',description:'Read committed scoped state',parameters:Type.Object({}),execute:async()=>{
    const state=await store.read(projectId),questions=ResearchQuestions.project(Object.values(state.searchObservations),Object.values(state.knowledgeCycles),Object.values(state.researchRequests))
    for(const q of originalQuestions)expect(questions.find(current=>current.requestId===q.requestId)?.status).toBe(literatureTurns ? 'answered' : 'open')
    if(literatureTurns)assessedContextReads++
    contextReads++;return{content:[{type:'text',text:'Original questions durably assessed; new inference remains a software fixture.'}],details:{originalAssessed:true}}
   }},
   {name:'evaluate_trial',label:'Evaluate',description:'CPU mock receipt only',parameters:Type.Object({}),execute:async()=>{expect(contextReads).toBeGreaterThan(0);if(completed>=options.maximumEvaluations)throw new Error('Offline fixture job evaluation cap');const r=await evaluate();return{content:[{type:'text',text:'Verified CPU fixture receipt '+r.run.id}],details:{runId:r.run.id}}}},
  ]}
 }
 const jobs=new PiJobController({...common,literature,scientistFactory,runtimeOptions:{streamFn:()=>{scienceTurns++;return response(completed>=jobMaximumEvaluations?undefined:++jobTurns%2===1?'read_context':'evaluate_trial',{},.002)}}})
 const controller=new CampaignController({...common,jobs});jobs.registerHandler('campaign_loop',controller.handleJob)
 const before=await controller.observe(campaign.id);expect(before.knowledge.due).toBe(true)
 const parent=await controller.enqueueCampaign(campaign.id,{idempotencyKey:'typed-internal-cycle',maxSteps:2,maximumTrajectories:4,maximumDiscoveryTrajectories:4,maximumKnowledgeRefreshes:1,discoveryBatchSize:2,modelBudgetUsd:1,perChildModelBudgetUsd:.3})
 const final=await jobs.runOnce({jobId:parent.id})
 expect(final?.status).toBe('succeeded');expect(final?.result).toMatchObject({remainingDiscoveryTrajectories:0,remainingTrajectories:0,knowledgeRefreshes:0})
 const children=(await jobs.list()).filter(job=>job.payload.parentJobId===parent.id)
 const discovery=children.filter(job=>job.payload.kind==='autoresearch'),knowledge=children.filter(job=>job.payload.kind==='knowledge_refresh')
 expect(knowledge).toHaveLength(0);expect(discovery).toHaveLength(2)
 expect(discovery[0]!.payload.sessionId).toBe(discovery[1]!.payload.sessionId)
 expect(discovery.map(child=>child.result?.completedEvaluations)).toEqual([2,2])
 expect(dispatches).toBe(6);expect(completed).toBe(6);expect(contextReads).toBe(4);expect(assessedContextReads).toBe(0);expect(literatureTurns).toBe(0);expect(schemaSeen).toBe(false)
 const separate=await jobs.enqueueLiterature(campaign.id,{idempotencyKey:'separate-internal-reconciliation',focusExperimentId:experiment.id,modelBudgetUsd:.3})
 const reconciled=await jobs.runOnce({jobId:separate.id})
 expect(reconciled?.status).toBe('succeeded');expect(separate.payload.parentJobId).toBeUndefined();expect(schemaSeen).toBe(true)
 const next=await jobs.enqueueDiscovery(experiment.id,{idempotencyKey:'next-independent-batch',iterations:1,modelBudgetUsd:.3})
 expect(next.payload.sessionId).toBe(discovery[0]!.payload.sessionId)
 const continued=await jobs.runOnce({jobId:next.id});expect(continued?.status).toBe('succeeded')
 expect(continued?.result?.completedEvaluations).toBe(1)
 expect(assessedContextReads).toBe(1);expect(contextReads).toBe(5);expect(dispatches).toBe(7);expect(scienceTurns).toBe(13)
 const state=await store.read(projectId);expect(Object.values(state.literature)).toHaveLength(0);expect(Object.values(state.claims)).toHaveLength(0)
 expect(Object.values(state.trials)).toHaveLength(7)
 const finalQuestions=ResearchQuestions.project(Object.values(state.searchObservations),Object.values(state.knowledgeCycles),Object.values(state.researchRequests))
 expect(finalQuestions.some(q=>q.status==='open')).toBe(false)
 expect(finalQuestions.map(q=>q.requestId).sort()).toEqual(originalQuestions.map(q=>q.requestId).sort())
 expect(Object.values(state.searchObservations).filter(item=>item.closeoutVersion===2)).toHaveLength(5)
 expect(Object.values(state.knowledgeCycles).filter(cycle=>/^autofold-trusted-success-closeout/.test(cycle.generated.by))).toHaveLength(2)
 expect((await research.knowledgeRefreshStatus(projectId,campaign.id)).reasons).not.toContain('open_research_questions')
 const sessions=createSessionStore(path.join(common.sessionDirectory,'sessions.sqlite'))
 try{const ids=[String(separate.payload.sessionId),String(discovery[0]!.payload.sessionId)];const actual=(await Promise.all(ids.map(id=>sessions.get(id)))).reduce((sum,s)=>sum+(s?.usage.costUsd??0),0);expect(final!.result!.modelCostUsd).toBeCloseTo(.020,10);expect(Number(final!.result!.modelCostUsd)+Number(reconciled!.result!.modelCostUsd)+Number(continued!.result!.modelCostUsd)).toBeCloseTo(actual,10)}finally{sessions.close()}
 const originalCounter=dispatches
 expect(await jobs.runOnce({jobId:parent.id})).toBeUndefined();expect(dispatches).toBe(originalCounter)
},30000)
