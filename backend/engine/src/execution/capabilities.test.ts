import {nativeFixtureRoot} from './native-fixture'
import {withNativeSearch} from './native-fixture'
import {ProtoRuntimeInspection} from './proto-inspection'
import {afterEach, expect, spyOn, test} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {ResearchDomain} from "@autofold/science-core/domain"
import {ResearchWorkflow} from "@autofold/science-core/workflow"
import {ResearchService} from "@autofold/science-core/service"
import {StorageResearchStore} from "@autofold/science-core/store"
import {ResearchArtifacts} from "@autofold/science-core/artifacts"
import {ScientificExecution, fileHash} from "./index"
import {assertCapabilities, localCapabilities} from "./capabilities"
import {RemoteWorkerTransport, type RemoteCommandRunner} from "./remote"
import {PiJobController} from "../jobs"
import {runNativeAcceptance} from "../acceptance"

const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
async function directory() {const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "host-preflight-"))); roots.push(root); return root}
async function git(root: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], {stdout: "pipe", stderr: "pipe"})
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code) throw new Error(error); return out.trim()
}
async function pinnedRuntime(root: string) {
  const protoRoot = path.join(root, "proto")
  const pins = []
  for (const name of [protoRoot, path.join(protoRoot, "proto-tools")]) {
    await fs.mkdir(name, {recursive: true})
    await git(name, ["init", "-q"])
    await git(name, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Offline fixture"])
    pins.push(await git(name, ["rev-parse", "HEAD"]))
  }
  return {root: protoRoot, python: "/usr/bin/python3", languageCommit: pins[0]!, toolsCommit: pins[1]!}
}
async function executable(file: string, marker: string) {await fs.writeFile(file, `#!/bin/sh\nprintf invoked > '${marker}'\n`, {mode: 0o700})}
/** Portable installed-lane fixture: exercise the selected native parser imports and
 * converter protocol with a tiny stdlib package, without any real model runner. */
async function installedPxParser(workspace: string) {
  const root = path.join(workspace, "installed-px"), bin = path.join(root, "bin"), cache = path.join(root, "release_data/ccd_cache")
  const marker = path.join(root, "converter-receipt.json"), cli = path.join(bin, "pxdesign")
  await Promise.all([fs.mkdir(bin, {recursive: true}), fs.mkdir(cache, {recursive: true}), fs.mkdir(path.join(root, "pxdesign/utils"), {recursive: true})])
  await fs.writeFile(path.join(cache, "components.cif"), "data_offline_fixture\n")
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(path.join(bin, "python"), `#!/bin/sh
export PYTHONPATH=${quote(root)}
export PROTENIX_DATA_ROOT_DIR=${quote(cache)}
export TOOL_WEIGHTS_ROOT=${quote(path.join(root, "tool_weights"))}
exec /usr/bin/python3 "$@"
`, {mode: 0o700})
  await fs.writeFile(cli, `#!${path.join(bin, "python")}\nraise AssertionError("Design CLI must never execute in preflight")\n`, {mode: 0o700})
  await fs.writeFile(path.join(root, "pxdesign/__init__.py"), "")
  await fs.writeFile(path.join(root, "pxdesign/utils/__init__.py"), "")
  await fs.writeFile(path.join(root, "pxdesign/utils/inputs.py"), `import json
from pathlib import Path
def parse_yaml_to_json(spec_path, _unused):
    spec = json.loads(Path(spec_path).read_text())
    target = spec["target"]
    # Deliberately use internal chain B so the host must honor converter metadata.
    assert list(target["chains"]) == ["A"]
    return [{"target_file": target["file"], "condition": {"filter": {"chain_id": ["B"]}}, "hotspot": {"B": target["chains"]["A"].get("hotspots", [])}}]
`)
  await fs.writeFile(path.join(root, "pxdesign/utils/infer.py"), `import json, os
from pathlib import Path
class Column(list):
    def __eq__(self, value):
        return [item == value for item in self]
class AtomArray:
    def __init__(self, rows):
        self.rows = rows
        self.chain_id = Column(row[0] for row in rows)
        self.res_id = Column(row[1] for row in rows)
    def __getitem__(self, mask):
        return AtomArray([row for row, keep in zip(self.rows, mask) if keep])
def convert_to_bioassembly_dict(task, output_dir):
    assert os.environ["CUDA_VISIBLE_DEVICES"] == ""
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
    rows = [("B", int(line[22:26])) for line in Path(task["target_file"]).read_text().splitlines() if line.startswith("ATOM") and line[21] == "A"]
    assert rows
    receipt = {"selectedChains": task["condition"]["filter"]["chain_id"], "residueCount": len(set(row[1] for row in rows)), "hotspots": task["hotspot"], "gpuDisabled": True, "offline": True}
    (Path(__file__).resolve().parents[2] / "converter-receipt.json").write_text(json.dumps(receipt))
    return {"atom_array": AtomArray(rows)}
`)
  return {cli, marker}
}
const workerRoot = path.resolve(import.meta.dir, "../../../worker")
const shellRunner = (commands: string[][]): RemoteCommandRunner => async (argv, options) => {
  commands.push([...argv])
  if (argv[0] !== "ssh") throw new Error("Preflight must not stage files")
  const child = Bun.spawn(["/bin/sh", "-c", argv.at(-1)!], {stdin: options?.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe"})
  if (options?.stdin !== undefined && child.stdin) {child.stdin.write(options.stdin); child.stdin.end()}
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code) throw new Error(error); return out
}

async function scientificFixture(missingPython = false) {
  const workspace = await directory(), proto = await pinnedRuntime(workspace), projectId = "host_preflight"
  if (missingPython) proto.python = path.join(workspace, "missing-python")
  const store = new StorageResearchStore({directory: path.join(workspace, "research")}), research = new ResearchService.Service(store)
  let dispatches = 0
  const execution = new ScientificExecution({workspace, projectId, research, proto, inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, authorization: {localProto: true, maximumGpuSeconds: 3600}, transport: {kind: "local", dispatch: async () => {dispatches++; throw new Error("No scientific dispatch permitted")}}})
  const evaluator = (await execution.evaluators()).find(item => item.id === "peptide-panel")!
  const target = await ResearchArtifacts.authorTarget(workspace, {format: "autofold.target-artifact.v1", name: "Offline target", chains: [{id: "A", sequence: "ACDEFGHIK"}], bindingSite: {residues: [{chainId: "A", position: 1}]}})
  const campaign = await research.createCampaign(projectId, {objective: "No wasted inference"}); await research.activateCampaign(projectId, campaign.id)
  const experiment = await research.createExperiment(projectId, campaign.id, {contract: {version: 1, objective: "Preflight admission fixture", targetArtifactHash: target.targetArtifactHash, modality: "short_peptide", budget: {maximumCandidates: 1, gpuHours: 1, wallTimeMinutes: 1}, evaluator: {...evaluator, fixedSeeds: [7], submissionSize: 1}}})
  await research.activateExperiment(projectId, experiment.id)
  return {workspace, projectId, store, research, execution, experiment, campaign, proto, sessionDirectory: path.join(workspace, "pi"), dispatches: () => dispatches}
}

test("remote inventory checks frozen runtime paths without running optional generators; absent PXDesign leaves BoltzGen available", async () => {
  const root = await directory(), proto = await pinnedRuntime(root), marker = path.join(root, "invoked"), commands: string[][] = []
  const boltzgen = path.join(root, "boltzgen"), cache = path.join(root, "cache")
  await executable(boltzgen, marker); await fs.mkdir(cache)
  const profile = {host: "fixture", root: path.join(root, "runs"), python: proto.python, protoRoot: proto.root, protoHome: cache, boltzgenExecutable: boltzgen, boltzgenCache: cache, pxdesignExecutable: path.join(root, "absent-pxdesign")}
  const transport = new RemoteWorkerTransport({profile, workerRoot, run: shellRunner(commands)})
  const inventory = await transport.capabilities({proto})
  expect(inventory.runtime.every(item => item.available)).toBe(true)
  expect(inventory.generators.find(item => item.id === "boltzgen-binder")?.available).toBe(true)
  expect(inventory.generators.find(item => item.id === "pxdesign-binder")?.available).toBe(false)
  expect(() => assertCapabilities(inventory, ["boltzgen-binder"])).not.toThrow()
  expect(() => assertCapabilities(inventory, ["pxdesign-binder"])).toThrow("PXDesign")
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(await Bun.file(profile.root).exists()).toBe(false)
  expect(commands).toHaveLength(1)
  expect(commands[0]!.at(-1)).not.toMatch(/mkdir|scp|launch|python.* -c/)
  expect(transport.profile).toEqual(profile)
})

test("local inventory checks executability and selected overrides without invoking a CLI", async () => {
  const root = await directory(), marker = path.join(root, "invoked"), cli = path.join(root, "pxdesign")
  await executable(cli, marker)
  const report = await localCapabilities("/usr/bin/python3", {generators: [{id: "pxdesign-binder", config: {executable: cli}}]})
  expect(report.generators[0]!.available).toBe(true)
  await fs.chmod(cli, 0o600)
  const missing = await localCapabilities("/usr/bin/python3", {generators: [{id: "pxdesign-binder", config: {executable: cli}}]})
  expect(() => assertCapabilities(missing, ["pxdesign-binder"])).toThrow("PXDesign")
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("selected unavailable generator is rejected during native inspection before config validation, trial creation or dispatch", async () => {
  const f = await scientificFixture(), programPath = path.join(f.workspace, "trial.py")
  await fs.writeFile(programPath, "def build_trial(ctx): raise AssertionError('Fixture must never load authored code')\n")
  const describe = spyOn(ProtoRuntimeInspection, "describeTrial").mockResolvedValue(withNativeSearch({generation: {generators: ["pxdesign-binder"], allocations: [{generator: "pxdesign-binder", maximumCandidates: 1, maximumGpuSeconds: 1}], maximumCandidates: 1, maximumGpuSeconds: 1}, program: {kind: "portfolio", optimizerCount: 1, constructCount: 1, generatorCount: 1, proposalSources: [null], fixedSequences: [], programResultCount: 1, optimizerSamples: [{numSamples: 1, numResults: 1, proposalBatchSize: 1}]}, diagnostics: [], declaration: {intent: "optimize"}, hypothesis: "Unavailable lane", generatorPreflight: {generators: [{id: "pxdesign-binder", config: {executable: path.join(f.workspace, "missing-pxdesign")}, sequenceLength: 8, targetPdb: "internal fixture"}]}}, {key: "pxdesign-binder"}))
  const extract = spyOn(ProtoRuntimeInspection, "extract").mockResolvedValue(undefined)
  let validations = 0
  const configs = spyOn(ProtoRuntimeInspection, "validateConfigs").mockImplementation(async () => {validations++; throw new Error("Must reject before config validation")})
  try {
    await expect(f.execution.inspectProgram({experiment: f.experiment, campaign: f.campaign, programPath: "trial.py", programHash: await fileHash(programPath)})).rejects.toThrow("PXDesign")
    const state = await f.store.read(f.projectId)
    expect(Object.values(state.trials)).toHaveLength(0); expect(Object.values(state.runs)).toHaveLength(0)
    expect(validations).toBe(0); expect(f.dispatches()).toBe(0)
  } finally {describe.mockRestore(); extract.mockRestore(); configs.mockRestore()}
})

test("runtime preflight failure precedes native acceptance job admission and Pi inference", async () => {
  const f = await scientificFixture(true)
  let runtimeCalls = 0
  const jobs = new PiJobController({...f, runtimeFactory: () => {runtimeCalls++; throw new Error("No runtime on failed preflight")}})
  const profile = {id: "fixture", mode: "local" as const, sourcePath: path.join(f.workspace, "profile.json")}; await fs.writeFile(profile.sourcePath, "{}")
  await expect(runNativeAcceptance({...f, jobs, profile}, f.experiment.id, {idempotencyKey: "missing-runtime", iterations: 1})).rejects.toThrow("Python")
  expect(await jobs.list()).toHaveLength(0)
  const job = await jobs.enqueueDiscovery(f.experiment.id, {idempotencyKey: "queued-missing-runtime", iterations: 1})
  await jobs.runOnce({jobId: job.id})
  expect((await jobs.get(job.id)).status).toBe("failed")
  expect(runtimeCalls).toBe(0); expect(f.dispatches()).toBe(0)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.trials)).toHaveLength(0); expect(Object.values(state.runs)).toHaveLength(0)
  expect(Object.values(state.evaluations)).toHaveLength(0)
})

test("installed-lane snapshot is bounded while selected paths refresh after executable removal", async () => {
  const f = await scientificFixture(), cli = path.join(f.workspace, "pxdesign"), marker = path.join(f.workspace, "invoked"), commands: string[][] = []
  await executable(cli, marker)
  const transport = new RemoteWorkerTransport({workerRoot, profile: {host: "fixture", root: path.join(f.workspace, "remote"), python: f.proto.python, protoRoot: f.proto.root, protoHome: f.workspace, pxdesignExecutable: cli}, run: shellRunner(commands)})
  const execution = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, proto: f.proto, transport})
  let discoveries = 0
  const discover = spyOn(ProtoRuntimeInspection, "discoverGenerators").mockImplementation(async () => {discoveries++; return [{key: "pxdesign-binder", usesGpu: true, toolsCalled: ["pxdesign-design"]}] as ResearchWorkflow.Generator[]})
  try {
    const first = await execution.capabilities(), second = await execution.capabilities()
    expect(first).toEqual(second); expect(discoveries).toBe(1)
    expect(first.registeredGenerators).toEqual(["pxdesign-binder"]); expect(first.generators[0]!.available).toBe(true)
    await fs.unlink(cli)
    await expect(execution.preflightGenerators([{id: "pxdesign-binder"}])).rejects.toThrow("PXDesign")
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await Bun.file(transport.profile.root).exists()).toBe(false)
  } finally {discover.mockRestore()}
})

