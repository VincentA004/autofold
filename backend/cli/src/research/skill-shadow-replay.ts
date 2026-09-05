import z from "zod"
import { Instance } from "@/project/instance"
import { CampaignSkills } from "./campaign-skills"
import { ResearchAutoresearch } from "./autoresearch"
import { ResearchDomain } from "./domain"
import { ResearchSkills } from "./research-skills"
import { Research } from "./service"

export namespace SkillShadowReplay {
  export const Input = z.object({
    campaignId: z.string().startsWith("cmp_"),
    experimentId: z.string().startsWith("exp_"),
    candidateVersionId: z.string().startsWith("skv_"),
    sessionId: z.string().startsWith("ses_"),
    agent: z.enum(["biology", "ml", "task"]).default("biology"),
    repetitions: z.number().int().min(3).max(5).default(3),
  })
  export type Input = z.infer<typeof Input>

  const LoadedSkill = ResearchSkills.DomainKnowledge.extend({ versionId: z.string().startsWith("skv_") })
  export const Prepared = z.object({
    capturedAt: z.string().datetime(),
    // Autoresearch and shadow replay call one another at runtime. Resolve these
    // schemas lazily so module initialization order cannot expose a partially
    // initialized ResearchAutoresearch namespace.
    context: z.lazy(() => ResearchAutoresearch.Context),
    parent: LoadedSkill,
    candidate: LoadedSkill,
  })
  export type Prepared = z.infer<typeof Prepared>

  export const Arm = z.enum(["parent", "candidate"])
  export type Arm = z.infer<typeof Arm>

  export const Pair = z.object({
    repetition: z.number().int().positive(),
    parent: z.lazy(() => ResearchAutoresearch.Iteration),
    candidate: z.lazy(() => ResearchAutoresearch.Iteration),
  })
  export const Result = z.object({
    campaignId: Input.shape.campaignId,
    experimentId: Input.shape.experimentId,
    candidateVersionId: Input.shape.candidateVersionId,
    pairs: z.array(Pair).min(3).max(5),
    replay: ResearchDomain.SkillReplay,
    finalStatus: ResearchDomain.SkillVersion.shape.status,
  })
  export type Result = z.infer<typeof Result>

  export interface ArmResume {
    proposal?: ResearchAutoresearch.Proposal
    run?: z.infer<typeof ResearchAutoresearch.RunCheckpoint>
    iteration?: ResearchAutoresearch.Iteration
  }

  export interface Dependencies {
    prepare(input: Input): Promise<Prepared>
    runArm(input: {
      request: Input
      jobId: string
      arm: Arm
      repetition: number
      prepared: Prepared
      resume: ArmResume
      signal?: AbortSignal
      onProposal(value: ResearchAutoresearch.Proposal): Promise<void>
      onRun(value: z.infer<typeof ResearchAutoresearch.RunCheckpoint>): Promise<void>
      onIteration(value: ResearchAutoresearch.Iteration): Promise<void>
    }): Promise<ResearchAutoresearch.Iteration>
    score(context: ResearchAutoresearch.Context, iteration: ResearchAutoresearch.Iteration): Promise<ResearchDomain.SkillReplayScore>
    evaluate(input: Input, prepared: Prepared, replay: CampaignSkills.ReplayInput): Promise<ResearchDomain.SkillVersion>
  }

  export interface Lifecycle {
    jobId: string
    prepared?: Prepared
    arms?: Record<number, Partial<Record<Arm, ArmResume>>>
    final?: ResearchDomain.SkillVersion
    signal?: AbortSignal
    onPrepared?(value: Prepared): Promise<void>
    onProposal?(repetition: number, arm: Arm, value: ResearchAutoresearch.Proposal): Promise<void>
    onRun?(repetition: number, arm: Arm, value: z.infer<typeof ResearchAutoresearch.RunCheckpoint>): Promise<void>
    onIteration?(repetition: number, arm: Arm, value: ResearchAutoresearch.Iteration): Promise<void>
    onFinal?(value: ResearchDomain.SkillVersion): Promise<void>
  }

  export function armWorkspaceKey(jobId: string, repetition: number, arm: Arm): string {
    return `${jobId}-r${repetition}-${arm}`
  }

