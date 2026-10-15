import {createHash} from "node:crypto"

/** Stable search RNG for one persistent scientist's prospective evaluation slot. */
export function generationSeed(projectId: string, experimentId: string, sessionId: string, ordinal: number): number {
  if (![projectId, experimentId, sessionId].every(value => typeof value === "string" && value.length > 0)) {
    throw new TypeError("Generation seed scope needs project, experiment and session identities")
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new RangeError("Generation seed ordinal must be a positive safe integer")
  const identity = JSON.stringify(["autofold.generation-seed.v1", projectId, experimentId, sessionId, ordinal])
  return createHash("sha256").update(identity).digest().readUInt32BE(0)
}
