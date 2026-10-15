import {expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {ResearchDomain} from '@autofold/science-core/domain'
import {PiRuntime, SqliteSessionStore, DEFAULT_MODEL_SELECTION} from '../runtime'
import {StorageResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchJobService} from '@autofold/science-core/job-service'
import {OperationService} from '@autofold/science-core/operation-service'
import {captureJobAccountingBaseline, readJobAccounting, readAccountingSession, sessionProviderAccounting, aggregateProviderAccounting, readTreeProviderAccounting} from './accounting'

test('unresolved provider billing cannot become a fresh baseline or a zero or partial child result', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-unknown-accounting-'))
  const host = {workspace, projectId:'offline_unknown', sessionDirectory:path.join(workspace,'pi')}
  const sessions = new SqliteSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
  try {
    const runtime = new PiRuntime({store:sessions})
    const session = await runtime.create({id:'ses_accounting_unknown', metadata:{projectId:host.projectId}})
    session.status = 'failed'; session.usage.costUsd = .11776617
    session.modelRequests = {req_unknown:{status:'unknown', model:session.modelSelection, purpose:'turn', startedAt:Date.now()}}
    await sessions.save(session)
    const now = new Date().toISOString()
    const job = {id:'job_unknown',projectId:host.projectId,status:'failed',attempts:1,createdAt:now,updatedAt:now,checkpoints:{},payload:{kind:'autoresearch',sessionId:session.id,modelSelection:DEFAULT_MODEL_SELECTION}} as unknown as ResearchDomain.Job
    await expect(captureJobAccountingBaseline(host,job)).rejects.toThrow('unresolved usage')
    for (const modelCostUsd of [0,.11776617]) await expect(readJobAccounting(host,{...job,result:{modelCostUsd}})).rejects.toThrow('unresolved usage')
    const baseline = {jobId:job.id,sessions:{[session.id]:{costUsd:0,existed:true}}}
    await expect(readJobAccounting(host,job,{baseline})).rejects.toThrow('unresolved usage')
    delete session.modelRequests // Existing completed legacy receipts keep their measured usage.
    await sessions.save(session)
    expect((await readJobAccounting(host,job,{baseline})).modelCostUsd).toBe(.11776617)
  } finally {sessions.close(); await fs.rm(workspace,{recursive:true,force:true})}
})


test('cancelled unadmitted zero requires an exact settled canonical receipt; missing or mismatched proof stays held',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-no-admission-accounting-'))
  const host={workspace,projectId:'offline_no_admission',sessionDirectory:path.join(workspace,'pi'),store:new StorageResearchStore({directory:path.join(workspace,'research')})}
  try{
    const jobs=new ResearchJobService.Service(host.store),operations=new OperationService.Service(host.store)
    const campaign=await new ResearchService.Service(host.store).createCampaign(host.projectId,{objective:'Offline unadmitted cancellation proof'})
    const queued=await jobs.enqueue(host.projectId,{idempotencyKey:'original_cancelled',payload:{runtime:'autofold-pi.v1',kind:'knowledge_refresh',campaignId:campaign.id,maxSources:1,maxClaims:1,sessionId:'ses_no_admission',modelSelection:DEFAULT_MODEL_SELECTION}})
    const cancelled=await jobs.cancel(host.projectId,queued.id)
    await expect(readJobAccounting(host,cancelled)).rejects.toThrow('no durable usage baseline')
    const id='op_job_'+queued.id.slice(4),handle=await operations.acquire(host.projectId,id,{mode:'settle',leaseMs:30000})
    const committed=await operations.update(handle,{phase:'cancelled',state:{jobId:queued.id,result:{reason:'cancelled_before_admission',modelCostUsd:0,consumedTrajectories:0}},effect:'none',accounting:'settled',settlement:'settled',outcome:'failed'})
    await operations.release(committed.handle)
    expect(await readJobAccounting(host,cancelled)).toEqual({jobId:queued.id,modelCostUsd:0,consumedTrajectories:0,sessions:{}})
    await expect(readJobAccounting(host,{...cancelled,payload:{...cancelled.payload,sessionId:'ses_changed'}})).rejects.toThrow('no durable usage baseline')
    await expect(fs.access(path.join(host.sessionDirectory,'sessions.sqlite'))).rejects.toMatchObject({code:'ENOENT'})
    const sessions=new SqliteSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
    try{
      const runtime=new PiRuntime({store:sessions}),session=await runtime.create({id:'ses_no_admission',metadata:{projectId:host.projectId}})
      session.status='failed';session.modelRequests={req_unknown:{status:'unknown',model:session.modelSelection,purpose:'turn',startedAt:Date.now()}};await sessions.save(session)
      await expect(readJobAccounting(host,cancelled)).rejects.toThrow('unresolved usage')
    }finally{sessions.close()}

  }finally{await fs.rm(workspace,{recursive:true,force:true})}
})

