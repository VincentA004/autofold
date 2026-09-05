import z from "zod"
import { Instance } from "@/project/instance"
import { ResearchDomain } from "./domain"
import { ResearchLiteratureReview } from "./literature-review"
import { Research, ResearchService } from "./service"
import { ResearchSearchPolicy } from "./search-policy"
import { ExecutionProtocol } from "./execution-protocol"
import { EvaluatorCalibration } from "./evaluator-calibration"
import { ResearchScientistMemory } from "./scientist-memory"

/**
 * Deterministically close one empirical trajectory. Trusted run facts enter
 * the search landscape immediately and idempotently; literature review and
 * model-authored interpretation are optional scientist tools, never an
 * iteration barrier.
 */
export namespace ResearchTrajectoryCloseout {
  export const TrajectoryPacket = z.object({
    format: z.literal("autofold.trajectory.v1"),
    campaignId: z.string().startsWith("cmp_"),
    experimentId: z.string().startsWith("exp_"),
    contractHash: z.string().startsWith("sha256:"),
    iteration: z.number().int().positive(),
    status: z.enum(["succeeded", "run_failed"]),
    trialId: z.string().startsWith("trl_"),
    runId: z.string().startsWith("run_"),
    knowledgeCycleId: z.string().startsWith("kcy_"),
    searchObservationIds: z.array(z.string().startsWith("sobs_")),
    score: z.number().finite().nullable().optional(),
    decision: z.enum(["promoted", "rejected", "observed", "failed"]).optional(),
    error: z.string().optional(),
    generatorPortfolio: z.array(z.string().trim().min(1)).max(30),
    generatorAllocations: z.array(ResearchSearchPolicy.Allocation).max(30),
    semanticProgramFingerprint: z.string().startsWith("sha256:").optional(),
    workflowFingerprint: z.string().startsWith("sha256:").optional(),
    calibrationClass: EvaluatorCalibration.CalibrationClass.optional(),
    calibrationReplicateOfTrialId: z.string().startsWith("trl_").optional(),
    generationReplicate: ExecutionProtocol.GenerationReplicateV1.optional(),
    generationWallSeconds: z.number().finite().nonnegative().optional(),
    generatorDiagnostics: z.array(ResearchDomain.GeneratorDiagnostics).max(30).default([]),
    candidateSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(100),
    modelIds: z.array(z.string().trim().min(1)).max(100),
  })
  export type TrajectoryPacket = z.infer<typeof TrajectoryPacket>

