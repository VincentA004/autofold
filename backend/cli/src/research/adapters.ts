import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "@/project/instance"

export namespace DesignAdapters {
  export interface Info {
    id: "mock" | "proto"
    label: string
    available: boolean
    reason?: string
    python: string
    proto?: {
      root: string
      languageCommit: string
      toolsCommit: string
    }
  }

  async function command(argv: string[], cwd?: string): Promise<string | undefined> {
    const process = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const [code, output] = await Promise.all([process.exited, new Response(process.stdout).text()])
    if (code !== 0) return
    return output.trim()
  }

  async function executable(file: string): Promise<boolean> {
    return fs.access(file, fs.constants.X_OK).then(
      () => true,
      () => false,
    )
  }

  export async function list(workspace = Instance.directory): Promise<Info[]> {
    const protoRoot =
      process.env.AUTOFOLD_PROTO_ROOT ??
      path.join(os.homedir(), "Developer", "repo_store", "github.com-evo-design-proto-language")
    const protoPython =
      process.env.AUTOFOLD_PROTO_PYTHON ?? path.join(workspace, ".autofold", "envs", "proto", "bin", "python")
    const [pythonAvailable, languageCommit, toolsCommit] = await Promise.all([
      executable(protoPython),
      command(["git", "rev-parse", "HEAD"], protoRoot),
      command(["git", "rev-parse", "HEAD"], path.join(protoRoot, "proto-tools")),
    ])
    const commitsValid = /^[a-f0-9]{40}$/.test(languageCommit ?? "") && /^[a-f0-9]{40}$/.test(toolsCommit ?? "")
    const imports =
      pythonAvailable && commitsValid
        ? await command([protoPython, "-c", "import proto_language, proto_tools"], protoRoot)
        : undefined
    const protoAvailable = pythonAvailable && commitsValid && imports !== undefined
    const reason = !commitsValid
      ? "Pinned Proto repository was not found"
      : !pythonAvailable
        ? `Proto Python environment was not found at ${protoPython}`
        : imports === undefined
          ? "Proto Python environment cannot import proto_language and proto_tools"
          : undefined
    return [
      {
        id: "mock",
        label: "Deterministic mock peptide generator",
        available: true,
        python: Bun.which("python3") ?? "python3",
      },
      {
        id: "proto",
        label: "Pinned Proto Language program",
        available: protoAvailable,
        reason,
        python: protoPython,
        ...(commitsValid
          ? {
              proto: {
                root: protoRoot,
                languageCommit: languageCommit!,
                toolsCommit: toolsCommit!,
              },
            }
          : {}),
      },
    ]
  }

  export async function get(id: Info["id"], workspace = Instance.directory): Promise<Info> {
    return (await list(workspace)).find((adapter) => adapter.id === id)!
  }
}
