import {withNativeSearch} from './execution/native-fixture'
import { describe, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { offlineDemo } from './demo'
import { Application } from './application'
import { createHandler } from './server'

describe('Autofold Pi backend integration', () => {
  test('actual Pi tools execute the Python worker and survive scientific SQLite reopen', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-pi-acceptance-'))
    try {
      const result = await offlineDemo(workspace)
      expect(result.status).toBe('passed')
      expect(result.biologicalEvidence).toBe(false)
      expect(result.scientificStateReopened).toBe(true)
      expect(result.modelTurns).toBe(5)
    } finally { await fs.rm(workspace, { recursive: true, force: true }) }
  }, 30_000)

  test('HTTP host keeps workspace fixed and rejects cross-origin mutation', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-pi-http-'))
    try {
      const app = new Application({ workspace })
      const handler = createHandler(app)
      const authenticated = createHandler(app, { token: 'test-only', allowedOrigins: ['http://localhost:5173'] })
      const preflight = await authenticated(new Request('http://127.0.0.1:4096/research/campaigns', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }))
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      expect((await authenticated(new Request('http://127.0.0.1:4096/research/status'))).status).toBe(401)
      const rebound = await handler(new Request('http://unrelated.example:4096/health'))
      expect(rebound.status).toBe(403)
      const health = await handler(new Request('http://127.0.0.1:4096/health'))
      expect(await health.json()).toMatchObject({ ok: true, runtime: 'pi', version: '1.0.1', worker: {status:'stopped',consecutiveFailures:0} })
      const rejected = await handler(new Request('http://127.0.0.1:4096/research/campaigns', { method: 'POST', headers: { origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'Unwanted campaign' }) }))
      expect(rejected.status).toBe(403)
      expect((await app.research.listCampaigns(app.projectId)).length).toBe(0)
      const response = await handler(new Request('http://127.0.0.1:4096/research/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'Test host-scoped campaign' }) }))
      expect(response.status).toBe(201)
      expect((await app.research.listCampaigns(app.projectId)).length).toBe(1)
    } finally { await fs.rm(workspace, { recursive: true, force: true }) }
  })
})

test('direct Application scientist port exposes bounded attributable knowledge with no science effects', async () => {
 const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-direct-knowledge-'))
 try {
  const app = new Application({workspace}), experiment = await app.createMockExperiment('Read-only knowledge port fixture')
  await app.store.mutate(app.projectId, state => {
   for (let index = 0; index < 35; index++) {
    const id = 'lit_app_' + index
    state.literature[id] = {id, campaignId: experiment.campaignId, database: 'pubmed', sourceId: String(index), title: index === 0 ? 'Earliest direct knowledge needle' : 'Later unrelated ' + index,
     query: 'fixture', contentHash: 'sha256:' + 'b'.repeat(64), excerpts: ['Attributed direct-port observation.'], retrievedAt: new Date(Date.UTC(2026,0,1,0,0,index)).toISOString()}
   }
  })
  const before = JSON.stringify(await app.store.read(app.projectId)), port = app.science(experiment.id)
  const found = await port.queryKnowledge!({query: 'Earliest direct knowledge needle'}) as any
  expect(found.items[0].id).toBe('lit_app_0')
  expect((await port.readKnowledge!({id: 'lit_app_0'}) as any).sources.items[0].contentHash).toBe('sha256:' + 'b'.repeat(64))
  const context = await port.context() as any
  expect(context.decisionMemory.sourceManifest.cutoff.sourceCount).toBeGreaterThanOrEqual(35)
  expect(JSON.stringify(await app.store.read(app.projectId))).toBe(before)
 } finally {await fs.rm(workspace, {recursive: true, force: true})}
})

