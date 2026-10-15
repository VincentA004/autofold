import {remoteInspectionBootstrap,remoteInspectionPayload,parseRemoteInspectionResult} from './remote-inspection'
import type {InspectionRequest} from './inspection-boundary'
import { externalGeneratorIds, type GeneratorCapabilityRequest, type CapabilityRequest, type HostCapabilities, type HostCapability } from './capabilities'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import z from 'zod'
import { ExecutionProtocol } from '@autofold/science-core/execution-protocol'
import { workerTreeIdentity } from './index'
import {processPlanHash, publishFrozenPlan} from "./process-plan"
import { fileHash } from './provenance'
import { assertSafeTree, checkedPath } from './paths'
import { ReceiptUnresolvedError, type Dispatch, type ExecutionTransport, type TransportCompletion } from './transport'

const safePath = z.string().refine(value => /^\/[A-Za-z0-9._/-]+$/.test(value) && value !== '/' && !value.includes('//') && path.posix.normalize(value) === value, 'Remote paths must be normalized absolute POSIX paths')
const host = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
export const RemoteProfile = z.object({
  host, address: host.optional(), root: safePath, python: safePath,
  inspectionBubblewrap:safePath.optional(), inspectionBubblewrapSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  protoRoot: safePath.optional(), protoHome: safePath.optional(),
  boltzgenExecutable: safePath.optional(), boltzgenCache: safePath.optional(), pxdesignExecutable: safePath.optional(),
}).strict()
export type RemoteProfile = z.infer<typeof RemoteProfile>
export type RemoteCommandRunner = (argv: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number; stdin?: string }) => Promise<string>
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export class RemoteCommandError extends Error {
  constructor(readonly code: 'remote_connection_failed' | 'remote_command_failed' | 'remote_command_timed_out' | 'remote_command_aborted', detail: string, readonly exitCode?: number) {
    super(`${code}: ${detail}`); this.name = 'RemoteCommandError'
  }
}

export const runRemoteCommand: RemoteCommandRunner = async (argv, options = {}) => {
  options.signal?.throwIfAborted()
  const environment = { ...process.env }
  for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key]
  const child = Bun.spawn([...argv], { stdin: options.stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', env: environment })
  if (options.stdin !== undefined && child.stdin) {child.stdin.write(options.stdin); child.stdin.end()}
  let killer: ReturnType<typeof setTimeout> | undefined
  const abort = () => { child.kill('SIGTERM'); killer ??= setTimeout(() => child.kill('SIGKILL'), 1000); killer.unref() }
  options.signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {timedOut = true; abort()}, options.timeoutMs ?? 120_000)
  if (options.signal?.aborted) abort()
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (options.signal?.aborted) throw new RemoteCommandError('remote_command_aborted', 'Host detached from remote control command', code)
    if (timedOut) throw new RemoteCommandError('remote_command_timed_out', 'Remote control command exceeded its bounded wait', code)
    if (code !== 0) throw new RemoteCommandError(code === 255 ? 'remote_connection_failed' : 'remote_command_failed', `Remote control command failed (${code}): ${stderr.slice(-8000)}`, code)
    options.signal?.throwIfAborted()
    return stdout
  } finally {
    clearTimeout(timer); if (killer) clearTimeout(killer)
    options.signal?.removeEventListener('abort', abort)
  }
}

interface Identity { runId: string; bundleHash: string; workerHash: string; directory: string; planHash?:string }
const Receipt = z.object({
  runId: z.string(), bundleHash: z.string(), workerHash: z.string(),
  state: z.enum(['absent', 'launching', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  manifest: z.boolean().optional(), exitCode: z.number().int().nullable().optional(), completedAt:z.number().finite().optional(),
}).passthrough().superRefine((receipt,context)=>{
  // Historical v1 receipts may omit these fields; present terminal evidence
  // must still agree with the supervisor's own completion protocol.
  if(receipt.state==='succeeded'&&receipt.exitCode!==undefined&&receipt.exitCode!==0)context.addIssue({code:'custom',message:'Successful remote receipt has a nonzero exit code'})
  if(['succeeded','failed','cancelled','timed_out'].includes(receipt.state)&&receipt.completedAt!==undefined&&receipt.completedAt<=0)context.addIssue({code:'custom',message:'Terminal remote receipt has an invalid completion time'})
})
const pause = (milliseconds: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve() }
  const timer = setTimeout(stop, milliseconds)
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
})