  export async function run(
    raw: Input,
    lifecycle: Lifecycle,
    dependencies: Dependencies = productionDependencies(),
  ): Promise<Result> {
    const request = Input.parse(raw)
    lifecycle.signal?.throwIfAborted()
    const prepared = Prepared.parse(lifecycle.prepared ?? await dependencies.prepare(request))
    if (prepared.context.experiment.id !== request.experimentId || prepared.context.experiment.campaignId !== request.campaignId) {
      throw new Error("Shadow replay context does not match the requested campaign experiment")
    }
    if (prepared.candidate.versionId !== request.candidateVersionId) throw new Error("Shadow replay candidate changed")
    await lifecycle.onPrepared?.(prepared)
    const pairs: Array<z.infer<typeof Pair>> = []
    for (let repetition = 1; repetition <= request.repetitions; repetition++) {
      const results = {} as Record<Arm, ResearchAutoresearch.Iteration>
      for (const arm of Arm.options) {
        lifecycle.signal?.throwIfAborted()
        const resume = lifecycle.arms?.[repetition]?.[arm] ?? {}
        results[arm] = resume.iteration ?? await dependencies.runArm({
          request,
          jobId: lifecycle.jobId,
          repetition,
          arm,
          prepared,
          resume,
          signal: lifecycle.signal,
          onProposal: (value) => lifecycle.onProposal?.(repetition, arm, value) ?? Promise.resolve(),
          onRun: (value) => lifecycle.onRun?.(repetition, arm, value) ?? Promise.resolve(),
          onIteration: (value) => lifecycle.onIteration?.(repetition, arm, value) ?? Promise.resolve(),
        })
      }
      pairs.push(Pair.parse({ repetition, ...results }))
    }
    const parentScores = await Promise.all(pairs.map((pair) => dependencies.score(prepared.context, pair.parent)))
    const candidateScores = await Promise.all(pairs.map((pair) => dependencies.score(prepared.context, pair.candidate)))
    const baseline = aggregate(parentScores)
    const candidate = aggregate(candidateScores)
    if (baseline.failureRate === 1 && candidate.failureRate === 1) {
      throw new Error("Shadow replay is inconclusive because neither arm produced a valid locked evaluation")
    }
    const replayInput = CampaignSkills.ReplayInput.parse({
      // v2 denotes independent mutable scientist workspaces per paired arm.
      // Keep it in the immutable replay identity so results from the former
      // sequential/shared-workspace harness cannot be mistaken for this A/B
      // protocol in later campaign or library decisions.
      benchmarkId: `shadow-v2:${prepared.context.experiment.contractHash}:${request.candidateVersionId}:n${request.repetitions}`,
      sameBudget: true,
      baseline,
      candidate,
      campaignIds: [request.campaignId],
    })
    const final = lifecycle.final ?? await dependencies.evaluate(request, prepared, replayInput)
    await lifecycle.onFinal?.(final)
    if (!final.replay) throw new Error(`Evaluated skill ${final.id} has no replay record`)
    return Result.parse({
      campaignId: request.campaignId,
      experimentId: request.experimentId,
      candidateVersionId: request.candidateVersionId,
      pairs,
      replay: final.replay,
      finalStatus: final.status,
    })
  }

  function productionDependencies(): Dependencies {
    return { prepare, runArm, score, evaluate }
  }

  async function prepare(input: Input): Promise<Prepared> {
    const versions = await CampaignSkills.service.list(Instance.project.id, input.campaignId)
    const candidate = versions.find((version) => version.id === input.candidateVersionId)
    if (!candidate || !candidate.parentVersionId) throw new Error(`Candidate ${input.candidateVersionId} was not found`)
    if (candidate.status !== "candidate" && !candidate.replay) throw new Error(`${candidate.id} is ${candidate.status}, not replayable`)
    const parent = versions.find((version) => version.id === candidate.parentVersionId)
    if (!parent) throw new Error(`Parent ${candidate.parentVersionId} was not found`)
    const context = await ResearchAutoresearch.loadContext(input.experimentId)
    if (context.experiment.campaignId !== input.campaignId) throw new Error(`${input.experimentId} is outside ${input.campaignId}`)
    return Prepared.parse({
      capturedAt: new Date().toISOString(),
      context,
      parent: await CampaignSkills.service.loadVersion(Instance.project.id, input.campaignId, Instance.directory, parent.id),
      candidate: await CampaignSkills.service.loadVersion(Instance.project.id, input.campaignId, Instance.directory, candidate.id),
    })
  }

