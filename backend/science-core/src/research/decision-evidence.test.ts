import { expect, test } from "bun:test"
import { ResearchDomain } from "./domain"
import { DecisionEvidence } from "./decision-evidence"
const hash = (x: string) => `sha256:${x.repeat(64)}`
function observation(id: string, family: string, extra = {}) {
  return ResearchDomain.SearchObservation.parse({
    id: `sobs_${id}`, campaignId: "cmp_test", experimentId: "exp_test", trialId: `trl_${id}`, runId: `run_${id}`,
    knowledgeId: `knw_${id}`, knowledgeCycleId: `kcy_${id}`, intent: "optimize", programHash: hash("a"),
    configurationFamilyFingerprint: hash(family), realizedCandidateSetHash: hash("b"),
    generatorPortfolio: ["pxdesign-binder"], candidateSequences: [], modelIds: [], seeds: [1],
    epistemicLevel: "computational_support", score: 0.2, decision: "rejected", diagnostics: {}, hypothesis: "An observation", createdAt: "2026-09-06T00:00:00Z", ...extra,
  })
}
test("identifies repeated outputs across changed configurations without inventing independent samples", () => {
  const a = observation("a", "c", { generationWallSeconds: 200 })
  const result = DecisionEvidence.summarize([a, a, observation("b", "d", { generationWallSeconds: 400 }),
    observation("control", "c", { intent: "negative_control" }), observation("other", "c", { experimentId: "exp_other" })], "exp_test")
  expect(result.repeatedOutputs).toHaveLength(1)
  expect(result.repeatedOutputs[0]).toMatchObject({ runIds: ["run_a", "run_b"], generationWallSeconds: [200, 400], configurationFamilies: [hash("c"), hash("d")] })
  expect(result.families).toHaveLength(2)
  expect(result.families[0]).toMatchObject({ attempts: 1, distinctObservedCandidateSets: 1, inferenceScope: "single_scored_observation" })
})
test("keeps unknown candidate identity and timing unknown", () => {
  const result = DecisionEvidence.summarize([observation("a", "c", { realizedCandidateSetHash: undefined })], "exp_test")
  expect(result.repeatedOutputs).toEqual([])
  expect(result.families[0]).toMatchObject({ unknownCandidateSets: 1, distinctObservedCandidateSets: 0, generationWallSeconds: null })
})

test("feeds the prospective plan back with the observed predicate without claiming information gain", () => {
  const decisionPlan = {
    question: "Is the improvement repeatable?",
    alternatives: [
      { id: "A", experiment: "Replicate", expectedInformation: "Variability", estimatedGpuHours: 1 },
      { id: "B", experiment: "Explore", expectedInformation: "Alternative family", estimatedGpuHours: 1 },
    ], selectedAlternativeId: "A", rationale: "Resolve uncertainty first", evidenceRefs: ["run_baseline"],
    outcomeBranches: [{ observation: "Improves", nextDecision: "Compare another family" }, { observation: "Worsens", nextDecision: "Reconsider allocation" }],
  }
  const result = DecisionEvidence.summarize([
    observation("baseline", "c", { score: 0.3 }),
    observation("result", "c", { score: 0.2, decisionPlan, prediction: { comparatorTrialId: "trl_baseline", metric: "locked_score", relation: "lower", minimumDifference: 0 } }),
  ], "exp_test")
  expect(result.priorDecisions).toHaveLength(1)
  expect(result.priorDecisions[0]).toMatchObject({ plan: decisionPlan, observed: { scorePredicate: "supported", generationWallSeconds: null } })
  expect(result.priorDecisions[0]).not.toHaveProperty("informationGain")
})

