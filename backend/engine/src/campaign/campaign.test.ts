import {afterEach, expect, spyOn, test} from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {Type} from 'typebox'
import {createAssistantMessageEventStream, getCurrentTools, type JsonObject, type AssistantMessage,type ToolCall} from '@earendil-works/pi-ai'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchDomain} from '@autofold/science-core/domain'
import {ScientificExecution} from '../execution'
import {JobInterrupted} from '../jobs/lease'
import {PiJobController, type PiJobControllerOptions, type JobScientist} from '../jobs'
import {DEFAULT_MODEL} from '../runtime'
import {CampaignController, type CampaignControllerOptions, CampaignPolicy, directActiveExperimentProposal, materialObservationFingerprint} from './index'
const roots: string[] = []
afterEach(async()=>{for(const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true})})
const digest=(c:string)=>`sha256:${c.repeat(64)}`
const authoredToolCalls=(name:string,args:JsonObject):ToolCall[]=>{
 const {program,...submission}=args
 return name==='submit_trial'&&typeof program==='string'?
  [{type:'toolCall',id:'write_'+crypto.randomUUID(),name:'write',arguments:{path:'trial.py',content:program}},{type:'toolCall',id:'submit_'+crypto.randomUUID(),name,arguments:submission}]:
  [{type:'toolCall',id:name+'_'+crypto.randomUUID(),name,arguments:args}]
}
const stream=(tool:boolean,name='evaluate_trial',args:JsonObject={})=>{
 const value:AssistantMessage={role:'assistant',content:tool?authoredToolCalls(name,args):[{type:'text',text:'Committed fixture outcome inspected.'}],
  api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:tool?'toolUse':'stop',
  usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
 const output=createAssistantMessageEventStream();output.push({type:'start',partial:value});output.push({type:'done',reason:tool?'toolUse':'stop',message:value});output.end(value);return output
}

/** Canonical, receipt-bound failed software outcome; no worker or model is invoked. */
async function settledStopEvidence(f:{projectId:string;research:ResearchService.Service;experiment:{id:string}}){
 const trial=await f.research.createTrial(f.projectId,f.experiment.id,{hypothesis:'Offline settled failure fixture',designAdapter:'mock',programPath:'fixture.py',programHash:'sha256:'+'b'.repeat(64)})
 const run=await f.research.beginRun(f.projectId,trial.id,{bundlePath:'fixture/bundle.json',outputPath:'fixture/output'})
 await f.research.failRun(f.projectId,run.id,'Verified offline fixture outcome',undefined,{failureReceiptHash:'sha256:'+'f'.repeat(64)})
 return run.id
}

async function fixture(propose?:CampaignControllerOptions['propose'], jobExtra:Partial<PiJobControllerOptions>={}) {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-pi-campaign-'));roots.push(workspace)
 const projectId='campaign_offline',store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
 const execution=new ScientificExecution({workspace,projectId,research}),campaign=await research.createCampaign(projectId,{objective:'Bounded offline campaign acceptance'})
 await research.activateCampaign(projectId,campaign.id)
 const evaluator=(await execution.evaluators())[0]!,contract:ResearchDomain.ExperimentContract={version:1,objective:'Plumbing only',targetArtifactHash:digest('a'),modality:'short_peptide',budget:{maximumCandidates:8,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[7,11],submissionSize:3}}
 const experiment=await research.createExperiment(projectId,campaign.id,{contract});await research.activateExperiment(projectId,experiment.id)
 let evaluations=0,turns=0,maximumEvaluations=0
 const scientistFactory:NonNullable<PiJobControllerOptions["scientistFactory"]>=options=>({initialize:async()=>{maximumEvaluations=options.maximumEvaluations},status:async()=>({completedEvaluations:evaluations,stopped:false,researchRequested:false}),context:async()=>({evaluations}),systemPrompt:'Offline campaign scientist fixture',
 tools:()=>[{name:'evaluate_trial',label:'Fixture evaluation',description:'Offline software fixture only',parameters:Type.Object({}),execute:async()=>{evaluations++;return{content:[{type:'text',text:'Offline software fixture complete'}],details:{evaluations}}}}]})
 const options:PiJobControllerOptions={workspace,projectId,store,research,execution,sessionDirectory:path.join(workspace,'pi'),scientistFactory,runtimeOptions:{streamFn:()=>{turns++;return stream(evaluations<maximumEvaluations)}},...jobExtra}
 const jobs=new PiJobController(options),controller=new CampaignController({...options,jobs,propose});jobs.registerHandler('campaign_loop',controller.handleJob)
 return {...options,jobs,controller,campaign,experiment,contract,get evaluations(){return evaluations},get turns(){return turns}}
}
async function multiple(f:Awaited<ReturnType<typeof fixture>>){const second=await f.research.createExperiment(f.projectId,f.campaign.id,{contract:f.contract});await f.research.activateExperiment(f.projectId,second.id);return second}
const iterate=(o:CampaignPolicy.Observation,experimentId:string):CampaignPolicy.Move=>({kind:'iterate_experiment',experimentId,iterations:1,agent:'task',recursionMode:'autonomous_discovery',rationale:'An additional locked comparison resolves uncertainty.',expectedInformationGain:'A comparison informs next intervention.',researchBasis:{goalCriterionId:o.researchState.charter.successCriteria[0]!.id,hypothesis:'The next intervention may differ.',expectedObservation:'A locked change.',falsificationCriterion:'No difference.',searchDelta:'Scientist chooses native intervention.'}})
test('one active experiment runs its persistent scientist directly with exact owned-child dispatch and bounded authorization',async()=>{
 let supervisors=0
 const f=await fixture(async()=>{supervisors++;throw new Error('Sole active scientist must proceed directly')})
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'direct',maxSteps:3,maximumTrajectories:2,maximumKnowledgeRefreshes:0})
 const completed=await f.jobs.runOnce({jobId:parent.id})
 expect(completed?.status).toBe('succeeded');expect(completed?.result).toMatchObject({status:'exhausted',boundary:'ordinary_discovery_authorization_exhausted',remainingTrajectories:0,completedSteps:2})
 expect(f.evaluations).toBe(2);expect(supervisors).toBe(0)
 expect(completed?.result?.stopExplanation).toMatchObject({authority:'host_policy',reason:'discovery_budget_exhausted',refinementAssessed:false,remainingTrajectories:0})
 const jobs=await f.jobs.list(),child=jobs.find(job=>job.payload.parentJobId===parent.id)!
 expect(jobs).toHaveLength(2);expect(child.status).toBe('succeeded');expect(child.payload.iterations).toBe(2)
 expect((await f.store.read(f.projectId)).campaigns[f.campaign.id]?.piStopDecision).toBeUndefined()
 expect((await f.store.read(f.projectId)).campaigns[f.campaign.id]?.status).toBe('active')
 expect(await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'direct',maxSteps:3,maximumTrajectories:2,maximumKnowledgeRefreshes:0})).toMatchObject({id:parent.id})
 expect(await f.jobs.runOnce()).toBeUndefined()
})
test('ordinary prose cannot complete discovery and cumulative turn exhaustion defers without pausing the experiment',async()=>{
 let requests=0
 const f=await fixture(undefined,{runtimeOptions:{limits:{maxTurns:3},streamFn:()=>{requests++;return stream(false)}}})
 const job=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'natural-completion',maxSteps:3,maximumTrajectories:2,maximumKnowledgeRefreshes:0})
 const result=await f.jobs.runOnce({jobId:job.id})
 expect(result?.result).toMatchObject({status:'deferred',boundary:'runtime_limit_reached',remainingTrajectories:2,completedSteps:1})
 expect(requests).toBe(3);expect(f.evaluations).toBe(0)
 expect((await f.store.read(f.projectId)).experiments[f.experiment.id]!.status).toBe('active')
 expect((await f.jobs.list()).filter(child=>child.payload.parentJobId===job.id)).toHaveLength(1)
})
test('an exhausted parent grant leaves the scientific campaign active for a separately authorized fresh grant',async()=>{
 const f=await fixture()
 const input={maxSteps:2,maximumTrajectories:2,maximumDiscoveryTrajectories:2,discoveryBatchSize:2,maximumKnowledgeRefreshes:0}
 const first=await f.controller.enqueueCampaign(f.campaign.id,{...input,idempotencyKey:'parent-exhausted-first'})
 expect((await f.jobs.runOnce({jobId:first.id}))?.result).toMatchObject({status:'exhausted',boundary:'ordinary_discovery_authorization_exhausted',remainingTrajectories:0})
 const next=await f.controller.enqueueCampaign(f.campaign.id,{...input,idempotencyKey:'parent-exhausted-renewed'})
 expect((await f.jobs.runOnce({jobId:next.id}))?.result).toMatchObject({status:'exhausted',remainingTrajectories:0})
 expect(f.evaluations).toBe(4)
 const campaign=(await f.store.read(f.projectId)).campaigns[f.campaign.id]!
 expect(campaign.status).toBe('active');expect(campaign.piStopDecision).toBeUndefined()
 expect((await f.jobs.list()).filter(job=>job.payload.kind==='autoresearch').every(job=>job.status==='succeeded'&&job.result?.completedEvaluations===2)).toBe(true)
})
test('real Pi mock streams renew three two-trial batches without confusing prose or local exhaustion with a scientific stop',async()=>{
 let evaluations=0,maximum=0,requests=0
 const grants:number[]=[],baselines:number[]=[]
 const f=await fixture(undefined,{scientistFactory:options=>({
  initialize:async()=>{maximum=options.maximumEvaluations;grants.push(maximum);baselines.push(options.evaluationBaseline??0)},
  status:async()=>({completedEvaluations:evaluations,stopped:false,researchRequested:false}),context:async()=>({}),systemPrompt:'Offline boundary integration fixture',
  tools:()=>[{name:'evaluate_trial',label:'Evaluate',description:'Offline boundary fixture',parameters:Type.Object({}),executionMode:'sequential',execute:async()=>{
    evaluations++;return{content:[{type:'text',text:JSON.stringify({evaluations,continuation:evaluations>=maximum?'yield':'continue'})}],details:{evaluations},...evaluations>=maximum?{terminate:true}:{}}
  }}],
 }),runtimeOptions:{limits:{maxTurns:8,maxToolCalls:6},streamFn:()=>{
  requests++
  // Prose after initial inspection must not end the first child grant.
  return requests===1?stream(false):stream(true)
 }}})
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'three-renewed-batches',maxSteps:4,maximumTrajectories:6,maximumDiscoveryTrajectories:6,discoveryBatchSize:2,maximumKnowledgeRefreshes:0})
 const result=await f.jobs.runOnce({jobId:parent.id})
 expect(result?.status).toBe('succeeded')
 expect(result?.result).toMatchObject({status:'exhausted',boundary:'ordinary_discovery_authorization_exhausted',remainingTrajectories:0,remainingDiscoveryTrajectories:0,completedSteps:4})
 expect(evaluations).toBe(6);expect(requests).toBe(7)
 expect(grants).toEqual([2,4,6]);expect(baselines).toEqual([0,2,4])
 const children=(await f.jobs.list()).filter(job=>job.payload.parentJobId===parent.id)
 expect(children).toHaveLength(3)
 expect(children.every(job=>job.status==='succeeded'&&job.result?.reason==='iteration_limit_reached'&&job.result.completedEvaluations===2)).toBe(true)
 const state=await f.store.read(f.projectId)
 expect(state.experiments[f.experiment.id]!.status).toBe('active')
 expect(state.experiments[f.experiment.id]!.piStopDecision).toBeUndefined()
 expect(state.campaigns[f.campaign.id]!.piStopDecision).toBeUndefined()
 expect(state.campaigns[f.campaign.id]!.status).toBe('active')
})
test('native campaign contract proposals require exact host approval and idempotent approved identity',async()=>{
 const f=await fixture(async()=>({kind:'request_experiment',contract:{...f.contract,objective:'A different approved hypothesis'},hypothesis:'A new frozen contract is needed.',rationale:'The target question crosses the current contract.',successCriterion:'Independent support.'}));await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'proposal',maxSteps:2,maximumKnowledgeRefreshes:0})
 const completed=await f.jobs.runOnce({jobId:parent.id});expect(completed?.result).toMatchObject({status:'approval_required',completedSteps:1})
 const before=await f.research.listExperiments(f.projectId,f.campaign.id);expect(before).toHaveLength(2)
 const packet=Object.values((await f.controller.status(f.campaign.id)).approvals as Record<string,any>)[0]!
 expect((await Bun.file(path.join(f.workspace,packet.proposalPath)).json()).authority).toBe('scientist_proposal')
 await expect(f.controller.approveContract(f.campaign.id,{approvalId:'human-approval',proposalId:packet.proposalId,contract:f.contract})).rejects.toThrow('differs')
 const contract={...f.contract,objective:'A different approved hypothesis'},input={approvalId:'human-approval',proposalId:packet.proposalId,contract}
 const approved=await f.controller.approveContract(f.campaign.id,input);expect(approved.status).toBe('draft')
 expect(await f.controller.approveContract(f.campaign.id,input)).toEqual(approved)
 await expect(f.controller.approveContract(f.campaign.id,{...input,approvalId:'different'})).rejects.toThrow('already bound')
 expect(await f.research.listExperiments(f.projectId,f.campaign.id)).toHaveLength(3)
})
test('changed material observation supersedes a boundary proposal before dispatch',async()=>{
 const f=await fixture(async({observation})=>{await f.store.mutate(f.projectId,state=>{state.campaigns[f.campaign.id]!.objective='A materially changed question'});return iterate(observation,f.experiment.id)});await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'stale',maxSteps:1,maximumKnowledgeRefreshes:0})
 const result=await f.jobs.runOnce({jobId:parent.id});expect(result?.status).toBe('succeeded')
 expect((result?.result?.steps as any[])[0].result).toMatchObject({status:'superseded_stale_observation'})
 expect(await f.jobs.list()).toHaveLength(1);expect(f.evaluations).toBe(0)
 const observation=await f.controller.observe(f.campaign.id)
 expect(materialObservationFingerprint(observation)).toBe(materialObservationFingerprint({...observation,observedAt:new Date(Date.now()+1000).toISOString()}))
})
test('campaign policy cannot prescribe scientist intent or silently change a frozen contract',async()=>{
 const f=await fixture(async({observation})=>({...iterate(observation,f.experiment.id),kind:'iterate_experiment',trialIntent:'calibrate'} as CampaignPolicy.Move));await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'directive',maxSteps:1,maximumKnowledgeRefreshes:0})
 const result=await f.jobs.runOnce({jobId:parent.id});expect(result?.result).toMatchObject({status:'rejected',boundary:'policy_rejected'});expect(await f.jobs.list()).toHaveLength(1)
})
test('completed child recovery does not repeat a scientist turn after interrupted parent checkpoint',async()=>{
 const f=await fixture();let fail=true
 const jobs=new PiJobController(f),campaignController=new CampaignController({...f,jobs});jobs.registerOperation('campaign_loop',{...campaignController.operation,run:ctx=>campaignController.handleJob({...ctx,lifecycle:{...ctx.lifecycle,checkpoint:async(phase,data)=>{if(phase==='campaign:step:1:completed'&&fail){fail=false;throw new JobInterrupted('shutdown','Fixture interrupted after committed child')};return ctx.lifecycle.checkpoint(phase,data)}}})})
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'recover',maxSteps:1,maximumTrajectories:1,maximumKnowledgeRefreshes:0})
 const interrupted=await jobs.runOnce({jobId:parent.id});expect(interrupted!.status).toBe('interrupted');expect(f.evaluations).toBe(1)
 const turns=f.turns;const result=(await jobs.reconcileDetailed(parent.id)).job;expect(f.turns).toBe(turns)
 expect(result?.status).toBe('succeeded');expect(result?.result).toMatchObject({remainingTrajectories:0,completedSteps:1})
 expect(f.evaluations).toBe(1);expect(f.turns).toBe(2);expect(await f.jobs.list()).toHaveLength(2)
})
test('campaign trial cap is atomic across experiments and permits only exact origin replay at cap',async()=>{
 const f=await fixture(),second=await multiple(f)
 await f.research.campaignResearchState(f.projectId,f.campaign.id)
 await f.store.mutate(f.projectId,state=>{state.campaignCharters[f.campaign.id]!.constraints.maximumCampaignTrials=1})
 const input={hypothesis:'Admission fixture',designAdapter:'mock' as const,programPath:'fixture.json',programHash:digest('b'),origin:{jobId:'job_fixture',phase:'one'}}
 const accepted=await f.research.createTrial(f.projectId,f.experiment.id,input)
 expect(await f.research.createTrial(f.projectId,f.experiment.id,input)).toEqual(accepted)
 await expect(f.research.createTrial(f.projectId,second.id,{...input,origin:{...input.origin,phase:'two'}})).rejects.toThrow()
 expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(1)
})

