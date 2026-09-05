import z from "zod"

export namespace ResearchSearchPolicy {
  export const Move = z.enum([
    "exploit_incumbent_family",
    "explore_generator",
    "workflow_ablation",
    "investigate_predictor_disagreement",
    "reallocate_compute",
  ])
  export type Move = z.infer<typeof Move>

  export const WorkflowVariant = z.enum([
    "full_consensus",
    "predictor_order_permutation",
    "disagreement_gated_resolution",
    "candidate_routing_ablation",
    "compute_rebalanced_consensus",
  ])
  export type WorkflowVariant = z.infer<typeof WorkflowVariant>

  export const GeneratorStrategy = z.enum([
    "incumbent_family",
    "novel_scaffold",
    "sequence_diversity",
    "interface_hotspot",
    "failure_recovery",
  ])
  export type GeneratorStrategy = z.infer<typeof GeneratorStrategy>

  export const GeneratorOutcome = z.object({
    generator: z.string().trim().min(1),
    status: z.enum(["succeeded", "failed"]),
    valid: z.boolean().optional(),
    score: z.number().finite().nullable().optional(),
  })
  export type GeneratorOutcome = z.infer<typeof GeneratorOutcome>

  export const LandscapeArm = z.object({
    generator: z.string().trim().min(1),
    attempts: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    validResults: z.number().int().nonnegative(),
    bestScore: z.number().finite().optional(),
    meanScore: z.number().finite().optional(),
    explorationBonus: z.number().finite().min(0),
    failureRisk: z.number().finite().min(0).max(1),
    acquisitionScore: z.number().finite(),
  })
  export type LandscapeArm = z.infer<typeof LandscapeArm>

  export const Landscape = z.object({
    direction: z.enum(["minimize", "maximize"]),
    totalAttempts: z.number().int().nonnegative(),
    arms: z.array(LandscapeArm),
  })
  export type Landscape = z.infer<typeof Landscape>

  export const Allocation = z.object({
    generator: z.string().trim().min(1),
    maximumCandidates: z.number().int().positive(),
    maximumGpuSeconds: z.number().finite().positive(),
  })
  export type Allocation = z.infer<typeof Allocation>

  export const Policy = z.object({
    move: Move,
    rationale: z.string().trim().min(1).max(4_000),
    // Generator-free negative controls may still describe the workflow
    // ablation being tested. Their canonical allocation is the empty set;
    // optimize moves are checked by the orchestration compiler below.
    preferredGenerators: z.array(z.string().trim().min(1)).max(8).default([]),
    allocations: z.array(Allocation).max(8).default([]),
    targetStage: z.string().trim().min(1).optional(),
    workflowVariant: WorkflowVariant.default("full_consensus"),
    generatorStrategy: GeneratorStrategy.default("incumbent_family"),
  }).superRefine((policy, context) => {
    const preferred = new Set(policy.preferredGenerators)
    const allocated = policy.allocations.map((allocation) => allocation.generator)
    if (preferred.size !== policy.preferredGenerators.length) {
      context.addIssue({ code: "custom", path: ["preferredGenerators"], message: "Search-policy generators must be unique" })
    }
    if (new Set(allocated).size !== allocated.length) {
      context.addIssue({ code: "custom", path: ["allocations"], message: "Search-policy allocations must be unique" })
    }
    if (allocated.some((generator) => !preferred.has(generator)) || allocated.length !== preferred.size) {
      context.addIssue({ code: "custom", path: ["allocations"], message: "Every preferred generator requires exactly one allocation" })
    }
  })
  export type Policy = z.infer<typeof Policy>

  export function allocate(
    generators: string[],
    maximumCandidates: number,
    maximumGpuSeconds: number,
  ): Allocation[] {
    const selected = [...new Set(generators)].slice(0, Math.max(1, maximumCandidates))
    if (!selected.length) return []
    const baseCandidates = Math.floor(maximumCandidates / selected.length)
    const remainderCandidates = maximumCandidates % selected.length
    const baseGpuSeconds = maximumGpuSeconds / selected.length
    return selected.map((generator, index) => ({
      generator,
      maximumCandidates: baseCandidates + (index < remainderCandidates ? 1 : 0),
      maximumGpuSeconds: baseGpuSeconds,
    }))
  }

  export function landscape(input: {
    availableGenerators: string[]
    direction?: "minimize" | "maximize"
    outcomes?: GeneratorOutcome[]
  }): Landscape {
    const direction = input.direction ?? "minimize"
    const outcomes = input.outcomes ?? []
    const available = [...new Set(input.availableGenerators)]
    const raw = available.map((generator) => {
      const arm = outcomes.filter((outcome) => outcome.generator === generator)
      const scores = arm.flatMap((outcome) => outcome.status === "succeeded" && outcome.valid && outcome.score != null
        ? [outcome.score]
        : [])
      const failures = arm.filter((outcome) => outcome.status === "failed").length
      return {
        generator,
        attempts: arm.length,
        successes: arm.length - failures,
        failures,
        validResults: scores.length,
        bestScore: scores.length ? direction === "minimize" ? Math.min(...scores) : Math.max(...scores) : undefined,
        meanScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined,
        explorationBonus: 1 / Math.sqrt(arm.length + 1),
        failureRisk: arm.length ? failures / arm.length : 0,
      }
    })
    const rankedObserved = raw
      .filter((arm) => arm.bestScore !== undefined)
      .toSorted((left, right) => direction === "minimize"
        ? left.bestScore! - right.bestScore!
        : right.bestScore! - left.bestScore!)
    const quality = new Map(rankedObserved.map((arm, index) => [
      arm.generator,
      rankedObserved.length === 1 ? 1 : 1 - index / (rankedObserved.length - 1),
    ]))
    return Landscape.parse({
      direction,
      totalAttempts: outcomes.length,
      arms: raw.map((arm) => ({
        ...arm,
        acquisitionScore: arm.explorationBonus + (quality.get(arm.generator) ?? 0) * 0.35 - arm.failureRisk * 0.5,
      })).toSorted((left, right) => right.acquisitionScore - left.acquisitionScore),
    })
  }