  async function runArm(input: {
    request: Input
    jobId: string
    arm: Arm
    repetition: number
    prepared: Prepared
    resume: ArmResume
    signal?: AbortSignal
    onProposal(value: ResearchAutoresearch.Proposal): Promise<void>
    onRun(value: z.infer<typeof ResearchAutoresearch.RunCheckpoint>): Promise<void>
    onIteration(value: ResearchAutoresearch.Iteration): Promise<void>
  }): Promise<ResearchAutoresearch.Iteration> {
    const skill = input.arm === "parent" ? input.prepared.parent : input.prepared.candidate
    const result = await ResearchAutoresearch.run(
      {
        experimentId: input.request.experimentId,
        sessionId: input.request.sessionId,
        iterations: 1,
        agent: input.request.agent,
      },
      undefined,
      input.signal,
      {
        proposals: input.resume.proposal ? { 1: input.resume.proposal } : {},
        runs: input.resume.run ? { 1: input.resume.run } : {},
        iterations: input.resume.iteration ? { 1: input.resume.iteration } : {},
        originJobId: input.jobId,
        originPhasePrefix: `shadow:${input.repetition}:${input.arm}:`,
        // A replay pair shares one frozen scientific context, but each arm
        // must start from an independent mutable trial, notebook, and agent
        // session. Otherwise the candidate arm inherits the parent arm's
        // edits/conversation and the skill comparison is sequential adaptation
        // rather than a paired benchmark.
        workspaceKey: armWorkspaceKey(input.jobId, input.repetition, input.arm),
        isolatedWorkspace: true,
        skillRefs: [ResearchSkills.reference(skill)],
        skillKnowledge: [skill],
        frozenContext: input.prepared.context,
        contractLock: {
          experimentId: input.prepared.context.experiment.id,
          contractHash: input.prepared.context.experiment.contractHash,
        },
        intent: "shadow_replay",
        onProposal: (_iteration, value) => input.onProposal(value),
        onRunStarted: (_iteration, value) => input.onRun(value),
        onIteration: input.onIteration,
      },
    )
    const iteration = result.iterations[0]
    if (!iteration) throw new Error(`Shadow repetition ${input.repetition} ${input.arm} arm produced no iteration`)
    return iteration
  }

  async function score(
    context: ResearchAutoresearch.Context,
    iteration: ResearchAutoresearch.Iteration,
  ): Promise<ResearchDomain.SkillReplayScore> {
    const evaluation = iteration.trialId
      ? (await Research.history(Instance.project.id, context.experiment.id)).evaluations.find((item) => item.trialId === iteration.trialId)
      : undefined
    return scoreEvaluation(context, evaluation)
  }

  export function scoreEvaluation(
    context: ResearchAutoresearch.Context,
    evaluation?: ResearchDomain.Evaluation,
  ): ResearchDomain.SkillReplayScore {
    const valid = Boolean(evaluation?.valid && evaluation.score !== null)
    const utility = valid
      ? context.experiment.contract.evaluator.direction === "maximize" ? evaluation!.score! : -evaluation!.score!
      : -1_000_000_000
    const diagnostics = evaluation?.diagnostics ?? {}
    const submission = diagnostics.submission_count ?? diagnostics.candidate_count ?? 0
    const diversity = diagnostics.panel_diversity ?? diagnostics.unique_fraction ?? 0
    const disagreementValues = Object.entries(diagnostics)
      .filter(([key]) => key.toLowerCase().includes("disagreement"))
      .map(([, value]) => value)
    return ResearchDomain.SkillReplayScore.parse({
      lockedObjectiveUtility: utility,
      areaUnderImprovementCurve: utility,
      validDiverseYield: valid ? submission * diversity : 0,
      predictorDisagreement: disagreementValues.length
        ? disagreementValues.reduce((sum, value) => sum + value, 0) / disagreementValues.length
        : 0,
      failureRate: valid ? 0 : 1,
      computeCost: context.experiment.contract.budget.gpuHours,
    })
  }

  export function aggregate(scores: ResearchDomain.SkillReplayScore[]): ResearchDomain.SkillReplayScore {
    if (!scores.length) throw new Error("Shadow replay requires at least one score")
    const sum = (field: keyof ResearchDomain.SkillReplayScore) => scores.reduce((total, score) => total + score[field], 0)
    return ResearchDomain.SkillReplayScore.parse({
      lockedObjectiveUtility: sum("lockedObjectiveUtility") / scores.length,
      areaUnderImprovementCurve: sum("lockedObjectiveUtility"),
      validDiverseYield: sum("validDiverseYield"),
      predictorDisagreement: sum("predictorDisagreement") / scores.length,
      failureRate: sum("failureRate") / scores.length,
      computeCost: sum("computeCost"),
    })
  }

  async function evaluate(
    input: Input,
    _prepared: Prepared,
    replay: CampaignSkills.ReplayInput,
  ): Promise<ResearchDomain.SkillVersion> {
    const versions = await CampaignSkills.service.list(Instance.project.id, input.campaignId)
    const existing = versions.find((version) => version.id === input.candidateVersionId)
    if (existing?.replay?.benchmarkId === replay.benchmarkId) return existing
    return CampaignSkills.service.evaluate(Instance.project.id, input.campaignId, input.candidateVersionId, replay)
  }
}