test('canonical auxiliary baseline wins over a conflicting JSON projection',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-canonical-baseline-'))
  const host={workspace,projectId:'offline_canonical_baseline',sessionDirectory:path.join(workspace,'pi'),store:new StorageResearchStore({directory:path.join(workspace,'research')})},sessions=new SqliteSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
  try{
    const now=new Date().toISOString(),job={id:'job_canonical',projectId:host.projectId,status:'failed',attempts:1,createdAt:now,updatedAt:now,checkpoints:{},payload:{runtime:'autofold-pi.v1',kind:'knowledge_refresh',campaignId:'cmp_fixture',sessionId:'ses_canonical',modelSelection:DEFAULT_MODEL_SELECTION}} as unknown as ResearchDomain.Job
    const key=(await import('node:crypto')).createHash('sha256').update(`${host.projectId}:cmp_fixture:${job.id}`).digest('hex')
    const operations=new OperationService.Service(host.store)
    await operations.open(host.projectId,{id:'op_'+key,kind:'knowledge_refresh',identity:{fixture:'baseline'},state:{operationId:job.id,childSessionId:'ses_canonical',baselineCostUsd:.1}})
    const file=path.join(workspace,'.autofold/literature',key,'review.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({operationId:job.id,childSessionId:'ses_canonical',baselineCostUsd:.2}))
    const runtime=new PiRuntime({store:sessions}),session=await runtime.create({id:'ses_canonical',metadata:{projectId:host.projectId}})
    session.status='completed';session.usage.costUsd=.3;await sessions.save(session)
    expect((await readJobAccounting(host,job)).modelCostUsd).toBeCloseTo(.2)
  }finally{sessions.close();await fs.rm(workspace,{recursive:true,force:true})}
})

test('fresh shared literature and review baselines account through original role operations without rewriting old provider provenance',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-shared-baseline-accounting-'))
 const host={workspace,projectId:'offline_shared_baseline',sessionDirectory:path.join(workspace,'pi'),store:new StorageResearchStore({directory:path.join(workspace,'research')})}
 const sessions=new SqliteSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
 try{
  const {createHash}=await import('node:crypto'),operations=new OperationService.Service(host.store),now=new Date().toISOString()
  for(const kind of ['knowledge_refresh','knowledge_review'] as const){
   const job={id:'job_'+kind,projectId:host.projectId,status:'failed',attempts:1,createdAt:now,updatedAt:now,checkpoints:{},payload:{runtime:'autofold-pi.v1',kind,campaignId:'cmp_fixture',sessionId:'ses_'+kind,modelSelection:DEFAULT_MODEL_SELECTION}} as unknown as ResearchDomain.Job
   const key=createHash('sha256').update(kind==='knowledge_refresh'?`${host.projectId}:cmp_fixture:${job.id}`:`${host.projectId}:${job.id}`).digest('hex')
   const baseline={costUsd:.1,turns:2,toolCalls:3,deadlineMs:Date.now()+60_000}
   const state=kind==='knowledge_refresh'?{operationId:job.id,childSessionId:job.payload.sessionId,hostSession:baseline}:{checkpoints:{budget:baseline}}
   await operations.open(host.projectId,{id:'op_'+key,kind,identity:{fixture:'shared-baseline'},state})
   const runtime=new PiRuntime({store:sessions}),session=await runtime.create({id:job.payload.sessionId as string,metadata:{projectId:host.projectId}})
   session.status='completed';session.usage.costUsd=.3;await sessions.save(session)
   const originalSession=JSON.stringify(await sessions.get(session.id)),originalRecord=JSON.stringify(await operations.read(host.projectId,'op_'+key))
   const receipt=await readJobAccounting(host,job)
   expect(receipt.modelCostUsd).toBeCloseTo(.2);expect(receipt.providerAccounting?.status).toBe('unknown')
   expect(JSON.stringify(await sessions.get(session.id))).toBe(originalSession)
   expect(JSON.stringify(await operations.read(host.projectId,'op_'+key))).toBe(originalRecord)
  }
 }finally{sessions.close();await fs.rm(workspace,{recursive:true,force:true})}
})

