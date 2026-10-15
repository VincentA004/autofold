import {expect, spyOn, test} from "bun:test"
import {withExecutionDeadline} from "./authority"
import type {Dispatch, ExecutionTransport} from "./transport"

function input(extra: Partial<Dispatch> = {}): Dispatch {
  return {runId: "run_original", requestId: "request_original", command: [], workspace: "/tmp", bundlePath: "/tmp/bundle", outputPath: "/tmp/output", timeoutMs: 1000, ...extra}
}
class CompleteTransport implements ExecutionTransport {
  #identity = "original"
  kind = "remote" as const
  calls: Dispatch[] = []
  async capabilities() { return {format: "autofold.host-capabilities.v1" as const, host: this.#identity, checkedAt: "fixture", runtime: [], generators: []} }
  async validateGeneratorSpecs(request: {source: string; request: unknown}) {expect(this.#identity).toBe("original"); expect(request.request).toEqual({exact: true})}
  futureHook() {return this.#identity}
  async preflight(request: Dispatch) {expect(this.#identity).toBe("original"); this.calls.push(request)}
  async dispatch(request: Dispatch) {expect(this.#identity).toBe("original"); await request.authorizeStart?.(); this.calls.push(request); return {status: "succeeded" as const}}
  async reconcile(request: Dispatch) {expect(this.#identity).toBe("original"); this.calls.push(request); return {status: "succeeded" as const}}
}

test("deadline scope forwards exact generator preflight, inventory and future methods with private receiver", async () => {
  const original = Object.freeze(new CompleteTransport()), deadline = Date.now() + 60000
  const scoped = withExecutionDeadline(original, deadline)
  expect(scoped.kind).toBe("remote")
  expect((await scoped.capabilities()).host).toBe("original")
  await scoped.validateGeneratorSpecs({source: "trusted worker", request: {exact: true}})
  expect(scoped.futureHook()).toBe("original")
  const request = input({authorizationDeadlineMs: deadline - 5000})
  await scoped.preflight(request); await scoped.dispatch(request)
  expect(original.calls.map(call => call.authorizationDeadlineMs)).toEqual([deadline - 5000, deadline - 5000])
  expect(request.authorizeStart).toBeUndefined()
  await scoped.dispatch(input({authorizationDeadlineMs: deadline + 5000}))
  expect(original.calls.at(-1)!.authorizationDeadlineMs).toBe(deadline)
})

test("expiry denies fresh dispatch and delayed first launch but permits original receipt observation", async () => {
  const original = new CompleteTransport(), scoped = withExecutionDeadline(original, 1)
  await expect(scoped.dispatch(input())).rejects.toThrow("deadline expired")
  expect(original.calls).toHaveLength(0)
  await scoped.reconcile(input({allowFirstRemoteLaunch: false}))
  expect(original.calls[0]!.authorizeStart).toBeUndefined()
  expect(original.calls[0]!.allowFirstRemoteLaunch).toBe(false)
  let authorize = 0
  await scoped.reconcile(input({authorizeStart: async () => {authorize++}}))
  await expect(original.calls[1]!.authorizeStart!()).rejects.toThrow("deadline expired")
  expect(authorize).toBe(0)
  const deadline = Date.now() + 30000, live = withExecutionDeadline(original, deadline)
  await expect(live.dispatch(input({authorizeStart: async () => {throw new Error("Lease lost")}}))).rejects.toThrow("Lease lost")
  const aborted = AbortSignal.abort(new Error("Cancelled"))
  await expect(live.dispatch(input({signal: aborted}))).rejects.toThrow("Cancelled")
})

test("host authorization callback cannot cross the absolute deadline", async () => {
  const original = new CompleteTransport(), deadline = 10001
  let now = 10000, authorizations = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const scoped = withExecutionDeadline(original, deadline)
    await expect(scoped.dispatch(input({authorizeStart: async () => {authorizations++; now = deadline}}))).rejects.toThrow("deadline expired")
    expect(authorizations).toBe(1)
    expect(original.calls).toHaveLength(0)
  } finally {clock.mockRestore()}
})

test("optional hooks stay absent and invalid deadline configuration fails immediately", () => {
  const original: ExecutionTransport = {kind: "local", dispatch: async () => ({status: "succeeded"})}
  const scoped = withExecutionDeadline(original, Date.now() + 1000)
  expect(scoped.capabilities).toBeUndefined(); expect(scoped.validateGeneratorSpecs).toBeUndefined()
  expect(scoped.preflight).toBeUndefined(); expect(scoped.reconcile).toBeUndefined()
  for (const deadline of [NaN, Infinity, 0, -1, 1.5]) expect(() => withExecutionDeadline(original, deadline)).toThrow("Execution deadline")
})
