import z from 'zod'
import {ResearchDomain} from '@autofold/science-core/domain'
import {ResearchService} from '@autofold/science-core/service'
import type {ResearchStore} from '@autofold/science-core/store'

export const GraphKinds = ['campaign','charter','operation','target','candidate_sequence','configuration','experiment','trial','run','evaluation','observation','knowledge','literature','claim','alignment','hypothesis','interpretation','skill','knowledge_cycle','research_question'] as const
export type GraphKind = typeof GraphKinds[number]
export const GraphSearch = z.object({query:z.string().trim().max(500).default(''), kinds:z.array(z.enum(GraphKinds)).min(1).optional(), limit:z.number().int().min(1).max(20).default(8), offset:z.number().int().min(0).max(100000).default(0), includeDeprecated:z.boolean().default(false)}).strict()
export const GraphRead = z.object({id:z.string().min(1).max(200), expectedHash:z.string().optional()}).strict()
export const GraphTraverse = GraphRead.extend({maxHops:z.number().int().min(1).max(4).default(2), maxNodes:z.number().int().min(1).max(40).default(20), relations:z.array(z.string().max(80)).min(1).max(20).optional()}).strict()
export interface GraphOptions {store:ResearchStore; projectId:string; campaignId:string; experimentId?:string; expectedContractHash?:string}
type Node = {id:string;kind:GraphKind;title:string;body:string;status:string;campaignIds:string[];recordHash:string;epistemicLabel:string;applicability:string;data:Record<string,unknown>;recordedAt?:string}
type Edge = {from:string;to:string;relation:string;authority:'recorded_structure'|'interpretation';recordId:string;recordHash:string;status:string}
type GraphSnapshot = {nodes:Map<string,Node>;edges:Edge[];issues:Array<{code:string;recordId:string}>;snapshotHash:string;focusTargetId?:string;adjacent:Map<string,Edge[]>;text:Map<string,string>}
// Only derivative projections are cached. A store must attest the SAME atomic read
// revision before reuse; historical/custom stores without that port always re-read.
const projections=new WeakMap<ResearchStore,Map<string,{revision:string;snapshot:GraphSnapshot}>>()
const cacheLimit=8

const digest = (value:unknown) => ResearchService.knowledgeRecordHash(value)
const entityId = (kind:string,value:unknown) => kind+'_'+digest(value).slice(7)
const clip = (value:unknown,limit:number) => typeof value==='string'?value.slice(0,limit):''
const bounded=(value:unknown,depth=0):any=>{
  if(typeof value==='string')return value.slice(0,2000)
  if(depth>=5)return '[nested data omitted; read original record]'
  if(Array.isArray(value))return value.slice(0,20).map(item=>bounded(item,depth+1))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,32).map(([key,item])=>[key,bounded(item,depth+1)]))
  return value
}
const retired = (n:Node) => ['deprecated','superseded','rejected'].includes(n.status)
const authority = 'Read-only project graph of persisted records. Edges preserve recorded provenance and interpretation status; they do not establish biological truth. Cross-contract scores are not interchangeable. No inference, dispatch or enrichment is required.'

/** Deterministic projection of one atomic authoritative store snapshot. No second
 * writable graph ledger or ingestion job: duplicate closeouts cannot duplicate nodes. */
