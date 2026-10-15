import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {Lock} from '../util/lock'
import type {ResearchState,ResearchStore} from './store'
import {ResearchTrajectoryObservation} from './trajectory-observation'
import { TrialReasoning } from "./trial-reasoning"
import z from "zod"
import { ResearchDomain } from "./domain"
import { ResearchService } from "./service"
import { ResearchSearchPolicy } from "./search-policy"
import { ExecutionProtocol } from "./execution-protocol"
import { EvaluatorCalibration } from "./evaluator-calibration"
import { ResearchScientistMemory } from "./scientist-memory"

/**
 * Deterministically close one empirical trajectory. Trusted run facts enter
 * the search landscape immediately and idempotently; literature review and
 * model-authored interpretation are optional scientist tools, never an
 * iteration barrier.
 */
export namespace ResearchTrajectoryCloseout {
  export const TrajectoryPacket = z.object({
    format: z.literal("autofold.trajectory.v1"),
    campaignId: z.string().startsWith("cmp_"),
    experimentId: z.string().startsWith("exp_"),
    contractHash: z.string().startsWith("sha256:"),
    iteration: z.number().int().positive(),
    status: z.enum(["succeeded", "run_failed"]),
    trialId: z.string().startsWith("trl_"),
    runId: z.string().startsWith("run_"),
    knowledgeCycleId: z.string().startsWith("kcy_"),
    searchObservationIds: z.array(z.string().startsWith("sobs_")),
    score: z.number().finite().nullable().optional(),
    decision: z.enum(["promoted", "rejected", "observed", "failed"]).optional(),
    error: z.string().optional(),
    generatorPortfolio: z.array(z.string().trim().min(1)).max(30),
    generatorAllocations: z.array(ResearchSearchPolicy.Allocation).max(30),
    semanticProgramFingerprint: z.string().startsWith("sha256:").optional(),
    configurationFamilyFingerprint: z.string().startsWith("sha256:").optional(),
    workflowFingerprint: z.string().startsWith("sha256:").optional(),
    calibrationClass: EvaluatorCalibration.CalibrationClass.optional(),
    calibrationReplicateOfTrialId: z.string().startsWith("trl_").optional(),
    decisionPlan: TrialReasoning.DecisionPlan.optional(),
    prediction: TrialReasoning.Prediction.optional(),
    evidenceRefs: TrialReasoning.EvidenceRefs.optional(),
    generationReplicate: ExecutionProtocol.GenerationReplicateV1.optional(),
    generationWallSeconds: z.number().finite().nonnegative().optional(),
    generatorDiagnostics: z.array(ResearchDomain.GeneratorDiagnostics).max(30).default([]),
    candidateSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(100),
    modelIds: z.array(z.string().trim().min(1)).max(100),
  })
  export type TrajectoryPacket = z.infer<typeof TrajectoryPacket>

  export const Input = z.object({
    campaignId: z.string().startsWith("cmp_"),
    experimentId: z.string().startsWith("exp_"),
    sessionId: z.string().startsWith("ses_"),
    iteration: z.number().int().positive(),
    status: z.enum(["succeeded", "run_failed"]),
    trialId: z.string().startsWith("trl_").optional(),
    runId: z.string().startsWith("run_").optional(),
    score: z.number().finite().nullable().optional(),
    decision: z.enum(["promoted", "rejected", "observed"]).optional(),
    error: z.string().trim().min(1).optional(),
    failureReceiptHash:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    generatorPortfolio: z.array(z.string().trim().min(1)).max(30).default([]),
    generatorAllocations: z.array(ResearchSearchPolicy.Allocation).max(30).default([]),
    semanticProgramFingerprint: z.string().startsWith("sha256:").optional(),
    configurationFamilyFingerprint: z.string().startsWith("sha256:").optional(),
    workflowFingerprint: z.string().startsWith("sha256:").optional(),
    calibrationClass: EvaluatorCalibration.CalibrationClass.optional(),
    calibrationReplicateOfTrialId: z.string().startsWith("trl_").optional(),
    decisionPlan: TrialReasoning.DecisionPlan.optional(),
    prediction: TrialReasoning.Prediction.optional(),
    evidenceRefs: TrialReasoning.EvidenceRefs.optional(),
    generationReplicate: ExecutionProtocol.GenerationReplicateV1.optional(),
    generationWallSeconds: z.number().finite().nonnegative().optional(),
    generatorDiagnostics: z.array(ResearchDomain.GeneratorDiagnostics).max(30).default([]),
    candidateSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(100).default([]),
    modelIds: z.array(z.string().trim().min(1)).max(100).default([]),
  })
  // Callers may omit fields with schema defaults; `run` immediately parses
  // this into the fully populated output shape used by the closeout logic.
  export type Input = z.input<typeof Input>