test('new empirical requests stay open while the persistent scientist continues in its current batch',async()=>{
 const {ScientistLane}=await import('../scientist')
 let turns=0,reads=0,stopEvidence=''
 const f=await fixture(undefined,{scientistFactory:options=>{
  const lane=new ScientistLane(options),original=lane.tools.bind(lane)
  lane.tools=()=>original().map(tool=>tool.name!=='read_context'?tool:{...tool,execute:async(...args)=>{
   const result=await tool.execute(...args),context=result.details
   if(context.decisionMemory.openQuestions.length){reads++;expect(context.decisionMemory.openQuestions[0]!.status).toBe('open');expect(context.decisionMemory.openQuestions[0]!.request.purpose).toBe('empirical_test');expect((await lane.status()).researchRequested).toBe(false)}
   return result
  }})
  return lane
 },runtimeOptions:{streamFn:()=>{
  turns++
  if(turns===1)return stream(true,'request_research',{question:'Would repeated measurements explain the worse hotspot result?',competingExplanations:['Conditioning effect','Sampling variation'],requiredEvidence:'Independent repeats under the frozen evaluator',applicabilityChecks:'Same target, scorer, seed and trial budget',decisionIfResolved:'Compare the same arms within remaining authorization',evidenceRefs:[]})
  if(turns===2)return stream(true,'read_context',{})
  if(turns===3)return stream(true,'stop_discovery',{basis:'no_justified_intervention',reason:'Fixture stopped explicitly',rationale:'No provider or GPU inference in this test',evidenceRefs:[stopEvidence]})
  throw new Error('No model call after scientist stop')
 }}})
 stopEvidence=await settledStopEvidence(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'empirical-continue',maxSteps:4,maximumTrajectories:2,maximumKnowledgeRefreshes:1})
 const result=await f.jobs.runOnce({jobId:parent.id})
 expect(result?.status).toBe('succeeded');expect(result?.result).toMatchObject({status:'stopped',boundary:'scientist_stopped',knowledgeRefreshes:0,completedSteps:1})
 expect(turns).toBe(3);expect(reads).toBeGreaterThan(0)
 expect((await f.jobs.list()).filter(job=>job.payload.parentJobId===parent.id)).toHaveLength(1)
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(1);expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
 expect((await f.controller.observe(f.campaign.id)).knowledge.blockingResearchExperimentIds).toEqual([])
})