/** Selected parser environment shim; real Proto compilation and strict emitted-spec checks
 * run below, while this tiny parser fixture performs no learned-model execution. */
async function installedBoltzParser(workspace: string) {
  const root=path.join(workspace,'installed-boltz'),bin=path.join(root,'bin'),cli=path.join(bin,'boltzgen')
  await fs.mkdir(bin,{recursive:true});await fs.mkdir(path.join(root,'boltzgen/data/parse'),{recursive:true})
  for(const name of ['boltzgen','boltzgen/data','boltzgen/data/parse'])await fs.writeFile(path.join(root,name,'__init__.py'),'')
  await fs.writeFile(path.join(root,'mols.zip'),'Offline cache fixture')
  await fs.writeFile(path.join(root,'boltzgen/data/mol.py'),'def load_canonicals(moldir): return {}\n')
  await fs.writeFile(path.join(root,'boltzgen/data/parse/schema.py'),'class YamlDesignParser:\n    def __init__(self, mol_dir): pass\n    def parse_yaml(self, spec_path, mols, mol_dir):\n        assert spec_path.is_file() and mol_dir.is_file()\n')
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
  await fs.writeFile(path.join(bin,'python'),`#!/bin/sh\nexport PYTHONPATH=${quote(root)}\nexec /usr/bin/python3 "$@"\n`,{mode:0o700})
  await fs.writeFile(cli,`#!${path.join(bin,'python')}\nraise AssertionError("Design CLI must never execute during inspection")\n`,{mode:0o700})
  return {root,cli}
}

