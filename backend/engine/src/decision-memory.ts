import {DecisionMemory} from '@autofold/science-core/decision-memory'
import {ExecutionProtocol} from '@autofold/science-core/execution-protocol'
import {ResearchScientistMemory} from '@autofold/science-core/scientist-memory'
import type {ResearchDomain} from '@autofold/science-core/domain'
import type {ResearchState} from '@autofold/science-core/store'
import {decisions} from './scientist/evidence'
import type {ScientificExecution} from './execution'
import {loadSnapshotSkill} from './skills/service'
import {canonicalOperationJSON,operationHash} from '@autofold/science-core/operations'
import {checkedPath} from './execution/paths'
import {atomicJSON} from './scientist/persistence'
import fs from 'node:fs/promises'
import path from 'node:path'

function trialSeedRoleFallback(trial: ResearchDomain.Trial | undefined): DecisionMemory.SeedRoleEvidence | undefined {
  const value=(trial as any)?.generationSeed
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>0xffff_ffff)return undefined
  return {format:'autofold.generation-seed-roles.v1',hostGenerationSeed:{value,source:'trial_binding_fallback'}}
}

export function verifiedSeedRoles(artifacts: Awaited<ReturnType<ScientificExecution['artifacts']>>, trial: ResearchDomain.Trial | undefined) {
  const raw=(artifacts.generationRuns as any)?.seedRoles
  if(raw===undefined)return trialSeedRoleFallback(trial)
  const roles=ExecutionProtocol.GenerationSeedRoleViewV1.parse(raw)
  const bound=(trial as any)?.generationSeed, bundle=(artifacts.comparisonContext as any)?.generationSeed
  if(bound!==undefined&&roles.hostGenerationSeed.value!==bound||bundle!==undefined&&roles.hostGenerationSeed.value!==bundle||
      bound!==undefined&&bundle!==undefined&&bound!==bundle)throw new Error('Verified generation seed roles differ from the original trial or bundle binding')
  const cap=<T>(values:T[]|undefined)=>values?.slice(0,6)
  return DecisionMemory.SeedRoleEvidence.parse({...roles,
    effectiveProgramSeeds:cap(roles.effectiveProgramSeeds),declaredPredictorSeeds:cap(roles.declaredPredictorSeeds),
    observedToolConfigSeeds:cap(roles.observedToolConfigSeeds)?.map(item=>({
      ...item,...(item.seeds&&item.seeds.length>16?{seeds:item.seeds.slice(0,16),omittedSeeds:item.seeds.length-16}:{})})),
    evaluatorSeeds:roles.evaluatorSeeds?{...roles.evaluatorSeeds,values:roles.evaluatorSeeds.values.slice(0,16),
      ...(roles.evaluatorSeeds.values.length>16?{omitted:roles.evaluatorSeeds.values.length-16}:{})}:undefined,
    omitted:{...(roles.effectiveProgramSeeds.length>6?{effectiveProgramSeeds:roles.effectiveProgramSeeds.length-6}:{}),
      ...(roles.declaredPredictorSeeds.length>6?{declaredPredictorSeeds:roles.declaredPredictorSeeds.length-6}:{}),
      ...(roles.observedToolConfigSeeds.length>6?{observedToolConfigSeeds:roles.observedToolConfigSeeds.length-6}:{})}})
}