test('two ordinary trajectories yield to procedural refinement and protected paired replay; recovery charges each ledger once',async()=>{
 const {CampaignSkillService}=await import('../skills/service'),{CapabilityRefinementController,SkillShadowReplayController}=await import('../skills/controllers')
 let proposalCalls=0,refinementCalls=0,shadowCalls=0
 const f=await fixture(async({observation})=>{proposalCalls++;if(proposalCalls===1)return{...iterate(observation,f.experiment.id),iterations:100};return{kind:'refine_skill',skillId:'skill_bionemo.predictor-interpretation',experimentId:f.experiment.id,trajectoryRefs:[f.experiment.id],repetitions:3,rationale:'Refine interpretation using frozen campaign evidence.',expectedInformationGain:'A paired shadow comparison can reject unsupported guidance.'}})
 await multiple(f)
 const skills=new CampaignSkillService(f),parent=(await skills.initialize(f.campaign.id)).find(version=>version.skillId==='skill_bionemo.predictor-interpretation')!
 const markdown=(await fs.readFile(path.join(f.workspace,parent.path),'utf8')).replace('version: 1','version: 2')+'\nRequire an attributed same-contract counterfactual comparison.\n'
 const toolStream=(name:string,args:any,cost:number)=>{
  const value:AssistantMessage={role:'assistant',content:authoredToolCalls(name,args),api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'toolUse',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost}}}
  const output=createAssistantMessageEventStream();output.push({type:'start',partial:value});output.push({type:'done',reason:'toolUse',message:value});output.end(value);return output
 }
 const jobs=new PiJobController(f).registerSkills({refinement:new CapabilityRefinementController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{refinementCalls++;return toolStream('submit_skill',{markdown},0.01)}}}),
  replay:new SkillShadowReplayController({...f,allowMockPrograms:true,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{shadowCalls++;return toolStream('submit_trial',{hypothesis:'Independent software fixture arm '+shadowCalls,program:'"""Software plumbing shadow arm '+shadowCalls+'"""\n'},0.01)}}})})
 const campaign=new CampaignController({...f,jobs,propose:f.controller.options.propose});let interrupt=true
 jobs.registerOperation('campaign_loop',{...campaign.operation,run:ctx=>campaign.handleJob({...ctx,lifecycle:{...ctx.lifecycle,checkpoint:async(phase,data)=>{if(interrupt&&phase==='campaign:step:2:completed'){interrupt=false;throw new JobInterrupted('shutdown','Interrupted after both owned children settled')};return ctx.lifecycle.checkpoint(phase,data)}}})})
 const job=await campaign.enqueueCampaign(f.campaign.id,{idempotencyKey:'refine-chain',maxSteps:2,maximumTrajectories:8,maximumDiscoveryTrajectories:2,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:0,modelBudgetUsd:1,perChildModelBudgetUsd:0.3})
 expect((await jobs.runOnce({jobId:job.id}))?.status).toBe('interrupted');expect(shadowCalls).toBe(6);expect(refinementCalls).toBe(1)
 const turns=f.turns;const completed=(await jobs.reconcileDetailed(job.id)).job;expect(f.turns).toBe(turns)
 expect(completed?.status).toBe('succeeded');expect(completed?.result).toMatchObject({remainingTrajectories:0,remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:0,discoveryBatchSize:2,modelCostUsd:expect.closeTo(0.07)})
 const children=(await jobs.list()).filter(child=>child.payload.parentJobId===job.id);expect(children).toHaveLength(3)
 expect(children.every(child=>child.status==='succeeded')).toBe(true);expect(children.map(child=>child.payload.kind).sort()).toEqual(['autoresearch','capability_refinement','skill_shadow_replay'])
 expect(proposalCalls).toBe(2);expect(f.evaluations).toBe(2);expect(refinementCalls).toBe(1);expect(shadowCalls).toBe(6)
 const state=await f.store.read(f.projectId),trials=Object.values(state.trials)
 expect(trials).toHaveLength(6);expect(trials.every(trial=>trial.intent==='shadow_replay')).toBe(true);expect(state.experiments[f.experiment.id]?.incumbentTrialId).toBeUndefined()
 const candidate=Object.values(state.skillVersions).find(version=>version.parentVersionId===parent.id)!
 expect(['active','rejected']).toContain(candidate.status)
 expect(completed?.checkpoints['campaign:step:2:refinement-replay']?.data).toMatchObject({candidateVersionId:candidate.id,contentHash:candidate.contentHash,experimentId:f.experiment.id,repetitions:3})
},30000)
test('campaign refuses refinement before allocating model work when paired replay exceeds residual scientific authorization',async()=>{
 const f=await fixture(async()=>({kind:'refine_skill',skillId:'skill_bionemo.predictor-interpretation',experimentId:f.experiment.id,trajectoryRefs:[f.experiment.id],repetitions:3,rationale:'Frozen-evidence guidance refinement.',expectedInformationGain:'Paired validation.'}));await multiple(f)
 const {CampaignSkillService}=await import('../skills/service');await new CampaignSkillService(f).initialize(f.campaign.id)
 const job=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'insufficient-pairs',maxSteps:1,maximumTrajectories:5,maximumKnowledgeRefreshes:0})
 const completed=await f.jobs.runOnce({jobId:job.id});expect(completed?.result).toMatchObject({status:'deferred',boundary:'paired_shadow_replay_requires_residual_authorization',remainingTrajectories:5})
 expect(await f.jobs.list()).toHaveLength(1);expect(Object.values((await f.store.read(f.projectId)).skillVersions).some(version=>version.status==='candidate')).toBe(false)
})


