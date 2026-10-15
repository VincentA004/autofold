import type { CapabilityRequest, HostCapabilities } from "./capabilities"

export class ReceiptUnresolvedError extends Error {
  readonly effectState = "unresolved" as const
  constructor(readonly runId: string, detail = "Dispatch may have started; reconcile this run before retrying") {
    super(`Execution receipt unresolved for ${runId}: ${detail}`)
    this.name = "ReceiptUnresolvedError"
  }
}
export class ExecutionCancelledError extends Error {
  constructor() { super("Scientific worker cancelled by host"); this.name = "ExecutionCancelledError" }
}
export interface Dispatch {
  /** Exact host runtime paths captured with the original request, never current defaults. */
  transportProfile?: unknown
  requireOriginalProfile?: boolean
  runtimeEnvironment?: Record<string, string>
  runId: string
  requestId: string
  command: readonly string[]
  workspace: string
  bundlePath: string
  outputPath: string
  timeoutMs: number
  /** Original grant ceiling, frozen with process intent; never rebased on recovery. */
  authorizationDeadlineMs?: number
  /** Trusted frozen worker identity, including receipt recovery after a host upgrade. */
  workerHash?: string
  /** Every transport must call this immediately before its first scientific launch. */
  /** Frozen host protocol proves a missing host attempt means no SSH launch was attempted. */
  allowFirstRemoteLaunch?: boolean
  authorizeStart?: () => Promise<void>
  signal?: AbortSignal
  /** Call only after durable confirmation that the same runId was launched. */
  onStarted?: () => Promise<void>
}
export type TransportCompletion = {status: "succeeded" | "failed" | "cancelled" | "pending"; error?: string}
/** A host transport must deduplicate runId itself and retrieve artifacts before reporting success.
 * Transport errors after dispatch are ambiguous and must use ReceiptUnresolvedError.
 */
export interface ExecutionTransport {
  kind: "local" | "remote"
  snapshotProfile?(): unknown
  /** Read-only inventory before admission/model inference; never stages or launches compute. */
  capabilities?(input: CapabilityRequest): Promise<HostCapabilities>
  /** Validate exact generator payloads with trusted stdlib worker bytes; never executes authored code. */
  validateGeneratorSpecs?(input: {source: string; request: unknown; signal?: AbortSignal}): Promise<void>
  /** Replay-safe readiness/staging only. Must never launch scientific compute. */
  preflight?(input: Dispatch): Promise<void>
  dispatch(input: Dispatch): Promise<TransportCompletion>
  reconcile?(input: Dispatch): Promise<TransportCompletion>
}

export {DurableLocalTransport as LocalWorkerTransport} from "./local"
