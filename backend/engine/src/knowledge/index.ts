import z from 'zod'
import {ResearchDomain} from '@autofold/science-core/domain'
import {ResearchKnowledge} from '@autofold/science-core/knowledge'
import {ResearchService} from '@autofold/science-core/service'
import type {ResearchState,ResearchStore} from '@autofold/science-core/store'
export const KnowledgeKinds=['knowledge','literature','claim','alignment','knowledge_cycle','hypothesis','scientist_interpretation'] as const
export const KnowledgeQuery=z.object({query:z.string().trim().max(500).default(''),kinds:z.array(z.enum(KnowledgeKinds)).min(1).max(7).optional(),includeDeprecated:z.boolean().default(true),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(20).default(8)}).strict()
export const KnowledgeRead=z.object({id:z.string().max(500).regex(/^(knw|lit|clm|aln|kcy|hyp|srv)_[A-Za-z0-9_-]+$/),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(20).default(10)}).strict()
export const knowledgeRecordHash=ResearchService.knowledgeRecordHash
const clip=(value:unknown,length:number)=>typeof value==='string'?value.slice(0,length):''
const authority='Read-only projection of authoritative campaign records. Record hashes bind this snapshot, not independent truth. Computational observations require original receipt verification; claims, hypotheses, alignments, synthesis and scientist reviews remain interpretations. Review status or confidence never establishes biological confirmation.'
export interface CampaignKnowledgeOptions {store:ResearchStore;projectId:string;campaignId:string;experimentId?:string;expectedContractHash?:string}
type Kind=typeof KnowledgeKinds[number]
type Node={id:string;kind:Kind;raw:any;title:string;body:string;status:string;createdAt:string;epistemicLabel:string;applicability:string;recordSnapshotHash:string;supersededBy?:{knowledgeId:string;evaluationId:string}}
type Edge={from:string;to:string;relation:string;status?:string;alignmentId?:string}
type KnowledgeSnapshot={campaign:ResearchDomain.Campaign;experiment?:ResearchDomain.Experiment;nodes:Node[];map:Map<string,Node>;edges:Edge[];adjacent:Map<string,Edge[]>;text:Map<string,string>;concepts:ResearchDomain.KnowledgeConcept[];snapshotHash:string}
const projections=new WeakMap<ResearchStore,Map<string,{revision:string;snapshot:KnowledgeSnapshot}>>()
const page=<T>(rows:T[],offset:number,limit:number)=>({items:rows.slice(offset,offset+limit),total:rows.length,offset,limit,hasMore:offset+limit<rows.length,nextOffset:offset+limit<rows.length?offset+limit:null})
/** No files, models, connectors, compute dispatch, publication or store mutation. */
export class CampaignKnowledgeReader {
 constructor(readonly options:CampaignKnowledgeOptions){if(!options.projectId.trim()||!/^cmp_[A-Za-z0-9_-]+$/.test(options.campaignId))throw new Error('Knowledge requires an explicit host-bound project and campaign')}
 private async snapshot():Promise<KnowledgeSnapshot>{
  const store=this.options.store,key=JSON.stringify([this.options.projectId,this.options.campaignId,this.options.experimentId,this.options.expectedContractHash]),cache=projections.get(store),cached=cache?.get(key)
  const observed=store.readWithRevision?await store.readWithRevision(this.options.projectId,cached?.revision):{state:await store.read(this.options.projectId)}
  if(!observed.state){if(!cached||!observed.revision||cached.revision!==observed.revision)throw new Error('Knowledge revision did not bind a snapshot');cache!.delete(key);cache!.set(key,cached);return cached.snapshot}
  const snapshot=this.project(observed.state)
  if(observed.revision&&snapshot.nodes.length<=10000&&snapshot.nodes.reduce((n,node)=>n+JSON.stringify(node.raw).length,0)<=2_000_000){const entries=cache??new Map();entries.delete(key);entries.set(key,{revision:observed.revision,snapshot});while(entries.size>8)entries.delete(entries.keys().next().value!);projections.set(store,entries)}else cache?.delete(key)
  return snapshot
 }
 private project(state:ResearchState):KnowledgeSnapshot {
  const campaign=state.campaigns[this.options.campaignId],experiment=this.options.experimentId?state.experiments[this.options.experimentId]:undefined
  if(!campaign||campaign.projectId!==this.options.projectId)throw new Error('Knowledge campaign is outside this project')
  if(this.options.experimentId&&(!experiment||experiment.campaignId!==campaign.id))throw new Error('Knowledge focus experiment is outside this campaign')
  if(experiment){ResearchDomain.assertContractIntegrity(experiment);if(this.options.expectedContractHash&&experiment.contractHash!==this.options.expectedContractHash)throw new Error('Knowledge frozen experiment contract changed')}
  const inScope=(row:any)=>row.campaignId===campaign.id
  const concepts=Object.values(state.knowledge).filter(inScope),nodes:Node[]=[],edges:Edge[]=[]
  const recovered=new Map(concepts.filter(c=>c.runId&&c.evaluationId&&c.type==='Research Evaluation'&&c.status!=='deprecated').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(c=>[c.runId!,{knowledgeId:c.id,evaluationId:c.evaluationId!}]))
  const failures=new Map(concepts.filter(c=>c.type==='Research Failure'&&c.status==='deprecated'&&c.runId&&recovered.has(c.runId)).map(c=>[c.id,recovered.get(c.runId!)!]))
  const supersession=(kind:Kind,row:any)=>{
   if(kind==='knowledge')return failures.get(row.id)
   if(kind==='knowledge_cycle')return row.inputs.knowledgeIds.map((id:string)=>failures.get(id)).find(Boolean)
   if(kind==='scientist_interpretation'){const found=recovered.get(row.runId),evaluation=found&&state.knowledge[found.knowledgeId];return found&&(row.evidenceSummary?.status==='run_failed'||evaluation&&evaluation.createdAt>row.createdAt)?found:undefined}
   if(kind==='hypothesis'){const known=row.supportingEvidenceRefs.map((id:string)=>state.knowledge[id]).filter(Boolean);if(known.length&&known.every((c:any)=>c.campaignId===campaign.id&&c.type==='Research Failure'&&failures.has(c.id)))return failures.get(known[0].id)}
  }
  const sameExperimentClaims=new Set(experiment?Object.values(state.alignments).filter(a=>a.campaignId===campaign.id&&state.knowledge[a.knowledgeId]?.experimentId===experiment.id&&state.knowledge[a.knowledgeId]?.campaignId===campaign.id).map(a=>a.claimId):[])
  const add=(kind:Kind,raw:any,title:string,body:string,label:string)=>{
   const alignedKnowledge=kind==='alignment'?state.knowledge[raw.knowledgeId]:undefined
   const linkedExperimentId=raw.experimentId??(alignedKnowledge?.campaignId===campaign.id?alignedKnowledge.experimentId:undefined)
   const alignedClaim=kind==='claim'&&sameExperimentClaims.has(raw.id)
   const own=linkedExperimentId&&state.experiments[linkedExperimentId]
   const applicability=!experiment?'campaign_context':linkedExperimentId===experiment.id?'same_experiment':alignedClaim?'same_experiment_claim_alignment_requires_applicability_check':!linkedExperimentId?'campaign_context_requires_applicability_check':own?.contract.targetArtifactHash===experiment.contract.targetArtifactHash?'same_target_other_contract_not_score_comparable':'other_target_or_contract_requires_applicability_check'
   nodes.push({id:raw.id,kind,raw,title,body,status:raw.status??'recorded',createdAt:raw.createdAt??raw.retrievedAt,epistemicLabel:label,applicability,recordSnapshotHash:knowledgeRecordHash(raw),supersededBy:supersession(kind,raw)})
  }
  for(const row of concepts)add('knowledge',row,row.title,row.description+(row.error?'\n'+row.error:''),'persisted_computational_observation_not_biological_confirmation')
  for(const row of Object.values(state.literature).filter(inScope))add('literature',row,row.title,[row.summary,...row.excerpts].filter(Boolean).join('\n'),'retrieved_source_text_not_independently_verified_truth')
  for(const row of Object.values(state.claims).filter(inScope))add('claim',row,row.statement,row.statement+'\n'+row.evidence.map(e=>e.excerpt??'').join('\n'),'source_grounded_interpretation_not_verified_measurement')
  for(const row of Object.values(state.alignments).filter(inScope))add('alignment',row,row.relation+' '+row.claimId+' / '+row.knowledgeId,row.rationale,'proposed_or_reviewed_interpretive_relation')
  for(const row of Object.values(state.knowledgeCycles).filter(inScope))add('knowledge_cycle',row,row.question,[row.campaignSummary,...row.outputs.unresolvedQuestions,row.nextExperiment?.hypothesis,row.nextExperiment?.rationale].filter(Boolean).join('\n'),'synthesis_or_closeout_record_not_new_measurement')
  for(const row of Object.values(state.hypotheses).filter(inScope))add('hypothesis',row,row.statement,[row.prediction,row.falsificationCriterion,row.recommendedExperiment,...row.limitations].filter(Boolean).join('\n'),'hypothesis_interpretation_with_declared_evidence_level_'+row.evidenceLevel)
  for(const row of Object.values(state.scientistReviews).filter(inScope))add('scientist_interpretation',row,row.finding??'Scientist interpretation '+row.id,[row.interpretation,row.nextDecision,...row.limitations].filter(Boolean).join('\n'),'scientist_interpretation_not_measurement')
  const map=new Map(nodes.map(node=>[node.id,node]))
  const edge=(from:string,to:string,relation:string,status?:string,alignmentId?:string)=>{if(map.has(from)&&map.has(to))edges.push({from,to,relation,status,alignmentId})}
  for(const node of nodes){const row=node.raw
   if(node.supersededBy)edge(row.id,node.supersededBy.knowledgeId,'superseded_by_recovered_evaluation','deprecated')
   if(node.kind==='claim')for(const source of row.evidence)edge(row.id,source.literatureId,'cites_source',row.status)
   if(node.kind==='alignment'){edge(row.claimId,row.knowledgeId,row.relation,row.status,row.id);edge(row.id,row.claimId,'aligns_claim',row.status);edge(row.id,row.knowledgeId,'aligns_observation',row.status)}
   if(node.kind==='knowledge_cycle'){for(const id of [...row.inputs.knowledgeIds,...row.inputs.claimIds,...row.inputs.literatureIds])edge(row.id,id,'uses');for(const id of [...row.outputs.claimIds,...row.outputs.literatureIds,...row.outputs.alignmentIds,...row.outputs.hypothesisIds])edge(row.id,id,'produced')}
   if(node.kind==='hypothesis'){for(const id of row.supportingEvidenceRefs)edge(row.id,id,'supports_hypothesis');for(const id of row.opposingEvidenceRefs)edge(row.id,id,'opposes_hypothesis')}
   if(node.kind==='scientist_interpretation')for(const id of row.evidenceRefs??[])edge(row.id,id,'interprets')
  }
  const sorted=nodes.sort((a,b)=>(a.status==='deprecated'||Boolean(a.supersededBy)?1:0)-(b.status==='deprecated'||Boolean(b.supersededBy)?1:0)||Number(b.applicability.startsWith('same_experiment'))-Number(a.applicability.startsWith('same_experiment'))||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id))
  const adjacent=new Map<string,Edge[]>(),text=new Map<string,string>()
  for(const edge of edges)for(const id of new Set([edge.from,edge.to])){const rows=adjacent.get(id)??[];rows.push(edge);adjacent.set(id,rows)}
  for(const node of nodes)text.set(node.id,[node.id,node.title,node.body,JSON.stringify(node.raw.tags??[])].join(' ').toLowerCase())
  return {campaign,experiment,nodes:sorted,map,edges,adjacent,text,concepts,snapshotHash:knowledgeRecordHash(nodes.map(node=>({id:node.id,recordSnapshotHash:node.recordSnapshotHash})).sort((a,b)=>a.id.localeCompare(b.id)))}
 }
 private actor(value:any){return value?{by:clip(value.by,600),at:value.at}:undefined}
 private measurementProvenance(value:any){return {contractHash:value.contractHash,targetArtifactHash:value.targetArtifactHash,evaluatorHash:value.evaluatorHash,programHash:value.programHash,manifestHash:value.manifestHash}}
 private summary(node:Node){return structuredClone({id:node.id,kind:node.kind,title:clip(node.title,600),excerpt:clip(node.body,600),status:node.status,epistemicLabel:node.epistemicLabel,applicability:node.applicability,recordSnapshotHash:node.recordSnapshotHash,createdAt:node.createdAt,generated:this.actor(node.raw.generated),reviewed:this.actor(node.raw.reviewed),...(node.kind==='literature'?{source:{database:clip(node.raw.database,200),sourceId:clip(node.raw.sourceId,1000),contentHash:node.raw.contentHash,url:clip(node.raw.url,2000)}}:{}),...(node.kind==='alignment'?{relation:node.raw.relation}:{}),...(node.supersededBy?{supersededBy:node.supersededBy,historicalOnly:true}:{})})}
 private resultBase(snapshot:Awaited<ReturnType<CampaignKnowledgeReader['snapshot']>>){return {campaignId:snapshot.campaign.id,focusExperimentId:snapshot.experiment?.id,snapshotHash:snapshot.snapshotHash,authority}}
 async query(raw:z.input<typeof KnowledgeQuery>={}){
  const input=KnowledgeQuery.parse(raw),snapshot=await this.snapshot(),tokens=input.query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
  const ranked=snapshot.nodes.filter(node=>(!input.kinds||input.kinds.includes(node.kind))&&(input.includeDeprecated||node.status!=='deprecated'&&!node.supersededBy)).map(node=>{
   const text=snapshot.text.get(node.id)!,matched=tokens.filter(token=>text.includes(token)).length
   return {node,score:matched+(input.query&&text.includes(input.query.toLowerCase())?tokens.length:0)}
  }).filter(row=>!tokens.length||row.score>0).sort((a,b)=>b.score-a.score)
  return {...this.resultBase(snapshot),query:input.query,includeDeprecated:input.includeDeprecated,...page(ranked.map(row=>this.summary(row.node)),input.offset,input.limit)}
 }
 async read(raw:z.input<typeof KnowledgeRead>){
  const input=KnowledgeRead.parse(raw),snapshot=await this.snapshot(),node=snapshot.map.get(input.id)
  if(!node)throw new Error('Knowledge record is missing or outside this campaign')
  const row=node.raw,sources:Array<Record<string,unknown>>=[]
  if(node.kind==='knowledge')for(const source of row.sources)sources.push({id:clip(source.id,200),resource:clip(source.resource,2000),title:clip(source.title,600),provenance:this.measurementProvenance(row.provenance)})
  if(node.kind==='literature')for(const [index,excerpt] of row.excerpts.entries())sources.push({id:row.id,sourceId:clip(row.sourceId,1000),database:clip(row.database,200),url:clip(row.url,2000),contentHash:row.contentHash,retrievedAt:row.retrievedAt,excerptIndex:index,excerpt:clip(excerpt,4000)})
  if(node.kind==='claim')for(const evidence of row.evidence){const source=snapshot.map.get(evidence.literatureId);if(source?.kind==='literature')sources.push({id:source.id,title:clip(source.title,600),contentHash:source.raw.contentHash,database:clip(source.raw.database,200),sourceId:clip(source.raw.sourceId,1000),url:clip(source.raw.url,2000),retrievedAt:source.raw.retrievedAt,excerpt:clip(evidence.excerpt,4000),sourceRecordSnapshotHash:source.recordSnapshotHash});else sources.push({unresolvedSource:true,reason:'Source is missing or outside this campaign'})}
  const related=snapshot.adjacent.get(node.id)??[]
  const details=node.kind==='knowledge'?{type:row.type,score:row.score,decision:row.decision,diagnostics:Object.fromEntries(Object.entries(row.diagnostics).slice(0,20).map(([key,value])=>[clip(key,100),value])),diagnosticCount:Object.keys(row.diagnostics).length,experimentId:row.experimentId,trialId:row.trialId,runId:row.runId,evaluationId:row.evaluationId,provenance:this.measurementProvenance(row.provenance)}:node.kind==='claim'?{kind:row.kind,stance:row.stance,confidence:row.confidence}:node.kind==='alignment'?{claimId:snapshot.map.has(row.claimId)?row.claimId:undefined,knowledgeId:snapshot.map.has(row.knowledgeId)?row.knowledgeId:undefined,relation:row.relation}:node.kind==='hypothesis'?{category:row.category,evidenceLevel:row.evidenceLevel,confidence:row.confidence,prediction:row.prediction,falsificationCriterion:row.falsificationCriterion}:node.kind==='knowledge_cycle'?{trigger:row.trigger,nextReviewAt:row.nextReviewAt,unresolvedQuestions:row.outputs.unresolvedQuestions.slice(0,20),nextExperiment:row.nextExperiment?{action:row.nextExperiment.action,experimentId:row.nextExperiment.experimentId,hypothesis:row.nextExperiment.hypothesis,rationale:row.nextExperiment.rationale,successCriterion:row.nextExperiment.successCriterion}:undefined}:node.kind==='scientist_interpretation'?{revision:row.revision,runId:row.runId,nextDecision:row.nextDecision,evidenceRefs:(row.evidenceRefs??[]).filter((id:string)=>snapshot.map.has(id))}: {sourceId:clip(row.sourceId,1000),database:clip(row.database,200),url:clip(row.url,2000),contentHash:row.contentHash,retrievedAt:row.retrievedAt}
  return structuredClone({...this.resultBase(snapshot),...this.summary(node),body:clip(node.body,8000),bodyTruncated:node.body.length>8000,details,provenance:{recordSnapshotHash:node.recordSnapshotHash,generated:this.actor(row.generated),reviewed:this.actor(row.reviewed),verified:row.verified?.slice(0,10).map((actor:any)=>this.actor(actor)),immutableSourceHashes:sources.map(source=>source.contentHash).filter(Boolean)},sources:page(sources,input.offset,input.limit),relations:page(related,input.offset,input.limit)})
 }
 async current(raw:{limit?:number}={}){
  const {limit}=z.object({limit:z.number().int().min(1).max(12).default(6)}).strict().parse(raw),snapshot=await this.snapshot()
  const take=(kind:Kind,n:number)=>{const rows=snapshot.nodes.filter(node=>node.kind===kind);if(kind==='knowledge_cycle')rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));return rows.slice(0,n)}
  const nodes=[...take('knowledge',limit),...take('claim',limit),...take('literature',Math.min(limit,3))],alignments=take('alignment',limit),cycles=take('knowledge_cycle',3),hypotheses=take('hypothesis',3),reviews=take('scientist_interpretation',3)
  const selected=new Set([...nodes,...alignments,...cycles,...hypotheses,...reviews].map(node=>node.id))
  const concepts=snapshot.concepts.filter(row=>selected.has(row.id)||nodes.some(node=>node.supersededBy?.knowledgeId===row.id))
  const wiki=ResearchKnowledge.renderIndex(snapshot.campaign,concepts,nodes.filter(node=>node.kind==='literature').map(node=>node.raw),nodes.filter(node=>node.kind==='claim').map(node=>node.raw),alignments.map(node=>node.raw),cycles.map(node=>node.raw),[],[],undefined,hypotheses.map(node=>node.raw))
  return {...this.resultBase(snapshot),totalRecords:snapshot.nodes.length,nodes:nodes.map(node=>this.summary(node)),alignments:alignments.map(node=>this.summary(node)),hypotheses:hypotheses.map(node=>this.summary(node)),latestSynthesisCycles:cycles.map(node=>this.summary(node)),scientistInterpretations:reviews.map(node=>this.summary(node)),relations:page(structuredClone(snapshot.edges.filter(edge=>selected.has(edge.from)||selected.has(edge.to))),0,20),okfIndex:wiki.replace(/^No .+yet\.$/gm,'').slice(0,6000),okfIndexScope:'Bounded selection of canonical OKF index; omitted records remain retrievable and are not evidence of absence.',okfIndexTruncated:wiki.length>6000,retrieval:'Use query_knowledge across all campaign records and read_knowledge for attributable bodies/source/edge pages. Other-experiment observations remain marked and are not interchangeable scores.'}
 }
}

export {ProjectKnowledgeGraph, GraphKinds, GraphSearch, GraphRead, GraphTraverse} from './graph'
