import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("Autofold product shell", () => {
  test("keeps the donor layout while presenting Autofold to the user", () => {
    const html = read("../../index.html")
    const wordmark = read("../atlas/Wordmark.tsx")
    const error = read("./error.tsx")

    expect(html).toContain("<title>Autofold</title>")
    expect(wordmark).toContain("Autofold")
    expect(wordmark).toContain('src="/openscience-logo.png"')
    expect(error).toContain("Autofold hit a problem")
    expect(error).not.toContain("synthetic-sciences/openscience/issues")
  })

  test("retains compatibility identifiers that protect existing user state", () => {
    const entry = read("../entry.tsx")
    const session = read("./session.tsx")
    const pane = read("../atlas/RightPane.tsx")

    expect(entry).toContain('"openscience.settings.dat:defaultServerUrl"')
    expect(session).toContain('"openscience:open-file"')
    expect(pane).toContain('"openscience-research-inspector-width-v2"')
  })
})

