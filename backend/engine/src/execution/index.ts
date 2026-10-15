import {ProtoRuntimeInspection} from './proto-inspection'
import {freezeAssets,assertFrozenAssets,type FrozenAssetInput} from './frozen-assets'
import type {InspectionBoundary} from './inspection-boundary'
import { localCapabilities, assertCapabilities, externalGeneratorIds, type CapabilityRequest, type HostCapabilities, type GeneratorCapabilityRequest } from "./capabilities"
import crypto from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { TrialReasoning } from "@autofold/science-core/trial-reasoning"
import {snapshotPinnedProto} from "./native-references"
import fs from "node:fs/promises"
import path from "node:path"
import { ResearchDomain } from "@autofold/science-core/domain"
import type { OperationDomain } from "@autofold/science-core/operations"
import { ResearchService } from "@autofold/science-core/service"
import { ResearchArtifacts } from "@autofold/science-core/artifacts"
import { ResearchWorkflow } from "@autofold/science-core/workflow"
import { ProtoModelRegistry } from "@autofold/science-core/research/model-registry"
import { ExecutionProtocol } from "@autofold/science-core/execution-protocol"
import { checkedPath, assertSafeTree } from "./paths"
import { fileHash, readVerifiedRunReceipt, evidenceCompleteness } from "./provenance"
import { compactRunError, stageFailureDetail, ExecutionPreflightUnavailableError } from "./errors"
import { withExecutionDeadline } from "./authority"
import { LocalWorkerTransport, ReceiptUnresolvedError, ExecutionCancelledError, type ExecutionTransport, type Dispatch } from "./transport"
export { ReceiptUnresolvedError, ExecutionCancelledError, LocalWorkerTransport, ExecutionPreflightUnavailableError, withExecutionDeadline }
export type { ExecutionTransport, Dispatch, TransportCompletion } from "./transport"
export { readVerifiedRunReceipt, fileHash } from "./provenance"

