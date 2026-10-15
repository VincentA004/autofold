import z from 'zod'
import type {ResearchState} from './store'
import type {ResearchDomain} from './domain'
import {CampaignEvidence} from './campaign-evidence'
import {ResearchQuestions} from './research-questions'
import {DecisionEvidence} from './decision-evidence'
import {EvidenceView} from './evidence-view'
import {ResearchScientistMemory} from './scientist-memory'
import {ResearchTrajectoryCloseout} from './trajectory-closeout'
import {operationHash} from './operations'

/** One deterministic delivery over an immutable, host-supplied scientific snapshot.
 * No projection, model, filesystem or dispatch port participates in its construction. */
export namespace DecisionMemory {
  const hash=(value:unknown)=>'sha256:'+operationHash(value)
  const Digest=z.string().regex(/^sha256:[a-f0-9]{64}$/)
  export const Scope=z.object({projectId:z.string().min(1),campaignId:z.string(),experimentId:z.string()})
  export type Scope=z.infer<typeof Scope>
  export const Guide=z.object({versionId:z.string(),skillId:z.string(),contentHash:Digest,version:z.number(),status:z.string(),
    capabilities:z.array(z.string()),path:z.string().optional(),validations:z.array(z.unknown()).optional()}).passthrough()
  export type Guide=z.infer<typeof Guide>
  export const Source=z.object({id:z.string(),kind:z.string(),hash:Digest,layer:z.enum(['evidence','interpretation','guidance'])})
  export type Source=z.infer<typeof Source>
  export const SourceManifest=z.object({format:z.literal('autofold.decision-memory-source.v1'),scope:Scope,snapshotHash:Digest,
    revisions:z.object({evidence:Digest,interpretation:Digest,guidance:Digest}),sources:z.array(Source),
    cutoff:z.object({kind:z.literal('exact_source_inventory'),latestObservationAt:z.string().nullable(),sourceCount:z.number().int().nonnegative()})}).superRefine((manifest,context)=>{
    const revisions={evidence:hash(manifest.sources.filter(s=>s.layer==='evidence')),interpretation:hash(manifest.sources.filter(s=>s.layer==='interpretation')),guidance:hash(manifest.sources.filter(s=>s.layer==='guidance'))}
    if(operationHash(revisions)!==operationHash(manifest.revisions)||manifest.cutoff.sourceCount!==manifest.sources.length||manifest.snapshotHash!==hash({scope:manifest.scope,sources:manifest.sources,revisions,cutoff:manifest.cutoff}))context.addIssue({code:'custom',message:'Decision memory source manifest integrity differs'})
  })
  export type SourceManifest=z.infer<typeof SourceManifest>
  export const SourceBinding=z.object({format:z.literal('autofold.decision-memory-source-binding.v1'),scope:Scope,snapshotHash:Digest,
    revisions:SourceManifest.shape.revisions,cutoff:SourceManifest.shape.cutoff,sources:z.array(Source).max(100),selectedSourcesHash:Digest,
    manifestPath:z.string().regex(/^evidence\/memory\/[a-f0-9]{64}\.json$/),manifestHash:Digest,publicationStatus:z.enum(['not_checked','available','unavailable'])
  }).superRefine((binding,context)=>{if(binding.selectedSourcesHash!==hash(binding.sources)||binding.manifestPath!==`evidence/memory/${binding.manifestHash.slice(7)}.json`)context.addIssue({code:'custom',message:'Selected source binding integrity differs'})})
  export type SourceBinding=z.infer<typeof SourceBinding>

