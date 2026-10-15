import {afterEach,expect,spyOn,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {OperationService} from '@autofold/science-core/operation-service'
import {ScientificExecution,LocalWorkerTransport} from '../execution'
import {PiJobController} from '../jobs'
import {JobInterrupted} from '../jobs/lease'
import {LiteratureReviewController} from '../literature'
import {KnowledgeReviewController} from '../knowledge-review-controller'
import {CampaignSkillService,CapabilityRefinementController,SkillShadowReplayController} from '../skills'
import {DEFAULT_MODEL,createSessionStore} from '../runtime'
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai'
import {AuxiliaryOperation,AuxiliaryProjectionPendingError} from './auxiliary-state'
import {ConnectorRegistry} from '../connectors'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const message=(name:string,args:any):AssistantMessage=>({role:'assistant',content:[{type:'toolCall',id:'call_'+crypto.randomUUID(),name,arguments:args}],stopReason:'toolUse',api:DEFAULT_MODEL.api,provider:DEFAULT_MODEL.provider,model:DEFAULT_MODEL.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:.02,cacheRead:0,cacheWrite:0,total:.02}}})
type Kind='knowledge_refresh'|'knowledge_review'|'capability_refinement'|'skill_shadow_replay'
async function fixture(kind:Kind){
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-typed-auxiliary-'));roots.push(workspace)
  const projectId='typed_auxiliary_offline',sessionDirectory=path.join(workspace,'pi'),store=new StorageResearchStore({directory:path.join(workspace,'research')}),research=new ResearchService.Service(store)
  let providerCalls=0,dispatches=0,beforePreflight:(()=>Promise<void>)|undefined;const queue:AssistantMessage[]=[]
  const runtimeOptions={accountingProvenance:'offline_fixture' as const,streamFn:()=>{providerCalls++;const value=queue.shift();if(!value)throw new Error('Forbidden extra fixture model call');const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'toolUse',message:value});stream.end(value);return stream}}
  const local=new LocalWorkerTransport(),execution=new ScientificExecution({workspace,projectId,research,transport:{kind:'local',preflight:async()=>{await beforePreflight?.()},dispatch:async input=>{dispatches++;return local.dispatch(input)}}})
  const campaign=await research.createCampaign(projectId,{objective:'Offline original auxiliary receipts'});await research.activateCampaign(projectId,campaign.id)
  const evaluator=(await execution.evaluators())[0]!,contract={version:1 as const,objective:'CPU fixture only',targetArtifactHash:'sha256:'+'a'.repeat(64),modality:'short_peptide' as const,budget:{maximumCandidates:3,gpuHours:0,wallTimeMinutes:1},evaluator:{...evaluator,fixedSeeds:[1,7],submissionSize:2}}
  const experiment=await research.createExperiment(projectId,campaign.id,{contract});await research.activateExperiment(projectId,experiment.id)
  const connectors=new ConnectorRegistry();connectors.register({id:'pubmed',name:'pubmed',domain:'literature',description:'Offline original fixture source',search:async()=>[],fetch:async()=>({title:'Original fixture source',abstract:'Matched controls remain necessary.'})})
  const options={workspace,projectId,sessionDirectory,store,research,execution,runtimeOptions,connectors,allowMockPrograms:true}
  const literature=new LiteratureReviewController(options),review=new KnowledgeReviewController(options),refinement=new CapabilityRefinementController(options),replay=new SkillShadowReplayController(options)
  const jobs=new PiJobController({...options,literature}).registerKnowledgeReview(review).registerSkills({refinement,replay})
  let job:any,crash:any,restore:()=>void,recover:(job:any)=>Promise<any>,operationId:string
  if(kind==='knowledge_refresh'){
    queue.push(message('fetch_literature',{source:'pubmed',id:'7'}),message('submit_review',{sources:[{key:'s',database:'pubmed',sourceId:'7',title:'Original fixture source',query:'fixture',excerpts:['Matched controls remain necessary.']}],claims:[{kind:'limitation',statement:'Matched controls remain necessary.',stance:'context',confidence:.6,evidence:[{sourceKey:'s',excerpt:'Matched controls remain necessary.'}]}],researchRequestUpdates:[],unresolvedQuestions:[]}))
    job=await jobs.enqueueLiterature(campaign.id,{idempotencyKey:'typed_literature'})
    const original=research.ingestLiteratureReview.bind(research);crash=spyOn(research,'ingestLiteratureReview').mockImplementation(async(...args)=>{await original(...args);throw new JobInterrupted('shutdown','Fixture crash after literature commit')});restore=()=>crash.mockRestore();recover=job=>literature.recover(job)
    operationId='op_'+hash(`${projectId}:${campaign.id}:${job.id}`)
  }else if(kind==='knowledge_review'){
    const ingest=await research.ingestLiteratureReview(projectId,campaign.id,{generatedBy:'independent_fixture_author',sources:[{key:'s',database:'pubmed',sourceId:'7',title:'Fixture source',query:'fixture',excerpts:['Matched controls remain necessary.']}],claims:[{kind:'limitation',statement:'Matched controls remain necessary.',stance:'context',confidence:.6,evidence:[{sourceKey:'s',excerpt:'Matched controls remain necessary.'}]}],unresolvedQuestions:[]})
    const claim=ingest.claims[0]!,source=ingest.records[0]!
    queue.push(message('read_knowledge',{id:source.id}),message('submit_reconciliation',{decisions:[{id:claim.id,expectedHash:ResearchService.knowledgeRecordHash(claim),status:'reviewed',rationale:'The original exact source supports this interpretation.',evidenceRefs:[source.id]}],campaignSummary:'Source interpretation remains distinct from measurement.',unresolvedQuestions:[]}))
    job=await jobs.enqueueKnowledgeReview(campaign.id,{idempotencyKey:'typed_review',claimIds:[claim.id]})
    const original=research.reconcileKnowledge.bind(research);crash=spyOn(research,'reconcileKnowledge').mockImplementation(async(...args)=>{await original(...args);throw new JobInterrupted('shutdown','Fixture crash after reviewer commit')});restore=()=>crash.mockRestore();recover=job=>review.recover(job)
    operationId='op_'+hash(projectId+':'+job.id)
  }else{
    const skills=new CampaignSkillService({...options,allowPlumbingOnly:true}),versions=await skills.initialize(campaign.id),parent=versions.find(v=>v.skillId==='skill_bionemo.predictor-interpretation')!,markdown=(await fs.readFile(path.join(workspace,parent.path),'utf8')).replace('version: 1','version: 2')+'\nFrozen comparisons require exact original receipts.\n'
    if(kind==='capability_refinement'){
      queue.push(message('submit_skill',{markdown}));job=await jobs.enqueueRefinement({idempotencyKey:'typed_refinement',campaignId:campaign.id,skillId:parent.skillId,trajectoryRefs:[experiment.id]})
      const original=refinement.skills.propose.bind(refinement.skills);crash=spyOn(refinement.skills,'propose').mockImplementation(async(...args)=>{await original(...args);throw new JobInterrupted('shutdown','Fixture crash after refinement commit')});restore=()=>crash.mockRestore();recover=job=>refinement.recover(job);operationId='op_'+hash(projectId+':refinement:'+job.id)
    }else{
      const candidate=await skills.propose(campaign.id,parent.skillId,{parentVersionId:parent.id,markdown,createdBy:'fixture'})
      for(let i=0;i<6;i++)queue.push(message('write',{path:'trial.py',content:'"""Independent fixture program '+i+'"""\n'}),message('submit_trial',{programPath:'trial.py',hypothesis:'Independent CPU fixture arm'}))
      job=await jobs.enqueueShadowReplay({idempotencyKey:'typed_replay',campaignId:campaign.id,experimentId:experiment.id,candidateVersionId:candidate.id,repetitions:3})
      const original=replay.skills.evaluate.bind(replay.skills);crash=spyOn(replay.skills,'evaluate').mockImplementation(async(...args)=>{await original(...args);throw new JobInterrupted('shutdown','Fixture crash after replay commit')});restore=()=>crash.mockRestore();recover=job=>replay.recover(job);operationId='op_'+hash(projectId+':shadow:'+job.id)
    }
  }
  return{...options,jobs,job,operationId,restore:restore!,recover:recover!,calls:()=>({providerCalls,dispatches}),setPreflight:(hook:()=>Promise<void>)=>{beforePreflight=hook}}
}
for(const kind of ['knowledge_refresh','knowledge_review','capability_refinement','skill_shadow_replay'] as const)test(`${kind} crash after native commit recovers the exact original result and canonical settlement without model or launch`,async()=>{
  const f=await fixture(kind)
  try{
    const first=await f.jobs.runOnce({jobId:f.job.id});expect(first?.status).toBe('interrupted')
    const interrupted=await f.jobs.get(f.job.id);expect(interrupted.checkpoints['pi:job:result']).toBeUndefined()
    const before=f.calls(),snapshot=await f.store.read(f.projectId)
    expect(snapshot.operations[f.operationId]!.outcome).toBe('pending')
    f.restore()
    const denied=spyOn(f.execution,'evaluateTrial').mockImplementation(async()=>{throw new Error('Receipt recovery cannot dispatch')})
    try{
      const result=await f.jobs.reconcile(f.job.id)
      expect(result.status).toBe('succeeded');expect(f.calls()).toEqual(before);expect(denied).not.toHaveBeenCalled()
      expect(result.result!.modelCostUsd).toBeGreaterThan(0)
      const canonical=(await f.store.read(f.projectId)).operations[f.operationId]!
      expect(canonical.outcome).toBe('succeeded');expect(canonical.accounting).toBe('settled');expect(canonical.settlement).toBe('settled');expect(canonical.owner).toBeUndefined()
      expect((await f.recover(await f.jobs.get(f.job.id))).kind).toBe('complete');expect(f.calls()).toEqual(before)
    }finally{denied.mockRestore()}
  }finally{f.restore()}
},30000)

