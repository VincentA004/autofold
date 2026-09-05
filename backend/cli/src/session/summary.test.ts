import { describe, expect, test } from "bun:test"
import { SessionSummary } from "./summary"

describe("session summary model routing", () => {
  test("identifies every Autofold auxiliary summary for pinned-model routing", () => {
    expect(SessionSummary.summaryUsesRecordedModel("autofold-campaign-supervisor")).toBeTrue()
    expect(SessionSummary.summaryUsesRecordedModel("autofold-discovery-acquisition")).toBeTrue()
    expect(SessionSummary.summaryUsesRecordedModel("autofold-specialist")).toBeTrue()
    expect(SessionSummary.summaryUsesRecordedModel("autofold-proto-author")).toBeTrue()
    expect(SessionSummary.summaryUsesRecordedModel("autofold-knowledge-review")).toBeTrue()
  })

  test("preserves generic small-model routing for non-Autofold sessions", () => {
    expect(SessionSummary.summaryUsesRecordedModel("title")).toBeFalse()
    expect(SessionSummary.summaryUsesRecordedModel("research")).toBeFalse()
  })
})
