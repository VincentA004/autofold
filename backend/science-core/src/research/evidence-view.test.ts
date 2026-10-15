import { expect, test } from "bun:test"
import { EvidenceView } from "./evidence-view"

const decisions = Array.from({ length: 36 }, (_, i) => ({
  candidateId: `c${i % 6}`, stage: ["diagnostic", "boltz", "chai"][Math.floor(i / 12)],
  modelId: ["protenix", "boltz", "chai"][Math.floor(i / 12)], seed: i % 12 < 6 ? 1 : 2,
  status: "completed" as const, metrics: { confidence: i / 36 },
}))
test("36 decision pipeline retains paired analysis and bounded display", () => {
  const result = { iteration: 1, status: "succeeded", modelEvidence: decisions }
  expect(result.modelEvidence).toHaveLength(36)
  const view = EvidenceView.sample(result.modelEvidence!, 16, EvidenceView.path("run_complete"))
  expect(view.items).toHaveLength(16)
  expect(view.omitted).toBe(20)
  expect(view.coverage.groups).toHaveLength(6)
  expect(new Set(view.items.map(x => `${x.stage}:${x.seed}`)).size).toBe(6)
  const paired = EvidenceView.paired(result.modelEvidence!)
  expect(paired.rows).toHaveLength(12)
  expect(paired.rows.every(r => Object.values(r.cells).every(v => v !== null))).toBe(true)
  expect(paired.coverage.duplicateDecisions).toEqual([])
  expect(EvidenceView.paired(decisions.slice(1)).rows[5]?.cells).toBeDefined()
  expect(() => EvidenceView.paired([...decisions, decisions[0]])).toThrow("Duplicate")
})
test("missing and skipped evidence is never converted to zero confidence", () => {
  const result = EvidenceView.paired([{ ...decisions[0], status: "skipped" }, decisions[13]])
  expect(result.rows[0].cells[JSON.stringify(["diagnostic", "protenix"])]).toMatchObject({ status: "skipped" })
  expect(result.rows[0].cells[JSON.stringify(["boltz", "boltz"])]).toBeNull()
  expect(EvidenceView.sample([], 24, "path")).toMatchObject({ items: [], shown: 0, omitted: 0 })
})



test("paired receipt includes both seeds, missing metrics and signed prospective threshold", () => {
  const items = [1,2].flatMap(seed => [0,1,2,3,4,5].flatMap(i => [
    {candidateId:`c${i}`,seed,stage:"baseline",modelId:"chai",status:"completed" as const,metrics:{confidence_score:0.6}},
    {candidateId:`c${i}`,seed,stage:"diagnostic",modelId:"chai",status:"completed" as const,metrics:{confidence_score:seed===1?0.59:0.55}},
  ]))
  const summary = EvidenceView.summary(items)
  expect(summary.pairedRows).toBe(12)
  expect(summary.comparisons[0].metrics.confidence_score).toMatchObject({count:12,missingPairs:0,expectedPairs:12})
  expect(summary.comparisons[0].metrics.confidence_score.mean).toBeCloseTo(-0.03)
  expect(summary.comparisons[0].metrics.confidence_score.bySeed).toHaveLength(2)
  const predicate = {modelId:"chai",leftStage:"baseline",rightStage:"diagnostic",metric:"confidence_score",relation:"greater" as const,threshold:0.05}
  expect(EvidenceView.assessMeasurement(predicate,items).status).toBe("not_supported_for_tested_predicate")
  expect(EvidenceView.assessMeasurement({...predicate,leftStage:"diagnostic",rightStage:"baseline",threshold:0.02},items).status).toBe("supported_for_tested_predicate")
  expect(EvidenceView.assessMeasurement(predicate,items.slice(1)).status).toBe("unresolved")
  const history = EvidenceView.historicalExtrema([{runId:"run_prior",modelEvidence:[{...items[0],metrics:{confidence_score:0.89}}]}, {runId:"run_now",modelEvidence:items}])
  expect(history.extrema.find(x=>x.stage==="baseline")?.maximumRunId).toBe("run_prior")
  expect(history.extrema.find(x=>x.stage==="baseline")?.maximum).toBe(0.89)
  expect(EvidenceView.summary([{...items[0],modelId:"other"},items[1]]).comparisons).toEqual([])
})