test("comparison audit preserves confounds and separates score support from promotion", () => {
  const baseline = observation("baseline", "c", { score: 0.3, configurationFamilyFingerprint: undefined,
    generatorPortfolio: ["pxdesign-binder", "boltzgen-binder"] })
  const result = observation("result", "d", { score: 0.2, prediction: {
    comparatorTrialId: "trl_baseline", metric: "locked_score", relation: "lower", minimumDifference: 0 } })
  const evidence = DecisionEvidence.summarize([baseline, baseline, result], "exp_test")
  expect(evidence.coverage).toMatchObject({ uniqueOptimizeRuns: 2, unknownFamilyRunIds: ["run_baseline"], portfolioRunIds: ["run_baseline"] })
  expect(evidence.comparisonAudit[0]).toMatchObject({ comparatorResolution: "unique", sameKnownFamily: null,
    portfolioInvolved: true, predicate: { status: "supported" }, globalDecision: "rejected" })
  const ambiguous = DecisionEvidence.summarize([baseline, { ...baseline, runId: "run_repeat" }, result], "exp_test")
  expect(ambiguous.comparisonAudit[0]).toMatchObject({ comparatorResolution: "ambiguous", predicate: { status: "unresolved" } })
})

test("structured comparison treats workflow fingerprint changes as design provenance, not a frozen-condition confound", () => {
  const conditions={contractHash:hash("a"),targetArtifactHash:hash("b"),evaluationSeeds:[7,11],scoringPipelineHash:hash("c")}
  const left={status:"verified" as const,conditions,workflowFingerprint:hash("d"),admittedDesign:{projection:[{lane:0,programSeed:17,stages:[{config:{alphabet:"ACDE"},generators:[{key:"generator-a"}],constraints:[{id:"length"}]}]}]}}
  const right={...left,workflowFingerprint:hash("e"),admittedDesign:{projection:[{lane:0,programSeed:18,stages:[{config:{alphabet:"ACFG"},generators:[{key:"generator-b"}],constraints:[{id:"charge"}]}]}]}}
  const compared=DecisionEvidence.compareVerifiedProvenance(left,right)
  expect(compared.conditionChanges).toEqual([])
  expect(compared.designChanges?.map(change=>change.path)).toEqual(expect.arrayContaining([
    "projection[0].programSeed","projection[0].stages[0].config.alphabet","projection[0].stages[0].generators[0].key","projection[0].stages[0].constraints[0].id",
  ]))
  const structural=DecisionEvidence.compareVerifiedProvenance({...left,admittedDesign:{projection:[{stages:[]}]}},
    {...right,admittedDesign:{projection:[{stages:[{config:{alphabet:"ACDE",temperature:0.2},generators:[{key:"generator-a"}],constraints:[{id:"length"}]}]}]}})
  expect(structural.designChanges?.map(change=>change.path)).toEqual(expect.arrayContaining([
    "projection[0].stages#length","projection[0].stages[0].config.temperature","projection[0].stages[0].generators#length","projection[0].stages[0].generators[0].key","projection[0].stages[0].constraints#length",
  ]))
  const changedConditions=DecisionEvidence.compareVerifiedProvenance(left,{...right,conditions:{...conditions,evaluationSeeds:[7,13],targetArtifactHash:hash("f"),scoringPipelineHash:hash("e")}})
  expect(changedConditions.conditionChanges?.map(change=>change.path)).toEqual(expect.arrayContaining([
    "evaluationSeeds[1]","targetArtifactHash","scoringPipelineHash",
  ]))
  const changedSources=DecisionEvidence.compareVerifiedProvenance(left,{...right,conditions:{...conditions,evaluator:{id:"panel",version:"2",sourceHash:hash("f"),direction:"minimize"}}})
  expect(changedSources.conditionChanges?.map(change=>change.path)).toEqual(expect.arrayContaining(["evaluator.version","evaluator.sourceHash"]))
  expect(DecisionEvidence.compareVerifiedProvenance({...left,status:"unknown"},right)).toMatchObject({status:"unknown",conditionChanges:null,designChanges:null})
  expect(DecisionEvidence.compareVerifiedProvenance(left,{...right,unknownFields:["evaluator.sourceHash"]})).toMatchObject({status:"partial",unknown:["comparator.evaluator.sourceHash"]})
})


