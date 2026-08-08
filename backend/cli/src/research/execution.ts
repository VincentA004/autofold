import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { ComputeJobs } from "@/compute/jobs"
import { ExecutionAuthority } from "@/project/execution"
import { Instance } from "@/project/instance"
import { Research, ResearchService } from "./service"
import { ResearchArtifacts } from "./artifacts"
import { ExecutionProtocol } from "./execution-protocol"
import { ResearchDomain } from "./domain"
import { DesignAdapters } from "./adapters"
import { ResearchRemoteCompute } from "./remote-compute"
import { ResearchWorkflow } from "./workflow"

const workerRoot = path.resolve(import.meta.dir, "../../../worker")
const workerScript = path.join(workerRoot, "run_worker.py")
const mockEvaluatorSource = path.join(workerRoot, "autofold_worker", "evaluate.py")
const peptideEvaluatorSource = path.join(workerRoot, "autofold_worker", "peptide_panel_v1.py")
// This bridge retains the legacy filename because v3 bundles still consume its
// Boltz-only artifact contract; v4 dispatches the compiled Proto registry graph.
const structureEvidenceSource = path.join(workerRoot, "autofold_worker", "evidence_boltz2_v1.py")
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

function bundleResource(workspace: string, bundlePath: string, resource: string): string {
  return path.isAbsolute(resource) ? inside(workspace, resource) : inside(path.dirname(bundlePath), resource)
}