  /** One mapping for standalone and campaign paths; schema owns all durable fields. */
  export function fromIteration(scope:{campaignId:string;experimentId:string;sessionId:string}, iteration:Iteration): z.output<typeof Input> {
    const candidateSequences=[...new Set((iteration.candidateSummaries ?? []).flatMap(candidate=>{
      if(!candidate || typeof candidate!=="object" || Array.isArray(candidate)) return []
      const sequence=(candidate as Record<string,unknown>).sequence
      return typeof sequence==="string" && /^[ACDEFGHIKLMNPQRSTVWY]+$/.test(sequence) ? [sequence] : []
    }))]
    return Input.parse({...iteration,...scope,candidateSequences,
      modelIds:[...new Set((iteration.modelEvidence ?? []).map(e=>e.modelId))]})
  }

  export const LegacyResult = z.discriminatedUnion("status", [
    z.object({
      status: z.literal("skipped"),
      reason: z.enum(["no_persisted_trajectory", "knowledge_current"]),
    }),
    z.object({
      status: z.literal("completed"),
      cycleId: z.string().startsWith("kcy_"),
      claimIds: z.array(z.string().startsWith("clm_")),
      alignmentIds: z.array(z.string().startsWith("aln_")),
      // The search observation is the canonical structured trajectory packet:
      // it links the immutable execution lineage, frozen contract evidence,
      // model/generator provenance, score delta, and knowledge cycle. Optional
      // preserves restart compatibility with checkpoints written before v1.
      trajectory: TrajectoryPacket.optional(),
      nextExperiment: ResearchDomain.NextExperimentProposal,
      unresolvedQuestions: z.array(z.string()),
    }),
  ])
  export type LegacyResult = z.infer<typeof LegacyResult>
  export const Result=z.union([LegacyResult,ResearchTrajectoryObservation.Result])
  export type Result=z.infer<typeof Result>
  export type DirectResult=ResearchTrajectoryObservation.Result

  /** Portable completed iteration; execution runtimes supply this projection. */
  export type Iteration = Omit<Input, "campaignId" | "experimentId" | "sessionId"> & {
    candidateSummaries?: unknown[]
    modelEvidence?: { modelId: string }[]
  }

