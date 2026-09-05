import { afterEach, describe, expect, test } from "bun:test"
import { ResearchModel } from "./model"

const previous = process.env.AUTOFOLD_RESEARCH_MODEL

afterEach(() => {
  if (previous === undefined) delete process.env.AUTOFOLD_RESEARCH_MODEL
  else process.env.AUTOFOLD_RESEARCH_MODEL = previous
})

describe("research model selection", () => {
  test("defaults to the pinned Autofold GLM worker rather than a parent-session model", () => {
    delete process.env.AUTOFOLD_RESEARCH_MODEL
    expect(ResearchModel.select()).toEqual({
      providerID: "openrouter",
      modelID: "z-ai/glm-5.3-flash",
    })
  })

  test("keeps the pinned GLM model when the override agrees", () => {
    process.env.AUTOFOLD_RESEARCH_MODEL = "openrouter:z-ai/glm-5.3-flash"
    expect(ResearchModel.select()).toEqual({
      providerID: "openrouter",
      modelID: "z-ai/glm-5.3-flash",
    })
  })

  test("silently replaces a non-GLM research override", () => {
    process.env.AUTOFOLD_RESEARCH_MODEL = "openrouter:anthropic/claude-haiku-4.5"
    expect(ResearchModel.select()).toEqual(ResearchModel.DEFAULT)
  })

  test("ignores malformed overrides rather than failing the campaign", () => {
    process.env.AUTOFOLD_RESEARCH_MODEL = "openrouter"
    expect(ResearchModel.select()).toEqual(ResearchModel.DEFAULT)
  })
})
