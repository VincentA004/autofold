import { describe, expect, test } from "bun:test"
import { LLM } from "./llm"

describe("LLM output budgets", () => {
  test("does not impose an application output cap on Autofold research agents", () => {
    expect(LLM.shouldCapOutput("autofold-campaign-supervisor")).toBeFalse()
    expect(LLM.shouldCapOutput("autofold-knowledge-review")).toBeFalse()
    expect(LLM.shouldCapOutput("autofold-proto-author")).toBeFalse()
  })

  test("preserves the interactive runtime output setting", () => {
    expect(LLM.shouldCapOutput("research")).toBeTrue()
    expect(LLM.outputTokenLimit("research")).toBe(LLM.OUTPUT_TOKEN_MAX)
  })

  test("routes Autofold OpenRouter work away from the unavailable Phala endpoint", () => {
    expect(LLM.providerRoutingOptions("autofold-proto-author", "openrouter")).toEqual({
      provider: {
        order: ["deepinfra", "deepseek", "fireworks", "together"],
        allow_fallbacks: true,
        require_parameters: true,
        ignore: ["phala"],
      },
    })
    expect(LLM.providerRoutingOptions("research", "openrouter")).toEqual({})
    expect(LLM.providerRoutingOptions("autofold-proto-author", "deepseek")).toEqual({})
  })
})