const nativeRoot = nativeFixtureRoot
const nativePython = path.resolve(import.meta.dir, "../../../../.autofold/envs/proto/bin/python")
const nativeInstalled = await Promise.all([fs.access(nativePython), fs.access(path.join(nativeRoot, "proto-tools"))]).then(() => true, () => false)
;(nativeInstalled ? test : test.skip)("actual native graph without workflow generation metadata rejects its exact invalid BoltzGen hotspots before admission", async () => {
  const f = await scientificFixture(), target = path.join(f.workspace, "target.pdb"), installed = await installedBoltzParser(f.workspace)
  await fs.writeFile(target, [1, 2, 3].map((residue, index) => `ATOM  ${String(index + 1).padStart(5)}  CA  ALA A${String(residue).padStart(4)}       0.000   0.000   0.000  1.00 20.00           C\n`).join("") + "END\n")
  const proto = {root: nativeRoot, python: nativePython, languageCommit: await git(nativeRoot, ["rev-parse", "HEAD"]), toolsCommit: await git(path.join(nativeRoot, "proto-tools"), ["rev-parse", "HEAD"])}
  let dispatches = 0
  const execution = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, proto, inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, authorization: {localProto: true, maximumGpuSeconds: 3600}, transport: {kind: "local", dispatch: async () => {dispatches++; throw new Error("No native generation permitted")}}})
  const source = `from proto_language.core import Segment, Construct, Program, Constraint
from proto_language.constraint.protein_quality import protein_length_constraint
from proto_language.constraint.protein_quality.protein_length_constraint import ProteinLengthConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_generators import BoltzGenBinderGenerator, BoltzGenBinderConfig
from autofold_worker.proto_trial import ProtoTrial, NativeSearch, NativeOutput
def build_trial(ctx):
    segment = Segment(length=12, sequence_type="protein", label="peptide")
    generator = BoltzGenBinderGenerator(BoltzGenBinderConfig(target_structure=${JSON.stringify(target)}, target_chain="A", hotspots=[1, 4], executable=${JSON.stringify(installed.cli)}, cache_dir=${JSON.stringify(installed.root)}))
    generator.assign(segment)
    optimizer = RejectionSamplingOptimizer(constructs=[Construct([segment], label="candidate")], generators=[generator], constraints=[Constraint(inputs=[segment], function=protein_length_constraint, function_config=ProteinLengthConfig(min_length=5, max_length=40))], config=RejectionSamplingOptimizerConfig(num_samples=1, num_results=1, proposal_batch_size=1))
    program = Program(optimizers=[optimizer], num_results=1, seed=7)
    return ProtoTrial(program=program, hypothesis="Exact graph preflight", search=NativeSearch(maximum_candidates=1, maximum_proposals=1, maximum_sampling_calls=1, maximum_tool_calls=1, maximum_wall_seconds=1, outputs=(NativeOutput("candidate"),)))
`
  await fs.writeFile(path.join(f.workspace, "trial.py"), source)
  await expect(execution.inspectProgram({experiment: f.experiment, campaign: f.campaign, programPath: "trial.py", programHash: await fileHash(path.join(f.workspace, "trial.py"))})).rejects.toThrow(/hotspots.*outside|outside.*hotspot/)
  const state = await f.store.read(f.projectId)
  expect(Object.values(state.trials)).toHaveLength(0); expect(Object.values(state.runs)).toHaveLength(0)
  expect(dispatches).toBe(0)
  const native = source.replace('hotspots=[1, 4]', 'hotspots=[1, 2]').replace('maximum_wall_seconds=1,', 'maximum_wall_seconds=10,')
  await fs.writeFile(path.join(f.workspace, "trial.py"), native)
  const inspected = await execution.inspectProgram({experiment: f.experiment, campaign: f.campaign, programPath: "trial.py", programHash: await fileHash(path.join(f.workspace, "trial.py"))})
  if (inspected.nativeExecution?.protocol !== 'native_search_v1') throw new Error('Expected native search admission')
  expect(inspected.nativeExecution.descriptor.budget.allowedTools).toEqual([])
  expect(inspected.nativeExecution.descriptor.projection[0]?.stages[0]?.generators.find(g=>g.key==='boltzgen-binder')?.toolsCalled).toEqual([])
  expect(inspected.pipeline?.nativeSearch).toBeUndefined()
  expect(inspected.pipeline?.generation).toBeUndefined()
  expect(inspected.generatorSpecPreflight?.valid).toBe(true)
  expect(dispatches).toBe(0)
}, 30_000)

