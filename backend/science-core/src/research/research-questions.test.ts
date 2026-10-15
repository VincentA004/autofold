import {expect,test} from "bun:test"
import {ResearchQuestions} from "./research-questions"
import {TrialReasoning} from "./trial-reasoning"
const request = {question:"Exact sequence?",competingExplanations:["A","B"],requiredEvidence:"Sequence passage",applicabilityChecks:"same target",decisionIfResolved:"control"}
const original:any = {id:"sobs_original",campaignId:"cmp_one",experimentId:"exp_one",createdAt:"2026-01-01",runId:"run_one",decisionPlan:{researchRequest:request,evidenceRefs:["run_one"]}}
const cycle:any = {id:"kcy_block",campaignId:"cmp_one",createdAt:"2026-01-02",outputs:{researchRequestUpdates:[{requestId:"sobs_original",expectedRevision:null,status:"blocked",assessment:"missing",remainingGap:"supplement",nextAction:"new source",literatureIds:[]}]}}
test("reworded explicit reference preserves blocked identity, revision and assessment across serialization",()=>{
  const reference:any = {...original,id:"sobs_reference",createdAt:"2026-01-03",decisionPlan:{evidenceRefs:["run_two"],researchRequest:{...request,action:"reference",existingRequestId:"sobs_original",question:"Still standing, this is not a reopening"}}}
  const queue = ResearchQuestions.project(JSON.parse(JSON.stringify([reference,original])),[cycle])
  expect(queue).toHaveLength(1)
  expect(queue[0]).toMatchObject({requestId:"sobs_original",revision:"kcy_block",status:"blocked",assessment:"missing"})
  expect(queue[0].occurrenceIds).toEqual(["sobs_original","sobs_reference"])
  expect(queue[0].evidenceRefs).toEqual(["run_one","run_two"])
  expect(()=>ResearchQuestions.validateReference(reference.decisionPlan.researchRequest,queue,"exp_one")).toThrow("action=create")
  expect(()=>ResearchQuestions.validateReference({...reference.decisionPlan.researchRequest,question:request.question},queue,"exp_one")).not.toThrow()
  expect(()=>ResearchQuestions.validateReference(reference.decisionPlan.researchRequest,queue,"exp_other")).toThrow("Unknown")
  expect(()=>ResearchQuestions.project([{...reference,campaignId:"cmp_other"},original],[cycle])).toThrow("Unknown")
  expect(()=>ResearchQuestions.project([{...reference,decisionPlan:{...reference.decisionPlan,researchRequest:{...reference.decisionPlan.researchRequest,existingRequestId:"sobs_missing"}}},original],[cycle])).toThrow("Unknown")
})
test("references cannot silently become creates and explicit revisioned reopening remains required",()=>{
  expect(TrialReasoning.ResearchRequest.safeParse({...request,action:"reference"}).success).toBe(false)
  expect(TrialReasoning.ResearchRequest.safeParse({...request,existingRequestId:"sobs_original"}).success).toBe(false)
  expect(TrialReasoning.ResearchRequest.safeParse({...request,action:"reference",existingRequestId:"sobs_original"}).success).toBe(true)
  expect(()=>ResearchQuestions.validateUpdates([{requestId:"sobs_original",revision:"kcy_block",status:"blocked"}],[{requestId:"sobs_original",expectedRevision:"kcy_block",status:"open"}])).toThrow("Reopening")
})

test("explicit reopen is revisioned and a later assessment supersedes it",()=>{
  const reopen:any={...original,id:"sobs_reopen",createdAt:"2026-01-03",decisionPlan:{evidenceRefs:["run_one"],researchRequest:{...request,action:"reopen",existingRequestId:"sobs_original",expectedRevision:"kcy_block",reopenReason:"New full-text capability"}}}
  const queue=ResearchQuestions.project([original],[cycle])
  expect(()=>ResearchQuestions.validateReference(reopen.decisionPlan.researchRequest,queue,"exp_one")).not.toThrow()
  expect(()=>ResearchQuestions.validateReference({...reopen.decisionPlan.researchRequest,expectedRevision:null},queue,"exp_one")).toThrow("Reopening")
  expect(ResearchQuestions.project([original,reopen],[cycle])[0]).toMatchObject({requestId:"sobs_original",status:"open",revision:"kcy_block",nextAction:"New full-text capability"})
  const later:any={...cycle,id:"kcy_later",createdAt:"2026-01-04",outputs:{researchRequestUpdates:[{...cycle.outputs.researchRequestUpdates[0],expectedRevision:"kcy_block",status:"answered"}]}}
  expect(ResearchQuestions.project([original,reopen],[later,cycle])[0]).toMatchObject({status:"answered",revision:"kcy_later"})
})


