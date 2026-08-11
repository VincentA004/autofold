import { afterEach, describe, expect, test } from "bun:test"
import { ResearchModel } from "./model"

const previous = process.env.AUTOFOLD_RESEARCH_MODEL

afterEach(() => {
  if (previous === undefined) delete process.env.AUTOFOLD_RESEARCH_MODEL
  else process.env.AUTOFOLD_RESEARCH_MODEL = previous
})

describe("research model selection", () => {
  test("defaults to the Autofold DeepSeek worker rather than a parent-session model", () => {
    delete process.env.AUTOFOLD_RESEARCH_MODEL
    expect(ResearchModel.select()).toEqual({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731",
    })
  })

  test("uses an explicit provider:model operator override", () => {
    process.env.AUTOFOLD_RESEARCH_MODEL = "openrouter:openai/gpt-oss-120b"
    expect(ResearchModel.select()).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-oss-120b",
    })
  })

  test("rejects malformed overrides", () => {
    process.env.AUTOFOLD_RESEARCH_MODEL = "openrouter"
    expect(() => ResearchModel.select()).toThrow("provider:model")
  })
})
