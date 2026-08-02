import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "../global"
import { OpenScience } from "../openscience"
import { Shell } from "../shell/shell"
import { Instance } from "../project/instance"
import { Sandbox } from "../sandbox/sandbox"
import { Filesystem } from "../util/filesystem"
import { ProvenanceEnvelope } from "../science/provenance/envelope"
import { ExecutionAuthority } from "../project/execution"

export class ComputeJobsCorruptError extends Error {
  constructor(
    readonly filepath: string,
    readonly backup?: string,
    cause?: unknown,
  ) {
    super(
      backup
        ? `Compute job history ${filepath} is corrupt. Refusing to overwrite it; the unmodified bytes were backed up to ${backup}.`
        : `Compute job history ${filepath} is corrupt and cannot be read. Repair or remove it before continuing.`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "ComputeJobsCorruptError"
  }
}

export namespace ComputeJobs {
  export const Scheduler = z.enum(["none", "slurm", "pbs"])
  export type Scheduler = z.infer<typeof Scheduler>

  export const Host = z.object({
    id: z.string(),
    label: z.string(),
    host: z.string(),
    user: z.string().optional(),
    port: z.number().int().positive().optional(),
    scheduler: Scheduler.default("none"),
    workdir: z.string().optional(),
  })
  export type Host = z.infer<typeof Host>

  export const Probe = z.object({
    ok: z.boolean(),
    host: z.string(),
    latency_ms: z.number().nonnegative(),
    hostname: z.string().optional(),
    python: z.boolean(),
    gpu: z.boolean(),
    slurm: z.boolean(),
    pbs: z.boolean(),
    error: z.string().optional(),
  })
  export type Probe = z.infer<typeof Probe>

