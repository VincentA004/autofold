import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Auth } from "../auth"
import { Global } from "../global"
import { resolveAtlasPackageDir } from "../openscience/atlas-package"
import { BYOK_LLM_ENV_KEYS } from "../openscience/synced-env-policy"

const syncedSecretValues = new Map<string, string>()
const byokSecretValues = new Set<string>()

const TOKEN_SECRET_PATTERNS = [
  /\b(?:thk_|sk-|sk_|gsk_|hf_|nvapi-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]
const QUOTED_SECRET =
  /(\b(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*)(["'])(.*?)\2/gi
const BARE_SECRET =
  /(\b(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*)((?!Bearer\b)[^\s"'[,;}\]]{4,})/gi
const BEARER_SECRET = /(\bBearer\s+)[A-Za-z0-9._~+/-]{4,}=*/gi
const SECRET_FIELD =
  /(^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential|authorization)($|[_-])|^(apiKey|accessToken|refreshToken|authToken|clientSecret|secretKey)$/i

const SAFE_ENV_PREFIXES = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_", "TMPDIR", "XDG_", "EDITOR", "VISUAL"]
const KERNEL_RUNTIME_KEYS = new Set([
  "TMP",
  "TEMP",
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "R_HOME",
  "R_LIBS",
  "R_LIBS_USER",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
])
const SAFE_SYNCED_KEYS = new Set([
  ...BYOK_LLM_ENV_KEYS,
  "TINKER_API_KEY",
  "TINKER_BASE_URL",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "WANDB_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "LAMBDA_API_KEY",
  "LAMBDA_LABS_API_KEY",
  "RUNPOD_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "TENSORPOOL_API_KEY",
  "VAST_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_TRACING",
  "PINECONE_API_KEY",
  "OPENSCIENCE_RUNTIME",
])

const BYOK_SUBPROCESS_PROVIDERS: Record<string, { keys: string[]; baseUrl?: string; publicBaseUrl?: string }> = {
  openai: { keys: ["OPENAI_API_KEY"], baseUrl: "OPENAI_BASE_URL", publicBaseUrl: "https://api.openai.com/v1" },
  anthropic: {
    keys: ["ANTHROPIC_API_KEY"],
    baseUrl: "ANTHROPIC_BASE_URL",
    publicBaseUrl: "https://api.anthropic.com/v1",
  },
  google: {
    keys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"],
    baseUrl: "GOOGLE_GENERATIVE_AI_BASE_URL",
    publicBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  xai: { keys: ["XAI_API_KEY"], baseUrl: "XAI_BASE_URL", publicBaseUrl: "https://api.x.ai/v1" },
  meta: { keys: ["META_MODEL_API_KEY"] },
  openrouter: {
    keys: ["OPENROUTER_API_KEY"],
    baseUrl: "OPENROUTER_BASE_URL",
    publicBaseUrl: "https://openrouter.ai/api/v1",
  },
  togetherai: {
    keys: ["TOGETHER_API_KEY"],
    baseUrl: "TOGETHER_BASE_URL",
    publicBaseUrl: "https://api.together.xyz/v1",
  },
  together: {
    keys: ["TOGETHER_API_KEY"],
    baseUrl: "TOGETHER_BASE_URL",
    publicBaseUrl: "https://api.together.xyz/v1",
  },
  groq: { keys: ["GROQ_API_KEY"], baseUrl: "GROQ_BASE_URL", publicBaseUrl: "https://api.groq.com/openai/v1" },
  "fireworks-ai": {
    keys: ["FIREWORKS_API_KEY"],
    baseUrl: "FIREWORKS_BASE_URL",
    publicBaseUrl: "https://api.fireworks.ai/inference/v1",
  },
  fireworks: {
    keys: ["FIREWORKS_API_KEY"],
    baseUrl: "FIREWORKS_BASE_URL",
    publicBaseUrl: "https://api.fireworks.ai/inference/v1",
  },
  mistral: { keys: ["MISTRAL_API_KEY"], baseUrl: "MISTRAL_BASE_URL", publicBaseUrl: "https://api.mistral.ai/v1" },
  deepseek: { keys: ["DEEPSEEK_API_KEY"], baseUrl: "DEEPSEEK_BASE_URL", publicBaseUrl: "https://api.deepseek.com" },
  cerebras: {
    keys: ["CEREBRAS_API_KEY"],
    baseUrl: "CEREBRAS_BASE_URL",
    publicBaseUrl: "https://api.cerebras.ai/v1",
  },
  perplexity: {
    keys: ["PERPLEXITY_API_KEY"],
    baseUrl: "PERPLEXITY_BASE_URL",
    publicBaseUrl: "https://api.perplexity.ai",
  },
}

function isManagedAtlasKey(value: string): boolean {
  return value.startsWith("thk_")
}

export function syncedConfigDir(): string {
  const config = process.env.OPENSCIENCE_CONFIG_DIR?.trim()
  if (config) return path.resolve(config)
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "openscience")
}

try {
  const raw = readFileSync(path.join(syncedConfigDir(), "synced-env.json"), "utf-8")
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) syncedSecretValues.set(key, value)
    }
  }
} catch {
  // No synced snapshot on disk.
}

let atlasBinDirCache: string | null | undefined

function ensureAtlasBinDir(): string | null {
  if (atlasBinDirCache !== undefined) return atlasBinDirCache
  atlasBinDirCache = null
  const pkgDir = resolveAtlasPackageDir()
  if (!pkgDir) return atlasBinDirCache
  try {
    const nmBin = path.join(pkgDir, "..", "..", ".bin")
    if (existsSync(path.join(nmBin, "atlas")) || existsSync(path.join(nmBin, "atlas.cmd"))) {
      atlasBinDirCache = nmBin
      return atlasBinDirCache
    }
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>
    }
    const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.atlas
    if (!relative) return atlasBinDirCache
    const entry = path.join(pkgDir, relative)
    if (!existsSync(entry)) return atlasBinDirCache
    const launcher = path.join(Global.Path.bin, "atlas")
    const script = `#!/bin/sh\nexec node ${JSON.stringify(entry)} "$@"\n`
    let current = ""
    try {
      current = readFileSync(launcher, "utf8")
    } catch {}
    if (current !== script) writeFileSync(launcher, script, { mode: 0o755 })
    chmodSync(launcher, 0o755)
    atlasBinDirCache = Global.Path.bin
  } catch {}
  return atlasBinDirCache
}

function withAtlasOnPath(env: Record<string, string>): Record<string, string> {
  const dir = ensureAtlasBinDir()
  if (!dir) return env
  const separator = process.platform === "win32" ? ";" : ":"
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === "PATH") ?? "PATH"
  const parts = (env[key] ?? "").split(separator).filter(Boolean)
  if (parts.includes(dir)) return env
  return { ...env, [key]: [dir, ...parts].join(separator) }
}

export namespace RuntimePolicy {
  export function syncedSecretEntries(): IterableIterator<[string, string]> {
    return syncedSecretValues.entries()
  }

  export function setSyncedSecret(key: string, value: string): void {
    syncedSecretValues.set(key, value)
  }

  export function clearSyncedSecrets(): void {
    syncedSecretValues.clear()
  }

  export async function refreshByokSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    try {
      const auth = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
      for (const info of Object.values(auth)) {
        if (info.type !== "api" || !info.key || isManagedAtlasKey(info.key)) continue
        byokSecretValues.add(info.key)
      }
    } catch {}
    for (const key of BYOK_LLM_ENV_KEYS) {
      const value = env[key]
      if (!value || isManagedAtlasKey(value)) continue
      byokSecretValues.add(value)
    }
  }

  export function registerSecretValues(values: Iterable<string>): void {
    for (const value of values) {
      if (!value || value.length < 4 || isManagedAtlasKey(value)) continue
      byokSecretValues.add(value)
    }
  }

  export function redactSecrets(text: string): string {
    let result = text
    for (const value of syncedSecretValues.values()) {
      if (value.length >= 4) result = result.replaceAll(value, "[REDACTED]")
    }
    for (const value of byokSecretValues) {
      if (value.length >= 4) result = result.replaceAll(value, "[REDACTED]")
    }
    for (const pattern of TOKEN_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]")
    result = result.replace(BEARER_SECRET, "$1[REDACTED]")
    result = result.replace(QUOTED_SECRET, "$1$2[REDACTED]$2")
    return result.replace(BARE_SECRET, "$1[REDACTED]")
  }

  export function redactSensitive<T>(value: T): T {
    const visit = (item: unknown, key?: string): unknown => {
      if (typeof item === "string") return key && SECRET_FIELD.test(key) ? "[REDACTED]" : redactSecrets(item)
      if (Array.isArray(item)) return item.map((entry) => visit(entry))
      if (!item || typeof item !== "object") return item
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, entry]) => [name, visit(entry, name)]),
      )
    }
    return visit(value) as T
  }

  export async function scrubSecrets<T>(value: T): Promise<T> {
    await refreshByokSecrets()
    return redactSensitive(value)
  }

  export function isManagedKeyValue(value: string | undefined): boolean {
    return typeof value === "string" && isManagedAtlasKey(value)
  }

  export function isSyncedSecretKey(key: string): boolean {
    return syncedSecretValues.has(key)
  }

  export function isSyncedSecretValue(value: string | undefined): boolean {
    if (!value) return false
    for (const candidate of syncedSecretValues.values()) if (candidate === value) return true
    return false
  }

  export function filterEnvForSubprocess(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (!value || isManagedAtlasKey(value)) continue
      const safe =
        SAFE_ENV_PREFIXES.some((prefix) => (prefix.endsWith("_") ? key.startsWith(prefix) : key === prefix)) ||
        SAFE_SYNCED_KEYS.has(key)
      if (safe || !syncedSecretValues.has(key)) result[key] = value
    }
    return result
  }

  export function filterEnvForKernel(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue
      const runtime =
        SAFE_ENV_PREFIXES.some((prefix) => (prefix.endsWith("_") ? key.startsWith(prefix) : key === prefix)) ||
        KERNEL_RUNTIME_KEYS.has(key)
      if (runtime) result[key] = value
    }
    return result
  }

  export function kernelEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return filterEnvForKernel(env)
  }

  export function kernelSensitivePaths(): string[] {
    return [
      path.join(Global.Path.data, "openscience-session.json"),
      path.join(Global.Path.data, "auth.json"),
      path.join(Global.Path.data, "credentials.json"),
      path.join(Global.Path.data, "mcp-auth.json"),
      path.join(syncedConfigDir(), "synced-env.json"),
      process.env.ATLAS_CLI_CONFIG_PATH || path.join(os.homedir(), ".config", "atlas-cli", "config.json"),
    ]
  }

  export function mergeByokEnv(base: Record<string, string>, auth: Record<string, Auth.Info>): Record<string, string> {
    const result = { ...base }
    for (const [providerID, info] of Object.entries(auth)) {
      if (info.type !== "api" || isManagedAtlasKey(info.key)) continue
      const spec = BYOK_SUBPROCESS_PROVIDERS[providerID]
      if (!spec || spec.keys.some((key) => result[key])) continue
      for (const key of spec.keys) result[key] = info.key
      if (spec.baseUrl && spec.publicBaseUrl) result[spec.baseUrl] = spec.publicBaseUrl
    }
    return result
  }

  export async function subprocessEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    const base = filterEnvForSubprocess(env)
    const auth = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
    return withAtlasOnPath(mergeByokEnv(base, auth))
  }
}
