#!/usr/bin/env bun

import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { $ } from "bun"

const directory = fileURLToPath(new URL("..", import.meta.url))
// Generated client contracts are checked in. Building never starts a server
// or regenerates those historical contracts from the research API.
await fs.rm(new URL("../dist", import.meta.url), { recursive: true, force: true })
await $`bun tsc --project tsconfig.json`.cwd(directory)