  export interface LegacyDependencies {
    projectId:string
    store:ResearchStore
    verifyOriginalReceipt(runId:string):Promise<{receiptHash:string}>
    readEvents(experimentId:string):Promise<ResearchScientistMemory.TrajectoryEvent[]>
    appendEvent(event:ResearchScientistMemory.TrajectoryEventInput):Promise<unknown>
    publish?(campaignId:string):Promise<unknown>
  }
  export interface Dependencies {
    commit(input:z.output<typeof Input>):Promise<DirectResult>
    project(projection:ResearchTrajectoryObservation.Projection):Promise<unknown>
    acknowledge(id:string,commitHash:string):Promise<unknown>
  }
  /** Canonical receipts commit before every derivative projection attempt. */
  export async function run(raw:Input,dependencies:Dependencies):Promise<DirectResult|{status:'skipped';reason:'no_persisted_trajectory'}> {
    const input=Input.parse(raw)
    if(!input.trialId||!input.runId)return{status:'skipped',reason:'no_persisted_trajectory'}
    const result=await dependencies.commit(input),errors:string[]=[],pendingIds:string[]=[]
    for(const id of result.outboxIds){
      const kind=id.endsWith(':trajectory_journal_v2')?'trajectory_journal_v2':id.endsWith(':campaign_knowledge')?'campaign_knowledge':undefined
      if(!kind)throw new Error('Original trajectory projection kind is unsupported')
      try{await dependencies.project({id,kind,campaignId:input.campaignId,observationId:result.observationId,commitHash:result.commitHash,event:result.event});await dependencies.acknowledge(id,result.commitHash)}
      catch(error){pendingIds.push(id);errors.push(kind+': '+(error instanceof Error?error.message:String(error)))}
    }
    return {...result,outboxIds:pendingIds,projection:{status:errors.length?'pending':'published',...(errors.length?{errors}:{})}}
  }
  export const events=ResearchTrajectoryObservation.events
  export const readCommitted=ResearchTrajectoryObservation.readCommitted