test("trusted closeout questions require persisted trajectory linkage and retain revisioned status across multiple cycles",()=>{
 const source:any={id:'kcy_closeout',campaignId:'cmp_one',createdAt:'2026-01-01',trigger:'run_completed',generated:{by:'autofold-trusted-success-closeout/v1:run_one'},inputs:{knowledgeIds:['knw_one']},outputs:{researchRequestUpdates:[],searchObservationIds:['sobs_trajectory'],unresolvedQuestions:['What evidence did run_one add?','What decision changes?']},nextExperiment:{experimentId:'exp_one'}}
 const observation:any={id:'sobs_trajectory',campaignId:'cmp_one',experimentId:'exp_one',knowledgeCycleId:source.id,knowledgeId:'knw_one',runId:'run_one'}
 expect(ResearchQuestions.project([],[source])).toHaveLength(0)
 expect(ResearchQuestions.project([{...observation,runId:'run_forged'}],[source])).toHaveLength(0)
 expect(ResearchQuestions.project([{...observation,campaignId:'cmp_other'}],[source])).toHaveLength(0)
 expect(ResearchQuestions.project([{...observation,knowledgeId:'knw_wrong'}],[source])).toHaveLength(0)
 const questions=ResearchQuestions.project([observation],[source]);expect(questions).toHaveLength(2)
 expect(questions[0].origin).toBe('trusted_closeout')
 const assessed:any={id:'kcy_assessment',campaignId:'cmp_one',createdAt:'2026-01-02',outputs:{researchRequestUpdates:questions.map(q=>({requestId:q.requestId,expectedRevision:null,status:'blocked',assessment:'No independent replication',remainingGap:'Replication needed',nextAction:'Plan one replicate',literatureIds:[]}))}}
 const projected=ResearchQuestions.project([observation],JSON.parse(JSON.stringify([source,assessed])))
 expect(projected.every(q=>q.status==='blocked'&&q.revision===assessed.id)).toBe(true)
 expect(projected.map(q=>q.requestId)).toEqual(questions.map(q=>q.requestId))
})


test("all research statuses and historical requests are advisory while their identities and branch annotations remain intact",()=>{
 const question:any={status:'open',origin:'explicit_request',request}
 expect(ResearchQuestions.blocksExperiment(question)).toBe(false)
 expect(ResearchQuestions.blocksExperiment({...question,origin:'trusted_closeout'})).toBe(false)
 for(const purpose of ['empirical_test','knowledge_lookup']) expect(ResearchQuestions.blocksExperiment({...question,request:{...request,purpose}})).toBe(false)
 const scoped={...question,request:{...request,purpose:'knowledge_lookup',prerequisiteBranchId:'brn_a'}}
 expect(ResearchQuestions.blocksBranch(scoped,'brn_a')).toBe(false)
 expect(ResearchQuestions.blocksBranch({...scoped,status:'blocked'},'brn_a')).toBe(false)
 expect(ResearchQuestions.blocksBranch({...scoped,status:'answered'},'brn_a')).toBe(false)
 expect(ResearchQuestions.blocksBranch(scoped,'brn_b')).toBe(false)
 expect(ResearchQuestions.blocksBranch(question,'brn_a')).toBe(false)
 expect(TrialReasoning.ResearchRequest.safeParse({...request,purpose:'empirical_test',prerequisiteBranchId:'brn_a'}).success).toBe(false)
 expect(TrialReasoning.ResearchRequest.safeParse({...request,prerequisiteBranchId:'brn_a'}).success).toBe(false)
 expect(TrialReasoning.ResearchRequest.safeParse(scoped.request).success).toBe(true)
 expect(ResearchQuestions.identity(request)).toBe(JSON.stringify([request.question,request.requiredEvidence]))
 expect(ResearchQuestions.project([original],[])[0]!.identity).toBe(JSON.stringify([original.campaignId,original.experimentId,request.question,request.requiredEvidence]))
 expect(ResearchQuestions.identity(scoped.request)).not.toBe(ResearchQuestions.identity(request))
 const observations=[original,{...original,id:'sobs_typed',decisionPlan:{researchRequest:{...request,purpose:'empirical_test'},evidenceRefs:[]}},
 {...original,id:'sobs_branch_a',decisionPlan:{researchRequest:scoped.request,evidenceRefs:[]}},
 {...original,id:'sobs_branch_b',decisionPlan:{researchRequest:{...scoped.request,prerequisiteBranchId:'brn_b'},evidenceRefs:[]}}]
 expect(ResearchQuestions.project(observations,[])).toHaveLength(4)
})
