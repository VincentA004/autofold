import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchArtifacts } from "./artifacts"
import { ResearchDomain } from "./domain"
import { ExecutionProtocol } from "./execution-protocol"
import { ResearchService } from "./service"
import { MemoryResearchStore } from "./store"

const workerRoot = path.resolve(import.meta.dir, "../../../worker")
const workerScript = path.join(workerRoot, "run_worker.py")
const evaluatorSource = path.join(workerRoot, "autofold_worker", "evaluate.py")
const peptideEvaluatorSource = path.join(workerRoot, "autofold_worker", "peptide_panel_v1.py")
const fixtureEvidenceSource = path.join(workerRoot, "autofold_worker", "evidence_fixture_v1.py")
const protoSmokeTrial = path.join(workerRoot, "tests", "fixtures", "proto_smoke_trial.py")
const protoScientificTrial = path.join(workerRoot, "tests", "fixtures", "proto_scientific_trial.py")
const protoRoot = path.join(os.homedir(), "Developer", "repo_store", "github.com-evo-design-proto-language")
const protoPython = path.resolve(import.meta.dir, "../../../../.autofold/envs/proto/bin/python")

async function hashFile(file: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(await Bun.file(file).arrayBuffer())
  return `sha256:${hash.digest("hex")}`
}

async function runWorker(
  bundle: string,
  output: string,
  python = "python3",
  evaluator = evaluatorSource,
  evidenceAdapter?: string,
) {
  const process = Bun.spawn(
    [
      python,
      workerScript,
      "--bundle",
      bundle,
      "--output",
      output,
      "--evaluator-source",
      evaluator,
      ...(evidenceAdapter ? ["--evidence-adapter-source", evidenceAdapter] : []),
    ],
    {
      cwd: path.dirname(workerRoot),
      env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
  return { exitCode, stderr }
}

describe("research execution worker", () => {
  test("continues to parse legacy v1 bundles without target paths", () => {
    const legacy = ExecutionProtocol.TrialBundle.parse({
      format: "autofold.trial-bundle.v1",
      runId: "run_legacy",
      trialId: "trl_legacy",
      contractHash: `sha256:${"a".repeat(64)}`,
      designAdapter: "mock",
      programPath: "/immutable/trial.py",
      programHash: `sha256:${"b".repeat(64)}`,
      modality: "short_peptide",
      evaluator: {
        id: "mock-peptide-panel",
        version: "1",
        sourceHash: `sha256:${"c".repeat(64)}`,
        direction: "minimize",
      },
      seeds: [7],
      candidateBudget: 8,
      submissionSize: 3,
    })
    expect(legacy.format).toBe("autofold.trial-bundle.v1")
    expect("targetArtifactHash" in legacy).toBe(false)
  })

  test("rejects evidence authored by an agent-editable v3 trial", async () => {
    const script = [
      "from autofold_worker.adapters.proto import _normalize",
      "bundle = {'format':'autofold.trial-bundle.v3','evaluator':{'id':'peptide-panel','version':'1'},'seeds':[7],'candidateBudget':1,'modality':'short_peptide','runId':'run_trust','trialId':'trl_trust','targetArtifactHash':'sha256:' + 'a' * 64}",
      "_normalize([{'sequence':'ACDEFG','generation':{},'evidence':{}}], bundle)",
    ].join("\n")
    const process = Bun.spawn(["python3", "-c", script], {
      cwd: workerRoot,
      env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Trial programs may not provide trusted generation or evaluator evidence")
  })

  test("replays identical bundles deterministically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      const evaluatorHash = await hashFile(evaluatorSource)
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# deterministic mock trial\n")
      const programHash = await hashFile(programPath)
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: "run_deterministic",
        trialId: "trl_deterministic",
        contractHash: `sha256:${"a".repeat(64)}`,
        targetArtifactHash: `sha256:${"c".repeat(64)}`,
        designAdapter: "mock",
        programPath,
        programHash,
        modality: "linear_minibinder",
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: evaluatorHash,
          direction: "minimize",
        },
        seeds: [41, 42, 43],
        candidateBudget: 64,
        submissionSize: 12,
      })
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))

      expect((await runWorker(bundlePath, path.join(root, "one"))).exitCode).toBe(0)
      expect((await runWorker(bundlePath, path.join(root, "two"))).exitCode).toBe(0)

      const candidatesOne = await Bun.file(path.join(root, "one", "candidates.json")).text()
      const candidatesTwo = await Bun.file(path.join(root, "two", "candidates.json")).text()
      const resultOne = await Bun.file(path.join(root, "one", "result.json")).text()
      const resultTwo = await Bun.file(path.join(root, "two", "result.json")).text()
      expect(candidatesOne).toBe(candidatesTwo)
      expect(resultOne).toBe(resultTwo)
      ExecutionProtocol.CandidateSet.parse(JSON.parse(candidatesOne))
      ExecutionProtocol.EvaluationResult.parse(JSON.parse(resultOne))
      ExecutionProtocol.RunManifest.parse(await Bun.file(path.join(root, "one", "manifest.json")).json())
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("resolves portable bundle resources beside bundle.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-portable-bundle-"))
    try {
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# portable mock trial\n")
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: "run_portable",
        trialId: "trl_portable",
        contractHash: `sha256:${"a".repeat(64)}`,
        targetArtifactHash: `sha256:${"c".repeat(64)}`,
        designAdapter: "mock",
        programPath: "trial.py",
        programHash: await hashFile(programPath),
        modality: "short_peptide",
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: await hashFile(evaluatorSource),
          direction: "minimize",
        },
        seeds: [7],
        candidateBudget: 4,
        submissionSize: 2,
      })
      const bundlePath = path.join(root, "bundle.json")
      const output = path.join(root, "output")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))
      expect((await runWorker(bundlePath, output)).exitCode).toBe(0)
      const manifest = ExecutionProtocol.RunManifest.parse(await Bun.file(path.join(output, "manifest.json")).json())
      expect(manifest.files.bundle).toBe(await hashFile(bundlePath))
      expect(manifest.files.program).toBe(await hashFile(programPath))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("refuses to run when the evaluator source is not frozen by the contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# evaluator mismatch trial\n")
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: "run_mismatch",
        trialId: "trl_mismatch",
        contractHash: `sha256:${"a".repeat(64)}`,
        targetArtifactHash: `sha256:${"c".repeat(64)}`,
        designAdapter: "mock",
        programPath,
        programHash: await hashFile(programPath),
        modality: "short_peptide",
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: `sha256:${"f".repeat(64)}`,
          direction: "minimize",
        },
        seeds: [41],
        candidateBudget: 4,
        submissionSize: 2,
      })
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))
      const result = await runWorker(bundlePath, path.join(root, "output"))
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("Evaluator hash mismatch")
      expect(await Bun.file(path.join(root, "output", "result.json")).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("refuses to run when immutable trial.py no longer matches its hash", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# mutated after trial creation\n")
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: "run_program_mismatch",
        trialId: "trl_program_mismatch",
        contractHash: `sha256:${"a".repeat(64)}`,
        targetArtifactHash: `sha256:${"c".repeat(64)}`,
        designAdapter: "mock",
        programPath,
        programHash: `sha256:${"f".repeat(64)}`,
        modality: "short_peptide",
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: await hashFile(evaluatorSource),
          direction: "minimize",
        },
        seeds: [41],
        candidateBudget: 4,
        submissionSize: 2,
      })
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))
      const result = await runWorker(bundlePath, path.join(root, "output"))
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("Program hash mismatch")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("refuses to run when a frozen target artifact is mutated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      const programPath = path.join(root, "trial.py")
      const targetPath = path.join(root, "target.json")
      await fs.writeFile(programPath, "# target integrity trial\n")
      await fs.writeFile(targetPath, '{"format":"autofold.target-artifact.v1","name":"before"}\n')
      const targetArtifactHash = await hashFile(targetPath)
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: "run_target_mismatch",
        trialId: "trl_target_mismatch",
        contractHash: `sha256:${"a".repeat(64)}`,
        targetArtifactHash,
        targetArtifactPath: targetPath,
        designAdapter: "mock",
        programPath,
        programHash: await hashFile(programPath),
        modality: "short_peptide",
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: await hashFile(evaluatorSource),
          direction: "minimize",
        },
        seeds: [41],
        candidateBudget: 4,
        submissionSize: 2,
      })
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))
      await fs.writeFile(targetPath, '{"format":"autofold.target-artifact.v1","name":"after"}\n')

      const result = await runWorker(bundlePath, path.join(root, "output"))
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("Target artifact hash mismatch")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("runs a pinned Proto program deterministically on CPU", async () => {
    const protoInstalled = await Promise.all([fs.access(protoPython), fs.access(path.join(protoRoot, "proto_language"))]).then(
      () => true,
      () => false,
    )
    if (!protoInstalled) {
      console.warn("Skipping Proto smoke test: pinned local runtime is not installed")
      return
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-proto-worker-"))
    try {
      const programPath = path.join(root, "trial.py")
      await fs.copyFile(protoSmokeTrial, programPath)
      const languageCommit = (await Bun.$`git -C ${protoRoot} rev-parse HEAD`.text()).trim()
      const toolsCommit = (await Bun.$`git -C ${path.join(protoRoot, "proto-tools")} rev-parse HEAD`.text()).trim()
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: "run_proto_smoke",
        trialId: "trl_proto_smoke",
        contractHash: `sha256:${"b".repeat(64)}`,
        targetArtifactHash: `sha256:${"c".repeat(64)}`,
        designAdapter: "proto",
        programPath,
        programHash: await hashFile(programPath),
        modality: "short_peptide",
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: await hashFile(evaluatorSource),
          direction: "minimize",
        },
        proto: { root: protoRoot, languageCommit, toolsCommit },
        seeds: [2026],
        candidateBudget: 8,
        submissionSize: 3,
      })
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))

      const first = await runWorker(bundlePath, path.join(root, "one"), protoPython)
      expect(first.exitCode, first.stderr).toBe(0)
      const second = await runWorker(bundlePath, path.join(root, "two"), protoPython)
      expect(second.exitCode, second.stderr).toBe(0)

      const candidatesOne = await Bun.file(path.join(root, "one", "candidates.json")).text()
      const candidatesTwo = await Bun.file(path.join(root, "two", "candidates.json")).text()
      expect(candidatesOne).toBe(candidatesTwo)
      const candidates = ExecutionProtocol.CandidateSet.parse(JSON.parse(candidatesOne))
      expect(candidates.candidates).toHaveLength(3)
      expect(candidates.candidates.every((candidate) => /^[ACDEFGHIKLMNPQRSTVWY]+$/.test(candidate.sequence))).toBe(true)
      const result = ExecutionProtocol.EvaluationResult.parse(
        await Bun.file(path.join(root, "one", "result.json")).json(),
      )
      expect(result.designAdapter).toBe("proto")
      expect(result.valid).toBe(true)
      const manifest = ExecutionProtocol.RunManifest.parse(
        await Bun.file(path.join(root, "one", "manifest.json")).json(),
      )
      expect(manifest.files.program).toBe(bundle.programHash)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("scores artifact-backed peptide evidence against a frozen target deterministically", async () => {
    const protoInstalled = await Promise.all([fs.access(protoPython), fs.access(path.join(protoRoot, "proto_language"))]).then(
      () => true,
      () => false,
    )
    if (!protoInstalled) {
      console.warn("Skipping scientific Proto test: pinned local runtime is not installed")
      return
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-scientific-worker-"))
    try {
      const structure = Buffer.from("data_deterministic_receptor\n#\n")
      const structureHash = new Bun.CryptoHasher("sha256")
      structureHash.update(structure)
      const target = await ResearchArtifacts.authorTarget(root, {
        format: "autofold.target-artifact.v1",
        name: "Deterministic receptor fixture",
        chains: [{ id: "A", sequence: "ACDEFGHIKLMNPQRSTVWYACDEFGHIKLMNPQRSTVWY" }],
        structure: { format: "mmcif", contentHash: `sha256:${structureHash.digest("hex")}` },
        bindingSite: {
          residues: [
            { chainId: "A", position: 8 },
            { chainId: "A", position: 13 },
          ],
        },
      }, structure)
      const programPath = path.join(root, "trial.py")
      await fs.copyFile(protoScientificTrial, programPath)
      const languageCommit = (await Bun.$`git -C ${protoRoot} rev-parse HEAD`.text()).trim()
      const toolsCommit = (await Bun.$`git -C ${path.join(protoRoot, "proto-tools")} rev-parse HEAD`.text()).trim()
      const evidenceAdapterHash = await hashFile(fixtureEvidenceSource)
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v3",
        runId: "run_scientific_panel",
        trialId: "trl_scientific_panel",
        contractHash: `sha256:${"d".repeat(64)}`,
        targetArtifactHash: target.targetArtifactHash,
        targetArtifactPath: path.join(root, target.targetArtifactPath),
        targetStructurePath: path.join(root, target.structureArtifactPath!),
        evidenceAdapter: {
          id: "evidence-fixture",
          version: "fixture-1",
          sourceHash: evidenceAdapterHash,
        },
        designAdapter: "proto",
        programPath,
        programHash: await hashFile(programPath),
        modality: "short_peptide",
        evaluator: {
          id: "peptide-panel",
          version: "1",
          sourceHash: await hashFile(peptideEvaluatorSource),
          direction: "minimize",
        },
        proto: { root: protoRoot, languageCommit, toolsCommit },
        seeds: [7, 11, 23],
        candidateBudget: 8,
        submissionSize: 3,
      })
      const bundlePath = path.join(root, "bundle.json")
      await fs.writeFile(bundlePath, JSON.stringify(bundle))

      const mismatchedBundle = JSON.parse(JSON.stringify(bundle))
      mismatchedBundle.evidenceAdapter.sourceHash = `sha256:${"f".repeat(64)}`
      const mismatchedBundlePath = path.join(root, "mismatched-bundle.json")
      await fs.writeFile(mismatchedBundlePath, JSON.stringify(mismatchedBundle))
      const rejected = await runWorker(
        mismatchedBundlePath,
        path.join(root, "rejected"),
        protoPython,
        peptideEvaluatorSource,
        fixtureEvidenceSource,
      )
      expect(rejected.exitCode).toBe(2)
      expect(rejected.stderr).toContain("Evidence adapter hash mismatch")

      const first = await runWorker(
        bundlePath,
        path.join(root, "one"),
        protoPython,
        peptideEvaluatorSource,
        fixtureEvidenceSource,
      )
      expect(first.exitCode, first.stderr).toBe(0)
      const second = await runWorker(
        bundlePath,
        path.join(root, "two"),
        protoPython,
        peptideEvaluatorSource,
        fixtureEvidenceSource,
      )
      expect(second.exitCode, second.stderr).toBe(0)

      const candidatesOne = await Bun.file(path.join(root, "one", "candidates.json")).text()
      const candidatesTwo = await Bun.file(path.join(root, "two", "candidates.json")).text()
      const resultOne = await Bun.file(path.join(root, "one", "result.json")).text()
      const resultTwo = await Bun.file(path.join(root, "two", "result.json")).text()
      expect(candidatesOne).toBe(candidatesTwo)
      expect(resultOne).toBe(resultTwo)

      const candidates = ExecutionProtocol.CandidateSetV2.parse(JSON.parse(candidatesOne))
      expect(candidates.targetArtifactHash).toBe(target.targetArtifactHash)
      expect(candidates.candidates).toHaveLength(3)
      expect(candidates.candidates[0]?.evidence.predictors).toHaveLength(3)
      const modelRuns = ExecutionProtocol.ModelRunIndex.parse(
        await Bun.file(path.join(root, "one", "model-runs", "index.json")).json(),
      )
      expect(modelRuns.entries).toHaveLength(9)
      const firstModelRun = ExecutionProtocol.ModelRunArtifact.parse(
        await Bun.file(path.join(root, "one", modelRuns.entries[0]!.artifactPath)).json(),
      )
      expect(firstModelRun.model.adapterSourceHash).toBe(evidenceAdapterHash)
      const result = ExecutionProtocol.EvaluationResult.parse(JSON.parse(resultOne))
      expect(result.valid).toBe(true)
      expect(result.evidenceAdapterHash).toBe(evidenceAdapterHash)
      expect(result.score).toBeGreaterThan(0)
      expect(result.score).toBeLessThan(1)
      expect(result.diagnostics.yield_fraction).toBe(1)
      const manifest = ExecutionProtocol.RunManifest.parse(
        await Bun.file(path.join(root, "one", "manifest.json")).json(),
      )
      expect(manifest.files.target).toBe(target.targetArtifactHash)
      expect(manifest.files.target_structure).toBe(target.artifact.structure!.contentHash)
      expect(manifest.files.model_runs).toBe(await hashFile(path.join(root, "one", "model-runs", "index.json")))
      expect(manifest.evidenceAdapterHash).toBe(evidenceAdapterHash)
      expect(manifest.files.candidates).toBe(await hashFile(path.join(root, "one", "candidates.json")))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("records worker output and promotion as one completed run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      let sequence = 0
      const projectId = "project-execution"
      const service = new ResearchService.Service(new MemoryResearchStore(), {
        id: (prefix) => `${prefix}_${++sequence}`,
      })
      const evaluatorHash = await hashFile(evaluatorSource)
      const contract: ResearchDomain.ExperimentContract = {
        version: 1,
        objective: "Discover binders for target X",
        targetArtifactHash: `sha256:${"a".repeat(64)}`,
        modality: "linear_minibinder",
        budget: { maximumCandidates: 32, gpuHours: 1, wallTimeMinutes: 5 },
        evaluator: {
          id: "mock-peptide-panel",
          version: "1",
          sourceHash: evaluatorHash,
          direction: "minimize",
          fixedSeeds: [41, 42],
          submissionSize: 8,
        },
      }
      const campaign = await service.createCampaign(projectId, { objective: "Find a binder" })
      await service.activateCampaign(projectId, campaign.id)
      let experiment = await service.createExperiment(projectId, campaign.id, { contract })
      experiment = await service.activateExperiment(projectId, experiment.id)
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# integration mock trial\n")
      const programHash = await hashFile(programPath)
      const trial = await service.createTrial(projectId, experiment.id, {
        hypothesis: "Deterministic baseline",
        designAdapter: "mock",
        programPath,
        programHash,
      })
      const bundlePath = path.join(root, "bundle.json")
      const outputPath = path.join(root, "output")
      const run = await service.beginRun(projectId, trial.id, {
        runId: "run_integration",
        bundlePath,
        outputPath,
      })
      await service.attachRunJob(projectId, run.id, "job-mock")
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v2",
        runId: run.id,
        trialId: trial.id,
        contractHash: experiment.contractHash,
        targetArtifactHash: contract.targetArtifactHash,
        designAdapter: trial.designAdapter,
        programPath,
        programHash: trial.programHash,
        modality: contract.modality,
        evaluator: {
          id: contract.evaluator.id,
          version: contract.evaluator.version,
          sourceHash: contract.evaluator.sourceHash,
          direction: contract.evaluator.direction,
        },
        seeds: contract.evaluator.fixedSeeds,
        candidateBudget: contract.budget.maximumCandidates,
        submissionSize: contract.evaluator.submissionSize,
      })
      await fs.writeFile(bundlePath, JSON.stringify(bundle))
      expect((await runWorker(bundlePath, outputPath)).exitCode).toBe(0)

      const result = ExecutionProtocol.EvaluationResult.parse(
        await Bun.file(path.join(outputPath, "result.json")).json(),
      )
      const completed = await service.completeRun(
        projectId,
        run.id,
        {
          contractHash: result.contractHash,
          evaluatorHash: result.evaluatorHash,
          valid: result.valid,
          score: result.score,
          diagnostics: result.diagnostics,
        },
        await hashFile(path.join(outputPath, "manifest.json")),
      )
      expect(completed.run.status).toBe("succeeded")
      expect(completed.decision).toBe("promoted")
      expect(completed.experiment.incumbentTrialId).toBe(trial.id)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