  /** A regenerable v2 export. Original events.jsonl bytes and amendments are untouched. */
  export async function projectJournalV2(projection:ResearchTrajectoryObservation.Projection,directory:string):Promise<void> {
    const file=path.join(ResearchScientistMemory.root(directory,projection.event.experimentId),'events.v2.jsonl')
    using lock=await Lock.write('trajectory-projection:'+file)
    const original=await fs.readFile(file,'utf8').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return '';throw error})
    const entries=original.split('\n').filter(Boolean).map(line=>JSON.parse(line) as {format:string;observationId:string;commitHash:string;event:ResearchScientistMemory.TrajectoryEvent})
    const entry={format:'autofold.trajectory-projection.v2',observationId:projection.observationId,commitHash:projection.commitHash,event:projection.event}
    const existing=entries.find(item=>item.observationId===projection.observationId)
    if(existing&&ResearchService.knowledgeRecordHash(existing)!==ResearchService.knowledgeRecordHash(entry))throw new Error('Trajectory projection differs from canonical evidence; rebuild from the ledger')
    if(!existing)entries.push(entry)
    await atomicProjection(file,entries.map(item=>JSON.stringify(item)).join('\n')+'\n')
  }
  /** Repair corrupt/missing exports exclusively from canonical observations. */
  export async function rebuildJournalV2(state:ResearchState,directory:string,experimentId:string):Promise<void> {
    const projected=events(state,[],experimentId).filter(event=>event.closeoutVersion===2).map(event=>({format:'autofold.trajectory-projection.v2',observationId:event.observationId,commitHash:event.commitHash,event:ResearchScientistMemory.TrajectoryEvent.parse((({closeoutVersion,observationId,commitHash,receiptHash,...original})=>original)(event))}))
    const file=path.join(ResearchScientistMemory.root(directory,experimentId),'events.v2.jsonl')
    using lock=await Lock.write('trajectory-projection:'+file)
    await atomicProjection(file,projected.map(item=>JSON.stringify(item)).join('\n')+(projected.length?'\n':''))
  }
  async function atomicProjection(file:string,content:string){
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700})
    const temporary=file+'.'+randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600)
    try{await handle.writeFile(content);await handle.sync()}finally{await handle.close()}
    await fs.rename(temporary,file)
    const parent=await fs.open(path.dirname(file),'r');try{await parent.sync()}finally{await parent.close()}
  }

  /** Historical reader/journal repair only. It cannot create a cycle or interpretation. */
  export async function runLegacy(raw:Input,dependencies:LegacyDependencies):Promise<LegacyResult> {
    const input=Input.parse(raw)
    if(!input.trialId||!input.runId)return{status:'skipped',reason:'no_persisted_trajectory'}
    const state=await dependencies.store.read(dependencies.projectId),run=state.runs[input.runId],trial=run&&state.trials[run.trialId],experiment=trial&&state.experiments[trial.experimentId]
    if(!run||trial?.id!==input.trialId||experiment?.id!==input.experimentId||experiment.campaignId!==input.campaignId)throw new Error('Original legacy trajectory scope differs')
    const original=await dependencies.verifyOriginalReceipt(run.id)
    if(!/^sha256:[a-f0-9]{64}$/.test(original.receiptHash)||input.status==='succeeded'&&run.manifestHash!==original.receiptHash||input.status==='run_failed'&&input.failureReceiptHash!==original.receiptHash)throw new Error('Original verified legacy receipt differs')
    const actor=input.status==='succeeded'?successCloseoutActor(run.id):failureCloseoutActor(run.id)
    const cycles=Object.values(state.knowledgeCycles).filter(cycle=>cycle.campaignId===input.campaignId&&cycle.generated.by===actor)
    if(cycles.length!==1)throw new Error('Original v1 closeout cycle is absent or ambiguous; fresh semantic closeout is retired')
    const cycle=cycles[0]!,observations=Object.values(state.searchObservations).filter(observation=>observation.runId===run.id&&observation.knowledgeCycleId===cycle.id&&cycle.outputs.searchObservationIds.includes(observation.id))
    if(observations.length!==1||!cycle.inputs.knowledgeIds.includes(observations[0]!.knowledgeId)||!cycle.nextExperiment)throw new Error('Original v1 closeout lineage is incomplete; repair verified factual lineage through v2')
    const observation=observations[0]!,committed=ResearchTrajectoryObservation.readCommitted(state,dependencies.projectId,observation.id,original.receiptHash)
    if(committed.closeoutVersion!==1||committed.event.status!==input.status)throw new Error('Original closeout storage version or terminal outcome differs')
    const events=await dependencies.readEvents(input.experimentId)
    const previous=events.findLast(event=>event.runId===run.id&&event.status===input.status)
    if(previous&&(previous.trialId!==trial.id||previous.contractHash!==experiment.contractHash||previous.programHash&&previous.programHash!==trial.programHash||previous.score!==undefined&&previous.score!==committed.event.score||previous.decision&&previous.decision!==committed.event.decision))throw new Error('Original legacy journal receipt lineage differs')
    await dependencies.appendEvent(previous??{...committed.event,iteration:input.iteration})
    await dependencies.publish?.(input.campaignId)
    return LegacyResult.parse({status:'completed',cycleId:cycle.id,claimIds:cycle.outputs.claimIds,alignmentIds:cycle.outputs.alignmentIds,
      trajectory:TrajectoryPacket.parse({...committed.trajectory,iteration:input.iteration}),nextExperiment:cycle.nextExperiment,unresolvedQuestions:cycle.outputs.unresolvedQuestions})
  }

  export function failureCloseoutActor(runId: string): string {
    return `autofold-trusted-failure-closeout/v2:${z.string().startsWith("run_").parse(runId)}`
  }

  export function successCloseoutActor(runId: string): string {
    return `autofold-trusted-success-closeout/v1:${z.string().startsWith("run_").parse(runId)}`
  }

  export async function appendTrustedEvent(
    event: ResearchScientistMemory.TrajectoryEventInput,
    directory: string,
    direction: "minimize" | "maximize" = "minimize",
  ): Promise<ResearchScientistMemory.AppendResult> {
    const failed = event.status === "succeeded"
      ? (await ResearchScientistMemory.read(directory, event.experimentId))
        .find(previous => previous.runId === event.runId && previous.status === "run_failed")
      : undefined
    if(failed)return ResearchScientistMemory.appendAmendment(event,ResearchScientistMemory.eventHash(failed),directory,direction)
    return ResearchScientistMemory.append(event,directory,direction)
  }

}
