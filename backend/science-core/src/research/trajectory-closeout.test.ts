import {expect,test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {ResearchTrajectoryCloseout} from './trajectory-closeout'
import {MemoryResearchStore} from './store'

test('historical closeout actors retain their original per-run identity',()=>{
 expect(ResearchTrajectoryCloseout.failureCloseoutActor('run_one')).toBe('autofold-trusted-failure-closeout/v2:run_one')
 expect(ResearchTrajectoryCloseout.successCloseoutActor('run_one')).toBe('autofold-trusted-success-closeout/v1:run_one')
 expect(ResearchTrajectoryCloseout.failureCloseoutActor('run_one')).not.toBe(ResearchTrajectoryCloseout.failureCloseoutActor('run_two'))
})
test('fresh nonpersisted authoring failures do not open an evidence transaction or projection',async()=>{
 let calls=0
 const result=await ResearchTrajectoryCloseout.run({campaignId:'cmp_original',experimentId:'exp_original',sessionId:'ses_original',iteration:1,status:'run_failed',error:'Authoring had no accepted artifact'},
  {commit:async()=>{calls++;throw new Error('No receipt to commit')},project:async()=>{calls++;throw new Error('No projection')},acknowledge:async()=>{calls++;throw new Error('No outbox')}})
 expect(result).toEqual({status:'skipped',reason:'no_persisted_trajectory'});expect(calls).toBe(0)
})
test('legacy compatibility does not offer an ingest port and refuses absent original lineage',async()=>{
 const store=new MemoryResearchStore();let writes=0
 await expect(ResearchTrajectoryCloseout.runLegacy({campaignId:'cmp_original',experimentId:'exp_original',sessionId:'ses_original',iteration:1,status:'succeeded',trialId:'trl_original',runId:'run_original'},
  {projectId:'original',store,readEvents:async()=>[],verifyOriginalReceipt:async()=>({receiptHash:'sha256:'+'a'.repeat(64)}),appendEvent:async()=>{writes++}})).rejects.toThrow('Original legacy trajectory scope differs')
 expect(Object.values((await store.read('original')).knowledgeCycles)).toHaveLength(0);expect(writes).toBe(0)
})
test('original authoritative journal remains append-only and identical repeated recovery does not add evidence',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'autofold-original-events-'))
 try{
  const event={experimentId:'exp_original',contractHash:'sha256:'+'a'.repeat(64),iteration:1,status:'succeeded' as const,trialId:'trl_original',runId:'run_original',score:.2,decision:'promoted' as const}
  await ResearchTrajectoryCloseout.appendTrustedEvent(event,workspace)
  const file=path.join(workspace,'.autofold/autoresearch/exp_original/events.jsonl'),before=await fs.readFile(file)
  await ResearchTrajectoryCloseout.appendTrustedEvent(event,workspace)
  expect(await fs.readFile(file)).toEqual(before)
 }finally{await fs.rm(workspace,{recursive:true,force:true})}
})
test('iteration mapper preserves authored prospective metadata and observed candidate identities',()=>{
 const decisionPlan={question:'Which branch?',alternatives:[{id:'a',experiment:'A',expectedInformation:'A',estimatedGpuHours:1},{id:'b',experiment:'B',expectedInformation:'B',estimatedGpuHours:1}],selectedAlternativeId:'a',rationale:'Compare',evidenceRefs:['run_prior'],outcomeBranches:[{observation:'low',nextDecision:'expand'},{observation:'high',nextDecision:'defer'}]}
 const mapped=ResearchTrajectoryCloseout.fromIteration({campaignId:'cmp_original',experimentId:'exp_original',sessionId:'ses_original'},
  {iteration:1,status:'succeeded',trialId:'trl_original',runId:'run_original',decisionPlan,prediction:{comparatorTrialId:'trl_prior',metric:'locked_score',relation:'lower',minimumDifference:0},evidenceRefs:['run_prior'],configurationFamilyFingerprint:'sha256:'+'a'.repeat(64),candidateSummaries:[{sequence:'ACDE'},{sequence:'ACDE'},{sequence:'INVALID-X'}]})
 expect(mapped.decisionPlan).toEqual(decisionPlan);expect(mapped.prediction?.comparatorTrialId).toBe('trl_prior');expect(mapped.candidateSequences).toEqual(['ACDE'])
})
