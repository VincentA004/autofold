import type { ResearchState } from "./store"

/** Conservative GPU allocation ledger derived from immutable run/contract identity.
 * Unknown or failed consumption never becomes a free retry. All trial intents,
 * including skill shadow replay, share this admission boundary.
 */
export namespace CampaignResources {
  /** Whole-second authorization: snap binary conversion noise at integer boundaries,
   * round reservations up and grants down. Genuine fractional overruns stay denied. */
  export function gpuSeconds(hours: number, boundary: "reservation" | "grant") {
    const seconds = hours * 3600
    const nearest = Math.round(seconds)
    const normalized = Math.abs(seconds - nearest) <= Number.EPSILON * Math.max(1, Math.abs(seconds)) * 8 ? nearest : seconds
    return boundary === "reservation" ? Math.ceil(normalized) : Math.floor(normalized)
  }
  export function summarize(state: ResearchState, campaignId: string) {
    const entries = Object.values(state.runs).flatMap((run) => {
      const trial = state.trials[run.trialId]
      const experiment = trial && state.experiments[trial.experimentId]
      if (!trial || experiment?.campaignId !== campaignId) return []
      return [{ runId: run.id, trialId: trial.id, intent: trial.intent, status: run.status,
        reservedGpuHours: experiment.contract.budget.gpuHours, reservedGpuSeconds: gpuSeconds(experiment.contract.budget.gpuHours, "reservation") }]
    })
    const allocatedGpuSeconds = entries.reduce((sum, entry) => sum + entry.reservedGpuSeconds, 0)
    const allocatedGpuHours = allocatedGpuSeconds / 3600
    const maximumGpuHours = state.campaignCharters[campaignId]?.constraints.maximumCampaignGpuHours
    const maximumGpuSeconds = maximumGpuHours === undefined ? null : gpuSeconds(maximumGpuHours, "grant")
    const remainingGpuSeconds = maximumGpuSeconds === null ? null : Math.max(0, maximumGpuSeconds - allocatedGpuSeconds)
    return { entries, allocatedGpuHours, maximumGpuHours, allocatedGpuSeconds, maximumGpuSeconds, remainingGpuSeconds,
      remainingGpuHours: remainingGpuSeconds === null ? null : remainingGpuSeconds / 3600,
      accounting: "conservative_frozen_allocations" as const,
      limitation: "Reserved GPU ceilings include uncertain and failed runs; these are not measured utilization or author-model/literature costs.",
    }
  }
}