  export function derive(input: {
    iteration: number
    availableGenerators: string[]
    usedGenerators: string[]
    candidateBudget: number
    generationGpuSeconds: number
    predictorDisagreement: boolean
    direction?: "minimize" | "maximize"
    outcomes?: GeneratorOutcome[]
  }): Policy {
    const available = [...new Set(input.availableGenerators)]
    if (!available.length) throw new Error("No execution-ready binder generator is available")
    const used = new Set(input.usedGenerators)
    const outcomes = input.outcomes ?? []
    const observed = new Set(outcomes.map((outcome) => outcome.generator))
    const unexplored = available.filter((generator) => !used.has(generator) && !observed.has(generator))
    const statistics = new Map(available.map((generator) => {
      const arm = outcomes.filter((outcome) => outcome.generator === generator)
      const scores = arm.flatMap((outcome) => outcome.status === "succeeded" && outcome.valid && outcome.score !== null && outcome.score !== undefined
        ? [outcome.score]
        : [])
      const direction = input.direction ?? "minimize"
      const bestScore = scores.length
        ? direction === "minimize" ? Math.min(...scores) : Math.max(...scores)
        : undefined
      return [generator, {
        attempts: arm.length,
        failures: arm.filter((outcome) => outcome.status === "failed").length,
        bestScore,
      }] as const
    }))
    const ranked = available.toSorted((left, right) => {
      const leftStats = statistics.get(left)!
      const rightStats = statistics.get(right)!
      if (leftStats.bestScore !== undefined && rightStats.bestScore !== undefined) {
        return (input.direction ?? "minimize") === "minimize"
          ? leftStats.bestScore - rightStats.bestScore
          : rightStats.bestScore - leftStats.bestScore
      }
      if (leftStats.bestScore !== undefined) return -1
      if (rightStats.bestScore !== undefined) return 1
      if (leftStats.failures !== rightStats.failures) return leftStats.failures - rightStats.failures
      if (leftStats.attempts !== rightStats.attempts) return leftStats.attempts - rightStats.attempts
      return available.indexOf(left) - available.indexOf(right)
    })
    const empiricalBest = ranked[0]!
    let move: Move
    let selected: string[]
    let rationale: string
    let targetStage: string | undefined
    let workflowVariant: WorkflowVariant
    let generatorStrategy: GeneratorStrategy
    if (unexplored.length) {
      move = "explore_generator"
      selected = unexplored.slice(0, Math.min(unexplored.length, input.candidateBudget))
      workflowVariant = "full_consensus"
      generatorStrategy = "novel_scaffold"
      rationale = selected.length === 1
        ? `Explore the untested ${selected[0]} generator under an explicit frozen allocation.`
        : `Compare untested generator arms ${selected.join(", ")} in one frozen candidate portfolio.`
    } else if (input.predictorDisagreement) {
      move = "investigate_predictor_disagreement"
      selected = [empiricalBest]
      targetStage = "independent"
      workflowVariant = "disagreement_gated_resolution"
      generatorStrategy = "interface_hotspot"
      rationale = `Use the best-supported ${empiricalBest} arm while isolating the largest independent-predictor disagreement.`
    } else if (available.length > 1 && input.candidateBudget > 1 && input.iteration % 3 === 0) {
      move = "reallocate_compute"
      selected = ranked.slice(0, Math.min(available.length, input.candidateBudget))
      workflowVariant = "compute_rebalanced_consensus"
      generatorStrategy = "sequence_diversity"
      rationale = "Allocate a candidate to each empirically ranked generator arm, then spend remaining candidates and compute on the best observed arms."
    } else if (input.iteration % 4 === 0) {
      move = "workflow_ablation"
      selected = [empiricalBest]
      targetStage = "resolution"
      workflowVariant = input.iteration % 8 === 0 ? "candidate_routing_ablation" : "predictor_order_permutation"
      generatorStrategy = "incumbent_family"
      rationale = `Hold ${empiricalBest} stable and permute one validation/routing axis to measure its marginal information value.`
    } else {
      move = "exploit_incumbent_family"
      selected = [empiricalBest]
      workflowVariant = "full_consensus"
      generatorStrategy = statistics.get(empiricalBest)!.failures > 0 ? "failure_recovery" : "incumbent_family"
      rationale = `Exploit the empirically best ${empiricalBest} arm with one falsifiable sequence or configuration delta.`
    }
    return Policy.parse({
      move,
      rationale,
      preferredGenerators: selected,
      allocations: allocate(selected, input.candidateBudget, input.generationGpuSeconds),
      targetStage,
      workflowVariant,
      generatorStrategy,
    })
  }
}
