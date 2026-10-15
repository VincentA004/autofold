import {expect,test} from 'bun:test'
import {DecisionMemory} from './decision-memory'
import {ResearchDomain} from './domain'
import {emptyResearchState,MemoryResearchStore} from './store'
import {ResearchService} from './service'
import {ResearchTrajectoryCloseout} from './trajectory-closeout'
import {ResearchScientistMemory} from './scientist-memory'
const digest=(c:string)=>'sha256:'+c.repeat(64)
const scope={projectId:'offline',campaignId:'cmp_test',experimentId:'exp_test'}
function corpus(){
  const state=emptyResearchState()
  state.campaigns[scope.campaignId]={id:scope.campaignId,projectId:scope.projectId} as ResearchDomain.Campaign
  state.experiments[scope.experimentId]={id:scope.experimentId,campaignId:scope.campaignId,contractHash:digest('a'),contract:{evaluator:{direction:'minimize'}}} as ResearchDomain.Experiment
  const receipts:DecisionMemory.Receipt[]=[]
  for(let i=0;i<45;i++){
    const id=String(i).padStart(2,'0'),date=new Date(Date.UTC(2026,9,1,0,i)).toISOString()
    const row=ResearchDomain.SearchObservation.parse({id:'sobs_'+id,campaignId:scope.campaignId,experimentId:scope.experimentId,trialId:'trl_'+id,runId:'run_'+id,knowledgeId:'knw_'+id,
      intent:'optimize',programHash:digest('b'),valid:true,configurationFamilyFingerprint:digest('c'),generatorPortfolio:['native'],candidateSequences:[],modelIds:[],seeds:[1],
      epistemicLevel:'computational_support',score:.3,decision:'rejected',diagnostics:{},hypothesis:'Current length setting',createdAt:date,
      ...(i===0?{hypothesis:'Old opposing length evidence'}:{}),...(i===1?{score:null,decision:'failed',error:'Original memory exhaustion'}:{}),
      ...(i===2?{score:.01,valid:false}:{}),...(i===3?{score:null}:{}),...(i===4?{valid:undefined}:{}),...(i===5?{configurationFamilyFingerprint:undefined}:{}),})
    state.searchObservations[row.id]=row
    receipts.push({runId:row.runId,status:'verified',receiptHash:digest('d'),run:{id:row.runId,status:i===1?'failed':'succeeded'},modelEvidence:[]})
  }
  state.hypotheses.hyp_opposing=ResearchDomain.ResearchHypothesis.parse({id:'hyp_opposing',campaignId:scope.campaignId,category:'method',statement:'The old length finding contradicts the current explanation',status:'weakened',confidence:.4,evidenceLevel:'model_observation',supportingEvidenceRefs:['run_44'],opposingEvidenceRefs:['run_00'],prediction:'Ordering repeats',falsificationCriterion:'A matched replicate reverses ordering',recommendedExperiment:'Replicate',limitations:['Single observed draw'],generated:{by:'original',at:'2026-10-01T00:00:00.000Z'},createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'})
  return {state,receipts}
}
test('bounded packet retains old opposing, failure, invalid and unknown facts over more than 32 observations',()=>{
  const {state,receipts}=corpus(),before=JSON.stringify(state),result=DecisionMemory.project({state,scope,receipts,query:{question:'length',maxFacts:12}})
  expect(result.packet.coverage).toMatchObject({totalRecords:45,deliveredFacts:12,omittedFacts:33,invalidRuns:1,failedRuns:1})
  expect(result.packet.facts.map(f=>f.runId)).toEqual(expect.arrayContaining(['run_00','run_01','run_02','run_04']))
  expect(result.packet.facts.find(f=>f.runId==='run_02')).toMatchObject({outcome:'invalid',score:null,recordedScore:.01})
  expect(result.packet.interpretations[0]?.opposingSources[0]?.id).toBe('sobs_00')
  expect(result.ledger.evidenceRefs).toHaveLength(45)
  expect(result.packet.replications.families).not.toHaveLength(0)
  expect(JSON.stringify(state)).toBe(before)
  expect(result.packet.retrieval.bytes).toBe(Buffer.byteLength(JSON.stringify(result.packet)))
})
test('delivered comparison audit uses receipt-verified conditions and admitted design, retaining unknown source pins',()=>{
  const {state,receipts}=corpus()
  state.searchObservations.sobs_06!.prediction={comparatorTrialId:'trl_00',metric:'locked_score',relation:'lower',minimumDifference:0}
  const conditions={contractHash:digest('a'),targetArtifactHash:digest('b'),modality:'short_peptide',candidateBudget:6,submissionSize:3,evaluationSeeds:[7,11],
    evaluator:{id:'panel',version:'1',sourceHash:digest('c'),direction:'minimize'},evidenceAdapter:{id:'adapter',version:'1',sourceHash:digest('d'),scoringPipelineHash:digest('e')},
    scoringPipelineHash:digest('f'),workerSourceHash:digest('a'),proto:{languageCommit:'a'.repeat(40),toolsCommit:'b'.repeat(40)}}
  const design=(alphabet:string,seed:number)=>({protocol:'native_search_v1',programSourceHash:digest(alphabet==='ACDE'?'1':'2'),budget:{maximumCandidates:6},outputs:[{construct:'design',lane:0}],
    projection:[{lane:0,programSeed:seed,externalInputs:[],constructs:[{label:'design'}],stages:[{instanceId:'lane0.stage0',config:{alphabet},generators:[{key:'native'}],constraints:[{id:'length'}]}]}]})
  receipts[0]={...receipts[0]!,comparisonProvenance:{status:'verified',conditions,admittedDesign:design('ACDE',17),workflowFingerprint:digest('1'),unknownFields:[]}}
  receipts[6]={...receipts[6]!,comparisonProvenance:{status:'verified',conditions,admittedDesign:design('ACFG',18),workflowFingerprint:digest('2'),unknownFields:['workerSourceHash']}}
  const {packet}=DecisionMemory.project({state,scope,receipts})
  const comparison=(packet.comparisons as any[]).find(value=>value.runId==='run_06')?.panelComparison.structuredComparison
  expect(comparison).toMatchObject({status:'partial',conditionChanges:[],unknown:['tested.workerSourceHash']})
  expect(comparison.designChanges.map((change:any)=>change.path)).toEqual(expect.arrayContaining([
    'projection[0].programSeed','projection[0].stages[0].config.alphabet','programSourceHash',
  ]))
})
test('unavailable original receipt exposes an explicit gap and never admits its recorded score',()=>{
  const {state,receipts}=corpus();receipts[0]={runId:'run_00',status:'unavailable',reason:'Archived artifact absent'}
  const {packet,ledger}=DecisionMemory.project({state,scope,receipts})
  expect(packet.facts.find(f=>f.runId==='run_00')).toMatchObject({receiptStatus:'unavailable',outcome:'unknown',score:null,recordedScore:.3})
  expect(packet.coverage.gaps).toContainEqual({id:'run_00',reason:'Archived artifact absent'})
  expect(ledger.objectiveProgress.scoredOptimizeRuns).toBe(40)
})
test('scientific revisions ignore jobs, operation leases and projection acknowledgements',()=>{
  const {state}=corpus(),before=DecisionMemory.sourceManifest(state,scope)
  state.jobs.job_noise={payload:{kind:'autoresearch',experimentId:scope.experimentId},owner:'different'} as unknown as ResearchDomain.Job
  state.operations.op_noise={revision:999,owner:{leaseId:'new'}} as any
  state.operationOutbox.noise={status:'acknowledged'} as any
  expect(DecisionMemory.sourceManifest(state,scope)).toEqual(before)
  state.hypotheses.hyp_opposing!.statement='Revised interpretation'
  const revised=DecisionMemory.sourceManifest(state,scope)
  expect(revised.revisions.evidence).toBe(before.revisions.evidence)
  expect(revised.revisions.interpretation).not.toBe(before.revisions.interpretation)
})
test('source inventory is deterministic, guide-explicit, scoped and tamper-evident',()=>{
  const {state}=corpus(),before=DecisionMemory.sourceManifest(state,scope)
  state.skillVersions.skv_future={id:'skv_future',campaignId:scope.campaignId} as any
  state.searchObservations.sobs_other={...state.searchObservations.sobs_00!,id:'sobs_other',experimentId:'exp_sibling',runId:'run_other'}
  expect(DecisionMemory.sourceManifest(state,scope)).toEqual(before)
  const reordered={...state,searchObservations:Object.fromEntries(Object.entries(state.searchObservations).reverse())}
  expect(DecisionMemory.sourceManifest(reordered,scope)).toEqual(before)
  expect(DecisionMemory.SourceManifest.safeParse({...before,sources:before.sources.slice(1)}).success).toBe(false)
  expect(()=>DecisionMemory.build({state,scope,previousManifest:{...before,snapshotHash:digest('f')}})).toThrow('integrity')
  const guided=DecisionMemory.sourceManifest(state,scope,[],[{versionId:'skv_assigned',skillId:'length',version:1,contentHash:digest('e'),status:'active',capabilities:['native'],validations:[]}])
  expect(guided.revisions.evidence).toBe(before.revisions.evidence)
  expect(guided.revisions.guidance).not.toBe(before.revisions.guidance)
})
async function canonical(evaluatorId='offline',failure=false,diagnostics:Record<string,number>={}){
  const store=new MemoryResearchStore();let id=0,clock=0
  const service=new ResearchService.Service(store,{id:p=>p+'_'+(++id),now:()=>new Date(Date.UTC(2026,9,12,0,0,clock++)).toISOString()})
  const campaign=await service.createCampaign('offline',{objective:'Original receipt facts'});await service.activateCampaign('offline',campaign.id)
  const experiment=await service.createExperiment('offline',campaign.id,{contract:{version:1,objective:'Original facts',targetArtifactHash:digest('a'),modality:'short_peptide',budget:{maximumCandidates:4,gpuHours:0,wallTimeMinutes:1},evaluator:{id:evaluatorId,version:'1',sourceHash:digest('b'),direction:'minimize',fixedSeeds:[1],submissionSize:1}}});await service.activateExperiment('offline',experiment.id)
  const trial=await service.createTrial('offline',experiment.id,{hypothesis:'Original question',designAdapter:'mock',programPath:'original.py',programHash:digest('c'),generators:['native']})
  const run=await service.beginRun('offline',trial.id,{bundlePath:'bundle.json',outputPath:'output'});await service.attachRunJob('offline',run.id,'original')
  if(failure)await service.failRun('offline',run.id,'Original verified failure',undefined,{failureReceiptHash:digest('e')})
  else await service.completeRun('offline',run.id,{contractHash:experiment.contractHash,evaluatorHash:experiment.contract.evaluator.sourceHash,valid:true,score:.2,diagnostics},digest('d'))
  const state=await store.read('offline'),row=Object.values(state.searchObservations)[0]!
  return {state,row,store,service,experiment,scope:{projectId:'offline',campaignId:campaign.id,experimentId:experiment.id},receipts:[{runId:run.id,status:'verified' as const,receiptHash:digest('d'),run:{id:run.id,status:'succeeded'},modelEvidence:[]}]}
}
test('canonical commit is visible despite stale or missing projections and frozen packet never reads later state',async()=>{
  const f=await canonical(),prior=DecisionMemory.sourceManifest({...f.state,searchObservations:{}},f.scope)
  const packet=DecisionMemory.build({...f,previousManifest:prior,projectionWatermark:prior.revisions.evidence})
  expect(packet.facts).toHaveLength(1);expect(packet.facts[0]?.score).toBe(.2);expect(packet.freshness.fallback).toBe(true)
  expect(packet.deltas.added.map(s=>s.id)).toContain(f.row.id)
  const bytes=JSON.stringify(packet),snapshot=packet.sourceManifest.snapshotHash
  f.state.searchObservations[f.row.id]!.hypothesis='Future edit'
  expect(JSON.stringify(packet)).toBe(bytes);expect(packet.sourceManifest.snapshotHash).toBe(snapshot)
  expect(()=>DecisionMemory.build(f)).toThrow('commit hash differs')
})
test('journal and canonical facts deduplicate by original run while preserving original journal source',async()=>{
  const f=await canonical(),event=ResearchTrajectoryCloseout.readCommitted(f.state,'offline',f.row.id).event
  const originalHash=ResearchScientistMemory.eventHash(event),{packet,sourceManifest,ledger}=DecisionMemory.project({...f,legacyEvents:[event]})
  expect(packet.facts).toHaveLength(1);expect(ledger.evidenceRefs).toHaveLength(1)
  expect(sourceManifest.sources.map(s=>s.id)).toContain(originalHash)
  expect(()=>DecisionMemory.build({...f,receipts:[{...f.receipts[0]!,receiptHash:digest('e')}]})).toThrow('original receipt differs')
  expect(()=>DecisionMemory.build({...f,legacyEvents:[{...event,score:.9}]})).toThrow('lineage conflict')
})
test('selection binds a finite raw-artifact budget over 120 original runs and excludes future experiment evidence',()=>{
  const {state,receipts}=corpus()
  for(let i=45;i<120;i++){
    const id=String(i).padStart(3,'0'),original=state.searchObservations.sobs_44!
    state.searchObservations['sobs_'+id]={...original,id:'sobs_'+id,runId:'run_'+id,trialId:'trl_'+id,knowledgeId:'knw_'+id,createdAt:new Date(Date.UTC(2026,9,2,0,i)).toISOString()}
  }
  const selected=DecisionMemory.selectedRunIds(state,scope,[],{question:'length'})
  expect(selected).toHaveLength(24);expect(selected).toContain('run_00');expect(selected).toContain('run_01');expect(selected).toContain('run_02')
  const selectedReceipts=selected.map(runId=>receipts.find(r=>r.runId===runId)??{runId,status:'verified' as const,receiptHash:digest('d'),run:{id:runId,status:'succeeded'},modelEvidence:[]})
  const {packet}=DecisionMemory.project({state,scope,query:{question:'length'},receipts:selectedReceipts})
  expect(packet.retrieval.selectedOrder).toEqual(selected)
  expect(packet.coverage).toMatchObject({totalRecords:120,verifiedReceipts:24,notSelectedReceipts:96,unavailableReceipts:0})
  expect(packet.deltas).toMatchObject({baseline:true,added:[],changed:[],removed:[]})
  expect(packet.retrieval.bytes).toBeLessThan(80000)
  console.info(`decision-memory corpus: 120 original runs, ${selected.length} raw reads, ${packet.retrieval.bytes} delivery bytes`)
})
test('question delivery preserves answered assessment and exact historical revision',()=>{
  const {state}=corpus(),date='2026-10-01T00:00:00.000Z'
  state.researchRequests.rq_original={id:'rq_original',campaignId:scope.campaignId,experimentId:scope.experimentId,createdAt:date,generatedBy:'original',evidenceRefs:['sobs_00'],request:{action:'create',question:'Was ordering independently established?',requiredEvidence:'Original matched rows'}} as any
  state.knowledgeCycles.kcy_assessment={id:'kcy_assessment',campaignId:scope.campaignId,trigger:'manual',createdAt:date,outputs:{researchRequestUpdates:[{requestId:'rq_original',expectedRevision:null,status:'answered',assessment:'The original rows establish only this recorded ordering',remainingGap:'Independent biological validity remains unresolved',nextAction:'Choose the next bounded experiment',literatureIds:[],evidenceSnapshots:[]}]},generated:{by:'original',at:date}} as any
  const packet=DecisionMemory.build({state,scope})
  expect(packet.openQuestions).toEqual([])
  expect(packet.interpretations.find(i=>i.kind==='research_assessment')).toMatchObject({requestId:'rq_original',status:'answered',revision:'kcy_assessment',statement:'The original rows establish only this recorded ordering',remainingGap:'Independent biological validity remains unresolved',source:{id:'kcy_assessment'}})
})
test('compact delivery bounds a 105-run complete canonical inventory and retains unselected committed scores',async()=>{
  const f=await canonical()
  for(let i=1;i<105;i++){
    const trial=await f.service.createTrial('offline',f.experiment.id,{hypothesis:`Original experiment ${i}`,designAdapter:'mock',programPath:`original_${i}.py`,programHash:digest('c'),generators:['native']})
    const run=await f.service.beginRun('offline',trial.id,{bundlePath:`bundle_${i}.json`,outputPath:`output_${i}`});await f.service.attachRunJob('offline',run.id,`original_${i}`)
    await f.service.completeRun('offline',run.id,{contractHash:f.experiment.contractHash,evaluatorHash:f.experiment.contract.evaluator.sourceHash,valid:true,score:.2+i/1000,diagnostics:{}},digest('d'))
  }
  const state=await f.store.read('offline'),selected=DecisionMemory.selectedRunIds(state,f.scope)
  const receipts=selected.map(runId=>({runId,status:'verified' as const,receiptHash:digest('d'),run:{id:runId,status:'succeeded'},modelEvidence:[]}))
  const {packet,sourceManifest,ledger}=DecisionMemory.project({state,scope:f.scope,receipts})
  expect(sourceManifest.sources.length).toBeGreaterThan(400)
  expect(packet.sourceManifest.sources.length).toBeLessThanOrEqual(100)
  expect(packet.coverage).toMatchObject({totalRecords:105,verifiedReceipts:24,notSelectedReceipts:81,unavailableReceipts:0})
  expect(ledger.objectiveProgress.scoredOptimizeRuns).toBe(105)
  expect(packet.retrieval.bytes).toBeLessThan(60000)
  expect(DecisionMemory.SourceManifest.safeParse(sourceManifest).success).toBe(true)
  expect(DecisionMemory.Packet.safeParse({...packet,sourceManifest:{...packet.sourceManifest,sources:[]}}).success).toBe(false)
  console.info(`decision-memory canonical corpus: ${sourceManifest.sources.length} full sources, ${selected.length} raw reads, ${packet.retrieval.bytes} delivery bytes`)
})
test('raw artifact failure cannot change committed canonical score, validity or outcome',async()=>{
  const f=await canonical(),available=DecisionMemory.build(f)
  const missing=DecisionMemory.build({...f,receipts:[{runId:f.row.runId,status:'unavailable',reason:'Derivative archive unavailable'}]})
  expect(missing.facts[0]).toMatchObject({score:.2,valid:true,outcome:'valid',receiptAuthority:'canonical_commit',receiptHash:digest('d'),receiptStatus:'unavailable'})
  expect(missing.facts[0]?.score).toBe(available.facts[0]?.score)
  expect(missing.coverage.gaps).toContainEqual({id:f.row.runId,reason:'Derivative archive unavailable'})
})
test('scientific qualification stays explicit and bounded rather than inferred from receipt verification',async()=>{
  const f=await canonical('mock-peptide-panel'),unknown=DecisionMemory.build(f)
  expect(unknown.facts[0]?.qualification).toMatchObject({scientific:false,evidenceKind:'plumbing_only'})
  expect(unknown.facts[0]?.limitations.join(' ')).toContain('Plumbing-only')
  const native=await canonical()
  const receipt={...native.receipts[0]!,scientific:true,evidenceKind:'native_model_result',evidenceCompleteness:{rows:Array.from({length:200},()=>({text:'x'.repeat(1000)}))}}
  const qualified=DecisionMemory.build({...native,receipts:[receipt]})
  expect(qualified.facts[0]?.qualification).toMatchObject({scientific:true,evidenceKind:'native_model_result',metadataTruncated:true})
  expect(JSON.stringify(qualified.facts[0]?.qualification).length).toBeLessThan(3000)
})
test('unanswered questions rank by query relevance and never drop revision status',()=>{
  const {state}=corpus(),date='2026-10-01T00:00:00.000Z'
  for(let i=0;i<10;i++)state.researchRequests['rq_'+i]={id:'rq_'+i,campaignId:scope.campaignId,experimentId:scope.experimentId,createdAt:date,generatedBy:'original',evidenceRefs:['sobs_00'],request:{action:'create',question:i===9?'Does target binding calibration transfer?':`Unrelated question ${i}`,requiredEvidence:`Exact original evidence ${i}`}} as any
  const packet=DecisionMemory.build({state,scope,query:{question:'target binding calibration'}})
  expect(packet.openQuestions).toHaveLength(8)
  expect(packet.openQuestions[0]).toMatchObject({requestId:'rq_9',revision:null,status:'open'})
  expect(packet.coverage.omittedQuestions).toBe(2)
})
test('opening gaps and unresolved interpretation refs stay bounded while full audit preserves omissions',()=>{
  const {state}=corpus(),original=state.hypotheses.hyp_opposing!
  for(let i=0;i<30;i++)state.hypotheses['hyp_gap_'+i]={...original,id:'hyp_gap_'+i,supportingEvidenceRefs:Array.from({length:40},(_,j)=>`run_missing${i}_${j}`),opposingEvidenceRefs:[]}
  const result=DecisionMemory.project({state,scope})
  expect(result.gaps.length).toBeGreaterThan(1000)
  expect(result.packet.coverage.gaps.length).toBeLessThanOrEqual(24)
  expect(result.packet.coverage.gapCount).toBe(result.gaps.length)
  expect(result.packet.coverage.omittedGaps).toBe(result.gaps.length-result.packet.coverage.gaps.length)
  expect(result.packet.interpretations.every(i=>i.unresolvedRefs.length<=12)).toBe(true)
})
test('recovered success supersedes original failure once without erasing either immutable source',async()=>{
  const f=await canonical('offline',true),failureEvent=ResearchTrajectoryCloseout.readCommitted(f.state,'offline',f.row.id).event
  await f.service.reopenRunFinalization('offline',f.row.runId)
  await f.service.completeRun('offline',f.row.runId,{contractHash:f.experiment.contractHash,evaluatorHash:f.experiment.contract.evaluator.sourceHash,valid:true,score:.2,diagnostics:{}},digest('d'))
  const state=await f.store.read('offline'),result=DecisionMemory.project({state,scope:f.scope,legacyEvents:[failureEvent],receipts:f.receipts})
  expect(result.packet.facts).toHaveLength(1);expect(result.packet.facts[0]?.outcome).toBe('valid')
  expect(result.packet.coverage.failedRuns).toBe(0);expect(result.ledger.evidenceRefs).toHaveLength(1)
  expect(result.sourceManifest.sources.map(s=>s.id)).toContain(f.row.id)
  expect(result.sourceManifest.sources.map(s=>s.id)).toContain(ResearchScientistMemory.eventHash(failureEvent))
  expect(state.searchObservations[f.row.id]).toEqual(f.row)
})
test('verified per-model stage measurements remain available without a declared measurement and missing raw rows never erase canonical score',async()=>{
  const f=await canonical(),rows=[
    {candidateId:'candidate_original',stage:'design',modelId:'native_generator',seed:1,status:'completed' as const,metrics:{confidence:.81,non_numeric:'untrusted',non_finite:Infinity}},
    {candidateId:'candidate_original',stage:'evaluation',modelId:'native_predictor',seed:7,status:'completed' as const,metrics:{interface_confidence:.63}},
    ...Array.from({length:8},(_,seed)=>({candidateId:'candidate_original',stage:'evaluation',modelId:'native_predictor',seed:seed+10,status:'completed' as const,metrics:{interface_confidence:.6+seed/100}})),
  ]
  const available=DecisionMemory.build({...f,receipts:[{...f.receipts[0]!,modelEvidence:rows}]})
  expect(available.facts[0]?.rawModelEvidence).toMatchObject({totalRows:10,omittedRows:4})
  expect(available.facts[0]?.rawModelEvidence.rows).toHaveLength(6)
  expect(available.facts[0]?.rawModelEvidence.rows[0]).toMatchObject({stage:'design',modelId:'native_generator',seed:1,metrics:{confidence:.81},omittedMetrics:2})
  expect(available.facts[0]?.rawModelEvidence.rows[1]).toMatchObject({stage:'evaluation',modelId:'native_predictor',seed:7,metrics:{interface_confidence:.63}})
  expect(available.facts[0]?.qualification.scientific).toBeNull()
  const missing=DecisionMemory.build({...f,receipts:[{runId:f.row.runId,status:'unavailable'}]})
  expect(missing.facts[0]?.rawModelEvidence).toEqual({rows:[],totalRows:null,omittedRows:null})
  expect(missing.facts[0]?.score).toBe(.2);expect(missing.facts[0]?.outcome).toBe('valid')
})
test('canonical promoted panels, hidden candidate improvements, counts and comparison predicates survive missing or unselected raw diagnostics',async()=>{
  const f=await canonical('offline',false,{best_candidate_loss:.15,candidate_count:1,eligible_count:1})
  const trial=await f.service.createTrial('offline',f.experiment.id,{hypothesis:'Candidate refinement improves its best candidate but not the panel',designAdapter:'mock',programPath:'refinement.py',programHash:digest('c'),generators:['native'],prediction:{comparatorTrialId:f.row.trialId,metric:'locked_score',relation:'lower',minimumDifference:0}})
  const run=await f.service.beginRun('offline',trial.id,{bundlePath:'refinement.json',outputPath:'refinement'});await f.service.attachRunJob('offline',run.id,'refinement')
  await f.service.completeRun('offline',run.id,{contractHash:f.experiment.contractHash,evaluatorHash:f.experiment.contract.evaluator.sourceHash,valid:true,score:.25,diagnostics:{best_candidate_loss:.12,candidate_count:1,eligible_count:1}},digest('d'))
  const state=await f.store.read('offline'),receipts=[...f.receipts,{runId:run.id,status:'verified' as const,receiptHash:digest('d'),run:{id:run.id,status:'succeeded'},modelEvidence:[]}]
  const available=DecisionMemory.project({state,scope:f.scope,receipts}).ledger
  const missing=DecisionMemory.project({state,scope:f.scope,receipts:receipts.map(r=>({runId:r.runId,status:'unavailable' as const}))}).ledger
  const unselected=DecisionMemory.project({state,scope:f.scope,query:{maxFacts:1},receipts:receipts.filter(r=>r.runId===f.row.runId)}).ledger
  const factual=(ledger:typeof available)=>({objective:ledger.objectiveProgress,coverage:ledger.coverage,families:ledger.families,
    promotion:ledger.latestPromotionEvidence&&{runId:ledger.latestPromotionEvidence.runId,score:ledger.latestPromotionEvidence.score,panelDiagnostics:ledger.latestPromotionEvidence.panelDiagnostics},
    opportunities:ledger.candidateOpportunities.map(({candidates,...item})=>item),comparisons:ledger.comparisonAudit})
  expect(factual(missing)).toEqual(factual(available));expect(factual(unselected)).toEqual(factual(available))
  expect(missing.latestPromotionEvidence).toMatchObject({runId:f.row.runId,panelDiagnostics:{best_candidate_loss:.15}})
  expect(missing.candidateOpportunities[0]).toMatchObject({runId:run.id,bestCandidateLoss:.12,referenceBestCandidateLoss:.15})
  expect(missing.comparisonAudit[0]?.panelComparison.tested).toMatchObject({candidates:1,eligible:1})
  expect(missing.comparisonAudit[0]?.predicate.status).toBe('refuted')
})
test('compact unanswered question preserves latest blocked assessment while bounding 110 occurrence and evidence previews',()=>{
  const {state}=corpus(),request={action:'create',purpose:'knowledge_lookup',prerequisiteBranchId:'brn_original',question:'Calibration evidence '+ 'q'.repeat(1800),requiredEvidence:'Independent evidence '+ 'e'.repeat(1800),competingExplanations:['a'.repeat(2000),'b'.repeat(2000)],applicabilityChecks:'c'.repeat(2000),decisionIfResolved:'d'.repeat(2000)}
  for(let i=0;i<110;i++){
    const id='rq_occurrence_'+String(i).padStart(3,'0')
    state.researchRequests[id]={id,campaignId:scope.campaignId,experimentId:scope.experimentId,createdAt:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),generatedBy:'original',evidenceRefs:['run_source_'+i],request} as any
  }
  state.knowledgeCycles.kcy_latest={id:'kcy_latest',campaignId:scope.campaignId,trigger:'manual',createdAt:'2026-10-02T00:00:00.000Z',generated:{by:'original',at:'2026-10-02T00:00:00.000Z'},outputs:{researchRequestUpdates:[{requestId:'rq_occurrence_109',expectedRevision:null,status:'blocked',assessment:'Latest recorded assessment '+ 'a'.repeat(1900),remainingGap:'Independent calibration '+ 'g'.repeat(1900),nextAction:'Resolve original gap '+ 'n'.repeat(1900),literatureIds:[],evidenceSnapshots:[]}]}} as any
  const result=DecisionMemory.project({state,scope,query:{question:'Calibration'}}),question=result.packet.openQuestions[0]!
  expect(question).toMatchObject({requestId:'rq_occurrence_109',revision:'kcy_latest',status:'blocked',request:{purpose:'knowledge_lookup',prerequisiteBranchId:'brn_original'},source:{id:'kcy_latest'},omittedOccurrences:102,omittedEvidenceRefs:102})
  expect(question.occurrenceIds).toHaveLength(8);expect(question.evidenceRefs).toHaveLength(8)
  expect(question.assessment?.length).toBe(600);expect(question.remainingGap?.length).toBe(600);expect(question.nextAction?.length).toBe(600)
  expect(JSON.stringify(question).length).toBeLessThan(5000)
  expect(Object.keys(question)).not.toContain('authoritativeRequest');expect(Object.keys(question)).not.toContain('latestRequest')
  expect(Object.keys(question.request)).not.toContain('competingExplanations')
  expect(result.questions[0]!.occurrenceIds).toHaveLength(110)
  expect(result.questions[0]!.request.competingExplanations).toEqual(request.competingExplanations)
  expect(result.questions[0]!.assessment?.length).toBeGreaterThan(600)
  expect(result.packet.expansion.questionsPath).toBe('QUESTIONS.json')
  expect(state.researchRequests.rq_occurrence_109!.request.question).toHaveLength(request.question.length)
})
test('replication and comparison display previews bound all nested member arrays without changing full descriptive distributions',()=>{
  const {state}=corpus();state.searchObservations={}
  const template=ResearchDomain.SearchObservation.parse({id:'sobs_template',campaignId:scope.campaignId,experimentId:scope.experimentId,trialId:'trl_template',runId:'run_template',knowledgeId:'knw_template',intent:'optimize',programHash:digest('b'),valid:true,configurationFamilyFingerprint:digest('c'),generatorPortfolio:['native'],candidateSequences:[],modelIds:[],seeds:[1],epistemicLevel:'computational_support',score:.3,decision:'rejected',diagnostics:{candidate_count:1,eligible_count:1},hypothesis:'One replicated family',createdAt:'2026-10-01T00:00:00.000Z'})
  const receipts:DecisionMemory.Receipt[]=[]
  for(let i=0;i<120;i++){
    const id=String(i).padStart(3,'0'),row={...template,id:'sobs_'+id,runId:'run_'+id,trialId:'trl_'+id,knowledgeId:'knw_'+id,score:.2+i/1000,realizedCandidateSetHash:digest('e'),generationReplicateId:'grep_'+id,generationWallSeconds:10+i,seeds:Array.from({length:100},(_,seed)=>seed),generatorPortfolio:Array.from({length:30},(_,g)=>'generator_'+g),createdAt:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),...(i===119?{prediction:{comparatorTrialId:'trl_000',metric:'locked_score' as const,relation:'lower' as const,minimumDifference:0}}:{})}
    state.searchObservations[row.id]=row;receipts.push({runId:row.runId,status:'verified',receiptHash:digest('d'),run:{id:row.runId,status:'succeeded'},modelEvidence:[]})
  }
  const result=DecisionMemory.project({state,scope,receipts}),families=result.packet.replications.families as any[],repeated=result.packet.replications.repeatedOutputs as any[],comparison=result.packet.comparisons[0] as any
  expect(result.ledger.families[0]?.runIds).toHaveLength(120);expect(result.ledger.repeatedOutputs[0]?.runIds).toHaveLength(120)
  expect(families[0]).toMatchObject({attempts:120,scored:120,mean:result.ledger.families[0]!.mean,sampleStandardDeviation:result.ledger.families[0]!.sampleStandardDeviation,runIdsCoverage:{total:120,shown:12,omitted:108},generationReplicateIdsCoverage:{total:120,shown:12,omitted:108}})
  for(const name of ['runIds','trialIds','scores','generationWallSeconds']){
    expect(repeated[0][name]).toHaveLength(12);expect(repeated[0][name+'Coverage']).toEqual({total:120,shown:12,omitted:108})
  }
  expect(comparison.panelComparison.tested.seeds).toHaveLength(12);expect(comparison.panelComparison.tested.seedsCoverage).toEqual({total:100,shown:12,omitted:88})
  expect(comparison.panelComparison.tested.generators).toHaveLength(12);expect(comparison.panelComparison.tested.generatorsCoverage).toEqual({total:30,shown:12,omitted:18})
  expect(result.packet.retrieval.bytes).toBeLessThan(75000)
})
