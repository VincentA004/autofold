import z from "zod"
import { ResearchDomain } from "./domain"

/**
 * Decision-grade audit of the locked objective. Calibration trials never
 * promote an incumbent; they test whether the frozen score orders declared
 * known-positive references ahead of matched known-negative controls.
 */
export namespace EvaluatorCalibration {
  export const CalibrationClass = z.enum(["known_positive", "known_negative", "neutral"])
  export type CalibrationClass = z.infer<typeof CalibrationClass>

  export const Audit = z.object({
    status: z.enum(["unassessed", "preliminary", "supported", "failed"]),
    positiveTrials: z.number().int().nonnegative(),
    negativeTrials: z.number().int().nonnegative(),
    pairwiseAccuracy: z.number().finite().min(0).max(1).nullable(),
    separationMargin: z.number().finite().nullable(),
    direction: z.enum(["minimize", "maximize"]),
    evidenceRefs: z.array(ResearchDomain.EvidenceRef),
    limitations: z.array(z.string()),
  })
  export type Audit = z.infer<typeof Audit>

  export function audit(input: {
    direction: "minimize" | "maximize"
    observations: ResearchDomain.SearchObservation[]
  }): Audit {
    const scored = input.observations.filter((observation) =>
      observation.score !== null && observation.decision !== "failed" && observation.calibrationClass
    )
    const positives = scored.filter((observation) => observation.calibrationClass === "known_positive")
    const negatives = scored.filter((observation) => observation.calibrationClass === "known_negative")
    const pairs = positives.flatMap((positive) => negatives.map((negative) => ({ positive, negative })))
    const wins = pairs.reduce((total, pair) => {
      const positive = pair.positive.score!
      const negative = pair.negative.score!
      if (positive === negative) return total + 0.5
      const ordered = input.direction === "minimize" ? positive < negative : positive > negative
      return total + Number(ordered)
    }, 0)
    const pairwiseAccuracy = pairs.length ? wins / pairs.length : null
    const positiveScores = positives.map((observation) => observation.score!)
    const negativeScores = negatives.map((observation) => observation.score!)
    const separationMargin = positiveScores.length && negativeScores.length
      ? input.direction === "minimize"
        ? Math.min(...negativeScores) - Math.max(...positiveScores)
        : Math.min(...positiveScores) - Math.max(...negativeScores)
      : null
    const enoughReplicates = positives.length >= 2 && negatives.length >= 2
    const status: Audit["status"] = !pairs.length
      ? "unassessed"
      : pairwiseAccuracy! < 0.5 || separationMargin! <= 0
        ? "failed"
        : enoughReplicates && pairwiseAccuracy! >= 0.75
          ? "supported"
          : "preliminary"
    return Audit.parse({
      status,
      positiveTrials: positives.length,
      negativeTrials: negatives.length,
      pairwiseAccuracy,
      separationMargin,
      direction: input.direction,
      evidenceRefs: [...new Set([...positives, ...negatives].flatMap((observation) => [
        observation.trialId,
        observation.runId,
        ...(observation.evaluationId ? [observation.evaluationId] : []),
      ]))],
      limitations: [
        ...(!pairs.length ? ["A matched known-positive and known-negative pair has not been evaluated under this contract."] : []),
        ...(!enoughReplicates ? ["At least two independently recorded trials per calibration class are required for supported calibration."] : []),
        "Calibration establishes ordering under the frozen computational evaluator, not physical binding or specificity.",
      ],
    })
  }
}