  export interface Receipt {
    runId:string;status:'verified'|'unavailable'|'not_selected';receiptHash?:string;reason?:string
    run?:{id:string;status:string;startedAt?:string;completedAt?:string}
    modelEvidence?:readonly EvidenceView.Decision[];candidates?:readonly unknown[];scientific?:boolean;evidenceKind?:string;evidenceCompleteness?:unknown
    comparisonProvenance?:DecisionEvidence.VerifiedComparisonProvenance
    seedRoles?:SeedRoleEvidence
  }
  const SeedValue=z.number().int().refine(Number.isSafeInteger)
  export const SeedRoleEvidence=z.object({
    format:z.literal('autofold.generation-seed-roles.v1'),
    hostGenerationSeed:z.object({value:z.number().int().min(0).max(0xffff_ffff),source:z.enum(['trial_bundle.generationSeed','trial_binding_fallback'])}).strict(),
    effectiveProgramSeeds:z.array(z.object({lane:z.number().int().nonnegative(),value:SeedValue.nullable(),source:z.enum(['verified_native_projection.programSeed','runtime_program.seed'])}).strict()).max(6).optional(),
    declaredPredictorSeeds:z.array(z.object({lane:z.number().int().nonnegative(),stage:z.string().nullable(),constraint:z.string().nullable(),function:z.string().nullable(),field:z.literal('predictor_seed'),value:SeedValue,source:z.literal('verified_native_projection.constraint.config')}).strict()).max(6).optional(),
    observedToolConfigSeeds:z.array(z.object({requestId:z.string().min(1),tool:z.string().min(1),role:z.enum(['predictor_tool','generator_tool','registered_tool']),source:z.literal('verified_native_tool_call.config'),seed:SeedValue.nullable().optional(),seeds:z.array(SeedValue).max(16).optional(),omittedSeeds:z.number().int().nonnegative().optional()}).strict()).max(6).optional(),
    evaluatorSeeds:z.object({values:z.array(SeedValue).max(16),source:z.literal('trial_bundle.seeds'),omitted:z.number().int().nonnegative().optional()}).strict().optional(),
    omitted:z.object({effectiveProgramSeeds:z.number().int().nonnegative().optional(),declaredPredictorSeeds:z.number().int().nonnegative().optional(),observedToolConfigSeeds:z.number().int().nonnegative().optional()}).strict().optional(),
  }).strict()
  export type SeedRoleEvidence=z.infer<typeof SeedRoleEvidence>
  export const Query=z.object({question:z.string().optional(),configurationFamilyFingerprint:z.string().optional(),
    intent:z.string().optional(),evidenceRefs:z.array(z.string()).optional(),maxFacts:z.number().int().min(1).max(64).optional(),
    maxInterpretations:z.number().int().min(1).max(32).optional()}).strict()
  export type Query=z.infer<typeof Query>
  export const RawModelRow=z.object({candidateId:z.string().optional(),stage:z.string().optional(),modelId:z.string(),seed:z.number().finite(),status:z.enum(['completed','skipped']),metrics:z.record(z.string(),z.number().finite()),omittedMetrics:z.number().int().nonnegative()})
  export const RawModelEvidence=z.object({rows:z.array(RawModelRow).max(6),totalRows:z.number().int().nonnegative().nullable(),omittedRows:z.number().int().nonnegative().nullable()})
  export const Fact=z.object({runId:z.string(),trialId:z.string(),observationId:z.string().nullable(),source:Source,
    receiptStatus:z.enum(['verified','unavailable','not_selected']),receiptHash:Digest.nullable(),receiptAuthority:z.enum(['canonical_commit','raw_verified','historical_record']),
    rawModelEvidence:RawModelEvidence,qualification:z.object({scientific:z.boolean().nullable(),evidenceKind:z.string().nullable(),evidenceCompleteness:z.unknown().nullable(),metadataTruncated:z.boolean()}),valid:z.boolean().nullable(),
    outcome:z.enum(['failed','invalid','valid','unknown']),score:z.number().finite().nullable(),
    recordedScore:z.number().finite().nullable(),decision:z.string(),intent:z.string(),createdAt:z.string(),
    programHash:z.string().nullable(),configurationFamilyFingerprint:z.string().nullable(),
    seedRoles:SeedRoleEvidence.optional(),
    generationStochasticity:z.string().nullable(),replicateOfTrialId:z.string().nullable(),
    modelIds:z.array(z.string()),seeds:z.array(z.number()),diagnostics:z.record(z.string(),z.number()),
    evidencePath:z.string(),error:z.string().nullable(),limitations:z.array(z.string())})
  export type Fact=z.infer<typeof Fact>
  export const Interpretation=z.object({id:z.string(),kind:z.string(),source:Source,statement:z.string(),status:z.string(),
    runId:z.string().optional(),reviewRevision:z.number().int().positive().optional(),nextDecision:z.string().optional(),requestId:z.string().optional(),revision:z.string().nullable().optional(),remainingGap:z.string().nullable().optional(),omittedEvidenceRefs:z.number(),applicability:z.enum(['same_experiment','campaign_analogy']),supportingSources:z.array(Source),opposingSources:z.array(Source),
    unresolvedRefs:z.array(z.string()),limitations:z.array(z.string()),epistemicStatus:z.literal('attributed_interpretation')})
  export type Interpretation=z.infer<typeof Interpretation>
  export const CompactQuestionRequest=z.object({question:z.string().max(600),requiredEvidence:z.string().max(600),purpose:z.enum(['empirical_test','knowledge_lookup']).optional(),prerequisiteBranchId:z.string().optional(),action:z.enum(['create','reference','reopen']).optional()}).strict()
  export const OpenQuestion=z.object({id:z.string(),source:Source,question:z.string().max(600),applicability:z.string(),requestId:z.string(),revision:z.string().nullable(),status:z.enum(['open','blocked']),assessment:z.string().max(600).nullable(),remainingGap:z.string().max(600).nullable(),nextAction:z.string().max(600).nullable(),occurrenceIds:z.array(z.string()).max(8),omittedOccurrences:z.number().int().nonnegative(),evidenceRefs:z.array(z.string()).max(8),omittedEvidenceRefs:z.number().int().nonnegative(),request:CompactQuestionRequest}).strict()
  export const Packet=z.object({format:z.literal('autofold.decision-memory.v1'),sourceManifest:SourceBinding,
    facts:z.array(Fact),interpretations:z.array(Interpretation),proceduralGuidance:z.array(Guide),
    comparisons:z.array(z.unknown()),replications:z.object({families:z.array(z.unknown()),repeatedOutputs:z.array(z.unknown())}),
    openQuestions:z.array(OpenQuestion),
    coverage:z.object({totalRecords:z.number(),deliveredFacts:z.number(),omittedFacts:z.number(),verifiedReceipts:z.number(),
      unavailableReceipts:z.number(),notSelectedReceipts:z.number(),invalidRuns:z.number(),failedRuns:z.number(),omittedInterpretations:z.number(),omittedQuestions:z.number(),gapCount:z.number(),omittedGaps:z.number(),gaps:z.array(z.object({id:z.string(),reason:z.string()}))}),
    deltas:z.object({baseline:z.boolean(),added:z.array(Source),changed:z.array(Source),removed:z.array(Source),counts:z.object({added:z.number(),changed:z.number(),removed:z.number()}),omitted:z.number()}),
    freshness:z.object({mode:z.literal('canonical_ledger'),canonicalEvidenceRevision:Digest,projectionEvidenceRevision:Digest.nullable(),fallback:z.boolean()}),
    retrieval:z.object({query:Query,configHash:Digest,backend:z.literal('deterministic_ledger'),selectedOrder:z.array(z.string()),
      bytes:z.number().int().nonnegative(),inferenceRequestIds:z.array(z.string()).max(0)}),
    expansion:z.object({ledgerPath:z.string(),archivePath:z.string(),questionsPath:z.string().optional(),sourcesPath:z.string(),publicationStatus:z.enum(['not_checked','available','unavailable'])}),limitation:z.string()})
  export type Packet=z.infer<typeof Packet>
  export interface Input {state:ResearchState;scope:Scope;legacyEvents?:ResearchScientistMemory.TrajectoryEvent[];
    receipts?:Receipt[];guides?:Guide[];query?:Query;previousManifest?:SourceManifest;projectionWatermark?:string}
  const key=(source:Source)=>source.layer+':'+source.kind+':'+source.id
  function scoped(state:ResearchState,raw:Scope){
    const scope=Scope.parse(raw),experiment=state.experiments[scope.experimentId]
    if(!experiment||experiment.campaignId!==scope.campaignId||state.campaigns[scope.campaignId]?.projectId!==scope.projectId)throw new Error('Decision memory scope differs from original experiment')
    return {scope,experiment,catalog:CampaignEvidence.resolve(state,scope)}
  }
  function originalEvents(state:ResearchState,scope:Scope,legacy:ResearchScientistMemory.TrajectoryEvent[]){
    const events=legacy.filter(event=>event.experimentId===scope.experimentId)
    for(const event of events)if(event.campaignId&&event.campaignId!==scope.campaignId||event.contractHash!==state.experiments[scope.experimentId]!.contractHash)throw new Error('Historical decision memory scope differs')
    // The closeout verifies every v2 commit, including its original operation binding.
    return ResearchTrajectoryCloseout.events(state,events,scope.experimentId)
  }
  export function sourceManifest(state:ResearchState,rawScope:Scope,legacyEvents:ResearchScientistMemory.TrajectoryEvent[]=[],guides:Guide[]=[]):SourceManifest {
    const {scope,experiment,catalog}=scoped(state,rawScope),events=originalEvents(state,scope,legacyEvents),sources:Source[]=[]
    const add=(id:string,kind:string,value:unknown,layer:Source['layer'])=>sources.push({id,kind,hash:hash(value),layer})
    add(experiment.id,'experiment',{id:experiment.id,campaignId:experiment.campaignId,contract:experiment.contract,contractHash:experiment.contractHash,incumbentTrialId:experiment.incumbentTrialId},'evidence')
    const collections=['trials','evaluations','runs','searchObservations','knowledge','literature','claims','alignments','knowledgeCycles','hypotheses','researchRequests','campaignCharters','scientistReviews','experimentBranches'] as const
    for(const collection of collections)for(const [id,record] of Object.entries(state[collection])){
      const allowed=collection==='experimentBranches'?(record as {experimentId:string}).experimentId===scope.experimentId:collection==='scientistReviews'
        ? (record as {experimentId:string;campaignId:string}).experimentId===scope.experimentId&&(record as {campaignId:string}).campaignId===scope.campaignId : catalog.has(id)
      if(!allowed)continue
      if(collection==='runs'){
        const run=record as ResearchDomain.Run
        // Execution leases, mutable checkpoints, output locations and publication acknowledgements are not scientific revisions.
        add(id,collection,{id:run.id,trialId:run.trialId,status:run.status,manifestHash:run.manifestHash,error:run.error,startedAt:run.startedAt,completedAt:run.completedAt},'evidence')
      }else if(collection==='trials'){
        const {status,updatedAt,origin,...scientific}=record as ResearchDomain.Trial
        add(id,collection,scientific,'evidence')
      }else add(id,collection,record,['claims','alignments','knowledgeCycles','hypotheses','researchRequests','campaignCharters','scientistReviews','experimentBranches'].includes(collection)?'interpretation':'evidence')
    }
    // Preserve each historical source identity, including superseded failures; never rewrite its bytes.
    for(const event of events.filter(event=>event.closeoutVersion!==2))add(ResearchScientistMemory.eventHash(event),'legacy_event',event,'evidence')
    for(const guide of guides){const parsed=Guide.parse(guide);add(parsed.versionId,'assigned_guide',parsed,'guidance')}
    sources.sort((a,b)=>key(a).localeCompare(key(b)))
    if(new Set(sources.map(key)).size!==sources.length)throw new Error('Decision memory source identity is duplicated')
    const revisions={evidence:hash(sources.filter(s=>s.layer==='evidence')),interpretation:hash(sources.filter(s=>s.layer==='interpretation')),guidance:hash(sources.filter(s=>s.layer==='guidance'))}
    const times=[...Object.values(state.searchObservations).filter(o=>o.experimentId===scope.experimentId).map(o=>o.createdAt),...events.map(e=>e.recordedAt)].sort()
    const cutoff={kind:'exact_source_inventory' as const,latestObservationAt:times.at(-1)??null,sourceCount:sources.length}
    return SourceManifest.parse({format:'autofold.decision-memory-source.v1',scope,snapshotHash:hash({scope,sources,revisions,cutoff}),revisions,sources,cutoff})
  }
  function delta(manifest:SourceManifest,prior?:SourceManifest){
    if(prior)prior=SourceManifest.parse(prior)
    if(prior&&(prior.scope.projectId!==manifest.scope.projectId||prior.scope.campaignId!==manifest.scope.campaignId||prior.scope.experimentId!==manifest.scope.experimentId))throw new Error('Previous decision memory scope differs')
    if(!prior)return {baseline:true,added:[],changed:[],removed:[],counts:{added:0,changed:0,removed:0},omitted:0}
    const previous=new Map(prior.sources.map(s=>[key(s),s])??[]),current=new Map(manifest.sources.map(s=>[key(s),s]))
    const added=manifest.sources.filter(s=>!previous.has(key(s))),changed=manifest.sources.filter(s=>previous.has(key(s))&&previous.get(key(s))!.hash!==s.hash),removed=[...previous.values()].filter(s=>!current.has(key(s)))
    return {baseline:false,added:added.slice(0,24),changed:changed.slice(0,24),removed:removed.slice(0,24),counts:{added:added.length,changed:changed.length,removed:removed.length},omitted:Math.max(0,added.length-24)+Math.max(0,changed.length-24)+Math.max(0,removed.length-24)}
  }
  /** Display previews never change full-ledger totals or descriptive statistics. */
  function boundedCard(value:unknown):unknown{
    if(Array.isArray(value))return value.slice(0,12).map(boundedCard)
    if(!value||typeof value!=='object')return value
    const output:Record<string,unknown>={}
    for(const [name,item] of Object.entries(value)){
      output[name]=boundedCard(item)
      if(Array.isArray(item))output[name+'Coverage']={total:item.length,shown:Math.min(12,item.length),omitted:Math.max(0,item.length-12)}
    }
    return output
  }
  function rawModelEvidence(receipt:Receipt|undefined){
    if(receipt?.status!=='verified'||!receipt.modelEvidence)return {rows:[],totalRows:null,omittedRows:null}
    const selected=EvidenceView.sample(receipt.modelEvidence,6,EvidenceView.path(receipt.runId)).items
    const rows=selected.map(row=>{
      const entries=Object.entries(row.metrics??{}).sort(([a],[b])=>a.localeCompare(b))
      const finite=entries.filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1])).slice(0,6)
      return {candidateId:row.candidateId,stage:row.stage,modelId:row.modelId,seed:row.seed,status:row.status,metrics:Object.fromEntries(finite),omittedMetrics:entries.length-finite.length}
    })
    return {rows,totalRows:receipt.modelEvidence.length,omittedRows:receipt.modelEvidence.length-rows.length}
  }
  function qualification(receipt:Receipt|undefined,experiment:ResearchDomain.Experiment){
    const plumbing=experiment.contract.evaluator.id==='mock-peptide-panel'
    const truncate=(value:unknown,depth=0):unknown=>{
      if(typeof value==='string')return value.slice(0,300)
      if(depth>2&&value&&typeof value==='object')return '[metadata omitted]'
      if(Array.isArray(value))return value.slice(0,8).map(v=>truncate(v,depth+1))
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).slice(0,12).map(([k,v])=>[k,truncate(v,depth+1)]))
      return value
    }
    const raw=receipt?.evidenceCompleteness??null,evidenceCompleteness=truncate(raw)
    return {scientific:plumbing?false:receipt?.scientific??null,evidenceKind:plumbing?'plumbing_only':receipt?.evidenceKind??null,evidenceCompleteness,metadataTruncated:operationHash(raw)!==operationHash(evidenceCompleteness)}
  }
  /** Select before raw-artifact I/O; the same selection binds delivered order. */
  export function selectedRunIds(state:ResearchState,scope:Scope,legacyEvents:ResearchScientistMemory.TrajectoryEvent[]=[],rawQuery:Query={}):string[]{
    scoped(state,scope);const query=Query.parse(rawQuery),events=originalEvents(state,scope,legacyEvents)
    const members=new Map<string,{runId:string;trialId:string;id?:string;valid?:boolean;score?:number|null;decision?:string;hypothesis?:string;createdAt:string;configurationFamilyFingerprint?:string;calibrationReplicateOfTrialId?:string}>()
    for(const event of events){const prior=members.get(event.runId);if(!prior||prior.decision==='failed'&&event.status==='succeeded')members.set(event.runId,{...event,decision:event.decision??(event.status==='run_failed'?'failed':undefined),createdAt:event.recordedAt})}
    for(const row of Object.values(state.searchObservations).filter(o=>o.experimentId===scope.experimentId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){const prior=members.get(row.runId);if(!prior||prior.decision==='failed'||row.decision!=='failed')members.set(row.runId,row)}
    const opposing=new Set(Object.values(state.hypotheses).filter(h=>h.campaignId===scope.campaignId).flatMap(h=>h.opposingEvidenceRefs))
    for(const review of Object.values(state.scientistReviews).filter(r=>r.experimentId===scope.experimentId&&r.campaignId===scope.campaignId&&r.predictionAssessment==='not_supported_for_tested_predicate'))for(const ref of review.evidenceRefs)opposing.add(ref)
    const families=new Map<string,number>();for(const item of members.values())if(item.configurationFamilyFingerprint)families.set(item.configurationFamilyFingerprint,(families.get(item.configurationFamilyFingerprint)??0)+1)
    const familyAnchors=new Map<string,string>();for(const item of [...members.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.runId.localeCompare(b.runId)))if(item.configurationFamilyFingerprint&&!familyAnchors.has(item.configurationFamilyFingerprint))familyAnchors.set(item.configurationFamilyFingerprint,item.runId)
    const terms=(query.question??'').toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>2)
    const priority=(item:typeof members extends Map<string,infer T>?T:never)=>Number(opposing.has(item.runId)||opposing.has(item.trialId)||opposing.has(item.id??''))*100+
      Number(item.decision==='failed'||item.valid!==true||item.score==null)*20+Number(!!item.configurationFamilyFingerprint&&(families.get(item.configurationFamilyFingerprint)??0)>1)*10+
      Number(!!query.configurationFamilyFingerprint&&query.configurationFamilyFingerprint===item.configurationFamilyFingerprint)*40+Number(!!query.evidenceRefs?.includes(item.runId))*50+Number(!!item.calibrationReplicateOfTrialId)*15+Number(!!item.configurationFamilyFingerprint&&familyAnchors.get(item.configurationFamilyFingerprint)===item.runId)*15+
      terms.reduce((n,t)=>n+Number((item.hypothesis??'').toLowerCase().includes(t)),0)+Number(item.trialId===state.experiments[scope.experimentId]?.incumbentTrialId)*60
    return [...members.values()].sort((a,b)=>priority(b)-priority(a)||b.createdAt.localeCompare(a.createdAt)||a.runId.localeCompare(b.runId)).slice(0,query.maxFacts??24).map(item=>item.runId)
  }
  /** Full ledger/archive remain expansion artifacts; only the packet enters the opening context. */
  export function project(input:Input){
    const {state}=input,{scope,experiment}=scoped(state,input.scope),query=Query.parse(input.query??{}),guides=(input.guides??[]).map(g=>Guide.parse(g))
    const selectedOrder=selectedRunIds(state,scope,input.legacyEvents,query),selectedSet=new Set(selectedOrder)
    const manifest=sourceManifest(state,scope,input.legacyEvents,guides),sourcesById=new Map(manifest.sources.map(s=>[s.id,s]))
    const events=originalEvents(state,scope,input.legacyEvents??[]),byRun=new Map<string,ResearchScientistMemory.TrajectoryEvent>()
    for(const event of events){const prior=byRun.get(event.runId);if(!prior||prior.status==='run_failed'&&event.status==='succeeded')byRun.set(event.runId,event)}
    const rows=new Map<string,ResearchDomain.SearchObservation>()
    for(const row of Object.values(state.searchObservations).filter(o=>o.experimentId===scope.experimentId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){
      const prior=rows.get(row.runId)
      if(prior&&prior.decision!=='failed'&&row.decision!=='failed'&&prior.id!==row.id)throw new Error('Original successful decision memory observation is duplicated')
      if(!prior||prior.decision==='failed'&&row.decision!=='failed')rows.set(row.runId,row)
    }
    const receiptMap=new Map<string,Receipt>()
    for(const receipt of input.receipts??[]){if(receiptMap.has(receipt.runId))throw new Error('Decision memory receipt identity is duplicated');receiptMap.set(receipt.runId,receipt)}
    const observations:ResearchDomain.SearchObservation[]=[],facts:Fact[]=[],gaps:Array<{id:string;reason:string}>=[]
    for(const runId of [...new Set([...rows.keys(),...byRun.keys()])].sort()){
      const row=rows.get(runId),event=byRun.get(runId),receipt=receiptMap.get(runId),evaluation=row?.evaluationId?state.evaluations[row.evaluationId]:undefined
      const valid=row?.valid??evaluation?.valid??event?.valid??null,failed=(row?.decision??event?.decision)==='failed'||event?.status==='run_failed'&&!row
      const expectedHash=row?.receiptHash??state.runs[runId]?.manifestHash
      if(receipt?.status==='verified'&&(!receipt.receiptHash||expectedHash&&receipt.receiptHash!==expectedHash||receipt.run&&(receipt.run.id!==runId||receipt.run.status!==(failed?'failed':'succeeded'))))throw new Error('Decision memory original receipt differs')
      const verified=receipt?.status==='verified',notSelected=!selectedSet.has(runId),canonicalFact=row?.closeoutVersion===2,source=row?sourcesById.get(row.id):event?sourcesById.get(ResearchScientistMemory.eventHash(event)):undefined
      if(!source)throw new Error('Decision memory fact has no exact source')
      if(!verified&&!notSelected)gaps.push({id:runId,reason:receipt?.reason??(canonicalFact?'Original raw artifact unavailable; committed frozen result remains canonical':'Original receipt unavailable; recorded score is not admitted as measured evidence')})
      const fact=Fact.parse({runId,trialId:row?.trialId??event!.trialId,observationId:row?.id??null,source,receiptStatus:verified?'verified':notSelected?'not_selected':'unavailable',receiptHash:canonicalFact?row!.receiptHash:verified?receipt!.receiptHash:null,receiptAuthority:canonicalFact?'canonical_commit':verified?'raw_verified':'historical_record',rawModelEvidence:rawModelEvidence(receipt),qualification:qualification(receipt,experiment),
        valid,outcome:failed?'failed':valid===false?'invalid':valid===true&&(verified||canonicalFact)?'valid':'unknown',score:(verified||canonicalFact)&&valid===true&&!failed?(row?.score??event?.score??null):null,
        recordedScore:row?.score??event?.score??null,decision:row?.decision??event?.decision??'unknown',intent:row?.intent??event!.intent,createdAt:row?.createdAt??event!.recordedAt,
        programHash:row?.programHash??event?.programHash??null,configurationFamilyFingerprint:row?.configurationFamilyFingerprint??event?.configurationFamilyFingerprint??null,
        generationStochasticity:row?.generationStochasticity??null,replicateOfTrialId:row?.calibrationReplicateOfTrialId??null,
        ...(verified&&receipt?.seedRoles?{seedRoles:receipt.seedRoles}:{}),
        modelIds:row?.modelIds??event!.modelIds,seeds:row?.seeds??event!.seeds,diagnostics:verified||canonicalFact?(row?.diagnostics??event!.diagnostics):{},
        evidencePath:EvidenceView.path(runId),error:failed?String(row?.error??event?.error??state.runs[runId]?.error??'Unknown original failure'):null,
        limitations:['Computational observations do not establish biological activity or method superiority.',...(qualification(receipt,experiment).scientific===false?['Plumbing-only result; it does not provide scientific model evidence.']:qualification(receipt,experiment).scientific===null?['Scientific artifact qualification is unknown.']:[]),...(!verified?[notSelected?'Raw model evidence not selected for this delivery; expand the original receipt on demand.':canonicalFact?'Raw artifact unavailable; committed frozen evaluation remains canonical.':'Receipt unavailable; score retained only as a historical record.']:[]),...(valid===null?['Original result validity is unknown.']:[])]})
      facts.push(fact)
      if(row)observations.push({...row,score:fact.score,decision:failed?'failed':fact.outcome==='valid'?row.decision:'observed',diagnostics:canonicalFact||verified?row.diagnostics:{}})
      else if(event)observations.push({id:'sobs_legacy_'+operationHash(source.id),campaignId:scope.campaignId,experimentId:scope.experimentId,trialId:event.trialId,runId,knowledgeId:'knw_legacy_'+operationHash(source.id),
        programHash:event.programHash??experiment.contractHash,intent:event.intent,generatorPortfolio:event.generatorPortfolio,generatorAllocations:event.generatorAllocations,generatorDiagnostics:[],candidateSequences:event.candidateSequences,
        modelIds:event.modelIds,seeds:event.seeds,score:fact.score,decision:failed?'failed':fact.outcome==='valid'?(event.decision??'observed'):'observed',diagnostics:verified?event.diagnostics:{},hypothesis:event.hypothesis??'Historical proposal unavailable',
        epistemicLevel:'model_observation',createdAt:event.recordedAt,configurationFamilyFingerprint:event.configurationFamilyFingerprint,decisionPlan:event.decisionPlan,prediction:event.prediction,evidenceRefs:event.evidenceRefs})
    }
    // Compacted historical stores retain lineage in the observation itself. Bind a
    // run/trial reference to that exact surviving source rather than inventing a record.
    for(const row of rows.values())for(const id of [row.runId,row.trialId,row.knowledgeId,row.evaluationId])if(id&&!sourcesById.has(id))sourcesById.set(id,sourcesById.get(row.id)!)
    const projectedQuestions=ResearchQuestions.project(Object.values(state.searchObservations).filter(o=>o.experimentId===scope.experimentId),Object.values(state.knowledgeCycles).filter(c=>c.campaignId===scope.campaignId),Object.values(state.researchRequests).filter(r=>r.experimentId===scope.experimentId&&r.campaignId===scope.campaignId))
    const interpretations:Interpretation[]=[]
    const addInterpretation=(id:string,kind:string,statement:string,status:string,support:string[],oppose:string[],limitations:string[],sameExperiment=false,details:{runId?:string;reviewRevision?:number;nextDecision?:string;requestId?:string;revision?:string|null;remainingGap?:string|null}={})=>{
      const source=sourcesById.get(id);if(!source)return
      const refs=[...support,...oppose],missing=refs.filter(ref=>!sourcesById.has(ref));for(const ref of missing)gaps.push({id:ref,reason:`Unresolved or outside-scope source for ${id}`})
      interpretations.push(Interpretation.parse({...details,nextDecision:details.nextDecision?.slice(0,600),remainingGap:details.remainingGap?.slice(0,600),id,kind,source,statement:statement.slice(0,1000),status,applicability:sameExperiment?'same_experiment':'campaign_analogy',
        supportingSources:support.flatMap(ref=>sourcesById.get(ref)??[]).slice(0,12),opposingSources:oppose.flatMap(ref=>sourcesById.get(ref)??[]).slice(0,12),unresolvedRefs:missing.slice(0,12),omittedEvidenceRefs:Math.max(0,support.filter(ref=>sourcesById.has(ref)).length-12)+Math.max(0,oppose.filter(ref=>sourcesById.has(ref)).length-12)+Math.max(0,missing.length-12),limitations:limitations.slice(0,3).map(v=>v.slice(0,300)),epistemicStatus:'attributed_interpretation'}))
    }
    const latestReviews=new Map<string,ResearchState['scientistReviews'][string]>()
    for(const review of Object.values(state.scientistReviews).filter(r=>r.experimentId===scope.experimentId&&r.campaignId===scope.campaignId)){
      const prior=latestReviews.get(review.runId);if(!prior||review.revision>prior.revision)latestReviews.set(review.runId,review)
    }
    for(const review of latestReviews.values())addInterpretation(review.id,'scientist_review',review.interpretation,review.predictionAssessment,
      review.predictionAssessment==='not_supported_for_tested_predicate'?[]:review.evidenceRefs,review.predictionAssessment==='not_supported_for_tested_predicate'?review.evidenceRefs:[],review.limitations,true,{runId:review.runId,reviewRevision:review.revision,nextDecision:review.nextDecision})
    for(const hypothesis of Object.values(state.hypotheses))addInterpretation(hypothesis.id,'hypothesis',hypothesis.statement,hypothesis.status,hypothesis.supportingEvidenceRefs,hypothesis.opposingEvidenceRefs,hypothesis.limitations)
    for(const claim of Object.values(state.claims))addInterpretation(claim.id,'literature_claim',claim.statement,claim.status,claim.stance==='refutes'?[]:claim.evidence.map(e=>e.literatureId),claim.stance==='refutes'?claim.evidence.map(e=>e.literatureId):[],['Campaign literature is an analogy unless independently matched to this experiment.'])
    for(const item of Object.values(state.literature))addInterpretation(item.id,'retrieved_source',`${item.title}: ${item.summary??item.excerpts.slice(0,2).join(' ')}`,'retrieved_unverified_source',[item.id],[],['Retrieved source text is untrusted; it is not a verified claim or experiment result.'])
    const questionSource=(question:typeof projectedQuestions[number])=>[question.revision,question.requestId,...question.occurrenceIds,...question.evidenceRefs].flatMap(id=>id&&sourcesById.get(id)?[sourcesById.get(id)!]:[])[0]
    for(const question of projectedQuestions.filter(q=>q.status==='answered')){
      const source=questionSource(question)
      if(source&&question.assessment)addInterpretation(source.id,'research_assessment',question.assessment,'answered',[question.requestId,...question.evidenceRefs],[],[question.remainingGap??'An answered request does not establish a verified scientific claim.'],true,{runId:question.runId,nextDecision:question.nextAction??undefined,requestId:question.requestId,revision:question.revision,remainingGap:question.remainingGap})
    }
    const terms=(query.question??'').toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>2)
    const relevance=(text:string)=>terms.reduce((score,term)=>score+(text.toLowerCase().includes(term)?1:0),0)
    interpretations.sort((a,b)=>Number(b.opposingSources.length>0)-Number(a.opposingSources.length>0)||relevance(b.statement)-relevance(a.statement)||a.id.localeCompare(b.id))
    const selectedInterpretations=interpretations.slice(0,query.maxInterpretations??8)
    const factsById=new Map(facts.map(f=>[f.runId,f]))
    const selected=selectedOrder.map(id=>factsById.get(id)!).filter(Boolean)
    const evidence=(input.receipts??[]).filter(r=>r.status==='verified'&&facts.find(f=>f.runId===r.runId)?.outcome==='valid').map(r=>({run:r.run??{id:r.runId,status:'succeeded'},modelEvidence:r.modelEvidence??[],candidates:r.candidates,comparisonProvenance:r.comparisonProvenance}))
    const ledger={...DecisionEvidence.summarize(observations,scope.experimentId,evidence),qualificationByRun:facts.map(f=>({runId:f.runId,qualification:f.qualification,receiptAuthority:f.receiptAuthority,rawReceiptStatus:f.receiptStatus}))},archive=DecisionEvidence.archive(observations.filter(o=>facts.find(f=>f.runId===o.runId)?.outcome==='valid'),scope.experimentId,evidence)
    const unanswered=projectedQuestions.filter(q=>q.status==='open'||q.status==='blocked')
    const openQuestions=unanswered.toSorted((a,b)=>relevance(b.request.question)-relevance(a.request.question)||a.requestId.localeCompare(b.requestId)).slice(0,8).map(question=>{
      const source=questionSource(question)
      if(!source)throw new Error('Projected research question has no exact original source')
      return {id:question.requestId,source,question:question.request.question.slice(0,600),applicability:'same_experiment',requestId:question.requestId,revision:question.revision,status:question.status,assessment:question.assessment?.slice(0,600)??null,remainingGap:question.remainingGap?.slice(0,600)??null,nextAction:question.nextAction?.slice(0,600)??null,occurrenceIds:question.occurrenceIds.slice(0,8),omittedOccurrences:Math.max(0,question.occurrenceIds.length-8),evidenceRefs:question.evidenceRefs.slice(0,8),omittedEvidenceRefs:Math.max(0,question.evidenceRefs.length-8),request:{question:question.request.question.slice(0,600),requiredEvidence:question.request.requiredEvidence.slice(0,600),purpose:question.request.purpose,prerequisiteBranchId:question.request.prerequisiteBranchId,action:question.request.action}}
    })
    const selectedSourceKeys=new Set([...selected.map(f=>f.source),...selectedInterpretations.flatMap(i=>[i.source,...i.supportingSources,...i.opposingSources]),...openQuestions.map(q=>q.source),...manifest.sources.filter(s=>s.layer==='guidance')].map(key))
    const deliveredGaps=gaps.filter(gap=>selectedSet.has(gap.id)||selectedInterpretations.some(i=>i.unresolvedRefs.includes(gap.id))).slice(0,24)
    const manifestHash=hash(manifest),manifestPath=`evidence/memory/${manifestHash.slice(7)}.json`
    const selectedSources=manifest.sources.filter(source=>selectedSourceKeys.has(key(source))).slice(0,100)
    const binding=SourceBinding.parse({format:'autofold.decision-memory-source-binding.v1',scope:manifest.scope,snapshotHash:manifest.snapshotHash,revisions:manifest.revisions,cutoff:manifest.cutoff,sources:selectedSources,selectedSourcesHash:hash(selectedSources),manifestPath,manifestHash,publicationStatus:'not_checked'})
    const packet=Packet.parse({format:'autofold.decision-memory.v1',sourceManifest:binding,facts:selected,interpretations:selectedInterpretations,proceduralGuidance:guides,comparisons:ledger.comparisonAudit.slice(0,12).map(boundedCard),
      replications:{families:ledger.families.slice(0,12).map(boundedCard),repeatedOutputs:ledger.repeatedOutputs.slice(0,12).map(boundedCard)},openQuestions,
      coverage:{totalRecords:facts.length,deliveredFacts:selected.length,omittedFacts:facts.length-selected.length,verifiedReceipts:facts.filter(f=>f.receiptStatus==='verified').length,unavailableReceipts:facts.filter(f=>f.receiptStatus==='unavailable').length,notSelectedReceipts:facts.filter(f=>f.receiptStatus==='not_selected').length,
        invalidRuns:facts.filter(f=>f.outcome==='invalid').length,failedRuns:facts.filter(f=>f.outcome==='failed').length,omittedInterpretations:interpretations.length-selectedInterpretations.length,omittedQuestions:unanswered.length-openQuestions.length,gapCount:gaps.length,omittedGaps:Math.max(0,gaps.length-deliveredGaps.length),gaps:deliveredGaps},
      deltas:delta(manifest,input.previousManifest),freshness:{mode:'canonical_ledger',canonicalEvidenceRevision:manifest.revisions.evidence,projectionEvidenceRevision:input.projectionWatermark??null,fallback:input.projectionWatermark!==manifest.revisions.evidence},
      retrieval:{query,configHash:hash({algorithm:'scope_lexical_exception_v1',maxFacts:query.maxFacts??24,maxInterpretations:query.maxInterpretations??8}),backend:'deterministic_ledger',selectedOrder:selected.map(f=>f.runId),bytes:0,inferenceRequestIds:[]},
      expansion:{ledgerPath:'evidence/decisionEvidence.json',archivePath:'evidence/candidateArchive.json',questionsPath:'QUESTIONS.json',sourcesPath:manifestPath,publicationStatus:'not_checked'},limitation:'Facts, attributed interpretations and guidance remain distinct. Replication summaries are descriptive; independent RNG, causal effects and biological validity are not inferred.'})
    // Include the self-describing byte count without a variable clock or provider identity.
    for(let i=0;i<8;i++){const bytes=Buffer.byteLength(JSON.stringify(packet));if(bytes===packet.retrieval.bytes)break;packet.retrieval.bytes=bytes}
    return {packet,sourceManifest:manifest,ledger,archive,questions:projectedQuestions,gaps}
  }
  export function build(input:Input):Packet{return project(input).packet}
}