  export const Input = z.object({
    campaignId: z.string().startsWith("cmp_"),
    experimentId: z.string().startsWith("exp_"),
    sessionId: z.string().startsWith("ses_"),
    iteration: z.number().int().positive(),
    status: z.enum(["succeeded", "run_failed"]),
    trialId: z.string().startsWith("trl_").optional(),
    runId: z.string().startsWith("run_").optional(),
    score: z.number().finite().nullable().optional(),
    decision: z.enum(["promoted", "rejected"]).optional(),
    error: z.string().trim().min(1).optional(),
    generatorPortfolio: z.array(z.string().trim().min(1)).max(30).default([]),
    generatorAllocations: z.array(ResearchSearchPolicy.Allocation).max(30).default([]),
    semanticProgramFingerprint: z.string().startsWith("sha256:").optional(),
    workflowFingerprint: z.string().startsWith("sha256:").optional(),
    calibrationClass: EvaluatorCalibration.CalibrationClass.optional(),
    calibrationReplicateOfTrialId: z.string().startsWith("trl_").optional(),
    generationReplicate: ExecutionProtocol.GenerationReplicateV1.optional(),
    generationWallSeconds: z.number().finite().nonnegative().optional(),
    generatorDiagnostics: z.array(ResearchDomain.GeneratorDiagnostics).max(30).default([]),
    candidateSequences: z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)).max(100).default([]),
    modelIds: z.array(z.string().trim().min(1)).max(100).default([]),
  })
  // Callers may omit fields with schema defaults; `run` immediately parses
  // this into the fully populated output shape used by the closeout logic.
  export type Input = z.input<typeof Input>

  export const Result = z.discriminatedUnion("status", [
    z.object({
      status: z.literal("skipped"),
      reason: z.enum(["no_persisted_trajectory", "knowledge_current"]),
    }),
    z.object({
      status: z.literal("completed"),
      cycleId: z.string().startsWith("kcy_"),
      claimIds: z.array(z.string().startsWith("clm_")),
      alignmentIds: z.array(z.string().startsWith("aln_")),
      // The search observation is the canonical structured trajectory packet:
      // it links the immutable execution lineage, frozen contract evidence,
      // model/generator provenance, score delta, and knowledge cycle. Optional
      // preserves restart compatibility with checkpoints written before v1.
      trajectory: TrajectoryPacket.optional(),
      nextExperiment: ResearchDomain.NextExperimentProposal,
      unresolvedQuestions: z.array(z.string()),
    }),
  ])
  export type Result = z.infer<typeof Result>

  export interface Dependencies {
    history(experimentId: string): ReturnType<typeof Research.history>
    ingest(campaignId: string, input: ResearchService.LiteratureReviewInput): ReturnType<typeof Research.ingestLiteratureReview>
    publish(campaignId: string): Promise<void>
    appendEvent(event: ResearchScientistMemory.TrajectoryEventInput): Promise<void>
  }

  export interface Lifecycle {
    proposal?: z.infer<typeof ResearchLiteratureReview.ProposalCheckpoint>
    signal?: AbortSignal
    onProposal?(proposal: z.infer<typeof ResearchLiteratureReview.ProposalCheckpoint>): Promise<void>
  }

  export async function run(
    raw: Input,
    _lifecycle: Lifecycle = {},
    dependencies: Dependencies = productionDependencies(),
  ): Promise<Result> {
    const input = Input.parse(raw)
    if (!input.trialId || !input.runId) {
      return { status: "skipped", reason: "no_persisted_trajectory" }
    }
    const history = await dependencies.history(input.experimentId)
    if (input.status === "run_failed") {
      return deterministicFailureCloseout(input, history, dependencies)
    }
    return deterministicSuccessCloseout(input, history, dependencies)
  }

  export function compactQuestion(core: string, terminalEvidence: string, maximum = 2_000): string {
    if (core.length >= maximum) return core.slice(0, maximum)
    const remaining = maximum - core.length - 1
    return `${core} ${terminalEvidence.slice(0, Math.max(0, remaining))}`
  }

  export function classifyTerminalEvidence(error: string): string {
    const common = "Classify this failure as infrastructure, workflow, model, or scientific evidence. Preserve the actionable root cause without copying terminal progress noise."
    if (error.includes("Every Proto portfolio lane failed") && error.includes("IndexError: list index out of range")) {
      return [
        common,
        "Trusted runtime diagnosis: all lanes reached their generators, then the shared Proto optimizer indexed past a proposal pool that the frozen per-lane allocation had reduced. This is an optimizer/allocation integration failure.",
        "The 'Invalid characters X' lines are placeholder-sequence warnings emitted before generator replacement; do not claim that a final candidate contained X.",
        `Terminal evidence: ${error}`,
      ].join(" ")
    }
    return `${common} Terminal evidence: ${error}`
  }

  async function deterministicSuccessCloseout(
    input: z.output<typeof Input>,
    history: Awaited<ReturnType<typeof Research.history>>,
    dependencies: Dependencies,
  ): Promise<Result> {
    const trial = history.trials.find((item) => item.id === input.trialId)
    const run = history.runs.find((item) => item.id === input.runId)
    const evaluation = history.evaluations.findLast((item) => item.trialId === input.trialId)
    const knowledge = history.knowledge.find((item) => item.runId === input.runId)
    if (!trial || !run || !evaluation || !knowledge) {
      return { status: "skipped", reason: "no_persisted_trajectory" }
    }
    const decision = knowledge.decision
    const priorBestScore = bestPriorOptimizeScore(history, trial.id)
    const scoreDeltaFromPriorBest = evaluation.score === null || priorBestScore === null
      ? null
      : history.experiment.contract.evaluator.direction === "minimize"
        ? priorBestScore - evaluation.score
        : evaluation.score - priorBestScore
    const unresolved = [
      `Which scientist-selected Proto delta should follow run ${run.id} under the unchanged experiment contract?`,
      "Do the candidate-level predictors agree strongly enough to justify exploitation, or should the next trial investigate disagreement?",
    ]
    const outcome = !evaluation.valid || trial.intent !== "optimize"
      ? "unresolved"
      : decision === "promoted"
        ? "supported"
        : "refuted"
    const outcomeRefs = [knowledge.id, evaluation.id, run.id, trial.id]
    const persisted = await dependencies.ingest(input.campaignId, {
      generatedBy: successCloseoutActor(run.id),
      trigger: "run_completed",
      question: `Record trusted autoresearch iteration ${input.iteration} without inserting a model-authored review barrier.`,
      inputKnowledgeIds: [knowledge.id],
      sources: [],
      claims: [],
      unresolvedQuestions: unresolved,
      campaignSummary: [
        `Experiment ${input.experimentId} trial ${trial.id} completed run ${run.id}.`,
        `The frozen evaluator recorded ${evaluation.valid ? "a valid" : "an invalid"} score ${evaluation.score ?? "null"} and decision ${decision}.`,
        "This is trusted computational evidence under the recorded contract, not physical binding or specificity evidence.",
      ].join(" "),
      nextExperiment: {
        action: "continue_experiment",
        experimentId: input.experimentId,
        hypothesis: "The persistent scientist can use the completed trajectory to select a higher-information same-contract Proto delta.",
        rationale: "The trusted result is now available directly in the experiment history and search landscape; scientific interpretation remains with the persistent scientist.",
        successCriterion: "The next immutable trial produces a comparable score or an actionable execution diagnostic under the unchanged contract.",
      },
      searchObservations: [{
        experimentId: input.experimentId,
        trialId: trial.id,
        runId: run.id,
        evaluationId: evaluation.id,
        knowledgeId: knowledge.id,
        intent: trial.intent,
        programHash: trial.programHash,
        pipelineHash: input.workflowFingerprint,
        semanticProgramFingerprint: input.semanticProgramFingerprint,
        workflowFingerprint: input.workflowFingerprint,
        calibrationClass: input.calibrationClass,
        calibrationReplicateOfTrialId: input.calibrationReplicateOfTrialId,
        generationReplicateId: input.generationReplicate?.id,
        realizedCandidateSetHash: input.generationReplicate?.realizedCandidateSetHash,
        generationStochasticity: input.generationReplicate?.stochasticity,
        generationWallSeconds: input.generationWallSeconds,
        parentTrialId: trial.parentTrialId,
        generatorPortfolio: input.generatorPortfolio,
        generatorAllocations: input.generatorAllocations,
        generatorDiagnostics: input.generatorDiagnostics,
        candidateSequences: input.candidateSequences,
        modelIds: input.modelIds,
        seeds: history.experiment.contract.evaluator.fixedSeeds,
        score: evaluation.score,
        priorBestScore,
        scoreDeltaFromPriorBest,
        decision,
        diagnostics: evaluation.diagnostics,
        hypothesis: trial.hypothesis,
      }],
      hypothesisUpdates: [{
        category: "method",
        statement: trial.hypothesis,
        status: outcome,
        confidence: outcome === "unresolved" ? 0.5 : 0.85,
        evidenceLevel: "computational_support",
        supportingEvidenceRefs: outcome === "supported" ? outcomeRefs : [],
        opposingEvidenceRefs: outcome === "refuted" ? outcomeRefs : [],
        prediction: priorBestScore === null
          ? `Trial ${trial.id} will produce a valid locked score under experiment ${input.experimentId}.`
          : `Trial ${trial.id} will improve the locked ${history.experiment.contract.evaluator.direction} objective beyond prior best ${priorBestScore}.`,
        falsificationCriterion: priorBestScore === null
          ? `The frozen evaluator records an invalid or incomplete result for trial ${trial.id}.`
          : `A valid locked result fails to improve beyond ${priorBestScore} under the unchanged experiment contract.`,
        recommendedExperiment: outcome === "refuted"
          ? "Author a non-equivalent Proto delta that addresses the observed generator or predictor diagnostics while preserving the frozen experiment contract."
          : "Use the trusted trajectory and predictor diagnostics to choose the next highest-information same-contract Proto delta.",
        limitations: [
          `This ${outcome} outcome applies to the trial's prediction under frozen computational contract ${history.experiment.contractHash}.`,
          "It is not physical evidence of binding, affinity, specificity, safety, or biological activity.",
        ],
      }],
    })
    await dependencies.publish(input.campaignId)
    await dependencies.appendEvent({
      recordedAt: new Date().toISOString(),
      campaignId: input.campaignId,
      experimentId: input.experimentId,
      contractHash: history.experiment.contractHash,
      iteration: input.iteration,
      intent: trial.intent,
      status: "succeeded",
      trialId: trial.id,
      runId: run.id,
      parentTrialId: trial.parentTrialId,
      programHash: trial.programHash,
      semanticProgramFingerprint: input.semanticProgramFingerprint,
      workflowFingerprint: input.workflowFingerprint,
      hypothesis: trial.hypothesis,
      generatorPortfolio: input.generatorPortfolio,
      generatorAllocations: input.generatorAllocations,
      candidateSequences: input.candidateSequences,
      modelIds: input.modelIds,
      seeds: history.experiment.contract.evaluator.fixedSeeds,
      score: evaluation.score,
      priorBestScore,
      decision,
      diagnostics: evaluation.diagnostics,
      knowledgeCycleId: persisted.cycle.id,
      searchObservationIds: persisted.cycle.outputs?.searchObservationIds ?? [],
    })
    return Result.parse({
      status: "completed",
      cycleId: persisted.cycle.id,
      claimIds: [],
      alignmentIds: [],
      trajectory: trajectoryPacket(input, history.experiment.contractHash, persisted.cycle, decision),
      nextExperiment: persisted.cycle.nextExperiment!,
      unresolvedQuestions: persisted.unresolvedQuestions,
    })
  }

  async function deterministicFailureCloseout(
    input: z.output<typeof Input>,
    history: Awaited<ReturnType<typeof Research.history>>,
    dependencies: Dependencies,
  ): Promise<Result> {
    const trial = history.trials.find((item) => item.id === input.trialId)
    const run = history.runs.find((item) => item.id === input.runId)
    const knowledge = history.knowledge.find((item) => item.runId === input.runId && item.decision === "failed")
    if (!trial || !run || !knowledge) return { status: "skipped", reason: "no_persisted_trajectory" }
    const diagnosis = classifyTerminalEvidence(input.error ?? run.error ?? "Scientific worker run failed")
    const unresolved = [
      `Does the corrected workflow produce a complete locked panel under experiment ${input.experimentId}?`,
      "Which generator lanes and validator stages succeed after the shared execution failure is removed?",
    ]
    const persisted = await dependencies.ingest(input.campaignId, {
      // `generatedBy` is also the atomic idempotency key for a knowledge
      // cycle. A process-wide constant caused every later failed trajectory to
      // reuse the campaign's first failure notebook entry.
      generatedBy: failureCloseoutActor(input.runId!),
      trigger: "run_completed",
      question: `Close failed autoresearch iteration ${input.iteration} without treating execution diagnostics as biological evidence.`,
      inputKnowledgeIds: [knowledge.id],
      sources: [],
      claims: [],
      unresolvedQuestions: unresolved,
      campaignSummary: `Experiment ${input.experimentId} trial ${trial.id} failed before locked evaluation. ${diagnosis.slice(0, 3_000)}`,
      nextExperiment: {
        action: "continue_experiment",
        experimentId: input.experimentId,
        hypothesis: "Removing the recorded workflow failure will allow the unchanged frozen experiment to produce its first locked comparable panel.",
        rationale: "The terminal trajectory produced execution evidence but no score. Repeating only after a concrete workflow repair is the highest-information same-contract action.",
        successCriterion: "The corrected run completes generation and the frozen evaluator, producing a valid locked score and model diagnostics under the unchanged contract.",
      },
      searchObservations: [{
        experimentId: input.experimentId,
        trialId: trial.id,
        runId: run.id,
        knowledgeId: knowledge.id,
        intent: trial.intent,
        programHash: trial.programHash,
        pipelineHash: input.workflowFingerprint,
        semanticProgramFingerprint: input.semanticProgramFingerprint,
        workflowFingerprint: input.workflowFingerprint,
        calibrationClass: input.calibrationClass,
        calibrationReplicateOfTrialId: input.calibrationReplicateOfTrialId,
        generationReplicateId: input.generationReplicate?.id,
        realizedCandidateSetHash: input.generationReplicate?.realizedCandidateSetHash,
        generationStochasticity: input.generationReplicate?.stochasticity,
        generationWallSeconds: input.generationWallSeconds,
        parentTrialId: trial.parentTrialId,
        generatorPortfolio: input.generatorPortfolio,
        generatorAllocations: input.generatorAllocations,
        generatorDiagnostics: input.generatorDiagnostics,
        candidateSequences: input.candidateSequences,
        modelIds: input.modelIds,
        seeds: history.experiment.contract.evaluator.fixedSeeds,
        score: null,
        decision: "failed",
        diagnostics: {},
        hypothesis: trial.hypothesis,
      }],
      hypothesisUpdates: [{
        category: "workflow",
        statement: `The program in trial ${trial.id} has a reproducible execution-path failure before locked evaluation.`,
        status: "supported",
        confidence: 0.95,
        evidenceLevel: "model_observation",
        supportingEvidenceRefs: [knowledge.id, run.id, trial.id],
        opposingEvidenceRefs: [],
        prediction: "A run with the same unresolved execution path will fail before producing a locked evaluation.",
        falsificationCriterion: "A concretely repaired workflow completes the frozen evaluator and records a locked score.",
        recommendedExperiment: "Run a repaired non-equivalent workflow under the unchanged experiment contract.",
        limitations: [
          "This is execution evidence only and says nothing about physical binding, specificity, or candidate quality.",
          diagnosis.slice(0, 1_500),
        ],
      }],
    })
    await dependencies.publish(input.campaignId)
    await dependencies.appendEvent({
      recordedAt: new Date().toISOString(),
      campaignId: input.campaignId,
      experimentId: input.experimentId,
      contractHash: history.experiment.contractHash,
      iteration: input.iteration,
      intent: trial.intent,
      status: "run_failed",
      trialId: trial.id,
      runId: run.id,
      parentTrialId: trial.parentTrialId,
      programHash: trial.programHash,
      semanticProgramFingerprint: input.semanticProgramFingerprint,
      workflowFingerprint: input.workflowFingerprint,
      hypothesis: trial.hypothesis,
      generatorPortfolio: input.generatorPortfolio,
      generatorAllocations: input.generatorAllocations,
      candidateSequences: input.candidateSequences,
      modelIds: input.modelIds,
      seeds: history.experiment.contract.evaluator.fixedSeeds,
      decision: "failed",
      diagnostics: {},
      knowledgeCycleId: persisted.cycle.id,
      searchObservationIds: persisted.cycle.outputs?.searchObservationIds ?? [],
      error: input.error ?? run.error ?? "Scientific worker run failed",
    })
    return Result.parse({
      status: "completed",
      cycleId: persisted.cycle.id,
      claimIds: persisted.claims.map((claim) => claim.id),
      alignmentIds: persisted.alignments.map((alignment) => alignment.id),
      trajectory: trajectoryPacket(input, history.experiment.contractHash, persisted.cycle, "failed"),
      nextExperiment: persisted.cycle.nextExperiment!,
      unresolvedQuestions: persisted.unresolvedQuestions,
    })
  }

  export function failureCloseoutActor(runId: string): string {
    return `autofold-trusted-failure-closeout/v2:${z.string().startsWith("run_").parse(runId)}`
  }

  export function successCloseoutActor(runId: string): string {
    return `autofold-trusted-success-closeout/v1:${z.string().startsWith("run_").parse(runId)}`
  }

  function trajectoryPacket(
    input: z.output<typeof Input>,
    contractHash: string,
    cycle: { id: string; outputs?: { searchObservationIds?: string[] } },
    decision: "promoted" | "rejected" | "observed" | "failed",
  ): TrajectoryPacket {
    return TrajectoryPacket.parse({
      format: "autofold.trajectory.v1",
      campaignId: input.campaignId,
      experimentId: input.experimentId,
      contractHash,
      iteration: input.iteration,
      status: input.status,
      trialId: input.trialId,
      runId: input.runId,
      knowledgeCycleId: cycle.id,
      searchObservationIds: cycle.outputs?.searchObservationIds ?? [],
      score: input.score,
      decision,
      error: input.error,
      generatorPortfolio: input.generatorPortfolio,
      generatorAllocations: input.generatorAllocations,
      generatorDiagnostics: input.generatorDiagnostics,
      semanticProgramFingerprint: input.semanticProgramFingerprint,
      workflowFingerprint: input.workflowFingerprint,
      calibrationClass: input.calibrationClass,
      calibrationReplicateOfTrialId: input.calibrationReplicateOfTrialId,
      generationReplicate: input.generationReplicate,
      generationWallSeconds: input.generationWallSeconds,
      candidateSequences: input.candidateSequences,
      modelIds: input.modelIds,
    })
  }

  function bestPriorOptimizeScore(
    history: Awaited<ReturnType<typeof Research.history>>,
    currentTrialId: string,
  ): number | null {
    const trialIntent = new Map(history.trials.map((trial) => [trial.id, trial.intent]))
    const scores = history.evaluations
      .filter((evaluation) =>
        evaluation.trialId !== currentTrialId &&
        evaluation.valid &&
        evaluation.score !== null &&
        trialIntent.get(evaluation.trialId) === "optimize"
      )
      .map((evaluation) => evaluation.score as number)
    if (!scores.length) return null
    return history.experiment.contract.evaluator.direction === "minimize"
      ? Math.min(...scores)
      : Math.max(...scores)
  }

  export async function appendTrustedEvent(
    event: ResearchScientistMemory.TrajectoryEventInput,
    directory = Instance.directory,
  ): Promise<void> {
    await ResearchScientistMemory.append(event, directory)
  }

  function productionDependencies(): Dependencies {
    return {
      history: (experimentId) => Research.history(Instance.project.id, experimentId),
      ingest: (campaignId, input) => Research.ingestLiteratureReview(Instance.project.id, campaignId, input),
      publish: (campaignId) => Research.publishCampaignKnowledge(Instance.project.id, campaignId, Instance.directory),
      appendEvent: (event) => appendTrustedEvent(event),
    }
  }
}