test('an original committed auxiliary receipt cannot settle when provider usage is unknown',async()=>{
  const f=await fixture('knowledge_refresh')
  try{
    await f.jobs.runOnce({jobId:f.job.id});f.restore();const job=await f.jobs.get(f.job.id)
    const sessions=createSessionStore(path.join(f.sessionDirectory,'sessions.sqlite'))
    try{const session=(await sessions.get(job.payload.sessionId))!;session.modelRequests!.req_unknown={status:'unknown',model:session.modelSelection,purpose:'turn',startedAt:Date.now()};await sessions.save(session)}finally{sessions.close()}
    const before=f.calls(),outcome=await f.recover(job)
    expect(outcome.kind).toBe('unresolved');expect(outcome.accounting.length).toBeGreaterThan(0);expect(f.calls()).toEqual(before)
    expect((await f.store.read(f.projectId)).operations[f.operationId]!.accounting).toBe('pending')
  }finally{f.restore()}
})

test('canonical epoch fencing rejects stale saves and failed JSON export is explicitly rebuildable from committed state',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-operation-projection-'));roots.push(workspace)
  const host={workspace,projectId:'projection_offline',store:new StorageResearchStore({directory:path.join(workspace,'research')})},id='op_projection',file=path.join(workspace,'projection.json')
  const operation=await AuxiliaryOperation.open(host,{id,kind:'fixture',identity:{fixture:'original'},projection:file})
  await fs.mkdir(file)
  await expect(operation.save({original:'durable'},'accepted')).rejects.toThrow()
  expect(operation.signal.aborted).toBe(true);expect(operation.signal.reason).toBeInstanceOf(AuxiliaryProjectionPendingError)
  await operation.close()
  const before=await host.store.read(host.projectId)
  expect(before.operations[id]!.state).toEqual({original:'durable'});expect(Object.values(before.operationOutbox).some(item=>item.status==='pending')).toBe(true)
  await fs.rm(file,{recursive:true})
  await AuxiliaryOperation.rebuildProjection(host,id)
  expect(JSON.parse(await fs.readFile(file,'utf8'))).toEqual({original:'durable'})
  expect(Object.values((await host.store.read(host.projectId)).operationOutbox).every(item=>item.status==='acknowledged'||item.status==='superseded')).toBe(true)
  const old=await AuxiliaryOperation.open(host,{id,kind:'fixture',identity:{fixture:'original'},projection:file})
  await host.store.mutate(host.projectId,state=>{state.operations[id]!.owner!.expiresAt=new Date(Date.now()-1).toISOString()})
  const service=new OperationService.Service(host.store),replacement=await service.acquire(host.projectId,id,{mode:'run',leaseMs:30000})
  await expect(old.save({original:'stale'})).rejects.toThrow();await expect(old.check()).rejects.toThrow()
  expect(JSON.parse(await fs.readFile(file,'utf8'))).toEqual({original:'durable'})
  await old.close();await service.release(replacement)
})