async function verifyGenerationRuns(
  output: string,
  bundle: ExecutionProtocol.TrialBundle,
  candidates: ExecutionProtocol.CandidateSet,
): Promise<ExecutionProtocol.GenerationRunIndexV1 | undefined> {
  if (bundle.designAdapter !== "proto") return undefined
  if (candidates.format !== "autofold.candidate-set.v2" || !bundle.proto || bundle.format === "autofold.trial-bundle.v1") return undefined
  const indexPath = path.join(output, "generation-runs", "index.json")
  const index = ExecutionProtocol.GenerationRunIndexV1.parse(await Bun.file(indexPath).json())
  if (index.runId !== bundle.runId || index.programHash !== bundle.programHash) {
    throw new Error(`Run ${bundle.runId} generation index has another execution identity`)
  }
  if (
    bundle.format === "autofold.trial-bundle.v4" &&
    bundle.pipeline.generation?.budget.maximumGpuSeconds &&
    index.runtime.wallSeconds > bundle.pipeline.generation.budget.maximumGpuSeconds
  ) {
    throw new Error(`Run ${bundle.runId} generation exceeded its frozen runtime budget`)
  }
  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.id, candidate]))
  const declaredGenerators = bundle.format === "autofold.trial-bundle.v4" && bundle.pipeline.generation
    ? new Map(bundle.pipeline.generation.generators.map((generator) => [generator.id, generator]))
    : undefined
  const observedGenerators = new Set<string>()
  const identities = new Set<string>()
  for (const entry of index.entries) {
    const candidate = candidateById.get(entry.candidateId)
    if (!candidate) throw new Error(`Run ${bundle.runId} generation references unknown candidate ${entry.candidateId}`)
    const identity = `${entry.candidateId}:${entry.seed}`
    if (identities.has(identity)) throw new Error(`Run ${bundle.runId} has duplicate generation evidence ${identity}`)
    identities.add(identity)
    if (entry.seed !== candidate.seed || !bundle.seeds.includes(entry.seed)) {
      throw new Error(`Run ${bundle.runId} generation uses an unfrozen seed for ${entry.candidateId}`)
    }
    if (path.isAbsolute(entry.artifactPath) || (entry.structurePath && path.isAbsolute(entry.structurePath))) {
      throw new Error(`Run ${bundle.runId} generation-run paths must be relative`)
    }
    const artifactPath = inside(output, entry.artifactPath)
    const artifactHash = await fileHash(artifactPath)
    if (artifactHash !== entry.artifactHash) {
      throw new Error(`Run ${bundle.runId} generation artifact no longer matches its index for ${identity}`)
    }
    const artifact = ExecutionProtocol.GenerationRunArtifactV1.parse(await Bun.file(artifactPath).json())
    const sequenceHash = `sha256:${new Bun.CryptoHasher("sha256").update(candidate.sequence).digest("hex")}`
    if (
      artifact.candidateId !== entry.candidateId ||
      artifact.seed !== entry.seed ||
      artifact.targetArtifactHash !== bundle.targetArtifactHash ||
      artifact.sequenceHash !== sequenceHash ||
      artifact.outputs.sequenceHash !== sequenceHash ||
      artifact.generator.id !== entry.modelId ||
      artifact.generator.version !== candidate.generation.version ||
      artifact.generator.protoLanguageCommit !== bundle.proto.languageCommit ||
      artifact.generator.protoToolsCommit !== bundle.proto.toolsCommit ||
      artifact.programHash !== bundle.programHash ||
      artifact.parametersHash !== candidate.generation.parametersHash ||
      candidate.generation.model !== entry.modelId ||
      candidate.generation.artifactHash !== entry.artifactHash
    ) {
      throw new Error(`Run ${bundle.runId} generation provenance mismatch for ${identity}`)
    }
    if (declaredGenerators) {
      const components = new Map(artifact.generator.components.map((component) => [component.id, component]))
      if (
        components.size === 0 ||
        [...components].some(([id, observed]) => {
          const declared = declaredGenerators.get(id)
          observedGenerators.add(id)
          return !declared || observed.version !== declared.version || JSON.stringify(observed.toolsCalled) !== JSON.stringify([...declared.toolsCalled].sort())
        })
      ) {
        throw new Error(`Run ${bundle.runId} generation artifact violates its frozen generator policy for ${identity}`)
      }
    }
    if (entry.structurePath && entry.structureHash) {
      const structureHash = await fileHash(inside(output, entry.structurePath))
      if (structureHash !== entry.structureHash || artifact.outputs.structureHash !== structureHash) {
        throw new Error(`Run ${bundle.runId} generated structure no longer matches its index for ${identity}`)
      }
    } else if (artifact.outputs.structureHash) {
      throw new Error(`Run ${bundle.runId} generation index omits a declared structure for ${identity}`)
    }
  }
  if (index.entries.length !== candidates.candidates.length || identities.size !== candidates.candidates.length) {
    throw new Error(`Run ${bundle.runId} has incomplete generation evidence`)
  }
  if (declaredGenerators && (
    observedGenerators.size !== declaredGenerators.size ||
    [...declaredGenerators.keys()].some((id) => !observedGenerators.has(id))
  )) {
    throw new Error(`Run ${bundle.runId} generation evidence omits a frozen generator`)
  }
  return index
}

