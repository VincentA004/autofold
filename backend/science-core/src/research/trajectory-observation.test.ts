import {afterEach,expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ResearchService} from './service'
import {StorageResearchStore} from './store'
import {ResearchTrajectoryCloseout} from './trajectory-closeout'
import {SearchDistributions} from './search-distributions'
import {EvaluatorCalibration} from './evaluator-calibration'
import {ResearchScientistMemory} from './scientist-memory'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
const digest=(c:string)=>'sha256:'+c.repeat(64)
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-factual-closeout-'));roots.push(root)
 const project='factual_offline',options={directory:path.join(root,'db')},store=new StorageResearchStore(options)
 let sequence=0,seconds=0
 const service=new ResearchService.Service(store,{id:prefix=>prefix+'_'+(++sequence),now:()=>new Date(Date.UTC(2026,9,12,0,0,seconds++)).toISOString()})
 const campaign=await service.createCampaign(project,{objective:'Observe original receipts'});await service.activateCampaign(project,campaign.id)
 const experiment=await service.createExperiment(project,campaign.id,{contract:{version:1,objective:'Observe original receipts',targetArtifactHash:digest('a'),modality:'short_peptide',budget:{maximumCandidates:4,gpuHours:0,wallTimeMinutes:1},evaluator:{id:'offline',version:'1',sourceHash:digest('b'),direction:'minimize',fixedSeeds:[1,7],submissionSize:1}}});await service.activateExperiment(project,experiment.id)
 const trial=await service.createTrial(project,experiment.id,{hypothesis:'An authored scientific question',designAdapter:'mock',programPath:'original.py',programHash:digest('c'),generators:['original-native-generator']})
 const run=await service.beginRun(project,trial.id,{bundlePath:'original/bundle.json',outputPath:'original/output'});await service.attachRunJob(project,run.id,'original-compute')
 const evaluation={contractHash:experiment.contractHash,evaluatorHash:experiment.contract.evaluator.sourceHash,valid:true,score:.2,diagnostics:{original_metric:.2}}
 const input={campaignId:campaign.id,experimentId:experiment.id,sessionId:'ses_original',iteration:1,trialId:trial.id,runId:run.id,status:'succeeded' as const}
 const dependencies=(host=service):ResearchTrajectoryCloseout.Dependencies=>({commit:input=>host.recordTrajectoryObservation(project,input),acknowledge:(id,hash)=>host.acknowledgeTrajectoryProjection(project,id,hash),project:projection=>projection.kind==='trajectory_journal_v2'?ResearchTrajectoryCloseout.projectJournalV2(projection,root):host.publishCampaignKnowledge(project,projection.campaignId,root)})
 return{root,project,options,store,service,campaign,experiment,trial,run,evaluation,input,dependencies}
}
test('receipt, evaluation, incumbent, observation and projection outbox commit together without semantic scaffolding',async()=>{
 const f=await fixture(),result=await f.service.completeRun(f.project,f.run.id,f.evaluation,digest('d'),undefined,{candidateSequences:['ACDE'],modelIds:['independent-evaluator'],iteration:3,sessionId:'ses_original'})
 const state=await f.store.read(f.project)
 expect(result.observationCommit).toMatchObject({closeoutVersion:2,trajectory:{iteration:3,candidateSequences:['ACDE']}})
 expect(state.runs[f.run.id]!.status).toBe('succeeded');expect(state.experiments[f.experiment.id]!.incumbentTrialId).toBe(f.trial.id)
 expect(Object.values(state.searchObservations)).toHaveLength(1);expect(Object.values(state.operationOutbox)).toHaveLength(2)
 expect(Object.values(state.knowledgeCycles)).toHaveLength(0);expect(Object.values(state.hypotheses)).toHaveLength(0)
 expect(ResearchTrajectoryCloseout.events(state,[],f.experiment.id)).toHaveLength(1)
 expect(await ResearchScientistMemory.read(f.root,f.experiment.id)).toEqual([])
})
test('an invalid factual admission rolls back every part of original completion',async()=>{
 const f=await fixture()
 await expect(f.service.completeRun(f.project,f.run.id,f.evaluation,digest('d'),undefined,{candidateSequences:['INVALID-X']})).rejects.toThrow()
 const state=await f.store.read(f.project)
 expect(state.runs[f.run.id]!.status).toBe('running');expect(state.experiments[f.experiment.id]!.incumbentTrialId).toBeUndefined()
 expect(Object.values(state.evaluations)).toHaveLength(0);expect(Object.values(state.searchObservations)).toHaveLength(0);expect(Object.values(state.operationOutbox)).toHaveLength(0)
})
test('failed projections cannot hide canonical facts and reopen retries only pending original projections',async()=>{
 const f=await fixture();await f.service.completeRun(f.project,f.run.id,f.evaluation,digest('d'))
 const before=await f.store.read(f.project),snapshot=JSON.stringify({runs:before.runs,evaluations:before.evaluations,knowledge:before.knowledge,observations:before.searchObservations})
 let projectionCalls=0
 const failed=await ResearchTrajectoryCloseout.run(f.input,{...f.dependencies(),project:async()=>{projectionCalls++;throw new Error('offline disk failure')}})
 expect(failed).toMatchObject({status:'completed',projection:{status:'pending'}});expect(projectionCalls).toBe(2)
 expect(ResearchTrajectoryCloseout.events(await f.store.read(f.project),[],f.experiment.id)).toHaveLength(1)
 const reopened=new ResearchService.Service(new StorageResearchStore(f.options)),recovered=await ResearchTrajectoryCloseout.run(f.input,f.dependencies(reopened))
 expect(recovered).toMatchObject({status:'completed',projection:{status:'published'}})
 const settled=await f.store.read(f.project)
 expect(JSON.stringify({runs:settled.runs,evaluations:settled.evaluations,knowledge:settled.knowledge,observations:settled.searchObservations})).toBe(snapshot)
 expect(Object.values(settled.operationOutbox).every(item=>item.status==='acknowledged')).toBe(true)
 expect((await ResearchTrajectoryCloseout.run(f.input,f.dependencies(reopened))).status).toBe('completed')
 expect((await fs.readFile(path.join(ResearchScientistMemory.root(f.root,f.experiment.id),'events.v2.jsonl'),'utf8')).trim().split('\n')).toHaveLength(1)
})
test('known failed receipts commit direct observations while unverified failures stay outside the factual ledger',async()=>{
 const f=await fixture();await f.service.failRun(f.project,f.run.id,'Original transport failed')
 expect(Object.values((await f.store.read(f.project)).searchObservations)).toHaveLength(0)
 await f.service.failRun(f.project,f.run.id,'Original transport failed',undefined,{failureReceiptHash:digest('e')})
 const result=await ResearchTrajectoryCloseout.run({...f.input,status:'run_failed'},f.dependencies())
 expect(result).toMatchObject({status:'completed',receiptHash:digest('e'),event:{status:'run_failed',valid:false,error:'Original transport failed'}})
 expect(Object.values((await f.store.read(f.project)).knowledgeCycles)).toHaveLength(0)
})
test('invalid computational scores remain observations without becoming a candidate frontier',async()=>{
 const f=await fixture();await f.service.completeRun(f.project,f.run.id,{...f.evaluation,valid:false,score:.001},digest('d'))
 const state=await f.store.read(f.project),events=ResearchTrajectoryCloseout.events(state,[],f.experiment.id)
 expect(events[0]).toMatchObject({status:'succeeded',valid:false,score:.001,decision:'rejected'})
 expect(Object.values(state.searchObservations)[0]).toMatchObject({valid:false,epistemicLevel:'model_observation'})
 const invalid={...Object.values(state.searchObservations)[0]!,configurationFamilyFingerprint:digest('f'),calibrationClass:'known_positive' as const}
 expect(SearchDistributions.summarize([invalid])[0]?.scored).toBe(0)
 expect(EvaluatorCalibration.audit({observations:[invalid],direction:'minimize'})).toMatchObject({status:'unassessed',positiveTrials:0})
 expect(ResearchScientistMemory.project(events,'minimize').frontier.bestScore).toBeNull()
 expect(state.experiments[f.experiment.id]!.incumbentTrialId).toBeUndefined()
})
test('a changed canonical observation hash is rejected during receipt recovery and memory derivation',async()=>{
 const f=await fixture();await f.service.completeRun(f.project,f.run.id,f.evaluation,digest('d'))
 await f.store.mutate(f.project,state=>{Object.values(state.searchObservations)[0]!.candidateSequences=['AAAA']})
 await expect(f.service.recordTrajectoryObservation(f.project,f.input)).rejects.toThrow('commit hash differs')
 const state=await f.store.read(f.project);expect(()=>ResearchTrajectoryCloseout.events(state,[],f.experiment.id)).toThrow('commit hash differs')
})
test('v2 projection corruption is rebuilt from the canonical ledger without editing the original journal',async()=>{
 const f=await fixture();await f.service.completeRun(f.project,f.run.id,f.evaluation,digest('d'));await ResearchTrajectoryCloseout.run(f.input,f.dependencies())
 const originalEvent=ResearchScientistMemory.TrajectoryEvent.parse({experimentId:'exp_historical',contractHash:digest('a'),iteration:1,status:'run_failed',trialId:'trl_historical',runId:'run_historical',error:'Original unscored failure'})
 await ResearchScientistMemory.append(originalEvent,f.root)
 const historicalFile=ResearchScientistMemory.eventLogPath(f.root,'exp_historical'),originalBytes=await fs.readFile(historicalFile)
 const projected=path.join(ResearchScientistMemory.root(f.root,f.experiment.id),'events.v2.jsonl');await fs.writeFile(projected,'corrupt export')
 await ResearchTrajectoryCloseout.rebuildJournalV2(await f.store.read(f.project),f.root,f.experiment.id)
 expect(JSON.parse((await fs.readFile(projected,'utf8')).trim()).event.runId).toBe(f.run.id)
 expect(await fs.readFile(historicalFile)).toEqual(originalBytes)
 expect(ResearchTrajectoryCloseout.events(await f.store.read(f.project),[],f.experiment.id)).toHaveLength(1)
})

