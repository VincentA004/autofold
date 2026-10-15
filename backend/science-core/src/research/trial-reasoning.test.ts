import { expect, test } from "bun:test"
import { TrialReasoning } from "./trial-reasoning"

test("family-baseline improvement is supported independently of global promotion", () => {
  const prediction = TrialReasoning.Prediction.parse({ comparatorTrialId: "trl_family", metric: "locked_score", relation: "lower" })
  expect(TrialReasoning.assess(prediction, 0.2363, { valid: true, score: 0.2991 }, true).status).toBe("supported")
  expect(TrialReasoning.assess(prediction, 0.31, { valid: true, score: 0.2991 }, true).status).toBe("refuted")
})
test("free-form hypotheses and missing or invalid comparisons remain unresolved", () => {
  const prediction = TrialReasoning.Prediction.parse({ comparatorTrialId: "trl_family", metric: "locked_score", relation: "lower" })
  expect(TrialReasoning.assess(undefined, 0.1, { valid: true, score: 0.3 }, true).status).toBe("unresolved")
  expect(TrialReasoning.assess(prediction, 0.1, undefined, true).status).toBe("unresolved")
  expect(TrialReasoning.assess(prediction, 0.1, { valid: false, score: 0.3 }, true).status).toBe("unresolved")
  expect(TrialReasoning.assess(prediction, 0.1, { valid: true, score: 0.3 }, false).status).toBe("unresolved")
})
test("declared difference and direction are respected", () => {
  const prediction = TrialReasoning.Prediction.parse({ comparatorTrialId: "trl_family", metric: "locked_score", relation: "higher", minimumDifference: 0.1 })
  expect(TrialReasoning.assess(prediction, 0.5, { valid: true, score: 0.3 }, true).status).toBe("supported")
  expect(TrialReasoning.assess(prediction, 0.31, { valid: true, score: 0.3 }, true).status).toBe("refuted")
})

const decision = {
  question: "Does replication change the allocation decision?",
  alternatives: [
    { id: "replicate", experiment: "Repeat cyclic", expectedInformation: "Estimate variability", estimatedGpuHours: 1 },
    { id: "explore", experiment: "Test linear", expectedInformation: "Test competing topology", estimatedGpuHours: 1.5 },
  ],
  selectedAlternativeId: "replicate", rationale: "Current minimum may be a lucky draw", evidenceRefs: ["run_prior"],
  outcomeBranches: [
    { observation: "Large variation", nextDecision: "Replicate competing topology before ranking" },
    { observation: "Stable result", nextDecision: "Test a new length" },
  ],
}
test("decision plans reject ambiguous selections and duplicate alternatives", () => {
  expect(TrialReasoning.DecisionPlan.safeParse({ ...decision, selectedAlternativeId: "missing" }).success).toBe(false)
  expect(TrialReasoning.DecisionPlan.safeParse({ ...decision, alternatives: [decision.alternatives[0], decision.alternatives[0]] }).success).toBe(false)
  expect(TrialReasoning.DecisionPlan.safeParse(decision).success).toBe(true)
})
test("fresh decisions require grounded evidence and a feasible selected estimate, while legacy records remain readable", () => {
  const plan = TrialReasoning.DecisionPlan.parse(decision)
  expect(() => TrialReasoning.validateDecisionPlan(plan, new Set(["run_prior"]), 2, true)).not.toThrow()
  expect(() => TrialReasoning.validateDecisionPlan(plan, new Set(["run_other"]), 2)).toThrow("resolve")
  expect(() => TrialReasoning.validateDecisionPlan(plan, new Set(["run_prior"]), 0.5)).toThrow("ceiling")
  expect(() => TrialReasoning.validateDecisionPlan(undefined, new Set(), 2, true)).toThrow("decision_plan")
  expect(() => TrialReasoning.validateDecisionPlan(undefined, new Set(), 2)).not.toThrow()
})