async function verifyModelRuns(
  output: string,
  bundle: ExecutionProtocol.TrialBundle,
  candidates: ExecutionProtocol.CandidateSet,
): Promise<ExecutionProtocol.ModelRunIndex | undefined> {
  if (bundle.format !== "autofold.trial-bundle.v3" && bundle.format !== "autofold.trial-bundle.v4") return undefined
  if (candidates.format !== "autofold.candidate-set.v2") {
    throw new Error(`Run ${bundle.runId} trusted evidence did not produce candidate-set.v2`)
  }
  const indexPath = path.join(output, "model-runs", "index.json")
  const index = ExecutionProtocol.ModelRunIndex.parse(await Bun.file(indexPath).json())
  if (index.runId !== bundle.runId) throw new Error(`Run ${bundle.runId} model-run index has another run identity`)
  if (bundle.format === "autofold.trial-bundle.v4") {
    if (index.format !== "autofold.model-run-index.v2") {
      throw new Error(`Run ${bundle.runId} pipeline bundle requires model-run-index.v2`)
    }
    await verifyModelRunsV2(output, bundle, candidates, index)
    return index
  }
  if (index.format !== "autofold.model-run-index.v1") {
    throw new Error(`Run ${bundle.runId} legacy scientific bundle requires model-run-index.v1`)
  }

  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.id, candidate]))
  const artifactHashes = new Map<string, Set<string>>()
  const identities = new Set<string>()
  for (const entry of index.entries) {
    if (!candidateById.has(entry.candidateId)) {
      throw new Error(`Run ${bundle.runId} model evidence references unknown candidate ${entry.candidateId}`)
    }
    if (!bundle.seeds.includes(entry.seed)) {
      throw new Error(`Run ${bundle.runId} model evidence uses unfrozen seed ${entry.seed}`)
    }
    const identity = `${entry.candidateId}:${entry.seed}`
    if (identities.has(identity)) throw new Error(`Run ${bundle.runId} has duplicate model evidence ${identity}`)
    identities.add(identity)

    for (const relative of [entry.artifactPath, entry.structurePath, entry.metricsPath]) {
      if (path.isAbsolute(relative)) throw new Error(`Run ${bundle.runId} model-run paths must be relative`)
    }
    const artifactPath = inside(output, entry.artifactPath)
    const structurePath = inside(output, entry.structurePath)
    const metricsPath = inside(output, entry.metricsPath)
    const [artifactHash, structureHash, metricsHash] = await Promise.all([
      fileHash(artifactPath),
      fileHash(structurePath),
      fileHash(metricsPath),
    ])
    if (artifactHash !== entry.artifactHash || structureHash !== entry.structureHash || metricsHash !== entry.metricsHash) {
      throw new Error(`Run ${bundle.runId} model evidence no longer matches its index for ${identity}`)
    }
    const artifact = ExecutionProtocol.ModelRunArtifact.parse(await Bun.file(artifactPath).json())
    const nativeMetrics = await Bun.file(metricsPath).json()
    const candidate = candidateById.get(entry.candidateId)!
    const sequenceHasher = new Bun.CryptoHasher("sha256")
    sequenceHasher.update(candidate.sequence)
    const sequenceHash = sequenceHasher.digest("hex")
    if (
      artifact.candidateId !== entry.candidateId ||
      artifact.seed !== entry.seed ||
      artifact.targetArtifactHash !== bundle.targetArtifactHash ||
      artifact.peptideSequenceHash !== `sha256:${sequenceHash}` ||
      artifact.model.adapterSourceHash !== bundle.evidenceAdapter.sourceHash ||
      artifact.model.protoToolsCommit !== bundle.proto?.toolsCommit ||
      artifact.outputs.structureHash !== structureHash ||
      artifact.outputs.metricsHash !== metricsHash
    ) {
      throw new Error(`Run ${bundle.runId} model artifact provenance mismatch for ${identity}`)
    }
    if (JSON.stringify(artifact.metrics) !== JSON.stringify(nativeMetrics)) {
      throw new Error(`Run ${bundle.runId} model artifact metrics mismatch for ${identity}`)
    }
    const hashes = artifactHashes.get(entry.candidateId) ?? new Set<string>()
    hashes.add(entry.artifactHash)
    artifactHashes.set(entry.candidateId, hashes)
  }

  const expectedCount = candidates.candidates.length * bundle.seeds.length
  if (index.entries.length !== expectedCount) {
    throw new Error(`Run ${bundle.runId} has ${index.entries.length} model runs; expected ${expectedCount}`)
  }
  for (const candidate of candidates.candidates) {
    const declared = new Set(candidate.evidence.predictors.map((predictor) => predictor.artifactHash))
    const indexed = artifactHashes.get(candidate.id) ?? new Set<string>()
    if (declared.size !== indexed.size || [...declared].some((hash) => !indexed.has(hash))) {
      throw new Error(`Run ${bundle.runId} candidate ${candidate.id} does not reference its complete model evidence`)
    }
  }
  return index
}

