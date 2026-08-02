// MUST remain first: provider SDKs read these values during module initialization.
import "./openscience/preload-env"

import { parseArgs } from "node:util"
import { resolveNetworkOptions } from "./cli/network"
import { Installation } from "./installation"
import { OpenScience } from "./openscience"
import { Server } from "./server/server"
import { Log } from "./util/log"

const parsed = parseArgs({
  options: {
    port: { type: "string" },
    cors: { type: "string", multiple: true },
    "print-logs": { type: "boolean", default: false },
    "log-level": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
})

const port = parsed.values.port === undefined ? 0 : Number(parsed.values.port)
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid --port value: ${parsed.values.port}`)
}
const level = parsed.values["log-level"]
if (level !== undefined && !["DEBUG", "INFO", "WARN", "ERROR"].includes(level)) {
  throw new Error(`Invalid --log-level value: ${level}`)
}

await Log.init({
  print: parsed.values["print-logs"],
  dev: Installation.isLocal(),
  level: level as "DEBUG" | "INFO" | "WARN" | "ERROR" | undefined,
})

process.env.AGENT = "1"
process.env.OPENSCIENCE = "1" // Compatibility marker consumed by the retained donor runtime.

await OpenScience.refreshIfStale().catch(() => {})
await import("./server/routes/settings/credentials")
  .then((module) => module.applyCredentialEnv())
  .catch(() => {})
await import("./server/routes/settings/compute")
  .then((module) => module.ComputeSettings.applyComputeEnv())
  .catch(() => {})
OpenScience.flushPendingUsage().catch(() => {})

const options = await resolveNetworkOptions({
  port,
  cors: parsed.values.cors ?? [],
})
const server = Server.listen(options)
console.log(`Autofold server listening on http://localhost:${server.port}`)

await new Promise<void>((resolve) => {
  const stop = () => resolve()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
})

const watchdog = setTimeout(() => process.exit(0), 2_000)
watchdog.unref?.()
try {
  await server.stop(true)
} catch {
  // The process is exiting regardless; active SSE connections must not block it.
}
process.exit(0)