test('a matching zero SDK total never manufactures missing historical request IDs or hides a real reported bill',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-no-rebased-provider-ids-'))
 const host={workspace,projectId:'offline_exact_provider_baseline',sessionDirectory:path.join(workspace,'pi')},sessions=new SqliteSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
 try{
  const runtime=new PiRuntime({store:sessions}),session=await runtime.create({id:'ses_zero_estimate',metadata:{projectId:host.projectId}}),now=new Date().toISOString()
  session.modelRequests={original_paid:{status:'settled',model:session.modelSelection,purpose:'turn',startedAt:1,costKind:'sdk_estimate',estimatedCostUsd:0,providerBilling:{source:'openrouter_stream',status:'reported',reportedCostUsd:.2,upstreamRequestId:'invoice_original_paid',evidenceHash:'sha256:'+ 'a'.repeat(64)}}};await sessions.save(session)
  const original=JSON.stringify(await sessions.get(session.id))
  for(const exactIds of [undefined,[]] as Array<string[]|undefined>){
   const native={completedEvaluations:0,costUsd:0,deadlineMs:Date.now()+60_000,...(exactIds?{originalRequestIds:exactIds}:{})}
   const job={id:'job_provider_zero',projectId:host.projectId,status:'failed',attempts:2,createdAt:now,updatedAt:now,checkpoints:{'pi:job:start':{data:native}},payload:{kind:'autoresearch',sessionId:session.id,modelSelection:DEFAULT_MODEL_SELECTION}} as unknown as ResearchDomain.Job
   const baseline=await captureJobAccountingBaseline(host,job)
   expect(baseline.sessions[session.id]!.originalRequestIds).toEqual(exactIds)
   const accounted=await readJobAccounting(host,job,{baseline})
   expect(accounted.modelCostUsd).toBe(0)
   expect(accounted.providerAccounting?.status).toBe(exactIds?'reported':'unknown')
   if(exactIds)expect(accounted.providerAccounting?.reportedCostUsd).toBe(.2)
   expect(native.costUsd).toBe(0);expect(JSON.stringify(await sessions.get(session.id))).toBe(original)
  }
 }finally{sessions.close();await fs.rm(workspace,{recursive:true,force:true})}
})


test('cancelled unadmitted shared-session zero preserves attributed historical intervals and rejects gaps or new unknown usage', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(),'autofold-attributed-cancel-'))
  const host = {workspace, projectId:'offline_attributed_cancel', sessionDirectory:path.join(workspace,'pi'), store:new StorageResearchStore({directory:path.join(workspace,'research')})}
  const sessions = new SqliteSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
  try {
    const research = new ResearchService.Service(host.store), jobs = new ResearchJobService.Service(host.store), operations = new OperationService.Service(host.store)
    const campaign = await research.createCampaign(host.projectId,{objective:'Original cancellation interval fixture'})
    const payload = {runtime:'autofold-pi.v1', kind:'knowledge_refresh' as const, campaignId:campaign.id, maxSources:1, maxClaims:1, sessionId:'ses_shared_attributed', modelSelection:DEFAULT_MODEL_SELECTION}
    const prior = await jobs.enqueue(host.projectId,{idempotencyKey:'prior-attributed', payload}), owner = (await jobs.claim(host.projectId,30000))!
    await jobs.checkpoint(host.projectId,prior.id,owner.leaseId!,'pi:accounting:lease:'+owner.leaseId,{jobId:prior.id,leaseId:owner.leaseId})
    await jobs.checkpoint(host.projectId,prior.id,owner.leaseId!,'pi:accounting:settlement:'+owner.leaseId,{jobId:prior.id,modelCostUsd:.125,sessions:{[payload.sessionId]:{baselineCostUsd:0,costUsd:.125}}})
    await jobs.succeed(host.projectId,prior.id,owner.leaseId!,{modelCostUsd:.125})
    const runtime = new PiRuntime({store:sessions}), session = await runtime.create({id:payload.sessionId,metadata:{projectId:host.projectId}})
    session.status='completed';session.usage.costUsd=.125;await sessions.save(session)
    const queued = await jobs.enqueue(host.projectId,{idempotencyKey:'no-admission-followup',payload}), cancelled = await jobs.cancel(host.projectId,queued.id)
    const handle = await operations.acquire(host.projectId,'op_job_'+queued.id.slice(4),{mode:'settle',leaseMs:30000})
    const saved = await operations.update(handle,{phase:'cancelled',state:{result:{reason:'cancelled_before_admission',modelCostUsd:0,consumedTrajectories:0}},effect:'none',accounting:'settled',settlement:'settled'})
    await operations.release(saved.handle)
    expect((await readJobAccounting(host,cancelled)).modelCostUsd).toBe(0)
    session.usage.costUsd=.15;await sessions.save(session)
    await expect(readJobAccounting(host,cancelled)).rejects.toThrow('unattributed original transcript usage')
    session.usage.costUsd=.125;session.modelRequests={req_new_unknown:{status:'unknown',model:session.modelSelection,purpose:'turn',startedAt:Date.now()}};await sessions.save(session)
    await expect(readJobAccounting(host,cancelled)).rejects.toThrow('unresolved usage')
  } finally {sessions.close();await fs.rm(workspace,{recursive:true,force:true})}
})