const targetPdb = (residues: number) => Array.from({length: residues}, (_, index) => `ATOM  ${String(index + 1).padStart(5)}  CA  ALA A${String(index + 1).padStart(4)}       0.000   0.000   0.000  1.00 20.00           C\n`).join("") + "END\n"

test("remote exact-spec preflight streams large target bytes without argv overflow or staging", async () => {
  const workspace = await directory(), commands: string[][] = [], installed = await installedPxParser(workspace)
  const transport = new RemoteWorkerTransport({workerRoot, profile: {host: "fixture", root: path.join(workspace, "remote"), python: "/usr/bin/python3", pxdesignExecutable: installed.cli}, run: shellRunner(commands)})
  const request = {generators: [{id: "pxdesign-binder", config: {target_chains: ["A"], hotspots: [2]}, sequenceLength: 12, targetPdb: targetPdb(2500)}]}
  expect(JSON.stringify(request).length).toBeGreaterThan(128 * 1024)
  await transport.validateGeneratorSpecs({source: await fs.readFile(path.join(workerRoot, "autofold_worker/generator_spec.py"), "utf8"), request})
  expect(await Bun.file(installed.marker).json()).toEqual({selectedChains: ["B"], residueCount: 2500, hotspots: {B: [2]}, gpuDisabled: true, offline: true})
  expect(commands).toHaveLength(1)
  expect(commands[0]!.at(-1)!.length).toBeLessThan(64 * 1024)
  expect(commands[0]!.at(-1)).toContain("--request-stdin")
  expect(commands[0]!.at(-1)).not.toContain("ATOM  2500")
  expect(await Bun.file(transport.profile.root).exists()).toBe(false)
})