test('legacy JSON-only operations stay frozen without creating canonical state or a session',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-legacy-operation-'));roots.push(workspace)
  const host={workspace,projectId:'legacy_offline',store:new StorageResearchStore({directory:path.join(workspace,'research')})},file=path.join(workspace,'legacy.json')
  await fs.writeFile(file,JSON.stringify({format:'legacy',input:{fixture:'original'}}))
  await expect(AuxiliaryOperation.open(host,{id:'op_legacy',kind:'fixture',identity:{fixture:'original'},projection:file})).rejects.toThrow('explicit migration')
  expect((await host.store.read(host.projectId)).operations).toEqual({})
  expect(await fs.readFile(file,'utf8')).toBe(JSON.stringify({format:'legacy',input:{fixture:'original'}}))
})


test('shadow first launch rejects a replaced auxiliary epoch while its native job epoch remains live',async()=>{
  const f=await fixture('skill_shadow_replay');f.restore()
  const operations=new OperationService.Service(f.store)
  let replacement:Awaited<ReturnType<typeof operations.acquire>>|undefined,nativeEpoch:string|undefined
  f.setPreflight(async()=>{
    const before=await f.store.read(f.projectId),job=before.jobs[f.job.id]!
    nativeEpoch=job.leaseId;expect(nativeEpoch).toBeString();expect(job.status).toBe('running')
    expect(Date.parse(job.leaseExpiresAt!)).toBeGreaterThan(Date.now())
    await f.store.mutate(f.projectId,state=>{state.operations[f.operationId]!.owner!.expiresAt=new Date(Date.now()-1).toISOString()})
    replacement=await operations.acquire(f.projectId,f.operationId,{mode:'run',leaseMs:30000,jobLeaseId:nativeEpoch})
    const after=await f.store.read(f.projectId)
    expect(after.jobs[f.job.id]!.leaseId).toBe(nativeEpoch)
  })
  try{
    const result=await f.jobs.runOnce({jobId:f.job.id})
    expect(result?.status).not.toBe('succeeded');expect(replacement).toBeDefined()
    expect(f.calls()).toEqual({providerCalls:2,dispatches:0})
    const state=await f.store.read(f.projectId)
    expect(Object.values(state.evaluations)).toHaveLength(0)
    expect(state.operations[f.operationId]!.epoch).toBe(replacement!.epoch)
  }finally{if(replacement)await operations.release(replacement)}
},30000)

