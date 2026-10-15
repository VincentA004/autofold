import {expect,test} from "bun:test"
import {EvidenceView} from "./evidence-view"
import {ScientistReview} from "./scientist-review"
import {emptyResearchState} from "./store"
import {ExperimentBranches} from "./experiment-branches"
function fixture() {
  const state=emptyResearchState()
  state.experiments.exp_one={id:"exp_one",campaignId:"cmp_one",contractHash:"frozen"} as any
  state.experiments.exp_two={id:"exp_two",campaignId:"cmp_one",contractHash:"frozen"} as any
  state.searchObservations.sobs_one={id:"sobs_one",campaignId:"cmp_one",experimentId:"exp_one",runId:"run_one",trialId:"trl_one",knowledgeId:"knw_one",knowledgeCycleId:"kcy_one",decisionPlan:{question:"original prospective question"}} as any
  state.searchObservations.sobs_foreign={id:"sobs_foreign",campaignId:"cmp_one",experimentId:"exp_two",runId:"run_foreign",trialId:"trl_foreign",knowledgeId:"knw_foreign",knowledgeCycleId:"kcy_foreign",decisionPlan:{question:"foreign question"}} as any
  const branch=ExperimentBranches.save(state,"exp_one",{program:"original",title:"one",rationale:"test",revisitWhen:"new evidence",evidenceRefs:[]},"2026-01-01")
  const input={runId:"run_one",expectedRevision:0,finding:"Mean did not improve",interpretation:"Specific rescue not observed",predictionAssessment:"not_supported_for_tested_predicate" as const,
    remainingExplanations:["Other settings remain untested"],limitations:["Small panel"],nextDecision:"Change generator",evidenceRefs:["run_one"],
    branchUpdates:[{action:"status" as const,branchId:branch.id,expectedRevision:0,status:"deferred" as const,rationale:"No rescue on tested panel",revisitWhen:"Independent evidence"}]}
  return {state,branch,input}
}
test("review and branch lifecycle commit once, retain original prediction and distinguish interpretation",()=>{
  const {state,branch,input}=fixture()
  const record=ScientistReview.commit(state,"exp_one",input,{pairedCount:12},"2026-01-02")
  expect(record).toMatchObject({revision:1,epistemicStatus:"scientist_interpretation",decisionPlan:{question:"original prospective question"},evidenceSummary:{pairedCount:12}})
  expect(branch.status).toBe("deferred");expect(branch.revision).toBe(1)
  expect(ScientistReview.commit(state,"exp_one",JSON.parse(JSON.stringify(input)),{pairedCount:12},"2026-01-03").id).toBe(record.id)
  expect(branch.revision).toBe(1)
  expect(()=>ScientistReview.commit(state,"exp_one",{...input,interpretation:"Changed claim"},{},"later")).toThrow("revision conflict")
  const corrected=ScientistReview.commit(state,"exp_one",{...input,expectedRevision:1,interpretation:"Correction",branchUpdates:[]},{pairedCount:12},"later")
  expect(corrected.revision).toBe(2);expect(Object.keys(state.scientistReviews)).toHaveLength(2)
})
test("unknown evidence, cross-experiment and stale batched branch effects are rejected without partial changes",()=>{
  const {state,branch,input}=fixture()
  expect(()=>ScientistReview.commit(state,"exp_other",input,{},"now")).toThrow("settled")
  expect(()=>ScientistReview.commit(state,"exp_one",{...input,evidenceRefs:["run_one","run_foreign"]},{},"now")).toThrow("outside_experiment")
  expect(()=>ScientistReview.commit(state,"exp_one",{...input,branchUpdates:[...input.branchUpdates,{...input.branchUpdates[0],branchId:"brn_missing"}]},{},"now")).toThrow("outside")
  expect(branch.revision).toBe(0);expect(Object.keys(state.scientistReviews)).toHaveLength(0)
  expect(()=>ScientistReview.commit(state,"exp_one",{...input,branchUpdates:[input.branchUpdates[0],input.branchUpdates[0]]},{},"now")).toThrow("Duplicate")
})

test("a prior run revision does not advance the first review revision for a new run",()=>{
  const {state,input}=fixture()
  ScientistReview.commit(state,"exp_one",{...input,branchUpdates:[]},{pairedCount:12},"2026-01-02")
  state.searchObservations.sobs_two={id:"sobs_two",campaignId:"cmp_one",experimentId:"exp_one",runId:"run_two",
    trialId:"trl_two",knowledgeId:"knw_two",knowledgeCycleId:"kcy_two",decisionPlan:{question:"second question"}} as any
  const next={...input,runId:"run_two",expectedRevision:1,evidenceRefs:["run_two"],branchUpdates:[]}
  let conflict: unknown
  try { ScientistReview.commit(state,"exp_one",next,{},"2026-01-03") } catch (error) { conflict=error }
  expect(conflict).toBeInstanceOf(ScientistReview.RevisionConflictError)
  expect((conflict as ScientistReview.RevisionConflictError).conflict).toEqual({
    runId:"run_two",expectedRevision:1,actualRevision:0,currentReviewId:undefined,
  })
  expect((conflict as Error).message).toContain("Reviews for other runs do not advance this run")
  const committed=ScientistReview.commit(state,"exp_one",{...next,expectedRevision:0},{},"2026-01-03")
  expect(committed).toMatchObject({runId:"run_two",revision:1})
})

