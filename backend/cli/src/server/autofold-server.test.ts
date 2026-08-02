import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("dedicated Autofold server entrypoint", () => {
  test("bypasses donor CLI command registration without shrinking the server API", () => {
    const entry = read("../autofold-server.ts")
    const root = read("../../../../package.json")

    expect(entry).toContain('import "./openscience/preload-env"')
    expect(entry).toContain('import { Server } from "./server/server"')
    expect(entry).not.toContain("./cli/cmd/")
    expect(entry).not.toContain('from "yargs"')
    expect(root).toContain("backend/cli/src/autofold-server.ts")
    expect(root).not.toContain("backend/cli/src/index.ts serve")
  })
})
