import z from 'zod'
import {ResearchDomain} from './domain'
import {OperationDomain,appendOperationEvent,operationHash} from './operations'
import {ResearchScientistMemory} from './scientist-memory'
import {ExecutionProtocol} from './execution-protocol'
import type {ResearchState,ResearchStore} from './store'
import type {ResearchTrajectoryCloseout} from './trajectory-closeout'

/** Local verified facts only. This port does not author interpretation or dispatch work. */
export namespace ResearchTrajectoryObservation {
  const Digest=z.string().regex(/^sha256:[a-f0-9]{64}$/)
  export const ReceiptFacts=z.object({
    iteration:z.number().int().positive().optional(),sessionId:z.string().startsWith('ses_').optional(),
    candidateSequences:z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(100).optional(),
    modelIds:z.array(z.string().min(1)).max(100).optional(),
    generationReplicate:ExecutionProtocol.GenerationReplicateV1.optional(),
    generationWallSeconds:z.number().finite().nonnegative().optional(),
    generatorDiagnostics:z.array(ResearchDomain.GeneratorDiagnostics).max(30).optional(),
    failureReceiptHash:Digest.optional(),
  })
  export type ReceiptFacts=z.input<typeof ReceiptFacts>
  export const Result=z.object({status:z.literal('completed'),closeoutVersion:z.union([z.literal(1),z.literal(2)]),
    observationId:z.string().startsWith('sobs_'),commitHash:Digest,receiptHash:Digest,
    trajectory:z.object({format:z.union([z.literal('autofold.trajectory.v1'),z.literal('autofold.trajectory.v2')]),
      campaignId:z.string(),experimentId:z.string(),contractHash:Digest,iteration:z.number().int().positive(),
      status:z.enum(['succeeded','run_failed']),trialId:z.string(),runId:z.string(),
      knowledgeCycleId:z.string().optional(),searchObservationIds:z.array(z.string()),score:z.number().finite().nullable(),
      decision:z.enum(['promoted','rejected','observed','failed'])}).passthrough(),
    event:ResearchScientistMemory.TrajectoryEvent,outboxIds:z.array(z.string()),
    projection:z.object({status:z.enum(['pending','published']),errors:z.array(z.string()).optional()}),
  })
  export type Result=z.infer<typeof Result>
  export const Projection=z.object({id:z.string(),kind:z.enum(['trajectory_journal_v2','campaign_knowledge']),
    campaignId:z.string(),observationId:z.string(),commitHash:Digest,event:ResearchScientistMemory.TrajectoryEvent})
  export type Projection=z.infer<typeof Projection>
  const hash=(value:unknown)=>'sha256:'+operationHash(value)