test("native inspection validates captured graph specs even without generation policy and exposes only compact hashes", async () => {
  const f = await scientificFixture(), programPath = path.join(f.workspace, "trial.py"), installed = await installedPxParser(f.workspace)
  await fs.writeFile(programPath, "def build_trial(ctx): raise AssertionError('Fixture must never load authored code')\n")
  const authored: ResearchWorkflow.AuthoredTrial = withNativeSearch({program: {kind: "native", optimizerCount: 1, constructCount: 1, generatorCount: 1, proposalSources: [null], fixedSequences: [], programResultCount: 1, optimizerSamples: [{numSamples: 1, numResults: 1, proposalBatchSize: 1}]}, diagnostics: [], declaration: {intent: "optimize"}, hypothesis: "Exact graph fixture", generatorPreflight: {generators: [{id: "pxdesign-binder", config: {target_chains: ["A"], hotspots: [2], executable: installed.cli}, sequenceLength: 12, targetPdb: targetPdb(3)}]}}, {key: "pxdesign-binder"})
  const describe = spyOn(ProtoRuntimeInspection, "describeTrial").mockResolvedValue(authored)
  const extract = spyOn(ProtoRuntimeInspection, "extract").mockResolvedValue(ResearchWorkflow.Plan.parse({format: "autofold.proto-workflow.v1", id: "scoring-only", maximumGpuSeconds: 1, stages: []}))
  const configs = spyOn(ProtoRuntimeInspection, "validateConfigs").mockResolvedValue()
  const tools = spyOn(ProtoRuntimeInspection, "discover").mockResolvedValue([])
  const generators = spyOn(ProtoRuntimeInspection, "discoverGenerators").mockResolvedValue([{key:"pxdesign-binder",usesGpu:true,toolsCalled:[]}])
  try {
    const result = await f.execution.inspectProgram({experiment: f.experiment, campaign: f.campaign, programPath: "trial.py", programHash: await fileHash(programPath)})
    expect(await Bun.file(installed.marker).json()).toEqual({selectedChains: ["B"], residueCount: 3, hotspots: {B: [2]}, gpuDisabled: true, offline: true})
    expect(result.generatorSpecPreflight?.valid).toBe(true)
    expect(result.generatorSpecPreflight?.generators).toEqual(["pxdesign-binder"])
    expect(result.generatorSpecPreflight?.specHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.authored.generatorPreflight).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("ATOM")
    expect(Object.values((await f.store.read(f.projectId)).trials)).toHaveLength(0)
    expect(f.dispatches()).toBe(0)
    const commands: string[][] = []
    const transport = new RemoteWorkerTransport({workerRoot, profile: {host: "fixture", root: path.join(f.workspace, "remote"), python: f.proto.python, protoRoot: f.proto.root, protoHome: f.workspace, pxdesignExecutable: installed.cli}, run: shellRunner(commands)})
    const remoteExecution = new ScientificExecution({workspace: f.workspace, projectId: f.projectId, research: f.research, proto: f.proto,
      inspectionBoundary:{containment:async command=>command,containmentName:'trusted_offline_cpu_fixture'}, transport, authorization: {deadlineMs: Date.now() + 60000, localProto: true, remote: true, maximumGpuSeconds: 3600}})
    const remoteResult = await remoteExecution.inspectProgram({experiment: f.experiment, campaign: f.campaign, programPath: "trial.py", programHash: await fileHash(programPath)})
    expect(remoteResult.generatorSpecPreflight?.valid).toBe(true)
    expect(remoteResult.generatorSpecPreflight?.specHash).toEqual(result.generatorSpecPreflight?.specHash)
    expect(commands.some(command => command.at(-1)?.includes("--request-stdin"))).toBe(true)
    expect(await Bun.file(transport.profile.root).exists()).toBe(false)
    authored.generation = {generators: ["pxdesign-binder"], allocations: [{generator: "pxdesign-binder", maximumCandidates: 1, maximumGpuSeconds: 1}], maximumCandidates: 1, maximumGpuSeconds: 1}
    authored.generatorPreflight = {generators: []}
    extract.mockResolvedValue(ResearchWorkflow.Plan.parse({format: "autofold.proto-workflow.v1", id: "generation", maximumGpuSeconds: 1, stages: [], generation: authored.generation}))
    await expect(f.execution.inspectProgram({experiment: f.experiment, campaign: f.campaign, programPath: "trial.py", programHash: await fileHash(programPath)})).rejects.toThrow(/omits.*selected external lane|capability preflight/)
  } finally {describe.mockRestore(); extract.mockRestore(); configs.mockRestore(); tools.mockRestore(); generators.mockRestore()}
})


