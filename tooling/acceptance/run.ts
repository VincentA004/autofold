import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {qualifyRecovery, requiredScenarios, nativeCases, oracleCases, recoveryPolicyCases, selectPhaseCases, type ScenarioReport} from './contract'
import {acceptanceDependencyInventory} from './dependencies'

const repository = path.resolve(import.meta.dir, '../..')
const base = path.resolve(process.env.AUTOFOLD_ACCEPTANCE_EVIDENCE_ROOT ?? path.join(repository, '.autofold/behavioral-suite-20261014'))
const directory = path.join(base, 'qualification-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
await fs.mkdir(path.join(directory, 'reports'), {recursive: true})

async function inventory(snapshot?: string) {
  const files: Record<string, string> = {}
  async function record(relative: string) {
    const bytes = await fs.readFile(path.join(repository, relative))
    files[relative] = createHash('sha256').update(bytes).digest('hex')
    if (snapshot) {
      const target = path.join(snapshot, relative)
      await fs.mkdir(path.dirname(target), {recursive: true})
      await fs.writeFile(target, bytes, {flag: 'wx'})
    }
  }
  async function walk(relative: string) {
    for (const entry of (await fs.readdir(path.join(repository, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '__pycache__', '.git'].includes(entry.name)) continue
      const item = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(item)
      else if (entry.isFile() && /\.(?:ts|tsx|py|json|toml)$/.test(entry.name)) await record(item)
    }
  }
  for (const root of ['backend/engine', 'backend/science-core', 'backend/worker', 'tooling/acceptance']) await walk(root)
  for (const name of ['package.json', 'package-lock.json']) await record(name)
  return {files, hash: createHash('sha256').update(JSON.stringify(files)).digest('hex')}
}
const before = await inventory(path.join(directory, 'sources'))
await fs.writeFile(path.join(directory, 'source-before.json'), JSON.stringify(before, null, 2), {flag: 'wx'})
console.log('Behavioral evidence: ' + directory)
let exitCode = 1
let cases: {name: string; status: string}[] = []
let runnerError: string | undefined
let dependenciesBefore: Awaited<ReturnType<typeof acceptanceDependencyInventory>> | undefined
const stages: {name: string; exitCode: number; cases: {name: string; status: string}[]; selectedCases: {name: string; status: string}[]}[] = []
const dependencyInput = {
  repository,
  nativeRoot: path.resolve(process.env.AUTOFOLD_TEST_PROTO_ROOT ?? path.join(repository, '.autofold/cohesive-engine-refactor-20261012/upstream-proto/v4/source')),
  python: path.resolve(process.env.AUTOFOLD_TEST_PROTO_PYTHON ?? path.join(repository, '.autofold/envs/proto/bin/python')),
}
try {
  dependenciesBefore = await acceptanceDependencyInventory(dependencyInput)
  await fs.writeFile(path.join(directory, 'dependencies-before.json'), JSON.stringify(dependenciesBefore, null, 2), {flag: 'wx'})
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'AUTOFOLD_TEST_PROTO_ROOT', 'AUTOFOLD_TEST_PROTO_PYTHON'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  await fs.mkdir(path.join(directory, 'home'), {recursive: true})
  const log = await fs.open(path.join(directory, 'tests.log'), 'wx')
  async function stage(name: string, files: string[], pattern?: string) {
    const junit = path.join(directory, name + '.xml')
    console.log('Behavioral phase: ' + name)
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test', '--timeout', '240000', '--reporter=junit', '--reporter-outfile=' + junit,
      ...(pattern ? ['--test-name-pattern', pattern] : []), ...files], {
      cwd: repository, env: {...env, HOME: path.join(directory, 'home'), AUTOFOLD_ACCEPTANCE_EVIDENCE_ROOT: base, AUTOFOLD_ACCEPTANCE_REPORT_DIR: path.join(directory, 'reports')}, stdout: 'pipe', stderr: 'pipe',
    })
    const pump = async (stream: ReadableStream<Uint8Array>) => {for await (const chunk of stream) {await log.write(chunk); process.stdout.write(chunk)}}
    const [code] = await Promise.all([child.exited, pump(child.stdout), pump(child.stderr)])
    // Parse generated XML rather than infer success from console test counts.
    const parser = Bun.spawn(['python3', '-c', 'import json,sys,xml.etree.ElementTree as E; r=E.parse(sys.argv[1]); print(json.dumps([dict(name=t.attrib.get("name",""),status=("failed" if t.find("failure") is not None or t.find("error") is not None else "skipped" if t.find("skipped") is not None else "passed")) for t in r.iter("testcase")]))', junit], {stdout: 'pipe', stderr: 'pipe'})
    const [parsed, stdout, stderr] = await Promise.all([parser.exited, new Response(parser.stdout).text(), new Response(parser.stderr).text()])
    if (parsed) throw Error('JUnit parse unavailable: ' + stderr)
    const rawCases = JSON.parse(stdout) as typeof cases
    const selectedCases = selectPhaseCases(rawCases, pattern)
    const result = {name, exitCode: code, cases: rawCases, selectedCases}
    stages.push(result); cases.push(...selectedCases)
    if (code !== 0) exitCode = code
    return code === 0 && selectedCases.length > 0 && selectedCases.every(test => test.status === 'passed')
  }
  try {
    exitCode = 0
    const prerequisites = await stage('prerequisites', [
      './tooling/acceptance/provider.test.ts', './tooling/acceptance/oracle.test.ts', './tooling/acceptance/artifact-evidence.test.ts',
      './tooling/acceptance/held-oracle.test.ts', './tooling/acceptance/artifact-cancellation.test.ts',
      './tooling/acceptance/qualification.test.ts', './backend/engine/src/execution/inspection-native-behavior.test.ts',
      './backend/engine/src/jobs/hold-stability.test.ts',
    ])
    if (!prerequisites || ![...nativeCases, ...oracleCases, ...recoveryPolicyCases].every(name => cases.some(test => test.name === name && test.status === 'passed'))) throw Error('Native/provider/oracle/recovery-policy prerequisites did not qualify; workflow phases blocked')
    const scenarios = ['./tooling/acceptance/scenarios/interruption-recovery.test.ts', './tooling/acceptance/scenarios/held-boundaries.test.ts']
    if (!await stage('baseline', scenarios, '^recovery\\.baseline-completes:')) throw Error('Normal native workflow did not qualify; fault phase blocked')
    const baseline = JSON.parse(await fs.readFile(path.join(directory, 'reports/recovery.baseline-completes.json'), 'utf8')) as ScenarioReport
    const verdict = baseline.observations.verdict as {passed?: boolean; counts?: {workerStarts?: number; successfulRuns?: number}}
    if (baseline.status !== 'passed' || !verdict?.passed || verdict.counts?.workerStarts !== 2 || verdict.counts.successfulRuns !== 2) throw Error('Baseline independent end-state proof is missing; fault phase blocked')
    await stage('faults', scenarios, '^(?!recovery\\.baseline-completes:)')
  } finally {await log.close()}
} catch (error) {runnerError = String(error)}
const reports: ScenarioReport[] = []
for (const id of requiredScenarios) {
  const file = path.join(directory, 'reports', id + '.json')
  try {reports.push(JSON.parse(await fs.readFile(file, 'utf8')))} catch (error) {
    const report: ScenarioReport = {id, status: 'blocked', proofLevel: 'native_cpu_public_workflow', evidence: {directory}, observations: {reason: runnerError ?? 'Required scenario did not produce its report', reportReadError: String(error)}}
    reports.push(report)
    // Preserve a malformed original report instead of replacing its evidence.
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT'
    await fs.writeFile(absent ? file : file + '.invalid.json', JSON.stringify(report, null, 2), {flag: 'wx'})
  }
}
const after = await inventory()
await fs.writeFile(path.join(directory, 'source-after.json'), JSON.stringify(after, null, 2), {flag: 'wx'})
const qualification = qualifyRecovery({exitCode, cases, reports, sourceBefore: before.hash, sourceAfter: after.hash})
if (dependenciesBefore) {
  try {
    const dependenciesAfter = await acceptanceDependencyInventory(dependencyInput)
    await fs.writeFile(path.join(directory, 'dependencies-after.json'), JSON.stringify(dependenciesAfter, null, 2), {flag: 'wx'})
    if (dependenciesAfter.hash !== dependenciesBefore.hash) {qualification.passed = false; qualification.failures.push('Installed Pi or native runtime source changed during qualification')}
  } catch (error) {runnerError = [runnerError, 'Dependency verification: ' + String(error)].filter(Boolean).join('\n')}
}
if (runnerError) {qualification.passed = false; qualification.failures.push(runnerError)}
await fs.writeFile(path.join(directory, 'qualification.json'), JSON.stringify({...qualification, at: new Date().toISOString(), exitCode, stages, cases, reports, sourceBefore: before.hash, sourceAfter: after.hash}, null, 2), {flag: 'wx'})
console.log(JSON.stringify(qualification, null, 2))
process.exitCode = qualification.passed ? 0 : 1
