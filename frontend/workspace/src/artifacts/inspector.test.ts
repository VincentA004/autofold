import { describe, expect, test } from "bun:test"
import { createArtifactContext } from "./context"
import { inspectorTabs, normalizeInspectorData, normalizePublicationReview } from "./inspector"

const context = createArtifactContext({
  directory: "/work/project",
  path: "results/protein.pdb",
  format: "pdb",
  scienceKind: "protein-structure",
})

describe("artifact inspector model", () => {
  test("normalizes recorded source, environment, and Git provenance", () => {
    const result = normalizeInspectorData(context, {
      file: { type: "text", content: "ATOM      1", size: 12 },
      provenance: {
        path: "results/protein.pdb",
        tracked: true,
        dirty: false,
        status: "clean",
        branch: "openscience/aayam-new",
        commit: {
          sha: "0123456789abcdef",
          author: "Aayam Bansal",
          email: "aayambansal@gmail.com",
          date: "2026-07-29T00:00:00.000Z",
          message: "record structure",
        },
      },
      audit: {
        environments: ["pyproject.toml", "environment.yml"],
        lockfiles: ["uv.lock"],
      },
    })

    expect(result.source).toBe("ATOM      1")
    expect(result.provenance).toMatchObject({
      status: "clean",
      branch: "openscience/aayam-new",
      commit: { sha: "0123456789abcdef", author: "Aayam Bansal" },
    })
    expect(result.environments).toEqual(["pyproject.toml", "environment.yml"])
    expect(result.lockfiles).toEqual(["uv.lock"])
    expect(result.tabs.code.available).toBe(true)
    expect(result.tabs.environment.available).toBe(true)
    expect(result.tabs.history.available).toBe(true)
    expect(result.tabs.run.available).toBe(false)
    expect(result.tabs.messages.available).toBe(false)
    expect(result.tabs.review.available).toBe(true)
  })

  test("keeps malformed and absent records honest instead of inventing metadata", () => {
    const result = normalizeInspectorData(context, {
      file: { type: "text", content: 12, encoding: "base64" },
      provenance: { tracked: "yes", commit: { sha: 12 } },
      audit: { environments: ["pyproject.toml", 4], lockfiles: "uv.lock" },
    })

    expect(result.source).toBeUndefined()
    expect(result.provenance).toBeUndefined()
    expect(result.environments).toEqual([])
    expect(result.lockfiles).toEqual([])
    expect(result.tabs.code).toEqual({
      available: false,
      title: "Source is not directly displayable",
      detail: "Open the file view or download the original artifact.",
    })
    expect(result.tabs.history).toMatchObject({ available: false, title: "No Git commit is recorded" })
  })

  test("publishes the complete stable inspector tab order", () => {
    expect(inspectorTabs).toEqual(["details", "code", "run", "messages", "environment", "review", "history"])
  })

  test("normalizes publication readiness without inventing a review", () => {
    const skipped = normalizePublicationReview("pdb", undefined)
    expect(skipped.kind).toBe("not-applicable")
    expect(skipped.report).toBeUndefined()
    const missing = normalizePublicationReview("md", { status: "ready" })
    expect(missing.kind).toBe("not-run")
    expect(missing.report).toBeUndefined()
  })

  test("distinguishes blocked, stale, and finalized manuscript states", () => {
    const report = {
      format: "openscience.publication-review.v1",
      id: "review_01",
      path: "report.md",
      artifactHash: "a".repeat(64),
      version: 2,
      status: "blocked",
      stale: false,
      summary: {
        total: 2,
        open: 1,
        blocking: 1,
        major: 1,
        minor: 0,
        info: 0,
        resolved: 1,
        overridden: 0,
      },
      findings: [
        {
          id: "finding_01",
          check: "citation",
          severity: "blocking",
          status: "open",
          title: "Citation is unresolved",
          detail: "Add a bibliography entry.",
          evidence: ["report.md:4"],
          location: { path: "report.md", line: 4 },
        },
      ],
      events: [{ version: 1, type: "generated", actor: "Reviewer", at: 1 }],
      createdAt: 1,
      updatedAt: 2,
    }
    expect(normalizePublicationReview("md", report)).toMatchObject({
      kind: "blocked",
      report: { id: "review_01" },
    })
    expect(normalizePublicationReview("md", { ...report, stale: true })).toMatchObject({
      kind: "stale",
    })
    expect(
      normalizePublicationReview("md", {
        ...report,
        status: "warnings",
        finalized: { actor: "Aayam Bansal", at: 3, artifactHash: "a".repeat(64) },
      }),
    ).toMatchObject({
      kind: "finalized",
      report: { finalized: { actor: "Aayam Bansal" } },
    })
  })
})
