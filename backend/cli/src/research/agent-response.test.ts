import { describe, expect, test } from "bun:test"
import { ResearchAgentResponse } from "./agent-response"

describe("research agent response errors", () => {
  test("surfaces nested provider errors instead of continuing with stale artifacts", () => {
    expect(() => ResearchAgentResponse.assert({
      info: {
        role: "assistant",
        error: { name: "UnknownError", data: { message: "provider unavailable" } },
      },
    }, "Proto author")).toThrow("Proto author failed: provider unavailable")
  })

  test("accepts a successful assistant response", () => {
    expect(() => ResearchAgentResponse.assert({ info: { role: "assistant" } }, "Specialist")).not.toThrow()
  })
})