test("available PXDesign launcher without its selected parser interpreter fails before invoking the design CLI", async () => {
  const workspace = await directory(), commands: string[][] = [], marker = path.join(workspace, "design-invoked"), cli = path.join(workspace, "pxdesign")
  await executable(cli, marker)
  const transport = new RemoteWorkerTransport({workerRoot, profile: {host: "fixture", root: path.join(workspace, "remote"), python: "/usr/bin/python3", pxdesignExecutable: cli}, run: shellRunner(commands)})
  const request = {generators: [{id: "pxdesign-binder", config: {target_chains: ["A"], hotspots: [2]}, sequenceLength: 12, targetPdb: targetPdb(3)}]}
  await expect(transport.validateGeneratorSpecs({source: await fs.readFile(path.join(workerRoot, "autofold_worker/generator_spec.py"), "utf8"), request})).rejects.toThrow("Cannot resolve selected PXDesign parser interpreter")
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(await Bun.file(transport.profile.root).exists()).toBe(false)
})

test("model registry and host capability views share generator discovery while selected-path readiness stays fresh",async()=>{
 const f=await scientificFixture(), inventory=[{key:"random-protein",usesGpu:false,toolsCalled:[]}]
 const generators=spyOn(ProtoRuntimeInspection, "discoverGenerators").mockResolvedValue(inventory),tools=spyOn(ProtoRuntimeInspection, "discover").mockResolvedValue([])
 try {
  await Promise.all([f.execution.capabilities(),f.execution.modelRegistry()])
  await f.execution.capabilities();await f.execution.modelRegistry()
  expect(generators).toHaveBeenCalledTimes(1);expect(tools).toHaveBeenCalledTimes(1)
  expect(f.dispatches()).toBe(0)
 }finally{generators.mockRestore();tools.mockRestore()}
})