async function verifyModelRunsV2(
  output: string,
  bundle: z.infer<typeof ExecutionProtocol.TrialBundleV4>,
  candidates: z.infer<typeof ExecutionProtocol.CandidateSetV2>,
  index: z.infer<typeof ExecutionProtocol.ModelRunIndexV2>,
): Promise<void> {
  if (index.pipelineHash !== bundle.pipelineHash) throw new Error(`Run ${bundle.runId} model index uses another pipeline policy`)
  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.id, candidate]))
  const policies = new Map<string, { version: string; allowSkip: boolean; allowedSkips: Set<string>; dependsOn: Set<string> }>()
  for (const stage of bundle.pipeline.stages) {
    for (const model of stage.models) {
      policies.set(`${stage.id}:${model.id}`, {
        version: model.version,
        allowSkip: stage.allowSkip,
        allowedSkips: new Set(stage.allowedSkips),
        dependsOn: new Set(stage.dependsOn),
      })
    }
  }
  const identities = new Set<string>()
  const artifactHashes = new Map<string, Map<string, { model: string; version: string }>>()
  const completed = new Map<string, { candidateId: string; seed: number; stage: string }>()
  const parents: Array<{ identity: string; candidateId: string; seed: number; dependencies: Set<string>; hashes: string[] }> = []

  for (const entry of index.entries) {
    const candidate = candidateById.get(entry.candidateId)
    if (!candidate) throw new Error(`Run ${bundle.runId} model evidence references unknown candidate ${entry.candidateId}`)
    if (!bundle.seeds.includes(entry.seed)) throw new Error(`Run ${bundle.runId} model evidence uses unfrozen seed ${entry.seed}`)
    const policy = policies.get(`${entry.stage}:${entry.modelId}`)
    if (!policy) throw new Error(`Run ${bundle.runId} model evidence references undeclared stage/model ${entry.stage}:${entry.modelId}`)
    const identity = `${entry.candidateId}:${entry.stage}:${entry.modelId}:${entry.seed}`
    if (identities.has(identity)) throw new Error(`Run ${bundle.runId} has duplicate model evidence ${identity}`)
    identities.add(identity)
    if (new Set(entry.parentArtifactHashes).size !== entry.parentArtifactHashes.length) {
      throw new Error(`Run ${bundle.runId} repeats a parent artifact for ${identity}`)
    }
    parents.push({ identity, candidateId: entry.candidateId, seed: entry.seed, dependencies: policy.dependsOn, hashes: entry.parentArtifactHashes })
    if (entry.status === "skipped") {
      if (!policy.allowSkip) throw new Error(`Run ${bundle.runId} skipped required model evidence ${identity}`)
      if (policy.allowedSkips.size > 0 && (!entry.kind || !policy.allowedSkips.has(entry.kind))) {
        throw new Error(`Run ${bundle.runId} used an undeclared skip kind for ${identity}`)
      }
      continue
    }

    for (const relative of [entry.artifactPath, entry.structurePath, entry.metricsPath]) {
      if (path.isAbsolute(relative)) throw new Error(`Run ${bundle.runId} model-run paths must be relative`)
    }
    const artifactPath = inside(output, entry.artifactPath)
    const structurePath = inside(output, entry.structurePath)
    const metricsPath = inside(output, entry.metricsPath)
    const [artifactHash, structureHash, metricsHash] = await Promise.all([
      fileHash(artifactPath),
      fileHash(structurePath),
      fileHash(metricsPath),
    ])
    if (artifactHash !== entry.artifactHash || structureHash !== entry.structureHash || metricsHash !== entry.metricsHash) {
      throw new Error(`Run ${bundle.runId} model evidence no longer matches its index for ${identity}`)
    }
    const artifact = ExecutionProtocol.ModelRunArtifactV2.parse(await Bun.file(artifactPath).json())
    const nativeMetrics = await Bun.file(metricsPath).json()
    const sequenceHash = new Bun.CryptoHasher("sha256").update(candidate.sequence).digest("hex")
    if (
      artifact.candidateId !== entry.candidateId ||
      artifact.stage !== entry.stage ||
      artifact.seed !== entry.seed ||
      artifact.targetArtifactHash !== bundle.targetArtifactHash ||
      artifact.peptideSequenceHash !== `sha256:${sequenceHash}` ||
      artifact.model.id !== entry.modelId ||
      artifact.model.version !== policy.version ||
      artifact.model.adapterSourceHash !== bundle.evidenceAdapter.sourceHash ||
      artifact.model.protoToolsCommit !== bundle.proto!.toolsCommit ||
      artifact.outputs.structureHash !== structureHash ||
      artifact.outputs.metricsHash !== metricsHash ||
      JSON.stringify(artifact.parentArtifactHashes) !== JSON.stringify(entry.parentArtifactHashes)
    ) {
      throw new Error(`Run ${bundle.runId} model artifact provenance mismatch for ${identity}`)
    }
    if (JSON.stringify(artifact.metrics) !== JSON.stringify(nativeMetrics)) {
      throw new Error(`Run ${bundle.runId} model artifact metrics mismatch for ${identity}`)
    }
    if (completed.has(entry.artifactHash)) throw new Error(`Run ${bundle.runId} reuses model artifact ${entry.artifactHash}`)
    completed.set(entry.artifactHash, { candidateId: entry.candidateId, seed: entry.seed, stage: entry.stage })
    const hashes = artifactHashes.get(entry.candidateId) ?? new Map<string, { model: string; version: string }>()
    hashes.set(entry.artifactHash, { model: artifact.model.id, version: artifact.model.version })
    artifactHashes.set(entry.candidateId, hashes)
  }

  const expected = candidates.candidates.length * bundle.seeds.length * [...policies].length
  if (index.entries.length !== expected || identities.size !== expected) {
    throw new Error(`Run ${bundle.runId} has ${index.entries.length} staged model decisions; expected ${expected}`)
  }
  for (const candidate of candidates.candidates) {
    for (const seed of bundle.seeds) {
      for (const [key] of policies) {
        const [stage, model] = key.split(":", 2)
        if (!identities.has(`${candidate.id}:${stage}:${model}:${seed}`)) {
          throw new Error(`Run ${bundle.runId} is missing staged model decision ${candidate.id}:${stage}:${model}:${seed}`)
        }
      }
    }
  }
  for (const parent of parents) {
    const expected = [...completed]
      .filter(([, source]) =>
        source.candidateId === parent.candidateId &&
        source.seed === parent.seed &&
        parent.dependencies.has(source.stage),
      )
      .map(([hash]) => hash)
    const declared = new Set(parent.hashes)
    if (declared.size !== expected.length || expected.some((hash) => !declared.has(hash))) {
      throw new Error(`Run ${bundle.runId} has incomplete or invalid parents for ${parent.identity}`)
    }
  }
  for (const candidate of candidates.candidates) {
    const indexed = artifactHashes.get(candidate.id) ?? new Map<string, { model: string; version: string }>()
    if (
      candidate.evidence.predictors.length !== indexed.size ||
      candidate.evidence.predictors.some((predictor) => {
        const model = indexed.get(predictor.artifactHash)
        return !model || model.model !== predictor.model || model.version !== predictor.version
      })
    ) {
      throw new Error(`Run ${bundle.runId} candidate ${candidate.id} does not reference its complete staged model evidence`)
    }
  }
}