test('reported provider receipts use original request baselines independently of SDK estimates and preserve unknowns',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-provider-accounting-'))
  const host={workspace,projectId:'offline_provider',sessionDirectory:path.join(workspace,'pi')}
  const {createSessionStore}=await import('../runtime')
  const sessions=createSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
  try{
    const runtime=new PiRuntime({store:sessions}),session=await runtime.create({id:'ses_provider_sum',metadata:{projectId:host.projectId}})
    const req=(upstream:string,cost:number)=>({status:'settled' as const,model:session.modelSelection,purpose:'turn' as const,startedAt:1,reportedCostUsd:.1,costKind:'sdk_estimate' as const,estimatedCostUsd:.1,
      providerBilling:{source:'openrouter_stream' as const,upstreamRequestId:upstream,routedProvider:'fixture',reportedCostUsd:cost,status:'reported' as const,evidenceHash:'sha256:'+upstream}})
    session.status='completed';session.modelRequests={prior:req('original_prior',.2)};session.usage.costUsd=.1;session.usage.turns=1;await sessions.save(session)
    const now=new Date().toISOString(),job={id:'job_provider',projectId:host.projectId,status:'running',attempts:1,createdAt:now,updatedAt:now,checkpoints:{},payload:{kind:'autoresearch',sessionId:session.id,modelSelection:DEFAULT_MODEL_SELECTION}} as unknown as ResearchDomain.Job
    const baseline=await captureJobAccountingBaseline(host,job)
    expect(baseline.sessions[session.id]?.originalRequestIds).toEqual(['prior'])
    session.modelRequests.fresh=req('original_fresh',.35);session.usage.costUsd=.2;session.usage.turns=2;await sessions.save(session)
    expect((await readAccountingSession(host,session.id))?.messages).toEqual([])
    const receipt=await readJobAccounting(host,job,{baseline})
    expect(receipt.modelCostUsd).toBeCloseTo(.1)
    expect(receipt.providerAccounting).toMatchObject({status:'reported',reportedCostUsd:.35,knownReportedCostUsd:.35,originalRequestIds:[session.id+':fresh'],upstreamRequestIds:['original_fresh'],unknownRequestIds:[]})
    const pure=sessionProviderAccounting(session.id,session,['prior'])
    expect(aggregateProviderAccounting([{identity:job.id,accounting:pure}]).reportedCostUsd).toBe(.35)
    expect(()=>aggregateProviderAccounting([{identity:'one',accounting:pure},{identity:'two',accounting:pure}])).toThrow('duplicate original provider request')
    expect(()=>aggregateProviderAccounting([{identity:'one',accounting:pure},{identity:'two',accounting:{...pure,originalRequestIds:['another_session:another_request']}}])).toThrow('duplicate upstream provider receipt')
    const repeated={...session,modelRequests:{...session.modelRequests,fresh:{...session.modelRequests.fresh,providerBilling:{...session.modelRequests.fresh.providerBilling!,upstreamRequestId:'original_prior'}}}}
    expect(()=>sessionProviderAccounting(session.id,repeated,['prior'])).toThrow('duplicate upstream provider receipt')
    const mixed=aggregateProviderAccounting([{identity:'known',accounting:pure},{identity:'legacy'}])
    expect(mixed).toMatchObject({status:'unknown',reportedCostUsd:null,knownReportedCostUsd:.35})
    const legacy=await readJobAccounting(host,job,{baseline:{jobId:job.id,sessions:{[session.id]:{costUsd:.1,existed:true}}}})
    expect(legacy.providerAccounting).toMatchObject({status:'unknown',reportedCostUsd:null})
    session.modelRequests.fresh.providerBilling={...session.modelRequests.fresh.providerBilling!,status:'unknown',reportedCostUsd:null};await sessions.save(session)
    expect((await readJobAccounting(host,job,{baseline})).providerAccounting).toMatchObject({status:'unknown',reportedCostUsd:null,knownReportedCostUsd:0})
  }finally{sessions.close();await fs.rm(workspace,{recursive:true,force:true})}
})