export class ProjectKnowledgeGraph {
 constructor(readonly options:GraphOptions) {if(!options.projectId.trim())throw new Error('Graph requires a bound project')}
 private async snapshot():Promise<GraphSnapshot> {
  const store=this.options.store,key=JSON.stringify([this.options.projectId,this.options.campaignId,this.options.experimentId,this.options.expectedContractHash])
  const cache=projections.get(store),cached=cache?.get(key)
  const observed=store.readWithRevision?await store.readWithRevision(this.options.projectId,cached?.revision):{state:await store.read(this.options.projectId)}
  if(!observed.state){if(!cached||!observed.revision||observed.revision!==cached.revision)throw new Error('Graph read revision did not bind a snapshot');cache!.delete(key);cache!.set(key,cached);return cached.snapshot}
  const result=this.project(observed.state)
  if(observed.revision&&result.nodes.size<=10000&&[...result.text.values()].reduce((n,text)=>n+text.length,0)<=2_000_000){const entries=cache??new Map();entries.delete(key);entries.set(key,{revision:observed.revision,snapshot:result});while(entries.size>cacheLimit)entries.delete(entries.keys().next().value!);projections.set(store,entries)}else cache?.delete(key)
  return result
 }
 private project(state:Awaited<ReturnType<ResearchStore['read']>>):GraphSnapshot {
  const bound=state.campaigns[this.options.campaignId]
  if(!bound || bound.projectId!==this.options.projectId)throw new Error('Graph campaign is outside this project')
  const focus=this.options.experimentId?state.experiments[this.options.experimentId]:undefined
  if(this.options.experimentId && (!focus || focus.campaignId!==bound.id))throw new Error('Graph focus is outside the bound campaign')
  if(focus){ResearchDomain.assertContractIntegrity(focus);if(this.options.expectedContractHash&&focus.contractHash!==this.options.expectedContractHash)throw new Error('Graph focus contract changed')}
  const campaigns=new Set(Object.values(state.campaigns).filter(c=>c.projectId===this.options.projectId).map(c=>c.id))
  const experiments=new Map<string,ResearchDomain.Experiment>(),issues:Array<{code:string;recordId:string}>=[]
  for(const e of Object.values(state.experiments).filter(e=>campaigns.has(e.campaignId))){
   try{ResearchDomain.assertContractIntegrity(e);experiments.set(e.id,e)}catch{issues.push({code:'historical_contract_integrity',recordId:e.id})}
  }
  const nodes=new Map<string,Node>(),edges:Edge[]=[]
  const originalRecords=new Map<string,unknown>([state.campaigns,state.campaignCharters,state.jobs,state.experiments,state.trials,state.runs,state.evaluations,state.knowledge,state.searchObservations,state.literature,state.claims,state.alignments,state.hypotheses,state.scientistReviews,state.skillVersions,state.knowledgeCycles,state.researchRequests].flatMap(collection=>Object.values(collection).map(row=>[row.id,row] as [string,unknown])))
  const add=(id:string,kind:GraphKind,row:any,title:string,body:string,data:Record<string,unknown>={},label='persisted_computational_record')=>{
   const e=experiments.get(row.experimentId??(kind==='experiment'?row.id:undefined))
   const campaignId=row.campaignId??e?.campaignId
   if(!campaigns.has(campaignId)||row.experimentId&&!e)return
   const applicability=!focus?'project_context':e?.id===focus.id?'same_experiment':e?.contractHash===focus.contractHash?'same_contract_other_experiment':e?.contract.targetArtifactHash===focus.contract.targetArtifactHash?'same_target_other_contract_not_score_comparable':'project_record_requires_applicability_check'
   nodes.set(id,{id,kind,title:clip(title,600),body:clip(body,4000),status:row.status??'recorded',campaignIds:[campaignId],recordHash:digest(originalRecords.get(id)??row),epistemicLabel:label,applicability,data:bounded(data),recordedAt:row.updatedAt??row.createdAt??row.evaluatedAt??row.retrievedAt})
  }
  const entity=(kind:'target'|'candidate_sequence'|'configuration',value:unknown,campaignId:string,title:string,data:Record<string,unknown>)=>{
   const id=entityId(kind,value),prior=nodes.get(id)
   if(prior){prior.campaignIds=[...new Set([...prior.campaignIds,campaignId])].sort();return id}
   nodes.set(id,{id,kind,title,body:title,status:'recorded',campaignIds:[campaignId],recordHash:digest(value),epistemicLabel:'exact_recorded_identity_not_inferred_equivalence',applicability:kind==='target'&&focus&&value===focus.contract.targetArtifactHash?'same_target':'identity_requires_context',data});return id
  }
  const pending:Array<{from:string;to:string;relation:string;row:any;interpretation?:boolean}>=[]
  const link=(from:string,to:unknown,relation:string,row:any,interpretation=false)=>{if(typeof to==='string')pending.push({from,to,relation,row,interpretation})}
  for(const c of Object.values(state.campaigns).filter(c=>campaigns.has(c.id)))
   add(c.id,'campaign',{...c,campaignId:c.id},c.objective,c.objective,{projectId:c.projectId},'research_scope_not_measurement')
  for(const c of Object.values(state.campaignCharters)){
   add(c.id,'charter',c,'Scientific charter '+c.id,'Declared campaign scientific goals and constraints',{constraints:c.constraints},'declared_objective_not_evidence')
   link(c.id,c.campaignId,'governs_campaign',c)
  }
  for(const j of Object.values(state.jobs)){
   if(j.projectId!==this.options.projectId)continue
   const e='experimentId' in j.payload?experiments.get(String(j.payload.experimentId)):undefined
   const campaignId='campaignId' in j.payload?j.payload.campaignId:e?.campaignId
   add(j.id,'operation',{...j,campaignId,experimentId:e?.id},j.payload.kind+' '+j.id,j.error??j.status,{kind:j.payload.kind,status:j.status,error:j.error,attempts:j.attempts},'operation_provenance_not_scientific_measurement')
   if(e)link(j.id,e.id,'operates_on_experiment',j)
  }
  for(const e of experiments.values()){
   add(e.id,'experiment',e,e.contract.objective,e.contract.objective,{contractHash:e.contractHash,evaluatorHash:e.contract.evaluator.sourceHash,seeds:e.contract.evaluator.fixedSeeds,modality:e.contract.modality})
   const target=entity('target',e.contract.targetArtifactHash,e.campaignId,'Target artifact '+e.contract.targetArtifactHash,{targetArtifactHash:e.contract.targetArtifactHash})
   link(e.id,target,'studies_target',e);link(e.id,e.campaignId,'in_campaign',e)
  }
  for(const t of Object.values(state.trials)){
   const e=experiments.get(t.experimentId);if(!e)continue
   add(t.id,'trial',{...t,campaignId:e.campaignId},t.hypothesis,t.hypothesis,{intent:t.intent,programHash:t.programHash,programPath:t.programPath,decisionPlan:t.decisionPlan?{question:t.decisionPlan.question,selectedAlternativeId:t.decisionPlan.selectedAlternativeId,rationale:clip(t.decisionPlan.rationale,1000)}:undefined,contractHash:e.contractHash})
   link(t.id,e.id,'in_experiment',t);link(t.id,t.parentTrialId,'derived_from_trial',t);link(t.id,t.replicateOfTrialId,'replicates_trial',t)
   const configuration=entity('configuration',{contractHash:e.contractHash,configurationFamilyFingerprint:t.configurationFamilyFingerprint??t.programHash},e.campaignId,'Configuration '+(t.configurationFamilyFingerprint??t.programHash),{contractHash:e.contractHash,configurationFamilyFingerprint:t.configurationFamilyFingerprint,exactProgramHash:t.configurationFamilyFingerprint?undefined:t.programHash,generators:t.generators??[],allocations:t.generatorAllocations??[]})
   link(t.id,configuration,'uses_configuration',t)
   for(const ref of t.skills)link(t.id,ref.versionId,'uses_skill',t)
   for(const ref of [...(t.evidenceRefs??[]),...(t.decisionPlan?.evidenceRefs??[])])link(t.id,ref,'uses_evidence',t,true)
  }
  for(const r of Object.values(state.runs)){
   const t=state.trials[r.trialId],e=t&&experiments.get(t.experimentId);if(!e)continue
   add(r.id,'run',{...r,campaignId:e.campaignId,experimentId:e.id},'Run '+r.id,r.error??r.status,{trialId:t.id,manifestHash:r.manifestHash,bundlePath:r.bundlePath,outputPath:r.outputPath,status:r.status})
   link(r.id,t.id,'executes_trial',r)
  }
  const runsByTrial=new Map<string,ResearchDomain.Run[]>()
  for(const run of Object.values(state.runs)){const rows=runsByTrial.get(run.trialId)??[];rows.push(run);runsByTrial.set(run.trialId,rows)}
  for(const v of Object.values(state.evaluations)){
   const t=state.trials[v.trialId],e=t&&experiments.get(t.experimentId);if(!e)continue
   add(v.id,'evaluation',{...v,campaignId:e.campaignId,experimentId:e.id},'Evaluation '+v.id,'Locked score '+v.score,{score:v.score,valid:v.valid,contractHash:v.contractHash,evaluatorHash:v.evaluatorHash,diagnostics:v.diagnostics})
   link(v.id,t.id,'measures_trial',v)
   for(const r of runsByTrial.get(t.id)??[])link(v.id,r.id,'measured_from_run',v)
  }
  for(const k of Object.values(state.knowledge)){
   add(k.id,'knowledge',k,k.title,k.description,{score:k.score,decision:k.decision,diagnostics:k.diagnostics,provenance:k.provenance,sources:k.sources.slice(0,4),sourceCount:k.sources.length},'persisted_observation_not_biological_confirmation')
   link(k.id,k.trialId,'summarizes_trial',k);link(k.id,k.runId,'summarizes_run',k);link(k.id,k.evaluationId,'summarizes_evaluation',k)
   const e=experiments.get(k.experimentId);if(e)link(k.id,entity('target',e.contract.targetArtifactHash,e.campaignId,'Target artifact '+e.contract.targetArtifactHash,{targetArtifactHash:e.contract.targetArtifactHash}),'about_target',k)
  }
  for(const o of Object.values(state.searchObservations)){
   add(o.id,'observation',o,o.hypothesis,o.hypothesis,{score:o.score,decision:o.decision,diagnostics:o.diagnostics,seeds:o.seeds,models:o.modelIds,generationStochasticity:o.generationStochasticity},'receipt_bound_closeout_not_biological_confirmation')
   link(o.id,o.trialId,'observes_trial',o);link(o.id,o.runId,'observes_run',o);link(o.id,o.evaluationId,'observes_evaluation',o);link(o.id,o.knowledgeId,'has_summary',o)
   if(campaigns.has(o.campaignId)&&experiments.has(o.experimentId))for(const seq of o.candidateSequences)link(o.id,entity('candidate_sequence',seq,o.campaignId,seq,{sequence:seq}),'observed_sequence',o)
  }
  for(const p of Object.values(state.literature))add(p.id,'literature',p,p.title,[p.summary,...p.excerpts].filter(Boolean).join('\n'),{database:p.database,sourceId:p.sourceId,url:p.url,contentHash:p.contentHash,excerpts:p.excerpts.slice(0,4).map(v=>clip(v,1000)),excerptCount:p.excerpts.length},'retrieved_source_not_independently_verified_truth')
  for(const c of Object.values(state.claims)){
   add(c.id,'claim',c,c.statement,c.statement,{confidence:c.confidence,stance:c.stance,evidence:c.evidence.slice(0,4),evidenceCount:c.evidence.length},'source_grounded_interpretation')
   for(const r of c.evidence)link(c.id,r.literatureId,'cites_source',c,true)
  }
  for(const a of Object.values(state.alignments)){
   add(a.id,'alignment',a,a.relation+' '+a.claimId,a.rationale,{rationale:a.rationale},'interpretive_relation')
   link(a.claimId,a.knowledgeId,a.relation,a,true);link(a.id,a.claimId,'aligns_claim',a,true);link(a.id,a.knowledgeId,'aligns_observation',a,true)
  }
  for(const h of Object.values(state.hypotheses)){
   add(h.id,'hypothesis',h,h.statement,h.statement,{prediction:h.prediction,limitations:h.limitations,evidenceLevel:h.evidenceLevel},'hypothesis_not_measurement')
   for(const r of h.supportingEvidenceRefs)link(h.id,r,'supported_by',h,true)
   for(const r of h.opposingEvidenceRefs)link(h.id,r,'opposed_by',h,true)
  }
  for(const r of Object.values(state.scientistReviews)){
   add(r.id,'interpretation',r,r.finding??'Scientist interpretation',r.interpretation+'\n'+r.nextDecision,{limitations:r.limitations},'scientist_interpretation_not_measurement')
   for(const ref of r.evidenceRefs)link(r.id,ref,'interprets',r,true)
  }
  for(const s of Object.values(state.skillVersions)){
   add(s.id,'skill',s,s.skillId+' v'+s.version,s.skillId,{contentHash:s.contentHash,path:s.path,replay:s.replay?{passed:s.replay.passed,benchmarkId:s.replay.benchmarkId,campaignIds:s.replay.campaignIds}:undefined},'versioned_procedure_requires_applicability_and_validation')
   link(s.id,s.parentVersionId,'derived_from_skill',s);for(const r of s.trajectoryRefs)link(s.id,r,'learned_from',s,true)
  }
  for(const r of Object.values(state.researchRequests)){
   add(r.id,'research_question',r,r.request.question,r.request.question,{purpose:r.request.purpose,requiredEvidence:r.request.requiredEvidence,competingExplanations:r.request.competingExplanations,decisionIfResolved:r.request.decisionIfResolved},'advisory_question_not_measurement')
   link(r.id,r.experimentId,'questions_experiment',r,true)
   for(const ref of r.evidenceRefs??[])link(r.id,ref,'question_uses_evidence',r,true)
  }
  for(const c of Object.values(state.knowledgeCycles)){
   add(c.id,'knowledge_cycle',c,c.question??'Knowledge closeout',c.campaignSummary??'',{unresolvedQuestions:c.outputs.unresolvedQuestions},'synthesis_not_new_measurement')
   for(const ref of [...c.inputs.knowledgeIds,...c.inputs.claimIds,...c.inputs.literatureIds])link(c.id,ref,'uses_evidence',c,true)
  }
  const seen=new Set<string>()
  for(const p of pending){
   if(p.row.campaignId && !campaigns.has(p.row.campaignId))continue
   if(!nodes.has(p.from))continue
   if(!nodes.has(p.to)){issues.push({code:'missing_or_out_of_scope_link',recordId:p.from});continue}
   // An alignment from a foreign project must never connect otherwise visible IDs.
   if(p.row.campaignId && !campaigns.has(p.row.campaignId))continue
   const key=[p.from,p.to,p.relation,p.row.id].join(':');if(seen.has(key))continue;seen.add(key)
   edges.push({from:p.from,to:p.to,relation:p.relation,authority:p.interpretation?'interpretation':'recorded_structure',recordId:p.row.id,recordHash:digest(p.row),status:p.row.status??'recorded'})
  }
  edges.sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to)||a.relation.localeCompare(b.relation)||a.recordId.localeCompare(b.recordId))
  const snapshotHash=digest({nodes:[...nodes.values()].sort((a,b)=>a.id.localeCompare(b.id)),edges})
  const adjacent=new Map<string,Edge[]>(),text=new Map<string,string>()
  for(const edge of edges)for(const id of new Set([edge.from,edge.to])){const rows=adjacent.get(id)??[];rows.push(edge);adjacent.set(id,rows)}
  for(const node of nodes.values())text.set(node.id,[node.title,node.body,JSON.stringify(node.data)].join(' ').toLowerCase())
  return {nodes,edges,issues,snapshotHash,adjacent,text,focusTargetId:focus?entityId('target',focus.contract.targetArtifactHash):undefined}
 }
 private summary(n:Node) {return structuredClone({...n,body:n.body.slice(0,600),data:undefined})}
 private base(s:Awaited<ReturnType<ProjectKnowledgeGraph['snapshot']>>) {return {projectId:this.options.projectId,scope:'project_records_in_bound_store',focusExperimentId:this.options.experimentId,focusTargetId:s.focusTargetId,snapshotHash:s.snapshotHash,authority,issues:structuredClone(s.issues.slice(0,20)),issueCount:s.issues.length}}
 async search(raw:z.input<typeof GraphSearch>={}) {
  const input=GraphSearch.parse(raw),s=await this.snapshot(),tokens=input.query.toLowerCase().split(/\s+/).filter(Boolean)
  const ranked=[...s.nodes.values()].filter(n=>(input.includeDeprecated||!retired(n))&&(!input.kinds||input.kinds.includes(n.kind))).map(n=>{
   const text=s.text.get(n.id)!;return {node:n,score:tokens.filter(t=>text.includes(t)).length}
  }).filter(r=>!tokens.length||r.score>0).sort((a,b)=>b.score-a.score||Number(b.node.applicability==='same_experiment')-Number(a.node.applicability==='same_experiment')||a.node.id.localeCompare(b.node.id))
  const items=ranked.slice(input.offset,input.offset+input.limit).map(({node:n})=>this.summary(n))
  return {...this.base(s),items,total:ranked.length,offset:input.offset,nextOffset:input.offset+items.length<ranked.length?input.offset+items.length:null}
 }
 async read(raw:z.input<typeof GraphRead>) {
  const input=GraphRead.parse(raw),s=await this.snapshot(),node=s.nodes.get(input.id);if(!node)throw new Error('Graph node is missing or outside this project')
  if(input.expectedHash&&input.expectedHash!==node.recordHash)throw new Error('Graph node revision changed; retrieve current evidence')
  const neighbors=s.adjacent.get(node.id)??[]
  return {...this.base(s),node:structuredClone(node),relations:structuredClone(neighbors.slice(0,40)),relationCount:neighbors.length,relationsTruncated:neighbors.length>40}
 }
 async traverse(raw:z.input<typeof GraphTraverse>) {
  const input=GraphTraverse.parse(raw),s=await this.snapshot(),root=s.nodes.get(input.id);if(!root)throw new Error('Graph node is missing or outside this project')
  if(input.expectedHash&&input.expectedHash!==root.recordHash)throw new Error('Graph node revision changed; retrieve current evidence')
  const ids=new Set([root.id]),paths:Record<string,string[]>={[root.id]:[]};let frontier=[root.id],truncated=false
  for(let hop=0;hop<input.maxHops&&frontier.length;hop++){
   const next:string[]=[]
   // Surface contradictions first rather than hiding them behind structural fanout.
   const adjacent=[...new Set(frontier.flatMap(id=>s.adjacent.get(id)??[]))].filter(e=>!input.relations||input.relations.includes(e.relation)).sort((a,b)=>Number(['refutes','opposed_by'].includes(b.relation))-Number(['refutes','opposed_by'].includes(a.relation)))
   for(const e of adjacent){const from=frontier.includes(e.from)?e.from:e.to,to=from===e.from?e.to:e.from;if(ids.has(to))continue;if(ids.size>=input.maxNodes){truncated=true;continue}ids.add(to);paths[to]=[...paths[from]!,e.recordId+':'+e.relation];next.push(to)}
   frontier=next
  }
  const edges=s.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&(!input.relations||input.relations.includes(e.relation)))
  return {...this.base(s),nodes:[...ids].map(id=>this.summary(s.nodes.get(id)!)),edges:structuredClone(edges.slice(0,120)),paths,maxHops:input.maxHops,truncated:truncated||edges.length>120,limitation:'Bounded neighborhood, not evidence of absence; follow node IDs or adjust relation filters. Retired and conflicting evidence remains visible.'}
 }
 /** Bounded evidence for the next decision, from one atomic graph snapshot. */
 async planningView() {
  const s=await this.snapshot(),target=s.focusTargetId
  const experimentIds=new Set(s.edges.filter(e=>e.to===target&&e.relation==='studies_target').map(e=>e.from))
  const related=new Set([...s.nodes.values()].filter(n=>n.applicability==='same_experiment'||n.applicability==='same_target_other_contract_not_score_comparable'||experimentIds.has(n.id)).map(n=>n.id))
  for(const e of s.edges)if(e.relation==='about_target'&&e.to===target)related.add(e.from)
  // Include attributable contradictions and questions connected to applicable evidence.
  for(let hop=0;hop<2;hop++)for(const e of s.edges){if(related.has(e.from)&&['cites_source','opposed_by','supported_by'].includes(e.relation))related.add(e.to);if(related.has(e.to)&&['interprets','aligns_observation','aligns_claim','cites_source','question_uses_evidence','questions_experiment','observes_trial','summarizes_trial','refutes','supports','opposed_by'].includes(e.relation))related.add(e.from)}
  const observationsByCandidate=new Map<string,Node[]>()
  for(const edge of s.edges)if(edge.relation==='observed_sequence'&&related.has(edge.from)){const rows=observationsByCandidate.get(edge.to)??[];rows.push(s.nodes.get(edge.from)!);observationsByCandidate.set(edge.to,rows)}
  const repeated=[...s.nodes.values()].filter(n=>n.kind==='candidate_sequence').map(n=>{
   const observations=observationsByCandidate.get(n.id)??[]
   return {node:n,observations}
  }).filter(r=>r.observations.length>1).slice(0,4)
  const emphasized=new Set(repeated.flatMap(r=>r.observations.map(n=>n.id)))
  for(const e of s.edges)if(['refutes','opposed_by'].includes(e.relation)&&(related.has(e.from)||related.has(e.to))){emphasized.add(e.from);emphasized.add(e.to)}
  const kinds=new Set<GraphKind>(['observation','evaluation','interpretation','claim','hypothesis','research_question','knowledge'])
  const selected=[...s.nodes.values()].filter(n=>related.has(n.id)&&kinds.has(n.kind)).sort((a,b)=>Number(emphasized.has(b.id))-Number(emphasized.has(a.id))||Number(b.applicability==='same_experiment')-Number(a.applicability==='same_experiment')||(b.recordedAt??'').localeCompare(a.recordedAt??'')||a.id.localeCompare(b.id)).slice(0,12)
  const ids=new Set(selected.map(n=>n.id)),relations=s.edges.filter(e=>ids.has(e.from)||ids.has(e.to)).slice(0,60)
  return {...this.base(s),nodeCount:s.nodes.size,edgeCount:s.edges.length,
   planningEvidence:selected.map(n=>({...this.summary(n),data:structuredClone(n.data)})),relations:structuredClone(relations),
   sourceRecords:[...new Set(relations.flatMap(e=>[e.from,e.to]))].filter(id=>!ids.has(id)).slice(0,24).map(id=>({...this.summary(s.nodes.get(id)!),data:structuredClone(s.nodes.get(id)!.data)})),
   repeatedCandidates:repeated.map(r=>({candidate:this.summary(r.node),observationCount:r.observations.length,observations:r.observations.slice(0,20).map(n=>this.summary(n)),limitation:'Same recorded sequence is not an independent new candidate or proof of equivalent conditions. Inspect original run and generation identities.'})),
   truncated:[...related].filter(id=>kinds.has(s.nodes.get(id)?.kind!)).length>selected.length||relations.length===60,
   retrieval:'Use this graph evidence when comparing alternatives. Expand with read_graph_node/traverse_graph for provenance, unresolved questions or contradictions. Other-campaign records remain references; they do not expand authorized evidence scope.'}
 }
 async brief(){const s=await this.snapshot();return {...this.base(s),nodeCount:s.nodes.size,edgeCount:s.edges.length,retrieval:'Use search_graph, read_graph_node and traverse_graph. Records from other campaigns are reference evidence, not authority to change this experiment or reuse incomparable scores.'}}
}