  /** Must run inside the original receipt/evaluation/incumbent transaction. */
  export function commitInState(state:ResearchState,projectId:string,runId:string,raw:ReceiptFacts={},now=new Date().toISOString()):Result {
    const facts=ReceiptFacts.parse(raw),run=state.runs[runId],trial=run&&state.trials[run.trialId],experiment=trial&&state.experiments[trial.experimentId]
    if(!run||!trial||!experiment||!state.campaigns[experiment.campaignId])throw new Error('Original trajectory lineage is missing')
    ResearchDomain.assertContractIntegrity(experiment)
    if(run.status!=='succeeded'&&run.status!=='failed')throw new Error('Only verified terminal scientific receipts can be observed')
    const succeeded=run.status==='succeeded',receiptHash=succeeded?run.manifestHash:facts.failureReceiptHash??Object.values(state.searchObservations).find(item=>item.runId===run.id&&item.closeoutVersion===2&&item.decision==='failed'&&state.knowledge[item.knowledgeId]?.status!=='deprecated')?.receiptHash
    if(!receiptHash)throw new Error('Original verified receipt hash is required for factual closeout')
    Digest.parse(receiptHash)
    const knowledge=Object.values(state.knowledge).filter(item=>item.runId===run.id&&item.trialId===trial.id&&item.experimentId===experiment.id&&item.campaignId===experiment.campaignId&&item.status!=='deprecated'&&(succeeded?item.type==='Research Evaluation'&&item.decision!=='failed':item.type==='Research Failure'&&item.decision==='failed'))
    if(knowledge.length!==1)throw new Error('Original terminal knowledge lineage is ambiguous or missing')
    const outcome=knowledge[0]!,evaluation=outcome.evaluationId?state.evaluations[outcome.evaluationId]:undefined
    if(succeeded&&(!evaluation||evaluation.trialId!==trial.id||evaluation.contractHash!==experiment.contractHash||evaluation.evaluatorHash!==experiment.contract.evaluator.sourceHash||outcome.score!==evaluation.score))throw new Error('Original frozen evaluation lineage differs')
    if(outcome.provenance?.contractHash!==experiment.contractHash||outcome.provenance?.programHash!==trial.programHash)throw new Error('Original outcome provenance differs')
    const existing=Object.values(state.searchObservations).filter(item=>item.runId===run.id&&item.experimentId===experiment.id&&item.knowledgeId===outcome.id)
    if(existing.length>1)throw new Error('Original observation lineage is duplicated')
    if(existing.length){
      const observation=existing[0]!
      if(observation.trialId!==trial.id||observation.programHash!==trial.programHash||observation.evaluationId!==evaluation?.id||observation.score!==(evaluation?.score??null)||observation.decision!==outcome.decision||observation.receiptHash&&observation.receiptHash!==receiptHash)throw new Error('Original observation conflicts with verified receipt')
      return describe(state,projectId,observation,receiptHash)
    }
    const evaluations=Object.values(state.evaluations).filter(item=>state.trials[item.trialId]?.experimentId===experiment.id).toSorted((a,b)=>a.evaluatedAt.localeCompare(b.evaluatedAt))
    const index=evaluation?evaluations.findIndex(item=>item.id===evaluation.id):-1
    const preceding=index<0?evaluations:evaluations.slice(0,index)
    const scores=preceding.filter(item=>item.valid&&item.score!==null&&state.trials[item.trialId]?.intent==='optimize').map(item=>item.score!)
    const priorBestScore=scores.length?(experiment.contract.evaluator.direction==='minimize'?Math.min(...scores):Math.max(...scores)):null
    const modelIds=[...new Set(facts.modelIds??[])].sort(),seeds=succeeded?[...new Set(experiment.contract.evaluator.fixedSeeds)].sort((a,b)=>a-b):[]
    const priorFailures=succeeded?Object.values(state.searchObservations).filter(item=>item.runId===run.id&&item.trialId===trial.id&&item.experimentId===experiment.id&&item.programHash===trial.programHash&&item.decision==='failed'):[]
    if(priorFailures.length>1)throw new Error('Original failed observation amendment identity is ambiguous')
    const priorFailure=priorFailures[0]
    const origin=trial.origin&&state.jobs[trial.origin.jobId]
    const checkpoint=trial.origin?origin?.checkpoints[trial.origin.phase]?.data:undefined
    const lane=Object.values(state.scientistLanes).find(item=>item.experimentId===experiment.id&&Object.values(((item.state as any)?.requests??{})).some((request:any)=>request.trialId===trial.id))
    const request=lane?Object.values(((lane.state as any)?.requests??{})).find((request:any)=>request.trialId===trial.id) as {iteration?:number}|undefined:undefined
    const originalIteration=typeof checkpoint?.iteration==='number'?checkpoint.iteration:request?.iteration
    const originalSession=typeof lane?.sessionId==='string'?lane.sessionId:typeof origin?.payload.sessionId==='string'?origin.payload.sessionId:undefined
    const observation=ResearchDomain.SearchObservation.parse({
      id:'sobs_'+operationHash([projectId,experiment.id,run.id,receiptHash]),campaignId:experiment.campaignId,experimentId:experiment.id,
      trialId:trial.id,runId:run.id,evaluationId:evaluation?.id,knowledgeId:outcome.id,closeoutVersion:2,valid:evaluation?.valid??false,receiptHash,
      iteration:originalIteration??facts.iteration??Object.values(state.runs).filter(item=>state.trials[item.trialId]?.experimentId===experiment.id&&item.createdAt<=run.createdAt).length,
      sessionId:originalSession??facts.sessionId,supersedesObservationId:priorFailure?.id,intent:trial.intent,programHash:trial.programHash,
      semanticProgramFingerprint:trial.semanticProgramFingerprint,configurationFamilyFingerprint:trial.configurationFamilyFingerprint,
      workflowFingerprint:trial.workflowFingerprint,pipelineHash:trial.workflowFingerprint,calibrationClass:trial.calibrationClass,
      calibrationReplicateOfTrialId:trial.replicateOfTrialId,parentTrialId:trial.parentTrialId,decisionPlan:trial.decisionPlan,prediction:trial.prediction,evidenceRefs:trial.evidenceRefs,
      generationReplicateId:facts.generationReplicate?.id,realizedCandidateSetHash:facts.generationReplicate?.realizedCandidateSetHash,
      generationStochasticity:facts.generationReplicate?.stochasticity,generationWallSeconds:facts.generationWallSeconds,
      generatorPortfolio:[...new Set(trial.generators)].sort(),generatorAllocations:trial.generatorAllocations,generatorDiagnostics:facts.generatorDiagnostics??[],
      candidateSequences:[...new Set(facts.candidateSequences??[])],modelIds,seeds,score:evaluation?.score??null,priorBestScore,
      scoreDeltaFromPriorBest:evaluation?.score===null||evaluation?.score===undefined||priorBestScore===null?null:experiment.contract.evaluator.direction==='minimize'?priorBestScore-evaluation.score:evaluation.score-priorBestScore,
      decision:outcome.decision,diagnostics:evaluation?.diagnostics??{},hypothesis:trial.hypothesis,
      epistemicLevel:!succeeded||!evaluation?.valid?'model_observation':seeds.length>1?'multi_seed_support':modelIds.length>1?'cross_model_support':'computational_support',
      error:succeeded?undefined:run.error,createdAt:run.completedAt??now,
    })
    observation.commitHash=hash({projectId,receiptHash,observation})
    state.searchObservations[observation.id]=observation
    const opId='op_evidence_'+operationHash([projectId,experiment.id,run.id,receiptHash])
    const identity={closeoutVersion:2,experimentId:experiment.id,runId:run.id,receiptHash},grant={localFactualCommit:true,modelBudgetUsd:0}
    const operation=OperationDomain.Record.parse({id:opId,projectId,kind:'verified_trajectory_evidence',identity,identityHash:operationHash({kind:'verified_trajectory_evidence',identity,grant}),grant,
      revision:0,epoch:0,phase:'committed',state:{observationId:observation.id,commitHash:observation.commitHash},effect:'none',accounting:'settled',outcome:'succeeded',settlement:'settled',createdAt:now,updatedAt:now})
    if(state.operations[opId])throw new Error('Original evidence commit identity is already occupied')
    state.operations[opId]=operation;appendOperationEvent(state,operation,'verified_evidence_committed',{observationId:observation.id,commitHash:observation.commitHash,receiptHash},now)
    for(const kind of ['trajectory_journal_v2','campaign_knowledge'] as const){
      const id=opId+':projection:'+kind,data={observationId:observation.id,commitHash:observation.commitHash,campaignId:experiment.campaignId}
      state.operationOutbox[id]=OperationDomain.Outbox.parse({id,operationId:opId,kind,purpose:'projection',data,identityHash:operationHash({operationId:opId,kind,purpose:'projection',data}),status:'pending',createdAt:now,updatedAt:now})
    }
    return describe(state,projectId,observation,receiptHash)
  }

