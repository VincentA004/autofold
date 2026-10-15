import type { TrialReasoning } from "./trial-reasoning"

/** Complete coverage beside bounded display samples. Never participates in scoring. */
export namespace EvidenceView {
  export interface Decision {
    candidateId?: string
    stage?: string
    modelId: string
    seed: number
    status: "completed" | "skipped"
    metrics?: Record<string, unknown>
  }
  export function coverage(items: readonly Decision[]) {
    const groups = new Map<string, { stage?: string; modelId: string; seed: number; completed: number; skipped: number; candidateIds: string[] }>()
    const identities = new Set<string>()
    const duplicates: string[] = []
    for (const item of items) {
      const key = JSON.stringify([item.stage ?? null, item.modelId, item.seed])
      const group = groups.get(key) ?? { stage: item.stage, modelId: item.modelId, seed: item.seed, completed: 0, skipped: 0, candidateIds: [] }
      group[item.status]++
      if (item.candidateId !== undefined) {
        const identity = JSON.stringify([item.candidateId, key])
        if (identities.has(identity)) duplicates.push(identity)
        identities.add(identity)
        group.candidateIds.push(item.candidateId)
      }
      groups.set(key, group)
    }
    return { total: items.length, groups: [...groups.values()], duplicateDecisions: duplicates }
  }
  export function sample<T extends Decision>(items: readonly T[], limit: number, fullEvidencePath: string) {
    // Round-robin across stage/model/seed; a new diagnostic cannot hide a scoring lane.
    const groups = new Map<string, T[]>()
    for (const item of items) {
      const key = JSON.stringify([item.stage ?? null, item.modelId, item.seed])
      const group = groups.get(key) ?? []
      group.push(item); groups.set(key, group)
    }
    const selected: T[] = []
    for (let row = 0; selected.length < limit; row++) {
      let found = false
      for (const group of groups.values()) {
        if (group[row] && selected.length < limit) { selected.push(group[row]); found = true }
      }
      if (!found) break
    }
    return { items: selected, coverage: coverage(items), shown: selected.length,
      omitted: items.length - selected.length, fullEvidencePath }
  }
  export function path(runId: string) {
    if (!/^run_[a-zA-Z0-9]+$/.test(runId)) throw new Error("Invalid evidence run ID")
    return `.autofold/runs/${runId}/output`
  }
  function averageRanks(values: readonly number[]) {
    const ranks = Array<number>(values.length)
    const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
    for (let start = 0; start < ordered.length;) {
      let end = start + 1
      while (end < ordered.length && ordered[end]!.value === ordered[start]!.value) end++
      const rank = (start + 1 + end) / 2
      for (let index = start; index < end; index++) ranks[ordered[index]!.index] = rank
      start = end
    }
    return ranks
  }
  function tiedCandidateCount(values: readonly number[]) {
    const counts = new Map<number, number>()
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
    return [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0)
  }
  function spearman(left: readonly number[], right: readonly number[]) {
    if (left.length < 2) return { spearman: null, reason: "insufficient_candidates" as const }
    const leftRanks = averageRanks(left), rightRanks = averageRanks(right)
    const leftMean = leftRanks.reduce((sum, value) => sum + value, 0) / leftRanks.length
    const rightMean = rightRanks.reduce((sum, value) => sum + value, 0) / rightRanks.length
    const numerator = leftRanks.reduce((sum, value, index) => sum + (value - leftMean) * (rightRanks[index]! - rightMean), 0)
    const denominator = Math.sqrt(
      leftRanks.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) *
      rightRanks.reduce((sum, value) => sum + (value - rightMean) ** 2, 0),
    )
    return denominator === 0
      ? { spearman: null, reason: "constant_rank" as const }
      : { spearman: numerator / denominator, reason: null }
  }
  /**
   * Deterministic, bounded identity join for scientist decisions. Raw metric
   * values remain descriptive: rank 1 is the largest raw value and does not
   * imply that a metric is an objective or that larger is biologically better.
   */
  export function candidateTable(
    items: readonly Decision[],
    candidates: readonly unknown[] = [],
    limits: { candidates?: number; metricsPerGroup?: number; contrasts?: number } = {},
  ) {
    paired(items) // Reject duplicate candidate/stage/model/seed identities.
    const maximumCandidates = limits.candidates ?? 12
    const maximumMetrics = limits.metricsPerGroup ?? 4
    const maximumContrasts = limits.contrasts ?? 72
    const identity = new Map(candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
      const value = candidate as Record<string, unknown>
      return typeof value.id === "string"
        ? [[value.id, { sequence: typeof value.sequence === "string" ? value.sequence : undefined }] as const]
        : []
    }))
    const candidateIds = [...new Set(items.flatMap((item) => item.candidateId ?? []))].sort()
    const selectedCandidates = candidateIds.slice(0, maximumCandidates)
    const groupKeys = [...new Set(items.map((item) => JSON.stringify([item.stage ?? null, item.modelId])))].sort()
    const rows: Array<{
      candidateId: string
      sequence?: string
      stage?: string
      modelId: string
      metrics: Record<string, { values: Array<{ seed: number; value: number }>; seedMean: number | null; rank: number | null }>
    }> = []
    const contrasts: Array<{
      stage?: string
      modelId: string
      metric: string
      leftCandidateId: string
      rightCandidateId: string
      seedMeanDifference: number
      pairedCount: number
      pairedMeanDifference: number | null
      bySeed: Array<{ seed: number; difference: number }>
    }> = []
    for (const key of groupKeys) {
      const records = items.filter((item) => JSON.stringify([item.stage ?? null, item.modelId]) === key)
      const primary = records.flatMap((item) => typeof item.metrics?.primary_metric === "string" ? [item.metrics.primary_metric] : [])
      const available = [...new Set(records.flatMap((item) => Object.entries(item.metrics ?? {}).flatMap(([metric, value]) =>
        typeof value === "number" && Number.isFinite(value) ? [metric] : [])))].sort()
      const metrics = [...new Set([...primary, ...["confidence_score", "iptm"].filter((metric) => available.includes(metric)), ...available])]
        .filter((metric) => available.includes(metric)).slice(0, maximumMetrics)
      const [stage, modelId] = JSON.parse(key) as [string | null, string]
      const groupRows = selectedCandidates.map((candidateId) => {
        const values = Object.fromEntries(metrics.map((metric) => {
          const perSeed = records.filter((item) => item.candidateId === candidateId && item.status === "completed")
            .flatMap((item) => {
              const value = item.metrics?.[metric]
              return typeof value === "number" && Number.isFinite(value) ? [{ seed: item.seed, value }] : []
            }).sort((left, right) => left.seed - right.seed)
          return [metric, { values: perSeed, seedMean: perSeed.length
            ? perSeed.reduce((sum, value) => sum + value.value, 0) / perSeed.length : null, rank: null as number | null }]
        }))
        return { candidateId, sequence: identity.get(candidateId)?.sequence,
          ...(stage === null ? {} : { stage }), modelId, metrics: values }
      })
      for (const metric of metrics) {
        const complete = groupRows.filter((row) => row.metrics[metric]?.seedMean !== null)
          .sort((left, right) => right.metrics[metric]!.seedMean! - left.metrics[metric]!.seedMean! || left.candidateId.localeCompare(right.candidateId))
        for (let start = 0; start < complete.length;) {
          let end = start + 1
          while (end < complete.length && complete[end]!.metrics[metric]!.seedMean === complete[start]!.metrics[metric]!.seedMean) end++
          const rank = (start + 1 + end) / 2
          for (let index = start; index < end; index++) complete[index]!.metrics[metric]!.rank = rank
          start = end
        }
        for (let leftIndex = 0; leftIndex < complete.length && contrasts.length < maximumContrasts; leftIndex++) {
          for (let rightIndex = leftIndex + 1; rightIndex < complete.length && contrasts.length < maximumContrasts; rightIndex++) {
            const left = complete[leftIndex]!, right = complete[rightIndex]!
            const rightBySeed = new Map(right.metrics[metric]!.values.map((value) => [value.seed, value.value]))
            const bySeed = left.metrics[metric]!.values.flatMap((value) => {
              const other = rightBySeed.get(value.seed)
              return other === undefined ? [] : [{ seed: value.seed, difference: value.value - other }]
            })
            contrasts.push({ ...(stage === null ? {} : { stage }), modelId, metric,
              leftCandidateId: left.candidateId, rightCandidateId: right.candidateId,
              seedMeanDifference: left.metrics[metric]!.seedMean! - right.metrics[metric]!.seedMean!,
              pairedCount: bySeed.length,
              pairedMeanDifference: bySeed.length ? bySeed.reduce((sum, value) => sum + value.difference, 0) / bySeed.length : null,
              bySeed })
          }
        }
      }
      rows.push(...groupRows)
    }
    const scoringInputs = candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
      const value=candidate as Record<string,unknown>
      if (typeof value.id !== "string" || !selectedCandidates.includes(value.id) || !value.evidence || typeof value.evidence !== "object") return []
      const evidence=value.evidence as Record<string,unknown>
      return [{candidateId:value.id, sequence:typeof value.sequence === "string" ? value.sequence : undefined,
        evidence:Object.fromEntries(["interfaceConfidence","foldConfidence","predictorAgreement","solubility","aggregationRisk","synthesisRisk"]
          .flatMap(key => typeof evidence[key] === "number" && Number.isFinite(evidence[key]) ? [[key,evidence[key]]] : []))}]
    })
    return {
      rows,
      contrasts,
      scoringInputs,
      scoringScope:"Recorded candidate-level inputs to the frozen panel evaluator, not a new score or biological measurements. Raw model confidence alone is not the locked objective; panel selection, diversity and yield also matter.",
      expectedCandidates: candidateIds.length,
      shownCandidates: selectedCandidates.length,
      omittedCandidates: candidateIds.length - selectedCandidates.length,
      ranking: "rank 1 is largest raw seed mean among shown candidates; descriptive only",
      contrast: "seedMeanDifference compares independently available seed means; pairedMeanDifference is left minus right on matching seeds only",
    }
  }
  /** Deterministic descriptive statistics, never an evaluator or causal test. */
  export function summary(items: readonly Decision[], candidates: readonly unknown[] = []) {
    const table = paired(items) // Reject duplicate identities before counting.
    const numeric = (item: Decision) => Object.entries(item.metrics ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    const stats = (values: number[]) => ({ count: values.length,
      mean: values.length ? values.reduce((a,b) => a+b, 0) / values.length : null,
      sampleStandardDeviation: values.length > 1 ? Math.sqrt(values.reduce((sum,v) => sum + (v-values.reduce((a,b)=>a+b,0)/values.length)**2,0)/(values.length-1)) : null,
      minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null })
    const groups = [...new Set(items.map(x => JSON.stringify([x.stage ?? null, x.modelId])))].map(key => {
      const records = items.filter(x => JSON.stringify([x.stage ?? null, x.modelId]) === key)
      const completed = records.filter(x => x.status === "completed")
      const metrics = [...new Set(completed.flatMap(x => numeric(x).map(([k]) => k)))].sort()
      return { key, stage: records[0].stage, modelId: records[0].modelId,
        seeds: [...new Set(records.map(x => x.seed))].sort((a,b) => a-b),
        completed: completed.length, skipped: records.length - completed.length,
        metrics: Object.fromEntries(metrics.map(metric => [metric, stats(completed.flatMap(x => numeric(x).filter(([k]) => k === metric).map(([,v]) => v)))])) }
    })
    const comparisons = groups.flatMap((left, i) => groups.slice(i+1).filter(right => right.modelId === left.modelId).map(right => {
      const leftItems = items.filter(x => JSON.stringify([x.stage ?? null,x.modelId]) === left.key)
      const rightItems = items.filter(x => JSON.stringify([x.stage ?? null,x.modelId]) === right.key)
      const identities = new Set([...leftItems,...rightItems].filter(x => x.candidateId !== undefined).map(x => JSON.stringify([x.candidateId,x.seed])))
      const metrics = [...new Set([...Object.keys(left.metrics),...Object.keys(right.metrics)])].sort()
      return { modelId: left.modelId, leftStage: left.stage, rightStage: right.stage, difference: "right minus left",
        metrics: Object.fromEntries(metrics.map(metric => {
          const deltas: Array<{seed:number; value:number}> = []
          for (const identity of identities) {
            const match = (xs: readonly Decision[]) => xs.find(x => JSON.stringify([x.candidateId,x.seed]) === identity && x.status === "completed")
            const a = match(leftItems), b = match(rightItems)
            const av = a?.metrics?.[metric], bv = b?.metrics?.[metric]
            if (typeof av === "number" && Number.isFinite(av) && typeof bv === "number" && Number.isFinite(bv)) deltas.push({seed:a!.seed,value:bv-av})
          }
          return [metric, { ...stats(deltas.map(x => x.value)), expectedPairs: identities.size, missingPairs: identities.size-deltas.length,
            bySeed: [...new Set(deltas.map(x => x.seed))].sort((a,b) => a-b).map(seed => ({seed,...stats(deltas.filter(x => x.seed === seed).map(x => x.value))})) }]
        })) }
    }))
    const rankComparisons = groups.flatMap((left, i) => groups.slice(i + 1).flatMap(right => {
      const leftItems = items.filter(x => JSON.stringify([x.stage ?? null, x.modelId]) === left.key)
      const rightItems = items.filter(x => JSON.stringify([x.stage ?? null, x.modelId]) === right.key)
      const metrics = Object.keys(left.metrics).filter(metric => metric in right.metrics).sort()
      if (!metrics.length) return []
      const expectedCandidates = [...new Set([...leftItems, ...rightItems].flatMap(item => item.candidateId ?? []))].sort()
      const seedMeans = (records: readonly Decision[], metric: string) => {
        const expectedSeeds = [...new Set([...leftItems, ...rightItems].map(item => item.seed))].sort((a, b) => a - b)
        const means = new Map<string, { mean: number; seedValues: number }>()
        for (const candidateId of expectedCandidates) {
          const values = records.filter(item => item.candidateId === candidateId).flatMap(item => {
            const value = item.status === "completed" ? item.metrics?.[metric] : undefined
            return typeof value === "number" && Number.isFinite(value) ? [{ seed: item.seed, value }] : []
          })
          if (values.length !== expectedSeeds.length || expectedSeeds.some(seed => !values.some(value => value.seed === seed))) continue
          means.set(candidateId, { mean: values.reduce((sum, value) => sum + value.value, 0) / values.length, seedValues: values.length })
        }
        return { expectedSeeds, means }
      }
      return [{
        leftStage: left.stage, leftModelId: left.modelId, rightStage: right.stage, rightModelId: right.modelId,
        aggregation: "arithmetic mean of complete seed values per candidate",
        metrics: Object.fromEntries(metrics.map(metric => {
          const leftMeans = seedMeans(leftItems, metric), rightMeans = seedMeans(rightItems, metric)
          const candidates = expectedCandidates.filter(candidateId => leftMeans.means.has(candidateId) && rightMeans.means.has(candidateId))
          const leftValues = candidates.map(candidateId => leftMeans.means.get(candidateId)!.mean)
          const rightValues = candidates.map(candidateId => rightMeans.means.get(candidateId)!.mean)
          return [metric, {
            ...spearman(leftValues, rightValues),
            expectedCandidates: expectedCandidates.length,
            pairedCandidates: candidates.length,
            missingCandidates: expectedCandidates.length - candidates.length,
            expectedLeftSeeds: leftMeans.expectedSeeds,
            expectedRightSeeds: rightMeans.expectedSeeds,
            leftSeedValues: candidates.reduce((sum, candidateId) => sum + leftMeans.means.get(candidateId)!.seedValues, 0),
            rightSeedValues: candidates.reduce((sum, candidateId) => sum + rightMeans.means.get(candidateId)!.seedValues, 0),
            leftTiedCandidates: tiedCandidateCount(leftValues),
            rightTiedCandidates: tiedCandidateCount(rightValues),
          }]
        })),
      }]
    }))
    const candidatesView = candidateTable(items, candidates)
    return { coverage: table.coverage, pairedRows: table.rows.length, groups, comparisons, rankComparisons,
      candidateTable: candidatesView, measurementCatalog: measurementCatalog(candidatesView),
      interpretation: "All available candidates and seeds; descriptive only. Same-model stage deltas are paired by candidate/seed. Rank comparisons use complete per-candidate seed means and are exploratory associations, not proof of a controlled mechanism, calibrated cross-model confidence, biological validity, or physical binding. Missing values are not zero." }
  }
  /** Content-addressed citations, resolved again from the reviewed run's trusted table. */
  export function measurementCatalog(table: ReturnType<typeof candidateTable>) {
    const claims = [
      ...table.rows.flatMap(row => Object.entries(row.metrics).flatMap(([metric, value]) =>
        value.seedMean === null ? [] : [{kind: "candidate_metric" as const, candidateId: row.candidateId,
          stage: row.stage, modelId: row.modelId, metric, seedMean: value.seedMean, rank: value.rank}])),
      ...table.contrasts.map(value => ({kind: "candidate_contrast" as const, stage: value.stage,
        modelId: value.modelId, metric: value.metric, leftCandidateId: value.leftCandidateId,
        rightCandidateId: value.rightCandidateId, seedMeanDifference: value.seedMeanDifference,
        pairedCount: value.pairedCount, pairedMeanDifference: value.pairedMeanDifference})),
    ]
    return claims.map(claim => ({id: "mcl_" + new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(claim)).digest("hex"), claim}))
  }
  export function assessMeasurement(measurement: TrialReasoning.Measurement | undefined, items: readonly Decision[]) {
    if (!measurement) return {status:"unresolved", reason:"No prospective measurement predicate"}
    const computed = summary(items)
    const statistic = measurement.statistic ?? "mean_difference"
    const supported = (value: number) => (measurement.relation === "greater" ? value > measurement.threshold : value < measurement.threshold)
      ? "supported_for_tested_predicate" : "not_supported_for_tested_predicate"
    if (statistic === "spearman") {
      const comparison = computed.rankComparisons.find(c => c.leftModelId === measurement.modelId && c.rightModelId === measurement.modelId &&
        ((c.leftStage === measurement.leftStage && c.rightStage === measurement.rightStage) ||
         (c.leftStage === measurement.rightStage && c.rightStage === measurement.leftStage)))
      const metric = comparison?.metrics[measurement.metric]
      if (!metric || metric.missingCandidates || metric.spearman === null)
        return {status:"unresolved", reason:metric?.reason ?? "Missing or incomplete paired ranks", measurement, statistic}
      return {status:supported(metric.spearman), measurement, statistic, value:metric.spearman,
        pairedCandidates:metric.pairedCandidates, aggregation:comparison!.aggregation,
        interpretation:"Tests the declared rank association across complete candidate seed means on this panel. It does not test a level shift, estimate a noise floor, or establish binding or a population relationship."}
    }
    const direct = computed.comparisons.find(c => c.modelId === measurement.modelId && c.leftStage === measurement.leftStage && c.rightStage === measurement.rightStage)
    const reverse = computed.comparisons.find(c => c.modelId === measurement.modelId && c.leftStage === measurement.rightStage && c.rightStage === measurement.leftStage)
    const metric = (direct ?? reverse)?.metrics[measurement.metric]
    if (!metric?.count || metric.missingPairs || metric.mean === null) return {status:"unresolved",reason:"Missing or incomplete paired metric",measurement,statistic}
    const difference = metric.mean * (direct ? 1 : -1)
    return {status:supported(difference), measurement, statistic, value:difference, difference, pairedCount:metric.count,
      interpretation:"Tests only the declared mean of right minus left on the observed panel. It does not test candidate ordering, establish a mechanism, or estimate a noise floor."}
  }
  export function historicalExtrema(runs: Array<{runId: string; modelEvidence: readonly Decision[]}>) {
    const extrema = new Map<string, {stage?:string;modelId:string;metric:string; minimum:number;maximum:number;maximumRunId:string;maximumCandidateId?:string;maximumSeed:number;count:number}>()
    for (const run of runs) for (const item of run.modelEvidence) {
      if (item.status !== "completed") continue
      for (const [metric,value] of Object.entries(item.metrics ?? {})) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue
        const key = JSON.stringify([item.stage ?? null,item.modelId,metric])
        const previous = extrema.get(key)
        if (!previous) extrema.set(key,{stage:item.stage,modelId:item.modelId,metric,minimum:value,maximum:value,maximumRunId:run.runId,maximumCandidateId:item.candidateId,maximumSeed:item.seed,count:1})
        else { previous.count++; previous.minimum = Math.min(previous.minimum,value)
          if (value > previous.maximum) Object.assign(previous,{maximum:value,maximumRunId:run.runId,maximumCandidateId:item.candidateId,maximumSeed:item.seed}) }
      }
    }
    return { runIds: runs.map(x => x.runId), emptyEvidenceRunIds: runs.filter(x => !x.modelEvidence.length).map(x => x.runId), extrema: [...extrema.values()],
      interpretation: "Observed extrema within the listed runs and exact stage/model/metric only. An observed maximum is not a biological optimum or family ceiling." }
  }
  /** A complete paired table for analysis; missing/skipped cells stay explicit. */
  export function paired(items: readonly Decision[]) {
    const columns = [...new Set(items.map(x => JSON.stringify([x.stage ?? null, x.modelId])))].sort()
    const rows = new Map<string, { candidateId: string; seed: number; cells: Record<string, unknown> }>()
    for (const item of items) {
      if (item.candidateId === undefined) continue
      const key = JSON.stringify([item.candidateId, item.seed])
      const row = rows.get(key) ?? { candidateId: item.candidateId, seed: item.seed, cells: Object.fromEntries(columns.map(c => [c, null])) }
      const column = JSON.stringify([item.stage ?? null, item.modelId])
      if (row.cells[column] !== null) throw new Error("Duplicate model decision in paired evidence")
      row.cells[column] = { status: item.status, metrics: item.metrics ?? null }
      rows.set(key, row)
    }
    return { columns, rows: [...rows.values()], coverage: coverage(items),
      interpretation: "Paired by candidate and seed. Null means missing, not zero. Confidence scales differ across predictors; agreement is not causal identification or binding validation." }
  }
}