test("rank summary computes cross-model Spearman from complete candidate seed means", () => {
  const left = [1, 2, 3, 4, 5, 6]
  const right = [3, 1, 6, 4, 2, 5]
  const items = [11, 22].flatMap((seed, seedIndex) => left.flatMap((value, candidate) => [
    { candidateId:`c${candidate}`, seed, stage:"chai-score", modelId:"chai", status:"completed" as const,
      metrics:{confidence_score:value + (seedIndex ? 0.1 : -0.1)} },
    { candidateId:`c${candidate}`, seed, stage:"boltz-score", modelId:"boltz", status:"completed" as const,
      metrics:{confidence_score:right[candidate]! + (seedIndex ? 0.2 : -0.2)} },
  ]))
  const comparison = EvidenceView.summary(items).rankComparisons.find(item =>
    item.leftStage === "chai-score" && item.rightStage === "boltz-score")!
  expect(comparison.aggregation).toBe("arithmetic mean of complete seed values per candidate")
  expect(comparison.metrics.confidence_score).toMatchObject({
    spearman: 0.3142857142857143,
    reason: null,
    expectedCandidates: 6,
    pairedCandidates: 6,
    missingCandidates: 0,
    expectedLeftSeeds: [11, 22],
    expectedRightSeeds: [11, 22],
    leftSeedValues: 12,
    rightSeedValues: 12,
    leftTiedCandidates: 0,
    rightTiedCandidates: 0,
  })
})

test("rank summary uses average ranks for ties and rejects incomplete or constant inputs", () => {
  const tied = [1, 1, 2, 3].flatMap((value, candidate) => [
    { candidateId:`c${candidate}`, seed:1, stage:"left", modelId:"a", status:"completed" as const, metrics:{score:value} },
    { candidateId:`c${candidate}`, seed:1, stage:"right", modelId:"b", status:"completed" as const, metrics:{score:candidate + 1} },
  ])
  const tiedMetric = EvidenceView.summary(tied).rankComparisons[0]!.metrics.score
  expect(tiedMetric.spearman).toBeCloseTo(0.9486832980505138)
  expect(tiedMetric).toMatchObject({reason:null,leftTiedCandidates:2,rightTiedCandidates:0,pairedCandidates:4})

  const constant = tied.map(item => item.stage === "left" ? {...item,metrics:{score:1}} : item)
  expect(EvidenceView.summary(constant).rankComparisons[0]!.metrics.score).toMatchObject({
    spearman:null,reason:"constant_rank",pairedCandidates:4,leftTiedCandidates:4,
  })

  const incomplete = tied.filter(item => item.stage === "left" || item.candidateId === "c0")
  expect(EvidenceView.summary(incomplete).rankComparisons[0]!.metrics.score).toMatchObject({
    spearman:null,reason:"insufficient_candidates",expectedCandidates:4,pairedCandidates:1,missingCandidates:3,
  })
})

test("candidate table joins names, sequences, seeds, means, ranks and contrasts independent of input order", () => {
  const candidates = [
    { id:"pep_positive", sequence:"ACDEFGHIK" },
    { id:"pep_control", sequence:"KIHGFEDCA" },
  ]
  const items = [
    {candidateId:"pep_control",seed:22,stage:"boltz",modelId:"boltz2",status:"completed" as const,
      metrics:{primary_metric:"confidence_score",confidence_score:0.9}},
    {candidateId:"pep_positive",seed:11,stage:"boltz",modelId:"boltz2",status:"completed" as const,
      metrics:{primary_metric:"confidence_score",confidence_score:0.8}},
    {candidateId:"pep_control",seed:11,stage:"boltz",modelId:"boltz2",status:"completed" as const,
      metrics:{primary_metric:"confidence_score",confidence_score:0.7}},
    {candidateId:"pep_positive",seed:22,stage:"boltz",modelId:"boltz2",status:"completed" as const,
      metrics:{primary_metric:"confidence_score",confidence_score:0.6}},
  ]
  const expected = EvidenceView.candidateTable(items, candidates)
  expect(EvidenceView.candidateTable([...items].reverse(), [...candidates].reverse())).toEqual(expected)
  expect(expected.rows).toEqual([
    {candidateId:"pep_control",sequence:"KIHGFEDCA",stage:"boltz",modelId:"boltz2",metrics:{
      confidence_score:{values:[{seed:11,value:0.7},{seed:22,value:0.9}],seedMean:0.8,rank:1},
    }},
    {candidateId:"pep_positive",sequence:"ACDEFGHIK",stage:"boltz",modelId:"boltz2",metrics:{
      confidence_score:{values:[{seed:11,value:0.8},{seed:22,value:0.6}],seedMean:0.7,rank:2},
    }},
  ])
  expect(expected.contrasts).toEqual([{
    stage:"boltz",modelId:"boltz2",metric:"confidence_score",
    leftCandidateId:"pep_control",rightCandidateId:"pep_positive",seedMeanDifference:0.10000000000000009,
    pairedCount:2,pairedMeanDifference:0.09999999999999998,
    bySeed:[{seed:11,difference:-0.10000000000000009},{seed:22,difference:0.30000000000000004}],
  }])
})