  function describe(state:ResearchState,projectId:string,observation:ResearchDomain.SearchObservation,receiptHash:string):Result {
    const originalProject=state.campaigns[observation.campaignId]?.projectId
    if(!originalProject||projectId&&projectId!==originalProject)throw new Error('Original evidence project scope differs')
    projectId=originalProject
    if(observation.closeoutVersion===2){const {commitHash,...original}=observation;if(commitHash!==hash({projectId,receiptHash,observation:original}))throw new Error('Canonical observation commit hash differs')}
    const experiment=state.experiments[observation.experimentId]!,run=state.runs[observation.runId]!
    const iteration=observation.iteration??1,commitHash=observation.commitHash??hash({projectId,receiptHash,observation})
    const event=ResearchScientistMemory.TrajectoryEvent.parse({recordedAt:observation.createdAt,campaignId:observation.campaignId,experimentId:observation.experimentId,contractHash:experiment.contractHash,
      iteration,intent:observation.intent,status:observation.decision==='failed'?'run_failed':'succeeded',trialId:observation.trialId,runId:observation.runId,
      parentTrialId:observation.parentTrialId,programHash:observation.programHash,semanticProgramFingerprint:observation.semanticProgramFingerprint,
      configurationFamilyFingerprint:observation.configurationFamilyFingerprint,workflowFingerprint:observation.workflowFingerprint,hypothesis:observation.hypothesis,
      decisionPlan:observation.decisionPlan,prediction:observation.prediction,evidenceRefs:observation.evidenceRefs,generatorPortfolio:observation.generatorPortfolio,
      generatorAllocations:observation.generatorAllocations,candidateSequences:observation.candidateSequences,modelIds:observation.modelIds,seeds:observation.seeds,
      ...(observation.closeoutVersion===2?{valid:observation.valid}:{}),score:observation.score,priorBestScore:observation.priorBestScore,decision:observation.decision,diagnostics:observation.diagnostics,knowledgeCycleId:observation.knowledgeCycleId,
      searchObservationIds:[observation.id],error:observation.decision==='failed'?(typeof observation.error==='string'?observation.error:run.error):undefined})
    const outbox=Object.values(state.operationOutbox).filter(item=>item.purpose==='projection'&&item.data.observationId===observation.id&&item.data.commitHash===commitHash)
    return Result.parse({status:'completed',closeoutVersion:observation.closeoutVersion??1,observationId:observation.id,commitHash,receiptHash,
      trajectory:{format:observation.closeoutVersion===2?'autofold.trajectory.v2':'autofold.trajectory.v1',...observation,contractHash:experiment.contractHash,iteration,status:event.status,searchObservationIds:[observation.id]},event,
      outboxIds:outbox.filter(item=>item.status==='pending').map(item=>item.id),projection:{status:outbox.some(item=>item.status==='pending')?'pending':'published'}})
  }

