import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {MemoryResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {prepareDecisionMemory,publishDecisionMemory,decisionMemoryExposure,verifiedSeedRoles} from './decision-memory'
import type {ScientificExecution} from './execution'
import {ScientificContext} from './scientist/context'
import {ScientificWorkspace} from './scientist/workspace'
import {ProtoModelRegistry} from '@autofold/science-core/research/model-registry'
import {operationHash} from '@autofold/science-core/operations'
const digest=(c:string)=>'sha256:'+c.repeat(64)
test('verified seed roles bind to the trial and compact actual role evidence',()=>{
  const roles={format:'autofold.generation-seed-roles.v1' as const,
    hostGenerationSeed:{value:31,source:'trial_bundle.generationSeed' as const},
    effectiveProgramSeeds:[{lane:0,value:91,source:'verified_native_projection.programSeed' as const}],
    declaredPredictorSeeds:[{lane:0,stage:'stage0',constraint:'constraint0',function:'fixed_predictor_iptm',field:'predictor_seed' as const,value:99173,source:'verified_native_projection.constraint.config' as const}],
    observedToolConfigSeeds:Array.from({length:9},(_,i)=>({requestId:`request-${i}`,tool:'boltz2-prediction',role:'predictor_tool' as const,source:'verified_native_tool_call.config' as const,seed:99173,
      ...(i===0?{seeds:Array.from({length:17},(_,n)=>n)}:{})})),
    evaluatorSeeds:{values:Array.from({length:1024},(_,i)=>i),source:'trial_bundle.seeds' as const}}
  const artifacts={generationRuns:{seedRoles:roles},comparisonContext:{generationSeed:31}}
  const compact=verifiedSeedRoles(artifacts as any,{generationSeed:31} as any)!
  expect(compact.observedToolConfigSeeds).toHaveLength(6)
  expect(compact.omitted?.observedToolConfigSeeds).toBe(3)
  expect(compact.observedToolConfigSeeds?.[0]?.seeds).toHaveLength(16)
  expect(compact.observedToolConfigSeeds?.[0]?.omittedSeeds).toBe(1)
  expect(compact.effectiveProgramSeeds?.[0]?.value).toBe(91)
  expect(compact.declaredPredictorSeeds?.[0]?.value).toBe(99173)
  expect(compact.evaluatorSeeds?.values).toHaveLength(16)
  expect(compact.evaluatorSeeds?.omitted).toBe(1008)
  expect(roles.evaluatorSeeds.values).toHaveLength(1024)
  expect(()=>verifiedSeedRoles({...artifacts,comparisonContext:{generationSeed:32}} as any,{generationSeed:31} as any)).toThrow(/differ from the original trial or bundle binding/)
  expect(verifiedSeedRoles({generationRuns:{}} as any,{} as any)).toBeUndefined()
  expect(verifiedSeedRoles({generationRuns:{}} as any,{generationSeed:31} as any)).toEqual({format:'autofold.generation-seed-roles.v1',hostGenerationSeed:{value:31,source:'trial_binding_fallback'}})
})
async function fixture(count=1){
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-decision-memory-')),store=new MemoryResearchStore(),projectId='memory_offline'
  const research=new ResearchService.Service(store),campaign=await research.createCampaign(projectId,{objective:'Bounded engineering evidence'})
  await research.activateCampaign(projectId,campaign.id)
  const experiment=await research.createExperiment(projectId,campaign.id,{contract:{version:1,objective:'Offline qualified facts',targetArtifactHash:digest('a'),modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:0,wallTimeMinutes:1},evaluator:{id:'mock-peptide-panel',version:'1',sourceHash:digest('b'),direction:'minimize',fixedSeeds:[1],submissionSize:1}}})
  await research.activateExperiment(projectId,experiment.id)
  for(let i=0;i<count;i++){
    const trial=await research.createTrial(projectId,experiment.id,{hypothesis:'Original bounded intervention '+i,designAdapter:'mock',programPath:'original-'+i+'.py',programHash:digest('c'),generators:['fixture']})
    const run=await research.beginRun(projectId,trial.id,{bundlePath:'bundle.json',outputPath:'output'})
    await research.attachRunJob(projectId,run.id,'offline-fixture')
    await research.completeRun(projectId,run.id,{contractHash:experiment.contractHash,evaluatorHash:experiment.contract.evaluator.sourceHash,valid:i!==1&&i!==2,score:i===2?null:1/(i+1),diagnostics:{}},digest('d'))
  }
  const state=await store.read(projectId);let reads=0
  const execution={artifacts:async(runId:string)=>{reads++;const run=state.runs[runId]!,trial=state.trials[run.trialId]!;return {run,trial,modelEvidence:[],candidates:{candidates:[]},scientific:false,evidenceKind:'plumbing_only'}},failureReceipt:async()=>{throw new Error('No failure receipts in fixture')}} as unknown as Pick<ScientificExecution,'artifacts'|'failureReceipt'>
  return {workspace,store,state,projectId,campaignId:campaign.id,experimentId:experiment.id,execution,reads:()=>reads}
}
function readerFor(f:Awaited<ReturnType<typeof fixture>>,sessionId='ses_refresh_memory',execution=f.execution as any){
  const experiment=f.state.experiments[f.experimentId]!,campaign=f.state.campaigns[f.campaignId]!
  return new ScientificContext({options:{...f,sessionId,maximumEvaluations:0,research:new ResearchService.Service(f.store),execution:{...execution,
      capabilities:async()=>({}),modelRegistry:async()=>ProtoModelRegistry.snapshot([],null)}},root:'scope',initialize:async()=>{},verifyTargetReferences:async()=>{},
    scope:async()=>({state:await f.store.read(f.projectId),experiment,campaign}),listFiles:async()=>[],status:async()=>({}),requests:()=>0,completedEvaluations:()=>0,latestResult:()=>undefined} as any)
}
test('105 canonical runs require only 24 raw receipts and a bounded packet without store mutation',async()=>{
  const f=await fixture(105)
  try {
    const before=JSON.stringify(await f.store.read(f.projectId)),memory=await prepareDecisionMemory({...f,includeGuides:false})
    expect(f.reads()).toBe(24);expect(memory.preparation.receiptReads).toBe(24)
    expect(memory.packet.coverage).toMatchObject({totalRecords:105,deliveredFacts:24,notSelectedReceipts:81})
    expect(memory.packet.retrieval.bytes).toBeLessThan(60000)
    expect(memory.packet.facts.some(fact=>fact.outcome==='invalid')).toBe(true)
    expect(memory.packet.facts.every(fact=>fact.qualification.scientific===false)).toBe(true)
    expect(memory.sourceManifest.sources.length).toBeGreaterThan(500)
    expect(memory.packet.sourceManifest.sources.length).toBeLessThanOrEqual(100)
    expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
    console.info('engine decision-memory preparation',JSON.stringify({...memory.preparation,packetBytes:memory.packet.retrieval.bytes,canonicalRuns:105}))
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
},30000)
test('native memory exposure requires an exact full packet in a confirmed inference delivery, never hidden details or cards',async()=>{
  const f=await fixture()
  try {
    const experiment=f.state.experiments[f.experimentId]!,campaign=f.state.campaigns[f.campaignId]!
    const reader=new ScientificContext({options:{...f,sessionId:'ses_confirmed_memory',maximumEvaluations:0,research:new ResearchService.Service(f.store),
      execution:{...f.execution,capabilities:async()=>({}),modelRegistry:async()=>ProtoModelRegistry.snapshot([],null),frozenAssetReferences:async()=>[]}},root:'scope',
      initialize:async()=>{},verifyTargetReferences:async()=>{},scope:async()=>({state:f.state,experiment,campaign}),listFiles:async()=>[],
      status:async()=>({}),requests:()=>0,completedEvaluations:()=>0,latestResult:()=>undefined} as any)
    const context=await reader.context(true),declaration={evidenceRefs:[context.decisionMemory.facts[0]!.runId]}
    const full={content:[{type:'text' as const,text:JSON.stringify(context)}],details:context,isError:false,projection:'full' as const}
    expect(reader.exposure(declaration)).toBeUndefined()
    reader.acknowledgeDelivery({...full,phase:'published'})
    expect(reader.exposure(declaration)).toBeUndefined() // A same-batch handoff has not received another model response.
    reader.acknowledgeDelivery({...full,phase:'inference'})
    expect(reader.exposure(declaration)?.citedSources[0]?.id).toBe(declaration.evidenceRefs[0])
    await reader.context(true) // A newer preparation invalidates the acknowledged packet before the card arrives.
    reader.acknowledgeDelivery({...full,phase:'inference',projection:'artifact_reference',content:[{type:'text',text:'Read the archived artifact for the original context.'}]})
    expect(reader.exposure(declaration)).toBeUndefined()
    reader.acknowledgeDelivery({...full,phase:'inference',content:[{type:'text',text:'Native extension replaced the context result.'}]})
    expect(reader.exposure(declaration)).toBeUndefined() // Full hidden details cannot acknowledge absent model-facing bytes.
    const altered=structuredClone(context);altered.decisionMemory.facts[0]!.score=999
    reader.acknowledgeDelivery({...full,phase:'inference',content:[{type:'text',text:JSON.stringify(altered)}]})
    expect(reader.exposure(declaration)).toBeUndefined()
    reader.acknowledgeDelivery({...full,phase:'inference',isError:true})
    expect(reader.exposure(declaration)).toBeUndefined()
    const trial=await new ResearchService.Service(f.store).createTrial(f.projectId,f.experimentId,{hypothesis:'No fabricated memory delivery',designAdapter:'mock',programPath:'handoff.py',programHash:digest('c'),...declaration,decisionMemoryExposure:reader.exposure(declaration)})
    expect(trial.decisionMemoryExposure).toBeUndefined()
    expect(context.decisionMemory.facts[0]!.score).toBe(1)
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('fresh memory refresh clears stale exposure and only an exact nested full inference packet reestablishes it',async()=>{
  const f=await fixture(2)
  try {
    const reader=readerFor(f),first=await reader.refreshDecisionMemory({maxFacts:1,maxInterpretations:1})
    expect(first.status).toBe('available')
    const oldFact=first.decisionMemory.facts[0]!,oldResult={status:'succeeded',decisionMemoryRefresh:first}
    const oldDelivery={content:[{type:'text' as const,text:JSON.stringify(oldResult)}],details:oldResult,isError:false,projection:'full' as const,phase:'inference' as const}
    reader.acknowledgeDelivery(oldDelivery)
    expect(reader.exposure({evidenceRefs:[oldFact.runId]})).toBeDefined()

    const second=await reader.refreshDecisionMemory({maxFacts:1,maxInterpretations:1,intent:'next decision'}),newFact=second.decisionMemory.facts[0]!
    expect(reader.exposure({evidenceRefs:[newFact.runId]})).toBeUndefined()
    reader.acknowledgeDelivery(oldDelivery)
    expect(reader.exposure({evidenceRefs:[oldFact.runId]})).toBeUndefined()
    const third=await reader.refreshDecisionMemory({maxFacts:1,maxInterpretations:1,intent:'fresh inference delivery'})
    const thirdFact=third.decisionMemory.facts[0]!
    const preparedOnly={content:[{type:'text' as const,text:JSON.stringify({decisionMemoryRefresh:third})}],details:{decisionMemoryRefresh:third},isError:false,projection:'full' as const,phase:'published' as const}
    reader.acknowledgeDelivery(preparedOnly)
    expect(reader.exposure({evidenceRefs:[thirdFact.runId]})).toBeUndefined()
    const exact={status:'succeeded',decisionMemoryRefresh:third}
    reader.acknowledgeDelivery({...preparedOnly,phase:'inference',content:[{type:'text',text:JSON.stringify(exact)}],details:exact})
    expect(reader.exposure({evidenceRefs:[thirdFact.runId]})).toMatchObject({packetHash:'sha256:'+operationHash(third.decisionMemory)})
    await reader.refreshDecisionMemory({maxFacts:1,maxInterpretations:1,intent:'card-only retry'})
    reader.acknowledgeDelivery({...preparedOnly,phase:'inference',projection:'artifact_reference',content:[{type:'text',text:'archived'}]})
    expect(reader.exposure({evidenceRefs:[thirdFact.runId]})).toBeUndefined()
    reader.acknowledgeDelivery({...preparedOnly,phase:'inference',projection:'full',content:[{type:'text',text:JSON.stringify(exact)}],details:exact})
    expect(reader.exposure({evidenceRefs:[thirdFact.runId]})).toBeUndefined()
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('fresh refresh over 105 records bounds selected facts while preserving exact ledger coverage and omissions',async()=>{
  const f=await fixture(105)
  try {
    const before=JSON.stringify(await f.store.read(f.projectId)),reader=readerFor(f),refreshed=await reader.refreshDecisionMemory({maxFacts:4,maxInterpretations:2})
    expect(refreshed.status).toBe('available')
    expect(refreshed.decisionMemory.facts).toHaveLength(4)
    expect(refreshed.decisionMemory.coverage).toMatchObject({totalRecords:105,deliveredFacts:4,notSelectedReceipts:101})
    expect(refreshed.decisionMemory.sourceManifest.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(refreshed.decisionMemory.sourceManifest.snapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(f.reads()).toBe(4)
    expect(Buffer.byteLength(JSON.stringify(refreshed))).toBeLessThan(60000)
    expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
},30000)
test('a missing or changed receipt remains an explicit gap in the refreshed packet',async()=>{
  const f=await fixture(1)
  try {
    const runId=Object.keys(f.state.runs)[0]!,execution={...(f.execution as any),artifacts:async(id:string)=>{
      const receipt=await (f.execution as any).artifacts(id)
      return id===runId?{...receipt,run:{...receipt.run,manifestHash:digest('e')}}:receipt
    }}
    const refreshed=await readerFor(f,'ses_missing_refresh',execution).refreshDecisionMemory({maxFacts:1})
    expect(refreshed.status).toBe('available')
    const fact=refreshed.decisionMemory.facts.find((item:any)=>item.runId===runId)!
    expect(fact.receiptStatus).toBe('unavailable')
    expect(fact.limitations).toContain('Raw artifact unavailable; committed frozen evaluation remains canonical.')
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('publication failure retains current committed facts and reports an unavailable expansion',async()=>{
  const f=await fixture()
  try {
    const memory=await prepareDecisionMemory({...f,includeGuides:false}),before=JSON.stringify(await f.store.read(f.projectId))
    await fs.mkdir(path.join(f.workspace,'scope'));await fs.writeFile(path.join(f.workspace,'scope/evidence'),'blocked derivative directory')
    const gaps=await publishDecisionMemory(f.workspace,'scope',memory)
    expect(Object.keys(gaps).length).toBeGreaterThan(0)
    expect(memory.packet.sourceManifest.publicationStatus).toBe('unavailable')
    expect(memory.packet.facts[0]).toMatchObject({score:1,valid:true,outcome:'valid'})
    expect(JSON.stringify(await f.store.read(f.projectId))).toBe(before)
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('immutable manifest publication verifies existing bytes rather than overwriting tampered evidence',async()=>{
  const f=await fixture()
  try {
    const memory=await prepareDecisionMemory({...f,includeGuides:false})
    expect(await publishDecisionMemory(f.workspace,'scope',memory)).toEqual({})
    const file=path.join(f.workspace,'scope',memory.packet.sourceManifest.manifestPath)
    await fs.chmod(file,0o600);await fs.writeFile(file,'tampered immutable derivative')
    const gaps=await publishDecisionMemory(f.workspace,'scope',memory)
    expect(gaps[memory.packet.sourceManifest.manifestPath]).toContain('bytes changed')
    expect(await fs.readFile(file,'utf8')).toBe('tampered immutable derivative')
    expect(memory.packet.facts[0]?.score).toBe(1)
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('admission exposure binds actually delivered cited sources and rejects a changed original origin',async()=>{
  const f=await fixture()
  try {
    const memory=await prepareDecisionMemory({...f,includeGuides:false}),ref=memory.packet.facts[0]!.runId
    const declaration={evidenceRefs:[ref]},exposure=decisionMemoryExposure(memory.packet,memory.sourceManifest,'ses_memory_exposure',declaration)
    expect(exposure.citedSources[0]).toMatchObject({id:ref,sourceId:ref,kind:'runs'})
    const research=new ResearchService.Service(f.store),input={hypothesis:'Exact exposure trace',designAdapter:'mock' as const,programPath:'trace.py',programHash:digest('c'),origin:{jobId:'job_memory_exposure',phase:'accepted'},...declaration,decisionMemoryExposure:exposure}
    const trial=await research.createTrial(f.projectId,f.experimentId,input)
    expect(trial.decisionMemoryExposure).toEqual(exposure)
    expect((await research.createTrial(f.projectId,f.experimentId,input)).id).toBe(trial.id)
    await expect(research.createTrial(f.projectId,f.experimentId,{...input,decisionMemoryExposure:{...exposure,packetHash:digest('e')}})).rejects.toMatchObject({data:{code:'trial_origin_conflict'}})
    await expect(research.createTrial(f.projectId,f.experimentId,{...input,origin:undefined,evidenceRefs:[]})).rejects.toMatchObject({data:{code:'decision_memory_exposure_conflict'}})
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
})
test('a paged manifest read verifies integrity without attributing unselected opening-packet sources',async()=>{
  const f=await fixture(105)
  try {
    const experiment=f.state.experiments[f.experimentId]!,campaign=f.state.campaigns[f.campaignId]!,root='scope'
    const reader=new ScientificContext({options:{...f,sessionId:'ses_packet_page',maximumEvaluations:0,research:new ResearchService.Service(f.store),
      execution:{...f.execution,capabilities:async()=>({}),modelRegistry:async()=>ProtoModelRegistry.snapshot([],null),frozenAssetReferences:async()=>[]}},root,
      initialize:async()=>{},verifyTargetReferences:async()=>{},scope:async()=>({state:f.state,experiment,campaign}),listFiles:async()=>[],
      status:async()=>({}),requests:()=>0,completedEvaluations:()=>0,latestResult:()=>undefined} as any)
    const context=await reader.context(),selected=new Set(context.decisionMemory.facts.map(fact=>fact.runId))
    const unselected=Object.keys(f.state.runs).find(id=>!selected.has(id))!
    const workspace=new ScientificWorkspace({workspace:f.workspace,root,initialize:async()=>{},scope:async()=>({state:f.state,experiment}),
      execution:f.execution as ScientificExecution,verifyReference:async(relative,bytes)=>reader.verifySourceRead(relative,bytes)})
    await workspace.read({path:context.decisionMemory.sourceManifest.manifestPath,limit:1})
    const exposure=reader.exposure({evidenceRefs:[unselected]})!
    expect(exposure.exposureScope).toBe('opening_packet');expect(exposure.citedSources).toEqual([])
  }finally{await fs.rm(f.workspace,{recursive:true,force:true})}
},30000)