test('failed terminal evidence survives broken JSON export and rebuild without becoming success',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-failed-projection-'));roots.push(workspace)
  const host={workspace,projectId:'failed_projection_offline',store:new StorageResearchStore({directory:path.join(workspace,'research')})},id='op_failed_projection',file=path.join(workspace,'projection.json')
  const operation=await AuxiliaryOperation.open(host,{id,kind:'skill_shadow_replay',identity:{fixture:'original'},projection:file})
  await operation.save({guideStatus:'unevaluated'})
  await fs.rm(file);await fs.mkdir(file)
  await expect(operation.complete({guideStatus:'unevaluated'},{outcome:'failed',reason:'authoring budget exhausted',effects:{kind:'none',requestIds:[]},accounting:{kind:'known',source:'fixture',modelCostUsd:.02,sessionIds:['ses_original']}})).rejects.toBeInstanceOf(AuxiliaryProjectionPendingError)
  await operation.close()
  const original=await new OperationService.Service(host.store).read(host.projectId,id)
  expect(original).toMatchObject({effect:'none',accounting:'settled',outcome:'failed',settlement:'settled'})
  await fs.rm(file,{recursive:true});await AuxiliaryOperation.rebuildProjection(host,id)
  const rebuilt=await new OperationService.Service(host.store).read(host.projectId,id)
  expect(rebuilt).toMatchObject({effect:'none',accounting:'settled',outcome:'failed',settlement:'settled'})
  expect(rebuilt?.state).toEqual(original?.state)
  expect(JSON.parse(await fs.readFile(file,'utf8')).terminalEvidence.outcome).toBe('failed')
})
