import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./ResearchWorkspace.tsx", import.meta.url)), "utf8")
const css = readFileSync(fileURLToPath(new URL("./research.css", import.meta.url)), "utf8")
const session = readFileSync(fileURLToPath(new URL("../pages/session.tsx", import.meta.url)), "utf8")
const tabs = readFileSync(fileURLToPath(new URL("../atlas/store/centerTabs.ts", import.meta.url)), "utf8")

test("research workspace remains an isolated scientific ledger ready for parent integration", () => {
  expect(source).toContain('data-component="research-workspace"')
  expect(source).toContain("Experiment contracts")
  expect(source).toContain("trial.py · immutable after record")
  expect(source).toContain("Campaign knowledge concepts")
  expect(source).toContain("runArtifacts")
  expect(source).not.toContain("centerTabs")
  expect(source).not.toContain("pages/session")
  expect(css).toContain("grid-template-columns: var(--research-rail)")
  expect(css).toContain("var(--color-border-strong)")
  expect(css).not.toContain("border-radius: 999")
  expect(session).toContain('import { ResearchWorkspace } from "@/research/ResearchWorkspace"')
  expect(session).toContain('centerTabs.active() === "research"')
  expect(session).toContain("<ResearchWorkspace sessionID=")
  expect(tabs).toContain('showResearch: () => setActive("research")')
})
