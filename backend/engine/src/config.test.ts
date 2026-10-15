import {afterEach, expect, test} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {loadExecutionConfig} from "./config"
const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
test("host execution config preserves an absolute deadline and rejects invalid grants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-grant-")); roots.push(root)
  const file = path.join(root, "execution.json")
  const authorization = {localProto: true, maximumGpuSeconds: 0, maximumCandidates: 1, maximumWallTimeMinutes: 1, deadlineMs: Date.now() + 60000}
  await fs.writeFile(file, JSON.stringify({authorization}))
  expect((await loadExecutionConfig(file))!.authorization!.deadlineMs).toBe(authorization.deadlineMs)
  for (const deadlineMs of [0, -1, 1.5, "tomorrow"]) {
    await fs.writeFile(file, JSON.stringify({authorization: {...authorization, deadlineMs}}))
    await expect(loadExecutionConfig(file)).rejects.toThrow()
  }
})
