import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import z from 'zod'
import { ResearchDomain } from '@autofold/science-core/domain'
import type { ResearchStore } from '@autofold/science-core/store'
import { ResearchService } from '@autofold/science-core/service'
import { ResearchScientistMemory } from '@autofold/science-core/scientist-memory'
import { ResearchTrajectoryCloseout } from '@autofold/science-core/trajectory-closeout'
import { ScientificExecution, fileHash } from '../execution'
import { checkedPath } from '../execution/paths'
import { PiJobController, PI_JOB_RUNTIME } from '../jobs'
import { DEFAULT_MODEL_SELECTION, openSessionReader, replayWorkspaceEdits, type PiModelSelection, type PiRuntimeEvent } from '../runtime'
const Input = z.object({idempotencyKey: z.string().trim().min(1).max(300), iterations: z.union([z.literal(1), z.literal(2)]).default(2),
  modelBudgetUsd: z.number().finite().positive().max(100).default(2), modelSelection: z.object({provider: z.string().min(1), modelId: z.string().min(1)}).default(DEFAULT_MODEL_SELECTION)})
export type NativeAcceptanceInput = z.input<typeof Input>
/** Static SDK pricing is never an actual upstream bill, including in acceptance reports. */
export function acceptanceCostSummary(result:Record<string,unknown>|undefined) {
  const accounting=result?.providerAccounting as {status?:string;reportedCostUsd?:unknown;knownReportedCostUsd?:unknown}|undefined
  const reported=accounting?.status==='reported'&&typeof accounting.reportedCostUsd==='number'&&Number.isFinite(accounting.reportedCostUsd)&&accounting.reportedCostUsd>=0?accounting.reportedCostUsd:null
  return {sdkEstimatedModelCostUsd:result?.modelCostUsd,providerReportedModelCostUsd:reported,actualModelCostUsd:reported,
    modelCostSemantics:'sdk_static_estimate_and_separately_reported_original_provider_usage' as const}
}
export interface NativeAcceptanceDependencies {workspace: string; projectId: string; store: ResearchStore; research: ResearchService.Service; execution: ScientificExecution;
  jobs: PiJobController; sessionDirectory: string; profile: {id: string; mode: 'local'|'remote'; sourcePath: string};
  /** Explicit offline harness authority. Such reports can never pass native scientific acceptance. */ allowFixtureEvidence?: boolean}
const digest = (value: string) => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex')
async function atomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700})
  const temporary=file+'.'+crypto.randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600)
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync()}finally{await handle.close()}
  await fs.rename(temporary,file)
  const directory=await fs.open(path.dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
}
async function sourceManifest() {
  const root=path.resolve(import.meta.dir,'..'),files: Array<{path:string;contentHash:string}>=[]
  const visit=async(directory:string)=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const absolute=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Acceptance source must not contain symbolic links');if(entry.isDirectory())await visit(absolute);else if(entry.isFile()&&(entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts')||entry.name==='SKILL.md'))files.push({path:path.relative(root,absolute).split(path.sep).join('/'),contentHash:await fileHash(absolute)})}}
  await visit(root);await visit(path.resolve(root,'../../science-core/src'));files.sort((a,b)=>a.path.localeCompare(b.path))
  for (const relative of ['../package.json','../../science-core/package.json','../../../package.json','../../../package-lock.json']) files.push({path:relative,contentHash:await fileHash(path.resolve(root,relative))})
  return {format:'autofold.engine-source-manifest.v1',root,files,contentHash:digest(JSON.stringify(files))}
}
const eventData=(event:PiRuntimeEvent)=>event.data as any
function toolDetails(event:PiRuntimeEvent){const value=eventData(event);return value?.result?.details??value?.result}
function successfulTool(event:PiRuntimeEvent,name:string){const data=eventData(event);return event.type==='tool_execution_end'&&data?.toolName===name&&!data.isError}
const fileAuthor=(event:PiRuntimeEvent)=>eventData(event)?.isError===false&&['write','edit','write_file','edit_file'].some(name=>successfulTool(event,name))
/** Reuse Pi's supported edit primitive over memory only, so BOM/CRLF, fuzzy
 * matching and simultaneous disjoint edits follow the pinned runtime semantics. */
async function replayAuthoredEdit(content:string,args:unknown,native:boolean):Promise<string|undefined> {
  const value=args as {edits?:unknown;oldText?:unknown;newText?:unknown}|undefined
  const edits=native?value?.edits:[{oldText:value?.oldText,newText:value?.newText}]
  return replayWorkspaceEdits(content,edits)
}
/** Reconstruct model-authored writes/repairs from durable native or frozen legacy
 * arguments and trusted pre/post-byte receipts; external edits break the chain. */