test("keeps old controls and scientific outcomes distinct from an easy comparator win", () => {
  const plan = {question:"Does ordering survive?", alternatives:[
    {id:"A",experiment:"Matched panel",expectedInformation:"Ordering",estimatedGpuHours:1},
    {id:"B",experiment:"Analyze saved rows",expectedInformation:"Existing ordering",estimatedGpuHours:0}],
    selectedAlternativeId:"A",rationale:"Prospective comparison",evidenceRefs:["run_baseline"],
    outcomeBranches:[{observation:"Ordering survives",nextDecision:"Use it"},{observation:"Reorders",nextDecision:"Reconsider selection"}],
    measurement:{modelId:"chai",leftStage:"left",rightStage:"right",metric:"confidence",statistic:"spearman",relation:"greater",threshold:0.8}}
  const baseline=observation("baseline","c",{score:0.3,decision:"promoted"})
  const control=observation("control","c",{intent:"calibrate",decision:"observed",score:0.05,decisionPlan:plan})
  const result=observation("result","c",{score:0.2,priorBestScore:0.1,scoreDeltaFromPriorBest:-0.1,decisionPlan:plan,
    prediction:{comparatorTrialId:"trl_baseline",metric:"locked_score",relation:"lower",minimumDifference:0}})
  const rows=[1,2].flatMap(seed => [0,1,2].flatMap(i => [
    {candidateId:`c${i}`,seed,stage:"left",modelId:"chai",status:"completed" as const,metrics:{confidence:0.6+i/100}},
    {candidateId:`c${i}`,seed,stage:"right",modelId:"chai",status:"completed" as const,metrics:{confidence:0.13-i/1000}}]))
  const evidence=DecisionEvidence.summarize([baseline,control,result],"exp_test",[{run:{id:"run_result",status:"succeeded"},modelEvidence:rows}])
  expect(evidence.nonOptimizationEvidence.map(o=>o.runId)).toEqual(["run_control"])
  expect(evidence.objectiveProgress.promotedRunIds).toEqual(["run_baseline"])
  expect(evidence.latestPromotionEvidence).toMatchObject({runId:"run_baseline",score:0.3,candidates:null})
  expect(evidence.coverage.uniqueOptimizeRuns).toBe(2)
  expect(evidence.priorDecisions.find(o=>o.runId==="run_result")).toMatchObject({
    measuredPrediction:{value:-1,status:"not_supported_for_tested_predicate"}, executionWallSeconds:null,
    observed:{scorePredicate:"supported",decision:"rejected",scoreDeltaFromPriorBest:-0.1}})
  expect(evidence.priorDecisions.find(o=>o.runId==="run_control")?.measuredPrediction.status).toBe("unresolved")
  const failed=DecisionEvidence.summarize([{...result,decision:"failed"}],"exp_test",[{run:{id:"run_result",status:"failed"},modelEvidence:rows}])
  expect(failed.priorDecisions[0].measuredPrediction.status).toBe("unresolved")
})


test("decision ledger orients paired levels as declared even when evidence order is reversed", () => {
  const decisionPlan={question:"Level",alternatives:[{id:"a",experiment:"One",expectedInformation:"Level",estimatedGpuHours:1},{id:"b",experiment:"Two",expectedInformation:"Other",estimatedGpuHours:1}],selectedAlternativeId:"a",rationale:"Test",evidenceRefs:[],outcomeBranches:[{observation:"Drop",nextDecision:"Revise"},{observation:"No drop",nextDecision:"Retain"}],measurement:{modelId:"chai",leftStage:"left",rightStage:"right",metric:"confidence",relation:"less",threshold:-0.05}}
  const rows=[{candidateId:"c",seed:1,stage:"right",modelId:"chai",status:"completed" as const,metrics:{confidence:0.1}},{candidateId:"c",seed:1,stage:"left",modelId:"chai",status:"completed" as const,metrics:{confidence:0.6}}]
  const ledger=DecisionEvidence.summarize([observation("one","c",{decisionPlan})],"exp_test",[{run:{id:"run_one",status:"succeeded"},modelEvidence:rows}])
  expect(ledger.priorDecisions[0].pairedEvidence?.level[0]).toMatchObject({leftStage:"left",rightStage:"right",mean:-0.5})
  expect(ledger.objectiveProgress.sinceLastPromotion.scoredRunIds).toBeNull()
  expect(ledger.priorDecisions[0].measuredPrediction).toMatchObject({value:-0.5,status:"supported_for_tested_predicate"})
})