test('native runtime readiness binds committed executable bytes and rejects untracked Python shadows',async()=>{
 const root=await directory(),proto=await pinnedRuntime(root)
 const pkg=path.join(proto.root,'proto_language');await fs.mkdir(pkg)
 const file=path.join(pkg,'__init__.py');await fs.writeFile(file,'# committed fixture\n')
 await git(proto.root,['add','proto_language']);await git(proto.root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Pinned package fixture'])
 proto.languageCommit=await git(proto.root,['rev-parse','HEAD'])
 const check=async()=> (await localCapabilities(proto.python,{proto,generators:[]})).runtime.find(item=>item.id==='proto-language')!.available
 expect(await check()).toBe(true)
 await fs.appendFile(file,'# dirty runtime\n');expect(await check()).toBe(false)
 await fs.writeFile(file,'# committed fixture\n');expect(await check()).toBe(true)
 await fs.writeFile(path.join(pkg,'untracked_shadow.py'),'# must not import');expect(await check()).toBe(false)
 await fs.unlink(path.join(pkg,'untracked_shadow.py'));await fs.writeFile(path.join(proto.root,'.gitignore'),'*.py\n');await fs.writeFile(path.join(pkg,'ignored_shadow.py'),'# ignored code still executes');expect(await check()).toBe(false)
})

test('denied inspection containment is a host preflight failure before runtime or scientific admission',async()=>{
 const f=await scientificFixture()
 let runtimeCalls=0,inspectorCalls=0
 const execution=new ScientificExecution({workspace:f.workspace,projectId:f.projectId,research:f.research,proto:f.proto,inspectionBoundary:{containment:async()=>{inspectorCalls++;throw new Error('fixture host primitive denied')},containmentName:'denied_fixture'},authorization:{localProto:true,maximumGpuSeconds:3600},transport:{kind:'local',dispatch:async()=>{throw new Error('No dispatch permitted')}}})
 const jobs=new PiJobController({...f,execution,runtimeFactory:()=>{runtimeCalls++;throw new Error('No reasoning runtime on unavailable containment')}})
 const job=await jobs.enqueueDiscovery(f.experiment.id,{idempotencyKey:'denied-containment',iterations:1})
 await jobs.runOnce({jobId:job.id})
 expect((await jobs.get(job.id)).status).toBe('failed');expect(runtimeCalls).toBe(0);expect(inspectorCalls).toBe(1)
 const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
})

test('a failed containment capability is retryable without admitting scientific effects or weakening source pins',async()=>{
 const f=await scientificFixture();let probes=0
 const execution=new ScientificExecution({workspace:f.workspace,projectId:f.projectId,research:f.research,proto:f.proto,inspectionBoundary:{containment:async command=>{if(++probes===1)throw new Error('transient fixture capability unavailable');return command},containmentName:'trusted_offline_cpu_fixture'},authorization:{localProto:true,maximumGpuSeconds:3600}})
 const inventory=spyOn(ProtoRuntimeInspection,'discoverGenerators').mockResolvedValue([])
 try {
  await expect(execution.preflightExperiment(f.experiment)).rejects.toThrow('transient fixture capability')
  await expect(execution.preflightExperiment(f.experiment)).resolves.toBeDefined();expect(probes).toBe(2)
  await expect(execution.preflightExperiment(f.experiment)).resolves.toBeDefined();expect(probes).toBe(2)
  await fs.mkdir(path.join(f.proto.root,'proto_language'),{recursive:true});await fs.writeFile(path.join(f.proto.root,'proto_language','shadow.py'),'# source pins must still reject this')
  await expect(execution.preflightExperiment(f.experiment)).rejects.toThrow('capability preflight');expect(probes).toBe(2)
  const state=await f.store.read(f.projectId);expect(Object.values(state.trials)).toHaveLength(0);expect(Object.values(state.runs)).toHaveLength(0)
 }finally{inventory.mockRestore()}
})

test('failed installed-lane inventory does not permanently poison a later authorized capability read',async()=>{
 const f=await scientificFixture();let attempts=0
 const inventory=spyOn(ProtoRuntimeInspection,'discoverGenerators').mockImplementation(async()=>{if(++attempts===1)throw new Error('transient fixture inventory unavailable');return []})
 try {
  await expect(f.execution.capabilities()).rejects.toThrow('transient fixture inventory')
  await expect(f.execution.capabilities()).resolves.toMatchObject({registeredGenerators:[]});expect(attempts).toBe(2)
  await expect(f.execution.capabilities()).resolves.toMatchObject({registeredGenerators:[]});expect(attempts).toBe(2)
 }finally{inventory.mockRestore()}
})

test('proposal capture accepts native-only optional claims but rejects supplied contradictions and preserves dispatch strictness',async()=>{
 const f=await scientificFixture(),program=path.join(f.workspace,'trial.py');await fs.writeFile(program,"def build_trial(ctx): raise AssertionError('Mocked construction only')\n")
 const plan={question:'Which fixture improves evidence?',alternatives:[{id:'a',experiment:'Fixture A',expectedInformation:'A result',estimatedGpuHours:0},{id:'b',experiment:'Fixture B',expectedInformation:'B result',estimatedGpuHours:0}],selectedAlternativeId:'a',rationale:'Known comparison',evidenceRefs:[],outcomeBranches:[{observation:'A wins',nextDecision:'Retain A'},{observation:'B wins',nextDecision:'Retain B'}]}
 const authored:ResearchWorkflow.AuthoredTrial=withNativeSearch({program:{kind:'native',optimizerCount:1,constructCount:1,generatorCount:0,proposalSources:[null],fixedSequences:['ACDE'],programResultCount:1,optimizerSamples:[{numSamples:1,numResults:1,proposalBatchSize:1}]},diagnostics:[],declaration:{intent:'optimize',decisionPlan:plan,evidenceRefs:[]},hypothesis:'Native-only claim fixture',generatorPreflight:{generators:[]}})
 const trial=ResearchDomain.Trial.parse({id:'trl_native_only',experimentId:f.experiment.id,hypothesis:authored.hypothesis,intent:'optimize',designAdapter:'proto',programPath:'trial.py',programHash:await fileHash(program),status:'proposed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})
 const describe=spyOn(ProtoRuntimeInspection,'describeTrial').mockResolvedValue(authored),extract=spyOn(ProtoRuntimeInspection,'extract').mockResolvedValue(ResearchWorkflow.Plan.parse({format:'autofold.proto-workflow.v1',id:'scoring-only',maximumGpuSeconds:1,stages:[]})),configs=spyOn(ProtoRuntimeInspection,'validateConfigs').mockResolvedValue(),tools=spyOn(ProtoRuntimeInspection,'discover').mockResolvedValue([]),generators=spyOn(ProtoRuntimeInspection,'discoverGenerators').mockResolvedValue([])
 try {
  const context={experiment:f.experiment,campaign:f.campaign,trial};const captured=await f.execution.validateProposal(context)
  expect(captured.declaration?.decisionPlan).toEqual(plan);expect(context.trial.decisionPlan).toBeUndefined()
  await expect(f.execution.validateProposal({...context,trial:{...trial,decisionPlan:{...plan,rationale:'Contradicting supplied claim'}}})).rejects.toThrow('Native decisionPlan differs')
  await expect(f.execution.validateProposal({...context,trial:{...trial,hypothesis:'Contradicting supplied hypothesis'}})).rejects.toThrow('Native trial declaration differs')
  await f.store.mutate(f.projectId,state=>{state.trials[trial.id]={...trial,executionProtocol:'native_search_v1'}})
  await expect(f.execution.validateTrial({trialId:trial.id})).rejects.toThrow('Native decisionPlan differs')
  expect(Object.values((await f.store.read(f.projectId)).runs)).toHaveLength(0);expect(f.dispatches()).toBe(0)
 }finally{describe.mockRestore();extract.mockRestore();configs.mockRestore();tools.mockRestore();generators.mockRestore()}
})
