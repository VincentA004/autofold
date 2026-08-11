import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "@/compute/jobs"

const safeRemotePath = /^\/[A-Za-z0-9._/-]+$/
const safeHost = /^[A-Za-z0-9._-]+$/

export namespace ResearchRemoteCompute {
  export type Profile =
    | { kind: "local" }
    | {
        kind: "ssh"
        host: ComputeJobs.Host
        remoteRun: string
        python: string
        protoRoot?: string
        protoHome?: string
        boltzgenExecutable?: string
        boltzgenCache?: string
        pxdesignExecutable?: string
      }

  function absoluteRemote(value: string | undefined, label: string): string {
    const clean = value?.replace(/\/$/, "")
    if (
      !clean ||
      !safeRemotePath.test(clean) ||
      clean === "/" ||
      clean.includes("//") ||
      path.posix.normalize(clean) !== clean
    ) {
      throw new Error(`${label} must be a safe absolute POSIX path`)
    }
    return clean
  }

  export function profile(
    runId: string,
    proto: boolean,
    env: NodeJS.ProcessEnv = process.env,
  ): Profile {
    const selected = env.AUTOFOLD_RESEARCH_COMPUTE?.trim() || "local"
    if (selected === "local") return { kind: "local" }
    if (!selected.startsWith("ssh:")) {
      throw new Error("AUTOFOLD_RESEARCH_COMPUTE must be local or ssh:<host-alias>")
    }
    const alias = selected.slice(4)
    if (!safeHost.test(alias) || alias.startsWith("-")) {
      throw new Error("The research SSH host alias contains unsupported characters")
    }
    const endpoint = env.AUTOFOLD_RESEARCH_REMOTE_HOST?.trim() || alias
    if (!safeHost.test(endpoint) || endpoint.startsWith("-")) {
      throw new Error("AUTOFOLD_RESEARCH_REMOTE_HOST contains unsupported characters")
    }
    const root = absoluteRemote(env.AUTOFOLD_RESEARCH_REMOTE_ROOT, "AUTOFOLD_RESEARCH_REMOTE_ROOT")
    const python = absoluteRemote(env.AUTOFOLD_RESEARCH_REMOTE_PYTHON, "AUTOFOLD_RESEARCH_REMOTE_PYTHON")
    const protoRoot = proto
      ? absoluteRemote(env.AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT, "AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT")
      : undefined
    const protoHome = proto
      ? absoluteRemote(env.AUTOFOLD_RESEARCH_REMOTE_PROTO_HOME, "AUTOFOLD_RESEARCH_REMOTE_PROTO_HOME")
      : undefined
    const hasBoltzgen = Boolean(
      env.AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_EXECUTABLE || env.AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_CACHE,
    )
    const boltzgenExecutable = hasBoltzgen
      ? absoluteRemote(
          env.AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_EXECUTABLE,
          "AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_EXECUTABLE",
        )
      : undefined
    const boltzgenCache = hasBoltzgen
      ? absoluteRemote(env.AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_CACHE, "AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_CACHE")
      : undefined
    const pxdesignExecutable = env.AUTOFOLD_RESEARCH_REMOTE_PXDESIGN_EXECUTABLE
      ? absoluteRemote(
          env.AUTOFOLD_RESEARCH_REMOTE_PXDESIGN_EXECUTABLE,
          "AUTOFOLD_RESEARCH_REMOTE_PXDESIGN_EXECUTABLE",
        )
      : undefined
    const remoteRun = path.posix.join(root, "runs", runId)
    return {
      kind: "ssh",
      host: {
        id: alias,
        label: alias,
        host: alias,
        ...(endpoint === alias ? {} : { address: endpoint }),
        scheduler: "none",
        workdir: remoteRun,
      },
      remoteRun,
      python,
      protoRoot,
      protoHome,
      boltzgenExecutable,
      boltzgenCache,
      pxdesignExecutable,
    }
  }