/** An explicit historical import fixture predating atomic v2 closeout. */
async function historicalCompletion(f:Awaited<ReturnType<typeof fixture>>){
 await f.store.mutate(f.project,state=>{state.trials[f.trial.id]!.status='evaluating'})
 const completed=await f.service.recordEvaluation(f.project,f.trial.id,f.evaluation)
 await f.store.mutate(f.project,state=>{
  state.runs[f.run.id]={...state.runs[f.run.id]!,status:'succeeded',manifestHash:digest('d'),completedAt:completed.evaluation.evaluatedAt}
  state.knowledge[completed.knowledge.id]={...state.knowledge[completed.knowledge.id]!,runId:f.run.id}
 })
 return completed
}
async function historicalCycle(f:Awaited<ReturnType<typeof fixture>>,failure=false){
 const state=await f.store.read(f.project),knowledge=Object.values(state.knowledge).find(item=>item.runId===f.run.id)!,evaluation=knowledge.evaluationId?state.evaluations[knowledge.evaluationId]:undefined
 return f.service.ingestLiteratureReview(f.project,f.campaign.id,{generatedBy:failure?ResearchTrajectoryCloseout.failureCloseoutActor(f.run.id):ResearchTrajectoryCloseout.successCloseoutActor(f.run.id),inputKnowledgeIds:[knowledge.id],sources:[],claims:[],unresolvedQuestions:['Original recorded scientific question'],nextExperiment:{action:'continue_experiment',experimentId:f.experiment.id,hypothesis:'Original recorded proposal',rationale:'Original recorded rationale',successCriterion:'Original recorded criterion'},searchObservations:[{experimentId:f.experiment.id,trialId:f.trial.id,runId:f.run.id,evaluationId:evaluation?.id,knowledgeId:knowledge.id,intent:f.trial.intent,programHash:f.trial.programHash,generatorPortfolio:f.trial.generators,generatorAllocations:[],candidateSequences:failure?[]:['ACDE'],modelIds:failure?[]:['original-evaluator'],seeds:failure?[]:f.experiment.contract.evaluator.fixedSeeds,score:evaluation?.score??null,decision:knowledge.decision!,diagnostics:evaluation?.diagnostics??{},hypothesis:f.trial.hypothesis}]})
}
test('original v1 observations and cycles are adopted without rewriting bytes or creating another observation',async()=>{
 const f=await fixture();await historicalCompletion(f);const originalCycle=await historicalCycle(f)
 const before=await f.store.read(f.project),observation=Object.values(before.searchObservations)[0]!
 const original=ResearchTrajectoryCloseout.readCommitted(before,f.project,observation.id,digest('d'))
 await ResearchTrajectoryCloseout.appendTrustedEvent(original.event,f.root)
 const journal=ResearchScientistMemory.eventLogPath(f.root,f.experiment.id),bytes=await fs.readFile(journal)
 const legacy=await ResearchTrajectoryCloseout.runLegacy(f.input,{projectId:f.project,store:f.store,readEvents:async()=>ResearchScientistMemory.read(f.root,f.experiment.id),verifyOriginalReceipt:async()=>({receiptHash:digest('d')}),appendEvent:event=>ResearchTrajectoryCloseout.appendTrustedEvent(event,f.root)})
 expect(legacy).toMatchObject({status:'completed',cycleId:originalCycle.cycle.id,nextExperiment:{hypothesis:'Original recorded proposal'}})
 const adopted=await f.service.recordTrajectoryObservation(f.project,f.input)
 expect(adopted).toMatchObject({closeoutVersion:1,observationId:observation.id,outboxIds:[]})
 expect(await f.store.read(f.project)).toEqual(before);expect(await fs.readFile(journal)).toEqual(bytes)
})
test('a verified historical journal with a missing ledger fact repairs through v2 without manufacturing a legacy cycle',async()=>{
 const f=await fixture();await historicalCompletion(f)
 const legacy=ResearchScientistMemory.TrajectoryEvent.parse({...f.input,contractHash:f.experiment.contractHash,intent:f.trial.intent,programHash:f.trial.programHash,hypothesis:f.trial.hypothesis,score:.2,decision:'promoted',knowledgeCycleId:'kcy_archived_original'})
 await ResearchTrajectoryCloseout.appendTrustedEvent(legacy,f.root)
 const journal=ResearchScientistMemory.eventLogPath(f.root,f.experiment.id),bytes=await fs.readFile(journal)
 await expect(ResearchTrajectoryCloseout.runLegacy(f.input,{projectId:f.project,store:f.store,readEvents:async()=>[],verifyOriginalReceipt:async()=>({receiptHash:digest('d')}),appendEvent:async()=>{throw new Error('No new legacy journal entry')}})).rejects.toThrow('fresh semantic closeout is retired')
 const repaired=await f.service.recordTrajectoryObservation(f.project,f.input)
 expect(repaired.closeoutVersion).toBe(2)
 const state=await f.store.read(f.project),events=ResearchTrajectoryCloseout.events(state,await ResearchScientistMemory.read(f.root,f.experiment.id),f.experiment.id)
 expect(Object.values(state.searchObservations)).toHaveLength(1);expect(Object.values(state.knowledgeCycles)).toHaveLength(0)
 expect(events).toHaveLength(1);expect(events[0]?.knowledgeCycleId).toBe('kcy_archived_original');expect(await fs.readFile(journal)).toEqual(bytes)
})
test('verified recovered success supersedes its exact original failure without rewriting historical judgments or journal bytes',async()=>{
 const f=await fixture();await f.service.failRun(f.project,f.run.id,'Original artifact transfer failure');await historicalCycle(f,true)
 const before=await f.store.read(f.project),failure=Object.values(before.searchObservations)[0]!,originalCycle=JSON.stringify(before.knowledgeCycles)
 const failureEvent=ResearchTrajectoryCloseout.readCommitted(before,f.project,failure.id,digest('e')).event
 await ResearchTrajectoryCloseout.appendTrustedEvent(failureEvent,f.root)
 const file=ResearchScientistMemory.eventLogPath(f.root,f.experiment.id),originalBytes=await fs.readFile(file)
 await f.service.reopenRunFinalization(f.project,f.run.id)
 await f.service.completeRun(f.project,f.run.id,f.evaluation,digest('d'),undefined,{candidateSequences:['ACDE']})
 const state=await f.store.read(f.project),success=Object.values(state.searchObservations).find(item=>item.decision!=='failed')!
 expect(state.searchObservations[failure.id]).toEqual(failure);expect(JSON.stringify(state.knowledgeCycles)).toBe(originalCycle)
 expect(success.supersedesObservationId).toBe(failure.id)
 const events=ResearchTrajectoryCloseout.events(state,await ResearchScientistMemory.read(f.root,f.experiment.id),f.experiment.id)
 expect(events).toHaveLength(2);expect(events[1]!.supersedesEventHash).toBe(ResearchScientistMemory.eventHash(failureEvent))
 expect(ResearchScientistMemory.project(events,'minimize')).toMatchObject({eventCount:1,failures:[]})
 expect(await fs.readFile(file)).toEqual(originalBytes)
})