test('frontend graph API shares bounded scientist evidence and rejects scope expansion without creating jobs or sessions',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-graph-http-'))
 try{
  const app=new Application({workspace}),experiment=await app.createMockExperiment('Read-only graph API'),handler=createHandler(app)
  const before=JSON.stringify(await app.store.read(app.projectId)),url='http://127.0.0.1:4096/research/experiments/'+experiment.id+'/graph'
  const response=await handler(new Request(url));expect(response.status).toBe(200)
  const view=await response.json() as any;expect(view.focusExperimentId).toBe(experiment.id);expect(view.planningEvidence.length).toBeLessThanOrEqual(12)
  const traversed=await handler(new Request(url+'/traverse',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:view.focusTargetId,maxNodes:3})}));expect(traversed.status).toBe(200);expect((await traversed.json() as any).nodes.length).toBeLessThanOrEqual(3)
  const expanded=await handler(new Request(url+'/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:'another_project'})}));expect(expanded.status).toBe(400)
  expect(JSON.stringify(await app.store.read(app.projectId))).toBe(before)
  expect(await fs.access(path.join(app.sessionDirectory,'sessions.sqlite')).then(()=>true,()=>false)).toBe(false)
 }finally{await fs.rm(workspace,{recursive:true,force:true})}
})

test('health exposes degraded worker polling even when the research store cannot be read', async () => {
  const {spyOn}=await import('bun:test')
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-worker-health-'))
  const app=new Application({workspace}),abort=new AbortController()
  const poll=spyOn(app.jobs,'runOnce').mockRejectedValue(new Error('Offline transient database read failure'))
  const read=spyOn(app.store,'read').mockRejectedValue(new Error('Offline inaccessible research store'))
  const worker=app.jobs.runWorker({signal:abort.signal,pollMs:1000})
  try {
    const deadline=Date.now()+2000
    while(app.jobs.workerState.status!=='degraded'&&Date.now()<deadline)await Bun.sleep(5)
    const readsBeforeHealth=read.mock.calls.length
    const response=await createHandler(app)(new Request('http://127.0.0.1:4096/health'))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ok:false,worker:{status:'degraded',consecutiveFailures:1,lastError:'Offline inaccessible research store'}})
    expect(read.mock.calls.length).toBe(readsBeforeHealth);expect(poll).not.toHaveBeenCalled()
  } finally {abort.abort();await worker;poll.mockRestore();read.mockRestore();await fs.rm(workspace,{recursive:true,force:true})}
})

test('HTTP recovery plan and receipt-only settlement of an unadmitted queued job create no work',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-recovery-api-'))
 try {
  let calls=0
  const app=new Application({workspace,jobs:{runtimeOptions:{streamFn:()=>{calls++;throw new Error('No provider permitted')}}}})
  const campaign=await app.research.createCampaign(app.projectId,{objective:'Read-only recovery plan fixture'})
  await app.research.activateCampaign(app.projectId,campaign.id)
  const job=await app.campaign.enqueueCampaign(campaign.id,{idempotencyKey:'unadmitted-plan',maxSteps:1,maximumTrajectories:1,maximumKnowledgeRefreshes:0})
  const before=await app.store.read(app.projectId),handler=createHandler(app)
  const plan=await handler(new Request(`http://127.0.0.1:4096/research/jobs/${job.id}/recovery-plan`))
  expect(plan.status).toBe(200);expect(await plan.json()).toMatchObject({selectedJobId:job.id,rootJobId:job.id,mode:'receipt_only'})
  const settle=await handler(new Request(`http://127.0.0.1:4096/research/jobs/${job.id}/settle`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))
  expect(settle.status).toBe(200);expect(await settle.json()).toMatchObject({job:{id:job.id,status:'queued'}})
  expect(await app.store.read(app.projectId)).toEqual(before);expect(calls).toBe(0)
 }finally{await fs.rm(workspace,{recursive:true,force:true})}
})

test('model registry HTTP read keeps missing Proto runtime explicit without creating scientific effects or SDK sessions', async () => {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'model-registry-http-'))
 try {
  const app=new Application({workspace}), before=JSON.stringify(await app.store.read(app.projectId))
  const response=await createHandler(app)(new Request('http://127.0.0.1:4096/research/model-registry'))
  expect(response.status).toBe(200)
  const registry=await response.json() as any
  expect(registry).toMatchObject({format:'autofold.proto-model-registry.v1',provenance:null,entries:[]})
  expect(JSON.stringify(await app.store.read(app.projectId))).toBe(before)
  expect(await fs.access(path.join(app.sessionDirectory,'sessions.sqlite')).then(()=>true,()=>false)).toBe(false)
 } finally {await fs.rm(workspace,{recursive:true,force:true})}
})


