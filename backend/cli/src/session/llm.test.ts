import { describe, expect, test } from "bun:test"
import { ResearchModel } from "@/research/model"
import { LLM } from "./llm"

describe("LLM output budgets", () => {
  test("does not impose an application output cap on Autofold research agents", () => {
    expect(LLM.shouldCapOutput("autofold-campaign-supervisor")).toBeFalse()
    expect(LLM.shouldCapOutput("autofold-discovery-acquisition")).toBeFalse()
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
        allow_fallbacks: true,
        require_parameters: true,
        ignore: ["phala"],
      },
    })
    expect(LLM.providerRoutingOptions("research", "openrouter")).toEqual({})
    expect(LLM.providerRoutingOptions("autofold-proto-author", "deepseek")).toEqual({})
  })

  test("substitutes the pinned research model for every Autofold or Autofold-originating call", () => {
    expect(LLM.forceAutofoldSelection({
      agent: "autofold-discovery-acquisition",
      originatingAgent: "autofold-discovery-acquisition",
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku-4.5",
    })).toEqual(ResearchModel.DEFAULT)
    expect(LLM.forceAutofoldSelection({
      agent: "autofold-specialist",
      originatingAgent: "autofold-specialist",
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku-4.5",
    })).toEqual(ResearchModel.DEFAULT)
    expect(LLM.forceAutofoldSelection({
      agent: "title",
      originatingAgent: "renamed-campaign-agent",
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku-4.5",
      originatingProviderID: "openrouter",
      originatingModelID: "z-ai/glm-5.3-flash",
    })).toEqual(ResearchModel.DEFAULT)
    expect(LLM.forceAutofoldSelection({
      agent: "autofold-campaign-supervisor",
      originatingAgent: "autofold-campaign-supervisor",
      providerID: "openrouter",
      modelID: "z-ai/glm-5.3-flash",
    })).toEqual(ResearchModel.DEFAULT)
  })

  test("preserves model selection for unrelated sessions", () => {
    expect(LLM.forceAutofoldSelection({
      agent: "title",
      originatingAgent: "research",
      providerID: "openrouter",
      modelID: "anthropic/claude-haiku-4.5",
    })).toEqual({ providerID: "openrouter", modelID: "anthropic/claude-haiku-4.5" })
  })

  test("removes cross-model fallbacks but preserves same-model provider-host routing", () => {
    expect(LLM.forceAutofoldProviderOptions({
      model: "anthropic/claude-haiku-4.5",
      models: ["anthropic/claude-haiku-4.5"],
      fallbacks: ["anthropic/claude-haiku-4.5"],
      provider: { order: ["deepinfra", "deepseek"], allow_fallbacks: true },
      reasoning: { enabled: false },
    })).toEqual({
      provider: { order: ["deepinfra", "deepseek"], allow_fallbacks: true },
      reasoning: { effort: "low" },
      model: "z-ai/glm-5.3-flash",
      models: ["z-ai/glm-5.3-flash"],
    })
  })
})
