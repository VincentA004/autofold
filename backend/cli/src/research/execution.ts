import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "@/compute/jobs"
import { ExecutionAuthority } from "@/project/execution"
import { Instance } from "@/project/instance"
import { Research, ResearchService } from "./service"
import { ResearchArtifacts } from "./artifacts"
import { ExecutionProtocol } from "./execution-protocol"
import { ResearchDomain } from "./domain"
import { DesignAdapters } from "./adapters"

const workerRoot = path.resolve(import.meta.dir, "../../../worker")
const workerScript = path.join(workerRoot, "run_worker.py")
const mockEvaluatorSource = path.join(workerRoot, "autofold_worker", "evaluate.py")
const peptideEvaluatorSource = path.join(workerRoot, "autofold_worker", "peptide_panel_v1.py")
const finalizers = new Map<string, Promise<void>>()

async function fileHash(file: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(await Bun.file(file).arrayBuffer())
  return `sha256:${hash.digest("hex")}`
}

async function writeJSON(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temporary, file)
}

function inside(root: string, relative: string): string {
  const target = path.resolve(root, relative)
  const relation = path.relative(root, target)
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Research run path escapes the project: ${relative}`)
  }
  return target
}

export namespace ResearchExecution {
  export interface EvaluatorInfo {
    id: string
    version: string
    sourceHash: string
    direction: "minimize" | "maximize"
    implementation: string
  }

  interface InstalledEvaluator extends EvaluatorInfo {
    sourcePath: string
    requiresTargetArtifact: boolean
  }

  async function installedEvaluators(): Promise<InstalledEvaluator[]> {
    return [
      {
        id: "mock-peptide-panel",
        version: "1",
        sourceHash: await fileHash(mockEvaluatorSource),
        direction: "minimize",
        implementation: "python-stdlib-sequence-heuristic",
        sourcePath: mockEvaluatorSource,
        requiresTargetArtifact: false,
      },
      {
        id: "peptide-panel",
        version: "1",
        sourceHash: await fileHash(peptideEvaluatorSource),
        direction: "minimize",
        implementation: "python-stdlib-locked-evidence-panel",
        sourcePath: peptideEvaluatorSource,
        requiresTargetArtifact: true,
      },
    ]
  }

  export async function evaluators(): Promise<EvaluatorInfo[]> {
    return (await installedEvaluators()).map(({ sourcePath: _sourcePath, requiresTargetArtifact: _required, ...info }) => info)
  }

  export async function start(input: { trialId: string; sessionId: string }): Promise<ResearchDomain.Run> {
    const projectId = Instance.project.id
    const context = await Research.getTrialContext(projectId, input.trialId)
    const adapter = await DesignAdapters.get(context.trial.designAdapter, Instance.directory)
    if (!adapter.available) {
      throw new ResearchService.ConflictError({
        code: "design_adapter_unavailable",
        message: adapter.reason ?? `Design adapter ${adapter.id} is unavailable`,
      })
    }
    const installed = (await installedEvaluators()).find(
      (candidate) =>
        candidate.id === context.experiment.contract.evaluator.id &&
        candidate.version === context.experiment.contract.evaluator.version,
    )
    if (!installed) {
      throw new ResearchService.ConflictError({
        code: "evaluator_not_installed",
        message: `Evaluator ${context.experiment.contract.evaluator.id}@${context.experiment.contract.evaluator.version} is not installed`,
      })
    }
    if (installed.sourceHash !== context.experiment.contract.evaluator.sourceHash) {
      throw new ResearchService.ConflictError({
        code: "evaluator_source_mismatch",
        message: "The installed evaluator source does not match the frozen experiment contract",
      })
    }
    const storedTarget = installed.requiresTargetArtifact
      ? await ResearchArtifacts.readTarget(Instance.directory, context.experiment.contract.targetArtifactHash).catch(() => {
          throw new ResearchService.ConflictError({
            code: "target_artifact_unavailable",
            message: `Target artifact ${context.experiment.contract.targetArtifactHash} is not available or no longer valid`,
          })
        })
      : undefined

    // Authorization is a precondition, not a run outcome. Check it before
    // beginRun mutates the proposed trial into a running state so a denied
    // launch can be retried after trust or sandbox remediation.
    await ExecutionAuthority.require({
      projectID: projectId,
      sessionID: input.sessionId,
      capability: "local_job",
    })

    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`
    const root = path.posix.join(".autofold", "runs", runId)
    const bundlePath = path.posix.join(root, "bundle.json")
    const programPath = path.posix.join(root, "trial.py")
    const targetPath = storedTarget ? path.posix.join(root, "target.json") : undefined
    const outputPath = path.posix.join(root, "output")
    const run = await Research.beginRun(projectId, input.trialId, { runId, bundlePath, outputPath })
    const bundle = ExecutionProtocol.TrialBundle.parse({
      format: "autofold.trial-bundle.v2",
      runId,
      trialId: context.trial.id,
      contractHash: context.experiment.contractHash,
      targetArtifactHash: context.experiment.contract.targetArtifactHash,
      targetArtifactPath: targetPath ? inside(Instance.directory, targetPath) : undefined,
      designAdapter: context.trial.designAdapter,
      programPath: inside(Instance.directory, programPath),
      programHash: context.trial.programHash,
      modality: context.experiment.contract.modality,
      evaluator: {
        id: installed.id,
        version: installed.version,
        sourceHash: installed.sourceHash,
        direction: installed.direction,
      },
      proto: adapter.proto,
      seeds: context.experiment.contract.evaluator.fixedSeeds,
      candidateBudget: context.experiment.contract.budget.maximumCandidates,
      submissionSize: context.experiment.contract.evaluator.submissionSize,
    })
    const absoluteBundle = inside(Instance.directory, bundlePath)
    const sourceProgram = inside(Instance.directory, context.trial.programPath)
    const absoluteProgram = inside(Instance.directory, programPath)
    const absoluteTarget = targetPath ? inside(Instance.directory, targetPath) : undefined
    const absoluteOutput = inside(Instance.directory, outputPath)

    try {
      const actualProgramHash = await fileHash(sourceProgram)
      if (actualProgramHash !== context.trial.programHash) {
        throw new ResearchService.ConflictError({
          code: "program_hash_mismatch",
          message: `Trial program does not match its recorded hash: ${context.trial.programPath}`,
        })
      }
      await fs.mkdir(path.dirname(absoluteProgram), { recursive: true })
      await fs.copyFile(sourceProgram, absoluteProgram)
      if (storedTarget && absoluteTarget) {
        await fs.copyFile(inside(Instance.directory, storedTarget.targetArtifactPath), absoluteTarget)
      }
      await writeJSON(absoluteBundle, bundle)
      const command = [
        ComputeJobs.quote(adapter.python),
        ComputeJobs.quote(workerScript),
        "--bundle",
        ComputeJobs.quote(absoluteBundle),
        "--output",
        ComputeJobs.quote(absoluteOutput),
        "--evaluator-source",
        ComputeJobs.quote(installed.sourcePath),
      ].join(" ")
      const job = await ComputeJobs.start({
        sessionID: input.sessionId,
        name: `Autofold trial ${context.trial.id}`,
        command,
        cwd: ".",
        target: { kind: "local" },
        resources: {
          cpus: 1,
          gpus: 0,
          time_minutes: Math.max(1, context.experiment.contract.budget.wallTimeMinutes),
        },
        artifacts: [path.posix.join(outputPath, "**", "*")],
      })
      const running = await Research.attachRunJob(projectId, run.id, job.id)
      scheduleFinalization(
        projectId,
        Instance.directory,
        running.id,
        job.id,
        context.experiment.contract.budget.wallTimeMinutes,
      )
      return running
    } catch (error) {
      await Research.failRun(
        projectId,
        run.id,
        error instanceof Error ? error.message : String(error),
        Instance.directory,
      )
      throw error
    }
  }

  export async function get(runId: string) {
    const run = await Research.getRun(Instance.project.id, runId)
    if (run.status === "running" && run.jobId) {
      const job = await ComputeJobs.get(run.jobId)
      if (job && ["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) {
        scheduleFinalization(Instance.project.id, Instance.directory, run.id, job.id, 1)
        await finalizers.get(run.id)
        return Research.getRun(Instance.project.id, run.id)
      }
    }
    return run
  }

  export async function artifacts(runId: string) {
    const run = await get(runId)
    if (run.status !== "succeeded") {
      throw new ResearchService.ConflictError({
        code: "run_artifacts_unavailable",
        message: `Run ${runId} has no verified artifacts while its status is ${run.status}`,
      })
    }
    const workspace = Instance.directory
    const context = await Research.getTrialContext(Instance.project.id, run.trialId)
    const output = inside(workspace, run.outputPath)
    const bundlePath = inside(workspace, run.bundlePath)
    const candidatesPath = path.join(output, "candidates.json")
    const resultPath = path.join(output, "result.json")
    const manifestPath = path.join(output, "manifest.json")
    const [bundle, candidates, evaluation, manifest] = await Promise.all([
      Bun.file(bundlePath).json().then(ExecutionProtocol.TrialBundle.parse),
      Bun.file(candidatesPath).json().then(ExecutionProtocol.CandidateSet.parse),
      Bun.file(resultPath).json().then(ExecutionProtocol.EvaluationResult.parse),
      Bun.file(manifestPath).json().then(ExecutionProtocol.RunManifest.parse),
    ])
    if (
      bundle.runId !== run.id ||
      candidates.runId !== run.id ||
      evaluation.runId !== run.id ||
      manifest.runId !== run.id ||
      bundle.trialId !== run.trialId ||
      candidates.trialId !== run.trialId ||
      evaluation.trialId !== run.trialId ||
      manifest.trialId !== run.trialId
    ) {
      throw new Error(`Run ${run.id} artifacts do not match the persisted run identity`)
    }
    const expectedFiles: Record<string, string> = {
      bundle: await fileHash(bundlePath),
      program: await fileHash(inside(workspace, bundle.programPath)),
      candidates: await fileHash(candidatesPath),
      result: await fileHash(resultPath),
    }
    if (bundle.format === "autofold.trial-bundle.v2" && bundle.targetArtifactPath) {
      expectedFiles.target = await fileHash(inside(workspace, bundle.targetArtifactPath))
      if (expectedFiles.target !== bundle.targetArtifactHash) {
        throw new Error(`Run ${run.id} target artifact no longer matches its frozen hash`)
      }
    }
    if (
      (bundle.format === "autofold.trial-bundle.v2" &&
        bundle.targetArtifactHash !== context.experiment.contract.targetArtifactHash) ||
      (candidates.format === "autofold.candidate-set.v2" &&
        (bundle.format !== "autofold.trial-bundle.v2" ||
          candidates.targetArtifactHash !== context.experiment.contract.targetArtifactHash))
    ) {
      throw new Error(`Run ${run.id} artifacts do not match its frozen target`)
    }
    for (const [label, hash] of Object.entries(expectedFiles)) {
      if (manifest.files[label] !== hash) throw new Error(`Run ${run.id} manifest does not match ${label}`)
    }
    if (run.manifestHash !== (await fileHash(manifestPath))) {
      throw new Error(`Run ${run.id} manifest no longer matches its persisted hash`)
    }
    return {
      run,
      trial: context.trial,
      candidates,
      evaluation,
      manifest,
      incumbent: context.experiment.incumbentTrialId === run.trialId,
    }
  }

  function scheduleFinalization(
    projectId: string,
    workspace: string,
    runId: string,
    jobId: string,
    minutes: number,
  ): void {
    if (finalizers.has(runId)) return
    const task = finalize(projectId, workspace, runId, jobId, minutes)
      .catch(async (error) => {
        await Research.failRun(
          projectId,
          runId,
          error instanceof Error ? error.message : String(error),
          workspace,
        )
      })
      .finally(() => finalizers.delete(runId))
    finalizers.set(runId, task)
  }

  async function finalize(
    projectId: string,
    workspace: string,
    runId: string,
    jobId: string,
    minutes: number,
  ): Promise<void> {
    const job = await ComputeJobs.wait(jobId, {
      workspace,
      timeout: Math.max(60_000, minutes * 60_000 + 30_000),
    })
    if (job.status !== "succeeded") {
      const detail = await ComputeJobs.log(jobId, { workspace }).catch(() => "")
      throw new Error(detail.trim() || `Compute job ${jobId} ended with ${job.status}`)
    }
    const run = await Research.getRun(projectId, runId)
    const context = await Research.getTrialContext(projectId, run.trialId)
    const bundlePath = inside(workspace, run.bundlePath)
    const output = inside(workspace, run.outputPath)
    const bundle = ExecutionProtocol.TrialBundle.parse(await Bun.file(bundlePath).json())
    const programPath = inside(workspace, bundle.programPath)
    const candidatesPath = path.join(output, "candidates.json")
    const resultPath = path.join(output, "result.json")
    const candidates = ExecutionProtocol.CandidateSet.parse(await Bun.file(candidatesPath).json())
    const result = ExecutionProtocol.EvaluationResult.parse(await Bun.file(path.join(output, "result.json")).json())
    const manifestPath = path.join(output, "manifest.json")
    const manifest = ExecutionProtocol.RunManifest.parse(await Bun.file(manifestPath).json())
    if (
      bundle.runId !== run.id ||
      candidates.runId !== run.id ||
      result.runId !== run.id ||
      manifest.runId !== run.id ||
      bundle.trialId !== run.trialId ||
      candidates.trialId !== run.trialId ||
      result.trialId !== run.trialId ||
      manifest.trialId !== run.trialId
    ) {
      throw new Error(`Run ${run.id} returned artifacts for another run or trial`)
    }
    if (
      bundle.contractHash !== context.experiment.contractHash ||
      (bundle.format === "autofold.trial-bundle.v2" &&
        bundle.targetArtifactHash !== context.experiment.contract.targetArtifactHash) ||
      bundle.programHash !== context.trial.programHash ||
      bundle.evaluator.sourceHash !== context.experiment.contract.evaluator.sourceHash ||
      result.contractHash !== context.experiment.contractHash ||
      result.evaluatorHash !== context.experiment.contract.evaluator.sourceHash ||
      manifest.evaluatorHash !== context.experiment.contract.evaluator.sourceHash ||
      result.designAdapter !== context.trial.designAdapter ||
      manifest.designAdapter !== context.trial.designAdapter ||
      result.programHash !== context.trial.programHash ||
      manifest.programHash !== context.trial.programHash
    ) {
      throw new Error(`Run ${run.id} returned artifacts that do not match its frozen experiment`)
    }
    const expectedFiles: Record<string, string> = {
      bundle: await fileHash(bundlePath),
      program: await fileHash(programPath),
      candidates: await fileHash(candidatesPath),
      result: await fileHash(resultPath),
    }
    if (bundle.format === "autofold.trial-bundle.v2" && bundle.targetArtifactPath) {
      expectedFiles.target = await fileHash(inside(workspace, bundle.targetArtifactPath))
      if (expectedFiles.target !== bundle.targetArtifactHash) {
        throw new Error(`Run ${run.id} target artifact no longer matches its frozen hash`)
      }
    }
    if (
      candidates.format === "autofold.candidate-set.v2" &&
      candidates.targetArtifactHash !== context.experiment.contract.targetArtifactHash
    ) {
      throw new Error(`Run ${run.id} candidates reference another target`)
    }
    for (const [label, hash] of Object.entries(expectedFiles)) {
      if (manifest.files[label] !== hash) throw new Error(`Run ${run.id} manifest does not match ${label}`)
    }
    const manifestHash = await fileHash(manifestPath)
    await Research.completeRun(
      projectId,
      runId,
      {
        contractHash: result.contractHash,
        evaluatorHash: result.evaluatorHash,
        valid: result.valid,
        score: result.score,
        diagnostics: result.diagnostics,
      },
      manifestHash,
      workspace,
    )
  }
}
