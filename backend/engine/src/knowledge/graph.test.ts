import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {emptyResearchState,StorageResearchStore,type ResearchStore} from '@autofold/science-core/store'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchDomain} from '@autofold/science-core/domain'
import {ProjectKnowledgeGraph} from './graph'
const hash=(c:string)=>'sha256:'+c.repeat(64),at='2026-10-01T00:00:00.000Z',actor={by:'fixture',at}
function fixture(){
 const state=emptyResearchState(),projectId='graph_project'
 for(const id of ['cmp_old','cmp_current','cmp_private'])state.campaigns[id]={id,projectId:id==='cmp_private'?'another_project':projectId,objective:'PD-L1 peptide experiment',status:'active',knowledgeCatalogId:'okf_'+id,createdAt:at,updatedAt:at}
 for(const [id,campaignId,evaluator] of [['exp_old','cmp_old','b'],['exp_current','cmp_current','c'],['exp_private','cmp_private','b']]){
  const contract=ResearchDomain.ExperimentContract.parse({version:1,objective:'PD-L1 cyclic and linear comparison',targetArtifactHash:hash('a'),modality:'short_peptide',budget:{maximumCandidates:1,gpuHours:1/6,wallTimeMinutes:15},evaluator:{id:'frozen-panel',version:'1',sourceHash:hash(evaluator!),direction:'minimize',fixedSeeds:[7],submissionSize:1}})
  state.experiments[id!]={id:id!,campaignId:campaignId!,status:'active',contract,contractHash:ResearchDomain.hashContract(contract),createdAt:at,updatedAt:at}
  const suffix=id!.slice(4),trialId='trl_'+suffix,runId='run_'+suffix,evaluationId='evl_'+suffix,knowledgeId='knw_'+suffix
  state.trials[trialId]=ResearchDomain.Trial.parse({id:trialId,experimentId:id,hypothesis:suffix==='private'?'PRIVATE_CONTENT':'Cyclic scaffold vs linear scaffold',intent:'optimize',designAdapter:'proto',programPath:'programs/cyclic.py',programHash:hash('d'),generators:['boltzgen-binder'],status:'succeeded',createdAt:at,updatedAt:at})
  state.runs[runId]=ResearchDomain.Run.parse({id:runId,trialId,status:'succeeded',bundlePath:'runs/'+runId+'/bundle.json',outputPath:'runs/'+runId+'/output',manifestHash:hash('e'),createdAt:at})
  state.evaluations[evaluationId]={id:evaluationId,trialId,contractHash:state.experiments[id!]!.contractHash,evaluatorHash:hash(evaluator!),valid:true,score:0.22,diagnostics:{interface:0.6},evaluatedAt:at}
  state.knowledge[knowledgeId]=ResearchDomain.KnowledgeConcept.parse({id:knowledgeId,campaignId,experimentId:id,trialId,runId,evaluationId,type:'Research Evaluation',title:suffix==='private'?'PRIVATE_CONTENT':'Cyclic peptide computational result',description:'Cyclic scaffold scored 0.22; no binding assay was run.',tags:['cyclic'],sources:[{id:'manifest',resource:'runs/'+runId+'/output/manifest.json'}],generated:actor,status:'stable',score:0.22,decision:'promoted',diagnostics:{interface:0.6},provenance:{contractHash:state.experiments[id!]!.contractHash,evaluatorHash:hash(evaluator!),programHash:hash('d'),manifestHash:hash('e')},createdAt:at})
 }
 state.literature.lit_paper={id:'lit_paper',campaignId:'cmp_old',database:'pubmed',sourceId:'12345',title:'Cyclic peptide limitations',query:'PD-L1 cyclic',excerpts:['A bounded assay observation; transfer remains uncertain.'],contentHash:hash('f'),retrievedAt:at,url:'https://pubmed.ncbi.nlm.nih.gov/12345/'}
 state.claims.clm_rule={id:'clm_rule',campaignId:'cmp_old',kind:'design_rule',statement:'Cyclic conditioning may improve this target.',stance:'supports',confidence:0.6,evidence:[{literatureId:'lit_paper',excerpt:state.literature.lit_paper.excerpts[0]}],status:'proposed',generated:actor,createdAt:at}
 state.alignments.aln_conflict={id:'aln_conflict',campaignId:'cmp_old',claimId:'clm_rule',knowledgeId:'knw_old',relation:'refutes',rationale:'Recorded model disagreement leaves the simple ordering contested.',status:'contested',generated:actor,reviewed:actor,createdAt:at}
 state.alignments.aln_missing={...state.alignments.aln_conflict,id:'aln_missing',knowledgeId:'knw_not_present'}
 const observation=ResearchDomain.SearchObservation.parse({id:'sobs_old',campaignId:'cmp_old',experimentId:'exp_old',trialId:'trl_old',runId:'run_old',evaluationId:'evl_old',knowledgeId:'knw_old',knowledgeCycleId:'kcy_missing',intent:'optimize',programHash:hash('d'),generatorPortfolio:['boltzgen-binder'],candidateSequences:['ACDEFG'],modelIds:['boltz2','chai1'],seeds:[7],score:0.22,decision:'promoted',diagnostics:{},hypothesis:'Cyclic baseline',epistemicLevel:'model_observation',createdAt:at})
 state.searchObservations[observation.id]=observation
 let reads=0
 const store:ResearchStore={read:async()=>{reads++;return structuredClone(state)},mutate:async()=>{throw new Error('Graph must never mutate')}}
 const options={store,projectId,campaignId:'cmp_current',experimentId:'exp_current',expectedContractHash:state.experiments.exp_current!.contractHash}
 return {state,store,options,graph:new ProjectKnowledgeGraph(options),reads:()=>reads}
}
test('target traversal retrieves old evidence, contradictions and exact paper/receipt provenance across campaigns',async()=>{
 const f=fixture(),before=JSON.stringify(f.state),brief=await f.graph.brief()
 const result=await f.graph.traverse({id:brief.focusTargetId!,maxHops:4,maxNodes:40})
 expect(result.nodes.map(n=>n.id)).toEqual(expect.arrayContaining(['knw_old','clm_rule','lit_paper','run_old','evl_old']))
 expect(result.edges.some(e=>e.relation==='refutes'&&e.status==='contested'&&e.authority==='interpretation'&&e.recordId==='aln_conflict')).toBe(true)
 expect(result.paths.lit_paper?.length).toBeGreaterThan(0)
 const source=await f.graph.read({id:'lit_paper'});expect(source.node.data.contentHash).toBe(hash('f'));expect(source.node.data.excerpts).toEqual(f.state.literature.lit_paper!.excerpts)
 const run=await f.graph.read({id:'run_old'});expect(run.node.data.manifestHash).toBe(hash('e'));expect(run.node.recordHash).toBe(ResearchService.knowledgeRecordHash(f.state.runs.run_old))
 expect((await f.graph.read({id:'knw_old'})).node.applicability).toBe('same_target_other_contract_not_score_comparable')
 expect(JSON.stringify(result)).not.toContain('PRIVATE_CONTENT');expect(JSON.stringify(f.state)).toBe(before)
})
test('boundaries exclude other projects, reject model scope selectors and detect focus tampering',async()=>{
 const f=fixture();expect(JSON.stringify(await f.graph.search({query:'PRIVATE_CONTENT'}))).not.toContain('trl_private')
 await expect(f.graph.read({id:'run_private'})).rejects.toThrow('outside this project')
 await expect(f.graph.search({query:'',projectId:'another_project'} as any)).rejects.toThrow()
 await expect(new ProjectKnowledgeGraph({...f.options,experimentId:'exp_old'}).brief()).rejects.toThrow('bound campaign')
 f.state.experiments.exp_current!.contract.evaluator.fixedSeeds=[99]
 await expect(f.graph.brief()).rejects.toThrow('contract hash mismatch')
})
test('projection is deterministic and incomplete/retired evidence remains explicit without blocking retrieval',async()=>{
 const f=fixture(),first=await f.graph.brief();expect((await f.graph.brief()).snapshotHash).toBe(first.snapshotHash)
 expect(first.issues.some(i=>i.code==='missing_or_out_of_scope_link')).toBe(true)
 f.state.knowledge.knw_old!.status='deprecated'
 expect((await f.graph.search({query:'Cyclic',kinds:['knowledge']})).items.some(n=>n.id==='knw_old')).toBe(false)
 expect((await f.graph.search({query:'Cyclic',kinds:['knowledge'],includeDeprecated:true})).items.some(n=>n.id==='knw_old')).toBe(true)
 const node=await f.graph.read({id:'clm_rule'});f.state.claims.clm_rule!.statement='Revised interpretation'
 await expect(f.graph.read({id:'clm_rule',expectedHash:node.node.recordHash})).rejects.toThrow('revision changed')
 f.state.experiments.exp_old!.contract.evaluator.fixedSeeds=[100]
 const degraded=await f.graph.brief();expect(degraded.issues.some(i=>i.code==='historical_contract_integrity')).toBe(true)
 expect((await f.graph.search({kinds:['experiment']})).items.some(n=>n.id==='exp_old')).toBe(false)
})
test('bounded traversal returns paths and truncation instead of dumping the full graph',async()=>{
 const f=fixture(),b=await f.graph.brief(),limited=await f.graph.traverse({id:b.focusTargetId!,maxHops:4,maxNodes:3})
 expect(limited.nodes).toHaveLength(3);expect(limited.truncated).toBe(true)
 expect(limited.edges.every(e=>limited.nodes.some(n=>n.id===e.from)&&limited.nodes.some(n=>n.id===e.to))).toBe(true)
 await expect(f.graph.traverse({id:b.focusTargetId!,maxHops:99})).rejects.toThrow()
 const claim=await f.graph.traverse({id:'clm_rule',relations:['cites_source'],maxHops:1});expect(claim.nodes.map(n=>n.id)).toEqual(['clm_rule','lit_paper'])
 expect(claim.nodes.every(n=>n.data===undefined)).toBe(true)
})
test('same sequence is linked from deterministic closeouts without inferring binding or condition equivalence',async()=>{
 const f=fixture();const found=await f.graph.search({kinds:['candidate_sequence'],query:'ACDEFG'})
 expect(found.items).toHaveLength(1);const graph=await f.graph.traverse({id:found.items[0]!.id})
 expect(graph.edges.some(e=>e.relation==='observed_sequence')).toBe(true)
 expect(graph.edges.some(e=>e.relation==='binds')).toBe(false)
})
test('SQLite persistence/restart preserves graph identities; rejected writes leave the prior graph intact',async()=>{
 const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'okf-graph-'))
 try{
  const store=new StorageResearchStore({directory:root});await store.mutate(f.options.projectId,draft=>Object.assign(draft,f.state))
  const first=await new ProjectKnowledgeGraph({...f.options,store}).brief()
  await expect(store.mutate(f.options.projectId,draft=>{draft.claims.clm_rule!.statement='Partial write';throw new Error('Interrupted enrichment')})).rejects.toThrow('Interrupted enrichment')
  const restarted=new ProjectKnowledgeGraph({...f.options,store:new StorageResearchStore({directory:root})})
  expect((await restarted.brief()).snapshotHash).toBe(first.snapshotHash)
  expect((await restarted.read({id:'clm_rule'})).node.title).toBe(f.state.claims.clm_rule!.statement)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('planning view includes advisory questions, receipt identities, contradictions and repeated sequences without mutation',async()=>{
 const f=fixture(),at='2026-10-01T00:00:00.000Z'
 f.state.researchRequests.rq_context={id:'rq_context',campaignId:'cmp_current',experimentId:'exp_current',request:{question:'Is the observed duplicate an independent draw?',competingExplanations:['Same output','Different generator condition'],requiredEvidence:'Original candidate and seed identity',applicabilityChecks:'Same frozen target and contract',decisionIfResolved:'Choose an informative replicate'},evidenceRefs:['trl_current'],generatedBy:'fixture',createdAt:at}
 f.state.trials.trl_current!.evidenceRefs=['rq_context']
 f.state.searchObservations.sobs_current={...f.state.searchObservations.sobs_old!,id:'sobs_current',campaignId:'cmp_current',experimentId:'exp_current',trialId:'trl_current',runId:'run_current',evaluationId:'evl_current',knowledgeId:'knw_current'}
 const before=JSON.stringify(f.state),view=await f.graph.planningView()
 expect(view.planningEvidence.some(n=>n.id==='rq_context'&&n.epistemicLabel==='advisory_question_not_measurement')).toBe(true)
 expect(view.issues.some(i=>i.recordId==='trl_current')).toBe(false)
 expect(view.planningEvidence.some(n=>n.id==='clm_rule')).toBe(true)
 expect(view.repeatedCandidates[0]!.observations.map(n=>n.id)).toEqual(expect.arrayContaining(['sobs_old','sobs_current']))
 expect(view.planningEvidence.length).toBeLessThanOrEqual(12);expect(view.relations.length).toBeLessThanOrEqual(60)
 expect(JSON.stringify(view)).not.toContain('PRIVATE_CONTENT');expect(JSON.stringify(f.state)).toBe(before)
})

test('atomic revision port reuses indexed projections across reader instances and invalidates changed evidence',async()=>{
 const f=fixture();let revision='one',projections=0,reads=0
 const store:ResearchStore={...f.store,read:async()=>{throw new Error('Revision port owns the atomic read')},readWithRevision:async(_project,prior)=>{reads++;if(prior===revision)return {revision};projections++;return {revision,state:structuredClone(f.state)}}}
 const options={...f.options,store},first=new ProjectKnowledgeGraph(options),brief=await first.brief()
 const source=await new ProjectKnowledgeGraph(options).read({id:'lit_paper'})
 // Returned projections are detached: caller mutation cannot corrupt another read.
 source.node.data.excerpts=['FORGED'];source.node.title='FORGED';source.relations.splice(0)
 const fresh=await first.read({id:'lit_paper'});expect(fresh.node.title).toBe('Cyclic peptide limitations');expect(fresh.node.data.excerpts).toEqual(f.state.literature.lit_paper!.excerpts)
 expect(projections).toBe(1);expect(reads).toBe(3)
 f.state.claims.clm_rule!.statement='New committed interpretation';revision='two'
 expect((await first.read({id:'clm_rule'})).node.title).toBe('New committed interpretation');expect((await first.brief()).snapshotHash).not.toBe(brief.snapshotHash);expect(projections).toBe(2)
 f.state.experiments.exp_current!.contract.evaluator.fixedSeeds=[91];revision='three'
 await expect(first.brief()).rejects.toThrow('contract hash mismatch')
})

test('revisionless stores always reconstruct current records without accepting stale graph projections',async()=>{
 const f=fixture();let reads=0
 const store:ResearchStore={...f.store,readWithRevision:async()=>{reads++;return {state:structuredClone(f.state)}}}
 const graph=new ProjectKnowledgeGraph({...f.options,store});const before=await graph.read({id:'clm_rule'})
 f.state.claims.clm_rule!.statement='Legacy store updated externally'
 await expect(graph.read({id:'clm_rule',expectedHash:before.node.recordHash})).rejects.toThrow('revision changed');expect(reads).toBe(2)
})