/** Extract comparison inputs only from an already verified immutable worker receipt. */
export function verifiedComparisonProvenance(artifacts: Awaited<ReturnType<ScientificExecution['artifacts']>>, workflowFingerprint?: string | null): NonNullable<DecisionMemory.Receipt['comparisonProvenance']> {
  const bundle=artifacts.comparisonContext as any, native=artifacts.nativeExecution as any
  const frozen=bundle?.frozenContract
  if(!bundle||!bundle.contractHash||!frozen||bundle.frozenContractHash!==bundle.contractHash)return {status:'unknown',workflowFingerprint:workflowFingerprint??null,unknownFields:['verifiedFrozenContract']}
  const evaluator=bundle.evaluator??frozen.evaluator, adapter=frozen.evaluator?.evidenceAdapter
  const conditions={contractHash:bundle.contractHash,targetArtifactHash:bundle.targetArtifactHash??frozen.targetArtifactHash??null,modality:bundle.modality??frozen.modality??null,
    candidateBudget:bundle.candidateBudget??frozen.budget?.maximumCandidates??null,submissionSize:bundle.submissionSize??frozen.evaluator?.submissionSize??null,
    evaluationSeeds:bundle.seeds??frozen.evaluator?.fixedSeeds??null,
    evaluator:{id:evaluator?.id??null,version:evaluator?.version??null,sourceHash:evaluator?.sourceHash??null,direction:evaluator?.direction??null},
    evidenceAdapter:adapter?{id:adapter.id??null,version:adapter.version??null,sourceHash:adapter.sourceHash??null,scoringPipelineHash:adapter.scoringPipelineHash??null}:null,
    frozenScoringPipelineHash:adapter?.scoringPipelineHash??null,executionPipelineHash:bundle.pipelineHash??null,workerSourceHash:bundle.worker?.sourceHash??null,
    proto:{languageCommit:bundle.proto?.languageCommit??null,toolsCommit:bundle.proto?.toolsCommit??null}}
  const descriptor=native?.protocol==='native_search_v1'?native.descriptor:native?.protocol==='native_fixed_control_v1'?native.descriptor.nativeProjection:undefined
  const unknownFields:string[]=[]
  for(const [name,value] of Object.entries({contractHash:bundle.contractHash,targetArtifactHash:conditions.targetArtifactHash,modality:conditions.modality,
    candidateBudget:conditions.candidateBudget,submissionSize:conditions.submissionSize,evaluationSeeds:conditions.evaluationSeeds,'evaluator.id':evaluator?.id,'evaluator.version':evaluator?.version,
    'evaluator.sourceHash':evaluator?.sourceHash,'evaluator.direction':evaluator?.direction,
    ...(adapter?{'evidenceAdapter.sourceHash':adapter.sourceHash,'frozenScoringPipelineHash':adapter.scoringPipelineHash}:{}),workerSourceHash:bundle.worker?.sourceHash,
    'proto.languageCommit':bundle.proto?.languageCommit,'proto.toolsCommit':bundle.proto?.toolsCommit}))if(value===undefined||value===null)unknownFields.push(name)
  const admittedDesign=descriptor?{protocol:native.protocol,programSourceHash:bundle.programHash??null,budget:descriptor.budget,outputs:native.outputs,
    projection:descriptor.projection.map((lane:any)=>({lane:lane.lane,programSeed:lane.programSeed,externalInputs:lane.externalInputs,constructs:lane.constructs,stages:lane.stages.map((stage:any)=>({
      instanceId:stage.instanceId,optimizer:stage.optimizer,config:stage.config,settings:stage.settings,numResults:stage.numResults,
      conditioning:stage.conditioning,targetSegment:stage.targetSegment,customLogging:stage.customLogging,
      generators:stage.generators.map((generator:any)=>({instanceId:generator.instanceId,key:generator.key,segments:generator.segments,config:generator.config,toolsCalled:generator.toolsCalled})),constraints:stage.constraints}))}))}:undefined
  if(!descriptor)unknownFields.push('nativeExecution.descriptor')
  return {status:'verified',conditions,...(admittedDesign?{admittedDesign}:{}),unknownFields,workflowFingerprint:workflowFingerprint??null}
}

/** Local receipt verification plus a pure projection of ONE supplied store snapshot.
 * No store writes, model calls, projection repair or dispatch are permitted here. */
export async function prepareDecisionMemory(input:{workspace:string;projectId:string;campaignId:string;experimentId:string;state:ResearchState;
  execution:Pick<ScientificExecution,'artifacts'|'failureReceipt'>;guideIds?:readonly string[];includeGuides?:boolean;
  legacyEvents?:ResearchScientistMemory.TrajectoryEvent[];query?:DecisionMemory.Query;previousManifest?:DecisionMemory.SourceManifest}) {
  const startedAt=performance.now()
  const scope={projectId:input.projectId,campaignId:input.campaignId,experimentId:input.experimentId}
  const legacyEvents=input.legacyEvents??await ResearchScientistMemory.read(input.workspace,input.experimentId)
  const versions=input.includeGuides===false?[]:Object.values(input.state.skillVersions).filter(version=>version.campaignId===input.campaignId&&
    (input.guideIds?input.guideIds.includes(version.id):version.status==='active'))
  const skills=await Promise.all(versions.map(version=>loadSnapshotSkill(input.workspace,version)))
  const runIds=DecisionMemory.selectedRunIds(input.state,scope,legacyEvents,input.query)
  const receipts:DecisionMemory.Receipt[]=[]
  for(let start=0;start<runIds.length;start+=4)receipts.push(...await Promise.all(runIds.slice(start,start+4).map(async runId=>{
    const run=input.state.runs[runId],trial=run&&input.state.trials[run.trialId]
    if(!run||trial?.experimentId!==input.experimentId)return {runId,status:'unavailable' as const,reason:'Original run is missing or outside the sampled experiment'}
    try {
      if(run.status==='failed') {
        const receipt=await input.execution.failureReceipt(runId)
        if(!receipt)throw new Error('Original terminal failure receipt is unavailable')
        return {runId,run,status:'verified' as const,receiptHash:receipt.receiptHash,modelEvidence:[],candidates:[],seedRoles:trialSeedRoleFallback(trial)}
      }
      const artifacts=await input.execution.artifacts(runId)
      if(artifacts.run.manifestHash!==run.manifestHash||artifacts.trial.programHash!==trial.programHash)throw new Error('Original receipt differs from the sampled lineage')
      return {runId,run,status:'verified' as const,receiptHash:run.manifestHash,modelEvidence:decisions(artifacts.modelEvidence),candidates:artifacts.candidates?.candidates,
        comparisonProvenance:verifiedComparisonProvenance(artifacts,trial.workflowFingerprint),
        seedRoles:verifiedSeedRoles(artifacts,trial),
        scientific:artifacts.scientific,evidenceKind:artifacts.evidenceKind,evidenceCompleteness:artifacts.evidenceCompleteness}
    }catch(error){return {runId,run,status:'unavailable' as const,reason:error instanceof Error?error.message:String(error)}}
  })))
  const guides=versions.map(version=>({versionId:version.id,skillId:version.skillId,version:version.version,contentHash:version.contentHash,status:version.status,
    capabilities:version.capabilities,path:version.path,replay:version.replay}))
  const projected=DecisionMemory.project({state:input.state,scope,legacyEvents,receipts,guides,query:input.query,previousManifest:input.previousManifest})
  return {...projected,skills,preparation:{receiptReads:runIds.length,elapsedMs:performance.now()-startedAt}}
}