test('explicit campaign continuation inherits the original residual grant and deadline without allocating fresh budgets',async()=>{
 const f=await fixture(async()=>({kind:'refine_skill',skillId:'skill_bionemo.predictor-interpretation',experimentId:f.experiment.id,trajectoryRefs:[f.experiment.id],repetitions:3,rationale:'Frozen evidence refinement.',expectedInformationGain:'Paired validation.'}));await multiple(f)
 const {CampaignSkillService}=await import('../skills/service');await new CampaignSkillService(f).initialize(f.campaign.id)
 const source=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'continuation-source',maxSteps:4,maximumTrajectories:5,maximumDiscoveryTrajectories:0,reservedReplayTrajectories:5,discoveryBatchSize:2,maximumKnowledgeRefreshes:0,modelBudgetUsd:0.5,perChildModelBudgetUsd:0.2,maximumDurationMs:60000})
 const completed=await f.jobs.runOnce({jobId:source.id});expect(completed?.result).toMatchObject({status:'deferred',completedSteps:1,remainingTrajectories:5})
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'fresh-compute',continuedFromJobId:source.id,maxSteps:1,maximumTrajectories:6})).rejects.toThrow('residual authorization')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'fresh-model',continuedFromJobId:source.id,maxSteps:1,modelBudgetUsd:1})).rejects.toThrow('residual authorization')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'fresh-steps',continuedFromJobId:source.id,maxSteps:4})).rejects.toThrow('exhausted')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'fresh-ordinary',continuedFromJobId:source.id,maxSteps:1,maximumDiscoveryTrajectories:1})).rejects.toThrow('residual authorization')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'fresh-batch',continuedFromJobId:source.id,maxSteps:1,discoveryBatchSize:3})).rejects.toThrow('residual authorization')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'released-reserve',continuedFromJobId:source.id,maxSteps:1,reservedReplayTrajectories:0})).rejects.toThrow('residual authorization')
 const input={idempotencyKey:'bounded-continuation',continuedFromJobId:source.id,maxSteps:1},next=await f.controller.enqueueCampaign(f.campaign.id,input)
 expect(next.payload.maximumTrajectories).toBe(5);expect(next.payload.maximumDiscoveryTrajectories).toBe(0);expect(next.payload.reservedReplayTrajectories).toBe(5);expect(next.payload.discoveryBatchSize).toBe(2);expect(next.payload.maximumKnowledgeRefreshes).toBe(0);expect(next.payload.modelBudgetUsd).toBe(0.5);expect(next.payload.perChildModelBudgetUsd).toBe(0.2)
 expect(next.payload.originDeadlineMs).toBe((completed?.checkpoints['campaign:job:start']?.data as any).deadlineMs)
 await Bun.sleep(5);expect((await f.controller.enqueueCampaign(f.campaign.id,input)).id).toBe(next.id)
 await expect(f.controller.enqueueCampaign(f.campaign.id,{...input,idempotencyKey:'forked-continuation'})).rejects.toThrow('already has a residual continuation')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{...input,maximumDiscoveryTrajectories:1})).rejects.toThrow('different authorization')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{...input,reservedReplayTrajectories:0})).rejects.toThrow('different authorization')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{...input,discoveryBatchSize:3})).rejects.toThrow('different authorization')
})


test('cancellation between approval packet staging and provenance commit leaves no actionable proposal',async()=>{
 const f=await fixture(async()=>({kind:'request_experiment',contract:f.contract,hypothesis:'A reviewable scientific contract.',rationale:'A new frozen question needs explicit approval.',successCriterion:'Independent support.'}));await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'cancel-proposal',maxSteps:1,maximumKnowledgeRefreshes:0})
 const rename=fs.rename.bind(fs);let cancelled=false
 const fault=spyOn(fs,'rename').mockImplementation(async(source,target)=>{await rename(source,target);if(!cancelled&&String(target).includes('/approvals/')){cancelled=true;await f.jobs.cancel(parent.id)}})
 try{expect((await f.jobs.runOnce({jobId:parent.id}))?.status).toBe('cancelled')}finally{fault.mockRestore()}
 expect((await f.controller.status(f.campaign.id)).approvals).toEqual({})
 const dir=path.join(f.workspace,`.autofold/campaigns/${f.campaign.id}/approvals`),packet=await Bun.file(path.join(dir,(await fs.readdir(dir))[0]!)).json()
 expect(packet.status).toBe('uncommitted');await expect(f.controller.approveContract(f.campaign.id,{approvalId:'forbidden',proposalId:packet.proposalId,contract:f.contract})).rejects.toThrow('outside this campaign')
 expect(await f.research.listExperiments(f.projectId,f.campaign.id)).toHaveLength(2)
})
test('host approval rejects a pending proposal after its originating job is cancelled',async()=>{
 const f=await fixture(async()=>({kind:'request_experiment',contract:f.contract,hypothesis:'A new contract is reviewable.',rationale:'Scientific boundary.',successCriterion:'Independent evidence.'}));await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'cancel-approved-packet',maxSteps:1,maximumKnowledgeRefreshes:0});await f.jobs.runOnce({jobId:parent.id})
 const packet=Object.values((await f.controller.status(f.campaign.id)).approvals as Record<string,any>)[0]!
 // A host restoration/cancellation outcome can be persisted independently of this already-terminal fixture job.
 await f.store.mutate(f.projectId,state=>{state.jobs[parent.id]!.status='cancelled'})
 expect((Object.values((await f.controller.status(f.campaign.id)).approvals) as any[])[0].status).toBe('cancelled')
 await expect(f.controller.approveContract(f.campaign.id,{approvalId:'forbidden-cancel',proposalId:packet.proposalId,contract:f.contract})).rejects.toThrow('Cancelled originating job')
 expect(await f.research.listExperiments(f.projectId,f.campaign.id)).toHaveLength(2)
})


test('ordinary proposals cannot spend protected replay slots or exceed the host batch and ordinary cap',async()=>{
 const f=await fixture(async({observation})=>({...iterate(observation,f.experiment.id),iterations:100}));await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'untrusted-allocation',maxSteps:4,maximumTrajectories:12,
  maximumDiscoveryTrajectories:3,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:0})
 const completed=await f.jobs.runOnce({jobId:parent.id})
 expect(completed?.result).toMatchObject({status:'deferred',boundary:'ordinary_discovery_authorization_exhausted',remainingTrajectories:9,
  remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6,completedSteps:3})
 const children=(await f.jobs.list()).filter(child=>child.payload.parentJobId===parent.id)
 expect([1,2].map(step=>children.find(child=>child.idempotencyKey===`campaign:${parent.id}:step:${step}:discovery`)?.payload.iterations)).toEqual([2,1]);expect(f.evaluations).toBe(3)
 expect((completed?.result?.steps as any[]).map(step=>step.consumedDiscoveryTrajectories)).toEqual([2,1,0])
 expect((await f.store.read(f.projectId)).campaigns[f.campaign.id]?.status).toBe('active')
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'impossible-reserve',maxSteps:1,maximumTrajectories:2,reservedReplayTrajectories:6})).rejects.toThrow('reservation exceeds')
})

test('ordinary exhaustion leaves research separate and selects only supported procedural feedback while preserving six replay slots',async()=>{
 const f=await fixture(),{CampaignSkillService}=await import('../skills/service');await new CampaignSkillService(f).initialize(f.campaign.id)
 const observation=await f.controller.observe(f.campaign.id),scheduling={maximumDiscoveryTrajectories:0,reservedReplayTrajectories:6,discoveryBatchSize:2}
 expect(directActiveExperimentProposal(observation,6,f.experiment.id,true,scheduling)?.kind).toBe('stop')
 const current={...observation,knowledge:{...observation.knowledge,due:false,reasons:[]}}
 expect(directActiveExperimentProposal(current,6,f.experiment.id,true,scheduling)).toMatchObject({kind:'stop',rationale:expect.stringContaining('Protected replay')})
 const skill=current.skills.active[0]!
 const feedback={...current,recentSkillFeedback:[1,2].map(index=>({jobId:'job_signal_'+index,experimentId:f.experiment.id,iteration:index,skillId:skill.skillId,
  trigger:'authoring_failure' as const,rationale:'Two distinct captured programs fail the same pinned construction check.',trajectoryRefs:[f.experiment.id],requiresShadowReplay:true as const,
  programFingerprint:digest(index===1?'b':'c'),recordedAt:new Date().toISOString()}))}
 // Even repeated gate feedback cannot preempt the approved ordinary discovery batches.
 expect(directActiveExperimentProposal(feedback,12,f.experiment.id,true,{...scheduling,maximumDiscoveryTrajectories:6})).toMatchObject({kind:'iterate_experiment',iterations:2})
 expect(directActiveExperimentProposal({...feedback,knowledge:observation.knowledge},12,f.experiment.id,true,{...scheduling,maximumDiscoveryTrajectories:6})?.kind).toBe('iterate_experiment')
 expect(directActiveExperimentProposal(feedback,12,f.experiment.id,true,{...scheduling,maximumDiscoveryTrajectories:6,assistanceDue:true})).toMatchObject({kind:'refine_skill',repetitions:3})
 expect(directActiveExperimentProposal(feedback,10,f.experiment.id,true,{...scheduling,maximumDiscoveryTrajectories:6,reservedReplayTrajectories:4,assistanceDue:true})).toMatchObject({kind:'iterate_experiment',iterations:2})
 expect(directActiveExperimentProposal(feedback,6,f.experiment.id,true,scheduling)).toMatchObject({kind:'refine_skill',repetitions:3})
 const candidate={id:'skv_pending',skillId:skill.skillId,version:2,parentVersionId:skill.id,contentHash:digest('d'),status:'candidate' as const,trajectoryRefs:[f.experiment.id],createdAt:new Date().toISOString()}
 expect(directActiveExperimentProposal({...feedback,skills:{...feedback.skills,recentRefinements:[candidate]}},6,f.experiment.id,true,scheduling)).toMatchObject({kind:'replay_skill',candidateVersionId:candidate.id,repetitions:3})
 expect(f.evaluations).toBe(0)
})