  export function readCommitted(state:ResearchState,projectId:string,observationId:string,verifiedReceiptHash?:string):Result {
    const observation=state.searchObservations[observationId]
    if(!observation)throw new Error('Original canonical observation is absent')
    const run=state.runs[observation.runId],receiptHash=observation.receiptHash??verifiedReceiptHash??run?.manifestHash
    if(!receiptHash)throw new Error('Original verified observation receipt is unavailable')
    if(verifiedReceiptHash&&verifiedReceiptHash!==receiptHash)throw new Error('Original observation receipt differs')
    if(observation.closeoutVersion===2){
      const operation=state.operations['op_evidence_'+operationHash([projectId,observation.experimentId,observation.runId,receiptHash])]
      if(operation?.kind!=='verified_trajectory_evidence'||operation.projectId!==projectId||operation.state.observationId!==observationId||operation.state.commitHash!==observation.commitHash)throw new Error('Canonical evidence operation differs')
    }
    return describe(state,projectId,observation,receiptHash)
  }

  /** Facts come from canonical rows; v2 journal files are never read as evidence. */
  export function events(state:ResearchState,legacyEvents:ResearchScientistMemory.TrajectoryEvent[],experimentId:string):ResearchScientistMemory.TrajectoryEvent[] {
    const historical=legacyEvents.filter(event=>event.experimentId===experimentId)
    const rows=Object.values(state.searchObservations).filter(item=>item.experimentId===experimentId&&item.closeoutVersion===2&&item.commitHash&&item.receiptHash)
    const current=new Map<string,ResearchDomain.SearchObservation>()
    for(const observation of rows){
      const previous=current.get(observation.runId)
      if(previous&&previous.decision!=='failed'&&observation.decision!=='failed')throw new Error('Original successful observation identity is duplicated')
      if(!previous||previous.decision==='failed'&&observation.decision!=='failed')current.set(observation.runId,observation)
    }
    const direct=[...current.values()].map(observation=>{
      const event=readCommitted(state,state.campaigns[observation.campaignId]!.projectId,observation.id).event
      const prior=historical.filter(item=>item.runId===event.runId)
      const sameStatus=prior.find(item=>item.status===event.status)
      if(sameStatus){if(sameStatus.trialId!==event.trialId||sameStatus.contractHash!==event.contractHash||sameStatus.programHash&&sameStatus.programHash!==event.programHash||sameStatus.score!==undefined&&sameStatus.score!==event.score||sameStatus.decision&&sameStatus.decision!==event.decision)throw new Error('Original journal and canonical receipt lineage conflict');return undefined}
      const failure=event.status==='succeeded'?prior.findLast(item=>item.status==='run_failed'):undefined
      return ResearchScientistMemory.TrajectoryEvent.parse({...event,closeoutVersion:2,observationId:observation.id,commitHash:observation.commitHash,receiptHash:observation.receiptHash,...(failure?{supersedesEventHash:ResearchScientistMemory.eventHash(failure)}:{})})
    }).filter((event):event is ResearchScientistMemory.TrajectoryEvent=>!!event)
    return [...historical,...direct].toSorted((a,b)=>a.recordedAt.localeCompare(b.recordedAt))
  }