/** Immutable manifest publication is derivative; its failure cannot erase facts. */
export async function publishDecisionMemory(workspace:string,root:string,memory:Awaited<ReturnType<typeof prepareDecisionMemory>>) {
  const gaps:Record<string,string>={},packet=memory.packet,binding=packet.sourceManifest
  if(binding.manifestHash!=='sha256:'+operationHash(memory.sourceManifest))throw new Error('Decision memory manifest binding differs')
  try {
    const file=await checkedPath(workspace,root+'/'+binding.manifestPath),bytes=canonicalOperationJSON(memory.sourceManifest)
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700})
    try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o400})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
    if(await fs.readFile(file,'utf8')!==bytes)throw new Error('Immutable decision-memory manifest bytes changed')
    binding.publicationStatus='available'
  }catch(error){binding.publicationStatus='unavailable';gaps[binding.manifestPath]=error instanceof Error?error.message:String(error)}
  for(const [relative,value] of [[packet.expansion.ledgerPath,memory.ledger],[packet.expansion.archivePath,memory.archive],[packet.expansion.questionsPath,memory.questions]] as const)try{
    if(!relative)continue
    await atomicJSON(await checkedPath(workspace,root+'/'+relative),value)
  }catch(error){if(relative)gaps[relative]=error instanceof Error?error.message:String(error)}
  packet.expansion.publicationStatus=Object.keys(gaps).length?'unavailable':'available'
  for(let i=0;i<8;i++){const bytes=Buffer.byteLength(JSON.stringify(packet));if(bytes===packet.retrieval.bytes)break;packet.retrieval.bytes=bytes}
  return gaps
}

/** Exposure is an attributable input trace, never part of authored scientific identity. */
export function decisionMemoryExposure(packet:DecisionMemory.Packet,manifest:DecisionMemory.SourceManifest,sessionId:string,
  declaration:{decisionPlan?:{evidenceRefs?:readonly string[]};evidenceRefs?:readonly string[]}) {
  if(packet.sourceManifest.manifestHash!=='sha256:'+operationHash(manifest))throw new Error('Delivered memory manifest differs')
  const eligible=new Set([...packet.sourceManifest.sources.map(source=>source.id),...packet.facts.flatMap(fact=>[fact.runId,fact.trialId,fact.observationId])])
  const sources=new Map(manifest.sources.map(source=>[source.id,source]))
  const citedSources=[...new Set([...(declaration.decisionPlan?.evidenceRefs??[]),...(declaration.evidenceRefs??[])])].filter(id=>eligible.has(id)).flatMap(id=>{
    const source=sources.get(id)??packet.facts.find(fact=>[fact.runId,fact.trialId].includes(id))?.source
    return source?[{id,sourceId:source.id,kind:source.kind,hash:source.hash}]:[]
  }).slice(0,100)
  return {format:'autofold.decision-memory-exposure.v1' as const,exposureScope:'opening_packet' as const,packetHash:'sha256:'+operationHash(packet),manifestHash:packet.sourceManifest.manifestHash,
    snapshotHash:packet.sourceManifest.snapshotHash,scope:packet.sourceManifest.scope,revisions:packet.sourceManifest.revisions,sessionId,
    decisionHash:'sha256:'+operationHash(declaration),citedSources}
}

/** Expansion exports share the packet's sampled records, never a second history read. */
export function snapshotHistory(state:ResearchState,experiment:ResearchDomain.Experiment) {
  const trials=Object.values(state.trials).filter(item=>item.experimentId===experiment.id).toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt)),ids=new Set(trials.map(item=>item.id))
  return {experiment,trials,runs:Object.values(state.runs).filter(item=>ids.has(item.trialId)).toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt)),
    evaluations:Object.values(state.evaluations).filter(item=>ids.has(item.trialId)).toSorted((a,b)=>a.evaluatedAt.localeCompare(b.evaluatedAt)),
    knowledge:Object.values(state.knowledge).filter(item=>item.experimentId===experiment.id).toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt))}
}
