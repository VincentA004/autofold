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
})
