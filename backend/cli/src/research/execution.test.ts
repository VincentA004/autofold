import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchDomain } from "./domain"
import { ExecutionProtocol } from "./execution-protocol"
import { ResearchService } from "./service"
import { MemoryResearchStore } from "./store"

const workerRoot = path.resolve(import.meta.dir, "../../../worker")
const workerScript = path.join(workerRoot, "run_worker.py")
const evaluatorSource = path.join(workerRoot, "autofold_worker", "evaluate.py")
const protoSmokeTrial = path.join(workerRoot, "tests", "fixtures", "proto_smoke_trial.py")
const protoRoot = path.join(os.homedir(), "Developer", "repo_store", "github.com-evo-design-proto-language")
const protoPython = path.resolve(import.meta.dir, "../../../../.autofold/envs/proto/bin/python")

async function hashFile(file: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(await Bun.file(file).arrayBuffer())
  return `sha256:${hash.digest("hex")}`
}

async function runWorker(bundle: string, output: string, python = "python3") {
  const process = Bun.spawn(
    [python, workerScript, "--bundle", bundle, "--output", output, "--evaluator-source", evaluatorSource],
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
  test("replays identical bundles deterministically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      const evaluatorHash = await hashFile(evaluatorSource)
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# deterministic mock trial\n")
      const programHash = await hashFile(programPath)
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v1",
        runId: "run_deterministic",
        trialId: "trl_deterministic",
        contractHash: `sha256:${"a".repeat(64)}`,
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

  test("refuses to run when the evaluator source is not frozen by the contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-worker-"))
    try {
      const programPath = path.join(root, "trial.py")
      await fs.writeFile(programPath, "# evaluator mismatch trial\n")
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: "autofold.trial-bundle.v1",
        runId: "run_mismatch",
        trialId: "trl_mismatch",
        contractHash: `sha256:${"a".repeat(64)}`,
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
        format: "autofold.trial-bundle.v1",
        runId: "run_program_mismatch",
        trialId: "trl_program_mismatch",
        contractHash: `sha256:${"a".repeat(64)}`,
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
        format: "autofold.trial-bundle.v1",
        runId: "run_proto_smoke",
        trialId: "trl_proto_smoke",
        contractHash: `sha256:${"b".repeat(64)}`,
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
        format: "autofold.trial-bundle.v1",
        runId: run.id,
        trialId: trial.id,
        contractHash: experiment.contractHash,
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
