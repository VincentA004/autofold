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
    knowledgeCycles: [],
    campaignCharter: ResearchDomain.CampaignCharter.parse({
      id: "chr_auto", campaignId: "cmp_auto", version: 1, objective: "Discover",
      successCriteria: [{ id: "biological_objective", statement: "Find a robust candidate", requiredEvidenceLevel: "multi_seed_support", status: "open" }],
      requiredControls: [],
      stopConditions: [{ kind: "budget_exhausted", criterion: "Budget is exhausted" }],
      constraints: { requireMatchedControlCardinality: true, requireMultiSeedConfirmation: true },
      status: "active", createdAt: timestamp, updatedAt: timestamp,
    }),
    hypothesisLedger: [],
    searchLandscape: [],
    campaignTrialCount: 1,
    incumbentCandidates: [],
    incumbentModelEvidence: [],
    recentTrialEvidence: [],
    protoToolCatalog: [],
  }
}

describe("bounded autoresearch orchestration", () => {
  test("projects a bounded experiment-local author packet instead of replaying raw failed programs", () => {
    const fresh = context()
    fresh.recentAuthoringFailures = [{
      jobId: "job_failed",
      iteration: 1,
      error: "preflight failed",
      draftPath: ".autofold/failed/trial.py",
      program: "# oversized failed source\n".repeat(20_000),
      failedAt: timestamp,
    }]
    fresh.searchLandscape.push(ResearchDomain.SearchObservation.parse({
      id: "sobs_other",
      campaignId: "cmp_auto",
      experimentId: "exp_other",
      trialId: "trl_other",
      runId: "run_other",
      knowledgeId: "knw_other",
      knowledgeCycleId: "kcy_other",
      intent: "optimize",
      programHash: digest("e"),
      generatorPortfolio: ["other-generator"],
      candidateSequences: ["ACDE"],
      modelIds: ["other-model"],
      seeds: [7],
      score: 0.1,
      decision: "rejected",
      diagnostics: {},
      hypothesis: "Other contract",
      epistemicLevel: "model_observation",
      createdAt: timestamp,
    }))
    const packet = ResearchAutoresearch.compactAuthorContext({ context: fresh })
    const serialized = JSON.stringify(packet)
    expect(serialized.length).toBeLessThan(50_000)
    expect(serialized).not.toContain("oversized failed source")
    expect(serialized).not.toContain("sobs_other")
    expect(serialized).toContain("preflight failed")
    expect(packet.searchBudgetSemantics).toEqual({
      maximumCandidates: 8,
      submissionSize: 3,
      maximumGpuSeconds: 3600,
      candidateAllocationCapsReturnedCandidates: true,
      generatorInternalSearchIsAgentAuthored: true,
      gpuTimeIsOnlyADeadline: true,
      allowedPortfolioShapes: "Any 1..N ready generators whose explicit candidate allocations sum to maximumCandidates",
    })
  })

  test("keeps generator failure diagnostics in the restart-safe scientist packet", () => {
    const fresh = context()
    fresh.searchLandscape.push(ResearchDomain.SearchObservation.parse({
      id: "sobs_diagnostics", campaignId: "cmp_auto", experimentId: "exp_auto",
      trialId: "trl_diagnostics", runId: "run_diagnostics", knowledgeId: "knw_diagnostics",
      knowledgeCycleId: "kcy_diagnostics", intent: "optimize", programHash: digest("f"),
      generatorPortfolio: ["freebindcraft"], candidateSequences: [], modelIds: [], seeds: [7, 11],
      score: null, decision: "failed", diagnostics: {}, hypothesis: "Probe a FreeBindCraft lane",
      epistemicLevel: "model_observation", createdAt: timestamp,
      generatorDiagnostics: [{
        format: "autofold.generator-diagnostics.v1", generator: "freebindcraft",
        rejectedCandidates: 1, rejectionFilters: { Surface_Hydrophobicity: 1 },
        trajectoryFailures: 2, trajectoryFailureFilters: { Trajectory_final_pLDDT: 2 },
        trajectoriesObserved: 3, acceptedCandidates: 0, sourceFiles: ["failure_csv"],
      }],
    }))
    const packet = ResearchAutoresearch.compactAuthorContext({ context: fresh })
    expect(packet.persistentSearchLandscape).toEqual([
      expect.objectContaining({
        id: "sobs_diagnostics",
        generatorDiagnostics: [expect.objectContaining({ trajectoryFailures: 2 })],
      }),
    ])
  })

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

  test("forwards job cancellation into active scientist authoring", async () => {
    const controller = new AbortController()
    let entered!: () => void
    const authoringStarted = new Promise<void>((resolve) => { entered = resolve })
    let observedSignal: AbortSignal | undefined
    const running = ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ signal }) => {
          observedSignal = signal
          entered()
          return await new Promise<ResearchAutoresearch.Proposal>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        },
        preflight: async () => undefined,
        execute: async () => { throw new Error("cancelled authoring must not execute") },
      },
      controller.signal,
    )
    await authoringStarted
    controller.abort(new Error("cancel scientist"))
    expect(observedSignal).toBe(controller.signal)
    await expect(running).rejects.toThrow("cancel scientist")
  })

  test("preflights the bounded Proto source and resolves its imports", async () => {
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
      const authoredIntentPath = path.join(root, "authored-intent.py")
      await fs.writeFile(authoredIntentPath, 'AUTOFOLD_TRIAL = {"intent": "calibrate", "calibrationClass": "known_positive", "replicateOfTrialId": "trl_incumbent"}\n')
      expect(await ResearchAutoresearch.extractTrialIntent(authoredIntentPath)).toBe("calibrate")
      expect(await ResearchAutoresearch.extractTrialDeclaration(authoredIntentPath)).toEqual({
        intent: "calibrate",
        calibrationClass: "known_positive",
        replicateOfTrialId: "trl_incumbent",
      })
      expect(await ResearchAutoresearch.extractTrialIntent(validPath)).toBeUndefined()

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

      const unresolvedImport = [
        "from contextlib import DefinitelyMissingProtoSymbol",
        "def build_program(bundle):",
        "    return bundle['candidateBudget'], bundle['submissionSize']",
        "",
      ].join("\n")
      const unresolvedImportPath = path.join(root, "unresolved-import.py")
      await fs.writeFile(unresolvedImportPath, unresolvedImport)
      await expect(
        ResearchAutoresearch.preflightFile(unresolvedImport, unresolvedImportPath),
      ).rejects.toThrow("Proto trial import symbol cannot be resolved: contextlib.DefinitelyMissingProtoSymbol")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("constructs a Proto program without executing its optimizer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-dry-build-"))
    try {
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify({ candidateBudget: 3, submissionSize: 2 }))
      const validPath = path.join(root, "valid.py")
      await fs.writeFile(validPath, [
        "class NativeProgram:",
        "    def run(self): pass",
        "def build_program(bundle):",
        "    assert bundle['candidateBudget'] >= bundle['submissionSize']",
        "    return NativeProgram()",
        "",
      ].join("\n"))
      await expect(
        ResearchAutoresearch.validateProgramConstruction(validPath, bundlePath, root),
      ).resolves.toEqual({
        constructed: true,
        generation: null,
        diagnostics: [],
        declaration: { intent: "optimize" },
        hypothesis: "Legacy Proto trial",
      })

      const agentNativePath = path.join(root, "agent-native.py")
      await fs.writeFile(agentNativePath, [
        "from autofold_worker.proto_trial import DiagnosticStage, ProtoTrial",
        "class NativeProgram:",
        "    def run(self): pass",
        "def build_trial(ctx):",
        "    assert ctx.candidate_budget >= ctx.submission_size",
        "    diagnostic = DiagnosticStage(id='chai-check', tools=('chai1-prediction',), configs={'chai1-prediction': {'use_msa': False}}, maximum_gpu_seconds=30)",
        "    return ProtoTrial(program=NativeProgram(), hypothesis='Test an independent Chai diagnostic.', diagnostics=(diagnostic,))",
        "",
      ].join("\n"))
      expect(await ResearchAutoresearch.preflightFile(await fs.readFile(agentNativePath, "utf8"), agentNativePath))
        .toStartWith("sha256:")
      await expect(
        ResearchAutoresearch.validateProgramConstruction(agentNativePath, bundlePath, root),
      ).resolves.toEqual({
        constructed: true,
        generation: null,
        diagnostics: [{
          id: "chai-check",
          role: "diagnostic",
          capability: "structure_prediction",
          tools: ["chai1-prediction"],
          configs: { "chai1-prediction": { use_msa: false } },
          selection: "all",
          dependsOn: [],
          maximumGpuSeconds: 30,
          optional: true,
        }],
        declaration: { intent: "optimize" },
        hypothesis: "Test an independent Chai diagnostic.",
      })

      const portfolioPath = path.join(root, "portfolio.py")
      await fs.writeFile(portfolioPath, [
        "from autofold_worker.proto_portfolio import ProtoPortfolioLane, ProtoPortfolioProgram",
        "class Generator:",
        "    _autofold_generator_id = 'boltzgen-binder'",
        "class Optimizer:",
        "    generators = [Generator()]",
        "class NativeProgram:",
        "    optimizers = [Optimizer()]",
        "    constructs = [object()]",
        "    def run(self): pass",
        "def build_program(bundle):",
        "    assert bundle['candidateBudget'] >= bundle['submissionSize']",
        "    lane = ProtoPortfolioLane(NativeProgram(), maximum_candidates=2, maximum_gpu_seconds=30)",
        "    return ProtoPortfolioProgram([lane])",
        "",
      ].join("\n"))
      await expect(
        ResearchAutoresearch.validateProgramConstruction(portfolioPath, bundlePath, root),
      ).resolves.toEqual({
        constructed: true,
        generation: {
          generators: ["boltzgen-binder"],
          allocations: [{ generator: "boltzgen-binder", maximumCandidates: 2, maximumGpuSeconds: 30 }],
          maximumCandidates: 2,
          maximumGpuSeconds: 30,
        },
        diagnostics: [],
        declaration: { intent: "optimize" },
        hypothesis: "Legacy Proto trial",
      })

      const invalidPath = path.join(root, "invalid.py")
      await fs.writeFile(invalidPath, [
        "def build_program(bundle):",
        "    raise ValueError('invalid generator config')",
        "",
      ].join("\n"))
      await expect(
        ResearchAutoresearch.validateProgramConstruction(invalidPath, bundlePath, root),
      ).rejects.toThrow("invalid generator config")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("bootstraps fresh-experiment construction preflight from frozen inputs without a fake run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-construction-fixture-"))
    try {
      const fresh = context()
      fresh.target.targetArtifactPath = "target.json"
      fresh.target.structureArtifactPath = "target.pdb"
      await fs.writeFile(path.join(root, "target.json"), JSON.stringify(fresh.target.artifact))
      await fs.writeFile(path.join(root, "target.pdb"), "ATOM\n")
      const first = await ResearchAutoresearch.prepareConstructionPreflightFixture(fresh, root)
      const second = await ResearchAutoresearch.prepareConstructionPreflightFixture(fresh, root)
      expect(second).toEqual(first)
      const bundle = JSON.parse(await fs.readFile(first.bundlePath, "utf8"))
      expect(bundle).toMatchObject({
        format: "autofold.construction-preflight.v1",
        experimentId: "exp_auto",
        contractHash: fresh.experiment.contractHash,
        targetArtifactPath: "target.json",
        targetStructurePath: "target.pdb",
        candidateBudget: 8,
        submissionSize: 3,
        seeds: [7, 11],
      })
      expect(await fs.readFile(path.join(first.root, "target.pdb"), "utf8")).toBe("ATOM\n")
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
    frozen.executionReadiness = {
      checkedAt: timestamp,
      compute: "ssh",
      host: "workstation_4090",
      ready: false,
      generators: [{
        generator: "boltzgen-binder",
        configured: true,
        ready: false,
        reason: "SSH readiness probe failed",
      }],
      validatorArtifacts: "checked_at_launch",
    }
    expect(() => ResearchAutoresearch.validateGenerationPolicy({
      ...validatorOnly,
      generation: { generators: ["boltzgen-binder"], maximumCandidates: 2, maximumGpuSeconds: 1 },
    }, frozen, "optimize")).toThrow("boltzgen-binder: SSH readiness probe failed")
  })

  test("rejects a static control sequence unrelated to its declared experiment incumbent", () => {
    const frozen = context()
    frozen.incumbentCandidates = [{ id: "incumbent", sequence: "CVTLEVDGEKFEIC", seed: 7 }]
    const directive = {
      rationale: "Probe one incumbent residue.",
      expectedInformationGain: "Localize an interface contact.",
      generatorPolicy: "forbidden" as const,
      preferredGenerators: [],
      baselineTrialId: "trl_incumbent",
    }
    expect(() => ResearchAutoresearch.validateStaticLineage(
      'binder = Segment(sequence="CVTLEVGGEKFEIC", sequence_type="protein")',
      frozen,
      "negative_control",
      directive,
    )).not.toThrow()
    expect(() => ResearchAutoresearch.validateStaticLineage(
      'CONTROL_SEQUENCE = "KCEIVEFGTDELVC"\nbinder = Segment(sequence=CONTROL_SEQUENCE, sequence_type="protein")',
      frozen,
      "negative_control",
      { ...directive, staticControlScope: "same_length_scaffold" },
    )).not.toThrow()
    expect(() => ResearchAutoresearch.validateStaticLineage(
      'CONTROL_SEQUENCE = scramble("CVTLEVDGEKFEIC")\nbinder = Segment(sequence=CONTROL_SEQUENCE, sequence_type="protein")',
      frozen,
      "negative_control",
      directive,
    )).toThrow("must encode at least one literal protein sequence")
    expect(() => ResearchAutoresearch.validateStaticLineage(
      'binder = Segment(sequence="CGVKLGDGKLIVTC", sequence_type="protein")',
      frozen,
      "negative_control",
      directive,
    )).toThrow("is not derived from incumbent trl_incumbent")
    expect(() => ResearchAutoresearch.validateStaticLineage(
      'binder = Segment(sequence="CGVKLGDGKLIVTC", sequence_type="protein")',
      frozen,
      "negative_control",
      { ...directive, staticControlScope: "same_length_scaffold" },
    )).not.toThrow()
    expect(() => ResearchAutoresearch.validateStaticLineage(
      'binder = Segment(sequence="CVTLEVGGEKFEIC", sequence_type="protein")',
      frozen,
      "negative_control",
      { ...directive, baselineTrialId: "trl_other" },
    )).toThrow("does not match experiment incumbent trl_incumbent")
  })

  test("accepts auditable static control panels encoded as a top-level peptide collection", () => {
    const frozen = context()
    frozen.incumbentCandidates = [{ sequence: "SAEEELRKLREELE" }]
    const panel = [
      "CONTROL_PANEL = [",
      '    ("EELRKSAEELRLEE", "scramble-1"),',
      '    ("KLEEERSAEELRLE", "scramble-2"),',
      '    ("AELREKSEELRLEE", "scramble-3"),',
      "]",
      "def build(sequence):",
      '    return Segment(sequence=sequence, sequence_type="protein")',
    ].join("\n")
    expect(() => ResearchAutoresearch.validateStaticLineage(
      panel,
      frozen,
      "negative_control",
      {
        rationale: "Test a composition-matched static control panel.",
        expectedInformationGain: "Separate sequence order from amino-acid composition.",
        generatorPolicy: "forbidden",
        baselineTrialId: frozen.incumbent!.id,
      },
    )).not.toThrow()
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

  test("rejects a declared generator whose registered Python symbols are misspelled", () => {
    const workflow = {
      format: "autofold.proto-workflow.v1" as const,
      id: "freebindcraft-test",
      maximumGpuSeconds: 10,
      generation: {
        generators: ["freebindcraft"],
        maximumCandidates: 1,
        maximumGpuSeconds: 5,
      },
      stages: [],
    }
    const catalog = [{
      key: "freebindcraft",
      className: "FreeBindCraftGenerator",
      configName: "FreeBindCraftGeneratorConfig",
      usesGpu: true,
      toolsCalled: ["freebindcraft-design"],
    }]
    expect(() => ResearchAutoresearch.validateGeneratorBindings(
      "from proto_language.generator import FreebindCraftGenerator, FreebindCraftGeneratorConfig",
      workflow,
      catalog,
    )).toThrow("FreeBindCraftGenerator")
    expect(() => ResearchAutoresearch.validateGeneratorBindings(
      "from proto_language.generator import FreeBindCraftGenerator, FreeBindCraftGeneratorConfig",
      workflow,
      catalog,
    )).not.toThrow()
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
    const resumedScientistSessions: Array<string | undefined> = []
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
          fresh.knowledgeCycles = contextVersion > 1
            ? [ResearchDomain.KnowledgeCycle.parse({
                id: `kcy_iteration_${contextVersion - 1}`,
                campaignId: fresh.experiment.campaignId,
                trigger: "run_completed",
                question: "What should the next iteration falsify?",
                inputs: { knowledgeIds: [`knw_iteration_${contextVersion - 1}`], claimIds: [], literatureIds: [] },
                outputs: { literatureIds: [], claimIds: [], alignmentIds: [], unresolvedQuestions: ["Does the contact survive mutation?"] },
                generated: { by: "test", at: timestamp },
                nextExperiment: {
                  action: "continue_experiment",
                  experimentId: fresh.experiment.id,
                  hypothesis: "Disrupt one predicted contact.",
                  rationale: "Falsify scaffold-only confidence.",
                  successCriterion: "The locked score degrades.",
                },
                createdAt: timestamp,
                nextReviewAt: "2026-08-11T12:00:00.000Z",
              })]
            : []
          return fresh
        },
        propose: async ({ iteration, context: fresh, scientistSessionId, workspaceKey }) => {
          events.push(`propose:${iteration}`)
          resumedScientistSessions.push(scientistSessionId)
          expect(workspaceKey).toBe("ses_parent")
          expect(fresh.knowledge).toHaveLength(iteration === 1 ? 0 : 1)
          expect(fresh.recentTrialEvidence).toHaveLength(iteration === 1 ? 0 : 1)
          expect(fresh.knowledgeCycles).toHaveLength(iteration === 1 ? 0 : 1)
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
    expect(resumedScientistSessions).toEqual([undefined, "ses_child_1", "ses_child_2"])
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

  test("returns a tool-triggered locked evaluation without executing the proposal twice", async () => {
    const events: string[] = []
    let executions = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ evaluateTrial }) => {
          const proposal: ResearchAutoresearch.Proposal = {
            childSessionId: "ses_persistent_scientist",
            draftPath: ".autofold/autoresearch/tool-evaluation/trial.py",
            program: "def build_program(bundle):\n    return bundle['candidateBudget'], bundle['submissionSize']\n",
            hypothesis: "Evaluate from inside the continuing scientist tool loop.",
            programFingerprint: digest("tool-evaluation"),
            semanticProgramFingerprint: digest("semantic-tool-evaluation"),
            workflowFingerprint: digest("workflow-tool-evaluation"),
            generatorPortfolio: ["boltzgen-binder"],
            generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 1, maximumGpuSeconds: 300 }],
            trialIntent: "optimize",
          }
          const evaluatedIteration = await evaluateTrial!(proposal)
          events.push("scientist-received-result")
          return { ...proposal, evaluatedIteration }
        },
        preflight: async () => {
          throw new Error("outer preflight must not rerun a tool-prepared proposal")
        },
        execute: async ({ proposal }) => {
          executions++
          return {
            status: "succeeded",
            childSessionId: proposal.childSessionId,
            draftPath: proposal.draftPath,
            trialId: "trl_tool_evaluated",
            runId: "run_tool_evaluated",
            programHash: proposal.programFingerprint,
            score: 0.19,
            valid: true,
            decision: "promoted",
          }
        },
      },
      undefined,
      {
        onProposal: async () => { events.push("proposal") },
        onRunStarted: async () => { events.push("run") },
        onIteration: async () => { events.push("iteration") },
      },
    )
    expect(executions).toBe(1)
    expect(events).toEqual(["proposal", "iteration", "scientist-received-result"])
    expect(result.iterations[0]).toMatchObject({
      status: "succeeded",
      childSessionId: "ses_persistent_scientist",
      trialId: "trl_tool_evaluated",
      runId: "run_tool_evaluated",
      score: 0.19,
      generatorPortfolio: ["boltzgen-binder"],
    })
  })

  test("commits fresh evidence between two evaluations in one continuous scientist turn", async () => {
    const events: string[] = []
    let contextLoads = 0
    let proposalTurns = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 2, agent: "biology" },
      {
        context: async () => {
          contextLoads++
          return context()
        },
        propose: async ({ evaluateTrial, evaluationLimit }) => {
          proposalTurns++
          expect(evaluationLimit).toBe(2)
          const first: ResearchAutoresearch.Proposal = {
            childSessionId: "ses_continuous_scientist",
            draftPath: ".autofold/autoresearch/continuous/trial.py",
            program: "def build_program(bundle):\n    return ('first', bundle['candidateBudget'], bundle['submissionSize'])\n",
            hypothesis: "Test the first generator configuration.",
            programFingerprint: digest("continuous-first"),
            semanticProgramFingerprint: digest("continuous-semantic-first"),
            workflowFingerprint: digest("continuous-workflow-first"),
            generatorPortfolio: ["boltzgen-binder"],
            generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 1, maximumGpuSeconds: 300 }],
          }
          const firstResult = await evaluateTrial!(first, 0)
          events.push("scientist-observed-first")
          const second: ResearchAutoresearch.Proposal = {
            ...first,
            program: "def build_program(bundle):\n    return ('second', bundle['candidateBudget'], bundle['submissionSize'])\n",
            hypothesis: "Mutate the generator configuration using the first result.",
            programFingerprint: digest("continuous-second"),
            semanticProgramFingerprint: digest("continuous-semantic-second"),
            workflowFingerprint: digest("continuous-workflow-second"),
          }
          const secondResult = await evaluateTrial!(second, 1)
          events.push("scientist-observed-second")
          return { ...second, evaluatedIterations: [firstResult, secondResult] }
        },
        preflight: async () => undefined,
        execute: async ({ iteration, proposal }) => ({
          status: "succeeded",
          childSessionId: proposal.childSessionId,
          draftPath: proposal.draftPath,
          trialId: `trl_continuous_${iteration}`,
          runId: `run_continuous_${iteration}`,
          programHash: proposal.programFingerprint,
          score: 0.3 - iteration * 0.01,
          valid: true,
          decision: "rejected",
        }),
      },
      undefined,
      {
        onProposal: async (iteration) => { events.push(`proposal-${iteration}`) },
        onIteration: async (iteration) => { events.push(`committed-${iteration.iteration}`) },
      },
    )
    expect(proposalTurns).toBe(1)
    expect(contextLoads).toBe(2)
    expect(events).toEqual([
      "proposal-1",
      "committed-1",
      "scientist-observed-first",
      "proposal-2",
      "committed-2",
      "scientist-observed-second",
    ])
    expect(result.iterations.map((iteration) => iteration.iteration)).toEqual([1, 2])
    expect(result.completedIterations).toBe(2)
  })

  test("honors an evidence-linked scientist stop without forcing another empirical trial", async () => {
    let executions = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 3, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ iteration }) => ({
          childSessionId: "ses_scientist",
          draftPath: ".autofold/autoresearch/stop/trial.py",
          program: "def build_program(bundle):\n    return bundle\n",
          hypothesis: "The observed plateau requires a campaign-level evaluator comparison.",
          evaluatedIteration: {
            iteration,
            status: "stopped",
            stopReason: "approval_required_contract_change",
            stopRationale: "The next falsifier changes the frozen evaluator and must be a separate experiment.",
            stopEvidenceRefs: ["trl_incumbent"],
          },
        }),
        preflight: async () => undefined,
        execute: async () => {
          executions++
          return { status: "succeeded" }
        },
      },
    )
    expect(executions).toBe(0)
    expect(result.stopReason).toBe("approval_required_contract_change")
    expect(result.iterations).toEqual([expect.objectContaining({
      status: "stopped",
      stopRationale: "The next falsifier changes the frozen evaluator and must be a separate experiment.",
      stopEvidenceRefs: ["trl_incumbent"],
    })])
  })

  test("resumes a durable stop checkpoint without authoring a later iteration", async () => {
    let proposals = 0
    const stopped = ResearchAutoresearch.Iteration.parse({
      iteration: 1,
      status: "stopped",
      stopReason: "improvement_plateau",
      stopRationale: "The comparable frontier has not improved after all generator families were exercised.",
      stopEvidenceRefs: ["trl_incumbent"],
    })
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 3, agent: "biology" },
      {
        context: async () => context(),
        propose: async () => {
          proposals++
          throw new Error("must not author after a durable stop")
        },
        preflight: async () => undefined,
        execute: async () => ({ status: "succeeded" }),
      },
      undefined,
      { iterations: { 1: stopped } },
    )
    expect(proposals).toBe(0)
    expect(result.stopReason).toBe("improvement_plateau")
    expect(result.iterations).toEqual([stopped])
  })

  test("yields a continuous scientist loop at a cross-plane boundary without calling it a stop", async () => {
    let executions = 0
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 10, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ iteration }) => ({
          childSessionId: "ses_scientist",
          draftPath: `.autofold/autoresearch/yield/${iteration}/trial.py`,
          program: "def build_program(bundle):\n    return bundle\n",
          hypothesis: "Produce one trusted result before refreshing literature.",
        }),
        preflight: async () => undefined,
        execute: async () => ({
          status: "succeeded",
          trialId: `trl_yield_${++executions}`,
          runId: `run_yield_${executions}`,
          score: 0.3,
          valid: true,
          decision: "rejected",
        }),
      },
      undefined,
      { shouldYield: async () => "knowledge_refresh" },
    )
    expect(executions).toBe(1)
    expect(result).toMatchObject({
      completedIterations: 1,
      yieldReason: "knowledge_refresh",
      iterations: [{ status: "succeeded" }],
    })
    expect(result.stopReason).toBeUndefined()
  })

  test("keeps repeated program fingerprints as provenance instead of a scientific veto", async () => {
    const frozen = context()
    const repeated = "def build_program(bundle):\n    return bundle['candidateBudget'], bundle['submissionSize']\n"
    frozen.history.trials[0]!.programHash = ResearchAutoresearch.programFingerprint(repeated)
    let executed = false
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => frozen,
        propose: async () => ({
          childSessionId: "ses_duplicate",
          draftPath: ".autofold/autoresearch/duplicate/trial.py",
          program: repeated,
          hypothesis: "Duplicate",
        }),
        preflight: async () => ({
          programFingerprint: ResearchAutoresearch.programFingerprint(repeated),
          semanticProgramFingerprint: digest("s"),
          workflowFingerprint: digest("w"),
          generatorPortfolio: [],
          generatorAllocations: [],
        }),
        execute: async () => {
          executed = true
          return { status: "succeeded" }
        },
      },
    )
    expect(executed).toBe(true)
    expect(result.stopReason).toBe("iteration_limit_reached")
    expect(result.iterations[0]?.status).toBe("succeeded")
  })

  test("records fingerprints without blocking a scientist-directed replication", async () => {
    const frozen = context()
    const workflowFingerprint = digest("w")
    frozen.incumbentCandidates = [{ sequence: "SAEEELRKLREELE" }]
    frozen.recentTrialEvidence = [{
      trial: {
        ...frozen.history.trials[0]!,
        id: "trl_prior_control",
        intent: "negative_control",
        workflowFingerprint,
      },
      run: {
        id: "run_prior_control",
        status: "succeeded",
        createdAt: timestamp,
        completedAt: timestamp,
      },
      candidates: [
        { sequence: "GAEEELRKLREELE" },
        { sequence: "SAEEGLRKLREELE" },
        { sequence: "SAEEELRKLREELG" },
      ],
      modelEvidence: [],
    }]
    let attempts = 0
    let executed = false
    const result = await ResearchAutoresearch.run(
      { experimentId: frozen.experiment.id, sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => frozen,
        propose: async () => ({
          childSessionId: `ses_static_${++attempts}`,
          draftPath: `.autofold/autoresearch/static-${attempts}/trial.py`,
          program: [
            `# helper refactor ${attempts}`,
            'a = Segment(sequence="GAEEELRKLREELE", sequence_type="protein")',
            'b = Segment(sequence="SAEEGLRKLREELE", sequence_type="protein")',
            'c = Segment(sequence="SAEEELRKLREELG", sequence_type="protein")',
            "def build_program(bundle):",
            "    return a, b, c",
          ].join("\n"),
          hypothesis: "Repeat the same static panel through refactored helpers.",
        }),
        preflight: async () => ({
          programFingerprint: digest(String(attempts)),
          semanticProgramFingerprint: digest(String(attempts + 3)),
          workflowFingerprint,
          generatorPortfolio: [],
          generatorAllocations: [],
          trialIntent: "negative_control",
        }),
        execute: async () => {
          executed = true
          return { status: "succeeded" }
        },
      },
      undefined,
      {
        intent: "negative_control",
        directive: {
          rationale: "Repeat the panel.",
          expectedInformationGain: "No new information.",
          generatorPolicy: "forbidden",
          preferredGenerators: [],
          baselineTrialId: frozen.incumbent!.id,
        },
      },
    )
    expect(executed).toBe(true)
    expect(attempts).toBe(1)
    expect(result.completedIterations).toBe(1)
  })

  test("permits an intentional equivalent replay only through an audited directive", async () => {
    const frozen = context()
    const repeated = "def build_program(bundle):\n    return bundle['candidateBudget'], bundle['submissionSize']\n"
    frozen.history.trials[0]!.programHash = ResearchAutoresearch.programFingerprint(repeated)
    let executed = false
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => frozen,
        propose: async () => ({
          childSessionId: "ses_replication",
          draftPath: ".autofold/autoresearch/replication/trial.py",
          program: repeated,
          hypothesis: "Replicate the exact program to measure infrastructure variance.",
        }),
        preflight: async () => undefined,
        execute: async () => {
          executed = true
          return { status: "succeeded", trialId: "trl_replication", runId: "run_replication", score: 0.3, valid: true, decision: "rejected" }
        },
      },
      undefined,
      {
        directive: {
          rationale: "Measure exact replay variance.",
          expectedInformationGain: "Separate stochastic variance from scientific improvement.",
          generatorPolicy: "optional",
          allowEquivalent: true,
          equivalenceJustification: "The experiment explicitly measures replay variance.",
        },
      },
    )
    expect(executed).toBe(true)
    expect(result.completedIterations).toBe(1)
  })

  test("leaves generator and workflow choice to the author by default", async () => {
    const frozen = context()
    frozen.protoGeneratorCatalog = [
      { key: "boltzgen-binder", usesGpu: true, toolsCalled: ["boltzgen-design"] },
      { key: "rfdiffusion-mpnn-binder", usesGpu: true, toolsCalled: ["rfdiffusion3-design", "proteinmpnn-sample"] },
    ]
    let observedPolicy: unknown = "unset"
    await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "ml" },
      {
        context: async () => frozen,
        propose: async ({ directive }) => {
          observedPolicy = directive?.searchPolicy
          return {
            childSessionId: "ses_agent_directed",
            draftPath: ".autofold/autoresearch/agent-directed/trial.py",
            program: "def build_program(bundle):\n    return bundle\n",
            hypothesis: "Let the author select the portfolio from evidence.",
          }
        },
        preflight: async () => undefined,
        execute: async () => ({ status: "succeeded", trialId: "trl_agent_directed", runId: "run_agent_directed", score: 0.3, valid: true, decision: "rejected" }),
      },
      undefined,
      {
        directive: {
          rationale: "Open the full registered execution space.",
          expectedInformationGain: "Let empirical evidence determine the next composition.",
          generatorPolicy: "required",
        },
      },
    )
    expect(observedPolicy).toBeUndefined()
  })

  test("derives a portfolio only when policy-guided mode is explicit", async () => {
    const frozen = context()
    frozen.protoGeneratorCatalog = [
      { key: "boltzgen-binder", usesGpu: true, toolsCalled: ["boltzgen-design"] },
      { key: "rfdiffusion-mpnn-binder", usesGpu: true, toolsCalled: ["rfdiffusion3-design", "proteinmpnn-sample"] },
    ]
    let observedPolicy: ResearchAutoresearch.Directive["searchPolicy"]
    await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "ml" },
      {
        context: async () => frozen,
        propose: async ({ directive }) => {
          observedPolicy = directive?.searchPolicy
          return {
            childSessionId: "ses_policy_guided",
            draftPath: ".autofold/autoresearch/policy-guided/trial.py",
            program: "def build_program(bundle):\n    return bundle\n",
            hypothesis: "Use an explicit empirical portfolio policy.",
          }
        },
        preflight: async () => undefined,
        execute: async () => ({ status: "succeeded", trialId: "trl_policy_guided", runId: "run_policy_guided", score: 0.3, valid: true, decision: "rejected" }),
      },
      undefined,
      {
        directive: {
          rationale: "Exercise the explicit portfolio policy.",
          expectedInformationGain: "Compare previously untested arms.",
          decisionMode: "policy_guided",
          generatorPolicy: "required",
        },
      },
    )
    expect(observedPolicy?.preferredGenerators).toEqual(["boltzgen-binder", "rfdiffusion-mpnn-binder"])
  })

  test("projects compact tested designs and hypotheses into the decision landscape", () => {
    const frozen = context()
    frozen.incumbentCandidates = [{ sequence: "CGVKLDDGKLIVTC" }]
    frozen.recentTrialEvidence = [{
      trial: {
        id: "trl_probe", parentTrialId: "trl_incumbent", hypothesis: "Probe D6", intent: "negative_control",
        programHash: digest("p"), status: "succeeded",
      },
      run: { id: "run_probe", status: "succeeded", createdAt: timestamp, completedAt: timestamp },
      evaluation: {
        id: "evl_probe", trialId: "trl_probe", contractHash: frozen.experiment.contractHash,
        evaluatorHash: digest("e"), valid: true, score: 0.4, diagnostics: {}, evaluatedAt: timestamp,
      },
      candidates: [{ sequence: "CGVKLGDGKLIVTC" }],
      modelEvidence: [],
    }]
    expect(ResearchAutoresearch.scientificDecisionLandscape(frozen)).toMatchObject({
      incumbent: { trialId: "trl_incumbent", sequences: ["CGVKLDDGKLIVTC"] },
      testedTrajectories: [{ trialId: "trl_probe", sequences: ["CGVKLGDGKLIVTC"], score: 0.4 }],
      priorHypotheses: [{ trialId: "trl_incumbent", hypothesis: "Baseline" }],
    })
  })

  test("reports an experiment plateau to the scientist without forcing a stop", () => {
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
    expect(ResearchAutoresearch.stoppingReason(frozen, undefined, "optimize")).toBeUndefined()
    expect(ResearchAutoresearch.plateauSignal(frozen)).toMatchObject({
      detected: true,
      patience: 4,
      allGeneratorFamiliesObserved: true,
    })
  })

  test("projects a direction-normalized hill-climb lineage and ignores controls", () => {
    const frozen = context()
    const base = frozen.history.trials[0]!
    frozen.history.trials = [
      { ...base, id: "trl_first", semanticProgramFingerprint: digest("1"), workflowFingerprint: digest("a"), generators: ["boltzgen-binder"] },
      { ...base, id: "trl_better", parentTrialId: "trl_first", semanticProgramFingerprint: digest("2"), workflowFingerprint: digest("b"), generators: ["pxdesign-binder"] },
      { ...base, id: "trl_worse", parentTrialId: "trl_better", semanticProgramFingerprint: digest("2"), workflowFingerprint: digest("b"), generators: ["boltzgen-binder"] },
      { ...base, id: "trl_control", intent: "negative_control", semanticProgramFingerprint: digest("3"), workflowFingerprint: digest("c"), generators: [] },
    ]
    frozen.history.evaluations = [
      { id: "evl_first", trialId: "trl_first", contractHash: frozen.experiment.contractHash, evaluatorHash: digest("e"), valid: true, score: 0.4, diagnostics: {}, evaluatedAt: "2026-08-04T12:00:01.000Z" },
      { id: "evl_better", trialId: "trl_better", contractHash: frozen.experiment.contractHash, evaluatorHash: digest("e"), valid: true, score: 0.3, diagnostics: {}, evaluatedAt: "2026-08-04T12:00:02.000Z" },
      { id: "evl_worse", trialId: "trl_worse", contractHash: frozen.experiment.contractHash, evaluatorHash: digest("e"), valid: true, score: 0.31, diagnostics: {}, evaluatedAt: "2026-08-04T12:00:03.000Z" },
      { id: "evl_control", trialId: "trl_control", contractHash: frozen.experiment.contractHash, evaluatorHash: digest("e"), valid: true, score: 0.01, diagnostics: {}, evaluatedAt: "2026-08-04T12:00:04.000Z" },
    ]
    const hillClimb = ResearchAutoresearch.hillClimbState(frozen)
    expect(hillClimb).toMatchObject({
      direction: "minimize",
      bestScore: 0.3,
      bestTrialId: "trl_better",
      scoredOptimizeTrials: 3,
      consecutiveNonImprovingTrials: 1,
      repeatedSemanticPrograms: [{ fingerprint: digest("2"), visits: 2 }],
      repeatedWorkflows: [{ fingerprint: digest("b"), visits: 2 }],
      steps: [
        { trialId: "trl_first", priorBestScore: null, improvedBest: true },
        { trialId: "trl_better", improvedBest: true },
        { trialId: "trl_worse", improvedBest: false },
      ],
    })
    expect(hillClimb.steps[1]?.improvementFromPriorBest).toBeCloseTo(0.1)
    expect(hillClimb.steps[2]?.improvementFromPriorBest).toBeCloseTo(-0.01)
  })

  test("benchmarks evidence-linked executable deltas without choosing the next move", () => {
    const frozen = context()
    const observation = (input: {
      id: string
      trialId: string
      runId: string
      score: number
      hypothesis: string
      semantic: string
      workflow: string
      generators: string[]
      createdAt: string
      decision?: "promoted" | "rejected"
    }) => ResearchDomain.SearchObservation.parse({
      id: input.id, campaignId: "cmp_auto", experimentId: "exp_auto",
      trialId: input.trialId, runId: input.runId,
      knowledgeId: `knw_${input.id}`, knowledgeCycleId: `kcy_${input.id}`,
      intent: "optimize", programHash: digest(input.semantic),
      semanticProgramFingerprint: digest(input.semantic), workflowFingerprint: digest(input.workflow),
      generatorPortfolio: input.generators, candidateSequences: ["ACDE"], modelIds: ["boltz2"], seeds: [7, 11],
      score: input.score, decision: input.decision ?? "rejected", diagnostics: {},
      hypothesis: input.hypothesis, epistemicLevel: "multi_seed_support", createdAt: input.createdAt,
    })
    const foreignPositive = observation({ id: "sobs_foreign_positive", trialId: "trl_foreign_positive", runId: "run_foreign_positive", score: 0.1, hypothesis: "Foreign positive control", semantic: "4", workflow: "d", generators: ["boltzgen-binder"], createdAt: "2026-08-04T12:00:04.000Z" })
    foreignPositive.experimentId = "exp_other"
    foreignPositive.calibrationClass = "known_positive"
    const foreignNegative = observation({ id: "sobs_foreign_negative", trialId: "trl_foreign_negative", runId: "run_foreign_negative", score: 0.9, hypothesis: "Foreign negative control", semantic: "5", workflow: "e", generators: ["boltzgen-binder"], createdAt: "2026-08-04T12:00:05.000Z" })
    foreignNegative.experimentId = "exp_other"
    foreignNegative.calibrationClass = "known_negative"
    frozen.searchLandscape = [
      observation({ id: "sobs_one", trialId: "trl_one", runId: "run_one", score: 0.4, hypothesis: "Baseline", semantic: "1", workflow: "a", generators: ["boltzgen-binder"], createdAt: "2026-08-04T12:00:01.000Z" }),
      observation({ id: "sobs_two", trialId: "trl_two", runId: "run_two", score: 0.3, hypothesis: "Run run_one motivates another generator", semantic: "2", workflow: "b", generators: ["pxdesign-binder"], createdAt: "2026-08-04T12:00:02.000Z", decision: "promoted" }),
      observation({ id: "sobs_three", trialId: "trl_three", runId: "run_three", score: 0.32, hypothesis: "Trial trl_two motivates a portfolio ablation", semantic: "3", workflow: "c", generators: ["boltzgen-binder", "pxdesign-binder"], createdAt: "2026-08-04T12:00:03.000Z" }),
      foreignPositive,
      foreignNegative,
    ]
    expect(ResearchAutoresearch.discoveryBenchmark(frozen)).toMatchObject({
      maturity: "operational",
      optimizeTrials: 3,
      empiricalTransitions: 2,
      evidenceLinkedTransitions: 2,
      nonEquivalentTransitions: 2,
      firstScore: 0.4,
      bestScore: 0.3,
      bestSingleGeneratorScore: 0.3,
      bestPortfolioScore: 0.32,
      evaluatorCalibration: { status: "unassessed" },
    })
  })

  test("does not accept a breakthrough label before evaluator calibration", () => {
    expect(() => ResearchAutoresearch.validateStopDecision(context(), {
      reason: "breakthrough",
      rationale: "A low score alone is not enough.",
      evidenceRefs: ["trl_incumbent"],
    })).toThrow("evaluator calibration is unassessed")
  })

  test("treats a lab-notebook contract recommendation as advisory inside a frozen experiment", () => {
    const frozen = context()
    frozen.knowledgeCycles = [ResearchDomain.KnowledgeCycle.parse({
      id: "kcy_boundary",
      campaignId: frozen.experiment.campaignId,
      trigger: "run_completed",
      question: "Does the next falsifier require a changed evaluator?",
      inputs: { knowledgeIds: [], claimIds: [], literatureIds: [] },
      outputs: { literatureIds: [], claimIds: [], alignmentIds: [], unresolvedQuestions: [] },
      generated: { by: "test", at: timestamp },
      nextExperiment: {
        action: "new_experiment",
        hypothesis: "Compare a competing evaluator contract.",
        rationale: "The current locked score cannot answer predictor validity.",
        successCriterion: "The evaluator comparison resolves the disagreement.",
      },
      createdAt: timestamp,
      nextReviewAt: "2026-08-11T12:00:00.000Z",
    })]
    expect(ResearchAutoresearch.stoppingReason(frozen, undefined, "optimize")).toBeUndefined()
    expect(ResearchAutoresearch.scientificDecisionLandscape(frozen)).toMatchObject({
      unresolvedQuestions: [],
    })
  })

  test("enforces the trusted campaign trial ceiling before authoring", () => {
    const frozen = context()
    frozen.campaignCharter.constraints.maximumCampaignTrials = 1
    expect(ResearchAutoresearch.stoppingReason(frozen, undefined, "optimize")).toBe("budget_exhausted")
  })

  test("turns successful per-candidate predictor disagreement into replay-gated skill feedback", () => {
    const signal = ResearchAutoresearch.predictorDisagreementSignal([
      { candidateId: "candidate_a", modelId: "boltz2", seed: 7, status: "completed", metrics: { iptm: 0.82 } },
      { candidateId: "candidate_a", modelId: "chai1", seed: 7, status: "completed", metrics: { confidence_score: 0.54 } },
      { candidateId: "candidate_b", modelId: "boltz2", seed: 7, status: "completed", metrics: { iptm: 0.73 } },
      { candidateId: "candidate_b", modelId: "chai1", seed: 7, status: "completed", metrics: { confidence_score: 0.69 } },
    ])
    expect(signal).toMatchObject({
      candidateId: "candidate_a",
      modelIds: ["boltz2", "chai1"],
      threshold: 0.15,
    })
    expect(signal?.confidenceRange).toBeCloseTo(0.28)
    const iteration = ResearchAutoresearch.Iteration.parse({
      iteration: 1,
      status: "succeeded",
      trialId: "trl_disagreement",
      runId: "run_disagreement",
      score: 0.2,
      valid: true,
      decision: "promoted",
      predictorDisagreement: signal,
    })
    expect(ResearchAutoresearch.skillFeedbackForIteration("exp_disagreement", iteration)).toMatchObject([{
      skillId: "skill_bionemo.predictor-interpretation",
      trigger: "predictor_disagreement",
      trajectoryRefs: ["exp_disagreement", "trl_disagreement", "run_disagreement"],
      requiresShadowReplay: true,
    }])
  })

  test("does not misclassify another existing experiment pointer as a contract change", () => {
    const frozen = context()
    frozen.knowledgeCycles = [ResearchDomain.KnowledgeCycle.parse({
      id: "kcy_other_existing",
      campaignId: frozen.experiment.campaignId,
      trigger: "run_completed",
      question: "Which active experiment should continue?",
      inputs: { knowledgeIds: [], claimIds: [], literatureIds: [] },
      outputs: { literatureIds: [], claimIds: [], alignmentIds: [], unresolvedQuestions: [] },
      generated: { by: "test", at: timestamp },
      nextExperiment: {
        action: "continue_experiment",
        experimentId: "exp_other_active",
        hypothesis: "Continue the other frozen contract.",
        rationale: "Campaign-level evidence preferred it.",
        successCriterion: "Its locked score improves.",
      },
      createdAt: timestamp,
      nextReviewAt: "2026-08-11T12:00:00.000Z",
    })]
    expect(ResearchAutoresearch.stoppingReason(frozen, undefined, "negative_control")).toBeUndefined()
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

  test("repairs an authoring failure inside the same scientific iteration", async () => {
    let proposals = 0
    let iterationTwoAttempts = 0
    const attempts: ResearchAutoresearch.AuthoringAttempt[] = []
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 4, agent: "biology" },
      {
        context: async () => context(),
        propose: async ({ iteration, recovery }) => {
          proposals++
          if (iteration === 2 && iterationTwoAttempts++ === 0) throw new Error("child did not produce a valid draft")
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
      undefined,
      { onAuthoringAttempt: async (attempt) => { attempts.push(attempt) } },
    )

    expect(proposals).toBe(5)
    expect(result.completedIterations).toBe(4)
    expect(result.stopReason).toBe("iteration_limit_reached")
    expect(result.iterations[1]).toMatchObject({ status: "succeeded", authoringAttempts: 2 })
    expect(attempts.filter((attempt) => attempt.iteration === 2).map((attempt) => attempt.status)).toEqual(["failed", "ready"])
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
    expect(result.stopReason).toBe("iteration_limit_reached")
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

  test("anchors a static-control iteration to the incumbent rather than the optimize search head", async () => {
    const frozen = context()
    frozen.searchHead = ResearchDomain.Trial.parse({
      ...frozen.incumbent!,
      id: "trl_latest_rejected",
      parentTrialId: frozen.incumbent!.id,
      hypothesis: "Latest rejected exploration",
      programHash: digest("f"),
    })
    frozen.searchHeadProgram = "def build_program(bundle):\n    return 'latest attempt'\n"
    const result = await ResearchAutoresearch.run(
      { experimentId: "exp_auto", sessionId: "ses_parent", iterations: 1, agent: "biology" },
      {
        context: async () => frozen,
        propose: async () => ({
          childSessionId: "ses_control",
          draftPath: ".autofold/autoresearch/control/trial.py",
          program: "def build_program(bundle):\n    return 'control'\n",
          hypothesis: "Static incumbent control",
        }),
        preflight: async () => undefined,
        execute: async () => ({ status: "succeeded", trialId: "trl_control", runId: "run_control" }),
      },
      undefined,
      {
        intent: "negative_control",
        directive: {
          rationale: "Run a static incumbent control.",
          expectedInformationGain: "Test one residue without generation.",
          generatorPolicy: "forbidden",
          preferredGenerators: [],
        },
      },
    )
    expect(result.iterations[0]?.parentTrialId).toBe("trl_incumbent")
    expect(result.iterations[0]?.searchPolicy).toBeUndefined()
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
      "preflight",
      "proposal-checkpoint:2",
      "execute:run_two:job_resume",
      "run-checkpoint:2",
      "iteration-checkpoint:2",
    ])
  })
})
