import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {StorageResearchStore,type ResearchState,type ResearchStore} from '@autofold/science-core/store'
import {ResearchDomain} from '@autofold/science-core/domain'
import {ResearchService} from '@autofold/science-core/service'
import {ResearchTrajectoryCloseout} from '@autofold/science-core/trajectory-closeout'

/** Explicit pre-migration fixture import. The fresh producer's database is never rewritten.
 * Only disposable test roots are accepted; this is not a production closeout port. */
export async function importHistoricalCloseoutFixture(host:{workspace:string;projectId:string;store:ResearchStore},runIds:string[]){
 if(!path.resolve(host.workspace).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Historical fixture imports require a temporary test workspace')
 const snapshot=historicalSnapshot(await host.store.read(host.projectId),runIds)
 const directory=path.join(host.workspace,'historical-closeout-fixture',randomUUID());await fs.mkdir(directory,{recursive:true})
 const store=new StorageResearchStore({directory});await store.mutate(host.projectId,draft=>{Object.assign(draft,snapshot)})
 const research=new ResearchService.Service(store)
 for(const runId of runIds){
  const observation=Object.values(snapshot.searchObservations).find(item=>item.runId===runId)!
  const original=ResearchTrajectoryCloseout.readCommitted(snapshot,host.projectId,observation.id,snapshot.runs[runId]!.manifestHash)
  await ResearchTrajectoryCloseout.appendTrustedEvent(original.event,host.workspace)
 }
 return{store,research}
}
function historicalSnapshot(source:ResearchState,runIds:string[]):ResearchState {
 const snapshot=structuredClone(source),selected=new Set(runIds)
 const factualOps=new Set(Object.values(snapshot.operations).filter(item=>item.kind==='verified_trajectory_evidence'&&selected.has(String(item.identity.runId))).map(item=>item.id))
 for(const id of factualOps)delete snapshot.operations[id]
 for(const [id,event] of Object.entries(snapshot.operationEvents))if(factualOps.has(event.operationId))delete snapshot.operationEvents[id]
 for(const [id,item] of Object.entries(snapshot.operationOutbox))if(factualOps.has(item.operationId))delete snapshot.operationOutbox[id]
 for(const runId of selected){
  const run=snapshot.runs[runId],trial=run&&snapshot.trials[run.trialId],experiment=trial&&snapshot.experiments[trial.experimentId]
  const observations=Object.values(snapshot.searchObservations).filter(item=>item.runId===runId)
  if(run?.status!=='succeeded'||!run.manifestHash||!trial||!experiment||observations.length!==1)throw new Error('Historical fixture requires one original verified successful receipt')
  const original=observations[0]!,knowledge=snapshot.knowledge[original.knowledgeId],evaluation=original.evaluationId&&snapshot.evaluations[original.evaluationId]
  if(!knowledge||!evaluation||evaluation.score!==original.score||evaluation.contractHash!==experiment.contractHash)throw new Error('Historical fixture original evaluation lineage differs')
  const cycleId='kcy_historical_'+createHash('sha256').update(runId).digest('hex')
  const {closeoutVersion,commitHash,receiptHash,iteration,sessionId,supersedesObservationId,valid,...legacy}=original
  snapshot.searchObservations[original.id]=ResearchDomain.SearchObservation.parse({...legacy,knowledgeCycleId:cycleId})
  snapshot.knowledgeCycles[cycleId]=ResearchDomain.KnowledgeCycle.parse({id:cycleId,campaignId:experiment.campaignId,trigger:'run_completed',question:'Original pre-migration closeout fixture',
   inputs:{knowledgeIds:[knowledge.id],claimIds:[],literatureIds:[]},outputs:{literatureIds:[],claimIds:[],alignmentIds:[],hypothesisIds:[],searchObservationIds:[original.id],unresolvedQuestions:[
    `What decision-relevant evidence did run ${runId} add?`,
    'What concrete candidate, program, allocation, or research decision changes after inspecting the saved evidence? An unresolved mechanism alone does not require another GPU trial.',
   ]},generated:{by:ResearchTrajectoryCloseout.successCloseoutActor(runId),at:original.createdAt},createdAt:original.createdAt,nextReviewAt:original.createdAt,
   campaignSummary:'Imported historical computational closeout fixture; it does not establish biological validity.',
   nextExperiment:{action:'continue_experiment',experimentId:experiment.id,hypothesis:'Original historical continuation proposal',rationale:'Original recorded computational outcome remains available',successCriterion:'Original bounded scientific decision'},
  })
 }
 return snapshot
}
