import {expect,test} from 'bun:test'
import {emptyResearchState,type ResearchStore} from '@autofold/science-core/store'
import {ResearchDomain} from '@autofold/science-core/domain'
import {CampaignKnowledgeReader} from './index'
const digest='sha256:'+'a'.repeat(64),at='2026-01-01T00:00:00.000Z',actor={by:'fixture-author',at}
function fixture(){
 const state=emptyResearchState(),campaignId='cmp_bound',experimentId='exp_bound',projectId='knowledge_test'
 state.campaigns[campaignId]={id:campaignId,projectId,objective:'Compare hotspot mechanisms',status:'active',knowledgeCatalogId:'okf_bound',createdAt:at,updatedAt:at}
 state.campaigns.cmp_other={...state.campaigns[campaignId],id:'cmp_other',objective:'PRIVATE_OTHER_CAMPAIGN'}
 const contract=ResearchDomain.ExperimentContract.parse({version:1,objective:'Fixture computational evidence',targetArtifactHash:digest,modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:0,wallTimeMinutes:1},evaluator:{id:'fixture',version:'1',sourceHash:digest,direction:'minimize',fixedSeeds:[1],submissionSize:1}})
 state.experiments[experimentId]={id:experimentId,campaignId,status:'active',contract,contractHash:ResearchDomain.hashContract(contract),createdAt:at,updatedAt:at}
 const concept=(id:string,description:string,createdAt=at)=>({id,campaignId,experimentId,trialId:'trl_fixture',evaluationId:'evl_fixture',type:'Research Evaluation' as const,title:description,description,tags:['hotspot'],sources:[{id:'immutable_receipt',resource:'.autofold/runs/run_fixture/output/manifest.json'}],generated:actor,status:'stable' as const,score:0.2,decision:'observed' as const,diagnostics:{metric:0.3},provenance:{contractHash:ResearchDomain.hashContract(contract),evaluatorHash:digest,programHash:digest,manifestHash:digest},createdAt})
 state.knowledge.knw_old=concept('knw_old','Archived hotspot mechanism affects the earliest candidate.')
 for(let index=0;index<35;index++){const id='knw_recent_'+index;state.knowledge[id]=concept(id,'Recent unrelated baseline '+index,new Date(Date.UTC(2026,8,1,index)).toISOString())}
 state.literature.lit_source={id:'lit_source',campaignId,database:'pubmed',sourceId:'123',title:'Primary hotspot paper',query:'hotspot',excerpts:['Primary source reported a bounded assay observation.','Transfer to other targets was not measured.'],url:'https://pubmed.ncbi.nlm.nih.gov/123/',contentHash:digest,retrievedAt:at}
 state.literature.lit_other={...state.literature.lit_source,id:'lit_other',campaignId:'cmp_other',title:'PRIVATE_OTHER_CAMPAIGN'}
 state.claims.clm_rule={id:'clm_rule',campaignId,kind:'design_rule',statement:'Hotspot localization may explain this observation.',stance:'supports',confidence:0.95,evidence:[{literatureId:'lit_source',excerpt:state.literature.lit_source.excerpts[0]}],status:'reviewed',generated:actor,reviewed:{by:'human-reviewer',at},createdAt:at}
 state.alignments.aln_refutes={id:'aln_refutes',campaignId,claimId:'clm_rule',knowledgeId:'knw_old',relation:'refutes',rationale:'The early computational observation contradicts simple transfer.',status:'contested',generated:actor,reviewed:{by:'human-reviewer',at},createdAt:at}
 state.knowledge.knw_failure={...concept('knw_failure','Recovered transport failure'),runId:'run_recovered',evaluationId:undefined,type:'Research Failure',status:'deprecated',score:null,decision:'failed',error:'Original interrupted transport'}
 state.knowledge.knw_recovered={...concept('knw_recovered','Recovered verified evaluation','2026-10-01T00:00:00.000Z'),runId:'run_recovered',evaluationId:'evl_recovered'}
 state.knowledgeCycles.kcy_synthesis={id:'kcy_synthesis',campaignId,trigger:'literature_review',question:'Reconcile hotspot transfer and model evidence.',inputs:{knowledgeIds:['knw_old'],claimIds:['clm_rule'],literatureIds:['lit_source']},outputs:{claimIds:['clm_rule'],literatureIds:[],alignmentIds:['aln_refutes'],hypothesisIds:[],searchObservationIds:[],researchRequestUpdates:[],unresolvedQuestions:['No matched biological assay exists.']},campaignSummary:'The reviewed rule remains a tentative model interpretation.',generated:actor,createdAt:'2026-10-02T00:00:00.000Z',nextReviewAt:'2026-10-09T00:00:00.000Z'}
 state.hypotheses.hyp_rule={id:'hyp_rule',campaignId,category:'method',statement:'A tentative hotspot mechanism',status:'supported',confidence:0.9,evidenceLevel:'model_observation',supportingEvidenceRefs:['knw_old'],opposingEvidenceRefs:[],prediction:'A matched intervention changes the model metric.',falsificationCriterion:'No response under matched condition.',recommendedExperiment:'Measure a matched control.',limitations:['No biological assay'],generated:actor,createdAt:at,updatedAt:at}
 state.scientistReviews.srv_prior={id:'srv_prior',campaignId,experimentId,runId:'run_fixture',expectedRevision:0,revision:1,finding:'Tentative hotspot response',interpretation:'A scientist interpretation of the model result.',predictionAssessment:'unresolved',remainingExplanations:['Model artifact'],limitations:['No assay'],nextDecision:'Test a matched intervention',evidenceRefs:['run_fixture','knw_old'],measuredClaims:[],branchUpdates:[],evidenceSummary:{},epistemicStatus:'scientist_interpretation',createdAt:at}
 let reads=0
 const store:ResearchStore={read:async()=>{reads++;return structuredClone(state)},mutate:async()=>{throw new Error('Read adapter must never mutate')}}
 return {state,store,reader:new CampaignKnowledgeReader({store,projectId,campaignId,experimentId,expectedContractHash:ResearchDomain.hashContract(contract)}),reads:()=>reads,campaignId,experimentId}
}
test('query retrieves old relevant knowledge beyond recent20 and reports exact pagination without writes',async()=>{
 const f=fixture(),before=JSON.stringify(f.state),found=await f.reader.query({query:'Archived hotspot mechanism',kinds:['knowledge']})
 expect(found.items[0]?.id).toBe('knw_old')
 expect(found.total).toBeGreaterThan(0)
 const first=await f.reader.query({kinds:['knowledge'],limit:5}),second=await f.reader.query({kinds:['knowledge'],offset:5,limit:5})
 expect(first.total).toBe(38);expect(first.nextOffset).toBe(5);expect(second.offset).toBe(5)
 expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(10)
 const end=await f.reader.query({kinds:['knowledge'],offset:36,limit:5});expect(end.items).toHaveLength(2);expect(end.hasMore).toBe(false);expect(end.nextOffset).toBeNull()
 expect(JSON.stringify(f.state)).toBe(before);expect(f.reads()).toBeGreaterThan(1)
})
test('campaign scope rejects foreign IDs, foreign focus and model-supplied campaign selectors',async()=>{
 const f=fixture()
 await expect(f.reader.read({id:'lit_other'})).rejects.toThrow('outside this campaign')
 expect(JSON.stringify(await f.reader.query({query:'PRIVATE_OTHER_CAMPAIGN'}))).not.toContain('lit_other')
 await expect(f.reader.query({query:'',campaignId:'cmp_other'} as any)).rejects.toThrow()
 await expect(new CampaignKnowledgeReader({...f.reader.options,experimentId:'exp_foreign'}).current()).rejects.toThrow('outside this campaign')
 await expect(new CampaignKnowledgeReader({...f.reader.options,expectedContractHash:'sha256:'+'b'.repeat(64)}).read({id:'knw_old'})).rejects.toThrow('contract changed')
})
test('read preserves source content hashes, reviewed-claim interpretation labels and contradictory alignment provenance',async()=>{
 const f=fixture(),claim=await f.reader.read({id:'clm_rule'})
 expect(claim.status).toBe('reviewed');expect(claim.epistemicLabel).toContain('interpretation_not_verified')
 expect(claim.provenance.reviewed?.by).toBe('human-reviewer')
 expect(claim.sources.items[0]?.contentHash).toBe(digest)
 expect(claim.sources.items[0]?.excerpt).toBe(f.state.literature.lit_source!.excerpts[0])
 expect(claim.sources.items[0]?.sourceRecordSnapshotHash).toMatch(/^sha256:/)
 expect(claim.relations.items.some(edge=>edge.relation==='refutes'&&edge.status==='contested'&&edge.alignmentId==='aln_refutes')).toBe(true)
 const page=await f.reader.read({id:'lit_source',limit:1});expect(page.sources.total).toBe(2);expect(page.sources.nextOffset).toBe(1)
 expect((await f.reader.read({id:'lit_source',offset:1,limit:1})).sources.items[0]?.excerpt).toBe('Transfer to other targets was not measured.')
 expect(claim.recordSnapshotHash).toMatch(/^sha256:/)
 const hash=claim.recordSnapshotHash;f.state.claims.clm_rule!.confidence=0.2
 expect((await f.reader.read({id:'clm_rule'})).recordSnapshotHash).not.toBe(hash)
})
test('deprecated recovered failures remain queryable and current synthesis/OKF graph exposes lifecycle',async()=>{
 const f=fixture(),failure=await f.reader.read({id:'knw_failure'})
 expect(failure.status).toBe('deprecated');expect(failure.historicalOnly).toBe(true)
 expect(failure.supersededBy).toEqual({knowledgeId:'knw_recovered',evaluationId:'evl_recovered'})
 expect((await f.reader.query({query:'Recovered transport failure'})).items.some(row=>row.id==='knw_failure')).toBe(true)
 expect((await f.reader.query({query:'Recovered transport failure',includeDeprecated:false})).items.some(row=>row.id==='knw_failure')).toBe(false)
 const current=await f.reader.current({limit:4})
 expect(current.latestSynthesisCycles[0]?.id).toBe('kcy_synthesis')
 expect(current.alignments[0]?.id).toBe('aln_refutes')
 expect(current.scientistInterpretations[0]?.id).toBe('srv_prior'); expect(current.scientistInterpretations[0]?.epistemicLabel).toBe('scientist_interpretation_not_measurement')
 expect(current.hypotheses[0]?.epistemicLabel).toContain('model_observation')
 expect((await f.reader.read({id:'kcy_synthesis'})).provenance.generated?.by).toBe('fixture-author')
 expect((await f.reader.read({id:'srv_prior'})).body).toContain('scientist interpretation')
 expect(current.relations.items.some(row=>row.relation==='refutes')).toBe(true)
 expect(current.authority).toContain('never establishes biological confirmation')
 expect(current.okfIndex).toContain('Campaign knowledge catalog')
})

test('knowledge projection reuse is revision-bound and returned records cannot poison later evidence',async()=>{
 const f=fixture();let revision='first',rebuilt=0
 const store:ResearchStore={...f.store,read:async()=>{throw new Error('Atomic revision port expected')},readWithRevision:async(_project,prior)=>{if(prior===revision)return {revision};rebuilt++;return {revision,state:structuredClone(f.state)}}}
 const options={...f.reader.options,store},reader=new CampaignKnowledgeReader(options),first=await reader.read({id:'knw_old'})
 ;(first.details as any).diagnostics.metric=991;first.relations.items.splice(0);const again=await new CampaignKnowledgeReader(options).read({id:'knw_old'})
 expect((again.details as any).diagnostics.metric).toBe(0.3);expect(again.relations.items.length).toBeGreaterThan(0);expect(rebuilt).toBe(1)
 f.state.knowledge.knw_old!.description='Committed revised mechanism';revision='second'
 const updated=await reader.read({id:'knw_old'});expect(updated.body).toBe('Committed revised mechanism');expect(updated.recordSnapshotHash).not.toBe(first.recordSnapshotHash);expect(rebuilt).toBe(2)
})