test("candidate contrasts distinguish independent means from matching-seed pairs", () => {
  const table = EvidenceView.candidateTable([
    {candidateId:"a",seed:1,stage:"score",modelId:"m",status:"completed",metrics:{score:0.9}},
    {candidateId:"a",seed:2,stage:"score",modelId:"m",status:"completed",metrics:{score:0.5}},
    {candidateId:"b",seed:2,stage:"score",modelId:"m",status:"completed",metrics:{score:0.4}},
    {candidateId:"b",seed:3,stage:"score",modelId:"m",status:"completed",metrics:{score:0.2}},
  ])
  expect(table.contrasts[0]).toMatchObject({ pairedCount:1 })
  expect(table.contrasts[0]!.seedMeanDifference).toBeCloseTo(0.4)
  expect(table.contrasts[0]!.pairedMeanDifference).toBeCloseTo(0.1)
  expect(table.contrasts[0]!.bySeed[0]!.difference).toBeCloseTo(0.1)
  expect(table.ranking).toContain("among shown candidates")
  expect(table.contrast).toContain("independently available")
})


test("rank inversion in a compressed band cannot be answered by the supported level predicate", () => {
  const items = [1,2].flatMap(seed => [0,1,2,3,4,5].flatMap(i => [
    {candidateId:`c${i}`,seed,stage:"left",modelId:"chai",status:"completed" as const,metrics:{confidence:0.6+i/100}},
    {candidateId:`c${i}`,seed,stage:"right",modelId:"chai",status:"completed" as const,metrics:{confidence:0.13-i/10000}},
  ]))
  const predicate = {modelId:"chai",leftStage:"left",rightStage:"right",metric:"confidence",relation:"less" as const,threshold:0.05}
  expect(EvidenceView.assessMeasurement(predicate,items)).toMatchObject({statistic:"mean_difference",status:"supported_for_tested_predicate"})
  expect(EvidenceView.assessMeasurement({...predicate,statistic:"spearman",relation:"greater",threshold:0.8},items))
    .toMatchObject({statistic:"spearman",value:-1,status:"not_supported_for_tested_predicate",pairedCandidates:6})
  const missingSeed = items.filter(x => !(x.stage === "right" && x.seed === 2))
  expect(EvidenceView.assessMeasurement({...predicate,statistic:"spearman"},missingSeed).status).toBe("unresolved")
  const constant = items.map(x => x.stage === "right" ? {...x,metrics:{confidence:0.13}} : x)
  expect(EvidenceView.assessMeasurement({...predicate,statistic:"spearman"},constant).status).toBe("unresolved")
  const preserved = items.map(x => x.stage === "right" ? {...x,metrics:{confidence:0.12+Number(x.candidateId.slice(1))/10000}} : x)
  expect(EvidenceView.assessMeasurement({...predicate,statistic:"spearman",relation:"greater",threshold:0.8},preserved))
    .toMatchObject({value:1,status:"supported_for_tested_predicate"})
})


test("candidate decision view retains frozen objective inputs separately from model confidence", () => {
  const table=EvidenceView.candidateTable([decisions[0]],[{id:decisions[0].candidateId,sequence:"AAAK",evidence:{
    interfaceConfidence:0.8,foldConfidence:0.9,predictorAgreement:0.4,solubility:0.7,aggregationRisk:0.2,synthesisRisk:0,
    arbitraryScore:999}}])
  expect(table.scoringInputs[0]).toEqual({candidateId:decisions[0].candidateId,sequence:"AAAK",evidence:{
    interfaceConfidence:0.8,foldConfidence:0.9,predictorAgreement:0.4,solubility:0.7,aggregationRisk:0.2,synthesisRisk:0}})
  expect(EvidenceView.candidateTable([decisions[0]]).scoringInputs).toEqual([])
})