test('legacy frozen campaign payloads recover default scheduling and reopen without enlarging authority',async()=>{
 const f=await fixture();const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'legacy-defaults',maxSteps:1,maximumTrajectories:8,maximumKnowledgeRefreshes:0})
 await f.store.mutate(f.projectId,state=>{const payload=state.jobs[parent.id]!.payload;delete payload.discoveryBatchSize;delete payload.maximumDiscoveryTrajectories;delete payload.reservedReplayTrajectories})
 expect((await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'legacy-defaults',maxSteps:1})).id).toBe(parent.id)
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'legacy-defaults',maxSteps:1,discoveryBatchSize:8})).rejects.toThrow('different authorization')
 const completed=await f.jobs.runOnce({jobId:parent.id})
 expect(completed?.result).toMatchObject({remainingTrajectories:6,remainingDiscoveryTrajectories:6,remainingReservedReplayTrajectories:0,discoveryBatchSize:2})
 expect(f.evaluations).toBe(2)
})


test('a model-submitted oversized move is clamped at admission and cannot release replay protection',async()=>{
 let supervisors=0,scientistTurns=0,observation:CampaignPolicy.Observation
 const f=await fixture(undefined,{runtimeOptions:{streamFn:(_model,context)=>{
  if(getCurrentTools(context.messages).some(tool=>tool.name==='submit_move')) {
   const schema = getCurrentTools(context.messages).find(tool=>tool.name==='submit_move')!.parameters as any
   expect(schema.anyOf).toHaveLength(CampaignPolicy.Move.options.length)
   const iterateSchema = schema.anyOf.find((branch:any)=>branch.properties.kind.const==='iterate_experiment')
   expect(iterateSchema.required).toContain('researchBasis')
   expect(iterateSchema.properties.iterations).toMatchObject({type:'integer',minimum:1,maximum:100})
   supervisors++;return stream(true,'submit_move',JSON.parse(JSON.stringify({...iterate(observation,f.experiment.id),iterations:100})))}
  scientistTurns++;return stream(f.evaluations<2)
 }}})
 await multiple(f);observation=await f.controller.observe(f.campaign.id)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'model-allocation',maxSteps:3,maximumTrajectories:8,
  maximumDiscoveryTrajectories:8,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:0})
 const completed=await f.jobs.runOnce({jobId:parent.id})
 expect(completed?.result).toMatchObject({status:'deferred',boundary:'ordinary_discovery_authorization_exhausted',remainingTrajectories:6,
  remainingDiscoveryTrajectories:6,remainingReservedReplayTrajectories:6,completedSteps:2})
 expect(f.evaluations).toBe(2);expect(supervisors).toBe(2)
 const children=(await f.jobs.list()).filter(child=>child.payload.parentJobId===parent.id)
 expect(children).toHaveLength(1);expect(children[0]!.payload.iterations).toBe(2)
 const session=await Bun.file(path.join(f.workspace,`.autofold/campaigns/${f.campaign.id}/jobs/${parent.id}/result.json`)).json()
 expect(session.remainingReservedReplayTrajectories).toBe(6)
})

test('a durable completed discovery checkpoint is charged once after parent restart and continuation carries only its residuals',async()=>{
 const f=await fixture();let interrupt=true
 const jobs=new PiJobController(f),controller=new CampaignController({...f,jobs})
 jobs.registerOperation('campaign_loop',{...controller.operation,run:ctx=>controller.handleJob({...ctx,lifecycle:{...ctx.lifecycle,checkpoint:async(phase,data)=>{
  const saved=await ctx.lifecycle.checkpoint(phase,data)
  if(interrupt&&phase==='campaign:step:1:completed'){interrupt=false;throw new JobInterrupted('shutdown','Interrupted after durable completed step')}
  return saved
 }}})})
 const parent=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'ledger-restart',maxSteps:3,maximumTrajectories:8,
  maximumDiscoveryTrajectories:2,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:0})
 expect((await jobs.runOnce({jobId:parent.id}))?.status).toBe('interrupted');expect(f.evaluations).toBe(2)
 // Keep the campaign active and use an injected boundary after restart, so a residual continuation remains inspectable.
 await multiple(f)
 const restartedJobs=new PiJobController(f),recovered=new CampaignController({...f,jobs:restartedJobs,propose:async({observation})=>({...iterate(observation,f.experiment.id),iterations:100})})
 restartedJobs.registerOperation('campaign_loop',recovered.operation)
 const turns=f.turns,completed=(await restartedJobs.reconcileDetailed(parent.id)).job
 expect(f.turns).toBe(turns)
 expect(completed?.result).toMatchObject({status:'deferred',completedSteps:1,remainingTrajectories:6,remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6})
 expect(f.evaluations).toBe(2);expect((await jobs.list()).filter(child=>child.payload.parentJobId===parent.id)).toHaveLength(1)
 await expect(recovered.enqueueCampaign(f.campaign.id,{idempotencyKey:'ledger-replenish',continuedFromJobId:parent.id,maxSteps:1,maximumDiscoveryTrajectories:2})).rejects.toThrow('residual authorization')
 const continuation=await recovered.enqueueCampaign(f.campaign.id,{idempotencyKey:'ledger-residual',continuedFromJobId:parent.id,maxSteps:1})
 expect(continuation.payload).toMatchObject({maximumTrajectories:6,maximumDiscoveryTrajectories:0,reservedReplayTrajectories:6,discoveryBatchSize:2})
 expect((await restartedJobs.runOnce({jobId:continuation.id}))?.result).toMatchObject({remainingTrajectories:6,remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6})
 expect(f.evaluations).toBe(2)
})


test('concurrent continuation callers cannot fork the same residual campaign authorization',async()=>{
 const f=await fixture(async()=>({kind:'refine_skill',skillId:'skill_bionemo.predictor-interpretation',experimentId:f.experiment.id,trajectoryRefs:[f.experiment.id],repetitions:3,rationale:'Frozen evidence refinement.',expectedInformationGain:'Paired validation.'}));await multiple(f)
 const {CampaignSkillService}=await import('../skills/service');await new CampaignSkillService(f).initialize(f.campaign.id)
 const source=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'concurrent-source',maxSteps:3,maximumTrajectories:5,
  maximumDiscoveryTrajectories:0,reservedReplayTrajectories:5,maximumKnowledgeRefreshes:0})
 await f.jobs.runOnce({jobId:source.id})
 const inputs=['residual-a','residual-b'].map(idempotencyKey=>({idempotencyKey,continuedFromJobId:source.id,maxSteps:1}))
 const admissions=await Promise.allSettled(inputs.map(input=>f.controller.enqueueCampaign(f.campaign.id,input)))
 expect(admissions.filter(result=>result.status==='fulfilled')).toHaveLength(1)
 expect(admissions.filter(result=>result.status==='rejected')).toHaveLength(1)
 const continuations=(await f.jobs.list()).filter(job=>job.payload.continuedFromJobId===source.id)
 expect(continuations).toHaveLength(1);expect(continuations[0]!.payload).toMatchObject({maximumTrajectories:5,maximumDiscoveryTrajectories:0,reservedReplayTrajectories:5})
 const winning=inputs.find(input=>input.idempotencyKey===continuations[0]!.payload.idempotencyKey)!
 expect((await f.controller.enqueueCampaign(f.campaign.id,winning)).id).toBe(continuations[0]!.id)
 expect(f.evaluations).toBe(0)
})