  /** Original receipt-only repair. No scientific intent, authoring, or provider ports. */
  export async function recover(store:ResearchStore,projectId:string,input:ResearchTrajectoryCloseout.Input):Promise<Result> {
    if(!input.runId||!input.trialId)throw new Error('Original persisted trajectory identity is required')
    return store.mutate(projectId,state=>{
      const run=state.runs[input.runId!],trial=run&&state.trials[run.trialId],experiment=trial&&state.experiments[trial.experimentId]
      if(trial?.id!==input.trialId||experiment?.id!==input.experimentId||experiment?.campaignId!==input.campaignId||(run?.status==='succeeded')!==(input.status==='succeeded'))throw new Error('Original closeout scope differs')
      return commitInState(state,projectId,input.runId!,input)
    })
  }
  export async function acknowledge(store:ResearchStore,projectId:string,id:string,commitHash:string){
    await store.mutate(projectId,state=>{
      const item=state.operationOutbox[id],observation=item&&state.searchObservations[String(item.data.observationId)],operation=item&&state.operations[item.operationId]
      if(!item||item.purpose!=='projection'||!['trajectory_journal_v2','campaign_knowledge'].includes(item.kind)||item.data.commitHash!==commitHash||observation?.commitHash!==commitHash||operation?.state.commitHash!==commitHash)throw new Error('Projection acknowledgement differs from original evidence commit')
      if(item.status==='pending')state.operationOutbox[id]={...item,status:'acknowledged',receiptId:commitHash,updatedAt:new Date().toISOString()}
    })
  }
}