test("candidate-scoped numerical receipts must exactly match the trusted identity join", () => {
  const {state,input}=fixture()
  const evidenceSummary={candidateTable:{rows:[
    {candidateId:"candidate-spam3",stage:"boltz",modelId:"boltz2",metrics:{confidence_score:{seedMean:0.86404282,rank:2}}},
    {candidateId:"candidate-reversal",stage:"boltz",modelId:"boltz2",metrics:{confidence_score:{seedMean:0.92697302,rank:1}}},
  ],contrasts:[{stage:"boltz",modelId:"boltz2",metric:"confidence_score",leftCandidateId:"candidate-reversal",
    rightCandidateId:"candidate-spam3",seedMeanDifference:0.0629302,pairedCount:2,pairedMeanDifference:0.0629302}]}}
  const measuredClaims=[
    {kind:"candidate_metric" as const,candidateId:"candidate-reversal",stage:"boltz",modelId:"boltz2",
      metric:"confidence_score",seedMean:0.92697302,rank:1},
    {kind:"candidate_contrast" as const,stage:"boltz",modelId:"boltz2",metric:"confidence_score",
      leftCandidateId:"candidate-reversal",rightCandidateId:"candidate-spam3",seedMeanDifference:0.0629302,
      pairedCount:2,pairedMeanDifference:0.0629302},
  ]
  const review=ScientistReview.commit(state,"exp_one",{...input,measuredClaims},evidenceSummary,"2026-01-02")
  expect(review.measuredClaims).toEqual(measuredClaims)
  const second=fixture()
  expect(()=>ScientistReview.commit(second.state,"exp_one",{...second.input,measuredClaims:[{kind:"candidate_metric",
    candidateId:"candidate-spam3",stage:"boltz",modelId:"boltz2",metric:"confidence_score",
    seedMean:0.9028,rank:1}]},evidenceSummary,"2026-01-02")).toThrow("expected {\"seedMean\":0.86404282,\"rank\":2}")
  const third=fixture()
  expect(()=>ScientistReview.commit(third.state,"exp_one",{...third.input,measuredClaims:[{kind:"candidate_contrast",
    stage:"boltz",modelId:"boltz2",metric:"confidence_score",leftCandidateId:"candidate-spam3",
    rightCandidateId:"candidate-reversal",seedMeanDifference:0.0629302,pairedCount:2,
    pairedMeanDifference:0.0629302}]},evidenceSummary,"2026-01-02")).toThrow("unknown directed identity candidate-spam3-candidate-reversal")
})

test("stale branch conflict returns authoritative state and corrected review retry is idempotent",()=>{
  const {state,branch,input}=fixture()
  ExperimentBranches.update(state,"exp_one",{...input.branchUpdates[0],expectedRevision:0,status:"open"},"2026-01-02")
  let conflict: unknown
  try { ScientistReview.commit(state,"exp_one",input,{},"2026-01-03") } catch (error) { conflict=error }
  expect(conflict).toBeInstanceOf(ScientistReview.BranchRevisionConflictError)
  expect((conflict as ScientistReview.BranchRevisionConflictError).conflict).toEqual({
    runId:"run_one",branchId:branch.id,expectedRevision:0,actualRevision:1,actualStatus:"open",
  })
  expect(Object.keys(state.scientistReviews)).toHaveLength(0)
  expect(branch).toMatchObject({revision:1,status:"open"})
  const corrected={...input,branchUpdates:[{...input.branchUpdates[0],expectedRevision:1}]}
  const committed=ScientistReview.commit(state,"exp_one",corrected,{},"2026-01-04")
  const retried=ScientistReview.commit(state,"exp_one",JSON.parse(JSON.stringify(corrected)),{},"2026-01-05")
  expect(retried.id).toBe(committed.id)
  expect(branch).toMatchObject({revision:2,status:"deferred"})
  expect(Object.keys(state.scientistReviews)).toHaveLength(1)
})


