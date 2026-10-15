import type { ResearchDomain } from "./domain"
import { TrialReasoning } from "./trial-reasoning"
import { SearchDistributions } from "./search-distributions"
import { EvidenceView } from "./evidence-view"
import { ScientificInquiry } from "./scientific-inquiry"
import { operationHash } from "./operations"

/** Rebuildable observations for scientific decisions, never a promotion policy. */
export namespace DecisionEvidence {
  export interface VerifiedComparisonProvenance {
    status: "verified" | "unknown"
    conditions?: Record<string, unknown>
    admittedDesign?: Record<string, unknown>
    workflowFingerprint?: string | null
    unknownFields?: string[]
  }
  export interface VerifiedRunEvidence {
    run: {id: string; status: string; startedAt?: string; completedAt?: string}
    modelEvidence: readonly EvidenceView.Decision[]
    candidates?: readonly unknown[]
    comparisonProvenance?: VerifiedComparisonProvenance
  }
  const leafPaths = (value: unknown, prefix = ""): Map<string, unknown> => {
    const result = new Map<string, unknown>()
    if (Array.isArray(value)) {
      if (prefix) result.set(`${prefix}#length`, value.length)
      value.forEach((item, index) => {
        for (const [key, child] of leafPaths(item, `${prefix}[${index}]`)) result.set(key, child)
      })
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      if (!entries.length && prefix) result.set(prefix, value)
      for (const [name, item] of entries) for (const [key, child] of leafPaths(item, prefix ? `${prefix}.${name}` : name)) result.set(key, child)
    } else if (prefix) result.set(prefix, value)
    return result
  }
  const changeValue = (value: unknown) => {
    const json=JSON.stringify(value),bytes=Buffer.byteLength(json??"null")
    return bytes<=512?value:{omitted:true,hash:"sha256:"+operationHash(value),bytes}
  }
  /** Compare only host-verified, structured receipt fields; fingerprints are labels, not condition evidence. */
  export function compareVerifiedProvenance(left?: VerifiedComparisonProvenance, right?: VerifiedComparisonProvenance) {
    const verified = (value?: VerifiedComparisonProvenance) => value?.status === "verified"
    if (!verified(left) || !verified(right)) return {
      status: "unknown" as const, conditionChanges: null, designChanges: null,
      unknown: [...(!verified(left) ? ["tested"] : []), ...(!verified(right) ? ["comparator"] : [])],
      workflowFingerprints: [left?.workflowFingerprint ?? null, right?.workflowFingerprint ?? null],
      interpretation: "Structured frozen conditions or admitted design are unavailable for at least one receipt; no match or confound is inferred.",
    }
    const changes = (a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) => {
      if (!a || !b) return null
      const leftLeaves = leafPaths(a), rightLeaves = leafPaths(b)
      return [...new Set([...leftLeaves.keys(), ...rightLeaves.keys()])].sort().flatMap(path => {
        const before = leftLeaves.get(path), after = rightLeaves.get(path)
        if (!leftLeaves.has(path) || !rightLeaves.has(path)) return [{path,tested:leftLeaves.has(path)?{present:true,value:changeValue(before)}:{present:false},comparator:rightLeaves.has(path)?{present:true,value:changeValue(after)}:{present:false}}]
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [{path, tested: changeValue(before), comparator: changeValue(after)}]
      })
    }
    const conditionChanges = changes(left!.conditions, right!.conditions), designChanges = changes(left!.admittedDesign, right!.admittedDesign)
    const unknown=[...(!left!.conditions ? ["tested.frozen_conditions"] : []),...(!right!.conditions ? ["comparator.frozen_conditions"] : []),
      ...(!left!.admittedDesign ? ["tested.admitted_design"] : []),...(!right!.admittedDesign ? ["comparator.admitted_design"] : []),
      ...(left!.unknownFields??[]).map(field=>`tested.${field}`),...(right!.unknownFields??[]).map(field=>`comparator.${field}`)]
    return {status: unknown.length ? "partial" as const : "compared" as const, conditionChanges, designChanges,
      unknown,
      workflowFingerprints: [left!.workflowFingerprint ?? null, right!.workflowFingerprint ?? null],
      interpretation: "Structured differences describe known frozen conditions and admitted designs; unknown fields prevent a complete match claim, and no difference establishes a causal effect. Workflow fingerprints include authored design projection/settings and are shown only as provenance labels.",
    }
  }
  /** Opening decision view: measurements first; original proposals remain in the full ledger. */
  export function card(ledger: ReturnType<typeof summarize>) {
    // Native metric rows and contrasts can dwarf the opening context. Keep the
    // evaluator inputs here; the complete candidate tables remain in the ledger.
    const candidates = (table: ReturnType<typeof EvidenceView.candidateTable> | null | undefined) => table ? {
      scoringInputs: table.scoringInputs,
      scoringScope: table.scoringScope,
      expectedCandidates: table.expectedCandidates,
      shownCandidates: table.shownCandidates,
      omittedCandidates: table.omittedCandidates,
      detail: "Full per-model/seed rows and contrasts are in this run's evidencePath and the decisionEvidence ledger.",
    } : null
    return {
      evidenceAuthority:ledger.evidenceAuthority,
      coverageScope:ledger.coverageScope,
      objective:ledger.objectiveProgress,
      latestPromotionEvidence:ledger.latestPromotionEvidence ? {...ledger.latestPromotionEvidence, candidates:candidates(ledger.latestPromotionEvidence.candidates)} : null,
      candidateArchiveLocation:"evidence/candidateArchive.json (all observed optimize panels, including rejected panels; read on demand for sequence refinement and panel-composition analysis)",
      candidateOpportunities:ledger.candidateOpportunities.map(item => ({...item, candidates:candidates(item.candidates)})),
      existingControls:ledger.nonOptimizationEvidence.map(({hypothesis,hypothesisAuthority,candidateEvidence,...evidence}) => ({...evidence, candidateEvidence:candidates(candidateEvidence)})),
      recentDecisions:ledger.priorDecisions.slice(-4).map(({plan,planAuthority,reviewQuestion,limitation,...evidence}) => ({
        ...evidence, question:plan!.question,
        originalPlan:"Available by runId in the full decisionEvidence ledger; prior branches and rationales are proposals, not measured conclusions.",
      })),
      comparisonAudit:ledger.comparisonAudit.slice(-4),
      nextDecision:"Resolving a diagnostic is not a discovery plateau. Reassess candidate/program improvements against the incumbent; useful computational optimization does not require solving every predictor mechanism. Compare the remaining value of a concrete design change, saved-evidence analysis, research, or stopping. Audit the original plan rather than obeying its next action.",
    }
  }
  export function archive(observations: ResearchDomain.SearchObservation[], experimentId: string,
    evidence: Parameters<typeof summarize>[2] = []) {
    const byRun=new Map(evidence.map(item => [item.run.id,item]))
    return {experimentId, interpretation:"Observed candidate inputs from optimize trials, not independent discoveries or promoted candidates. Compare the full frozen panel objective; favorable raw predictor confidence alone is insufficient.",
      runs:[...new Map(observations.filter(o => o.experimentId === experimentId && o.intent === "optimize" && o.decision !== "failed")
        .map(o => [o.runId,o])).values()].map(o => {
        const item=byRun.get(o.runId)
        return {runId:o.runId,trialId:o.trialId,decision:o.decision,score:o.score,panelDiagnostics:o.diagnostics,
          generators:o.generatorPortfolio,evidencePath:EvidenceView.path(o.runId),
          candidates:item?.run.status === "succeeded" ? EvidenceView.candidateTable(item.modelEvidence,item.candidates).scoringInputs : null}
      })}
  }
  export function summarize(observations: ResearchDomain.SearchObservation[], experimentId: string,
    evidence: VerifiedRunEvidence[] = []) {
    const allRuns = [...new Map(observations.filter(o => o.experimentId === experimentId)
      .map(o => [o.runId, o])).values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId))
    const runs = allRuns.filter(o => o.intent === "optimize")
    const byRun = new Map(evidence.map(item => [item.run.id, item]))
    const resultEvidence = (o: ResearchDomain.SearchObservation) => {
      const item = byRun.get(o.runId)
      const successful = o.decision !== "failed" && (!item || item.run.status === "succeeded")
      const elapsed = item?.run.startedAt && item.run.completedAt
        ? (Date.parse(item.run.completedAt) - Date.parse(item.run.startedAt)) / 1000 : null
      const measurement = o.decisionPlan?.measurement
      const computed = successful && item?.modelEvidence.length ? EvidenceView.summary(item.modelEvidence) : undefined
      return {
        evidenceStatus: !successful ? "failed_no_scientific_result" : computed ? "verified_model_evidence" : "model_evidence_unavailable",
        measuredPrediction: EvidenceView.assessMeasurement(measurement, successful ? item?.modelEvidence ?? [] : []),
        // Keep level and ordering together so satisfying one cannot silently stand in for the other.
        pairedEvidence: measurement && computed ? {
          level: computed.comparisons.filter(c => c.modelId === measurement.modelId &&
            [measurement.leftStage, measurement.rightStage].includes(c.leftStage ?? "") &&
            [measurement.leftStage, measurement.rightStage].includes(c.rightStage ?? ""))
            .map(c => {
              const values=c.metrics[measurement.metric]
              const sign=c.leftStage === measurement.leftStage ? 1 : -1
              return {leftStage:measurement.leftStage,rightStage:measurement.rightStage,difference:"right minus left",metric:measurement.metric,
                mean:values?.mean == null ? null : sign*values.mean, pairedCount:values?.count ?? 0,
                missingPairs:values?.missingPairs ?? null,
                bySeed:values?.bySeed.map(v => ({seed:v.seed,count:v.count,mean:v.mean === null ? null : sign*v.mean})) ?? []}
            }),
          ordering: computed.rankComparisons.filter(c => c.leftModelId === measurement.modelId && c.rightModelId === measurement.modelId &&
            [measurement.leftStage, measurement.rightStage].includes(c.leftStage ?? "") &&
            [measurement.leftStage, measurement.rightStage].includes(c.rightStage ?? ""))
            .map(c => ({leftStage:c.leftStage,rightStage:c.rightStage,aggregation:c.aggregation,metric:measurement.metric,values:c.metrics[measurement.metric]})),
        } : undefined,
        executionWallSeconds: elapsed !== null && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
        timingScope: "Observed start-to-completion wall time, not billed GPU utilization; unknown is not zero.",
        evidencePath: EvidenceView.path(o.runId),
      }
    }
    const comparatorMatches = (trialId: string) => [...new Map(observations
      .filter(other => other.experimentId === experimentId && other.trialId === trialId)
      .map(other => [other.runId, other])).values()]
    const sets = new Map<string, ResearchDomain.SearchObservation[]>()
    for (const run of runs) {
      if (!run.realizedCandidateSetHash) continue
      const group = sets.get(run.realizedCandidateSetHash) ?? []
      group.push(run); sets.set(run.realizedCandidateSetHash, group)
    }
    const repeatedOutputs = [...sets.entries()].filter(([, group]) => group.length > 1).map(([hash, group]) => ({
      candidateSetHash: hash, runIds: group.map((o) => o.runId),
      trialIds: group.map((o) => o.trialId),
      configurationFamilies: [...new Set(group.flatMap((o) => o.configurationFamilyFingerprint ?? []))],
      scores: group.map((o) => o.score),
      generationWallSeconds: group.map((o) => o.generationWallSeconds ?? null),
      interpretation: "Repeated returned sequences; not independent candidate discoveries or proof of equivalent structures, model evidence, or all possible configurations.",
    }))
    const families = SearchDistributions.summarize(runs).map((family) => {
      const members = runs.filter((o) => o.configurationFamilyFingerprint === family.configurationFamilyFingerprint)
      const hashes = new Set(members.flatMap((o) => o.realizedCandidateSetHash ?? []))
      return { ...family, distinctObservedCandidateSets: hashes.size,
        unknownCandidateSets: members.filter((o) => !o.realizedCandidateSetHash).length,
        inferenceScope: family.scored < 2 ? "single_scored_observation" : "descriptive_replicate_distribution",
        uncertainty: "No population superiority, optimum, ceiling, or plateau is established by this descriptive sample. Independent RNG is not inferred from run count.",
      }
    })
    return {
      format: "autofold.decision-evidence.v1", experimentId,
      evidenceAuthority:ScientificInquiry.evidenceAuthority,
      coverageScope:"Only the provided same-experiment observations; missing history is not evidence of no earlier improvement.",
      evidenceRefs: allRuns.map((o) => o.runId), families, repeatedOutputs,
      objectiveProgress: {
        scoredOptimizeRuns: runs.filter(o => o.decision !== "failed" && o.score !== null).length,
        promotedRunIds: runs.filter(o => o.decision === "promoted").map(o => o.runId),
        sinceLastPromotion: (() => {
          const latest = runs.findLastIndex(o => o.decision === "promoted")
          const following = runs.slice(latest + 1)
          return {lastPromotedRunId: latest >= 0 ? runs[latest].runId : null,
            scoredRunIds:latest < 0 ? null : following.filter(o => o.decision !== "failed" && o.score !== null).map(o => o.runId),
            failedRunIds:latest < 0 ? null : following.filter(o => o.decision === "failed").map(o => o.runId)}
        })(),
        interpretation:"Promotion records candidate-panel progress under the locked evaluator, not improvement of a generation method. Baseline promotion is included. A supported comparison against another trial need not improve the incumbent.",
      },
      latestPromotionEvidence: (() => {
        const promoted=runs.findLast(o => o.decision === "promoted")
        if (!promoted) return null
        const item=byRun.get(promoted.runId)
        return {runId:promoted.runId,trialId:promoted.trialId,score:promoted.score,panelDiagnostics:promoted.diagnostics,
          generators:promoted.generatorPortfolio,configurationFamily:promoted.configurationFamilyFingerprint ?? null,
          evidencePath:EvidenceView.path(promoted.runId),
          candidates:item?.run.status === "succeeded" ? EvidenceView.candidateTable(item.modelEvidence,item.candidates) : null,
          interpretation:"Latest recorded optimize promotion in the provided observations; confirm the experiment incumbent pointer. Candidate profiles are measurements for designing improvements, not validated structure-activity rules. Compare concrete sequence/program changes against this evidence before another diagnostic or fresh draw."}
      })(),
      candidateOpportunities: (() => {
        const promoted=runs.findLast(o => o.decision === "promoted")
        const baseline=promoted?.diagnostics.best_candidate_loss
        if (typeof baseline !== "number" || !Number.isFinite(baseline)) return []
        return runs.filter(o => o.decision === "rejected" && typeof o.diagnostics.best_candidate_loss === "number" &&
          o.diagnostics.best_candidate_loss < baseline).map(o => {
          const item=byRun.get(o.runId)
          return {runId:o.runId,trialId:o.trialId,panelScore:o.score,panelDecision:o.decision,
            bestCandidateLoss:o.diagnostics.best_candidate_loss,referenceRunId:promoted!.runId,referenceBestCandidateLoss:baseline,
            panelDiagnostics:o.diagnostics,evidencePath:EvidenceView.path(o.runId),
            candidates:item?.run.status === "succeeded" ? EvidenceView.candidateTable(item.modelEvidence,item.candidates) : null,
            interpretation:"This rejected panel recorded a lower best_candidate_loss than the latest recorded promotion. Its best individual signal may be useful for refinement or panel composition despite losing overall. Identify the candidate from saved evidence; do not infer a better method or biological activity. No evaluator weights or promotion decisions are changed."}
        })
      })(),
      nonOptimizationEvidence: allRuns.filter(o => o.intent !== "optimize").map(o => ({
        runId:o.runId, trialId:o.trialId, intent:o.intent, hypothesis:o.hypothesis,
        score:o.score, decision:o.decision, panelDiagnostics:o.diagnostics, candidateSequences:o.candidateSequences,
        ...resultEvidence(o),
        candidateEvidence: o.decision !== "failed" && byRun.get(o.runId)?.run.status === "succeeded"
          ? EvidenceView.candidateTable(byRun.get(o.runId)!.modelEvidence, byRun.get(o.runId)!.candidates) : undefined,
        hypothesisAuthority:"Historical scientist-authored interpretation/proposal, not a measured calibration verdict.",
        interpretation:"Existing diagnostic/control evidence, not promotion-eligible. Read its actual measurements and control provenance before proposing another control; intent alone does not validate a control or calibrate binding.",
      })),
      coverage: {
        uniqueOptimizeRuns: runs.length,
        scoredRuns: runs.filter(o => o.decision !== "failed" && o.score !== null).length,
        failedRuns: runs.filter(o => o.decision === "failed").length,
        unknownFamilyRunIds: runs.filter(o => !o.configurationFamilyFingerprint).map(o => o.runId),
        portfolioRunIds: runs.filter(o => o.generatorPortfolio.length > 1).map(o => o.runId),
        interpretation: "Do not pool unknown families by generator name or interpret a portfolio score as an isolated generator effect.",
      },
      comparisonAudit: runs.filter(o => o.prediction).map(o => {
        const matches = comparatorMatches(o.prediction!.comparatorTrialId)
        const comparator = matches.length === 1 ? matches[0] : undefined
        return { runId: o.runId, comparatorTrialId: o.prediction!.comparatorTrialId,
          comparatorRunId: comparator?.runId ?? null,
          comparatorIntent:comparator?.intent ?? null,
          panelComparison: {
            tested:{intent:o.intent,candidates:o.diagnostics.candidate_count ?? null,eligible:o.diagnostics.eligible_count ?? null,
              generators:o.generatorPortfolio,workflow:o.workflowFingerprint ?? null,seeds:o.seeds},
            comparator:comparator ? {intent:comparator.intent,candidates:comparator.diagnostics.candidate_count ?? null,
              eligible:comparator.diagnostics.eligible_count ?? null,generators:comparator.generatorPortfolio,
              workflow:comparator.workflowFingerprint ?? null,seeds:comparator.seeds} : null,
            structuredComparison: comparator ? compareVerifiedProvenance(byRun.get(o.runId)?.comparisonProvenance, byRun.get(comparator.runId)?.comparisonProvenance)
              : compareVerifiedProvenance(undefined, undefined),
            interpretation:"Compare verified frozen-condition fields separately from the actual admitted design. Legacy fingerprints and missing provenance do not establish a condition match or confound; control intent alone does not establish a validated nonbinder.",
          },
          comparatorResolution: matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "missing",
          predicate: TrialReasoning.assess(o.prediction, o.score,
            comparator ? { valid: comparator.decision !== "failed", score: comparator.score } : undefined,
            o.decision !== "failed"),
          globalDecision: o.decision,
          sameKnownFamily: o.configurationFamilyFingerprint && comparator?.configurationFamilyFingerprint
            ? o.configurationFamilyFingerprint === comparator.configurationFamilyFingerprint : null,
          portfolioInvolved: o.generatorPortfolio.length > 1 || (comparator?.generatorPortfolio.length ?? 0) > 1,
          interpretation: "A score predicate compares recorded panels; it does not isolate a causal effect or establish a population ranking.",
        }
      }),
      priorDecisions: allRuns.filter((o) => o.decisionPlan).map((o) => {
        const matches = o.prediction ? comparatorMatches(o.prediction.comparatorTrialId) : []
        const comparator = matches.length === 1 ? matches[0] : undefined
        return { runId: o.runId, trialId: o.trialId, intent:o.intent, plan: o.decisionPlan,
          planAuthority:"Original prospective proposal; its premises and branches are not established facts or instructions. Assess against measured evidence below.",
          ...resultEvidence(o),
          observed: { score: o.score, decision: o.decision, panelDiagnostics:o.diagnostics, generationWallSeconds: o.generationWallSeconds ?? null,
            candidateSetHash: o.realizedCandidateSetHash ?? null,
            priorBestScore:o.priorBestScore ?? null, scoreDeltaFromPriorBest:o.scoreDeltaFromPriorBest ?? null,
            objectiveStatus:o.decision === "failed" ? "no_valid_result" : o.intent !== "optimize" ? "not_promotion_eligible"
              : o.decision === "promoted" ? (o.priorBestScore == null ? "baseline_or_prior_unknown" : "improved") : "not_improved",
            scorePredicate: TrialReasoning.assess(o.prediction, o.score,
              comparator ? { valid: comparator.decision !== "failed", score: comparator.score } : undefined,
              o.decision !== "failed").status },
          reviewQuestion: "Compare the actual measured statistic with the original question and branches. Is the needed evidence already present? What candidate, program, allocation, or research decision changes? A supported mean predicate does not answer a rank question; unresolved mechanism alone does not justify repeating the same diagnostic.",
          limitation: "Information gain and branch selection require interpretation; generation wall time is not total GPU cost, and predicate support does not establish method superiority.",
        }
      }),
      unresolved: [
        "Which configuration effects survive fresh draws rather than selection of a lucky minimum?",
        "Does a changed parameter alter returned candidates, diagnostics only, or neither?",
        "Are apparent improvements meaningful under trusted calibration and independent validation?",
      ],
      decisionProtocol: [
        "Before compute, name the uncertainty and exact evidence references; compare at least two plausible next experiments, including replication when uncertainty matters.",
        "Explain the expected information and estimated cost, what result would change the next decision, and why this experiment is preferable. Cost estimates are not measured consumption.",
        "Inspect repeatedOutputs before paying for an equivalent candidate set. Re-evaluation can still be justified by independent predictor evidence; explain that purpose explicitly.",
        "After compute, separate the observed score predicate from the broader method claim. State remaining uncertainty and a falsifying next test; do not infer a family ceiling from a tie.",
      ],
      limitation: "This packet supplies evidence and questions, not a computed acquisition score or a harness-selected experiment. Calibration, causal effects, and statistical confidence require additional evidence.",
    }
  }
}
