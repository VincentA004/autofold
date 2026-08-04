import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("Autofold backend architecture boundary", () => {
  test("compute execution depends on the narrow runtime policy", () => {
    const jobs = read("../compute/jobs.ts")

    expect(jobs).toContain('import { RuntimePolicy } from "../security/runtime-policy"')
    expect(jobs).not.toContain('from "../openscience"')
  })

  test("project identity does not eagerly load the session-agent runtime", () => {
    const project = read("../project/project.ts")

    expect(project).not.toContain('import { Session } from "../session"')
    expect(project).toContain('await import("./legacy-session-migration")')
  })

  test("the donor namespace remains a compatibility facade over runtime policy", () => {
    const compatibility = read("../openscience/index.ts")

    expect(compatibility).toContain("return RuntimePolicy.redactSecrets(text)")
    expect(compatibility).toContain("return RuntimePolicy.subprocessEnv(env)")
  })

  test("research execution authorizes before consuming a proposed trial", () => {
    const execution = read("../research/execution.ts")
    const authorization = execution.indexOf("await ExecutionAuthority.require")
    const transition = execution.indexOf("await Research.beginRun")

    expect(authorization).toBeGreaterThan(-1)
    expect(transition).toBeGreaterThan(authorization)
  })

  test("autoresearch loads the child-agent harness only when an iteration authors a draft", () => {
    const autoresearch = read("../research/autoresearch.ts")

    expect(autoresearch).not.toContain('import { Session } from "@/session"')
    expect(autoresearch).not.toContain('import { SessionPrompt } from "@/session/prompt"')
    expect(autoresearch).toContain('await import("@/session")')
    expect(autoresearch).toContain('await import("@/session/prompt")')
  })
})
