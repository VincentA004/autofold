import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchTrajectoryCloseout } from "./trajectory-closeout"

describe("research trajectory closeout", () => {
  test("uses a trajectory-specific idempotency identity for failure notebook cycles", () => {
    expect(ResearchTrajectoryCloseout.failureCloseoutActor("run_one")).not.toBe(
      ResearchTrajectoryCloseout.failureCloseoutActor("run_two"),
    )
  })

  test("compacts oversized worker diagnostics without dropping core scientific instructions", () => {
    const core = "Preserve the frozen contract and propose one falsifying experiment."
    const question = ResearchTrajectoryCloseout.compactQuestion(core, `Worker failure: ${"progress ".repeat(1_000)}`)
    expect(question.length).toBe(2_000)
    expect(question.startsWith(core)).toBe(true)
    expect(question).toContain("Worker failure")
  })

  test("distinguishes placeholder warnings from a shared Proto allocation failure", () => {
    const evidence = ResearchTrajectoryCloseout.classifyTerminalEvidence(
      "Invalid characters X; valid: A C D. Every Proto portfolio lane failed: lane 0: IndexError: list index out of range",
    )
    expect(evidence).toContain("optimizer/allocation integration failure")
    expect(evidence).toContain("placeholder-sequence warnings")
    expect(evidence).toContain("do not claim that a final candidate contained X")
  })

  test("skips non-persisted failures without touching trajectory storage", async () => {
    let called = false
    const result = await ResearchTrajectoryCloseout.run(
      {
        campaignId: "cmp_closeout",
        experimentId: "exp_closeout",
        sessionId: "ses_closeout",
        iteration: 1,
        status: "run_failed",
        error: "Remote generator preflight failed",
      },
      {},
      {
        history: async () => {
          called = true
          throw new Error("unexpected")
        },
        ingest: async () => {
          throw new Error("unexpected")
        },
        publish: async () => {
          throw new Error("unexpected")
        },
        appendEvent: async () => {
          throw new Error("unexpected")
        },
      },
    )
    expect(result).toEqual({ status: "skipped", reason: "no_persisted_trajectory" })
    expect(called).toBe(false)
  })

  test("records a successful trajectory deterministically without a knowledge agent", async () => {
    let request: Record<string, unknown> | undefined
    let appended = false
    const result = await ResearchTrajectoryCloseout.run(
      {
        campaignId: "cmp_closeout",
        experimentId: "exp_closeout",
        sessionId: "ses_closeout",
        iteration: 2,
        status: "succeeded",
        trialId: "trl_closeout",
        runId: "run_closeout",
        score: 0.25,
        decision: "promoted",
        generatorPortfolio: ["boltzgen-binder"],
        generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 3, maximumGpuSeconds: 600 }],
        semanticProgramFingerprint: `sha256:${"c".repeat(64)}`,
        workflowFingerprint: `sha256:${"d".repeat(64)}`,
        candidateSequences: ["ACDEFG"],
        modelIds: ["boltz2", "chai1"],
        generatorDiagnostics: [{
          format: "autofold.generator-diagnostics.v1",
          generator: "freebindcraft",
          rejectedCandidates: 2,
          rejectionFilters: { Surface_Hydrophobicity: 2 },
          trajectoryFailures: 0,
          trajectoryFailureFilters: {},
          trajectoriesObserved: 2,
          acceptedCandidates: 0,
          sourceFiles: ["rejected_mpnn_full_stats.csv"],
        }],
      },
      {},
      {
        history: async () => ({
          experiment: {
            id: "exp_closeout",
            contractHash: `sha256:${"a".repeat(64)}`,
            contract: { evaluator: { fixedSeeds: [20260809], direction: "minimize" } },
          },
          trials: [{
            id: "trl_prior",
            intent: "optimize",
            programHash: `sha256:${"a".repeat(64)}`,
            hypothesis: "Prior best.",
          }, {
            id: "trl_closeout",
            intent: "optimize",
            parentTrialId: "trl_prior",
            programHash: `sha256:${"b".repeat(64)}`,
            hypothesis: "Test one Proto delta.",
          }],
          runs: [{ id: "run_closeout", trialId: "trl_closeout", status: "succeeded" }],
          evaluations: [{
            id: "evl_prior",
            trialId: "trl_prior",
            valid: true,
            score: 0.3,
            diagnostics: { loss: 0.3 },
          }, {
            id: "evl_closeout",
            trialId: "trl_closeout",
            valid: true,
            score: 0.25,
            diagnostics: { loss: 0.25 },
          }],
          knowledge: [{ id: "knw_closeout", runId: "run_closeout", decision: "promoted" }],
        }) as never,
        ingest: async (_campaignId, input) => {
          request = input
          return {
            claims: [],
            alignments: [],
            unresolvedQuestions: input.unresolvedQuestions,
            cycle: {
              id: "kcy_closeout",
              nextExperiment: {
                action: "continue_experiment",
                experimentId: "exp_closeout",
                hypothesis: "Use the trusted result.",
                rationale: "Continue directly.",
                successCriterion: "Produce another result.",
              },
            },
          } as never
        },
        publish: async () => undefined,
        appendEvent: async (event) => {
          appended = true
          expect(event).toMatchObject({ runId: "run_closeout", score: 0.25, decision: "promoted" })
        },
      },
    )
    expect(appended).toBe(true)
    expect(request?.generatedBy).toBe("autofold-trusted-success-closeout/v1:run_closeout")
    expect(request?.sources).toEqual([])
    expect(request?.claims).toEqual([])
    expect(request?.hypothesisUpdates).toMatchObject([{
      statement: "Test one Proto delta.",
      status: "supported",
      supportingEvidenceRefs: ["knw_closeout", "evl_closeout", "run_closeout", "trl_closeout"],
      opposingEvidenceRefs: [],
    }])
    expect(request?.searchObservations).toMatchObject([{
      trialId: "trl_closeout",
      runId: "run_closeout",
      score: 0.25,
      priorBestScore: 0.3,
      decision: "promoted",
      parentTrialId: "trl_prior",
      generatorPortfolio: ["boltzgen-binder"],
      generatorDiagnostics: [expect.objectContaining({
        generator: "freebindcraft",
        rejectionFilters: { Surface_Hydrophobicity: 2 },
      })],
      candidateSequences: ["ACDEFG"],
      modelIds: ["boltz2", "chai1"],
    }])
    const observations = request?.searchObservations as Array<{ scoreDeltaFromPriorBest?: number }>
    expect(observations[0]?.scoreDeltaFromPriorBest).toBeCloseTo(0.05)
    expect(result).toMatchObject({
      status: "completed",
      cycleId: "kcy_closeout",
      trajectory: {
        format: "autofold.trajectory.v1",
        experimentId: "exp_closeout",
        contractHash: `sha256:${"a".repeat(64)}`,
        trialId: "trl_closeout",
        runId: "run_closeout",
        knowledgeCycleId: "kcy_closeout",
        generatorPortfolio: ["boltzgen-binder"],
        candidateSequences: ["ACDEFG"],
        modelIds: ["boltz2", "chai1"],
      },
      nextExperiment: {
        action: "continue_experiment",
        experimentId: "exp_closeout",
        hypothesis: "Use the trusted result.",
      },
    })
  })

  test("mirrors each trusted run into the scientist event stream exactly once", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-trusted-events-"))
    const event = {
      experimentId: "exp_closeout",
      contractHash: `sha256:${"a".repeat(64)}`,
      iteration: 3,
      status: "succeeded" as const,
      trialId: "trl_closeout",
      runId: "run_closeout",
      score: 0.2,
      decision: "promoted" as const,
      diagnostics: { disagreement: 0.4 },
    }
    await ResearchTrajectoryCloseout.appendTrustedEvent(event, workspace)
    await ResearchTrajectoryCloseout.appendTrustedEvent(event, workspace)
    const contents = await fs.readFile(
      path.join(workspace, ".autofold", "autoresearch", "exp_closeout", "EVENTS.md"),
      "utf8",
    )
    expect(contents.match(/trusted-run:run_closeout/g)).toHaveLength(1)
    expect(contents).toContain("- Score: 0.2")
    expect(contents).toContain("- disagreement: 0.4")
  })
})