/** SSH transports only the frozen scientific worker. Model keys and arbitrary shell tools are absent. */
export class RemoteWorkerTransport implements ExecutionTransport {
  readonly kind = 'remote' as const
  readonly profile: RemoteProfile
  private readonly run: RemoteCommandRunner
  private readonly prepared = new Set<string>()
  private readonly pollMs: number
  private readonly statusAttempts: number
  private readonly statusRetryMs: number
  constructor(private readonly options: { profile: RemoteProfile; workerRoot: string; run?: RemoteCommandRunner; pollMs?: number; statusAttempts?:number; statusRetryMs?:number }) {
    this.profile = RemoteProfile.parse(options.profile)
    if (!path.isAbsolute(options.workerRoot)) throw new Error('Remote transport requires an absolute trusted worker root')
    this.run = options.run ?? runRemoteCommand
    this.statusAttempts = options.statusAttempts ?? 3
    this.statusRetryMs = options.statusRetryMs ?? 250
    if (!Number.isInteger(this.statusAttempts) || this.statusAttempts < 1 || this.statusAttempts > 3 || !Number.isInteger(this.statusRetryMs) || this.statusRetryMs < 0 || this.statusRetryMs > 5000) throw new Error('Invalid read-only remote recovery policy')
    this.pollMs = options.pollMs ?? 5000
    if (!Number.isInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 60_000) throw new Error('Invalid remote polling interval')
  }
  snapshotProfile() {return structuredClone(this.profile)}
  /** Rebind this adapter to the original profile, including old staged plans.
   * The current profile is never a replacement execution recipient. */
  private async original(input: Dispatch): Promise<RemoteWorkerTransport | undefined> {
    let captured = input.transportProfile
    if (!captured) {
      const plan = await Bun.file(path.join(path.dirname(input.bundlePath), 'remote-plan.identity.json')).json().catch(error => {if (error.code === 'ENOENT') return undefined; throw error})
      if (plan) {
        if (plan.runId !== input.runId || plan.bundleHash !== await fileHash(input.bundlePath) || input.workerHash && plan.workerHash !== input.workerHash || !Array.isArray(plan.argv) || !plan.argv[1]?.endsWith('/worker/run_worker.py')) throw new ReceiptUnresolvedError(input.runId, 'Original remote profile evidence differs')
        const environment = plan.environment ?? {}
        captured = {host: plan.host, address: plan.address, root: path.posix.dirname(path.posix.dirname(path.posix.dirname(path.posix.dirname(plan.argv[1])))), python: plan.argv[0],
          protoRoot: environment.AUTOFOLD_PROTO_ROOT, protoHome: environment.PROTO_HOME,
          boltzgenExecutable: environment.AUTOFOLD_BOLTZGEN_EXECUTABLE, boltzgenCache: environment.AUTOFOLD_BOLTZGEN_CACHE, pxdesignExecutable: environment.AUTOFOLD_PXDESIGN_EXECUTABLE}
      } else if (input.requireOriginalProfile) throw new ReceiptUnresolvedError(input.runId, 'Original remote profile is unavailable; current defaults cannot authorize a replacement recipient')
    }
    if (!captured) return undefined
    const profile = RemoteProfile.parse(captured)
    return processPlanHash(profile) === processPlanHash(this.profile) ? undefined : new RemoteWorkerTransport({...this.options, profile})
  }
  private address() { return this.profile.address && this.profile.address !== this.profile.host ? ['-o', `HostName=${this.profile.address}`] : [] }
  private ssh(command: string, options?: { signal?: AbortSignal; timeoutMs?: number; stdin?: string }) {
    return this.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', ...this.address(), '--', this.profile.host, command], options)
  }
  /** Retry only a read-only status command. Launch, cancel, uploads and model calls never retry here. */
  private async status(identity: Identity, signal?: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted()
      try {return await this.ssh(this.supervisor('status', identity), {signal, timeoutMs:20_000})}
      catch (error) {
        if (signal?.aborted || !(error instanceof RemoteCommandError) || !['remote_connection_failed','remote_command_timed_out'].includes(error.code) || attempt >= this.statusAttempts) throw error
        await pause(this.statusRetryMs, signal)
      }
    }
  }
  /** Frozen-profile path checks only. No staging, cache hydration, CLI invocation or model imports. */
  async capabilities(input: CapabilityRequest): Promise<HostCapabilities> {
    const checks: {item: HostCapability; command: string}[] = []
    const add = (id: string, requirement: string, value: string | undefined, predicate: string) => {
      const item = {id, available: false, requirement, path: value}
      checks.push({item, command: value ? predicate : 'false'})
    }
    add('python', 'Configure an installed executable remote Python interpreter', this.profile.python, `test -f ${quote(this.profile.python)} && test -x ${quote(this.profile.python)}`)
    if (input.proto) {
      add('proto-language', 'Configure the remote Proto language checkout at its frozen git commit', this.profile.protoRoot,
        this.profile.protoRoot ? `test -d ${quote(this.profile.protoRoot)} && test "$(git -C ${quote(this.profile.protoRoot)} rev-parse HEAD 2>/dev/null)" = ${quote(input.proto.languageCommit)} && git -C ${quote(this.profile.protoRoot)} diff --quiet HEAD -- proto_language && test -z "$(git -C ${quote(this.profile.protoRoot)} ls-files --others -- 'proto_language/**/*.py' 'proto_language/*.py')"` : 'false')
      const tools = this.profile.protoRoot && path.posix.join(this.profile.protoRoot, 'proto-tools')
      add('proto-tools', 'Configure the remote Proto tools checkout at its frozen git commit', tools,
        tools ? `test -d ${quote(tools)} && test "$(git -C ${quote(tools)} rev-parse HEAD 2>/dev/null)" = ${quote(input.proto.toolsCommit)} && git -C ${quote(tools)} diff --quiet HEAD -- proto_tools && test -z "$(git -C ${quote(tools)} ls-files --others -- 'proto_tools/**/*.py' 'proto_tools/*.py')"` : 'false')
      add('proto-home', 'Configure the remote Proto cache directory', this.profile.protoHome, this.profile.protoHome ? `test -d ${quote(this.profile.protoHome)}` : 'false')
    }
    const runtimeCount = checks.length
    for (const item of input.generators ?? externalGeneratorIds.map((id): GeneratorCapabilityRequest => ({id}))) {
      // Generator runtime defaults are supplied by the frozen execution profile.
      // Explicit authored overrides must be checked at the destination as well.
      const config = item.config ?? {}
      if (item.id === 'boltzgen-binder') {
        const command = typeof config.executable === 'string' ? config.executable : this.profile.boltzgenExecutable
        const cache = typeof config.cache_dir === 'string' ? config.cache_dir : this.profile.boltzgenCache
        add(item.id, 'Configure an installed remote BoltzGen executable and model cache directory', command,
          command && cache ? `test -f ${quote(command)} && test -x ${quote(command)} && test -d ${quote(cache)}` : 'false')
      } else if (item.id === 'pxdesign-binder') {
        const command = typeof config.executable === 'string' ? config.executable : this.profile.pxdesignExecutable
        add(item.id, 'Configure an installed remote PXDesign executable', command, command ? `test -f ${quote(command)} && test -x ${quote(command)}` : 'false')
      }
    }
    const output = await this.ssh(checks.map(({command}, index) => `if ${command}; then printf '${index}:1\\n'; else printf '${index}:0\\n'; fi`).join('; '), {signal: input.signal, timeoutMs: 20_000})
    const values = new Map(output.trim().split('\n').map(line => line.split(':') as [string, string]))
    for (const [index, check] of checks.entries()) {
      if (!['0', '1'].includes(values.get(String(index)) ?? '')) throw new Error('Remote capability inventory is incomplete')
      check.item.available = values.get(String(index)) === '1'
    }
    return {format: 'autofold.host-capabilities.v1', host: this.profile.host, checkedAt: new Date().toISOString(), runtime: checks.slice(0, runtimeCount).map(check => check.item), generators: checks.slice(runtimeCount).map(check => check.item)}
  }
  async inspect(input:InspectionRequest) {
    const payload=await remoteInspectionPayload(input,this.profile)
    input.signal.throwIfAborted()
    return parseRemoteInspectionResult(await this.ssh(`${quote(this.profile.python)} -I -c ${quote(remoteInspectionBootstrap)}`,{signal:input.signal,timeoutMs:input.timeoutMs+2000,stdin:JSON.stringify(payload)}))
  }
  async validateGeneratorSpecs(input: {source: string; request: unknown; signal?: AbortSignal}) {
    const environment = [
      ['AUTOFOLD_BOLTZGEN_EXECUTABLE', this.profile.boltzgenExecutable], ['AUTOFOLD_BOLTZGEN_CACHE', this.profile.boltzgenCache],
      ['AUTOFOLD_PXDESIGN_EXECUTABLE', this.profile.pxdesignExecutable], ['PYTHONDONTWRITEBYTECODE', '1'],
    ].filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => `${key}=${quote(value)}`).join(' ')
    await this.ssh(`${environment} ${quote(this.profile.python)} -c ${quote(input.source)} --request-stdin`, {signal: input.signal, timeoutMs: 20_000, stdin: JSON.stringify(input.request)})
  }
  private async identity(input: Dispatch): Promise<Identity> {
    if (!/^run_[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error('Invalid remote run identity')
    const bundle = ExecutionProtocol.TrialBundle.parse(await Bun.file(input.bundlePath).json())
    if (bundle.runId !== input.runId) throw new Error('Remote bundle belongs to another run')
    const identity:Identity = { runId: input.runId, bundleHash: await fileHash(input.bundlePath), workerHash: input.workerHash ?? (await workerTreeIdentity(this.options.workerRoot)).sourceHash,
      directory: path.posix.join(this.profile.root, 'runs', input.runId) }
    const frozen = await Bun.file(path.join(path.dirname(input.bundlePath),'remote-plan.identity.json')).json().catch(error => {if(error.code==='ENOENT')return undefined;throw error})
    if(frozen) {
      if(frozen.runId!==identity.runId||frozen.bundleHash!==identity.bundleHash||frozen.workerHash!==identity.workerHash||processPlanHash(frozen)!==processPlanHash(this.plan(input,identity)))throw new ReceiptUnresolvedError(input.runId,'Original remote runtime/environment/timeout plan differs')
      identity.planHash=processPlanHash(frozen)
    }
    return identity
  }
  private async launchFence(input: Dispatch, identity: Identity, create = false) {
    const file = await checkedPath(input.workspace, path.relative(input.workspace, path.join(path.dirname(input.bundlePath), 'remote-launch-attempt.json')))
    const expected = {format: 'autofold.remote-launch-attempt.v1', runId: identity.runId, bundleHash: identity.bundleHash, workerHash: identity.workerHash}
    if (!create) {
      const prior = await Bun.file(file).json().catch(error => {if (error.code === 'ENOENT') return undefined; throw error})
      if (prior && JSON.stringify(prior) !== JSON.stringify(expected)) throw new Error('Local remote launch fence has a different immutable identity')
      return Boolean(prior)
    }
    let handle
    try {handle = await fs.open(file, 'wx', 0o400)}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReceiptUnresolvedError(input.runId, 'A prior remote launch attempt requires an authoritative receipt; it cannot be repeated'); throw error}
    try {await handle.writeFile(JSON.stringify(expected)); await handle.sync()} finally {await handle.close()}
    const directory = await fs.open(path.dirname(file), 'r'); try {await directory.sync()} finally {await directory.close()}
    return true
  }
  private supervisor(action: 'launch' | 'status' | 'cancel' | 'adopt', identity: Identity, requireCancelAck = false) {
    return [this.profile.python, path.posix.join(identity.directory, 'worker/autofold_worker/remote_supervisor.py'), action,
      '--directory', identity.directory, '--bundle-hash', identity.bundleHash, '--worker-hash', identity.workerHash, ...(identity.planHash?['--plan-hash',identity.planHash]:[]), ...(requireCancelAck ? ['--require-cancel-ack'] : [])].map(quote).join(' ')
  }
  private parseReceipt(raw: string, identity: Identity) {
    const receipt = Receipt.parse(JSON.parse(raw))
    if (receipt.runId !== identity.runId || receipt.bundleHash !== identity.bundleHash || receipt.workerHash !== identity.workerHash) throw new Error('Remote receipt has a different frozen identity')
    if(identity.planHash&&receipt.planHash!==identity.planHash)throw new Error('Remote receipt plan hash differs')
    return receipt
  }
  async readiness(input: Dispatch) {
    const bundle = ExecutionProtocol.TrialBundle.parse(await Bun.file(input.bundlePath).json())
    const pipeline = bundle.format === 'autofold.trial-bundle.v4' ? bundle.pipeline : undefined
    const selected = new Set(pipeline?.generation?.generators.map(generator => generator.id) ?? [])
    const checks = [`test -x ${quote(this.profile.python)}`]
    if (bundle.designAdapter === 'proto') {
      if (!this.profile.protoRoot || !this.profile.protoHome) throw new Error('Remote Proto requires explicit language and cache roots')
      checks.push(`test -d ${quote(this.profile.protoRoot)}`, `test -d ${quote(this.profile.protoHome)}`)
      checks.push(`test "$(git -C ${quote(this.profile.protoRoot)} rev-parse HEAD)" = ${quote(bundle.proto!.languageCommit)}`,
        `test "$(git -C ${quote(path.posix.join(this.profile.protoRoot, 'proto-tools'))} rev-parse HEAD)" = ${quote(bundle.proto!.toolsCommit)}`)
    }
    if (selected.has('boltzgen-binder')) {
      if (!this.profile.boltzgenExecutable || !this.profile.boltzgenCache) throw new Error('Remote BoltzGen executable and cache are not configured')
      checks.push(`test -x ${quote(this.profile.boltzgenExecutable)}`, `test -d ${quote(this.profile.boltzgenCache)}`)
    }
    if (selected.has('pxdesign-binder')) {
      if (!this.profile.pxdesignExecutable) throw new Error('Remote PXDesign executable is not configured')
      checks.push(`test -x ${quote(this.profile.pxdesignExecutable)}`)
    }
    for (const stage of pipeline?.stages ?? []) for (const model of stage.models) {
      if ((model.toolKey ?? model.id) === 'protenix-prediction' && model.config?.model_name === 'protenix-v2') {
        if (!this.profile.protoHome) throw new Error('Remote model cache is not configured')
        checks.push(`test -s ${quote(path.posix.join(this.profile.protoHome, 'proto_model_cache/protenix/checkpoint/protenix-v2.pt'))}`)
      }
    }
    await this.ssh(checks.join(' && '), { signal: input.signal, timeoutMs: 20_000 })
    return { ready: true, host: this.profile.host, generators: [...selected] }
  }
  private plan(input:Dispatch,identity:Identity) {
    const evaluatorFlag = input.command.indexOf('--evaluator-source')
    const evidenceFlag = input.command.indexOf('--evidence-adapter-source')
    if (evaluatorFlag < 0 || !input.command[evaluatorFlag + 1]) throw new Error('Remote frozen evaluator is missing')
    const argv = [this.profile.python, `${identity.directory}/worker/run_worker.py`, '--bundle', `${identity.directory}/bundle.json`, '--output', `${identity.directory}/output`, '--evaluator-source', `${identity.directory}/worker/autofold_worker/${path.basename(input.command[evaluatorFlag + 1]!)}`,
      ...(evidenceFlag < 0 ? [] : ['--evidence-adapter-source', `${identity.directory}/worker/autofold_worker/${path.basename(input.command[evidenceFlag + 1]!)}`])]
    const environment = Object.fromEntries([
      ['AUTOFOLD_PROTO_ROOT', this.profile.protoRoot], ['PROTO_HOME', this.profile.protoHome],
      ['AUTOFOLD_BOLTZGEN_EXECUTABLE', this.profile.boltzgenExecutable], ['AUTOFOLD_BOLTZGEN_CACHE', this.profile.boltzgenCache],
      ['AUTOFOLD_PXDESIGN_EXECUTABLE', this.profile.pxdesignExecutable],
    ].filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    return { format: 'autofold.remote-plan.v1', runId: input.runId, bundleHash: identity.bundleHash, workerHash: identity.workerHash,
      timeoutMs: input.timeoutMs, authorizationDeadlineMs:input.authorizationDeadlineMs, argv, environment, ...(input.runtimeEnvironment ? {freezeRuntimeEnvironment:true} : {}), host: this.profile.host, address: this.profile.address ?? this.profile.host }
  }
  private async stage(input: Dispatch, identity: Identity) {
    const remote = identity.directory
    const existence = await this.ssh(`if test -d ${quote(remote)}; then printf present; else printf absent; fi`, { signal: input.signal, timeoutMs: 20_000 })
    if (existence.trim() === 'present') { await this.ssh(this.supervisor('status', identity), { signal: input.signal, timeoutMs: 20_000 }); return }
    const local = await fs.mkdtemp(path.join(path.dirname(input.bundlePath), '.remote-upload-'))
    const staging = `${remote}.staging.${crypto.randomUUID()}`
    try {
      const frozenWorker=input.command[1]?.endsWith("/run_worker.py")?path.dirname(input.command[1]):this.options.workerRoot
      await assertSafeTree(path.dirname(frozenWorker), frozenWorker)
      const bundle = ExecutionProtocol.TrialBundle.parse(await Bun.file(input.bundlePath).json())
      for (const name of ['bundle.json', bundle.programPath, bundle.targetArtifactPath, bundle.targetStructurePath].filter((name): name is string => !!name)) {
        if (path.basename(name) !== name) throw new Error('Remote frozen inputs must have portable leaf names')
        await fs.copyFile(await checkedPath(input.workspace, path.relative(input.workspace, path.join(path.dirname(input.bundlePath), name))), path.join(local, name))
      }
      await fs.cp(frozenWorker, path.join(local, 'worker'), { recursive: true, filter: source => !source.includes('__pycache__') && !source.includes('/tests') })
      if ((await workerTreeIdentity(path.join(local, 'worker'))).sourceHash !== identity.workerHash) throw new Error('Trusted worker changed during remote staging')
      if (await fileHash(path.join(local, 'bundle.json')) !== identity.bundleHash) throw new Error('Frozen bundle changed during remote staging')
      const plan=this.plan(input,identity)
      await publishFrozenPlan(path.join(path.dirname(input.bundlePath),'remote-plan.identity.json'),plan)
      identity.planHash=processPlanHash(plan)
      await fs.writeFile(path.join(local,'remote-plan.json'),JSON.stringify(plan),{mode:0o400})
      await this.ssh(`mkdir -p ${quote(path.posix.dirname(remote))}`, { signal: input.signal, timeoutMs: 20_000 })
      await this.run(['scp', '-q', '-o', 'BatchMode=yes', ...this.address(), '-r', local, `${this.profile.host}:${staging}`], { signal: input.signal, timeoutMs: 120_000 })
      const publish = `${quote(this.profile.python)} -c ${quote('import os,sys; a,b=sys.argv[1:];\ntry: os.rename(a,b)\nexcept OSError as e:\n if e.errno not in (17,39): raise\n')} ${quote(staging)} ${quote(remote)}`
      await this.ssh(publish, { signal: input.signal, timeoutMs: 20_000 })
      await this.ssh(this.supervisor('status', identity), { signal: input.signal, timeoutMs: 20_000 })
    } finally { await fs.rm(local, { recursive: true, force: true }) }
  }
  private async retrieve(input: Dispatch, identity: Identity) {
    const temporary = await fs.mkdtemp(path.join(path.dirname(input.outputPath), '.remote-download-'))
    const incoming = path.join(temporary, 'output')
    try {
      await this.run(['scp', '-q', '-o', 'BatchMode=yes', ...this.address(), '-r', `${this.profile.host}:${identity.directory}/output`, incoming], { timeoutMs: 120_000 })
      await assertSafeTree(temporary, incoming)
      let files = 0, bytes = 0
      const inspect = async (root: string): Promise<void> => {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          const file = path.join(root, entry.name), stat = await fs.lstat(file)
          if (stat.isDirectory()) await inspect(file)
          else if (!stat.isFile() || ++files > 20_000 || (bytes += stat.size) > 100 * 1024 ** 3) throw new Error('Remote artifact tree exceeds its retrieval boundary')
        }
      }
      await inspect(incoming)
      if (await Bun.file(path.join(input.outputPath, 'manifest.json')).exists()) return
      if (await fs.stat(input.outputPath).catch(() => undefined)) await fs.rename(input.outputPath, `${input.outputPath}.partial.${crypto.randomUUID()}`)
      await fs.rename(incoming, input.outputPath)
      await this.run(['scp', '-q', '-o', 'BatchMode=yes', ...this.address(), `${this.profile.host}:${identity.directory}/worker.log`, path.join(input.outputPath, 'worker.log')], { timeoutMs: 20_000 }).catch(() => {})
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  }
  private async settle(input: Dispatch, identity: Identity, raw: string): Promise<TransportCompletion> {
    const receipt = this.parseReceipt(raw, identity)
    if (receipt.state === 'cancelled') return { status: 'cancelled' }
    if (receipt.state === 'succeeded') { await this.retrieve(input, identity); return { status: 'succeeded' } }
    if (['failed', 'timed_out'].includes(receipt.state)) {
      await this.retrieve(input, identity).catch(() => {})
      return { status: 'failed', error: receipt.state === 'timed_out' ? 'Frozen remote wall-time budget exceeded' : `Remote scientific worker exited ${receipt.exitCode ?? 'without a final manifest'}` }
    }
    return { status: 'pending' }
  }
  private async cancelAttempt(input: Dispatch, identity: Identity): Promise<TransportCompletion> {
    const deadline = performance.now() + 30_000
    let raw = await this.ssh(this.supervisor('cancel', identity, true), {timeoutMs: 20_000})
    for (;;) {
      const result = await this.settle(input, identity, raw)
      if (result.status !== 'pending') return result
      if (performance.now() >= deadline) throw new ReceiptUnresolvedError(input.runId, 'Remote cancellation request was delivered, but execution acknowledgement is unresolved')
      await pause(Math.min(this.pollMs, 250))
      raw = await this.ssh(this.supervisor('status', identity), {timeoutMs: 20_000})
    }
  }
  async reconcile(input: Dispatch): Promise<TransportCompletion> {
    const original = await this.original(input)
    if (original) return original.reconcile({...input, transportProfile: original.snapshotProfile()})
    const identity = await this.identity(input)
    try {
      const receipt = this.parseReceipt(await this.status(identity, input.signal?.aborted ? undefined : input.signal), identity)
      if (receipt.state === 'absent') {
        const attempted = await this.launchFence(input, identity) || input.allowFirstRemoteLaunch !== true
        if (input.signal?.aborted) {
          const reason = input.signal.reason as {reason?: string} | undefined
          if (reason?.reason === 'shutdown' || reason?.reason === 'lease_lost') throw new ReceiptUnresolvedError(input.runId, 'Controller detached without changing remote execution')
          return attempted ? this.cancelAttempt(input, identity) : this.settle(input, identity, await this.ssh(this.supervisor('cancel', identity), {timeoutMs: 20_000}))
        }
        if (attempted) throw new ReceiptUnresolvedError(input.runId, 'Remote receipt is absent after a durable local launch attempt; never repeat uncertain compute')
        if (!input.authorizeStart) throw new Error('Remote continuation lacks host start authorization')
        await input.authorizeStart(); input.signal?.throwIfAborted()
        await this.launchFence(input, identity, true)
        const launched = await this.ssh(this.supervisor('launch', identity), {signal: input.signal, timeoutMs: 20_000})
        await input.onStarted?.()
        return this.settle(input, identity, launched)
      }
      if(identity.planHash&&['launching','running'].includes(receipt.state))await this.ssh(this.supervisor('adopt',identity),{signal:input.signal,timeoutMs:20_000})
      return this.settle(input, identity, JSON.stringify(receipt))
    }
    catch (error) { throw new ReceiptUnresolvedError(input.runId, error instanceof Error ? error.message : String(error)) }
  }
  async preflight(input: Dispatch): Promise<void> {
    const original = await this.original(input)
    if (original) return original.preflight({...input, transportProfile: original.snapshotProfile()})
    input.signal?.throwIfAborted()
    const identity = await this.identity(input)
    await this.readiness(input)
    await this.stage(input, identity)
    input.signal?.throwIfAborted()
    this.prepared.add(identity.runId + ':' + identity.bundleHash + ':' + identity.workerHash)
  }
  async dispatch(input: Dispatch): Promise<TransportCompletion> {
    const original = await this.original(input)
    if (original) return original.dispatch({...input, transportProfile: original.snapshotProfile()})
    const identity = await this.identity(input)
    if (input.signal?.aborted) return { status: 'cancelled' }
    try {
      if (!this.prepared.has(identity.runId + ':' + identity.bundleHash + ':' + identity.workerHash)) await this.preflight(input)
      if (input.signal?.aborted) return {status: 'cancelled'}
      if (!input.authorizeStart) throw new Error('Remote first launch lacks host start authorization')
      await input.authorizeStart(); input.signal?.throwIfAborted()
      await this.launchFence(input, identity, true)
      const first = this.parseReceipt(await this.ssh(this.supervisor('launch', identity), { signal: input.signal, timeoutMs: 20_000 }), identity)
      if (first.state !== 'absent') await input.onStarted?.()
      const deadline = performance.now() + input.timeoutMs + 120_000
      let cancellationDeadline: number | undefined
      for (;;) {
        if (input.signal?.aborted) {
          const reason = input.signal.reason as { reason?: string } | undefined
          if (reason?.reason === 'shutdown' || reason?.reason === 'lease_lost') throw new ReceiptUnresolvedError(input.runId, 'Controller detached; remote worker retains its durable execution identity')
          cancellationDeadline ??= performance.now() + 30_000
          if (performance.now() >= cancellationDeadline) throw new ReceiptUnresolvedError(input.runId, 'Remote cancellation receipt remains unresolved')
          const cancelled = await this.ssh(this.supervisor('cancel', identity), { timeoutMs: 20_000 })
          const result = await this.settle(input, identity, cancelled)
          if (result.status !== 'pending') return result
        }
        const rawStatus = await this.status(identity, input.signal)
        if (this.parseReceipt(rawStatus, identity).state === 'absent') throw new ReceiptUnresolvedError(input.runId, 'Remote launch receipt was lost; no relaunch is permitted')
        const result = await this.settle(input, identity, rawStatus)
        if (result.status !== 'pending') return result
        if (performance.now() >= deadline) throw new ReceiptUnresolvedError(input.runId, 'Remote final receipt has not arrived within the frozen execution window')
        await pause(this.pollMs, input.signal?.aborted ? undefined : input.signal)
      }
    } catch (error) {
      const reason = input.signal?.reason as {reason?: string} | undefined
      if (input.signal?.aborted && reason?.reason !== 'shutdown' && reason?.reason !== 'lease_lost' && await this.launchFence(input, identity)) {
        try {return await this.cancelAttempt(input, identity)} catch (cancelError) {throw new ReceiptUnresolvedError(input.runId, cancelError instanceof Error ? cancelError.message : String(cancelError))}
      }
      throw error instanceof ReceiptUnresolvedError ? error : new ReceiptUnresolvedError(input.runId, error instanceof Error ? error.message : String(error))
    }
  }
}