export namespace ResearchExecution {
  export const verifyModelEvidence = verifyModelRuns
  export const verifyGenerationEvidence = verifyGenerationRuns

  export interface EvaluatorInfo {
    id: string
    version: string
    sourceHash: string
    direction: "minimize" | "maximize"
    implementation: string
    evidenceAdapter?: { id: string; version: string; sourceHash: string }
  }

  interface InstalledEvaluator extends Omit<EvaluatorInfo, "evidenceAdapter"> {
    sourcePath: string
    requiresTargetArtifact: boolean
    evidenceAdapter?: { id: string; version: string; sourceHash: string; sourcePath: string }
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
        evidenceAdapter: {
          id: "proto-structure-pipeline",
          version: "1",
          sourceHash: await fileHash(structureEvidenceSource),
          sourcePath: structureEvidenceSource,
        },
      },
    ]
  }

  export async function evaluators(): Promise<EvaluatorInfo[]> {
    return (await installedEvaluators()).map(({ sourcePath: _sourcePath, requiresTargetArtifact: _required, ...info }) => {
      if (!info.evidenceAdapter) return info
      const { sourcePath: _adapterPath, ...evidenceAdapter } = info.evidenceAdapter
      return { ...info, evidenceAdapter }
    })
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
    if (installed.evidenceAdapter && !adapter.proto) {
      throw new ResearchService.ConflictError({
        code: "scientific_adapter_requires_proto",
        message: `${installed.id}@${installed.version} requires the pinned Proto design runtime`,
      })
    }
    const frozenEvidenceAdapter = context.experiment.contract.evaluator.evidenceAdapter
    if (installed.evidenceAdapter) {
      if (!frozenEvidenceAdapter) {
        throw new ResearchService.ConflictError({
          code: "evidence_adapter_not_frozen",
          message: "This legacy experiment does not freeze its evidence adapter; create a new experiment",
        })
      }
      if (
        frozenEvidenceAdapter.id !== installed.evidenceAdapter.id ||
        frozenEvidenceAdapter.version !== installed.evidenceAdapter.version ||
        frozenEvidenceAdapter.sourceHash !== installed.evidenceAdapter.sourceHash
      ) {
        throw new ResearchService.ConflictError({
          code: "evidence_adapter_source_mismatch",
          message: "The installed evidence adapter does not match the frozen experiment contract",
        })
      }
    } else if (frozenEvidenceAdapter) {
      throw new ResearchService.ConflictError({
        code: "evidence_adapter_not_installed",
        message: `Evidence adapter ${frozenEvidenceAdapter.id}@${frozenEvidenceAdapter.version} is not installed`,
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
    const sourceProgram = inside(Instance.directory, context.trial.programPath)
    const actualProgramHash = await fileHash(sourceProgram)
    if (actualProgramHash !== context.trial.programHash) {
      throw new ResearchService.ConflictError({
        code: "program_hash_mismatch",
        message: `Trial program does not match its recorded hash: ${context.trial.programPath}`,
      })
    }
    const proto = adapter.proto
    const workflowPlan = proto && installed.evidenceAdapter
      ? await ResearchWorkflow.extract(sourceProgram, adapter.python)
      : undefined
    const pipeline = workflowPlan && proto
      ? await (async () => {
          await ResearchWorkflow.validateConfigs(workflowPlan, adapter.python, proto.root)
          const [tools, generators] = await Promise.all([
            ResearchWorkflow.discover(adapter.python, proto.root),
            workflowPlan.generation ? ResearchWorkflow.discoverGenerators(adapter.python, proto.root) : Promise.resolve([]),
          ])
          return ResearchWorkflow.compile({
            plan: workflowPlan,
            tools,
            generators,
            contract: context.experiment.contract,
            protoToolsCommit: proto.toolsCommit,
            protoLanguageCommit: proto.languageCommit,
          })
        })()
      : undefined

    // Authorization is a precondition, not a run outcome. Check it before
    // beginRun mutates the proposed trial into a running state so a denied
    // launch can be retried after trust or sandbox remediation.
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`
    const compute = ResearchRemoteCompute.profile(runId, !!adapter.proto)
    await ExecutionAuthority.require({
      projectID: projectId,
      sessionID: input.sessionId,
      capability: compute.kind === "local" ? "local_job" : "remote_job",
    })

    const root = path.posix.join(".autofold", "runs", runId)
    const bundlePath = path.posix.join(root, "bundle.json")
    const programPath = path.posix.join(root, "trial.py")
    const targetPath = storedTarget ? path.posix.join(root, "target.json") : undefined
    const targetStructurePath = storedTarget?.structureArtifactPath
      ? path.posix.join(root, path.posix.basename(storedTarget.structureArtifactPath))
      : undefined
    const outputPath = path.posix.join(root, "output")
    const run = await Research.beginRun(projectId, input.trialId, { runId, bundlePath, outputPath })
    const bundle = ExecutionProtocol.TrialBundle.parse({
      format: pipeline
        ? "autofold.trial-bundle.v4"
        : installed.evidenceAdapter
          ? "autofold.trial-bundle.v3"
          : "autofold.trial-bundle.v2",
      runId,
      trialId: context.trial.id,
      contractHash: context.experiment.contractHash,
      targetArtifactHash: context.experiment.contract.targetArtifactHash,
      targetArtifactPath: targetPath ? path.posix.basename(targetPath) : undefined,
      targetStructurePath: targetStructurePath ? path.posix.basename(targetStructurePath) : undefined,
      evidenceAdapter: installed.evidenceAdapter
        ? {
            id: installed.evidenceAdapter.id,
            version: installed.evidenceAdapter.version,
            sourceHash: installed.evidenceAdapter.sourceHash,
          }
        : undefined,
      designAdapter: context.trial.designAdapter,
      programPath: path.posix.basename(programPath),
      programHash: context.trial.programHash,
      modality: context.experiment.contract.modality,
      evaluator: {
        id: installed.id,
        version: installed.version,
        sourceHash: installed.sourceHash,
        direction: installed.direction,
      },
      proto: adapter.proto,
      pipeline,
      pipelineHash: pipeline ? ExecutionProtocol.hashPipeline(pipeline) : undefined,
      seeds: context.experiment.contract.evaluator.fixedSeeds,
      candidateBudget: context.experiment.contract.budget.maximumCandidates,
      submissionSize: context.experiment.contract.evaluator.submissionSize,
    })
    const absoluteBundle = inside(Instance.directory, bundlePath)
    const absoluteProgram = inside(Instance.directory, programPath)
    const absoluteTarget = targetPath ? inside(Instance.directory, targetPath) : undefined
    const absoluteTargetStructure = targetStructurePath ? inside(Instance.directory, targetStructurePath) : undefined
    const absoluteOutput = inside(Instance.directory, outputPath)

    try {
      await fs.mkdir(path.dirname(absoluteProgram), { recursive: true })
      await fs.copyFile(sourceProgram, absoluteProgram)
      if (storedTarget && absoluteTarget) {
        await fs.copyFile(inside(Instance.directory, storedTarget.targetArtifactPath), absoluteTarget)
      }
      if (storedTarget?.structureArtifactPath && absoluteTargetStructure) {
        await fs.copyFile(inside(Instance.directory, storedTarget.structureArtifactPath), absoluteTargetStructure)
      }
      await writeJSON(absoluteBundle, bundle)
      if (compute.kind === "ssh") await ResearchRemoteCompute.stage(compute, path.dirname(absoluteBundle), workerRoot)
      const launch = ResearchRemoteCompute.command(compute, {
        python: adapter.python,
        bundle: absoluteBundle,
        output: absoluteOutput,
        evaluator: installed.sourcePath,
        evidence: installed.evidenceAdapter?.sourcePath,
      })
      const job = await ComputeJobs.start({
        sessionID: input.sessionId,
        name: `Autofold trial ${context.trial.id}`,
        command: launch.command,
        cwd: launch.cwd,
        target: launch.target,
        resources: {
          cpus: 1,
          gpus: installed.evidenceAdapter ? 1 : 0,
          time_minutes: Math.max(1, context.experiment.contract.budget.wallTimeMinutes),
        },
        artifacts: [path.posix.join(outputPath, "**", "*")],
      }, { hosts: launch.hosts })
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
    const [generationRuns, modelRuns] = await Promise.all([
      verifyGenerationRuns(output, bundle, candidates),
      verifyModelRuns(output, bundle, candidates),
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
      program: await fileHash(bundleResource(workspace, bundlePath, bundle.programPath)),
      candidates: await fileHash(candidatesPath),
      result: await fileHash(resultPath),
    }
    if (bundle.format !== "autofold.trial-bundle.v1" && bundle.targetArtifactPath) {
      expectedFiles.target = await fileHash(bundleResource(workspace, bundlePath, bundle.targetArtifactPath))
      if (expectedFiles.target !== bundle.targetArtifactHash) {
        throw new Error(`Run ${run.id} target artifact no longer matches its frozen hash`)
      }
    }
    if (bundle.designAdapter === "proto") {
      expectedFiles.generation_runs = await fileHash(path.join(output, "generation-runs", "index.json"))
    }
    if (bundle.format === "autofold.trial-bundle.v3" || bundle.format === "autofold.trial-bundle.v4") {
      if (bundle.targetStructurePath) {
        expectedFiles.target_structure = await fileHash(bundleResource(workspace, bundlePath, bundle.targetStructurePath))
      }
      expectedFiles.model_runs = await fileHash(path.join(output, "model-runs", "index.json"))
      if (manifest.evidenceAdapterHash !== bundle.evidenceAdapter.sourceHash) {
        throw new Error(`Run ${run.id} manifest does not match its trusted evidence adapter`)
      }
      if (evaluation.evidenceAdapterHash !== bundle.evidenceAdapter.sourceHash) {
        throw new Error(`Run ${run.id} evaluation does not match its trusted evidence adapter`)
      }
      if (bundle.evidenceAdapter.sourceHash !== context.experiment.contract.evaluator.evidenceAdapter?.sourceHash) {
        throw new Error(`Run ${run.id} evidence adapter does not match its frozen experiment`)
      }
    }
    if (
      (bundle.format !== "autofold.trial-bundle.v1" &&
        bundle.targetArtifactHash !== context.experiment.contract.targetArtifactHash) ||
      (candidates.format === "autofold.candidate-set.v2" &&
        (bundle.format === "autofold.trial-bundle.v1" ||
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
      modelRuns,
      generationRuns,
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
    await ResearchRemoteCompute.retrieve(job, output)
    const bundle = ExecutionProtocol.TrialBundle.parse(await Bun.file(bundlePath).json())
    const programPath = bundleResource(workspace, bundlePath, bundle.programPath)
    const candidatesPath = path.join(output, "candidates.json")
    const resultPath = path.join(output, "result.json")
    const candidates = ExecutionProtocol.CandidateSet.parse(await Bun.file(candidatesPath).json())
    const result = ExecutionProtocol.EvaluationResult.parse(await Bun.file(path.join(output, "result.json")).json())
    const manifestPath = path.join(output, "manifest.json")
    const manifest = ExecutionProtocol.RunManifest.parse(await Bun.file(manifestPath).json())
    await Promise.all([
      verifyGenerationRuns(output, bundle, candidates),
      verifyModelRuns(output, bundle, candidates),
    ])
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
      (bundle.format !== "autofold.trial-bundle.v1" &&
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
    if (bundle.format !== "autofold.trial-bundle.v1" && bundle.targetArtifactPath) {
      expectedFiles.target = await fileHash(bundleResource(workspace, bundlePath, bundle.targetArtifactPath))
      if (expectedFiles.target !== bundle.targetArtifactHash) {
        throw new Error(`Run ${run.id} target artifact no longer matches its frozen hash`)
      }
    }
    if (bundle.designAdapter === "proto") {
      expectedFiles.generation_runs = await fileHash(path.join(output, "generation-runs", "index.json"))
    }
    if (bundle.format === "autofold.trial-bundle.v3" || bundle.format === "autofold.trial-bundle.v4") {
      if (manifest.evidenceAdapterHash !== bundle.evidenceAdapter.sourceHash) {
        throw new Error(`Run ${run.id} manifest does not match its trusted evidence adapter`)
      }
      if (result.evidenceAdapterHash !== bundle.evidenceAdapter.sourceHash) {
        throw new Error(`Run ${run.id} evaluation does not match its trusted evidence adapter`)
      }
      if (bundle.evidenceAdapter.sourceHash !== context.experiment.contract.evaluator.evidenceAdapter?.sourceHash) {
        throw new Error(`Run ${run.id} evidence adapter does not match its frozen experiment`)
      }
      if (bundle.targetStructurePath) {
        expectedFiles.target_structure = await fileHash(bundleResource(workspace, bundlePath, bundle.targetStructurePath))
      }
      expectedFiles.model_runs = await fileHash(path.join(output, "model-runs", "index.json"))
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
