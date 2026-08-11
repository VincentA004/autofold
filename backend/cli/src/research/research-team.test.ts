import { describe, expect, test } from "bun:test"
import { ResearchTeam } from "./research-team"

describe("dynamic research-team contracts", () => {
  test("requires unique bounded specialist tasks", () => {
    expect(() =>
      ResearchTeam.Plan.parse({
        rationale: "Parallelize the two highest-value uncertainties.",
        tasks: [
          {
            id: "diagnose",
            role: "biology",
            capabilities: ["structural_biology"],
            objective: "Inspect interface failure modes.",
            questions: ["Which interface assumption is weakest?"],
            contextFocus: ["outcomes"],
          },
          {
            id: "diagnose",
            role: "ml",
            capabilities: ["model_diagnostics"],
            objective: "Inspect predictor disagreement.",
            questions: ["Which model is the persistent outlier?"],
            contextFocus: ["experiments"],
          },
        ],
      }),
    ).toThrow("Research-team task IDs must be unique")
  })

  test("allows only campaign provenance IDs in specialist findings", () => {
    const valid = ResearchTeam.Report.parse({
      summary: "The observed disagreement needs a controlled workflow change.",
      findings: [
        {
          statement: "The latest locked outcome reports predictor disagreement.",
          evidenceRefs: ["knw_one", "exp_one"],
          confidence: 0.8,
        },
      ],
      failureModes: ["A model-specific configuration may be the outlier."],
      recommendations: ["Change one routing decision and preserve the evaluator."],
      unresolvedQuestions: ["Does the disagreement reproduce?"],
    })
    expect(valid.findings[0]?.evidenceRefs).toEqual(["knw_one", "exp_one"])
    expect(() =>
      ResearchTeam.Report.parse({
        ...valid,
        findings: [{ statement: "Unsupported citation", evidenceRefs: ["paper:invented"], confidence: 1 }],
      }),
    ).toThrow()
  })

  test("normalizes a single planner context focus at the agent boundary", () => {
    const plan = ResearchTeam.Plan.parse({
      rationale: "Resolve the highest-value uncertainty.",
      tasks: [{
        id: "contact_map",
        role: "biology",
        capabilities: ["structural_biology"],
        objective: "Inspect the incumbent contact map.",
        questions: ["Which residue is the strongest contact?"],
        contextFocus: "claims",
      }],
    })
    expect(plan.tasks[0]?.contextFocus).toEqual(["claims"])
  })

  test("normalizes enriched specialist narratives and categorical confidence at the agent boundary", () => {
    const report = ResearchTeam.Report.parse({
      summary: "A bounded diagnostic.",
      findings: [{ statement: "Observed disagreement.", evidenceRefs: ["clm_known"], confidence: "high" }],
      failureModes: [{ description: "Single-seed uncertainty.", requiredFix: "Use three seeds." }],
      recommendations: [{ action: "Repeat the control.", detail: "Hold the evaluator fixed." }],
      unresolvedQuestions: [{ question: "Is the score stable?", proposedAction: "Measure variance." }],
    })

    expect(report.findings[0]?.confidence).toBe(0.85)
    expect(report.failureModes).toEqual(["Single-seed uncertainty. — Use three seeds."])
    expect(report.recommendations).toEqual(["Repeat the control. — Hold the evaluator fixed."])
    expect(report.unresolvedQuestions).toEqual(["Is the score stable? — Measure variance."])
  })
})