test('supported refinement runs before ordinary exhaustion; failed replay preserves follow-up capacity and original candidate', async () => {
 const {CampaignSkillService}=await import('../skills/service'),{CapabilityRefinementController,SkillShadowReplayController}=await import('../skills/controllers')
 const f=await fixture(),skills=new CampaignSkillService(f),parent=(await skills.initialize(f.campaign.id)).find(version=>version.skillId==='skill_bionemo.predictor-interpretation')!
 const markdown=(await fs.readFile(path.join(f.workspace,parent.path),'utf8')).replace('version: 1','version: 2')+'\nRequire independent comparison before changing guidance.\n'
 let refinementCalls=0,replayCalls=0;const signalAt=new Date().toISOString()
 const response=(name?:string,args?:any)=>{
  const value:AssistantMessage={role:'assistant',content:name?[{type:'toolCall',id:'offline_'+crypto.randomUUID(),name,arguments:args}]:[{type:'text',text:'No admissible program.'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:name?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0.01,output:0,cacheRead:0,cacheWrite:0,total:0.01}}}
  const s=createAssistantMessageEventStream();s.push({type:'start',partial:value});s.push({type:'done',reason:name?'toolUse':'stop',message:value});s.end(value);return s
 }
 const jobs=new PiJobController(f).registerSkills({refinement:new CapabilityRefinementController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{refinementCalls++;expect(f.evaluations).toBe(2);return response('submit_skill',{markdown})}}}),
  replay:new SkillShadowReplayController({...f,allowMockPrograms:true,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{replayCalls++;expect(f.evaluations).toBe(2);return response()}}})})
 const controller=new CampaignController({...f,jobs}),observe=controller.observe.bind(controller)
 controller.observe=async(...args)=>{const observation=await observe(...args);return {...observation,knowledge:{...observation.knowledge,due:false,reasons:[]},recentSkillFeedback:[1,2].map(index=>({jobId:'job_old_'+index,experimentId:f.experiment.id,iteration:index,skillId:parent.skillId,trigger:'authoring_failure' as const,rationale:'Two independently captured programs expose the same construction gap.',trajectoryRefs:[f.experiment.id],requiresShadowReplay:true as const,programFingerprint:digest(index===1?'b':'c'),recordedAt:signalAt}))}}
 jobs.registerHandler('campaign_loop',controller.handleJob)
 const job=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'discovery-before-replay',maxSteps:6,maximumTrajectories:12,maximumDiscoveryTrajectories:6,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:0,modelBudgetUsd:1,perChildModelBudgetUsd:0.2})
 const result=await jobs.runOnce({jobId:job.id})
 expect(result?.result).toMatchObject({status:'deferred',boundary:'paired_shadow_replay_requires_attention',completedSteps:2,remainingDiscoveryTrajectories:4,remainingReservedReplayTrajectories:6,remainingTrajectories:10,modelCostUsd:expect.closeTo(0.02)})
 expect(f.evaluations).toBe(2);expect(refinementCalls).toBe(1);expect(replayCalls).toBe(1)
 const children=(await jobs.list()).filter(child=>child.payload.parentJobId===job.id)
 expect(children.filter(child=>child.payload.kind==='autoresearch').map(child=>child.payload.iterations)).toEqual([2])
 const state=await f.store.read(f.projectId),candidate=Object.values(state.skillVersions).find(v=>v.parentVersionId===parent.id)!
 expect(candidate.status).toBe('candidate');expect(state.skillVersions[parent.id]?.status).toBe('active')
 expect((result?.result?.steps as any[]).map(s=>s.proposal.kind)).toEqual(['iterate_experiment','refine_skill'])
 expect(Object.values(state.runs)).toHaveLength(0)
},30_000)


test('due knowledge and a separately failed reviewer do not interrupt discovery or charge its campaign budget',async()=>{
 const f=await fixture(async()=>{throw new Error('Sole experiment does not need a supervisor')})
 const ingested=await f.research.ingestLiteratureReview(f.projectId,f.campaign.id,{generatedBy:'fixture:pending',sources:[{key:'s',database:'pubmed',sourceId:'1',title:'Scoped fixture',query:'fixture',excerpts:['Source-grounded fixture only.']}],claims:[{kind:'limitation',statement:'Fixture interpretation awaiting review.',stance:'context',confidence:.4,evidence:[{sourceKey:'s',excerpt:'Source-grounded fixture only.'}]}],unresolvedQuestions:[]})
 const jobs=new PiJobController(f),controller=new CampaignController({...f,jobs})
 let reviewers=0,interrupt=true
 const {createAgentRuntime,createSessionStore}=await import('../runtime')
 const {KnowledgeReviewController}=await import('../knowledge-review-controller')
 jobs.registerKnowledgeReview({run:async(input:any)=>{
  reviewers++;expect(f.evaluations).toBe(0)
  const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
  try{
   const runtime=createAgentRuntime({store:sessions,tools:[],streamFn:()=>{
    const value:AssistantMessage={role:'assistant',content:[{type:'text',text:'Failed advisory fixture; no accepted review.'}],api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:.07,output:0,cacheRead:0,cacheWrite:0,total:.07}}}
    const out=createAssistantMessageEventStream();out.push({type:'start',partial:value});out.push({type:'done',reason:'stop',message:value});out.end(value);return out
   }})
   await runtime.create({id:input.sessionId,metadata:{projectId:f.projectId,campaignId:f.campaign.id,jobId:input.jobId}})
   await runtime.run(input.sessionId,'Offline advisory reviewer failure')
  }finally{sessions.close()}
  throw new Error('Fixture citation failure')
 }} as unknown as InstanceType<typeof KnowledgeReviewController>)
 jobs.registerOperation('campaign_loop',{...controller.operation,run:ctx=>controller.handleJob({...ctx,lifecycle:{...ctx.lifecycle,checkpoint:async(phase,data)=>{
  const saved=await ctx.lifecycle.checkpoint(phase,data)
  if(phase==='campaign:job:result'&&interrupt){interrupt=false;throw new JobInterrupted('shutdown','Interrupt after final discovery and advisory receipt commit')}
  return saved
 }}})})
 const separate=await jobs.enqueueKnowledgeReview(f.campaign.id,{idempotencyKey:'separate-failed-review',claimIds:[ingested.claims[0]!.id],alignmentIds:[],question:'Separate source review',maxRequests:50,modelBudgetUsd:.2})
 expect((await jobs.runOnce({jobId:separate.id}))?.status).toBe('failed')
 const observation=await controller.observe(f.campaign.id)
 expect(directActiveExperimentProposal({...observation,knowledge:{...observation.knowledge,due:true,reasons:['no_prior_knowledge_cycle']}},10,f.experiment.id,true,{maximumDiscoveryTrajectories:4,reservedReplayTrajectories:6})).toMatchObject({kind:'iterate_experiment',iterations:2})
 const job=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'advisory-failure',maxSteps:4,maximumTrajectories:10,maximumDiscoveryTrajectories:4,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:4,modelBudgetUsd:1})
 expect((await jobs.runOnce({jobId:job.id}))?.status).toBe('interrupted')
 const turns=f.turns
 const final=(await jobs.reconcileDetailed(job.id)).job
 expect(f.turns).toBe(turns)
 expect(final?.result).toMatchObject({status:'exhausted',remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6,modelCostUsd:0,knowledgeRefreshes:0})
 const steps=final?.result?.steps as any[]
 expect(steps.map(s=>s.proposal.kind)).toEqual(['iterate_experiment','iterate_experiment','stop'])
 expect(steps.filter(s=>s.proposal.kind==='request_review'||s.proposal.kind==='refresh_knowledge')).toHaveLength(0)
 expect(reviewers).toBe(1);expect(f.evaluations).toBe(4)
 expect((await f.store.read(f.projectId)).claims[ingested.claims[0]!.id]?.status).toBe('proposed')
 expect((await jobs.list()).filter(j=>j.payload.kind==='knowledge_review')).toHaveLength(1)
 expect((await jobs.list()).filter(j=>j.payload.parentJobId===job.id).every(j=>j.payload.kind==='autoresearch')).toBe(true)
 const {readJobAccounting}=await import('../jobs/accounting')
 expect((await readJobAccounting(f,await jobs.get(separate.id))).modelCostUsd).toBeCloseTo(.07,10)
})

test('historical explicit research never blocks either experiment, even with zero knowledge allowance',async()=>{
 const f=await fixture(),other=await multiple(f)
 await f.research.requestResearch(f.projectId,f.experiment.id,{request:{action:'create',question:'Resolve a required measurement before proceeding.',competingExplanations:['Sequence effect','Evaluator effect'],requiredEvidence:'Attributable diagnostic evidence',applicabilityChecks:'Frozen experiment',decisionIfResolved:'Choose the next intervention'},evidenceRefs:[],generatedBy:'autofold-pi-scientist/v1:fixture'})
 const observation=await f.controller.observe(f.campaign.id)
 expect(observation.knowledge.blockingResearchExperimentIds).toEqual([])
 expect(directActiveExperimentProposal(observation,4,f.experiment.id,true)?.kind).toBe('iterate_experiment')
 expect(directActiveExperimentProposal(observation,4,other.id,true)?.kind).toBe('iterate_experiment')
 expect(CampaignPolicy.compile({...observation,knowledge:{...observation.knowledge,blockingResearchExperimentIds:[f.experiment.id]}},iterate(observation,f.experiment.id))).toMatchObject({status:'authorized',executable:true})
 const job=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'required-no-budget',experimentId:f.experiment.id,maxSteps:2,maximumTrajectories:4,maximumKnowledgeRefreshes:0})
 const final=await f.jobs.runOnce({jobId:job.id})
 expect(final?.result).toMatchObject({status:'exhausted',remainingTrajectories:0,knowledgeRefreshes:0})
 expect(f.evaluations).toBe(4)
 expect((await f.research.campaignResearchState(f.projectId,f.campaign.id)).researchQuestions[0]?.status).toBe('open')
})

