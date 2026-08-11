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
  const contract = ResearchDomain.ExperimentContract.parse({
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
  })
  const experiment = ResearchDomain.Experiment.parse({
    id: "exp_auto",
    campaignId: "cmp_auto",
    status: "active",
    contract,
    contractHash: ResearchDomain.hashContract(contract),
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
    literatureClaims: [],
    literatureRecords: [],
    incumbentCandidates: [],
    incumbentModelEvidence: [],
    recentTrialEvidence: [],
    protoToolCatalog: [],
  }
}

describe("bounded autoresearch orchestration", () => {
  test("keeps shadow replay on one frozen context and forwards non-promotable intent", async () => {
    const frozen = context()
    let observedIntent: ResearchDomain.Trial["intent"] | undefined
    let observedSkillCount = -1
    const result = await ResearchAutoresearch.run(
      { experimentId: frozen.experiment.id, sessionId: "ses_parent", iterations: 1, agent: "ml" },
      {
        context: async () => { throw new Error("frozen replay must not reload context") },
        propose: async ({ skillKnowledge }) => {
          observedSkillCount = skillKnowledge?.length ?? -1
          return {
            childSessionId: "ses_shadow", draftPath: ".autofold/shadow/trial.py",
            program: "def build_program(bundle):\n    return bundle\n", hypothesis: "Shadow replay",
          }
        },
        preflight: async () => undefined,
        execute: async ({ intent }) => {
          observedIntent = intent
          return { status: "succeeded", trialId: "trl_shadow", runId: "run_shadow", score: 0.3, valid: true, decision: "rejected" }
        },
      },
      undefined,
      { frozenContext: frozen, skillKnowledge: [], intent: "shadow_replay" },
    )
    expect(result.completedIterations).toBe(1)
    expect(observedSkillCount).toBe(0)
    expect(observedIntent).toBe("shadow_replay")
  })

  test("preflights the bounded Proto source without importing or executing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-autoresearch-preflight-"))
    try {
      const valid = [
        "from __future__ import annotations",
        "import json",
        "from pathlib import Path",
        "from contextlib import nullcontext",
        "def build_program(bundle):",
        "    budget = bundle['candidateBudget']",
        "    submission = bundle['submissionSize']",
        "    target = json.loads(Path(bundle['targetArtifactPath']).read_text())",
        "    return (budget, submission, target, nullcontext())",
        "",
      ].join("\n")
      const validPath = path.join(root, "valid.py")
      await fs.writeFile(validPath, valid)
      const fingerprint = await ResearchAutoresearch.preflightFile(valid, validPath)
      expect(fingerprint).toStartWith("sha256:")
      const documented = `\"\"\"Formatting-only documentation.\"\"\"\n${valid}`
      const documentedPath = path.join(root, "documented.py")
      await fs.writeFile(documentedPath, documented)
      expect(await ResearchAutoresearch.preflightFile(documented, documentedPath)).toBe(fingerprint)

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

      const emptyConstraints = [
        "from proto_language.optimizer import RejectionSamplingOptimizer",
        "def build_program(bundle):",
        "    optimizer = RejectionSamplingOptimizer(constructs=[], generators=[], constraints=[])",
        "    return optimizer, bundle['candidateBudget'], bundle['submissionSize']",
        "",
      ].join("\n")
      const emptyConstraintsPath = path.join(root, "empty-constraints.py")
      await fs.writeFile(emptyConstraintsPath, emptyConstraints)
      await expect(
        ResearchAutoresearch.preflightFile(emptyConstraints, emptyConstraintsPath),
      ).rejects.toThrow("RejectionSamplingOptimizer requires at least one Constraint")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("requires an installed binder generator for optimize while allowing explicit controls", () => {
    const frozen = context()
    frozen.protoGeneratorCatalog = [{
      key: "boltzgen-binder",
      usesGpu: true,
      toolsCalled: ["boltzgen-design"],
    }]
    const validatorOnly = {
      format: "autofold.proto-workflow.v1" as const,
      id: "validator_only",
      maximumGpuSeconds: 0,
      stages: [],
    }
    expect(() => ResearchAutoresearch.validateGenerationPolicy(validatorOnly, frozen, "optimize"))
      .toThrow("must declare and use at least one installed Proto binder generator")
    expect(() => ResearchAutoresearch.validateGenerationPolicy(validatorOnly, frozen, "negative_control", {
      rationale: "Measure the frozen control.",
      expectedInformationGain: "Calibrate evaluator variance.",
      generatorPolicy: "forbidden",
      preferredGenerators: [],
    })).not.toThrow()
    expect(() => ResearchAutoresearch.validateGenerationPolicy({
      ...validatorOnly,
      generation: { generators: ["random-protein"], maximumCandidates: 2, maximumGpuSeconds: 1 },
    }, frozen, "optimize")).toThrow("outside the installed search space")
    expect(() => ResearchAutoresearch.validateGenerationPolicy({
      ...validatorOnly,
      generation: { generators: ["boltzgen-binder"], maximumCandidates: 2, maximumGpuSeconds: 1 },
    }, frozen, "optimize")).not.toThrow()
  })

  test("opens recursive search across every registered binder lane", () => {
    const frozen = context()
    frozen.protoGeneratorCatalog = [
      { key: "freebindcraft", usesGpu: true, toolsCalled: ["freebindcraft-design"] },
      { key: "rfdiffusion-mpnn-binder", usesGpu: true, toolsCalled: ["rfdiffusion3-design", "proteinmpnn-sample"] },
      { key: "boltzgen-binder", usesGpu: true, toolsCalled: ["boltzgen-design"] },
    ]
    expect(ResearchAutoresearch.deriveSearchPolicy(frozen, 1)).toMatchObject({
      move: "explore_generator",
      preferredGenerators: ["freebindcraft", "rfdiffusion-mpnn-binder", "boltzgen-binder"],
      generatorStrategy: "novel_scaffold",
    })
  })

  test("compacts author catalogs without losing generator construction fields", () => {
    const compact = ResearchAutoresearch.compactAuthorCatalog([
      {
        key: "boltzgen-binder",
        className: "BoltzGenBinderGenerator",
        classModule: "autofold_worker.proto_generators",
        configName: "BoltzGenBinderConfig",
        configModule: "autofold_worker.proto_generators",
        configSchema: {
          type: "object",
          properties: {
            protocol: { type: "string", enum: ["peptide-anything"], description: "x".repeat(500), title: "Protocol" },
            seed: { type: "integer", description: "reserved by runtime" },
          },
        },
      },
    ]) as Array<Record<string, any>>
    expect(compact[0]?.className).toBe("BoltzGenBinderGenerator")
    expect(compact[0]?.configSchema.properties.protocol.enum).toEqual(["peptide-anything"])
    expect(compact[0]?.configSchema.properties.protocol.description.length).toBe(320)
    expect(compact[0]?.configSchema.properties.seed).toBeUndefined()
    expect(JSON.stringify(compact)).not.toContain("Protocol")
  })

  test("preserves structured scientific conflict messages", () => {
    expect(
      ResearchAutoresearch.errorMessage({
        message: "ResearchConflictError",
        data: { message: "The installed evidence adapter does not match the frozen experiment contract" },
      }),
    ).toBe("The installed evidence adapter does not match the frozen experiment contract")
  })

  test("rejects replay-mode and empty-segment programs when binder generation is required", () => {
    expect(() => ResearchAutoresearch.validateGenerationProgram(
      "optimizer = RejectionSamplingOptimizer(generators=[], constraints=[rank])",
      "optimize",
    )).toThrow("empty optimizer generator list")
    expect(() => ResearchAutoresearch.validateGenerationProgram(
      "optimizer = RejectionSamplingOptimizer(generators=[generator], constraints=[rank], proposal_source='existing_results')",
      "optimize",
    )).toThrow("proposal_source must be 'generated'")
    expect(() => ResearchAutoresearch.validateGenerationProgram(
      "generator.assign(binder)\noptimizer = RejectionSamplingOptimizer(generators=[generator], constraints=[rank], proposal_source='generator')",
      "optimize",
    )).toThrow("proposal_source must be 'generated'")
    expect(() => ResearchAutoresearch.validateGenerationProgram(
      "binder = Segment(sequence='', sequence_type='protein')",
      "optimize",
    )).toThrow("require a positive length")
    expect(() => ResearchAutoresearch.validateGenerationProgram(
      "binder = Segment(length=14, sequence_type='protein')\ngenerator.assign(binder)\noptimizer = RejectionSamplingOptimizer(generators=[generator], constraints=[rank])",
      "optimize",
    )).not.toThrow()
    expect(() => ResearchAutoresearch.validateGenerationProgram(
      "binder = Segment(length=14, sequence_type='protein')\noptimizer = RejectionSamplingOptimizer(generators=[generator], constraints=[rank])",
      "optimize",
    )).toThrow("must be assigned")
  })

  test("extracts a complete Proto program from raw or fenced model output", () => {
    expect(ResearchAutoresearch.extractProgram("def build_program(bundle):\n    return bundle\n"))
      .toBe("def build_program(bundle):\n    return bundle\n")
    expect(ResearchAutoresearch.extractProgram("```python\ndef build_program(bundle):\n    return bundle\n```"))
      .toBe("def build_program(bundle):\n    return bundle\n")
    expect(() => ResearchAutoresearch.extractProgram("I'll edit it next.")).toThrow(
      "Proto author did not return a complete Python program",
    )
  })

  test("derives the trial hypothesis from the Python docstring rather than storing source code", () => {
    expect(ResearchAutoresearch.extractHypothesis('"""Test one salt bridge.\n\nKeep the evaluator frozen."""\ndef build_program(bundle):\n    return bundle\n', 2))
      .toBe("Test one salt bridge.\n\nKeep the evaluator frozen.")
    expect(ResearchAutoresearch.extractHypothesis("def build_program(bundle):\n    return bundle\n", 2))
      .toBe("Autoresearch iteration 2")
  })

  test("authors, preflights, and executes every requested iteration sequentially", async () => {
    const events: string[] = []
    let contextVersion = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 3, agent: "biology" },
      {
        context: async () => {
          events.push("context")
          const fresh = context()
          contextVersion++
          fresh.knowledge = contextVersion > 1
            ? [{
                id: `knw_iteration_${contextVersion - 1}`,
                campaignId: fresh.experiment.campaignId,
                experimentId: fresh.experiment.id,
                trialId: `trl_iteration_${contextVersion - 1}`,
                type: "Research Evaluation",
                title: "Fresh iteration evidence",
                description: "Published after the previous trial.",
                tags: ["autofold"],
                sources: [],
                generated: { by: "test", at: timestamp },
                status: "stable",
                score: 0.4,
                decision: "rejected",
                diagnostics: { disagreement: 0.2 },
                provenance: {
                  contractHash: fresh.experiment.contractHash,
                  targetArtifactHash: fresh.experiment.contract.targetArtifactHash,
                  evaluatorHash: fresh.experiment.contract.evaluator.sourceHash,
                  programHash: digest(String(contextVersion - 1)),
                },
                createdAt: timestamp,
              }]
            : []
          fresh.recentTrialEvidence = contextVersion > 1
            ? [{
                trial: {
                  id: `trl_iteration_${contextVersion - 1}`,
                  parentTrialId: fresh.incumbent?.id,
                  hypothesis: "Previous recursive hypothesis",
                  intent: "optimize",
                  programHash: digest(String(contextVersion - 1)),
                  status: "succeeded",
                },
                run: {
                  id: `run_iteration_${contextVersion - 1}`,
                  status: "succeeded",
                  createdAt: timestamp,
                  completedAt: timestamp,
                },
                evaluation: {
                  id: `evl_iteration_${contextVersion - 1}`,
                  trialId: `trl_iteration_${contextVersion - 1}`,
                  contractHash: fresh.experiment.contractHash,
                  evaluatorHash: fresh.experiment.contract.evaluator.sourceHash,
                  valid: true,
                  score: 0.4,
                  diagnostics: { predictor_disagreement: 0.2 },
                  evaluatedAt: timestamp,
                },
                candidates: [{ id: `candidate_${contextVersion - 1}`, sequence: "ACDE" }],
                modelEvidence: [{
                  candidateId: `candidate_${contextVersion - 1}`,
                  modelId: "boltz2",
                  seed: 7,
                  status: "completed",
                  metrics: { confidence: 0.8 },
                }],
              }]
            : []
          return fresh
        },
        propose: async ({ iteration, context: fresh }) => {
          events.push(`propose:${iteration}`)
          expect(fresh.knowledge).toHaveLength(iteration === 1 ? 0 : 1)
          expect(fresh.recentTrialEvidence).toHaveLength(iteration === 1 ? 0 : 1)
          if (iteration > 1) {
            expect(fresh.recentTrialEvidence[0]?.evaluation?.diagnostics.predictor_disagreement).toBe(0.2)
            expect(fresh.recentTrialEvidence[0]?.modelEvidence[0]?.modelId).toBe("boltz2")
          }
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

  test("stops before authoring when a later iteration observes a changed frozen contract", async () => {
    let loads = 0
    let proposals = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 2, agent: "biology" },
      {
        context: async () => {
          const fresh = context()
          loads++
          if (loads === 2) {
            fresh.experiment.contract.objective = "Changed objective requiring a new experiment"
            fresh.experiment.contractHash = ResearchDomain.hashContract(fresh.experiment.contract)
          }
          return fresh
        },
        propose: async ({ iteration }) => {
          proposals++
          return {
            childSessionId: `ses_child_${iteration}`,
            draftPath: `.autofold/autoresearch/${iteration}/trial.py`,
            program: "def build_program(bundle):\n    return bundle\n",
            hypothesis: `Iteration ${iteration}`,
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
    expect(proposals).toBe(1)
    expect(result.completedIterations).toBe(1)
    expect(result.iterations[1]).toMatchObject({
      status: "authoring_failed",
      error: expect.stringContaining("Frozen experiment contract changed"),
    })
  })

  test("stops a proposal that repeats an existing program before execution", async () => {
    const frozen = context()
    const repeated = "def build_program(bundle):\n    return bundle['candidateBudget'], bundle['submissionSize']\n"
    frozen.history.trials[0]!.programHash = ResearchAutoresearch.programFingerprint(repeated)
    let executed = false
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 2, agent: "biology" },
      {
        context: async () => frozen,
        propose: async () => ({
          childSessionId: "ses_duplicate",
          draftPath: ".autofold/autoresearch/duplicate/trial.py",
          program: repeated,
          hypothesis: "Duplicate",
        }),
        preflight: async () => { throw new Error("duplicate must stop before preflight") },
        execute: async () => {
          executed = true
          return { status: "succeeded" }
        },
      },
    )
    expect(executed).toBe(false)
    expect(result.stopReason).toBe("repeated_equivalent_proposal")
    expect(result.iterations[0]?.status).toBe("stopped")
  })

  test("detects an experiment improvement plateau from locked comparable scores", () => {
    const frozen = context()
    frozen.history.evaluations = [0.2, 0.3, 0.25, 0.22, 0.24].map((score, index) => ({
      id: `evl_${index}`,
      trialId: `trl_${index}`,
      contractHash: frozen.experiment.contractHash,
      evaluatorHash: digest("e"),
      valid: true,
      score,
      diagnostics: {},
      evaluatedAt: timestamp,
    }))
    expect(ResearchAutoresearch.stoppingReason(frozen, undefined, "optimize"))
      .toBe("improvement_plateau")
  })

  test("preserves the original contract lock when resuming after a completed iteration", async () => {
    const original = context()
    const changed = context()
    changed.experiment.contract.objective = "A contract change after process restart"
    changed.experiment.contractHash = ResearchDomain.hashContract(changed.experiment.contract)
    let proposals = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 2, agent: "biology" },
      {
        context: async () => changed,
        propose: async () => {
          proposals++
          throw new Error("a changed contract must stop before authoring")
        },
        preflight: async () => undefined,
        execute: async () => ({ status: "succeeded" }),
      },
      undefined,
      {
        contractLock: {
          experimentId: original.experiment.id,
          contractHash: original.experiment.contractHash,
        },
        iterations: {
          1: {
            iteration: 1,
            status: "succeeded",
            trialId: "trl_iteration_one",
            runId: "run_iteration_one",
            score: 0.4,
            valid: true,
            decision: "promoted",
          },
        },
      },
    )
    expect(proposals).toBe(0)
    expect(result.completedIterations).toBe(1)
    expect(result.iterations[1]?.error).toContain("Frozen experiment contract changed")
  })

  test("records an authoring failure and uses the remaining repair budget", async () => {
    let proposals = 0
    let recoveredError: string | undefined
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 4, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ iteration, recovery }) => {
          proposals++
          if (iteration === 2) throw new Error("child did not produce a valid draft")
          if (iteration === 3) recoveredError = recovery?.error
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

    expect(proposals).toBe(4)
    expect(result.completedIterations).toBe(3)
    expect(result.stopReason).toBe("budget_exhausted")
    // No proposal existed for the model-call failure at iteration two, so the
    // next attempt still advances without pretending there is source to repair.
    expect(recoveredError).toBeUndefined()
    expect(result.iterations[1]).toMatchObject({ status: "authoring_failed", error: "child did not produce a valid draft" })
  })

  test("treats scientific run failures as evidence and continues the bounded lineage", async () => {
    let attempts = 0
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
        execute: async () => {
          attempts++
          return {
            status: "run_failed",
            trialId: `trl_failed_${attempts}`,
            runId: `run_failed_${attempts}`,
            error: "GPU allocation failed",
          }
        },
      },
    )

    expect(result.completedIterations).toBe(0)
    expect(result.stopReason).toBe("budget_exhausted")
    expect(result.iterations).toHaveLength(2)
    expect(result.iterations.map((iteration) => iteration.status)).toEqual(["run_failed", "run_failed"])
    expect(result.iterations[0]).toMatchObject({
      trialId: "trl_failed_1",
      parentTrialId: "trl_incumbent",
      error: "GPU allocation failed",
    })
  })

  test("keeps the mutable search head separate from the best locked incumbent", async () => {
    const frozen = context()
    frozen.searchHead = ResearchDomain.Trial.parse({
      ...frozen.incumbent!,
      id: "trl_latest_rejected",
      parentTrialId: frozen.incumbent!.id,
      hypothesis: "Latest rejected exploration",
      programHash: digest("f"),
    })
    frozen.searchHeadProgram = "def build_program(bundle):\n    return 'latest attempt'\n"
    let observedProgram = ""
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => frozen,
        propose: async ({ context: fresh }) => {
          observedProgram = fresh.searchHeadProgram ?? ""
          return {
            childSessionId: "ses_lineage",
            draftPath: ".autofold/autoresearch/lineage/trial.py",
            program: "def build_program(bundle):\n    return 'next attempt'\n",
            hypothesis: "Continue rejected branch",
          }
        },
        preflight: async () => undefined,
        execute: async () => ({ status: "succeeded", trialId: "trl_next", runId: "run_next" }),
      },
    )
    expect(observedProgram).toBe(frozen.searchHeadProgram)
    expect(result.iterations[0]?.parentTrialId).toBe("trl_latest_rejected")
    expect(frozen.incumbent?.id).toBe("trl_incumbent")
  })

  test("resumes completed iterations, proposals, and scientific runs from checkpoints", async () => {
    const events: string[] = []
    const resumedProposal = {
      childSessionId: "ses_child_two",
      draftPath: ".autofold/autoresearch/two/trial.py",
      program: "def build_program(bundle):\n    return bundle\n",
      hypothesis: "Resume iteration two",
    }
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 2, agent: "biology" },
      {
        context: async () => {
          events.push("context")
          return context()
        },
        propose: async () => {
          throw new Error("a checkpointed proposal must not create another child")
        },
        preflight: async () => {
          events.push("preflight")
        },
        execute: async ({ resumeRun, originJobId, onRunStarted }) => {
          events.push(`execute:${resumeRun?.runId}:${originJobId}`)
          await onRunStarted?.(resumeRun!)
          return {
            status: "succeeded",
            ...resumeRun,
            score: 0.21,
            valid: true,
            decision: "promoted",
          }
        },
      },
      undefined,
      {
        originJobId: "job_resume",
        proposals: { 2: resumedProposal },
        runs: { 2: { trialId: "trl_two", runId: "run_two", programHash: digest("2") } },
        iterations: {
          1: {
            iteration: 1,
            status: "succeeded",
            trialId: "trl_one",
            runId: "run_one",
            programHash: digest("1"),
            score: 0.3,
            valid: true,
            decision: "promoted",
          },
        },
        onProposal: async (iteration) => {
          events.push(`proposal-checkpoint:${iteration}`)
        },
        onRunStarted: async (iteration) => {
          events.push(`run-checkpoint:${iteration}`)
        },
        onIteration: async (iteration) => {
          events.push(`iteration-checkpoint:${iteration.iteration}`)
        },
      },
    )
    expect(result.completedIterations).toBe(2)
    expect(events).toEqual([
      "context",
      "proposal-checkpoint:2",
      "preflight",
      "execute:run_two:job_resume",
      "run-checkpoint:2",
      "iteration-checkpoint:2",
    ])
  })
})