  async function subprocess(argv: string[]): Promise<void> {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `${argv[0]} exited with code ${code}`)
    }
  }

  export function requiredProtoArtifacts(bundle: unknown, protoHome: string): string[] {
    const value = bundle as {
      pipeline?: { stages?: Array<{ models?: Array<{ toolKey?: string; id?: string; config?: Record<string, unknown> }> }> }
    }
    const required = new Set<string>()
    for (const stage of value.pipeline?.stages ?? []) {
      for (const model of stage.models ?? []) {
        const key = model.toolKey ?? model.id
        if (key === "protenix-prediction" && model.config?.model_name === "protenix-v2") {
          required.add(path.posix.join(protoHome, "proto_model_cache/protenix/checkpoint/protenix-v2.pt"))
        }
      }
    }
    return [...required]
  }

  async function assertRemoteArtifacts(profile: Extract<Profile, { kind: "ssh" }>, localRun: string) {
    if (!profile.protoHome) return
    const bundle = JSON.parse(await fs.readFile(path.join(localRun, "bundle.json"), "utf8"))
    const required = requiredProtoArtifacts(bundle, profile.protoHome)
    if (!required.length) return
    const address = profile.host.address ? ["-o", `HostName=${profile.host.address}`] : []
    try {
      await subprocess([
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        ...address,
        "--",
        profile.host.host,
        required.map((artifact) => `test -s ${ComputeJobs.quote(artifact)}`).join(" && "),
      ])
    } catch {
      throw new Error(
        `Remote Proto runtime is missing required gated model artifacts: ${required.join(", ")}. Install them before launching the GPU workflow.`,
      )
    }
  }

  export async function stage(profile: Extract<Profile, { kind: "ssh" }>, localRun: string, workerRoot: string) {
    await assertRemoteArtifacts(profile, localRun)
    const address = profile.host.address ? ["-o", `HostName=${profile.host.address}`] : []
    await subprocess([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      ...address,
      "--",
      profile.host.host,
      `test ! -e ${ComputeJobs.quote(profile.remoteRun)} && mkdir -p ${ComputeJobs.quote(profile.remoteRun)}`,
    ])
    const entries = await fs.readdir(localRun)
    const inputs = entries.filter((entry) => entry !== "output" && !entry.startsWith(".remote-download-"))
    if (!inputs.includes("bundle.json") || !inputs.includes("trial.py")) {
      throw new Error("Research run staging requires bundle.json and trial.py")
    }
    await subprocess(["scp", "-q", ...address, ...inputs.map((entry) => path.join(localRun, entry)), `${profile.host.host}:${profile.remoteRun}/`])
    await subprocess(["scp", "-q", ...address, "-r", workerRoot, `${profile.host.host}:${profile.remoteRun}/worker`])
  }

  async function validateDownloadedTree(root: string): Promise<void> {
    let files = 0
    let bytes = 0
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        const stat = await fs.lstat(target)
        if (stat.isSymbolicLink()) throw new Error(`Remote output contains a symbolic link: ${entry.name}`)
        if (stat.isDirectory()) {
          await visit(target)
          continue
        }
        if (!stat.isFile()) throw new Error(`Remote output contains an unsupported file type: ${entry.name}`)
        files += 1
        bytes += stat.size
        if (files > 20_000 || bytes > 100 * 1024 * 1024 * 1024) {
          throw new Error("Remote output exceeds the retrieval safety limit")
        }
      }
    }
    await visit(root)
  }

  export async function retrieve(job: ComputeJobs.Job, output: string): Promise<void> {
    if (job.target.kind !== "ssh") return
    if (!job.cwd || !safeRemotePath.test(job.cwd)) throw new Error("Remote research job has no safe run directory")
    const alias = job.target.host_id
    if (!safeHost.test(alias) || alias.startsWith("-")) throw new Error("Remote research job has an invalid SSH host")
    const configuredAddress = process.env.AUTOFOLD_RESEARCH_REMOTE_HOST?.trim()
    if (configuredAddress && (!safeHost.test(configuredAddress) || configuredAddress.startsWith("-"))) {
      throw new Error("AUTOFOLD_RESEARCH_REMOTE_HOST contains unsupported characters")
    }
    const address = configuredAddress ? ["-o", `HostName=${configuredAddress}`] : []
    const temporary = path.join(path.dirname(output), `.remote-download-${crypto.randomUUID()}`)
    await fs.mkdir(path.dirname(output), { recursive: true })
    try {
      await subprocess(["scp", "-q", ...address, "-r", `${alias}:${path.posix.join(job.cwd, "output")}`, temporary])
      await validateDownloadedTree(temporary)
      await fs.rename(temporary, output)
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  export function command(
    profile: Profile,
    local: { python: string; bundle: string; output: string; evaluator: string; evidence?: string },
  ): { command: string; cwd: string; target: ComputeJobs.Target; hosts?: ComputeJobs.Host[] } {
    if (profile.kind === "local") {
      return {
        command: workerCommand(local),
        cwd: ".",
        target: { kind: "local" },
      }
    }
    const remote = {
      python: profile.python,
      bundle: path.posix.join(profile.remoteRun, "bundle.json"),
      output: path.posix.join(profile.remoteRun, "output"),
      evaluator: path.posix.join(profile.remoteRun, "worker", "autofold_worker", path.basename(local.evaluator)),
      evidence: local.evidence
        ? path.posix.join(profile.remoteRun, "worker", "autofold_worker", path.basename(local.evidence))
        : undefined,
    }
    const base = workerCommand(remote)
    const environment = [
      ...(profile.protoRoot && profile.protoHome
        ? [
            `PROTO_HOME=${ComputeJobs.quote(profile.protoHome)}`,
            `AUTOFOLD_PROTO_ROOT=${ComputeJobs.quote(profile.protoRoot)}`,
          ]
        : []),
      ...(profile.boltzgenExecutable && profile.boltzgenCache
        ? [
            `AUTOFOLD_BOLTZGEN_EXECUTABLE=${ComputeJobs.quote(profile.boltzgenExecutable)}`,
            `AUTOFOLD_BOLTZGEN_CACHE=${ComputeJobs.quote(profile.boltzgenCache)}`,
          ]
        : []),
      ...(profile.pxdesignExecutable
        ? [`AUTOFOLD_PXDESIGN_EXECUTABLE=${ComputeJobs.quote(profile.pxdesignExecutable)}`]
        : []),
    ]
    const command = environment.length ? `${environment.join(" ")} ${base}` : base
    return {
      command,
      cwd: profile.remoteRun,
      target: { kind: "ssh", host_id: profile.host.id },
      hosts: [profile.host],
    }
  }

  function workerCommand(input: { python: string; bundle: string; output: string; evaluator: string; evidence?: string }) {
    return [
      ComputeJobs.quote(input.python),
      ComputeJobs.quote(path.join(path.dirname(path.dirname(input.evaluator)), "run_worker.py")),
      "--bundle",
      ComputeJobs.quote(input.bundle),
      "--output",
      ComputeJobs.quote(input.output),
      "--evaluator-source",
      ComputeJobs.quote(input.evaluator),
      ...(input.evidence ? ["--evidence-adapter-source", ComputeJobs.quote(input.evidence)] : []),
    ].join(" ")
  }
}