test('parent reported billing sums only exact original supervisor and child receipts without estimate comparison',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-provider-tree-'))
  const host={workspace,projectId:'offline_provider_tree',sessionDirectory:path.join(workspace,'pi'),store:new StorageResearchStore({directory:path.join(workspace,'research')})}
  const {createSessionStore}=await import('../runtime');const sessions=createSessionStore(path.join(host.sessionDirectory,'sessions.sqlite'))
  try{
    const research=new ResearchService.Service(host.store),jobs=new ResearchJobService.Service(host.store)
    const campaign=await research.createCampaign(host.projectId,{objective:'Original reported provider receipt tree'})
    const payload={runtime:'autofold-pi.v1',modelSelection:DEFAULT_MODEL_SELECTION}
    const parent=await jobs.enqueue(host.projectId,{idempotencyKey:'reported-owner',payload:{...payload,kind:'campaign_loop',campaignId:campaign.id,sessionId:'ses_reported_parent',maxSteps:1}})
    const owner=(await jobs.claim(host.projectId,30000,{eligible:j=>j.id===parent.id}))!
    await jobs.checkpoint(host.projectId,parent.id,owner.leaseId!,'campaign:provider:start',{jobId:parent.id,sessionId:'ses_reported_parent',existed:false,originalRequestIds:[]})
    const runtime=new PiRuntime({store:sessions})
    async function receipt(id:string,actual:number){
      const session=await runtime.create({id,metadata:{projectId:host.projectId}});session.status='completed';session.usage.costUsd=.01;session.usage.turns=1
      session.modelRequests={original:{status:'settled',model:session.modelSelection,purpose:'turn',startedAt:1,reportedCostUsd:.01,costKind:'sdk_estimate',estimatedCostUsd:.01,
        providerBilling:{source:'openrouter_stream',upstreamRequestId:'upstream_'+id,routedProvider:'fixture',status:'reported',reportedCostUsd:actual,evidenceHash:'sha256:'+id}}}
      await sessions.save(session)
    }
    await receipt('ses_reported_parent',.05)
    for(const [index,actual] of [.15,.25].entries()){
      const id='ses_reported_child_'+index
      const child=await jobs.enqueue(host.projectId,{idempotencyKey:'reported-child-'+index,parentLeaseId:owner.leaseId!,payload:{...payload,kind:'knowledge_refresh',campaignId:campaign.id,maxSources:1,maxClaims:1,sessionId:id,parentJobId:parent.id,parentLeaseId:owner.leaseId!}})
      const childOwner=(await jobs.claim(host.projectId,30000,{eligible:j=>j.id===child.id}))!
      const baseline=await captureJobAccountingBaseline(host,childOwner)
      await jobs.checkpoint(host.projectId,child.id,childOwner.leaseId!,'pi:accounting:start',{...baseline})
      await receipt(id,actual)
      const accounted=await readJobAccounting(host,childOwner,{baseline})
      await jobs.checkpoint(host.projectId,child.id,childOwner.leaseId!,'pi:accounting:lease:'+childOwner.leaseId,{jobId:child.id,leaseId:childOwner.leaseId})
      await jobs.checkpoint(host.projectId,child.id,childOwner.leaseId!,'pi:accounting:settlement:'+childOwner.leaseId,{...accounted})
      await jobs.succeed(host.projectId,child.id,childOwner.leaseId!,{modelCostUsd:.01})
    }
    const tree=await readTreeProviderAccounting(host,await jobs.get(host.projectId,parent.id))
    expect(tree).toMatchObject({status:'reported',reportedCostUsd:.45,knownReportedCostUsd:.45,unknownRequestIds:[]})
    expect(tree.originalRequestIds).toHaveLength(3);expect(tree.upstreamRequestIds).toHaveLength(3)
    const original=(await host.store.read(host.projectId)).jobs[parent.id]!
    const legacy={...original,checkpoints:{...original.checkpoints}};delete legacy.checkpoints['campaign:provider:start']
    const held=await readTreeProviderAccounting(host,legacy)
    expect(held.status).toBe('unknown');expect(held.reportedCostUsd).toBeNull();expect(held.knownReportedCostUsd).toBeCloseTo(.4)
  }finally{sessions.close();await fs.rm(workspace,{recursive:true,force:true})}
})