test("adding optional measured receipts preserves historical review retry identity", () => {
  const { state, input, branch } = fixture()
  const oldInput = ScientistReview.Input.omit({ measuredClaims: true, measurementRefs: true }).parse(input)
  const expectedId = "srv_" + new Bun.CryptoHasher("sha256").update(JSON.stringify(["exp_one", oldInput])).digest("hex")
  const first = ScientistReview.commit(state, "exp_one", input, {}, "2026-01-02")
  expect(first.id).toBe(expectedId)
  expect(ScientistReview.commit(state, "exp_one", { ...input, measuredClaims: [] }, {}, "2026-01-03").id).toBe(expectedId)
  expect(branch.revision).toBe(1)
})


test("measurement references resolve exact values, preserve retry identity and reject other evidence atomically", () => {
  const {state,input,branch}=fixture()
  const summary=EvidenceView.summary([{candidateId:"pep_one",stage:"chai1-no-esm-diagnostic-rank",
    modelId:"chai1",seed:42,status:"completed",metrics:{confidence_score:0.1227390319108963}}])
  const citation=summary.measurementCatalog.find(item => item.claim.kind === "candidate_metric")!
  const record=ScientistReview.commit(state,"exp_one",{...input,measurementRefs:[citation.id]},summary,"now")
  expect(record.measuredClaims).toEqual([citation.claim])
  expect(ScientistReview.commit(state,"exp_one",{...input,measurementRefs:[citation.id]},summary,"later").id).toBe(record.id)
  expect(ScientistReview.commit(state,"exp_one",{...input,measuredClaims:[citation.claim]},summary,"later").id).toBe(record.id)
  expect(branch.revision).toBe(1)
  const other=fixture()
  const changed=EvidenceView.summary([{candidateId:"pep_one",stage:"chai1-no-esm-diagnostic-rank",
    modelId:"chai1",seed:42,status:"completed",metrics:{confidence_score:0.8}}])
  expect(()=>ScientistReview.commit(other.state,"exp_one",{...other.input,measurementRefs:[citation.id]},changed,"now")).toThrow("Unknown measurement references for run_one")
  expect(other.branch.revision).toBe(0)
  expect(Object.keys(other.state.scientistReviews)).toHaveLength(0)
})

test("all numerical mismatches are returned in one repair with no partial branch effects", () => {
  const {state,input,branch}=fixture()
  const summary=EvidenceView.summary([{candidateId:"pep_one",stage:"chai1-score",modelId:"chai1",seed:42,
    status:"completed",metrics:{confidence_score:0.8763996660709381}}])
  let message=""
  try {ScientistReview.commit(state,"exp_one",{...input,measuredClaims:[
    {kind:"candidate_metric",candidateId:"pep_one",stage:"chai1-score",modelId:"chai1",metric:"confidence_score",seedMean:0.8764,rank:1},
    {kind:"candidate_metric",candidateId:"pep_one",stage:"wrong-stage",modelId:"chai1",metric:"confidence_score",seedMean:0.12,rank:1},
  ]},summary,"now")} catch(error) {message=(error as Error).message}
  expect(message).toContain("0.8763996660709381")
  expect(message).toContain("unknown identity pep_one/wrong-stage")
  expect(branch.revision).toBe(0)
  expect(Object.keys(state.scientistReviews)).toHaveLength(0)
})


test('decision cards preserve latest scoped review and bounded interpretations without copying numerical tables',()=>{
 const {state,input}=fixture()
 const first=ScientistReview.commit(state,'exp_one',{...input,branchUpdates:[]},{candidateTable:{rows:[],contrasts:[]}},'2026-01-02')
 const revised=ScientistReview.commit(state,'exp_one',{...input,expectedRevision:1,interpretation:'Corrected interpretation',branchUpdates:[]},{},'2026-01-03')
 const projection=ScientistReview.project([first,revised,{...revised,id:'srv_other',experimentId:'exp_two'},{...revised,id:'srv_foreign',campaignId:'cmp_other'}],
  {campaignId:'cmp_one',experimentId:'exp_one',runIds:new Set(['run_one'])})
 expect(projection.items).toHaveLength(1);expect(projection.items[0]).toMatchObject({id:revised.id,revision:2,interpretation:'Corrected interpretation',epistemicStatus:'scientist_interpretation'})
 expect(JSON.stringify(projection)).not.toContain('candidateTable')
 expect(ScientistReview.project([revised],{campaignId:'cmp_one',runIds:new Set(['run_missing'])}).items).toEqual([])
 const many=Array.from({length:6},(_,i)=>({...revised,id:'srv_'+i,runId:'run_'+i,interpretation:'x'.repeat(2000),limitations:['y'.repeat(2000)],createdAt:'2026-02-0'+(i+1)}))
 const bounded=ScientistReview.project(many,{campaignId:'cmp_one',runIds:new Set(many.map(r=>r.runId))})
 expect(bounded).toMatchObject({total:6,truncated:true});expect(bounded.items).toHaveLength(4)
 expect(bounded.items[0]).toMatchObject({runId:'run_5',proseTruncated:true});expect(JSON.stringify(bounded).length).toBeLessThan(6000)
})