test('empirical replication requests stay visible without scheduling online lookup between discovery batches',async()=>{
 const f=await fixture(async()=>{throw new Error('No supervisor needed')})
 let recorded=false,lookups=0
 const baseFactory=f.scientistFactory!
 const literature={run:async()=>{lookups++;expect(f.evaluations).toBe(2);throw new Error('Offline four-question reviewer failure')}} as unknown as PiJobControllerOptions['literature']
 const jobs=new PiJobController({...f,literature,scientistFactory:options=>{
  const lane=baseFactory(options),original=lane.tools.bind(lane)
  lane.tools=()=>original().map(tool=>tool.name!=='evaluate_trial'?tool:{...tool,execute:async(...args:any[])=>{
   const result=await (tool.execute as any)(...args)
   if(f.evaluations===2&&!recorded){recorded=true;await f.research.requestResearch(f.projectId,f.experiment.id,{request:{action:'create',purpose:'empirical_test',question:'Separate hotspot conditioning from stochastic variation with paired replication.',competingExplanations:['Conditioning effect','Sampling variation'],requiredEvidence:'Repeated same-budget baseline and hotspot trials',applicabilityChecks:'Frozen target and evaluator',decisionIfResolved:'Keep or reject the hotspot intervention'},evidenceRefs:[],generatedBy:'scientist:offline-reproduction'})}
   return result
  }})
  return lane
 }})
 const controller=new CampaignController({...f,jobs});jobs.registerHandler('campaign_loop',controller.handleJob)
 const parent=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'replication-advisory',maxSteps:4,maximumTrajectories:10,maximumDiscoveryTrajectories:4,reservedReplayTrajectories:6,maximumKnowledgeRefreshes:4,modelBudgetUsd:1})
 const result=await jobs.runOnce({jobId:parent.id})
 expect(result?.result).toMatchObject({status:'exhausted',remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6})
 const steps=result?.result?.steps as any[]
 expect(steps.map(step=>step.proposal.kind)).toEqual(['iterate_experiment','iterate_experiment','stop'])
 expect(lookups).toBe(0);expect(f.evaluations).toBe(4)
 const question=(await f.research.campaignResearchState(f.projectId,f.campaign.id)).researchQuestions[0]!
 expect(question).toMatchObject({status:'open',request:{purpose:'empirical_test'}})
 expect((await controller.observe(f.campaign.id)).knowledge.blockingResearchExperimentIds).toEqual([])
 expect((await f.store.read(f.projectId)).knowledgeCycles).toEqual({})
})


test.each(['refresh_knowledge','request_review'] as const)('supervisor %s proposal is recorded for separate processing and never halts the next discovery move',async kind=>{
 let step=0
 const f=await fixture(async({observation})=> ++step===1 ? (kind==='refresh_knowledge'
  ? {kind,force:true,rationale:'Research belongs in a separate process'}
  : {kind,claimIds:['clm_not_pending'],rationale:'An invalid review proposal must not stop science'}) : {...iterate(observation,observation.experiments[0]!.id),iterations:2})
 await multiple(f)
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'separate-'+kind,maxSteps:2,maximumTrajectories:2,maximumKnowledgeRefreshes:4,modelBudgetUsd:1})
 const result=await f.jobs.runOnce({jobId:parent.id})
 expect(result?.result).toMatchObject({status:'exhausted',remainingTrajectories:0,knowledgeRefreshes:0})
 const steps=result?.result?.steps as any[]
 expect(steps[0].result).toMatchObject({status:'research_deferred',boundary:'separate_research_process'})
 expect(steps[0].result.campaignStatus).toBeUndefined()
 expect(steps[1].proposal.kind).toBe('iterate_experiment')
 expect(f.evaluations).toBe(2)
 expect((await f.jobs.list()).filter(j=>j.payload.parentJobId===parent.id).map(j=>j.payload.kind)).toEqual(['autoresearch'])
})

test('a child with an unresolved original tool effect holds its parent without spinning or reporting success',async()=>{
 const {ReceiptUnresolvedError}=await import('../execution')
 let pending=false,modelCalls=0
 const f=await fixture(undefined,{scientistFactory:()=>({initialize:async()=>{},status:async()=>({completedEvaluations:0,stopped:false,researchRequested:false,...(pending?{pending:{requestId:'lost-child',programHash:digest('a'),programPath:'trial.py',iteration:1}}:{})}),context:async()=>({}),systemPrompt:'Unknown receipt fixture',tools:()=>[{name:'evaluate_trial',label:'Lost worker acknowledgement',description:'Fault injection only',parameters:Type.Object({}),execute:async()=>{pending=true;throw new ReceiptUnresolvedError('run_child_original','Injected lost receipt')}}]}),runtimeOptions:{streamFn:()=>{modelCalls++;return stream(true)}}})
 const parent=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'held-parent',maxSteps:2,maximumTrajectories:4,modelBudgetUsd:1})
 const held=await f.jobs.runOnce({jobId:parent.id})
 expect(held?.status).toBe('recovery_required');expect(held?.recovery?.reason).toBe('child_unresolved');expect(held?.result).toBeUndefined()
 const child=(await f.jobs.list()).find(j=>j.payload.parentJobId===parent.id)!
 expect(child.status).toBe('recovery_required');expect(held?.recovery?.childJobId).toBe(child.id)
 expect(modelCalls).toBe(1);expect(await f.jobs.runOnce()).toBeUndefined();expect(modelCalls).toBe(1)
 expect((await f.jobs.reconcile(parent.id)).status).toBe('recovery_required');expect(modelCalls).toBe(1)
})


test('a legacy terminal campaign with an unattributed owned child cannot issue a residual continuation', async () => {
 const f=await fixture(async()=>({kind:'refine_skill',skillId:'skill_bionemo.predictor-interpretation',experimentId:f.experiment.id,trajectoryRefs:[f.experiment.id],repetitions:3,rationale:'Frozen evidence refinement.',expectedInformationGain:'Paired validation.'}));await multiple(f)
 const {CampaignSkillService}=await import('../skills/service');await new CampaignSkillService(f).initialize(f.campaign.id)
 const source=await f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'legacy-unbound-source',maxSteps:4,maximumTrajectories:5,maximumDiscoveryTrajectories:0,reservedReplayTrajectories:5,maximumKnowledgeRefreshes:0})
 const completed=await f.jobs.runOnce({jobId:source.id});expect(completed?.status).toBe('succeeded')
 const orphan=await f.jobs.enqueueDiscovery(f.experiment.id,{idempotencyKey:'legacy-unbound-child',iterations:1})
 // Reproduce a persisted older result that omitted an already owned child; no work is dispatched.
 await f.store.mutate(f.projectId,state=>{const child=state.jobs[orphan.id]!;child.payload.parentJobId=source.id;child.status='failed';child.result={modelCostUsd:.2};child.completedAt=new Date().toISOString()})
 await expect(f.controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'cannot-spend-unbound-residual',continuedFromJobId:source.id,maxSteps:1})).rejects.toThrow('no saved campaign step accounting')
 expect((await f.jobs.list()).filter(job=>job.payload.continuedFromJobId===source.id)).toHaveLength(0)
 expect(f.evaluations).toBe(0)
})

test('typed campaign recovery collects original completed child without invoking ordinary handler or model again',async()=>{
 const f=await fixture(),jobs=new PiJobController(f),controller=new CampaignController({...f,jobs})
 const {JobRecoveryRequired}=await import('../jobs')
 let ordinary=0,crash=true
 jobs.registerOperation('campaign_loop',{...controller.operation,run:async ctx=>{
  ordinary++
  return controller.handleJob({...ctx,lifecycle:{...ctx.lifecycle,checkpoint:async(phase,data)=>{
   if(crash&&phase==='campaign:step:1:completed'){crash=false;throw new JobRecoveryRequired('execution_unresolved','Offline interruption after original child completion')}
   return ctx.lifecycle.checkpoint(phase,data)
  }}})
 }})
 const parent=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'typed-original-receipt',maxSteps:3,maximumTrajectories:4,maximumKnowledgeRefreshes:0})
 const interrupted=await jobs.runOnce({jobId:parent.id})
 expect(interrupted?.status).toBe('recovery_required')
 const before=await f.store.read(f.projectId),child=Object.values(before.jobs).find(job=>job.payload.parentJobId===parent.id)!
 expect(child.status).toBe('succeeded')
 const turns=f.turns
 const recovered=await jobs.reconcileDetailed(parent.id)
 expect(recovered.job.status).toBe('succeeded')
 expect(recovered.job.result).toMatchObject({status:'deferred',boundary:'receipt_only_recovery_no_continuation',completedSteps:1})
 expect((recovered.job.result?.steps as any[])[0].result.jobId).toBe(child.id)
 expect(ordinary).toBe(1);expect(f.turns).toBe(turns)
 const after=await f.store.read(f.projectId)
 expect(Object.keys(after.jobs)).toEqual(Object.keys(before.jobs));expect(after.trials).toEqual(before.trials);expect(after.runs).toEqual(before.runs)
})