  export const Target = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }),
    z.object({ kind: z.literal("ssh"), host_id: z.string() }),
  ])
  export type Target = z.infer<typeof Target>

  export const Resources = z.object({
    cpus: z.number().int().min(1).max(1024).optional(),
    gpus: z.number().int().min(0).max(128).optional(),
    memory_gb: z.number().min(0.1).max(100_000).optional(),
    time_minutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30)
      .optional(),
    partition: z.string().trim().min(1).max(120).optional(),
  })
  export type Resources = z.infer<typeof Resources>

  export const Artifact = z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    modified_at: z.string(),
  })
  export type Artifact = z.infer<typeof Artifact>

  export const Reproducibility = z.object({
    captured_at: z.string(),
    command: z.string(),
    cwd: z.string(),
    platform: z.string(),
    arch: z.string(),
    bun: z.string(),
    node: z.string(),
    python: z.string().optional(),
    git: z
      .object({
        repository: z.string().optional(),
        branch: z.string().optional(),
        commit: z.string().optional(),
        dirty: z.boolean(),
      })
      .optional(),
    lockfiles: Artifact.array(),
    resources: Resources.optional(),
  })
  export type Reproducibility = z.infer<typeof Reproducibility>

  export const Input = z.object({
    name: z.string().trim().min(1).max(120),
    command: z.string().trim().min(1).max(100_000),
    cwd: z.string().optional(),
    target: Target,
    resources: Resources.optional(),
    modules: z.array(z.string().trim().min(1).max(240)).max(64).optional(),
    container: z.string().trim().min(1).max(2_000).optional(),
    artifacts: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    checkpoint: z.string().trim().min(1).max(2_000).optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Request = Input.extend({
    sessionID: z.string().startsWith("ses_"),
  })
  export type Request = z.infer<typeof Request>

  export const Status = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"])
  export type Status = z.infer<typeof Status>

  export const Job = z.object({
    id: z.string(),
    name: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    target: Target,
    target_label: z.string(),
    scheduler: Scheduler,
    status: Status,
    created_at: z.string(),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
    exit_code: z.number().int().nullable().optional(),
    pid: z.number().int().positive().optional(),
    error: z.string().optional(),
    resources: Resources.optional(),
    modules: z.array(z.string()).optional(),
    container: z.string().optional(),
    artifact_patterns: z.array(z.string()).optional(),
    artifacts: Artifact.array().optional(),
    checkpoint_path: z.string().optional(),
    checkpoint: Artifact.optional(),
    reproducibility: Reproducibility.optional(),
    provenance: ProvenanceEnvelope.Schema.optional(),
    capture_error: z.string().optional(),
    session_id: z.string().startsWith("ses_").optional(),
    authority: ExecutionAuthority.Decision.optional(),
    scope: z
      .object({
        directory: z.string(),
        key: z.string(),
      })
      .optional(),
    sandbox: z
      .object({
        requested: z.boolean(),
        enforced: z.boolean(),
        backend: z.enum(["seatbelt", "bubblewrap", "none"]),
        network: z.enum(["allow", "deny"]),
        warning: z.string().optional(),
      })
      .optional(),
  })
  export type Job = z.infer<typeof Job>

  type Options = {
    data?: string
    root?: string
    workspace?: string
    hosts?: Host[]
  }

  type Runtime = {
    process?: ChildProcess
    detached: boolean
    authority: ExecutionAuthority.Decision
    root: string
    workspace: string
    id: string
    host?: Host
  }

  type Scope = {
    root: string
    workspace: string
    key: string
  }

  type Launch = {
    argv: string[]
    sandbox?: Job["sandbox"]
  }

  const active = new Map<string, Runtime>()
  const locks = new Map<string, Promise<void>>()
  const terminal = new Set<Status>(["succeeded", "failed", "cancelled", "interrupted"])

  const scopeKey = (workspace: string) => crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 40)
  // v1 wrote directly to `<data>/compute/jobs.json` without an owner. Never
  // auto-claim those records: cwd is optional/remote and nested projects make
  // inference ambiguous. They remain recoverable on disk while all current
  // reads and writes use a canonical-workspace bucket below `projects/`.
  const rootOf = (workspace: string, options: Options) =>
    options.root ?? path.join(options.data ?? Global.Path.data, "compute", "projects", scopeKey(workspace))
  const metaOf = (root: string) => path.join(root, "jobs.json")
  const logsOf = (root: string) => path.join(root, "jobs")
  const exitOf = (root: string, id: string) => path.join(logsOf(root), `${id}.exit`)
  const keyOf = (root: string, id: string) => `${root}\0${id}`

  async function scoped(options: Options): Promise<Scope> {
    const requested = options.workspace ?? Instance.directory
    const workspace = await Filesystem.canonical(requested)
    const info = workspace ? await fs.stat(workspace).catch(() => undefined) : undefined
    if (!workspace || !info?.isDirectory()) throw new Error(`Compute project directory does not exist: ${requested}`)
    return {
      root: rootOf(workspace, options),
      workspace,
      key: scopeKey(workspace),
    }
  }

  async function read(root: string): Promise<Job[]> {
    const filepath = metaOf(root)
    const text = await fs.readFile(filepath, "utf8").catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (text === undefined) return []
    const value = await Promise.resolve()
      .then(() => JSON.parse(text))
      .catch((error) => {
        throw new ComputeJobsCorruptError(filepath, undefined, error)
      })
    const result = Job.array().safeParse(value)
    if (!result.success) throw new ComputeJobsCorruptError(filepath, undefined, result.error)
    return result.data
  }

  async function write(root: string, jobs: Job[]): Promise<void> {
    const clean = await OpenScience.scrubSecrets(jobs)
    const filepath = metaOf(root)
    const temp = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(root, { recursive: true })
    await (async () => {
      const file = await fs.open(temp, "wx", 0o600)
      await file
        .chmod(0o600)
        .then(() => file.writeFile(JSON.stringify(clean, null, 2), "utf8"))
        .then(() => file.sync())
        .finally(() => file.close())
      await fs.rename(temp, filepath)
      const directory = await fs.open(root, "r").catch(() => undefined)
      await directory?.sync().catch(() => undefined)
      await directory?.close().catch(() => undefined)
    })().catch(async (error) => {
      await fs.unlink(temp).catch(() => undefined)
      throw error
    })
  }

  async function preserve(root: string, error: unknown): Promise<never> {
    if (!(error instanceof ComputeJobsCorruptError)) throw error
    const filepath = metaOf(root)
    const backup = `${filepath}.corrupt-${process.pid}`
    const preserved = await fs
      .copyFile(filepath, backup)
      .then(() => fs.chmod(backup, 0o600))
      .then(() => backup)
      .catch(() => undefined)
    throw new ComputeJobsCorruptError(filepath, preserved, error)
  }

  async function change<T>(root: string, edit: (jobs: Job[]) => T | Promise<T>): Promise<T> {
    const prior = locks.get(root) ?? Promise.resolve()
    const task = prior
      .catch(() => undefined)
      .then(async () => {
        const jobs = await read(root).catch((error) => preserve(root, error))
        const result = await edit(jobs)
        await write(root, jobs)
        return result
      })
    locks.set(
      root,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return task
  }

  async function patch(root: string, id: string, value: Partial<Job>): Promise<Job> {
    return change(root, (jobs) => {
      const index = jobs.findIndex((job) => job.id === id)
      if (index < 0) throw new Error(`Compute job ${id} was not found`)
      const draft = Job.parse({ ...jobs[index], ...value })
      const next = Job.parse({ ...draft, provenance: provenance(draft) })
      jobs[index] = next
      return next
    })
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function sync(root: string): Promise<void> {
    const jobs = await read(root)
    const updates = (
      await Promise.all(
        jobs.map(async (job): Promise<{ id: string; value: Partial<Job> } | undefined> => {
          if (terminal.has(job.status) || active.has(keyOf(root, job.id))) return
          if (job.status === "queued" && Date.now() - Date.parse(job.created_at) < 5_000) return
          const marker = await Bun.file(exitOf(root, job.id))
            .text()
            .catch(() => undefined)
          const exit = marker?.trim().match(/^-?\d+$/) ? Number(marker.trim()) : undefined
          if (job.target.kind === "local" && exit !== undefined) {
            return {
              id: job.id,
              value: {
                status: exit === 0 ? "succeeded" : "failed",
                completed_at: new Date().toISOString(),
                exit_code: exit,
                pid: undefined,
              },
            }
          }
          if (job.target.kind === "local" && job.pid && alive(job.pid)) return
          return {
            id: job.id,
            value: {
              status: "interrupted",
              completed_at: new Date().toISOString(),
              exit_code: null,
              pid: undefined,
              error:
                job.target.kind === "ssh"
                  ? "The app connection ended before this remote job reported a result. Check the remote scheduler before rerunning it."
                  : "The job process ended before it could report a result.",
            },
          }
        }),
      )
    ).filter((item): item is { id: string; value: Partial<Job> } => !!item)
    if (!updates.length) return
    await change(root, (current) => {
      for (const update of updates) {
        const index = current.findIndex((job) => job.id === update.id)
        if (index < 0 || terminal.has(current[index]!.status) || active.has(keyOf(root, update.id))) continue
        const draft = Job.parse({ ...current[index], ...update.value })
        current[index] = Job.parse({ ...draft, provenance: provenance(draft) })
      }
    })
  }

  export function quote(value: string): string {
    return `'${value.replaceAll("'", `'\"'\"'`)}'`
  }

  function name(value: string): string {
    const clean = value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42)
    return clean || "job"
  }

  function clock(minutes: number): string {
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00`
  }

  function workload(input: { command: string; modules?: string[]; container?: string }): string {
    const modules = input.modules?.length ? `module load ${input.modules.map(quote).join(" ")}` : undefined
    const command = input.container
      ? `apptainer exec ${quote(input.container)} bash -lc ${quote(input.command)}`
      : input.command
    return [modules, command].filter((part): part is string => !!part).join(" && ")
  }

  function slurm(input: { resources?: Resources }): string[] {
    const resources = input.resources
    if (!resources) return []
    return [
      resources.cpus ? `--cpus-per-task=${resources.cpus}` : undefined,
      resources.gpus ? `--gres=gpu:${resources.gpus}` : undefined,
      resources.memory_gb ? `--mem=${resources.memory_gb}G` : undefined,
      resources.time_minutes ? `--time=${clock(resources.time_minutes)}` : undefined,
      resources.partition ? `--partition=${quote(resources.partition)}` : undefined,
    ].filter((part): part is string => !!part)
  }

  function pbs(input: { resources?: Resources }): string[] {
    const resources = input.resources
    if (!resources) return []
    const select = [
      "select=1",
      resources.cpus ? `ncpus=${resources.cpus}` : undefined,
      resources.gpus ? `ngpus=${resources.gpus}` : undefined,
      resources.memory_gb ? `mem=${resources.memory_gb}gb` : undefined,
    ]
      .filter((part): part is string => !!part)
      .join(":")
    return [
      select === "select=1" ? undefined : `-l ${quote(select)}`,
      resources.time_minutes ? `-l ${quote(`walltime=${clock(resources.time_minutes)}`)}` : undefined,
    ].filter((part): part is string => !!part)
  }

  function remote(
    input: {
      id: string
      name: string
      command: string
      cwd?: string
      resources?: Resources
      modules?: string[]
      container?: string
    },
    host: Host,
  ): string {
    const cwd = input.cwd || host.workdir || "."
    const job = `os-${input.id}`
    const folder = `.openscience/jobs`
    const log = `${folder}/${input.id}.log`
    const enter = `cd ${quote(cwd)} && mkdir -p ${quote(folder)}`
    const run = workload(input)
    if (host.scheduler === "slurm") {
      return [
        enter,
        [
          "sbatch --wait --parsable",
          `--job-name=${quote(job)}`,
          `--output=${quote(log)}`,
          `--error=${quote(log)}`,
          ...slurm(input),
          `--wrap=${quote(run)}`,
        ].join(" "),
        "code=$?",
        `test -f ${quote(log)} && cat ${quote(log)}`,
        "exit $code",
      ].join("; ")
    }
    if (host.scheduler === "pbs") {
      const script = `#!/usr/bin/env bash\nset -o pipefail\n${run}\n`
      return [
        enter,
        [
          `printf %s ${quote(script)} | qsub -W block=true`,
          `-N ${quote(name(job))}`,
          "-j oe",
          `-o ${quote(log)}`,
          ...pbs(input),
        ].join(" "),
        "code=$?",
        `test -f ${quote(log)} && cat ${quote(log)}`,
        "exit $code",
      ].join("; ")
    }
    return `${enter} && exec bash -lc ${quote(run)}`
  }

  function ssh(host: Host, script: string): string[] {
    const destination = host.user ? `${host.user}@${host.host}` : host.host
    if (destination.startsWith("-")) throw new Error("SSH destinations cannot begin with a hyphen")
    const port = host.port ? ["-p", String(host.port)] : []
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...port, "--", destination, script]
  }

  export function command(
    input: {
      id: string
      name: string
      command: string
      cwd?: string
      resources?: Resources
      modules?: string[]
      container?: string
    },
    host?: Host,
  ): { argv: string[]; scheduler: Scheduler; label: string } {
    if (!host) {
      return {
        argv: [Shell.acceptable(), "-lc", input.command],
        scheduler: "none",
        label: "This computer",
      }
    }
    return {
      argv: ssh(host, remote(input, host)),
      scheduler: host.scheduler,
      label: host.label,
    }
  }

  async function launch(
    job: Job,
    host: Host | undefined,
    scope: Scope,
    authority: ExecutionAuthority.Decision,
  ): Promise<Launch> {
    const spec = command(job, host)
    if (host) {
      const planned = Sandbox.wrapArgv({
        file: spec.argv[0]!,
        args: spec.argv.slice(1),
        workspace: authority.writable,
        unreadable: OpenScience.kernelSensitivePaths(),
        options: authority.sandbox,
      })
      return {
        argv: [planned.file, ...planned.args],
        sandbox: {
          requested: authority.sandbox.enabled,
          enforced: planned.sandboxed,
          backend: planned.backend,
          network: authority.sandbox.network,
          warning: planned.warning,
        },
      }
    }

    await fs.mkdir(logsOf(scope.root), { recursive: true })
    await fs.writeFile(exitOf(scope.root, job.id), "", { mode: 0o600 })
    const wrapped = `(${job.command}\n); code=$?; printf %s "$code" > ${quote(exitOf(scope.root, job.id))}; exit "$code"`
    const planned = Sandbox.wrapArgv({
      file: Shell.acceptable(),
      args: ["-lc", wrapped],
      workspace: authority.writable,
      extraWritable: [exitOf(scope.root, job.id)],
      unreadable: OpenScience.kernelSensitivePaths(),
      options: authority.sandbox,
    })
    return {
      argv: [planned.file, ...planned.args],
      sandbox: {
        requested: authority.sandbox.enabled,
        enforced: planned.sandboxed,
        backend: planned.backend,
        network: authority.sandbox.network,
        warning: planned.warning,
      },
    }
  }

  async function output(
    argv: string[],
    cwd: string,
    authority: ExecutionAuthority.Decision,
  ): Promise<string | undefined> {
    const planned = Sandbox.wrapArgv({
      file: argv[0]!,
      args: argv.slice(1),
      workspace: authority.writable,
      unreadable: OpenScience.kernelSensitivePaths(),
      options: authority.sandbox,
    })
    const proc = Bun.spawn([planned.file, ...planned.args], {
      cwd,
      env: await OpenScience.subprocessEnv(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    if (code !== 0) return
    return text.trim() || undefined
  }

  function inside(root: string, file: string): string | undefined {
    const target = path.resolve(root, file)
    const relative = path.relative(root, target)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
    return relative
  }

  async function fingerprint(root: string, file: string): Promise<Artifact | undefined> {
    const relative = inside(root, file)
    if (!relative) return
    const target = path.join(root, relative)
    const canonical = await Filesystem.canonical(target)
    if (!canonical || !Filesystem.contains(root, canonical)) {
      throw new Error(`Artifact path escapes the project workspace: ${file}`)
    }
    const stat = await fs.stat(canonical).catch(() => undefined)
    if (!stat?.isFile()) return
    const hash = new Bun.CryptoHasher("sha256")
    for await (const chunk of createReadStream(canonical)) hash.update(chunk)
    return Artifact.parse({
      path: relative.split(path.sep).join("/"),
      size: stat.size,
      sha256: hash.digest("hex"),
      modified_at: stat.mtime.toISOString(),
    })
  }

  async function artifacts(root: string, patterns: string[]): Promise<Artifact[]> {
    const files = new Set<string>()
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern)
      for await (const file of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
        files.add(file)
        if (files.size >= 200) break
      }
      if (files.size >= 200) break
    }
    const values = await Promise.all([...files].toSorted().map((file) => fingerprint(root, file)))
    return values.filter((item): item is Artifact => !!item)
  }

  function prefix(pattern: string): string {
    const index = pattern.search(/[*?[{]/)
    const head = index < 0 ? pattern : pattern.slice(0, index)
    return head.endsWith(path.sep) || head.endsWith("/") ? head.slice(0, -1) : path.dirname(head)
  }

  async function outputPath(root: string, file: string, label: string): Promise<void> {
    if (!inside(root, file)) throw new Error(`${label} must stay inside the project working directory: ${file}`)
    const canonical = await Filesystem.canonical(path.resolve(root, file))
    if (!canonical || !Filesystem.contains(root, canonical)) {
      throw new Error(`${label} escapes the project working directory through a symlink: ${file}`)
    }
  }

  async function outputs(root: string, patterns: string[], checkpoint?: string): Promise<void> {
    for (const pattern of patterns) {
      await outputPath(root, pattern.replace(/[*?[{].*$/, "output"), "Artifact pattern")
      const base = prefix(pattern)
      if (base === ".") continue
      await outputPath(root, base, "Artifact pattern")
    }
    if (checkpoint) await outputPath(root, checkpoint, "Checkpoint path")
  }

  const lockfiles = [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "requirements.txt",
    "environment.yml",
    "environment.yaml",
    "renv.lock",
    "Manifest.toml",
    "Cargo.lock",
  ]

  async function reproduce(job: Job, authority: ExecutionAuthority.Decision): Promise<Reproducibility> {
    const cwd = path.resolve(job.cwd ?? process.cwd())
    const [repository, branch, commit, status, python, capturedLocks] = await Promise.all([
      output(["git", "remote", "get-url", "origin"], cwd, authority),
      output(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd, authority),
      output(["git", "rev-parse", "HEAD"], cwd, authority),
      output(["git", "status", "--porcelain"], cwd, authority),
      output(["python3", "--version"], cwd, authority),
      Promise.all(lockfiles.map((file) => fingerprint(cwd, file))),
    ])
    const git =
      repository || branch || commit || status !== undefined
        ? { repository, branch, commit, dirty: !!status }
        : undefined
    return Reproducibility.parse({
      captured_at: new Date().toISOString(),
      command: job.command,
      cwd,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      node: process.version,
      python,
      git,
      lockfiles: capturedLocks.filter((item): item is Artifact => !!item),
      resources: job.resources,
    })
  }

  function provenance(job: Job): ProvenanceEnvelope.Schema {
    const outputs = [
      ...(job.artifacts ?? []).map((artifact) =>
        ProvenanceEnvelope.output({
          kind: "artifact",
          label: artifact.path,
          artifactID: artifact.path,
          path: artifact.path,
          sha256: artifact.sha256,
          size: artifact.size,
          createdAt: artifact.modified_at,
          versionReason: "not_versioned",
        }),
      ),
      ...(job.checkpoint
        ? [
            ProvenanceEnvelope.output({
              kind: "checkpoint",
              label: job.checkpoint.path,
              artifactID: job.checkpoint.path,
              path: job.checkpoint.path,
              sha256: job.checkpoint.sha256,
              size: job.checkpoint.size,
              createdAt: job.checkpoint.modified_at,
              versionReason: "not_versioned",
            }),
          ]
        : []),
    ]
    const status = job.status === "succeeded" ? "succeeded" : job.status === "failed" ? "failed" : job.status
    return ProvenanceEnvelope.create({
      kind: job.target.kind === "local" ? "local_compute" : "remote_compute",
      projectID: job.authority?.projectID ?? job.scope?.key,
      sessionID: job.session_id,
      runID: job.id,
      code: job.command,
      cwd: job.cwd,
      codeState: job.reproducibility?.git,
      codeReason: job.target.kind === "ssh" ? "remote_unverified" : "not_captured",
      host: job.reproducibility
        ? {
            platform: job.reproducibility.platform,
            arch: job.reproducibility.arch,
            runtimes: {
              bun: job.reproducibility.bun,
              node: job.reproducibility.node,
              ...(job.reproducibility.python ? { python: job.reproducibility.python } : {}),
            },
          }
        : undefined,
      hostReason: job.target.kind === "ssh" ? "remote_unverified" : "not_captured",
      status,
      outputs,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    })
  }

  async function capture(job: Job): Promise<Pick<Job, "artifacts" | "checkpoint">> {
    const cwd = path.resolve(job.cwd ?? process.cwd())
    const [found, checkpoint] = await Promise.all([
      artifacts(cwd, job.artifact_patterns ?? []),
      job.checkpoint_path ? fingerprint(cwd, job.checkpoint_path) : undefined,
    ])
    return {
      artifacts: found,
      checkpoint,
    }
  }

  export async function probe(host: Host): Promise<Probe> {
    const parsed = Host.parse(host)
    const started = performance.now()
    const script = [
      "printf 'connected=1\\n'",
      "printf 'hostname='; hostname 2>/dev/null || true",
      "command -v python3 >/dev/null 2>&1 && printf 'python=1\\n' || true",
      "command -v nvidia-smi >/dev/null 2>&1 && printf 'gpu=1\\n' || true",
      "command -v sbatch >/dev/null 2>&1 && printf 'slurm=1\\n' || true",
      "command -v qsub >/dev/null 2>&1 && printf 'pbs=1\\n' || true",
    ].join("; ")
    const argv = ssh(parsed, script)
    const proc = spawn(argv[0]!, argv.slice(1), {
      env: await OpenScience.subprocessEnv(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    proc.stderr?.on("data", (chunk: Buffer) => errors.push(chunk))
    const done = new Promise<{ code: number | null; error?: string }>((resolve) => {
      proc.once("error", (error) => resolve({ code: null, error: error.message }))
      proc.once("exit", (code) => resolve({ code }))
    })
    const result = await Promise.race([
      done,
      Bun.sleep(12_000).then(() => ({ code: null, error: "Connection timed out" })),
    ])
    if (proc.exitCode === null) {
      await Shell.killTree(proc, {
        detached: false,
        exited: () => proc.exitCode !== null,
      })
    }
    const text = Buffer.concat(output).toString("utf8")
    const error = result.error || (result.code === 0 ? undefined : Buffer.concat(errors).toString("utf8").trim())
    return Probe.parse({
      ok: result.code === 0 && text.includes("connected=1"),
      host: parsed.label,
      latency_ms: Math.round(performance.now() - started),
      hostname: text.match(/^hostname=(.+)$/m)?.[1]?.trim(),
      python: text.includes("python=1"),
      gpu: text.includes("gpu=1"),
      slurm: text.includes("slurm=1"),
      pbs: text.includes("pbs=1"),
      error: error || undefined,
    })
  }

  async function execute(
    job: Job,
    host: Host | undefined,
    scope: Scope,
    authority: ExecutionAuthority.Decision,
    launch: Launch,
  ): Promise<void> {
    await fs.mkdir(logsOf(scope.root), { recursive: true })
    const log = path.join(logsOf(scope.root), `${job.id}.log`)
    const output = await fs.open(log, "a", 0o600)
    const env = await OpenScience.subprocessEnv(process.env)
    const queued = (await read(scope.root)).find((item) => item.id === job.id)
    if (queued?.status === "cancelled") {
      await output.close()
      active.delete(keyOf(scope.root, job.id))
      return
    }
    const detached = process.platform !== "win32"
    const proc = spawn(launch.argv[0]!, launch.argv.slice(1), {
      cwd: host ? authority.workspace : job.cwd,
      env,
      detached,
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd],
    })
    const result = new Promise<{ code: number | null; error?: string }>((resolve) => {
      proc.once("error", (error) => resolve({ code: null, error: error.message }))
      proc.once("exit", (code) => resolve({ code }))
    })
    const key = keyOf(scope.root, job.id)
    active.set(key, {
      process: proc,
      detached,
      authority,
      root: scope.root,
      workspace: scope.workspace,
      id: job.id,
      host,
    })
    await output.close()
    const started = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return false
      const draft = Job.parse({
        ...jobs[index],
        status: "running",
        started_at: new Date().toISOString(),
        pid: proc.pid,
      })
      jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
      return true
    })
    if (!started) {
      await Shell.killTree(proc, {
        detached,
        exited: () => proc.exitCode !== null,
      })
      active.delete(key)
      return
    }
    const completed = await result
    const captureResult = host
      ? undefined
      : await capture(job)
          .then((value) => ({ ...value, capture_error: undefined }))
          .catch((error) => ({
            capture_error: error instanceof Error ? error.message : String(error),
          }))
    await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === job.id)
      if (index < 0 || terminal.has(jobs[index]!.status)) return
      const draft = Job.parse({
        ...jobs[index],
        status: completed.code === 0 ? "succeeded" : "failed",
        completed_at: new Date().toISOString(),
        exit_code: completed.code,
        error: completed.error,
        ...captureResult,
      })
      jobs[index] = Job.parse({ ...draft, provenance: provenance(draft) })
    }).finally(() => active.delete(key))
  }

  export async function start(input: Request, options: Options = {}): Promise<Job> {
    const parsed = Request.parse(input)
    const scope = await scoped(options)
    const hostId = parsed.target.kind === "ssh" ? parsed.target.host_id : undefined
    const host = hostId ? options.hosts?.find((item) => item.id === hostId) : undefined
    if (parsed.target.kind === "ssh" && !host) throw new Error("The selected SSH compute profile was not found")
    const authority = await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: parsed.sessionID,
      capability: host ? "remote_job" : "local_job",
    })
    const requested = parsed.cwd ? path.resolve(authority.workspace, parsed.cwd) : authority.workspace
    const cwd = host ? parsed.cwd || host.workdir : await Filesystem.canonical(requested)
    const info = !host && cwd ? await fs.stat(cwd).catch(() => undefined) : undefined
    if (!host && (!cwd || !info?.isDirectory() || !Filesystem.contains(authority.workspace, cwd))) {
      throw new Error(
        `Local compute working directory must be inside the session workspace: ${parsed.cwd ?? requested}`,
      )
    }
    if (!host) await outputs(cwd!, parsed.artifacts ?? [], parsed.checkpoint)
    const id = crypto.randomUUID().slice(0, 12)
    const spec = command({ id, ...parsed, cwd }, host)
    const draft = Job.parse({
      id,
      name: parsed.name,
      command: parsed.command,
      cwd,
      target: parsed.target,
      target_label: spec.label,
      scheduler: spec.scheduler,
      status: "queued",
      created_at: new Date().toISOString(),
      resources: parsed.resources,
      modules: parsed.modules,
      container: parsed.container,
      artifact_patterns: parsed.artifacts,
      checkpoint_path: parsed.checkpoint,
      session_id: parsed.sessionID,
      authority,
      scope: {
        directory: scope.workspace,
        key: scope.key,
      },
    })
    const reproducibility = host ? undefined : await reproduce(draft, authority)
    const planned = await launch(draft, host, scope, authority).catch(async (error) => {
      if (!host) await fs.rm(exitOf(scope.root, id), { force: true })
      throw error
    })
    const base = Job.parse({ ...draft, sandbox: planned.sandbox, reproducibility })
    const job = Job.parse({ ...base, provenance: provenance(base) })
    await change(scope.root, (jobs) => {
      jobs.push(job)
    }).catch(async (error) => {
      if (!host) await fs.rm(exitOf(scope.root, id), { force: true }).catch(() => undefined)
      throw error
    })
    const key = keyOf(scope.root, job.id)
    active.set(key, {
      detached: false,
      authority,
      root: scope.root,
      workspace: scope.workspace,
      id: job.id,
      host,
    })
    void execute(job, host, scope, authority, planned)
      .catch(async (error) => {
        await fs.mkdir(logsOf(scope.root), { recursive: true })
        await fs
          .appendFile(
            path.join(logsOf(scope.root), `${job.id}.log`),
            `${error instanceof Error ? error.message : String(error)}\n`,
          )
          .catch(() => {})
        await patch(scope.root, job.id, {
          status: "failed",
          completed_at: new Date().toISOString(),
          exit_code: null,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
      .finally(() => active.delete(key))
    return job
  }

  export async function list(options: Options = {}): Promise<Job[]> {
    const scope = await scoped(options)
    await sync(scope.root)
    return (await read(scope.root)).toSorted(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id),
    )
  }

  export async function get(id: string, options: Options = {}): Promise<Job | undefined> {
    const scope = await scoped(options)
    return (await read(scope.root)).find((job) => job.id === id)
  }

  export async function log(id: string, options: Options & { bytes?: number } = {}): Promise<string> {
    const scope = await scoped(options)
    const job = await get(id, options)
    if (!job) throw new Error(`Compute job ${id} was not found`)
    const text = await Bun.file(path.join(logsOf(scope.root), `${job.id}.log`))
      .text()
      .catch(() => "")
    return text.slice(-Math.max(1, options.bytes ?? 256_000))
  }

  export async function cancel(id: string, options: Options = {}): Promise<Job> {
    const scope = await scoped(options)
    const result = await change(scope.root, (jobs) => {
      const index = jobs.findIndex((item) => item.id === id)
      if (index < 0) throw new Error(`Compute job ${id} was not found`)
      if (terminal.has(jobs[index]!.status)) return { job: jobs[index]!, changed: false }
      const draft = Job.parse({
        ...jobs[index],
        status: "cancelled",
        completed_at: new Date().toISOString(),
        exit_code: null,
      })
      const cancelled = Job.parse({ ...draft, provenance: provenance(draft) })
      jobs[index] = cancelled
      return { job: cancelled, changed: true }
    })
    const job = result.job
    if (!result.changed) return job
    const cancelled = result.job
    const runtime = active.get(keyOf(scope.root, id))
    const proc = runtime?.process
    if (proc) {
      await Shell.killTree(proc, {
        detached: runtime.detached,
        exited: () => proc.exitCode !== null,
      })
    } else if (job.pid) {
      try {
        if (process.platform === "win32") process.kill(job.pid, "SIGTERM")
        else process.kill(-job.pid, "SIGTERM")
      } catch {}
    }
    if (runtime) active.delete(keyOf(scope.root, id))
    const hostId = job.target.kind === "ssh" ? job.target.host_id : undefined
    const host = hostId ? options.hosts?.find((item) => item.id === hostId) : undefined
    if (host && host.scheduler !== "none") {
      const action =
        host.scheduler === "slurm"
          ? `scancel --name ${quote(`os-${job.id}`)}`
          : `qselect -N ${quote(name(`os-${job.id}`))} | xargs -r qdel`
      const spec = command(
        { id: job.id, name: job.name, command: action, cwd: host.workdir },
        { ...host, scheduler: "none" },
      )
      const planned = job.authority
        ? Sandbox.wrapArgv({
            file: spec.argv[0]!,
            args: spec.argv.slice(1),
            workspace: job.authority.writable,
            unreadable: OpenScience.kernelSensitivePaths(),
            options: job.authority.sandbox,
          })
        : { file: spec.argv[0]!, args: spec.argv.slice(1) }
      const proc = spawn(planned.file, planned.args, {
        cwd: job.authority?.workspace,
        env: await OpenScience.subprocessEnv(process.env),
        windowsHide: true,
        stdio: "ignore",
      })
      await new Promise<void>((resolve) => {
        proc.once("error", () => resolve())
        proc.once("exit", () => resolve())
      })
    }
    return cancelled
  }

  async function cancelActive(match: (runtime: Runtime) => boolean): Promise<number> {
    const runtimes = [...active.values()].filter(match)
    await Promise.allSettled(
      runtimes.map((runtime) =>
        cancel(runtime.id, {
          root: runtime.root,
          workspace: runtime.workspace,
          hosts: runtime.host ? [runtime.host] : undefined,
        }),
      ),
    )
    return runtimes.length
  }

  export function cancelSession(sessionID: string): Promise<number> {
    return cancelActive((runtime) => runtime.authority.sessionID === sessionID)
  }

  export function cancelProject(projectID: string): Promise<number> {
    return cancelActive((runtime) => runtime.authority.projectID === projectID)
  }

  export async function clear(options: Options = {}): Promise<number> {
    const scope = await scoped(options)
    const removed = await change(scope.root, (jobs) => {
      const done = jobs.filter((job) => terminal.has(job.status)).map((job) => job.id)
      const keep = jobs.filter((job) => !terminal.has(job.status))
      jobs.splice(0, jobs.length, ...keep)
      return done
    })
    await Promise.all(
      removed.flatMap((id) => [
        fs.rm(path.join(logsOf(scope.root), `${id}.log`), { force: true }),
        fs.rm(exitOf(scope.root, id), { force: true }),
      ]),
    )
    return removed.length
  }

  export async function wait(id: string, options: Options & { timeout?: number } = {}): Promise<Job> {
    const started = Date.now()
    const timeout = options.timeout ?? 30_000
    for (;;) {
      const job = (await list(options)).find((item) => item.id === id)
      if (!job) throw new Error(`Compute job ${id} was not found`)
      if (terminal.has(job.status)) return job
      if (Date.now() - started >= timeout) throw new Error(`Timed out waiting for compute job ${id}`)
      await Bun.sleep(25)
    }
  }
}
