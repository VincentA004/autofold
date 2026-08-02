import { afterEach, describe, expect, test } from "bun:test"
import { RuntimePolicy } from "./runtime-policy"

const originalAtlasConfig = process.env.ATLAS_CLI_CONFIG_PATH

afterEach(() => {
  if (originalAtlasConfig === undefined) delete process.env.ATLAS_CLI_CONFIG_PATH
  else process.env.ATLAS_CLI_CONFIG_PATH = originalAtlasConfig
})

describe("RuntimePolicy", () => {
  test("redacts registered values, token patterns, and credential-shaped fields", () => {
    RuntimePolicy.registerSecretValues(["private-value-123"])

    expect(RuntimePolicy.redactSecrets("value=private-value-123 Bearer token-1234 sk-abcdefghijk")).toBe(
      "value=[REDACTED] Bearer [REDACTED] [REDACTED]",
    )
    expect(
      RuntimePolicy.redactSensitive({
        nested: { api_key: "plain-value", note: "authorization=hidden-value" },
      }),
    ).toEqual({ nested: { api_key: "[REDACTED]", note: "authorization=[REDACTED]" } })
  })

  test("filters managed tokens while preserving ordinary subprocess variables", () => {
    expect(
      RuntimePolicy.filterEnvForSubprocess({
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        ORDINARY_SETTING: "present",
        MANAGED_TOKEN: "thk_managed-secret",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/tmp/home", ORDINARY_SETTING: "present" })
  })

  test("merges user BYOK credentials without overriding explicit environment", () => {
    const auth = {
      openai: { type: "api" as const, key: "user-openai-key" },
      anthropic: { type: "api" as const, key: "thk_managed-secret" },
    }

    expect(RuntimePolicy.mergeByokEnv({}, auth)).toEqual({
      OPENAI_API_KEY: "user-openai-key",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
    })
    expect(RuntimePolicy.mergeByokEnv({ OPENAI_API_KEY: "shell-key" }, auth)).toEqual({
      OPENAI_API_KEY: "shell-key",
    })
  })

  test("includes the configured Atlas credential path in sandbox exclusions", () => {
    process.env.ATLAS_CLI_CONFIG_PATH = "/tmp/custom-atlas-config.json"
    expect(RuntimePolicy.kernelSensitivePaths()).toContain("/tmp/custom-atlas-config.json")
  })
})
