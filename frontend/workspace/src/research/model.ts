import type { Evaluation, Experiment, ExperimentHistory, Run, Trial, TrialStatus } from "./api"

export type LedgerTone = "active" | "pending" | "error" | "done" | "muted"

export function statusTone(status: TrialStatus | Run["status"]): LedgerTone {
  if (status === "failed" || status === "cancelled") return "error"
  if (status === "running" || status === "evaluating") return "active"
  if (status === "queued" || status === "proposed") return "pending"
  if (status === "succeeded") return "done"
  return "muted"
}

export function evaluationFor(history: ExperimentHistory | undefined, trialId: string): Evaluation | undefined {
  return history?.evaluations.find((evaluation) => evaluation.trialId === trialId)
}

export function runFor(history: ExperimentHistory | undefined, trialId: string): Run | undefined {
  return history?.runs.findLast((run) => run.trialId === trialId)
}

export function promotionLabel(experiment: Experiment, trial: Trial, evaluation?: Evaluation): string {
  if (!evaluation) return "not evaluated"
  if (!evaluation.valid) return "invalid result"
  if (experiment.incumbentTrialId === trial.id) return "promoted incumbent"
  return "incumbent retained"
}

export interface CandidateSummary {
  count?: number
  uniqueFraction?: number
  bestScore?: number
}

export function candidateSummary(evaluation?: Evaluation): CandidateSummary {
  if (!evaluation) return {}
  return {
    count: evaluation.diagnostics.candidate_count,
    uniqueFraction: evaluation.diagnostics.unique_fraction,
    bestScore: evaluation.diagnostics.best_candidate_score,
  }
}

export function shortDigest(value?: string): string {
  if (!value) return "—"
  return value.length > 19 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value
}

export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return "—"
  return Number.isInteger(score) ? String(score) : score.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "")
}