export interface EvaluatorInfo {
  id: string; version: string; sourceHash: string; direction: "minimize" | "maximize"; implementation: string
  evidenceAdapter?: {id: string; version: string; sourceHash: string}
}
interface InstalledEvaluator extends EvaluatorInfo { sourcePath: string; evidenceSource?: string }
export interface ExecutionAuthorization {
  /** Absolute host grant ceiling; frozen in process intent and never extended on recovery. */
  deadlineMs?: number
  /** Authorizes importing an authored Proto program and running it locally. */
  localProto?: boolean
  remote?: boolean
  maximumGpuSeconds?: number
  maximumCandidates?: number
  maximumWallTimeMinutes?: number
  authorize?: (input: {trialId: string; capability: "local_mock" | "local_proto" | "remote"; gpuSeconds: number}) => void | Promise<void>
  /** Optional host protocol gate after contained construction and again before scientific launch. */
  authorizeNative?: (input:{trialId:string;contractHash:string;descriptor:ExecutionProtocol.NativeExecution['descriptor']})=>void|Promise<void>
}
export interface ScientificExecutionOptions {
  workspace: string; projectId: string; research: ResearchService.Service; workerRoot?: string; python?: string
  proto?: {root: string; python: string; languageCommit?: string; toolsCommit?: string}
  transport?: ExecutionTransport; authorization?: ExecutionAuthorization
  inspectionBoundary?: InspectionBoundary
  evidenceExecution?: "legacy_dag_v1" | "native_tool_sequence_v1"
  frozenAssets?: readonly FrozenAssetInput[]
}
export interface ExecutionCaller {jobId: string; leaseId: string}
interface EvaluationRequest {trialId: string; requestId: string; signal?: AbortSignal; caller?: ExecutionCaller; operationHandle?: OperationDomain.Handle}
interface RequestRecord {
  format: "autofold.execution-request.v1"; projectId: string; trialId: string; requestId: string; runId: string
  state: "prepared" | "dispatching" | "finished"; bundleHash: string; workerHash: string; timeoutMs: number; workerPath?: string; runtime?: string; authorizationDeadlineMs?: number; operationId?: string
  transportProfile?: unknown; runtimeEnvironment?: Record<string, string>
}
const pending = new Map<string, Promise<any>>()
async function atomicJSON(file: string, value: unknown) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temp, "wx", 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync() } finally { await handle.close() }
  await fs.rename(temp, file)
  const directory = await fs.open(path.dirname(file), "r")
  try { await directory.sync() } finally { await directory.close() }
}
function digest(value: string) { return crypto.createHash("sha256").update(value).digest("hex") }
export async function workerTreeIdentity(root: string) {
  const files = ["run_worker.py"]
  async function visit(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      if (entry.name === "__pycache__") continue
      if (entry.isSymbolicLink()) throw new Error("Trusted worker sources must not be symbolic links")
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile() && name.endsWith(".py")) files.push(name)
    }
  }
  await visit("autofold_worker")
  const hash = crypto.createHash("sha256")
  for (const name of files.toSorted()) hash.update(name).update("\0").update(await fs.readFile(path.join(root, name))).update("\0")
  return {format: "autofold.worker-tree.v1" as const, sourceHash: `sha256:${hash.digest("hex")}`}
}
export class ScientificExecution {
  readonly workspace: string
  readonly projectId: string
  private readonly workerRoot: string
  private readonly transport: ExecutionTransport
  private inspectionReady?:Promise<void>
  private toolInventory?: Promise<ResearchWorkflow.Tool[]>
  private generatorInventory?: Promise<ResearchWorkflow.Generator[]>
  private nativeComponents: ProtoModelRegistry.Card[] = []
  private modelRegistryInventory?: Promise<ProtoModelRegistry.Snapshot>
  private capabilityInventory?: Promise<HostCapabilities & {registeredGenerators: string[]}>
  constructor(private readonly options: ScientificExecutionOptions) {
    if (!path.isAbsolute(options.workspace)) throw new Error("Execution requires an absolute host workspace")
    if (!/^[A-Za-z0-9_-]+$/.test(options.projectId)) throw new Error("Invalid execution project identity")
    this.workspace = path.resolve(options.workspace); this.projectId = options.projectId
    this.workerRoot = path.resolve(options.workerRoot ?? path.resolve(import.meta.dir, "../../../worker"))
    const transport = options.transport ?? new LocalWorkerTransport()
    this.transport = options.authorization?.deadlineMs === undefined ? transport : withExecutionDeadline(transport, options.authorization.deadlineMs)
  }
  private async installed(root = this.workerRoot): Promise<InstalledEvaluator[]> {
    const mock = path.join(root, "autofold_worker/evaluate.py")
    const peptide = path.join(root, "autofold_worker/peptide_panel_v1.py")
    const evidence = path.join(root, "autofold_worker/evidence_pipeline_v3.py")
    return [
      {id: "mock-peptide-panel", version: "1", direction: "minimize", sourceHash: await fileHash(mock), sourcePath: mock, implementation: "plumbing-only-python-sequence-heuristic"},
      {id: "peptide-panel", version: "1", direction: "minimize", sourceHash: await fileHash(peptide), sourcePath: peptide, implementation: "python-stdlib-locked-evidence-panel", evidenceSource: evidence,
        evidenceAdapter: {id: "proto-structure-pipeline", version: "3", sourceHash: await fileHash(evidence)}},
    ]
  }
  get transportKind() {return this.transport.kind}
  async frozenAssetReferences(experimentId:string) {
    return (await freezeAssets(this.workspace,experimentId,this.options.frozenAssets))?.map(({id,contentHash,nativeBindings})=>({id,contentHash,nativeBindings}))??[]
  }
  async workerIdentity() {return workerTreeIdentity(this.workerRoot)}
  private protoIdentity() {
    const proto = this.options.proto
    if (!proto || !path.isAbsolute(proto.root) || !/^[a-f0-9]{40}$/.test(proto.languageCommit ?? "") || !/^[a-f0-9]{40}$/.test(proto.toolsCommit ?? "")) throw new Error("Proto requires explicit runtime and pinned language/tools commits")
    return {root: proto.root, languageCommit: proto.languageCommit!, toolsCommit: proto.toolsCommit!}
  }
  private async checkCapabilities(generators: GeneratorCapabilityRequest[], signal?: AbortSignal) {
    const proto = this.protoIdentity(), input: CapabilityRequest = {proto, generators, signal}
    // Local Python/Proto also performs bounded declaration inspection, including for remote runs.
    const local = await localCapabilities(this.options.proto!.python, {...input, generators: this.transport.kind === "local" ? generators : []})
    assertCapabilities(local, this.transport.kind === "local" ? generators.map(item => item.id) : [])
    if (this.transport.kind === "local") return local
    if (!this.transport.capabilities) throw new ExecutionPreflightUnavailableError("Remote scientific transport lacks read-only host capability preflight")
    const remote = await this.transport.capabilities(input)
    assertCapabilities(remote, generators.map(item => item.id))
    return remote
  }
  private preflightInspection(signal?:AbortSignal) {
    if(!this.options.proto)return Promise.resolve()
    const probe=()=>ProtoRuntimeInspection.preflight(this.options.proto!.python,{...this.options.inspectionBoundary,workerRoot:this.workerRoot,signal})
      .catch(error=>{throw new ExecutionPreflightUnavailableError("Native inspection containment is unavailable before scientific authoring: "+compactRunError(String(error)))})
    return signal?probe():(this.inspectionReady??=probe().catch(error=>{this.inspectionReady=undefined;throw error}))
  }
  /** Authoritative runtime readiness before scientific model authoring; optional lanes do not block alternatives. */
  async preflightExperiment(experiment: ResearchDomain.Experiment, signal?: AbortSignal) {
    ResearchDomain.assertContractIntegrity(experiment)
    if (!experiment.contract.evaluator.evidenceAdapter && !this.options.proto) return undefined
    const readiness = await this.checkCapabilities([], signal)
    await this.preflightInspection(signal)
    await this.capabilities()
    return readiness
  }
  private registeredTools() {
    return this.toolInventory ??= ProtoRuntimeInspection.discover(this.options.proto!.python, this.protoIdentity().root, this.workerRoot,this.options.inspectionBoundary)
      .catch(error => {this.toolInventory = undefined; throw error})
  }
  private registeredGenerators() {
    return this.generatorInventory ??= ProtoRuntimeInspection.discoverGenerators(this.options.proto!.python, this.protoIdentity().root, this.workerRoot, cards => {this.nativeComponents = cards},this.options.inspectionBoundary)
      .catch(error => {this.generatorInventory = undefined; throw error})
  }
  /** One bounded installed-lane inventory per immutable host instance; admission rechecks selected lanes. */
  async capabilities(): Promise<HostCapabilities & {registeredGenerators: string[]}> {
    if (!this.options.proto) return {format: "autofold.host-capabilities.v1", host: this.transport.kind, checkedAt: new Date().toISOString(), runtime: [], generators: [], registeredGenerators: []}
    return this.capabilityInventory ??= (async () => {
      await this.checkCapabilities([])
      const registered = await this.registeredGenerators()
      const request = {proto: this.protoIdentity(), generators: externalGeneratorIds.map(id => ({id}))}
      const report = this.transport.kind === "remote" ? await this.transport.capabilities!(request) : await localCapabilities(this.options.proto!.python, request)
      return {...report, registeredGenerators: registered.map(item => item.key), generators: registered.map(spec => report.generators.find(item => item.id === spec.key) ?? {
        id: spec.key, available: spec.usesGpu || spec.toolsCalled.length ? null : true,
        requirement: spec.usesGpu || spec.toolsCalled.length ? "Registered native generator; model/tool assets are not established by path-only inventory" : "Registered CPU generator in the installed pinned runtime",
      })}
    })().catch(error=>{this.capabilityInventory=undefined;throw error})
  }
  /** Read-only model metadata from exact local Proto pins; registration is not GPU/weight readiness. */
  async modelRegistry(): Promise<ProtoModelRegistry.Snapshot> {
    if (!this.options.proto) return ProtoModelRegistry.snapshot([], null)
    const proto = this.protoIdentity()
    return this.modelRegistryInventory ??= (async () => {
      const readiness = await localCapabilities(this.options.proto!.python, {proto, generators: []})
      assertCapabilities(readiness)
      const [tools, generators, worker] = await Promise.all([
        this.registeredTools(),
        this.registeredGenerators(), this.workerIdentity(),
      ])
      return ProtoModelRegistry.snapshot([...tools, ...generators].flatMap(item => item.modelCard ? [item.modelCard] : []).concat(this.nativeComponents),
        {languageCommit: proto.languageCommit, toolsCommit: proto.toolsCommit, workerHash: worker.sourceHash})
    })().catch(error=>{this.modelRegistryInventory=undefined;throw error})
  }
  /** Recheck only requested lanes against current host paths; a cached inventory cannot admit removed software. */
  async preflightGenerators(generators: GeneratorCapabilityRequest[], signal?: AbortSignal) {
    return this.checkCapabilities(generators, signal)
  }
  private async preflightGeneration(authored: ResearchWorkflow.AuthoredTrial | undefined, selected: string[]) {
    const captured = (authored?.generatorPreflight as {generators?: GeneratorCapabilityRequest[]} | undefined)?.generators ?? []
    selected = [...new Set([...selected, ...captured.map(item => item.id)])]
    if (!selected.length) return
    await this.preflightGenerators([...captured, ...selected.filter(id => !captured.some(item => item.id === id)).map(id => ({id}))])
    return this.validateGeneratorSpecs(authored, selected)
  }
  private async validateGeneratorSpecs(authored: ResearchWorkflow.AuthoredTrial | undefined, selected: string[]) {
    if (!selected.some(id => externalGeneratorIds.includes(id as typeof externalGeneratorIds[number]))) return
    const request = authored?.generatorPreflight
    if (!request) throw new Error("External generator requires an exact captured design-spec preflight before trial admission")
    const specs = (request as {generators?: {id: string}[]}).generators
    const external = selected.filter(id => externalGeneratorIds.includes(id as typeof externalGeneratorIds[number]))
    if (!Array.isArray(specs) || external.some(id => !specs.some(spec => spec.id === id))) throw new Error("Exact generator design-spec preflight omits a selected external lane")
    const source = await fs.readFile(path.join(this.workerRoot, "autofold_worker/generator_spec.py"), "utf8")
    if (this.transport.kind === "remote") {
      if (!this.transport.validateGeneratorSpecs) throw new ExecutionPreflightUnavailableError("Remote scientific transport lacks exact generator design-spec preflight")
      await this.transport.validateGeneratorSpecs({source, request})
    } else {
      const child = Bun.spawn([this.options.proto!.python, "-c", source, "--request-stdin"], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {...process.env, PYTHONDONTWRITEBYTECODE: "1"}, timeout: 20_000,
      })
      child.stdin.write(JSON.stringify(request)); child.stdin.end()
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error("Generator design-spec preflight failed before trial admission: " + compactRunError(error || output))
    }
    return {valid: true, generators: external, specHash: `sha256:${digest(JSON.stringify(request))}`}
  }

  async evaluators(): Promise<EvaluatorInfo[]> {
    return (await this.installed()).map(({sourcePath, evidenceSource, ...value}) => value)
  }
  /** Read-only byte copy of the actual worker loaded by this host, for scientist inspection. */
  async scientistReference(workspace: string, relativeRoot: string): Promise<string> {
    if (path.resolve(workspace) !== this.workspace) throw new Error("Scientist reference workspace mismatch")
    const identity = await workerTreeIdentity(this.workerRoot)
    const root = relativeRoot + "/worker-source/" + identity.sourceHash.slice(7)
    const files = ["run_worker.py"]
    const visit = async (relative: string) => {
      for (const entry of await fs.readdir(path.join(this.workerRoot, relative), {withFileTypes: true})) {
        if (entry.name === "__pycache__") continue
        if (entry.isSymbolicLink()) throw new Error("Worker reference contains a symbolic link")
        const name = path.posix.join(relative, entry.name)
        if (entry.isDirectory()) await visit(name); else if (entry.isFile() && name.endsWith(".py")) files.push(name)
      }
    }
    await visit("autofold_worker")
    for (const name of files) {
      const file = await checkedPath(this.workspace, root + "/" + name)
      await fs.mkdir(path.dirname(file), {recursive: true})
      const bytes = await fs.readFile(path.join(this.workerRoot, name))
      try {await fs.writeFile(file, bytes, {flag: "wx", mode: 0o400})}
      catch (error: any) {if (error.code !== "EEXIST" || !(await fs.readFile(file)).equals(bytes)) throw error}
    }
    const native = this.options.proto ? await snapshotPinnedProto(this.workspace, relativeRoot, this.options.proto) : undefined
    return `Executing worker identity: ${identity.sourceHash}. Read-only API entry points:\n- ${root}/autofold_worker/proto_trial.py: TrialContext fields and ProtoTrial search/fixed_control declarations.\n- ${root}/autofold_worker/proto_generators.py: registered binder generator constructors/configs. Registration alone does not establish an installed executable.\n- ${root}/autofold_worker/native_search.py: native admission, separate resource counters, explicit final selections and scientific receipt capture.\n- ${root}/autofold_worker/proto_portfolio.py: historical independent-lane compatibility. Fresh independent lanes use proto_language.core.PortfolioProgram and PortfolioLane from the pinned scoped lifecycle fork; explicit outputs select lane indices.\n Host installed-lane inventory is in read_context.executionCapabilities; use available lanes and read their requirements before authoring. Missing optional lanes do not disable other generators. This copied reference is never loaded for execution. ${native?.description ?? "No native Proto runtime was configured by the host."}`
  }
  /** Inspect captured native bytes against the actual host runtime without creating a trial or run. */
  async inspectProgram(input: {experiment: ResearchDomain.Experiment; campaign: ResearchDomain.Campaign; programPath: string; programHash: string; generationSeed?:number}) {
    if (!this.options.authorization?.localProto) throw new Error("Native local program inspection requires explicit host localProto authorization")
    const trial = ResearchDomain.Trial.parse({id: "trl_preflight", experimentId: input.experiment.id,
      hypothesis: "Native declaration inspection", intent: "optimize", designAdapter: "proto", programPath: input.programPath,
      programHash: input.programHash, ...(input.generationSeed === undefined ? {} : {generationSeed:input.generationSeed}), status: "proposed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()})
    const prepared = await this.prepare(trial.id, {...input, trial}, true)
    if (!prepared.authoredTrial) throw new Error("Scientist programs must export native build_trial(ctx) returning ProtoTrial")
    const pipeline = prepared.pipeline ?? prepared.inspectionPipeline
    const {generatorPreflight, ...authored} = prepared.authoredTrial
    return {authored, nativeExecution: prepared.nativeExecution, pipeline, tools: prepared.tools, generatorSpecPreflight: prepared.generatorSpecPreflight,
      programHash: input.programHash, contractHash: input.experiment.contractHash,
      scientific: !!prepared.installed.evidenceAdapter, evaluator: prepared.installed.id,
      pipelineHash: pipeline ? ExecutionProtocol.hashPipeline(pipeline) : undefined}
  }
  /** Validate a direct API proposal before its scientific trial record exists. */
  async validateProposal(input: {experiment: ResearchDomain.Experiment; campaign: ResearchDomain.Campaign; trial: ResearchDomain.Trial}) {
    const prepared=await this.prepare(input.trial.id,input,false,false,true)
    return {executionProtocol:prepared.authoredTrial?.executionProtocol,nativeExecution:prepared.nativeExecution,declaration:prepared.authoredTrial?.declaration,pipeline:prepared.pipeline??prepared.inspectionPipeline,tools:prepared.tools,authored:prepared.authoredTrial}
  }
  private async prepare(trialId: string, suppliedContext?: Awaited<ReturnType<ResearchService.Service["getTrialContext"]>>, inspection = false, fresh = false, captureDeclaration = false) {
    const context = {...(suppliedContext ?? await this.options.research.getTrialContext(this.projectId, trialId))}
    if (context.campaign.projectId !== this.projectId || context.trial.experimentId !== context.experiment.id || context.experiment.campaignId !== context.campaign.id) throw new Error("Scientific context does not match host project binding")
    ResearchDomain.assertContractIntegrity(context.experiment)
    const {contract} = context.experiment
    const installed = (await this.installed()).find(x => x.id === contract.evaluator.id && x.version === contract.evaluator.version)
    if (!installed) throw new Error("Frozen evaluator is not installed")
    if (installed.sourceHash !== contract.evaluator.sourceHash || installed.direction !== contract.evaluator.direction) throw new Error("Evaluator source or direction does not match frozen contract")
    if (JSON.stringify(installed.evidenceAdapter) !== JSON.stringify(contract.evaluator.evidenceAdapter && {id: contract.evaluator.evidenceAdapter.id, version: contract.evaluator.evidenceAdapter.version, sourceHash: contract.evaluator.evidenceAdapter.sourceHash})) throw new Error("Evidence adapter does not match frozen contract")
    const sourceProgram = await checkedPath(this.workspace, context.trial.programPath)
    if (await fileHash(sourceProgram) !== context.trial.programHash) throw new Error("Trial program hash does not match frozen trial")
    const auth = this.options.authorization
    const gpuSeconds = contract.budget.gpuHours * 3600
    if (context.trial.designAdapter === "mock" && installed.evidenceAdapter) throw new Error("Scientific evaluator requires pinned Proto runtime")
    if (context.trial.designAdapter === "mock" && gpuSeconds !== 0) throw new Error("Mock plumbing cannot reserve GPU authority")
    if (auth?.maximumCandidates !== undefined && contract.budget.maximumCandidates > auth.maximumCandidates) throw new Error("Candidate budget exceeds host authorization")
    if (auth?.maximumWallTimeMinutes !== undefined && contract.budget.wallTimeMinutes > auth.maximumWallTimeMinutes) throw new Error("Wall-time budget exceeds host authorization")
    if (this.transport.kind === "remote" && !auth?.remote) throw new Error("Remote scientific execution is not authorized by host")
    let proto: {root: string; languageCommit: string; toolsCommit: string} | undefined
    if (context.trial.designAdapter === "proto") {
      if (this.transport.kind === "local" && !auth?.localProto) throw new Error("Local Proto execution requires explicit host authorization")
      if (!Number.isFinite(auth?.maximumGpuSeconds) || gpuSeconds > auth!.maximumGpuSeconds!) throw new Error("GPU budget exceeds explicit host authorization")
      proto = this.protoIdentity()
      await this.checkCapabilities([])
      await this.preflightInspection()
    }
    await auth?.authorize?.({trialId, gpuSeconds, capability: this.transport.kind === "remote" ? "remote" : proto ? "local_proto" : "local_mock"})
    const storedTarget = installed.evidenceAdapter ? await ResearchArtifacts.readTarget(this.workspace, contract.targetArtifactHash) : undefined
    const frozenAssets=await freezeAssets(this.workspace,context.experiment.id,this.options.frozenAssets)
    if(frozenAssets&&!proto)throw new Error('Frozen native input assets require Proto execution')
    if (storedTarget) {
      await checkedPath(this.workspace, storedTarget.targetArtifactPath)
      if (storedTarget.structureArtifactPath) await checkedPath(this.workspace, storedTarget.structureArtifactPath)
    }
    const authoredTrial = proto ? await ProtoRuntimeInspection.describeTrial(sourceProgram, this.options.proto!.python, {
      freshNative: true, experimentId: context.experiment.id, contractHash: context.experiment.contractHash, targetArtifactHash: contract.targetArtifactHash,
      targetArtifactPath: storedTarget ? await checkedPath(this.workspace, storedTarget.targetArtifactPath) : undefined,
      targetStructurePath: storedTarget?.structureArtifactPath ? await checkedPath(this.workspace, storedTarget.structureArtifactPath) : undefined,
      modality: contract.modality, evaluator: contract.evaluator, seeds: contract.evaluator.fixedSeeds,
      ...(context.trial.generationSeed === undefined ? {} : {generationSeed:context.trial.generationSeed}),
      candidateBudget: contract.budget.maximumCandidates, submissionSize: contract.evaluator.submissionSize, intent: context.trial.intent,
      ...(frozenAssets===undefined?{}:{frozenAssets}),
    }, {...this.options.inspectionBoundary,workerRoot:this.workerRoot,protoRoot:proto.root,cache:!fresh}) : undefined
    if (proto && !authoredTrial?.executionProtocol) throw new Error("Fresh Proto programs require contained native execution admission")
    if (authoredTrial) {
      if (inspection) context.trial = {...context.trial, hypothesis: authoredTrial.hypothesis, ...authoredTrial.declaration, executionProtocol: authoredTrial.executionProtocol}
      else {
        if (!captureDeclaration && context.trial.executionProtocol !== authoredTrial.executionProtocol) throw new Error("Fresh trial execution protocol differs from inspected native construction")
        if (captureDeclaration && context.trial.executionProtocol !== undefined && context.trial.executionProtocol !== authoredTrial.executionProtocol) throw new Error("Caller execution protocol differs from inspected native construction")
        if (authoredTrial.hypothesis !== context.trial.hypothesis || authoredTrial.declaration.intent !== context.trial.intent) throw new Error("Native trial declaration differs from frozen trial")
        for (const key of ["decisionPlan", "prediction", "evidenceRefs", "calibrationClass", "replicateOfTrialId"] as const) {
          const normalize = (value: unknown) => value === undefined ? undefined :
            key === "decisionPlan" ? TrialReasoning.parseDecisionPlan(value) :
            key === "prediction" ? TrialReasoning.Prediction.parse(value) :
            key === "evidenceRefs" ? TrialReasoning.EvidenceRefs.parse(value) : value
          if ((!captureDeclaration || context.trial[key]!==undefined) && !isDeepStrictEqual(normalize(authoredTrial.declaration[key]), normalize(context.trial[key]))) throw new Error(`Native ${key} differs from frozen trial`)
        }
        if(captureDeclaration)context.trial={...context.trial,...authoredTrial.declaration,executionProtocol:authoredTrial.executionProtocol}
      }
    }
    let tools: ResearchWorkflow.Tool[] = []
    let pipeline: ExecutionProtocol.PipelinePolicy | undefined
    let inspectionPipeline: ExecutionProtocol.PipelinePolicy | undefined
    let nativeExecution: ExecutionProtocol.NativeExecution | undefined
    let generatorSpecPreflight: Awaited<ReturnType<ScientificExecution["validateGeneratorSpecs"]>>
    if (proto && authoredTrial) {
      if (this.options.evidenceExecution === "legacy_dag_v1") throw new Error("Fresh native evaluation cannot select a legacy diagnostic DAG")
      const described = authoredTrial.nativeSearch ?? authoredTrial.staticConstruction?.nativeProjection
      const selected = [...new Set(described?.projection.flatMap(lane => lane.stages.flatMap(stage => stage.generators.map(generator => generator.key))) ?? [])]
      generatorSpecPreflight = await this.preflightGeneration(authoredTrial, selected)
      tools = await this.registeredTools()
      const generators = await this.registeredGenerators()
      const compiled = ResearchWorkflow.compileNative({trial: authoredTrial, contract, tools, generators, protoToolsCommit: proto.toolsCommit, protoLanguageCommit: proto.languageCommit})
      nativeExecution = compiled.nativeExecution
      assertFrozenAssets(frozenAssets,nativeExecution.descriptor)
      await auth?.authorizeNative?.({trialId:context.trial.id,contractHash:context.experiment.contractHash,descriptor:structuredClone(nativeExecution.descriptor)})
      if (installed.evidenceAdapter) pipeline = compiled.pipeline
      else inspectionPipeline = compiled.pipeline
    }
    return {context, sourceProgram, installed, storedTarget, proto, pipeline, inspectionPipeline, authoredTrial, tools, generatorSpecPreflight, nativeExecution,frozenAssets}
  }

  async validateTrial({trialId}: {trialId: string}) {
    const prepared = await this.prepare(trialId)
    return {trialId, programHash: prepared.context.trial.programHash, contractHash: prepared.context.experiment.contractHash,
      evaluator: prepared.installed.id, generatorSpecPreflight: prepared.generatorSpecPreflight, pipelineHash: prepared.pipeline ? ExecutionProtocol.hashPipeline(prepared.pipeline) : undefined,
      scientific: !!prepared.installed.evidenceAdapter, evidenceKind: prepared.installed.evidenceAdapter ? "scientific" : "plumbing_only"}
  }
  /** Reject a new proposal before scientific mutation if its execution identity is already bound. */
  async assertUnusedRequest(requestId: string): Promise<void> {
    const locations = [this.requestLocation(requestId), `.autofold/runs/run_${digest(this.projectId + ":" + requestId)}/request.json`]
    for (const relative of locations) {
      const record = await Bun.file(await checkedPath(this.workspace, relative)).json().catch(error => {if (error.code === "ENOENT") return undefined; throw error})
      if (record) throw new Error("Execution requestId is already bound; reconcile its original scientist request or choose a new requestId")
    }
  }
  private requestLocation(requestId: string) {
    if (!requestId.trim() || requestId.length > 4096) throw new Error("Execution requires a stable nonempty requestId")
    return path.join(".autofold", "execution", this.projectId, digest(requestId) + ".json")
  }
  async evaluateTrial(input: EvaluationRequest): Promise<Awaited<ReturnType<ScientificExecution["artifacts"]>>> {
    const key = `${this.workspace}:${this.projectId}:${input.requestId}`
    const existing = pending.get(key)
    if (existing) { await existing; return this.evaluateTrial(input) }
    const promise = this.evaluateOnce(input)
    pending.set(key, promise)
    try { return await promise } finally { if (pending.get(key) === promise) pending.delete(key) }
  }
  private async evaluateOnce(input: EvaluationRequest) {
    const requestPath = await checkedPath(this.workspace, this.requestLocation(input.requestId))
    await fs.mkdir(path.dirname(requestPath), {recursive: true, mode: 0o700})
    let record = await this.readRequest(input)
    if (!record) {
      if (input.signal?.aborted) throw new ExecutionCancelledError()
      const launchGrant = input.caller ? await this.options.research.assertTrustedJobLaunch(this.projectId,input.caller,{trialId:input.trialId}) : undefined
      const operationGrant = input.operationHandle ? await this.options.research.assertTrustedOperationLaunch(this.projectId,input.operationHandle,{trialId:input.trialId,origin:input.caller}) : undefined
      const deadlines = [this.options.authorization?.deadlineMs,launchGrant?.deadlineMs,operationGrant?.deadlineMs].filter((deadline): deadline is number=>deadline!==undefined)
      const prepared = await this.prepare(input.trialId)
      const runId = `run_${digest(this.projectId + ":" + input.requestId)}`
      const runRoot = await checkedPath(this.workspace, `.autofold/runs/${runId}`)
      const staging = `${runRoot}.${crypto.randomUUID()}.tmp`
      await fs.mkdir(staging, {recursive: true, mode: 0o700})
      const {context, installed, sourceProgram, storedTarget, proto, pipeline, nativeExecution,frozenAssets} = prepared
      await fs.copyFile(sourceProgram, path.join(staging, "trial.py"))
      if (await fileHash(path.join(staging, "trial.py")) !== context.trial.programHash) throw new Error("Program changed during immutable snapshot")
      if (storedTarget) await fs.copyFile(await checkedPath(this.workspace, storedTarget.targetArtifactPath), path.join(staging, "target.json"))
      const structure = storedTarget?.structureArtifactPath ? path.basename(storedTarget.structureArtifactPath) : undefined
      if (structure) {
        await fs.copyFile(await checkedPath(this.workspace, storedTarget!.structureArtifactPath!), path.join(staging, structure))
        if (await fileHash(path.join(staging, structure)) !== storedTarget!.artifact.structure!.contentHash) throw new Error("Target structure changed during immutable snapshot")
      }
      await assertSafeTree(path.dirname(this.workerRoot), this.workerRoot)
      await fs.cp(this.workerRoot, path.join(staging, "worker"), {recursive:true, filter:source => !source.includes("__pycache__") && !source.includes("/tests")})
      const frozenWorker = await workerTreeIdentity(path.join(staging, "worker"))
      const bundle = ExecutionProtocol.TrialBundle.parse({
        format: pipeline ? "autofold.trial-bundle.v4" : installed.evidenceAdapter ? "autofold.trial-bundle.v3" : "autofold.trial-bundle.v2",
        runId, trialId: context.trial.id, generationReplicateId: proto ? `grep_${runId.slice(4)}` : undefined,
        intent: context.trial.intent, contractHash: context.experiment.contractHash, targetArtifactHash: context.experiment.contract.targetArtifactHash,
        targetArtifactPath: storedTarget ? "target.json" : undefined, targetStructurePath: structure,
        evidenceAdapter: installed.evidenceAdapter ? {...installed.evidenceAdapter, scoringPipelineHash: context.experiment.contract.evaluator.evidenceAdapter?.scoringPipelineHash} : undefined,
        designAdapter: context.trial.designAdapter, programPath: "trial.py", programHash: context.trial.programHash, modality: context.experiment.contract.modality,
        evaluator: {id: installed.id, version: installed.version, sourceHash: installed.sourceHash, direction: installed.direction},
        proto, pipeline, pipelineHash: pipeline ? ExecutionProtocol.hashPipeline(pipeline) : undefined,
        pipelineCanonicalJson: pipeline ? ExecutionProtocol.canonicalPipelineJson(pipeline) : undefined,
        worker: proto ? frozenWorker : undefined, nativeExecution,
        ...(frozenAssets===undefined?{}:{frozenAssets}),
        seeds: context.experiment.contract.evaluator.fixedSeeds,
        ...(context.trial.generationSeed === undefined ? {} : {generationSeed:context.trial.generationSeed}),
        candidateBudget: context.experiment.contract.budget.maximumCandidates, submissionSize: context.experiment.contract.evaluator.submissionSize,
      })
      await atomicJSON(path.join(staging, "bundle.json"), bundle)
      if (storedTarget && await fileHash(path.join(staging, "target.json")) !== context.experiment.contract.targetArtifactHash) throw new Error("Target changed during immutable snapshot")
      const runtimeEnvironment = proto ? Object.fromEntries([...["PROTO_HOME", "AUTOFOLD_BOLTZGEN_EXECUTABLE", "AUTOFOLD_BOLTZGEN_CACHE", "AUTOFOLD_PXDESIGN_EXECUTABLE"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]), ["AUTOFOLD_PROTO_ROOT", proto.root]]) : undefined
      record = {format: "autofold.execution-request.v1", projectId: this.projectId, trialId: input.trialId, requestId: input.requestId, runId, state: "prepared", bundleHash: await fileHash(path.join(staging, "bundle.json")), workerHash: frozenWorker.sourceHash, workerPath: `.autofold/runs/${runId}/worker`, runtime: proto ? this.options.proto!.python : this.options.python ?? "python3", transportProfile: this.transport.snapshotProfile?.(), runtimeEnvironment, authorizationDeadlineMs: deadlines.length ? Math.min(...deadlines) : undefined, operationId: input.operationHandle?.operationId, timeoutMs: context.experiment.contract.budget.wallTimeMinutes * 60000}
      await atomicJSON(path.join(staging, "request.json"), record)
      const freeze = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
          const location = path.join(directory,entry.name)
          if (entry.isDirectory()) await freeze(location)
          const handle = await fs.open(location,"r")
          try {await handle.sync()} finally {await handle.close()}
          await fs.chmod(location,entry.isDirectory() ? 0o700 : 0o400)
        }
      }
      await freeze(staging)
      try {
        await fs.rename(staging, runRoot)
        const runDirectory = await fs.open(path.dirname(runRoot), "r")
        try { await runDirectory.sync() } finally { await runDirectory.close() }
        await atomicJSON(requestPath, record)
      } catch (error: any) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error
        // Another owner published first. Read its bound immutable intent;
        // a different trial using this requestId must fail before dispatch.
        record = await this.readRequest(input)
        if (!record) throw new ReceiptUnresolvedError(runId, "Existing snapshot has no recoverable immutable request intent")
        await fs.rm(staging, {recursive: true, force: true})
      }
    }
    return await this.executeRecord(record, input, requestPath)
  }
  private assertRequest(record: RequestRecord, input: {trialId: string; requestId: string}) {
    if (record.format !== "autofold.execution-request.v1" || record.projectId !== this.projectId || record.trialId !== input.trialId || record.requestId !== input.requestId || record.runId !== `run_${digest(this.projectId + ":" + input.requestId)}`) throw new Error("Execution requestId is already bound to another trial or project")
  }
  private async readRequest(input: {trialId: string; requestId: string}): Promise<RequestRecord | undefined> {
    const requestPath = await checkedPath(this.workspace, this.requestLocation(input.requestId))
    const read = async (file: string): Promise<RequestRecord | undefined> => Bun.file(file).json().catch(error => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    let record = await read(requestPath)
    // The mutable request index may advance state, never the original runtime,
    // sources, recipient, deadline or resources published with frozen inputs.
    const intent = await checkedPath(this.workspace, `.autofold/runs/run_${digest(this.projectId + ":" + input.requestId)}/request.json`)
    const original = await read(intent)
    if (record && original) {
      const {state: _indexState, ...indexed} = record
      const {state: _originalState, ...immutable} = original
      if (!isDeepStrictEqual(indexed, immutable)) throw new ReceiptUnresolvedError(record.runId, "Mutable request index differs from original immutable intent")
    }
    record ??= original
    if (record) this.assertRequest(record, input)
    return record
  }
  private async executeRecord(record: RequestRecord, input: EvaluationRequest, requestPath: string): Promise<Awaited<ReturnType<ScientificExecution["artifacts"]>>> {
    this.assertRequest(record, input)
    let run = await this.options.research.getRun(this.projectId, record.runId).catch((error) => {
      if (error instanceof ResearchService.NotFoundError) return undefined
      throw error
    })
    if (!run) {
      try {
        run = await this.options.research.beginRun(this.projectId, input.trialId, {runId: record.runId, bundlePath: `.autofold/runs/${record.runId}/bundle.json`, outputPath: `.autofold/runs/${record.runId}/output`, jobId: `job_${record.runId.slice(4)}`})
      } catch (error) {
        // Recovery and the previous owner may reach beginRun together. Only the
        // same durable run binding can satisfy that race.
        run = await this.options.research.getRun(this.projectId, record.runId).catch(() => undefined)
        if (!run) throw error
      }
    }
    if (run.trialId !== input.trialId) throw new Error("Execution run is bound to another trial")
    if (run.status === "succeeded") return this.artifacts(run.id, record.bundleHash)
    if (["failed", "cancelled"].includes(run.status)) throw new Error(run.error || `Existing request ended ${run.status}; it will not be dispatched again`)
    if (record.state !== "prepared") return this.reconcileRecord(record, input.signal, false, input.caller, input.operationHandle)
    const fencePath = await checkedPath(this.workspace, `.autofold/runs/${record.runId}/dispatch.json`)
    if (await Bun.file(fencePath).exists()) return this.reconcileRecord(record, input.signal, false, input.caller, input.operationHandle)
    // An original prepared request is bound to its own sources and runtime;
    // host upgrades do not trigger new construction or reinterpret its protocol.
    await (await this.dispatchInput(record, input.signal, false, input.caller, input.operationHandle)).authorizeStart?.()
    if (input.signal?.aborted) {await this.options.research.cancelRun(this.projectId, run.id); throw new ExecutionCancelledError()}
    // Host transport readiness and immutable staging are retryable preparation,
    // not authority to launch compute. Only a successful preflight may acquire the dispatch fence.
    try {await this.transport.preflight?.(await this.dispatchInput(record, input.signal, false, input.caller, input.operationHandle))}
    catch (error) {
      if (input.signal?.aborted) {await this.options.research.cancelRun(this.projectId, run.id); throw new ExecutionCancelledError()}
      throw error
    }
    if (input.signal?.aborted) {await this.options.research.cancelRun(this.projectId, run.id); throw new ExecutionCancelledError()}
    // Canonical authority can change during staging/preflight while the native
    // lease stays live. Reject before recording dispatch, then recheck at spawn.
    if (record.operationId || input.operationHandle) {
      if (!input.operationHandle || record.operationId !== input.operationHandle.operationId) throw new Error("First launch requires the original canonical operation capability")
      await this.options.research.assertTrustedOperationLaunch(this.projectId,input.operationHandle,{trialId:record.trialId,origin:input.caller})
    }
    // Exclusive-create is the durable at-most-once dispatch authority. The
    // Atomic snapshot publication binds each request; this fence ensures
    // neither recovery nor a competing owner can dispatch it a second time.
    let fence
    try { fence = await fs.open(fencePath, "wx", 0o400) } catch (error: any) {
      if (error.code === "EEXIST") return this.reconcileRecord(record, input.signal, false, input.caller, input.operationHandle)
      throw error
    }
    try {
      await fence.writeFile(JSON.stringify({format: "autofold.dispatch-intent.v1", requestId: record.requestId, runId: record.runId, trialId: record.trialId, bundleHash: record.bundleHash, ...(this.transport.kind === "remote" ? {remoteLaunchProtocol: "autofold.host-launch-fence.v1"} : {})}) + "\n")
      await fence.sync()
    } finally { await fence.close() }
    const root = await fs.open(path.dirname(fencePath), "r")
    try { await root.sync() } finally { await root.close() }
    await atomicJSON(requestPath, {...record, state: "dispatching"})
    let completion
    try { completion = await this.transport.dispatch(await this.dispatchInput(record, input.signal, false, input.caller, input.operationHandle)) } catch (error) {
      if (this.transport.kind === "remote" || error instanceof ReceiptUnresolvedError) throw new ReceiptUnresolvedError(run.id, compactRunError(error))
      await this.options.research.failRun(this.projectId, run.id, compactRunError(error))
      throw error
    }
    const receipt = await this.finalize(record, completion)
    await atomicJSON(requestPath, {...record, state: "finished"})
    return receipt
  }
  private async dispatchInput(record: RequestRecord, signal?: AbortSignal, reconciliation = false, caller?: ExecutionCaller, operationHandle?: OperationDomain.Handle): Promise<Dispatch> {
    const run = await this.options.research.getRun(this.projectId, record.runId)
    const context = await this.options.research.getTrialContext(this.projectId, run.trialId)
    const bundlePath = await checkedPath(this.workspace, run.bundlePath)
    const outputPath = await checkedPath(this.workspace, run.outputPath)
    if (await fileHash(bundlePath) !== record.bundleHash) throw new Error("Frozen bundle changed before dispatch")
    const bundle = ExecutionProtocol.TrialBundle.parse(await Bun.file(bundlePath).json())
    const originalWorker = record.workerPath ? await checkedPath(this.workspace, record.workerPath) : this.workerRoot
    if ((await workerTreeIdentity(originalWorker)).sourceHash !== record.workerHash) throw new Error("Frozen worker implementation closure changed")
    const installed = (await this.installed(originalWorker)).find(item => item.id === bundle.evaluator.id && item.version === bundle.evaluator.version)
    if (!installed || installed.sourceHash !== context.experiment.contract.evaluator.sourceHash || installed.sourceHash !== bundle.evaluator.sourceHash || installed.evidenceAdapter?.sourceHash !== context.experiment.contract.evaluator.evidenceAdapter?.sourceHash) throw new Error("Trusted evaluator source changed before dispatch")
    if (bundle.worker && bundle.worker.sourceHash !== record.workerHash) throw new Error("Original bundle worker identity differs")
    if (bundle.runId !== run.id || bundle.trialId !== run.trialId || bundle.programHash !== context.trial.programHash || bundle.contractHash !== context.experiment.contractHash) throw new Error("Original bundle scientific identity differs")
    if (bundle.designAdapter !== context.trial.designAdapter || bundle.intent !== context.trial.intent || bundle.candidateBudget !== context.experiment.contract.budget.maximumCandidates || bundle.submissionSize !== context.experiment.contract.evaluator.submissionSize || !isDeepStrictEqual(bundle.seeds, context.experiment.contract.evaluator.fixedSeeds) || bundle.format !== "autofold.trial-bundle.v1" && bundle.targetArtifactHash !== context.experiment.contract.targetArtifactHash) throw new Error("Original bundle frozen input scope differs")
    const resource = (name: string) => checkedPath(this.workspace, path.relative(this.workspace, path.isAbsolute(name) ? name : path.join(path.dirname(bundlePath), name)))
    if (await fileHash(await resource(bundle.programPath)) !== bundle.programHash) throw new Error("Original program bytes changed")
    if (typeof bundle.targetArtifactPath === "string") {
      const target = await resource(bundle.targetArtifactPath)
      if (await fileHash(target) !== bundle.targetArtifactHash) throw new Error("Original target bytes changed")
      if (typeof bundle.targetStructurePath === "string") {
        const artifact = ResearchArtifacts.TargetArtifact.parse(await Bun.file(target).json())
        if (!artifact.structure || await fileHash(await resource(bundle.targetStructurePath)) !== artifact.structure.contentHash) throw new Error("Original target structure bytes changed")
      }
    } else if (bundle.targetStructurePath) throw new Error("Original structure has no frozen target identity")
    assertFrozenAssets(bundle.frozenAssets,bundle.nativeExecution?.descriptor)
    if (bundle.nativeExecution && bundle.nativeExecution.resources.maximumWorkerWallSeconds * 1000 > record.timeoutMs) throw new Error("Native worker wall authority exceeds original request ceiling")
    const dispatchFence = await Bun.file(await checkedPath(this.workspace, `.autofold/runs/${record.runId}/dispatch.json`)).json().catch(error => {if (error.code === "ENOENT") return undefined; throw error})
    const command = [record.runtime ?? (bundle.designAdapter === "proto" ? this.options.proto?.python : this.options.python ?? "python3"), path.join(originalWorker, "run_worker.py"), "--bundle", bundlePath, "--output", outputPath, "--evaluator-source", installed.sourcePath, ...(installed.evidenceSource ? ["--evidence-adapter-source", installed.evidenceSource] : [])]
    if (!command[0]) throw new Error("Pinned Proto Python runtime is unavailable")
    return {runId: record.runId, requestId: record.requestId, transportProfile: record.transportProfile, requireOriginalProfile: this.transport.kind === "remote" && !!this.transport.snapshotProfile, runtimeEnvironment: record.runtimeEnvironment, command: command as string[], workspace: this.workspace,
      bundlePath, outputPath, workerHash: record.workerHash, authorizationDeadlineMs:record.authorizationDeadlineMs, allowFirstRemoteLaunch: dispatchFence?.remoteLaunchProtocol === "autofold.host-launch-fence.v1", authorizeStart: async () => {
        const latest = await this.options.research.getTrialContext(this.projectId, record.trialId)
        ResearchDomain.assertContractIntegrity(latest.experiment)
        const auth = this.options.authorization, gpuSeconds = latest.experiment.contract.budget.gpuHours * 3600
        if (this.transport.kind === "remote" && !auth?.remote) throw new Error("Original remote execution requires live host authorization")
        if (bundle.designAdapter === "proto" && this.transport.kind === "local" && !auth?.localProto) throw new Error("Original local Proto execution requires live host authorization")
        if (bundle.designAdapter === "proto" && (!Number.isFinite(auth?.maximumGpuSeconds) || gpuSeconds > auth!.maximumGpuSeconds!)) throw new Error("Original compute reservation exceeds live host authorization")
        if (auth?.maximumCandidates !== undefined && bundle.candidateBudget > auth.maximumCandidates) throw new Error("Original candidate pool exceeds live host authorization")
        if (auth?.maximumWallTimeMinutes !== undefined && record.timeoutMs > auth.maximumWallTimeMinutes * 60000) throw new Error("Original wall-time authority exceeds live host authorization")
        if(await fileHash(bundlePath)!==record.bundleHash)throw new Error('Frozen bundle changed before scientific launch')
        assertFrozenAssets(bundle.frozenAssets,bundle.nativeExecution?.descriptor)
        if(bundle.nativeExecution)await auth?.authorizeNative?.({trialId:record.trialId,contractHash:bundle.contractHash,descriptor:structuredClone(bundle.nativeExecution.descriptor)})
        await auth?.authorize?.({trialId: record.trialId, gpuSeconds, capability: this.transport.kind === "remote" ? "remote" : bundle.designAdapter === "proto" ? "local_proto" : "local_mock"})
        if (latest.experiment.status !== "active" || latest.campaign.status !== "active") throw new Error("Scientific scope no longer permits a first launch")
        if (record.operationId || operationHandle) {
          if (!operationHandle || record.operationId !== operationHandle.operationId) throw new Error("First launch requires the original canonical operation capability")
          const operationGrant = await this.options.research.assertTrustedOperationLaunch(this.projectId,operationHandle,{trialId:record.trialId,origin:caller})
          if (operationGrant.deadlineMs !== undefined && (record.authorizationDeadlineMs === undefined || operationGrant.deadlineMs < record.authorizationDeadlineMs)) throw new Error("Original canonical process grant narrowed after immutable preparation")
        }
        if (record.authorizationDeadlineMs !== undefined && record.authorizationDeadlineMs <= Date.now()) throw new Error("Original process authorization deadline expired")
        if (latest.trial.origin?.jobId) {
          // Synthetic direct lanes have no managed job; managed origins require
          // the current caller's epoch, never a lease borrowed from a replacement.
          const managed = await this.options.research.hasTrustedJob(this.projectId, latest.trial.origin.jobId)
          if (managed || caller) {
            if (!caller || caller.jobId !== latest.trial.origin.jobId) throw new Error("First launch requires the owning job's exact lease epoch")
            const latestGrant = await this.options.research.assertTrustedJobLaunch(this.projectId,caller,{trialId:record.trialId})
            if (record.authorizationDeadlineMs !== undefined && record.authorizationDeadlineMs <= Date.now()) throw new Error("Original process authorization deadline expired")
            if (latestGrant.deadlineMs !== undefined && (record.authorizationDeadlineMs === undefined || latestGrant.deadlineMs < record.authorizationDeadlineMs)) throw new Error("Original process grant narrowed after immutable preparation")
          }
        }
      }, timeoutMs: record.timeoutMs, signal,
      onStarted: async () => { await this.options.research.attachRunJob(this.projectId, run.id, run.jobId ?? `job_${run.id.slice(4)}`) }}
  }
  private async finalize(record: RequestRecord, completion: {status: string; error?: string}) {
    const run = await this.options.research.getRun(this.projectId, record.runId)
    if (completion.status === "pending") throw new ReceiptUnresolvedError(run.id)
    if (!["succeeded", "failed", "cancelled"].includes(completion.status)) throw new ReceiptUnresolvedError(run.id, "Invalid terminal transport completion")
    // Publish the original trusted transport observation before updating projections.
    // A failed projection alone cannot establish that an external effect stopped.
    const payload = {format: "autofold.transport-terminal.v1", projectId: this.projectId, requestId: record.requestId,
      runId: record.runId, trialId: record.trialId, bundleHash: record.bundleHash, workerHash: record.workerHash,
      transport: this.transport.kind, status: completion.status}
    const evidence = {...payload, receiptHash: `sha256:${digest(JSON.stringify(payload))}`}
    const receiptPath = await checkedPath(this.workspace, `.autofold/runs/${run.id}/transport-terminal.json`)
    const temporary = `${receiptPath}.${crypto.randomUUID()}.tmp`
    const handle = await fs.open(temporary, "wx", 0o400)
    try {
      try {await handle.writeFile(JSON.stringify(evidence) + "\n"); await handle.sync()} finally {await handle.close()}
      // Linking publishes complete bytes exclusively, including concurrent finalizers.
      try {await fs.link(temporary, receiptPath)} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (!isDeepStrictEqual(await Bun.file(receiptPath).json(), evidence)) throw new ReceiptUnresolvedError(run.id, "Original terminal transport receipt conflicts")
      }
      const directory = await fs.open(path.dirname(receiptPath), "r")
      try {await directory.sync()} finally {await directory.close()}
    } finally {await fs.rm(temporary, {force: true})}
    if (completion.status === "cancelled") {
      await this.options.research.cancelRun(this.projectId, run.id, completion.error)
      throw new ExecutionCancelledError()
    }
    const context = await this.options.research.getTrialContext(this.projectId, run.trialId)
    if (completion.status === "failed") {
      const output = await checkedPath(this.workspace, run.outputPath)
      const stage = await Bun.file(path.join(output, "execution-stage.json")).json().catch(() => undefined)
      const message = await stageFailureDetail(output, stage, completion.error)
      await this.options.research.failRun(this.projectId, run.id, message, undefined, {failureReceiptHash: evidence.receiptHash})
      throw new Error(message)
    }
    try {
      const verified = await readVerifiedRunReceipt({workspace: this.workspace, run, context, requirePersistedManifestHash: false, expectedBundleHash: record.bundleHash})
      const result = verified.result
      if (run.status === "queued") await this.options.research.attachRunJob(this.projectId, run.id, run.jobId ?? `job_${run.id.slice(4)}`)
      await this.options.research.completeRun(this.projectId, run.id, {contractHash: result.contractHash, evaluatorHash: result.evaluatorHash, valid: result.valid, score: result.score, diagnostics: result.diagnostics}, verified.manifestHash, undefined, {
        candidateSequences: verified.candidates.candidates.map(candidate => candidate.sequence),
        modelIds: [...new Set(verified.modelRuns?.entries.filter(entry => !("status" in entry) || entry.status !== "skipped").map(entry => String(entry.modelId)) ?? [])],
        generationReplicate: verified.generationRuns?.replicate,
        generationWallSeconds: verified.generationRuns?.runtime.wallSeconds,
        generatorDiagnostics: verified.generationRuns?.generatorDiagnostics ?? [],
      })
      return this.artifacts(run.id, record.bundleHash)
    } catch (error) {
      if (this.transport.kind === "remote" && (error as any).code === "ENOENT") throw new ReceiptUnresolvedError(run.id, "Completion artifacts unavailable")
      await this.options.research.failRun(this.projectId, run.id, compactRunError(error), undefined, {failureReceiptHash: evidence.receiptHash})
      throw error
    }
  }
  private async reconcileRecord(record: RequestRecord, signal?: AbortSignal, observeOnly = false, caller?: ExecutionCaller, operationHandle?: OperationDomain.Handle) {
    const run = await this.options.research.getRun(this.projectId, record.runId)
    if (run.status === "succeeded") return this.artifacts(run.id, record.bundleHash)
    if (this.transport.kind === "local" && !this.transport.reconcile && await Bun.file(path.join(await checkedPath(this.workspace, run.outputPath), "manifest.json")).exists()) {
      if (run.status === "queued") await this.options.research.attachRunJob(this.projectId, run.id, run.jobId!)
      return this.finalize(record, {status: "succeeded"})
    }
    if (!this.transport.reconcile) throw new ReceiptUnresolvedError(run.id)
    const input = await this.dispatchInput(record, signal, true, caller, operationHandle)
    if (observeOnly) {input.allowFirstRemoteLaunch = false; input.authorizeStart = undefined}
    return this.finalize(record, await this.transport.reconcile(input))
  }
  /** Reconcile original owned runs using receipts only. Never stage, dispatch or first-launch.
   * Missing intent, unavailable transport or absent receipt stays unknown, including after expiry.
   */
  async reconcileOwnedEffects(job: ResearchDomain.Job, signal?: AbortSignal) {
    const experimentId = typeof job.payload.experimentId === 'string' ? job.payload.experimentId : undefined
    if (!experimentId) return
    const history = await this.options.research.history(this.projectId, experimentId)
    for (const run of history.runs) {
      const trial = history.trials.find(trial=>trial.id===run.trialId)
      if (trial?.origin?.jobId !== job.id || !['queued', 'running'].includes(run.status)) continue
      signal?.throwIfAborted()
      const intent = await Bun.file(await checkedPath(this.workspace, `.autofold/runs/${run.id}/request.json`)).json().catch(error => {
        if (error.code === 'ENOENT') throw new ReceiptUnresolvedError(run.id, 'Owned run has no original execution intent')
        throw error
      }) as RequestRecord
      if (intent.runId !== run.id) throw new Error('Recovery intent belongs to another run')
      const record = await this.readRequest({trialId: trial.id, requestId: intent.requestId})
      if (!record) throw new ReceiptUnresolvedError(run.id, 'Original request cannot be recovered')
      await this.reconcileRecord(record, signal, true)
    }
  }
  async reconcile(input: EvaluationRequest) {
    const record = await this.readRequest(input)
    if (!record) throw new ReceiptUnresolvedError(`run_${digest(this.projectId + ":" + input.requestId)}`, "No published immutable request intent is available")
    const requestPath = await checkedPath(this.workspace, this.requestLocation(input.requestId))
    await fs.mkdir(path.dirname(requestPath), {recursive: true, mode: 0o700})
    return this.executeRecord(record, input, requestPath)
  }
  async artifacts(runId: string, expectedBundleHash?: string) {
    const run = await this.options.research.getRun(this.projectId, runId)
    if (run.status !== "succeeded") throw new Error(`Run ${runId} has no verified successful receipt`)
    const context = await this.options.research.getTrialContext(this.projectId, run.trialId)
    const {bundle, candidates, result: evaluation, manifest, modelRuns, generationRuns, verifiedModelArtifacts, nativeSearch} = await readVerifiedRunReceipt({workspace: this.workspace, run, context, requirePersistedManifestHash: true, persistedManifestHash: run.manifestHash, expectedBundleHash})
    const modelEvidence = modelRuns?.entries.map(entry => {
      if ("status" in entry && entry.status === "skipped") return {candidateId: entry.candidateId, stage: entry.stage, modelId: entry.modelId, seed: entry.seed, status: "skipped" as const, reason: entry.reason}
      const artifact = verifiedModelArtifacts.get(String(entry.artifactPath))!
      return {candidateId: entry.candidateId, ...("stage" in artifact ? {stage: artifact.stage} : {}), modelId: artifact.model.id, seed: entry.seed, status: "completed" as const, parametersHash: artifact.parametersHash, ...("runtime" in artifact ? {runtime: artifact.runtime} : {}), metrics: artifact.metrics}
    }) ?? []
    return {run, trial: context.trial, candidates, evaluation, manifest, modelRuns, modelEvidence, generationRuns, nativeSearch,
      comparisonContext:{format:bundle.format,contractHash:bundle.contractHash,targetArtifactHash:bundle.format==='autofold.trial-bundle.v1'?undefined:bundle.targetArtifactHash,
        modality:bundle.modality,candidateBudget:bundle.candidateBudget,submissionSize:bundle.submissionSize,seeds:bundle.seeds,evaluator:bundle.evaluator,generationSeed:bundle.generationSeed,
        evidenceAdapter:bundle.format==='autofold.trial-bundle.v4'||bundle.format==='autofold.trial-bundle.v3'?bundle.evidenceAdapter:undefined,
        pipelineHash:bundle.format==='autofold.trial-bundle.v4'?bundle.pipelineHash:undefined,worker:bundle.worker,proto:bundle.proto,
        // The verifier above established this contract's hash/integrity against the immutable bundle.
        frozenContractHash:context.experiment.contractHash,frozenContract:context.experiment.contract},
      evidenceCompleteness: bundle.format === "autofold.trial-bundle.v4" && modelRuns?.format === "autofold.model-run-index.v2" ? evidenceCompleteness(bundle.pipeline, modelRuns) : undefined,
      pipeline: bundle.format === "autofold.trial-bundle.v4" ? bundle.pipeline : undefined,
      worker: bundle.worker, nativeExecution: bundle.nativeExecution,
      incumbent: context.experiment.incumbentTrialId === run.trialId, scientific: bundle.evaluator.id !== "mock-peptide-panel",
      evidenceKind: bundle.evaluator.id === "mock-peptide-panel" ? "plumbing_only" as const : "scientific" as const}
  }
  /** Verify an original terminal effect without inference, staging, or transport calls.
   * Historical failures without a captured transport observation remain unresolved.
   */
  async failureReceipt(runId: string) {
    const run = await this.options.research.getRun(this.projectId, runId)
    if (run.status !== "failed" && run.status !== "cancelled") throw new ReceiptUnresolvedError(runId, "Run has no failed or cancelled terminal projection")
    const read = async (name: string) => Bun.file(await checkedPath(this.workspace, `.autofold/runs/${runId}/${name}`)).json().catch(error => {
      if (error.code === "ENOENT") throw new ReceiptUnresolvedError(runId, `Original ${name} unavailable`)
      throw error
    })
    const intent = await read("request.json") as RequestRecord
    this.assertRequest(intent, {trialId: run.trialId, requestId: intent.requestId})
    if (intent.runId !== runId) throw new ReceiptUnresolvedError(runId, "Original request belongs to another run")
    const record = await this.readRequest({trialId: run.trialId, requestId: intent.requestId})
    if (!record || ["bundleHash", "workerHash", "runId", "trialId", "requestId"].some(key => (record as any)[key] !== (intent as any)[key])) throw new ReceiptUnresolvedError(runId, "Original request binding differs")
    await this.dispatchInput(record, undefined, true) // Verify the frozen worker, evaluator, and bundle only.
    const fence = await read("dispatch.json")
    if (fence.format !== "autofold.dispatch-intent.v1" || fence.runId !== runId || fence.trialId !== run.trialId || fence.requestId !== intent.requestId || fence.bundleHash !== intent.bundleHash) throw new ReceiptUnresolvedError(runId, "Original dispatch binding differs")
    const evidence = await read("transport-terminal.json")
    const {receiptHash, ...payload} = evidence
    const expected = {format: "autofold.transport-terminal.v1", projectId: this.projectId, requestId: intent.requestId,
      runId, trialId: run.trialId, bundleHash: intent.bundleHash, workerHash: intent.workerHash, transport: this.transport.kind, status: evidence.status}
    if (!isDeepStrictEqual(payload, expected) || receiptHash !== `sha256:${digest(JSON.stringify(payload))}` || !["failed", "cancelled", "succeeded"].includes(evidence.status) || (run.status === "cancelled" && evidence.status !== "cancelled")) throw new ReceiptUnresolvedError(runId, "Original terminal transport receipt differs")
    return {runId, requestId: intent.requestId, trialId: run.trialId, bundleHash: intent.bundleHash, workerHash: intent.workerHash,
      status: run.status, transportStatus: evidence.status as "failed" | "cancelled" | "succeeded", receiptHash: receiptHash as string,
      receiptId: `transport:${runId}:${receiptHash}`}
  }
}