export async function auditAuthoredProgram(trace: PiRuntimeEvent[], author: PiRuntimeEvent | undefined, programHash: string, throughSequence=(author?.sequence??0)+1, expectedDraftPath?:string) {
  if (!author||!fileAuthor(author)) return false
  const target = toolDetails(author)?.path
  if (typeof target !== 'string'||expectedDraftPath!==undefined&&target!==expectedDraftPath) return false
  let content: string | undefined
  for (const event of trace) {
    if (event.sequence >= throughSequence) break
    if (!fileAuthor(event) || toolDetails(event)?.path !== target) continue
    const starts=trace.filter(item=>item.type==='tool_execution_start'&&eventData(item)?.toolCallId===eventData(event)?.toolCallId)
    if(starts.length!==1||starts[0]!.sequence>=event.sequence||eventData(starts[0]!).toolName!==eventData(event).toolName)return false
    const args=eventData(starts[0]!).args
    const name=eventData(event).toolName,receipt=toolDetails(event)
    if (['write','write_file'].includes(name)) content = typeof args?.content === 'string' ? args.content : undefined
    else if(content!==undefined){
      if((name==='edit'&&receipt.previousProgramHash===undefined)||receipt.previousProgramHash!==undefined&&receipt.previousProgramHash!==digest(content))content=undefined
      else content=await replayAuthoredEdit(content,args,name==='edit')
    }
    if (content !== undefined && digest(content) !== receipt.programHash) content = undefined
  }
  return content !== undefined && digest(content) === programHash
}
const ACCEPTANCE_PROMPT=`Perform the authorized bounded native acceptance loop within the existing scientific experiment. The software gate checks runtime behavior; it does not replace the frozen scientific objective or make a completed gate a research stopping condition. Each contract budget is per trial, while the current job limits this batch; future authorized batches may continue the experiment. Use a grounded scientific stop only when the evidence, actual grants or a dependency justify it. Autonomously construct the initial native build_trial(ctx) program using the saved API and exact frozen contract; no operator supplies a trial or repairs it. Read the trusted context before choosing interventions. Repair from real validation/execution feedback within the existing bounds. After each verified result, inspect its committed trusted cycle, search observation and scientist event before taking another action. A subsequent evaluation must declare a concrete prospective intervention grounded in the prior run/evaluation/knowledge/search/cycle IDs. If further compute is unjustified, use stop_discovery with a concrete rationale and those prior evidence IDs. Preserve target, evaluator, seeds, model identity and budgets. These are software/computational acceptance checks, never biological confirmation or a claim of method improvement.`
export class NativeAcceptanceRunner {
  constructor(readonly dependencies: NativeAcceptanceDependencies) {
    for(const value of [dependencies.workspace,dependencies.sessionDirectory,dependencies.profile.sourcePath])if(!path.isAbsolute(value))throw new Error('Native acceptance requires explicit absolute host paths')
    if(dependencies.execution.workspace!==path.resolve(dependencies.workspace)||dependencies.execution.projectId!==dependencies.projectId)throw new Error('Acceptance execution belongs to another project')
    if(dependencies.profile.mode!==dependencies.execution.transportKind)throw new Error('Acceptance host profile mode differs from actual execution transport')
  }
  async run(experimentId:string,raw:NativeAcceptanceInput,signal?:AbortSignal){
    signal?.throwIfAborted()
    const input=Input.parse(raw),d=this.dependencies,state=await d.store.read(d.projectId),experiment=state.experiments[experimentId]
    if(!experiment||state.campaigns[experiment.campaignId]?.projectId!==d.projectId||experiment.status!=='active'||state.campaigns[experiment.campaignId]?.status!=='active')throw new Error('Native acceptance requires an existing active experiment and campaign in this project')
    ResearchDomain.assertContractIntegrity(experiment)
    const fixture=experiment.contract.evaluator.id==='mock-peptide-panel'||!experiment.contract.evaluator.evidenceAdapter
    if(fixture&&!d.allowFixtureEvidence)throw new Error('Native scientific acceptance rejects mock and CPU heuristic fixture contracts')
    await d.execution.preflightExperiment(experiment, signal)
    const key=digest(d.projectId+':'+experimentId+':'+input.idempotencyKey).slice(7),root='.autofold/acceptance/'+key
    const file=async(name:string)=>checkedPath(d.workspace,root+'/'+name)
    const currentSources=await sourceManifest(),profile={...d.profile,contentHash:await fileHash(d.profile.sourcePath)},worker=await d.execution.workerIdentity()
    let binding=await Bun.file(await file('binding.json')).json().catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
    if(binding&&(binding.format!=='autofold.native-acceptance-binding.v1'||binding.experimentId!==experimentId||binding.contractHash!==experiment.contractHash||JSON.stringify(binding.input)!==JSON.stringify(input)||JSON.stringify(binding.profile)!==JSON.stringify(profile)||binding.worker.sourceHash!==worker.sourceHash))throw new Error('Acceptance identity differs from its frozen contract, host profile, worker or model request')
    if(!binding){
      const initialStore=openSessionReader(path.join(d.sessionDirectory,'sessions.sqlite'))
      let initialSession
      try{initialSession=typeof experiment.piScientistSessionId==='string'?await initialStore?.get(experiment.piScientistSessionId):undefined}finally{initialStore?.close()}
      binding={format:'autofold.native-acceptance-binding.v1',projectId:d.projectId,experimentId,contractHash:experiment.contractHash,input,profile,worker,
      initialSources:currentSources,initialSessionSequence:initialSession?.sequence??0,capturedAt:new Date().toISOString(),baseline:{trialIds:Object.values(state.trials).filter(trial=>trial.experimentId===experimentId).map(trial=>trial.id)}};await atomic(await file('binding.json'),binding)}
    const job=await d.jobs.enqueueDiscovery(experimentId,{...input,idempotencyKey:'native-acceptance:'+key,prompt:ACCEPTANCE_PROMPT})
    if(binding.jobId&&binding.jobId!==job.id)throw new Error('Acceptance durable job identity changed')
    if(!binding.jobId){binding.jobId=job.id;await atomic(await file('binding.json'),binding)}
    if(!['succeeded','failed','cancelled'].includes(job.status))await d.jobs.runOnce({jobId:job.id,signal})
    const durable=await d.jobs.get(job.id),finalState=await d.store.read(d.projectId)
    const sessions=openSessionReader(path.join(d.sessionDirectory,'sessions.sqlite')),sessionId=String(durable.payload.sessionId)
    let session,journal:PiRuntimeEvent[]=[]
    try{session=await sessions?.get(sessionId);journal=await sessions?.events(sessionId)??[]}finally{sessions?.close()}
    const start=durable.startedAt?Date.parse(durable.startedAt):Number.POSITIVE_INFINITY
    const trace=journal.filter(event=>event.sequence>binding.initialSessionSequence&&event.timestamp>=start)
    const trials=Object.values(finalState.trials).filter(trial=>trial.experimentId===experimentId&&trial.origin?.jobId===job.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
    const runs=Object.values(finalState.runs).filter(run=>trials.some(trial=>trial.id===run.trialId)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
    const events=ResearchTrajectoryCloseout.events(finalState,await ResearchScientistMemory.read(d.workspace,experimentId),experimentId)
    const receipts:Array<Record<string,any>>=[],failures:string[]=[]
    for(const run of runs){if(run.status!=='succeeded'){failures.push(`${run.id}: ${run.status}${run.error?' '+run.error:''}`);continue}
      try{const receipt=await d.execution.artifacts(run.id),trial=receipt.trial,search=Object.values(finalState.searchObservations).filter(observation=>observation.runId===run.id&&observation.trialId===trial.id),memory=events.filter(event=>event.runId===run.id&&event.status==='succeeded')
        const cycle=memory[0]?.knowledgeCycleId?finalState.knowledgeCycles[memory[0].knowledgeCycleId]:undefined
        const observation=search.find(item=>item.closeoutVersion===2&&item.receiptHash===run.manifestHash&&item.decision!=='failed')
        const closeout=Object.values(durable.checkpoints).find(checkpoint=>checkpoint.phase.endsWith(':closeout')&&(observation
          ?checkpoint.data.closeoutVersion===2&&checkpoint.data.observationId===observation.id&&checkpoint.data.commitHash===observation.commitHash
          :!!cycle&&checkpoint.data.cycleId===cycle.id))
        const returned=trace.find(event=>successfulTool(event,'evaluate_trial')&&toolDetails(event)?.runId===run.id)
        const evaluating=returned?trace.find(event=>event.type==='tool_execution_start'&&eventData(event)?.toolCallId===eventData(returned)?.toolCallId):undefined
        const prematureActions=evaluating&&returned?trace.filter(event=>event.sequence>evaluating.sequence&&event.sequence<returned.sequence&&(event.type==='tool_execution_start'||event.type==='message_start'&&eventData(event)?.message?.role==='assistant')):[]
        const authors=trace.filter(event=>fileAuthor(event)&&toolDetails(event)?.path===(returned?toolDetails(returned)?.programPath:undefined)&&toolDetails(event)?.programHash===trial.programHash&&(!evaluating||event.sequence<evaluating.sequence))
        const author=authors.at(-1),authorName=author&&eventData(author).toolName
        const subsequent=returned?trace.filter(event=>event.sequence>returned.sequence&&(event.type==='tool_execution_start'||event.type==='message_start'&&eventData(event)?.message?.role==='assistant')):[]
        const committedAt=observation?.createdAt??cycle?.createdAt
        const boundObservation=observation
          ?Boolean(observation.commitHash&&observation.experimentId===experimentId&&observation.programHash===trial.programHash&&memory[0]?.observationId===observation.id&&memory[0]?.commitHash===observation.commitHash)
          :Boolean(cycle&&search.length&&search.every(item=>item.knowledgeCycleId===cycle.id&&item.experimentId===experimentId&&item.programHash===trial.programHash))
        const chronology=Boolean(committedAt&&boundObservation&&closeout&&returned&&evaluating&&prematureActions.length===0&&memory.length===1&&Date.parse(committedAt)<=returned.timestamp&&Date.parse(closeout.completedAt)<=returned.timestamp&&
          subsequent.every(event=>Date.parse(committedAt)<=event.timestamp&&Date.parse(memory[0]!.recordedAt)<=event.timestamp&&Date.parse(closeout.completedAt)<=event.timestamp))
        const frozen=receipt.evaluation.contractHash===experiment.contractHash&&trial.designAdapter==='proto'&&
          receipt.worker?.sourceHash===binding.worker.sourceHash&&receipt.scientific&&receipt.evidenceKind==='scientific'
        const closeoutTrusted=observation?Boolean(observation.commitHash&&observation.receiptHash===run.manifestHash):cycle?.generated.by===ResearchTrajectoryCloseout.successCloseoutActor(run.id)
        receipts.push({runId:run.id,trialId:trial.id,programHash:trial.programHash,programPath:trial.programPath,manifestHash:run.manifestHash,
          intent:trial.intent,hypothesis:trial.hypothesis,decisionPlan:trial.decisionPlan,prediction:trial.prediction,evidenceRefs:trial.evidenceRefs,
          configFingerprint:trial.configFingerprint,semanticFingerprint:trial.semanticFingerprint,workflowFingerprint:trial.workflowFingerprint,
          scientific:receipt.scientific,evidenceKind:receipt.evidenceKind,worker:receipt.worker,pipeline:receipt.pipeline,modelRuns:receipt.modelRuns,generationRuns:receipt.generationRuns,
          verifiedLocally:true,valid:receipt.evaluation.valid,score:receipt.evaluation.score,sourceBound:frozen,
          provenance:{closeoutVersion:observation?2:1,observationId:observation?.id,commitHash:observation?.commitHash,knowledgeCycleId:cycle?.id,searchObservationIds:search.map(item=>item.id),eventHashes:memory.map(ResearchScientistMemory.eventHash),closeoutPhase:closeout?.phase,
            closeoutCommittedAt:closeout?.completedAt,evaluationReturnedAt:returned?.timestamp,evaluationReturnedSequence:returned?.sequence,authoringSequence:author?.sequence,authoringTool:authorName},
          chronologyPassed:chronology&&closeoutTrusted,autonomouslyAuthored:await auditAuthoredProgram(trace,author,trial.programHash,evaluating?.sequence,(returned?toolDetails(returned)?.programPath:undefined))})
      }catch(error){failures.push(`${run.id}: local receipt verification failed: ${error instanceof Error?error.message:String(error)}`)}}
    const receiptIds=new Set(receipts.flatMap(receipt=>[receipt.runId,receipt.trialId,receipt.provenance.knowledgeCycleId,...receipt.provenance.searchObservationIds,
      ...Object.values(finalState.evaluations).filter(evaluation=>evaluation.trialId===receipt.trialId).map(evaluation=>evaluation.id),...Object.values(finalState.knowledge).filter(item=>item.runId===receipt.runId).map(item=>item.id)]).filter(Boolean))
    const first=receipts[0],priorIds=first?new Set([first.runId,first.trialId,first.provenance.knowledgeCycleId,...first.provenance.searchObservationIds,
      ...Object.values(finalState.evaluations).filter(evaluation=>evaluation.trialId===first.trialId).map(evaluation=>evaluation.id),...Object.values(finalState.knowledge).filter(item=>item.runId===first.runId).map(item=>item.id)]):new Set<string>()
    const next=trials.find(trial=>trial.id!==first?.trialId&&Date.parse(trial.createdAt)>=(first?.provenance.evaluationReturnedAt??Number.POSITIVE_INFINITY)&&trial.decisionPlan?.evidenceRefs.some(ref=>priorIds.has(ref)))
    const stop=(durable.result?.scientist as any)?.stopDecision
    const groundedStop=Boolean(stop?.reason&&stop?.rationale&&stop?.evidenceRefs?.some((ref:string)=>receiptIds.has(ref)))
    const scientificReceipts=receipts.filter(receipt=>receipt.scientific&&receipt.evidenceKind==='scientific'&&receipt.sourceBound)
    const latestSources=await sourceManifest()
    const checks={jobSettled:durable.status==='succeeded',fixedModel:Boolean(session&&session.modelSelection.provider===input.modelSelection.provider&&session.modelSelection.modelId===input.modelSelection.modelId),
      sourceVersionUnchanged:latestSources.contentHash===binding.initialSources.contentHash,verifiedScientificResult:scientificReceipts.length>=1,
      allReceiptsReverified:failures.length===0&&receipts.length===runs.filter(run=>run.status==='succeeded').length,
      trustedCloseoutBeforeFurtherAction:receipts.length>0&&receipts.every(receipt=>receipt.chronologyPassed),autonomousPrograms:receipts.length>0&&receipts.every(receipt=>receipt.autonomouslyAuthored),
      groundedNextInterventionOrStop:Boolean(next||groundedStop),twoVerifiedScientificIterations:scientificReceipts.length>=2}
    const basePassed=checks.jobSettled&&checks.fixedModel&&checks.sourceVersionUnchanged&&checks.verifiedScientificResult&&checks.allReceiptsReverified&&checks.trustedCloseoutBeforeFurtherAction&&checks.autonomousPrograms&&checks.groundedNextInterventionOrStop
    const report={format:'autofold.native-acceptance-report.v1',projectId:d.projectId,experimentId,jobId:job.id,sessionId,profile,worker,contract:experiment.contract,contractHash:experiment.contractHash,
      modelSelection:input.modelSelection,authorizedIterations:input.iterations,modelBudgetUsd:input.modelBudgetUsd,...acceptanceCostSummary(durable.result),
      executionMode:profile.mode,fixtureEvidence:fixture,nativeSoftwareAcceptancePassed:!fixture&&basePassed&&(input.iterations===1||checks.twoVerifiedScientificIterations),
      fullTwoIterationAcceptancePassed:!fixture&&basePassed&&checks.twoVerifiedScientificIterations,groundedStopAccepted:!fixture&&basePassed&&groundedStop,
      status:!['succeeded','failed','cancelled'].includes(durable.status)?'pending':fixture?'fixture_only':basePassed&&(input.iterations===1||checks.twoVerifiedScientificIterations)?'accepted':basePassed&&groundedStop?'grounded_stop':'incomplete',checks,failures,receipts,
      groundedNextTrialId:next?.id,groundedStop:groundedStop?stop:undefined,sourceManifestHash:binding.initialSources.contentHash,currentSourceManifestHash:latestSources.contentHash,
      epistemicStatus:'software_and_computational_acceptance_only',methodImprovementEstablished:false,biologicalValidationEstablished:false,
      paths:{root,report:root+'/report.json',job:root+'/job.json',transcript:root+'/transcript.json',journal:root+'/pi-events.json',events:root+'/scientist-events.json',sources:root+'/sources.json',receipts:root+'/receipts.json',closeout:root+'/closeout.json'}}
    const closeout={cycles:Object.values(finalState.knowledgeCycles).filter(cycle=>receipts.some(receipt=>receipt.provenance.knowledgeCycleId===cycle.id)),observations:Object.values(finalState.searchObservations).filter(item=>runs.some(run=>run.id===item.runId)),events:events.filter(event=>runs.some(run=>run.id===event.runId))}
    for(const [name,value] of Object.entries({'job.json':durable,'transcript.json':session??null,'pi-events.json':trace,'scientist-events.json':closeout.events,'sources.json':{initial:binding.initialSources,current:latestSources},'receipts.json':receipts,'closeout.json':closeout,'report.json':report}))await atomic(await file(name),value)
    return report
  }
}
export function runNativeAcceptance(dependencies:NativeAcceptanceDependencies,experimentId:string,input:NativeAcceptanceInput,signal?:AbortSignal){return new NativeAcceptanceRunner(dependencies).run(experimentId,input,signal)}