test('typed campaign recovery never treats a cancelled child label as original effect settlement',async()=>{
 const f=await fixture(),jobs=new PiJobController(f),controller=new CampaignController({...f,jobs})
 jobs.registerOperation('campaign_loop',controller.operation)
 const parent=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'cancelled-effect-gap',maxSteps:1,maximumTrajectories:2,maximumKnowledgeRefreshes:0})
 const {ResearchJobService}=await import('@autofold/science-core/job-service')
 const native=new ResearchJobService.Service(f.store),owner=await native.claim(f.projectId,30000,{eligible:candidate=>candidate.id===parent.id})
 const observation=await controller.observe(f.campaign.id,parent.id),proposal=iterate(observation,f.experiment.id)
 await native.checkpoint(f.projectId,parent.id,owner!.leaseId!,'campaign:job:start',{deadlineMs:Date.now()+30000})
 await native.checkpoint(f.projectId,parent.id,owner!.leaseId!,'campaign:step:1:observation',observation)
 await native.checkpoint(f.projectId,parent.id,owner!.leaseId!,'campaign:step:1:proposal',{move:proposal,modelCostUsd:0})
 const child=await jobs.enqueueDiscovery(f.experiment.id,{idempotencyKey:`campaign:${parent.id}:step:1:discovery`,parentJobId:parent.id,parentLeaseId:owner!.leaseId!,iterations:1})
 await jobs.cancel(child.id)
 const selected=await jobs.get(parent.id),before=await f.store.read(f.projectId),turns=f.turns
 const outcome=await controller.operation.recover({job:selected,signal:new AbortController().signal,operations:{} as any,readCheckpoint:async phase=>selected.checkpoints[phase]?.data})
 expect(outcome.kind).toBe('unresolved')
 if(outcome.kind==='unresolved')expect(outcome.effects).toContain(child.id)
 expect(await f.store.read(f.projectId)).toEqual(before);expect(f.turns).toBe(turns)
 const settlement=await jobs.reconcileDetailed(child.id)
 expect(settlement.outcomes[child.id]?.kind).toBe('complete')
 const {readJobAccounting}=await import('../jobs/accounting')
 expect((await readJobAccounting(f,await jobs.get(child.id))).modelCostUsd).toBe(0)
 const closed=await controller.operation.recover({job:selected,signal:new AbortController().signal,operations:{} as any,readCheckpoint:async phase=>selected.checkpoints[phase]?.data})
 expect(closed.kind).toBe('complete');expect(f.turns).toBe(turns)
 const after=await f.store.read(f.projectId)
 expect(after.trials).toEqual(before.trials);expect(after.runs).toEqual(before.runs);expect(Object.keys(after.jobs)).toEqual(Object.keys(before.jobs))
})


test('twelve-slot campaign executes six actual offline discovery trials and six independent paired replay arms',async()=>{
 const {ResearchPrograms}=await import('@autofold/science-core/programs')
 const {CampaignSkillService}=await import('../skills/service'),{CapabilityRefinementController,SkillShadowReplayController}=await import('../skills/controllers')
 let discovery=0,limit=0,refinements=0,arms=0,boundaries=0
 const f=await fixture(async({observation,authorization})=>{
  boundaries++
  if(authorization.remainingTrajectories===0)return {kind:'stop',rationale:'All twelve authorized offline trials are settled.',unresolvedQuestions:[]}
  if(discovery<6)return iterate(observation,f.experiment.id)
  expect(authorization).toMatchObject({remainingTrajectories:6,remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:6,ordinaryIterations:0})
  return {kind:'refine_skill',skillId:'skill_bionemo.predictor-interpretation',experimentId:f.experiment.id,repetitions:3,
   trajectoryRefs:observation.recentTrajectories.flatMap(t=>[t.trial.id,t.run!.id]),rationale:'Test explicit control guidance against the parent on the supplied offline trajectories.',expectedInformationGain:'Three independent matched-budget software fixture pairs; no scientific claim.'}
 },{scientistFactory:options=>({initialize:async()=>{limit=options.maximumEvaluations},status:async()=>({completedEvaluations:discovery,stopped:false,researchRequested:false}),context:async()=>({discovery}),systemPrompt:'CPU software fixture only',
  tools:()=>[{name:'evaluate_trial',label:'Offline trial',description:'Actual CPU fixture evaluation',parameters:Type.Object({}),execute:async()=>{
   const index=discovery+1,hypothesis='Ordinary CPU software fixture '+index
   const captured=await ResearchPrograms.author(options.workspace,{hypothesis,program:'"""Independent discovery fixture '+index+'"""\n',intent:'optimize',designAdapter:'mock'})
   const origin=options.origin as {jobId:string;leaseId:string}
   const trial=await options.research.createTrial(options.projectId,options.experimentId,{...captured,hypothesis,designAdapter:'mock',origin:{jobId:origin.jobId,phase:'ordinary:'+index}},origin)
   const result=await options.execution.evaluateTrial({trialId:trial.id,requestId:'ordinary:'+index,caller:origin,signal:options.signal})
   expect(result.run.status).toBe('succeeded');discovery++
   return {content:[{type:'text',text:'Trusted offline CPU receipt'}],details:{trialId:trial.id,runId:result.run.id}}
  }}]}),runtimeOptions:{streamFn:()=>stream(discovery<limit)}})
 // Two experiments require the real boundary proposal path; successful sole-experiment routing is tested with trusted native receipts in feedback.test.ts.
 await multiple(f)
 const skills=new CampaignSkillService(f),parent=(await skills.initialize(f.campaign.id)).find(v=>v.skillId==='skill_bionemo.predictor-interpretation')!
 const markdown=(await fs.readFile(path.join(f.workspace,parent.path),'utf8')).replace('version: 1','version: 2')+'\nReport independent equal-budget controls before interpreting a selected best draw.\n'
 const jobs=new PiJobController(f).registerSkills({refinement:new CapabilityRefinementController({...f,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{refinements++;return stream(true,'submit_skill',{markdown})}}}),
  replay:new SkillShadowReplayController({...f,allowMockPrograms:true,runtimeOptions:{accountingProvenance:'offline_fixture',streamFn:()=>{arms++;return stream(true,'submit_trial',{hypothesis:'Independent paired CPU fixture '+arms,program:'"""Distinct paired CPU program '+arms+'"""\n'})}}})})
 const controller=new CampaignController({...f,jobs,propose:f.controller.options.propose});jobs.registerHandler('campaign_loop',controller.handleJob)
 const parentJob=await controller.enqueueCampaign(f.campaign.id,{idempotencyKey:'actual-12-offline',maxSteps:8,maximumTrajectories:12,maximumDiscoveryTrajectories:6,reservedReplayTrajectories:6,discoveryBatchSize:1,maximumKnowledgeRefreshes:0})
 const completed=await jobs.runOnce({jobId:parentJob.id})
 expect(completed?.status).toBe('succeeded');expect(completed?.result).toMatchObject({remainingTrajectories:0,remainingDiscoveryTrajectories:0,remainingReservedReplayTrajectories:0})
 expect(discovery).toBe(6);expect(refinements).toBe(1);expect(arms).toBe(6)
 const state=await f.store.read(f.projectId),trials=Object.values(state.trials),runs=Object.values(state.runs)
 expect(trials).toHaveLength(12);expect(runs).toHaveLength(12);expect(runs.every(run=>run.status==='succeeded')).toBe(true)
 expect(trials.filter(trial=>trial.intent==='shadow_replay')).toHaveLength(6)
 expect(new Set(trials.map(trial=>trial.programHash)).size).toBe(12)
 const candidate=Object.values(state.skillVersions).find(v=>v.parentVersionId===parent.id)!
 expect(['active','rejected']).toContain(candidate.status)
 const validation=candidate.replay!;expect(validation.receiptPairs).toHaveLength(3);expect(validation.sameBudget).toBe(true)
 expect(await jobs.runOnce({jobId:parentJob.id})).toBeUndefined()
 expect(refinements).toBe(1);expect(arms).toBe(6);expect(discovery).toBe(6);expect(boundaries).toBe(8)
},60000)