test("optional research requests survive parsing and require competing explanations", () => {
  const researchRequest = { question: "Does the source apply to this epitope?", competingExplanations: ["site mismatch", "predictor failure"],
    requiredEvidence: "Matched assay and controls", applicabilityChecks: "Target, epitope and peptide modality", decisionIfResolved: "Choose calibration or redesign" }
  expect(TrialReasoning.DecisionPlan.parse({ ...decision, researchRequest }).researchRequest).toEqual(researchRequest)
  expect(TrialReasoning.DecisionPlan.safeParse({ ...decision, researchRequest: { ...researchRequest, competingExplanations: ["one"] } }).success).toBe(false)
  expect(TrialReasoning.DecisionPlan.parse(decision).researchRequest).toBeUndefined()
})


test("identical realized candidate sets require an explicit replication purpose, not a family ban", () => {
  const prior = ["run_a", "run_b"].map(runId => ({runId,experimentId:"exp_a",configurationFamilyFingerprint:"family",
    workflowFingerprint:"workflow",realizedCandidateSetHash:"same"})) as any
  const proposal={configurationFamilyFingerprint:"family",workflowFingerprint:"workflow"}
  const repeated=TrialReasoning.repeatedCandidates([...prior,prior[0]],proposal,"exp_a")
  expect(repeated).toHaveLength(2)
  expect(()=>TrialReasoning.requireReplicationPurpose(undefined,repeated)).toThrow("replicationPurpose")
  expect(()=>TrialReasoning.requireReplicationPurpose({replicationPurpose:"Measure independent predictor variability"} as any,repeated)).not.toThrow()
  expect(TrialReasoning.repeatedCandidates(prior,{...proposal,workflowFingerprint:"new-diagnostic"},"exp_a")).toEqual([])
  expect(TrialReasoning.repeatedCandidates(prior,proposal,"exp_other")).toEqual([])
  expect(TrialReasoning.repeatedCandidates([prior[0],{...prior[1],realizedCandidateSetHash:"different"}],proposal,"exp_a")).toEqual([])
})


test("portfolio repetition is visible despite different source-family hashes, without calling them equivalent", () => {
  const prior=["a","b"].map((id,i)=>({runId:`run_${id}`,experimentId:"exp_a",configurationFamilyFingerprint:`family${i}`,
    workflowFingerprint:"workflow",generatorPortfolio:["px"],realizedCandidateSetHash:"same"})) as any
  const proposal={configurationFamilyFingerprint:"new-source",workflowFingerprint:"workflow",generatorPortfolio:["px"]}
  expect(TrialReasoning.repeatedCandidates(prior,proposal,"exp_a")).toEqual(prior.map((o:any)=>({runId:o.runId,candidateSetHash:"same",match:"portfolio_workflow"})))
  expect(TrialReasoning.repeatedCandidates(prior,{...proposal,generatorPortfolio:["different"]},"exp_a")).toEqual([])
  expect(TrialReasoning.repeatedCandidates([...prior,{...prior[0],runId:"run_variable",realizedCandidateSetHash:"different"}],proposal,"exp_a")).toEqual([])
})


test("prospective statistic is explicit without changing legacy mean predicates", () => {
  const legacy = {modelId:"chai",leftStage:"a",rightStage:"b",metric:"confidence",relation:"less" as const,threshold:0.05}
  expect(TrialReasoning.Measurement.parse(legacy)).toEqual(legacy)
  expect(TrialReasoning.Measurement.safeParse({...legacy,statistic:"spearman",threshold:1.1}).success).toBe(false)
  expect(TrialReasoning.Measurement.safeParse({...legacy,statistic:"spearman",threshold:-0.2}).success).toBe(true)
})


test("agent decision-plan errors identify the nested field without silently copying trial evidence", () => {
  const {evidenceRefs, ...incomplete} = decision
  try { TrialReasoning.parseDecisionPlan(incomplete); throw new Error("Expected schema error") }
  catch (error: any) {
    expect(error.issues[0].path).toEqual(["decision_plan", "evidenceRefs"])
    expect(error.issues[0].message).toContain("ProtoTrial.evidence_refs is a separate field")
  }
  expect(TrialReasoning.parseDecisionPlan(decision)).toEqual(TrialReasoning.DecisionPlan.parse(decision))
  expect(() => TrialReasoning.parseDecisionPlan({...decision, selectedAlternativeId: "unknown"})).toThrow("Selected alternative must exist")
})