test('direct fresh authoring enforces supplied methodology and persists the human-explicit profile without admitting foreign claims', async () => {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-human-methodology-'))
  try {
    const app=new Application({workspace}),experiment=await app.createMockExperiment('Explicit human methodology fixture'),port=app.science(experiment.id)
    const draft={program:'def propose(ctx):\n    return []\n',hypothesis:'Plumbing admission fixture',designAdapter:'mock' as const}
    const before=await app.research.history(app.projectId,experiment.id)
    await expect(port.authorTrial({...draft,evidenceRefs:['trl_foreign']})).rejects.toThrow('do not resolve in the required scope')
    await expect(port.authorTrial({...draft,prediction:{metric:'locked_score',comparatorTrialId:'trl_missing',relation:'higher',minimumDifference:0}})).rejects.toThrow('valid locked evaluation')
    await expect(port.authorTrial({...draft,methodologyProfile:'historical'} as any)).rejects.toThrow('historical labels cannot bypass')
    expect((await app.research.history(app.projectId,experiment.id)).trials).toEqual(before.trials)
    const accepted=await port.authorTrial(draft) as any
    expect(accepted.trial.methodologyProfile).toBe('human_explicit')
    expect(accepted.validation.valid).toBe(true)
    const state=await app.store.read(app.projectId)
    expect(Object.values(state.jobs)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
  } finally {await fs.rm(workspace,{recursive:true,force:true})}
})


test('direct native-only declaration is captured, validated and persisted before strict validation without duplicate API metadata',async()=>{
  const {ProtoRuntimeInspection}=await import('./execution/proto-inspection')
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-native-human-capture-'))
  const app=new Application({workspace,execution:{proto:{python:'python3',root:workspace,languageCommit:'a'.repeat(40),toolsCommit:'b'.repeat(40)},authorization:{localProto:true,maximumGpuSeconds:0}}})
  const capabilities=spyOn(app.execution as unknown as {checkCapabilities:()=>Promise<unknown>},'checkCapabilities').mockResolvedValue({})
  const readiness=spyOn(app.execution as unknown as {preflightInspection:()=>Promise<void>},'preflightInspection').mockResolvedValue()
  const configs=spyOn(ProtoRuntimeInspection,'validateConfigs').mockResolvedValue()
  const nativeTools=spyOn(ProtoRuntimeInspection,'discover').mockResolvedValue([])
  const nativeGenerators=spyOn(ProtoRuntimeInspection,'discoverGenerators').mockResolvedValue([])
  let describe:ReturnType<typeof spyOn>|undefined
  try{
    const experiment=await app.createMockExperiment('Native-only metadata capture ordering'),port=app.science(experiment.id)
    const plan={question:'Can the native-only declaration be admitted?',alternatives:[{id:'run',experiment:'Bounded construction fixture',expectedInformation:'Captured metadata',estimatedGpuHours:0},{id:'stop',experiment:'No execution',expectedInformation:'Retain constraints',estimatedGpuHours:0}],selectedAlternativeId:'run',rationale:'Validate native claim capture without duplicate API fields',evidenceRefs:[experiment.id],outcomeBranches:[{observation:'Captured',nextDecision:'Inspect immutable metadata'},{observation:'Rejected',nextDecision:'Repair declaration'}]}
    const authored:import('@autofold/science-core/workflow').ResearchWorkflow.AuthoredTrial=withNativeSearch({hypothesis:'Native metadata fixture',declaration:{intent:'optimize',decisionPlan:plan,evidenceRefs:[experiment.id],calibrationClass:'neutral'},program:{kind:'native',optimizerCount:1,constructCount:1,generatorCount:0,proposalSources:[null],fixedSequences:['ACDE','CDEF','DEFG'],programResultCount:3,optimizerSamples:[{numSamples:3,numResults:3,proposalBatchSize:3}]},diagnostics:[],legacyWorkflow:null,generatorPreflight:{generators:[]}})
    describe=spyOn(ProtoRuntimeInspection,'describeTrial').mockResolvedValue(authored)
    // Only construction is doubled. The public authoring API, capture ordering,
    // shared scientific policy and strict persisted validation run unchanged.
    const draft={program:"def build_trial(ctx): raise AssertionError('Construction double only')\n",hypothesis:authored.hypothesis,designAdapter:'proto' as const}
    const result=await port.authorTrial(draft) as {trial:import('@autofold/science-core/domain').ResearchDomain.Trial;validation:{valid:boolean}}
    expect(result.validation.valid).toBe(true)
    expect(result.trial).toMatchObject({decisionPlan:plan,evidenceRefs:[experiment.id],calibrationClass:'neutral',methodologyProfile:'human_explicit'})
    await expect(port.authorTrial({...draft,decisionPlan:{...plan,rationale:'Contradictory supplied plan'}})).rejects.toThrow('Native decisionPlan differs')
    await expect(port.authorTrial({...draft,calibrationClass:'known_negative'})).rejects.toThrow('Native calibrationClass differs')
    authored.declaration={...authored.declaration,prediction:{metric:'locked_score',comparatorTrialId:'trl_missing',relation:'higher',minimumDifference:0}}
    await expect(port.authorTrial(draft)).rejects.toThrow('valid locked evaluation')
    const state=await app.store.read(app.projectId)
    expect(Object.values(state.trials)).toHaveLength(1);expect(Object.values(state.runs)).toHaveLength(0);expect(Object.values(state.jobs)).toHaveLength(0)
    expect(await fs.access(path.join(app.sessionDirectory,'sessions.sqlite')).then(()=>true,()=>false)).toBe(false)
  }finally{describe?.mockRestore();nativeTools.mockRestore();nativeGenerators.mockRestore();configs.mockRestore();readiness.mockRestore();capabilities.mockRestore();await fs.rm(workspace,{recursive:true,force:true})}
})

test('evidence outbox rebuild repairs corrupt new journal without repeating work or rewriting historical evidence',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-evidence-projection-'))
 let dispatches=0
 try{
  const app=new Application({workspace,execution:{transport:{kind:'local',dispatch:async()=>{dispatches++;throw new Error('Projection repair cannot dispatch')}}},jobs:{runtimeOptions:{getApiKey:()=>{throw new Error('Projection repair cannot access providers')},streamFn:()=>{throw new Error('Projection repair cannot infer')}}}})
  const experiment=await app.createMockExperiment('Explicit CPU-only factual projection fixture')
  const trial=await app.research.createTrial(app.projectId,experiment.id,{hypothesis:'Exercise original projection recovery',designAdapter:'mock',programPath:'fixture.py',programHash:'sha256:'+'c'.repeat(64)})
  const run=await app.research.beginRun(app.projectId,trial.id,{bundlePath:'fixture/bundle.json',outputPath:'fixture/output'})
  await app.research.attachRunJob(app.projectId,run.id,'job_fixture_worker')
  await app.research.completeRun(app.projectId,run.id,{contractHash:experiment.contractHash,evaluatorHash:experiment.contract.evaluator.sourceHash,valid:true,score:.5,diagnostics:{}},'sha256:'+'d'.repeat(64))
  const before=await app.store.read(app.projectId),operation=Object.values(before.operations).find(row=>row.kind==='verified_trajectory_evidence')!
  expect(operation).toBeDefined();expect(Object.values(before.knowledgeCycles)).toHaveLength(0)
  const root=path.join(workspace,'.autofold/autoresearch',experiment.id),legacy=JSON.stringify({format:'autofold.scientist-event.v1',recordedAt:'2026-01-01T00:00:00.000Z',experimentId:experiment.id,contractHash:experiment.contractHash,iteration:1,status:'run_failed',trialId:'trl_historical',runId:'run_historical',error:'Original historical fixture'})+'\n'
  await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'events.jsonl'),legacy);await fs.writeFile(path.join(root,'events.v2.jsonl'),'corrupt derived export\n')
  await app.rebuildOperationProjection(operation.id)
  const after=await app.store.read(app.projectId)
  expect(after.runs).toEqual(before.runs);expect(after.evaluations).toEqual(before.evaluations);expect(after.searchObservations).toEqual(before.searchObservations);expect(after.jobs).toEqual(before.jobs)
  expect(await fs.readFile(path.join(root,'events.jsonl'),'utf8')).toBe(legacy)
  const projected=JSON.parse((await fs.readFile(path.join(root,'events.v2.jsonl'),'utf8')).trim())
  expect(projected.observationId).toBe(operation.state.observationId)
  expect(Object.values(after.operationOutbox).filter(item=>item.operationId===operation.id).every(item=>item.status==='acknowledged')).toBe(true)
  expect(dispatches).toBe(0)
 }finally{await fs.rm(workspace,{recursive:true,force:true})}
})