test("opening card keeps earlier predictions out of measured results without losing their evidence", () => {
  const o=observation("control","c",{intent:"calibrate",decision:"observed",hypothesis:"Unverified control validates binding"})
  const ledger=DecisionEvidence.summarize([o],"exp_test")
  expect(ledger.nonOptimizationEvidence[0].hypothesis).toBe(o.hypothesis)
  const card=DecisionEvidence.card(ledger)
  expect(card.existingControls[0]).not.toHaveProperty("hypothesis")
  expect(card.existingControls[0]).toMatchObject({runId:o.runId,evidenceStatus:"model_evidence_unavailable"})
})


test("rejected panels can retain a better individual signal without overriding panel promotion", () => {
  const baseline=observation("baseline","c",{decision:"promoted",score:0.14,diagnostics:{best_candidate_loss:0.139,mean_candidate_loss:0.16}})
  const near=observation("near","d",{score:0.153,diagnostics:{best_candidate_loss:0.133,mean_candidate_loss:0.166}})
  const worse=observation("worse","d",{score:0.18,diagnostics:{best_candidate_loss:0.19}})
  const control=observation("control","c",{intent:"calibrate",decision:"observed",score:0.1,diagnostics:{best_candidate_loss:0.1}})
  const ledger=DecisionEvidence.summarize([baseline,near,worse,control],"exp_test")
  expect(DecisionEvidence.card(ledger).candidateOpportunities).toHaveLength(1)
  expect(ledger.candidateOpportunities[0]).toMatchObject({runId:"run_near",panelDecision:"rejected",bestCandidateLoss:0.133,referenceBestCandidateLoss:0.139})
  expect(ledger.objectiveProgress.promotedRunIds).toEqual(["run_baseline"])
  expect(DecisionEvidence.summarize([near],"exp_test").candidateOpportunities).toEqual([])
})


test("candidate archive includes rejected learning without treating control panels as optimization", () => {
  const archive=DecisionEvidence.archive([observation("won","c",{decision:"promoted"}),observation("lost","d"),
    observation("control","d",{intent:"calibrate",decision:"observed"})],"exp_test")
  expect(archive.runs.map(o=>o.runId)).toEqual(["run_won","run_lost"])
  expect(archive.runs[1]).toMatchObject({decision:"rejected",candidates:null})
})


test("opening card keeps candidate objective inputs without embedding every native metric", () => {
  const baseline=observation("baseline","c",{decision:"promoted",diagnostics:{best_candidate_loss:0.15}})
  const rejected=observation("rejected","c",{diagnostics:{best_candidate_loss:0.12}})
  const control=observation("control","c",{intent:"calibrate",decision:"observed"})
  const candidates=[{id:"candidate_a",sequence:"ACDEFG",evidence:{interfaceConfidence:0.8,foldConfidence:0.7,predictorAgreement:0.6,solubility:0.9,aggregationRisk:0.1,synthesisRisk:0.2}}]
  const rows=Array.from({length:12},(_,i)=>({candidateId:"candidate_a",seed:i%2,stage:`stage_${i}`,modelId:`model_${i}`,status:"completed" as const,
    metrics:Object.fromEntries(Array.from({length:40},(_,j)=>[`native_metric_${j}`,j/40]))}))
  const ledger=DecisionEvidence.summarize([baseline,rejected,control],"exp_test",[baseline,rejected,control].map(o=>({run:{id:o.runId,status:"succeeded"},modelEvidence:rows,candidates})))
  const card=DecisionEvidence.card(ledger)
  expect(card.latestPromotionEvidence?.candidates?.scoringInputs).toHaveLength(1)
  expect(card.latestPromotionEvidence?.candidates?.scoringInputs).toEqual(ledger.latestPromotionEvidence?.candidates?.scoringInputs)
  expect(card.candidateOpportunities[0].candidates?.scoringInputs).toEqual(ledger.candidateOpportunities[0].candidates?.scoringInputs)
  expect(card.existingControls[0].candidateEvidence?.scoringInputs).toEqual(ledger.nonOptimizationEvidence[0].candidateEvidence?.scoringInputs)
  expect(card.candidateOpportunities[0].evidencePath).toBe(ledger.candidateOpportunities[0].evidencePath)
  expect(JSON.stringify(card)).not.toContain("native_metric_0")
  expect(JSON.stringify(ledger)).toContain("native_metric_0")
  expect(JSON.stringify(card).length).toBeLessThan(12000)
})
