import {assertFrozenAssets} from './frozen-assets'
import { isDeepStrictEqual } from "node:util"
import {workerTreeIdentity} from "./index"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { ExecutionProtocol } from "@autofold/science-core/execution-protocol"
import { ResearchDomain } from "@autofold/science-core/domain"
import type { ResearchService } from "@autofold/science-core/service"
import { assertSafeTree, inside, checkedPath } from "./paths"
export async function fileHash(file: string): Promise<string> {
  return `sha256:${new Bun.CryptoHasher("sha256").update(await fs.readFile(file)).digest("hex")}`
}
export async function readHashedJSON(file: string) {
  const bytes = await fs.readFile(file)
  return {hash: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`, value: JSON.parse(bytes.toString("utf8"))}
}
function bundleResource(workspace: string, bundlePath: string, resource: string) {
  return path.isAbsolute(resource) ? inside(workspace, resource) : inside(path.dirname(bundlePath), resource)
}
type NativeSearchSummary = {counts: {proposals: number; samplingCalls: number; toolCalls: number}; wallSeconds: number; artifactPath: string; artifactHash: string}
async function verifyGenerationRuns(
  output: string,
  bundle: ExecutionProtocol.TrialBundle,
  candidates: ExecutionProtocol.CandidateSet,
  verifiedFiles: Map<string, string> = new Map(),
  verifiedNativeSearch: Map<string, NativeSearchSummary> = new Map(),
): Promise<ExecutionProtocol.GenerationRunIndexV1 | undefined> {
  if (bundle.designAdapter !== "proto") return undefined
  if (!bundle.proto || bundle.format === "autofold.trial-bundle.v1") return undefined
  const indexPath = path.join(output, "generation-runs", "index.json")
  const indexReceipt = await readHashedJSON(indexPath)
  verifiedFiles.set(indexPath, indexReceipt.hash)
  const index = ExecutionProtocol.GenerationRunIndexV1.parse(indexReceipt.value)
  if (index.runId !== bundle.runId || index.programHash !== bundle.programHash) {
    throw new Error(`Run ${bundle.runId} generation index has another execution identity`)
  }
  if(index.seedRoles&&(bundle.generationSeed===undefined||index.seedRoles.hostGenerationSeed.value!==bundle.generationSeed||
      JSON.stringify(index.seedRoles.evaluatorSeeds.values)!==JSON.stringify(bundle.seeds))) {
    throw new Error(`Run ${bundle.runId} generation seed roles differ from frozen host/evaluator seeds`)
  }
  if (bundle.generationReplicateId) {
    if (!index.replicate || index.replicate.id !== bundle.generationReplicateId) {
      throw new Error(`Run ${bundle.runId} generation index has another replicate identity`)
    }
    const realized = realizedCandidateSetHash(index, candidates)
    if (index.replicate.realizedCandidateSetHash !== realized) {
      throw new Error(`Run ${bundle.runId} generation replicate has another realized candidate set`)
    }
    if (JSON.stringify(index.replicate.requestedSeeds) !== JSON.stringify(bundle.seeds)) {
      throw new Error(`Run ${bundle.runId} generation replicate has another requested seed set`)
    }
  }
  // Proto enforces the frozen GPU timeout at the model-request boundary. This wall-clock
  // measurement also contains first-use environment/checkpoint hydration and is retained as
  // provenance; comparing it to GPU seconds would reject valid cold-start artifacts.
  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.id, {...candidate, generation: z.object({model: z.string(), version: z.string(), artifactHash: z.string(), parametersHash: z.string()}).parse(candidate.generation)}]))
  const generationPolicy = bundle.format === "autofold.trial-bundle.v4" ? bundle.pipeline.generation : undefined
  const freshNative = bundle.nativeExecution
  const nativeAdmission = freshNative ? freshNative.protocol === "native_search_v1" ? freshNative.descriptor : freshNative.descriptor.nativeProjection : bundle.format === "autofold.trial-bundle.v4" ? bundle.pipeline.nativeSearch : undefined
  const nativeGenerators = freshNative ? nativeAdmission?.projection.flatMap(lane => lane.stages.flatMap(stage => stage.generators)) ?? [] : []
  const declaredGenerators: Map<string, {id: string; version: string; toolsCalled: string[]; allocation?: {maximumCandidates: number; maximumGpuSeconds: number}}> | undefined = nativeGenerators.length
    ? new Map(nativeGenerators.map(generator => [generator.key, {id: generator.key, version: bundle.proto!.languageCommit, toolsCalled: generator.toolsCalled}])) : generationPolicy
    ? new Map(generationPolicy.generators.map((generator) => [generator.id, generator]))
    : undefined
  const diagnosticGenerators = new Set<string>()
  for (const diagnostic of index.generatorDiagnostics) {
    if (diagnosticGenerators.has(diagnostic.generator)) {
      throw new Error(`Run ${bundle.runId} repeats generator diagnostics for ${diagnostic.generator}`)
    }
    diagnosticGenerators.add(diagnostic.generator)
    if (!declaredGenerators?.has(diagnostic.generator)) {
      throw new Error(`Run ${bundle.runId} has diagnostics for an undeclared generator ${diagnostic.generator}`)
    }
    if (new Set(diagnostic.sourceFiles).size !== diagnostic.sourceFiles.length) {
      throw new Error(`Run ${bundle.runId} repeats diagnostic source files for ${diagnostic.generator}`)
    }
  }
  if (!freshNative && declaredGenerators && index.sampling.length) {
    const sampling = new Map(index.sampling.map((lane) => [lane.generator, lane]))
    if (sampling.size !== index.sampling.length || sampling.size !== declaredGenerators.size) {
      throw new Error(`Run ${bundle.runId} generation sampling does not cover its frozen generator policy`)
    }
    for (const [id, declared] of declaredGenerators) {
      const observed = sampling.get(id)
      const allocation = declared.allocation ?? generationPolicy!.budget
      if (
        !observed ||
        observed.allocatedCandidates !== allocation.maximumCandidates ||
        observed.maximumGpuSeconds !== allocation.maximumGpuSeconds ||
        (observed.effectiveSamples !== undefined && observed.effectiveSamples > observed.allocatedCandidates) ||
        (observed.effectiveResults !== undefined && observed.effectiveSamples !== undefined && observed.effectiveResults > observed.effectiveSamples)
      ) {
        throw new Error(`Run ${bundle.runId} generation sampling violates the frozen allocation for ${id}`)
      }
    }
  }
  if (nativeAdmission) {
    if (!index.nativeSearch) throw new Error(`Run ${bundle.runId} omits native search evidence`)
    const receiptPath = inside(output, index.nativeSearch.path)
    const native = await readHashedJSON(receiptPath)
    if (native.hash !== index.nativeSearch.hash) throw new Error("Native search receipt hash mismatch")
    const receipt = z.object({format: z.literal("autofold.native-search-receipt.v1"), runId: z.string(), programHash: z.string(),
      admission: ExecutionProtocol.NativeSearch, counts: z.object({proposals: z.number().int().nonnegative(), samplingCalls: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative()}),
      calls: z.array(z.object({tool: z.string(), status: z.enum(["completed", "failed"]),configSeed:z.number().int().refine(Number.isSafeInteger).nullable().optional(),configSeeds:z.array(z.number().int().refine(Number.isSafeInteger)).optional()}).passthrough()),
      samplings: z.array(z.object({instanceId: z.string(), key: z.string(), proposals: z.number().int().nonnegative(), status: z.enum(["completed", "failed"])}).passthrough()),
      wallSeconds: z.number().finite().nonnegative(), selected: z.array(z.object({sequence: z.object({sequence: z.string()}).passthrough()}).passthrough()),
      lanes: z.array(z.unknown()),seedRoles:ExecutionProtocol.GenerationSeedRoleViewV1.optional(),
    }).passthrough().parse(native.value)
    if (receipt.runId !== bundle.runId || receipt.programHash !== bundle.programHash || !isDeepStrictEqual(receipt.admission, nativeAdmission))
      throw new Error("Native search receipt does not match frozen admission")
    const hasObservedCallSeeds=receipt.calls.some(call=>call.configSeed!==undefined||call.configSeeds!==undefined)
    if(bundle.generationSeed===undefined&&(receipt.seedRoles!==undefined||index.seedRoles!==undefined||hasObservedCallSeeds))
      throw new Error("Legacy native receipt contains generation-only seed metadata")
    if((receipt.seedRoles===undefined)!==(index.seedRoles===undefined)||
        hasObservedCallSeeds&&receipt.seedRoles===undefined||
        receipt.seedRoles&&!isDeepStrictEqual(receipt.seedRoles,index.seedRoles))
      throw new Error("Native receipt and generation index have partial or inconsistent seed-role evidence")
    if(receipt.seedRoles&&(bundle.generationSeed===undefined||
        receipt.seedRoles.hostGenerationSeed.value!==bundle.generationSeed||
        JSON.stringify(receipt.seedRoles.evaluatorSeeds.values)!==JSON.stringify(bundle.seeds))) {
      throw new Error("Native receipt seed roles differ from frozen host/evaluator seeds")
    }
    if(receipt.seedRoles) {
      const effectiveProgramSeeds: ExecutionProtocol.GenerationSeedRoleViewV1["effectiveProgramSeeds"] = []
      const declaredPredictorSeeds: ExecutionProtocol.GenerationSeedRoleViewV1["declaredPredictorSeeds"] = []
      const generatorTools = new Set<string>()
      for (const lane of receipt.admission.projection) {
        const seed = lane.programSeed
        if (seed === undefined || seed === null || typeof seed === "number" && Number.isSafeInteger(seed)) {
          effectiveProgramSeeds.push({lane: lane.lane, value: seed == null ? null : seed, source: "verified_native_projection.programSeed"})
        }
        for (const stage of lane.stages) {
          for (const generator of stage.generators) for (const tool of generator.toolsCalled) generatorTools.add(tool)
          for (const constraint of stage.constraints) {
            const record = constraint as Record<string, unknown>
            const config = record.config && typeof record.config === "object" ? record.config as Record<string, unknown> : undefined
            const predictorSeed = config?.predictor_seed
            if (typeof predictorSeed === "number" && Number.isSafeInteger(predictorSeed)) {
              const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>).name : undefined
              declaredPredictorSeeds.push({lane: lane.lane, stage: stage.instanceId, constraint: typeof record.instanceId === "string" ? record.instanceId : null,
                function: typeof fn === "string" ? fn : null, field: "predictor_seed", value: predictorSeed, source: "verified_native_projection.constraint.config"})
            }
          }
        }
      }
      const observedToolConfigSeeds: ExecutionProtocol.GenerationSeedRoleViewV1["observedToolConfigSeeds"] = []
      const seenSeedRequestIds = new Set<string>()
      for (const call of receipt.calls) {
        if (call.configSeed === undefined && call.configSeeds === undefined) continue
        const requestId = (call as typeof call & {requestId?: unknown}).requestId
        if (typeof requestId !== "string" || requestId.length === 0 || seenSeedRequestIds.has(requestId))
          throw new Error("Native seed-role evidence has a missing or duplicate request identity")
        seenSeedRequestIds.add(requestId)
        observedToolConfigSeeds.push({requestId, tool: call.tool,
          role: call.tool.endsWith("-prediction") ? "predictor_tool" : generatorTools.has(call.tool) ? "generator_tool" : "registered_tool",
          source: "verified_native_tool_call.config",
          ...(call.configSeed === undefined ? {} : {seed: call.configSeed}),
          ...(call.configSeeds === undefined ? {} : {seeds: call.configSeeds})})
      }
      if (!isDeepStrictEqual(receipt.seedRoles.effectiveProgramSeeds, effectiveProgramSeeds) ||
          !isDeepStrictEqual(receipt.seedRoles.declaredPredictorSeeds, declaredPredictorSeeds) ||
          !isDeepStrictEqual(receipt.seedRoles.observedToolConfigSeeds, observedToolConfigSeeds))
        throw new Error("Native seed-role evidence differs from frozen admission or observed tool calls")
    }
    if (freshNative?.observation === "scoped_native_lifecycle_v1") {
      const scoped = z.object({observation:z.literal("scoped_native_lifecycle_v1"),
        calls:z.array(z.object({requestId:z.string().min(1),parentRequestId:z.string().min(1).nullable(),tool:z.string(),status:z.enum(["completed","failed"]),cacheOrigin:z.enum(["unobserved","cache_hit","cache_partial","cache_miss","cache_disabled","external_dispatch_backend"]),wallSeconds:z.number().finite().nonnegative(),outputSuccess:z.boolean().optional()}).passthrough()),
        samplings:z.array(z.object({sampleId:z.string().min(1),parentSampleId:z.string().min(1).nullable()}).passthrough()),
      }).passthrough().parse(receipt)
      if (scoped.calls.some(call=>call.status==='completed'&&call.cacheOrigin==='unobserved')) throw new Error("Scoped native request lacks its actual cache branch")
      verifyScopedParents(scoped.calls.map(call=>({id:call.requestId,parent:call.parentRequestId})))
      verifyScopedParents(scoped.samplings.map(sample=>({id:sample.sampleId,parent:sample.parentSampleId})))
    }
    const instances = new Map(receipt.admission.projection.flatMap(lane => lane.stages.flatMap(stage => stage.generators.map(g => [g.instanceId, g.key] as const))))
    const budget = receipt.admission.budget
    if (freshNative?.protocol === "native_fixed_control_v1" && (receipt.counts.proposals || receipt.counts.samplingCalls || receipt.counts.toolCalls)) throw new Error("Fixed native control performed undeclared search effects")
    if (receipt.counts.proposals > budget.maximumProposals || receipt.counts.samplingCalls > budget.maximumSamplingCalls ||
        receipt.counts.toolCalls > budget.maximumToolCalls || receipt.counts.toolCalls !== receipt.calls.length || receipt.counts.samplingCalls !== receipt.samplings.length ||
        receipt.samplings.reduce((n, item) => n + item.proposals, 0) !== receipt.counts.proposals ||
        receipt.samplings.some(item => instances.get(item.instanceId) !== item.key) ||
        receipt.calls.some(call => !budget.allowedTools.includes(call.tool)) || receipt.wallSeconds > budget.maximumWallSeconds ||
        receipt.selected.length !== candidates.candidates.length || receipt.selected.some((item, i) => item.sequence.sequence !== candidates.candidates[i]?.sequence))
      throw new Error("Native search receipt violates output or resource limits")
    verifiedFiles.set(receiptPath, native.hash)
    verifiedNativeSearch.set(bundle.runId, {counts: receipt.counts, wallSeconds: receipt.wallSeconds, artifactPath: index.nativeSearch.path, artifactHash: native.hash})
  }
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
    if (bundle.generationSeed !== undefined && artifact.generationSeed !== bundle.generationSeed) {
      throw new Error(`Run ${bundle.runId} generation artifact omits or changes its frozen generation seed`)
    }
    if (freshNative && !nativeGenerators.length && artifact.generator.components.length) throw new Error("Native generation provenance contains an unadmitted generator")
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
  if (declaredGenerators && !nativeAdmission) {
    const missing = [...declaredGenerators.keys()].filter((id) => !observedGenerators.has(id))
    const failureLanes = new Set<number>()
    const attributedFailures = new Set<string>()
    for (const failure of index.portfolioFailures) {
      if (failureLanes.has(failure.lane)) {
        throw new Error(`Run ${bundle.runId} repeats a failed portfolio lane`)
      }
      failureLanes.add(failure.lane)
      if (failure.generator) {
        if (!declaredGenerators.has(failure.generator) || observedGenerators.has(failure.generator)) {
          throw new Error(`Run ${bundle.runId} attributes a portfolio failure to an invalid generator`)
        }
        attributedFailures.add(failure.generator)
      }
    }
    const unattributed = index.portfolioFailures.filter((failure) => !failure.generator)
    const unresolved = missing.filter((id) => !attributedFailures.has(id))
    // Older trusted workers recorded only the failing portfolio lane number. Accept
    // that representation only when it gives a one-to-one explanation of every
    // otherwise missing declaration; new workers persist the generator identity.
    if (unresolved.length !== unattributed.length || attributedFailures.size + unattributed.length !== missing.length) {
      throw new Error(`Run ${bundle.runId} generation evidence omits a frozen generator without a lane failure`)
    }
  }
  return index
}

function verifyScopedParents(events:Array<{id:string;parent:string|null}>) {
  const records=new Map(events.map(event=>[event.id,event]))
  if(records.size!==events.length)throw new Error('Scoped native lifecycle repeats an invocation identity')
  for(const event of events){
    const visited=new Set<string>();let cursor=event
    while(cursor.parent!==null){
      if(visited.has(cursor.id))throw new Error('Scoped native lifecycle parent graph contains a cycle')
      visited.add(cursor.id)
      const parent=records.get(cursor.parent)
      if(!parent)throw new Error('Scoped native lifecycle parent is missing')
      cursor=parent
    }
  }
}

function realizedCandidateSetHash(
  index: ExecutionProtocol.GenerationRunIndexV1,
  candidates: ExecutionProtocol.CandidateSet,
): string {
  const sequenceById = new Map(candidates.candidates.map((candidate) => [candidate.id, candidate.sequence]))
  const identity = index.entries.map((entry) => ({
    generator: entry.modelId,
    seed: entry.seed,
    sequence: sequenceById.get(entry.candidateId) ?? "",
  })).toSorted((left, right) =>
    left.generator.localeCompare(right.generator) || left.seed - right.seed || left.sequence.localeCompare(right.sequence)
  )
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex")}`
}

async function verifyModelRuns(
  output: string,
  bundle: ExecutionProtocol.TrialBundle,
  candidates: ExecutionProtocol.CandidateSet,
  verifiedArtifacts: Map<string, ExecutionProtocol.ModelRunArtifact> = new Map(),
  verifiedFiles: Map<string, string> = new Map(),
): Promise<ExecutionProtocol.ModelRunIndex | undefined> {
  if (bundle.format !== "autofold.trial-bundle.v3" && bundle.format !== "autofold.trial-bundle.v4") return undefined
  if (candidates.format !== "autofold.candidate-set.v2") {
    throw new Error(`Run ${bundle.runId} trusted evidence did not produce candidate-set.v2`)
  }
  const indexPath = path.join(output, "model-runs", "index.json")
  const indexReceipt = await readHashedJSON(indexPath)
  verifiedFiles.set(indexPath, indexReceipt.hash)
  const index = ExecutionProtocol.ModelRunIndex.parse(indexReceipt.value)
  if (index.runId !== bundle.runId) throw new Error(`Run ${bundle.runId} model-run index has another run identity`)
  if (bundle.format === "autofold.trial-bundle.v4") {
    if (index.format !== "autofold.model-run-index.v2") {
      throw new Error(`Run ${bundle.runId} pipeline bundle requires model-run-index.v2`)
    }
    await verifyModelRunsV2(output, bundle, candidates, index, verifiedArtifacts)
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
    const [artifactReceipt, structureHash, metricsReceipt] = await Promise.all([
      readHashedJSON(artifactPath),
      fileHash(structurePath),
      readHashedJSON(metricsPath),
    ])
    const artifactHash = artifactReceipt.hash
    const metricsHash = metricsReceipt.hash
    if (artifactHash !== entry.artifactHash || structureHash !== entry.structureHash || metricsHash !== entry.metricsHash) {
      throw new Error(`Run ${bundle.runId} model evidence no longer matches its index for ${identity}`)
    }
    const artifact = ExecutionProtocol.ModelRunArtifact.parse(artifactReceipt.value)
    verifiedArtifacts.set(entry.artifactPath, artifact)
    const nativeMetrics = metricsReceipt.value
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
  verifiedArtifacts: Map<string, ExecutionProtocol.ModelRunArtifact>,
): Promise<void> {
  if (index.pipelineHash !== bundle.pipelineHash) throw new Error(`Run ${bundle.runId} model index uses another pipeline policy`)
  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.id, candidate]))
  const policies = new Map<string, {
    version: string
    tool: string
    role: "scoring" | "diagnostic"
    allowSkip: boolean
    allowedSkips: Set<string>
    dependsOn: Set<string>
  }>()
  for (const stage of bundle.pipeline.stages) {
    for (const model of stage.models) {
      policies.set(`${stage.id}:${model.id}`, {
        version: model.version,
        tool: model.toolKey ?? model.id,
        role: stage.role,
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
    const [artifactReceipt, structureHash, metricsReceipt] = await Promise.all([
      readHashedJSON(artifactPath),
      fileHash(structurePath),
      readHashedJSON(metricsPath),
    ])
    const artifactHash = artifactReceipt.hash
    const metricsHash = metricsReceipt.hash
    if (artifactHash !== entry.artifactHash || structureHash !== entry.structureHash || metricsHash !== entry.metricsHash) {
      throw new Error(`Run ${bundle.runId} model evidence no longer matches its index for ${identity}`)
    }
    const artifact = ExecutionProtocol.ModelRunArtifactV2.parse(artifactReceipt.value)
    if (bundle.nativeExecution?.observation === "scoped_native_lifecycle_v1") {
      const reservation = bundle.nativeExecution.resources.invocationReservations.find(item => item.stageId === entry.stage)
      if (!reservation) throw new Error(`Run ${bundle.runId} model evidence has no frozen invocation reservation for ${identity}`)
      verifyNativeRequestObservation(artifact.runtime, policy.tool, reservation.perRequestTimeoutSeconds, {seed:artifact.seed,parametersHash:artifact.parametersHash})
    }
    verifiedArtifacts.set(entry.artifactPath, artifact)
    const nativeMetrics = metricsReceipt.value
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
    // Every scoring and diagnostic artifact is independently verified above
    // and remains available through the model-run index. Only experiment-frozen
    // scoring artifacts may be referenced by candidate.evidence, because that
    // object is the locked evaluator's comparable input. Requiring diagnostic
    // artifacts here would either let an agent-authored diagnostic change the
    // objective or make scoring/diagnostic isolation impossible to verify.
    if (policy.role === "scoring") {
      const hashes = artifactHashes.get(entry.candidateId) ?? new Map<string, { model: string; version: string }>()
      hashes.set(entry.artifactHash, { model: artifact.model.id, version: artifact.model.version })
      artifactHashes.set(entry.candidateId, hashes)
    }
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
      throw new Error(`Run ${bundle.runId} candidate ${candidate.id} does not reference its complete frozen scoring evidence`)
    }
  }
}

/** Verify registered-call evidence against the existing frozen model boundary.
 * Nested calls are native orchestration; their wall time is never summed as GPU use. */
export function verifyNativeRequestObservation(runtime: z.infer<typeof ExecutionProtocol.ModelRunArtifactV2>["runtime"], tool: string, maximumWallSeconds: number, parameters?:{seed:number;parametersHash:string}) {
  const observation = runtime.requestObservation
  if (!observation) throw new Error("Fresh frozen evaluation requires scoped registered-request evidence")
  if (runtime.wallSeconds > maximumWallSeconds) throw new Error("Frozen evaluation exceeded its whole invocation wall deadline")
  const entries = new Map(observation.entries.map(entry => [entry.requestId, entry]))
  if (entries.size !== observation.entries.length) throw new Error("Frozen evaluation repeats a registered-request identity")
  const root = entries.get(observation.rootRequestId)
  if (!root || root.parentRequestId !== null || root.tool !== tool || root.status !== "completed" || root.outputSuccess === false || root.cacheOrigin === "unobserved" || observation.entries.filter(entry => entry.parentRequestId === null).length !== 1) throw new Error("Frozen evaluation registered-request root differs from its model invocation")
  if(parameters){
    const actual=`sha256:${new Bun.CryptoHasher('sha256').update(JSON.stringify({configHash:root.configHash,seed:parameters.seed,tool})).digest('hex')}`
    if(actual!==parameters.parametersHash)throw new Error('Frozen evaluation parameters differ from its actual registered-request configuration')
  }
  for (const entry of observation.entries) {
    if (entry.wallSeconds > runtime.wallSeconds) throw new Error("Registered-request wall exceeds its frozen invocation boundary")
    const visited = new Set<string>()
    let cursor = entry
    while (cursor.requestId !== root.requestId) {
      if (visited.has(cursor.requestId)) throw new Error("Frozen evaluation registered-request parents contain a cycle")
      visited.add(cursor.requestId)
      const parent = cursor.parentRequestId === null ? undefined : entries.get(cursor.parentRequestId)
      if (!parent) throw new Error("Frozen evaluation registered-request parent is missing")
      cursor = parent
    }
  }
}

type TrialContext = Awaited<ReturnType<ResearchService.Service["getTrialContext"]>>
export async function readVerifiedRunReceipt(input: {
    workspace: string
    run: ResearchDomain.Run
    context: TrialContext
    requirePersistedManifestHash: boolean
    persistedManifestHash?: string
    expectedBundleHash?: string
  }) {
    const { workspace, run, context } = input
    ResearchDomain.assertContractIntegrity(context.experiment)
    const request = await Bun.file(path.join(path.dirname(await checkedPath(workspace,run.bundlePath)),"request.json")).json().catch(error=>{if(error.code==="ENOENT")return undefined;throw error})
    if(request?.workerPath) {
      if(request.runId!==run.id||request.trialId!==run.trialId||request.projectId!==context.campaign.projectId)throw new Error("Frozen implementation closure belongs to another run")
      const root=await checkedPath(workspace,request.workerPath)
      await assertSafeTree(workspace,root)
      if((await workerTreeIdentity(root)).sourceHash!==request.workerHash)throw new Error("Frozen worker/evaluator implementation closure changed")
    }
    const output = inside(workspace, run.outputPath)
    const bundlePath = await checkedPath(workspace, run.bundlePath)
    await assertSafeTree(workspace, output)
    await assertSafeTree(workspace, path.dirname(bundlePath))
    const candidatesPath = path.join(output, "candidates.json")
    const resultPath = path.join(output, "result.json")
    const manifestPath = path.join(output, "manifest.json")
    const [bundleReceipt, candidatesReceipt, resultReceipt, manifestReceipt] = await Promise.all([
      readHashedJSON(bundlePath),
      readHashedJSON(candidatesPath),
      readHashedJSON(resultPath),
      readHashedJSON(manifestPath),
    ])
    if (input.expectedBundleHash && bundleReceipt.hash !== input.expectedBundleHash) throw new Error(`Run ${run.id} frozen bundle changed`)
    const bundle = ExecutionProtocol.TrialBundle.parse(bundleReceipt.value)
    if (bundle.nativeExecution && (bundle.nativeExecution.protocol !== context.trial.executionProtocol || !request?.workerPath || bundle.worker?.sourceHash !== request.workerHash)) throw new Error("Fresh native receipt differs from original trial/worker authority")
    const candidates = ExecutionProtocol.CandidateSet.parse(candidatesReceipt.value)
    const result = ExecutionProtocol.EvaluationResult.parse(resultReceipt.value)
    const manifest = ExecutionProtocol.RunManifest.parse(manifestReceipt.value)
    const verifiedModelArtifacts = new Map<string, ExecutionProtocol.ModelRunArtifact>()
    const verifiedFiles = new Map<string, string>()
    const verifiedNativeSearch = new Map<string, NativeSearchSummary>()
    const [generationRuns, modelRuns] = await Promise.all([
      verifyGenerationRuns(output, bundle, candidates, verifiedFiles, verifiedNativeSearch),
      verifyModelRuns(output, bundle, candidates, verifiedModelArtifacts, verifiedFiles),
    ])
    if (
      bundle.runId !== run.id ||
      candidates.runId !== run.id ||
      result.runId !== run.id ||
      manifest.runId !== run.id ||
      bundle.trialId !== run.trialId ||
      bundle.intent !== context.trial.intent ||
      candidates.trialId !== run.trialId ||
      result.trialId !== run.trialId ||
      manifest.trialId !== run.trialId
    ) {
      throw new Error(`Run ${run.id} artifacts do not match the persisted run identity`)
    }
    if (
      bundle.contractHash !== context.experiment.contractHash ||
      bundle.programHash !== context.trial.programHash ||
      bundle.evaluator.sourceHash !== context.experiment.contract.evaluator.sourceHash ||
      bundle.evaluator.id !== context.experiment.contract.evaluator.id ||
      bundle.evaluator.version !== context.experiment.contract.evaluator.version ||
      bundle.evaluator.direction !== context.experiment.contract.evaluator.direction ||
      bundle.designAdapter !== context.trial.designAdapter ||
      JSON.stringify(bundle.seeds) !== JSON.stringify(context.experiment.contract.evaluator.fixedSeeds) ||
      bundle.candidateBudget !== context.experiment.contract.budget.maximumCandidates ||
      bundle.submissionSize !== context.experiment.contract.evaluator.submissionSize ||
      result.contractHash !== context.experiment.contractHash ||
      result.evaluatorHash !== context.experiment.contract.evaluator.sourceHash ||
      manifest.evaluatorHash !== context.experiment.contract.evaluator.sourceHash ||
      result.designAdapter !== context.trial.designAdapter ||
      manifest.designAdapter !== context.trial.designAdapter ||
      result.programHash !== context.trial.programHash ||
      manifest.programHash !== context.trial.programHash
    ) {
      throw new Error(`Run ${run.id} artifacts do not match its frozen experiment`)
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
    assertFrozenAssets(bundle.frozenAssets,bundle.nativeExecution?.descriptor)
    const expectedFiles: Record<string, string> = {
      bundle: bundleReceipt.hash,
      program: await fileHash(bundleResource(workspace, bundlePath, bundle.programPath)),
      candidates: candidatesReceipt.hash,
      result: resultReceipt.hash,
    }
    if (bundle.format !== "autofold.trial-bundle.v1" && bundle.targetArtifactPath) {
      expectedFiles.target = await fileHash(bundleResource(workspace, bundlePath, bundle.targetArtifactPath))
      if (expectedFiles.target !== bundle.targetArtifactHash) {
        throw new Error(`Run ${run.id} target artifact no longer matches its frozen hash`)
      }
    }
    if (bundle.designAdapter === "proto") {
      expectedFiles.generation_runs = verifiedFiles.get(path.join(output, "generation-runs", "index.json"))!
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
      if (
        ("scoringPipelineHash" in bundle.evidenceAdapter ? bundle.evidenceAdapter.scoringPipelineHash : undefined) !==
        context.experiment.contract.evaluator.evidenceAdapter?.scoringPipelineHash
      ) {
        throw new Error(`Run ${run.id} scoring pipeline does not match its frozen experiment`)
      }
      if (bundle.targetStructurePath) {
        expectedFiles.target_structure = await fileHash(bundleResource(workspace, bundlePath, bundle.targetStructurePath))
      }
      expectedFiles.model_runs = verifiedFiles.get(path.join(output, "model-runs", "index.json"))!
    }
    if (expectedFiles.program !== bundle.programHash) throw new Error(`Run ${run.id} frozen program changed`)
    for (const [label, hash] of Object.entries(expectedFiles)) {
      if (manifest.files[label] !== hash) throw new Error(`Run ${run.id} manifest does not match ${label}`)
    }
    const manifestHash = manifestReceipt.hash
    if (input.requirePersistedManifestHash && input.persistedManifestHash !== manifestHash) {
      throw new Error(`Run ${run.id} manifest no longer matches its persisted hash`)
    }
    return { bundle, candidates, result, manifest, generationRuns, modelRuns, verifiedModelArtifacts, nativeSearch: verifiedNativeSearch.get(run.id), manifestHash }
  }


export { verifyGenerationRuns, verifyModelRuns }

  export function evidenceCompleteness(
    pipeline: ExecutionProtocol.PipelinePolicy,
    modelRuns: Extract<ExecutionProtocol.ModelRunIndex, { format: "autofold.model-run-index.v2" }>,
  ) {
    const requiredStages = new Set(pipeline.stages.filter((stage) => stage.required).map((stage) => stage.id))
    const completed = modelRuns.entries.filter((entry) => entry.status === "completed")
    // A frozen condition or candidate-routing decision is resolved evidence about
    // the workflow, not a missing model result. Only tool failures (or legacy
    // unclassified skips) leave an evidence gap for the recursive agent.
    const plannedSkips = modelRuns.entries.filter(
      (entry) => entry.status === "skipped" && (entry.kind === "condition_false" || entry.kind === "candidate_filtered"),
    )
    const evidenceGaps = modelRuns.entries.filter(
      (entry) => entry.status === "skipped" && !plannedSkips.includes(entry),
    )
    const resolved = [...completed, ...plannedSkips]
    const requiredDecisions = modelRuns.entries.filter((entry) => requiredStages.has(entry.stage))
    return {
      status: evidenceGaps.length ? "partial_optional" as const : "complete" as const,
      totalDecisions: modelRuns.entries.length,
      completedDecisions: resolved.length,
      skippedOptionalDecisions: evidenceGaps.length,
      requiredDecisions: requiredDecisions.length,
      completedRequiredDecisions: requiredDecisions.filter((entry) => resolved.includes(entry)).length,
      skippedStages: [...new Set(evidenceGaps.map((entry) => entry.stage))],
    }
  }

