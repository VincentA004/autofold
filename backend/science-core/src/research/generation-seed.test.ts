import {expect, test} from "bun:test"
import {generationSeed} from "./generation-seed"

test("generation seeds are stable within an authoring slot and isolated by identity and ordinal", () => {
  const seed = generationSeed("project-a", "exp-a", "ses-a", 1)
  expect(generationSeed("project-a", "exp-a", "ses-a", 1)).toBe(seed)
  expect(generationSeed("project-b", "exp-a", "ses-a", 1)).not.toBe(seed)
  expect(generationSeed("project-a", "exp-b", "ses-a", 1)).not.toBe(seed)
  expect(generationSeed("project-a", "exp-a", "ses-b", 1)).not.toBe(seed)
  expect(generationSeed("project-a", "exp-a", "ses-a", 2)).not.toBe(seed)
  expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff).toBe(true)
})

test("generation seed rejects invalid ordinals", () => {
  expect(() => generationSeed("project", "exp", "session", 0)).toThrow()
  expect(() => generationSeed("project", "exp", "session", 1.5)).toThrow()
})
