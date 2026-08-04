import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchArtifacts } from "./artifacts"
import { ResearchAutoresearch } from "./autoresearch"
import { ResearchDomain } from "./domain"

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`
const timestamp = "2026-08-04T12:00:00.000Z"

function context(): ResearchAutoresearch.Context {
  const experiment = ResearchDomain.Experiment.parse({
    id: "exp_auto",
    campaignId: "cmp_auto",
    status: "active",
    contract: {
      version: 1,
      objective: "Improve peptide binding under a fixed panel",
      targetArtifactHash: digest("a"),
      modality: "short_peptide",
      budget: { maximumCandidates: 8, gpuHours: 1, wallTimeMinutes: 5 },
      evaluator: {
        id: "peptide-panel",
        version: "1",
        sourceHash: digest("b"),
        direction: "minimize",
        fixedSeeds: [7, 11],
        submissionSize: 3,
      },
    },
    contractHash: digest("c"),
    incumbentTrialId: "trl_incumbent",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  const incumbent = ResearchDomain.Trial.parse({
    id: "trl_incumbent",
    experimentId: experiment.id,
    hypothesis: "Baseline",
    designAdapter: "proto",
    programPath: ".autofold/programs/base/trial.py",
    programHash: digest("d"),
    status: "succeeded",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  const artifact = ResearchArtifacts.TargetArtifact.parse({
    format: "autofold.target-artifact.v1",
    name: "Fixture target",
    chains: [{ id: "A", sequence: "ACDEFGHIK" }],
    bindingSite: { residues: [{ chainId: "A", position: 4 }] },
  })
  return {
    experiment,
    target: {
      artifact,
      targetArtifactHash: experiment.contract.targetArtifactHash,
      targetArtifactPath: ".autofold/targets/a/target.json",
    },
    incumbent,
    incumbentProgram: "def build_program(bundle):\n    return bundle\n",
    history: { trials: [incumbent], evaluations: [] },
    knowledge: [],
    incumbentCandidates: [],
    protoToolCatalog: [],
  }
}

describe("bounded autoresearch orchestration", () => {
  test("preflights the bounded Proto source without importing or executing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-autoresearch-preflight-"))
    try {
      const valid = [
        "from contextlib import nullcontext",
        "def build_program(bundle):",
        "    budget = bundle['candidateBudget']",
        "    submission = bundle['submissionSize']",
        "    return (budget, submission, nullcontext())",
        "",
      ].join("\n")
      const validPath = path.join(root, "valid.py")
      await fs.writeFile(validPath, valid)
      await expect(ResearchAutoresearch.preflightFile(valid, validPath)).resolves.toBeUndefined()

      const unsafe = [
        "import os",
        "def build_program(bundle):",
        "    return bundle['candidateBudget'], bundle['submissionSize']",
        "",
      ].join("\n")
      const unsafePath = path.join(root, "unsafe.py")
      await fs.writeFile(unsafePath, unsafe)
      await expect(ResearchAutoresearch.preflightFile(unsafe, unsafePath)).rejects.toThrow(
        "Proto trial import is not allowed: os",
      )

      const forged = [
        "def build_program(bundle):",
        "    return {'candidateBudget': bundle['candidateBudget'], 'submissionSize': bundle['submissionSize'], 'evidence': {}}",
        "",
      ].join("\n")
      const forgedPath = path.join(root, "forged.py")
      await fs.writeFile(forgedPath, forged)
      await expect(ResearchAutoresearch.preflightFile(forged, forgedPath)).rejects.toThrow(
        "Proto trial may not author trusted evidence",
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("authors, preflights, and executes every requested iteration sequentially", async () => {
    const events: string[] = []
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 3, agent: "biology" },
      {
        context: async () => {
          events.push("context")
          return context()
        },
        propose: async ({ iteration }) => {
          events.push(`propose:${iteration}`)
          return {
            childSessionId: `ses_child_${iteration}`,
            draftPath: `.autofold/autoresearch/${iteration}/trial.py`,
            program: `def build_program(bundle):\n    return ${iteration}\n`,
            hypothesis: `Iteration ${iteration}`,
          }
        },
        preflight: async (_program, draftPath) => {
          events.push(`preflight:${draftPath}`)
        },
        execute: async ({ iteration, proposal }) => {
          events.push(`execute:${iteration}`)
          return {
            status: "succeeded",
            childSessionId: proposal.childSessionId,
            draftPath: proposal.draftPath,
            trialId: `trl_iteration_${iteration}`,
            runId: `run_iteration_${iteration}`,
            programHash: digest(String(iteration)),
            score: 0.5 - iteration / 100,
            valid: true,
            decision: iteration === 2 ? "rejected" : "promoted",
          }
        },
      },
    )

    expect(result.completedIterations).toBe(3)
    expect(result.iterations.map((iteration) => iteration.decision)).toEqual(["promoted", "rejected", "promoted"])
    expect(events).toEqual([
      "context",
      "propose:1",
      "preflight:.autofold/autoresearch/1/trial.py",
      "execute:1",
      "context",
      "propose:2",
      "preflight:.autofold/autoresearch/2/trial.py",
      "execute:2",
      "context",
      "propose:3",
      "preflight:.autofold/autoresearch/3/trial.py",
      "execute:3",
    ])
  })

  test("stops the bounded loop and reports an authoring failure", async () => {
    let proposals = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 4, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ iteration }) => {
          proposals++
          if (iteration === 2) throw new Error("child did not produce a valid draft")
          return {
            childSessionId: "ses_child_one",
            draftPath: ".autofold/autoresearch/one/trial.py",
            program: "def build_program(bundle):\n    return bundle\n",
            hypothesis: "First iteration",
          }
        },
        preflight: async () => undefined,
        execute: async () => ({
          status: "succeeded",
          trialId: "trl_iteration_one",
          runId: "run_iteration_one",
          score: 0.4,
          valid: true,
          decision: "promoted",
        }),
      },
    )

    expect(proposals).toBe(2)
    expect(result.completedIterations).toBe(1)
    expect(result.iterations[1]).toMatchObject({ status: "authoring_failed", error: "child did not produce a valid draft" })
  })

  test("stops after a scientific run failure without relabeling it as authoring", async () => {
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 2, agent: "biology" },
      {
        context: async () => context(),
        propose: async () => ({
          childSessionId: "ses_child",
          draftPath: ".autofold/autoresearch/failure/trial.py",
          program: "def build_program(bundle):\n    return bundle\n",
          hypothesis: "Expected failure",
        }),
        preflight: async () => undefined,
        execute: async () => ({
          status: "run_failed",
          trialId: "trl_failed",
          runId: "run_failed",
          error: "GPU allocation failed",
        }),
      },
    )

    expect(result.completedIterations).toBe(0)
    expect(result.iterations).toEqual([
      {
        iteration: 1,
        status: "run_failed",
        trialId: "trl_failed",
        runId: "run_failed",
        error: "GPU allocation failed",
      },
    ])
  })
})
