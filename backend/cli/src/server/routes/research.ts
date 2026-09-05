import crypto from "node:crypto"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import {
  DesignAdapters,
  Research,
  ResearchAutoresearch,
  ResearchArtifacts,
  ResearchDomain,
  ResearchExecution,
  ResearchLiterature,
  ResearchLiteratureReview,
  ResearchJobRunner,
  ResearchJobs,
  ResearchJobService,
  ResearchOrchestration,
  ResearchPrograms,
  ResearchService,
  CampaignSkills,
  CapabilityRefinement,
  SkillShadowReplay,
} from "@/research"
import { lazy } from "@/util/lazy"
import { MAX_AUTONOMOUS_ITERATIONS } from "@/research/autoresearch"

const CampaignParam = z.object({ campaignId: z.string().startsWith("cmp_") })
const CampaignSkillParam = CampaignParam.extend({ skillId: z.string().regex(/^skill_[a-z0-9._-]+$/) })
const SkillVersionParam = CampaignParam.extend({ versionId: z.string().startsWith("skv_") })
const KnowledgeParam = z.object({
  campaignId: z.string().startsWith("cmp_"),
  conceptId: z.string().regex(/^knw_[A-Za-z0-9_-]+$/),
})
const ClaimParam = z.object({
  campaignId: z.string().startsWith("cmp_"),
  claimId: z.string().regex(/^clm_[A-Za-z0-9_-]+$/),
})
const AlignmentParam = z.object({
  campaignId: z.string().startsWith("cmp_"),
  alignmentId: z.string().regex(/^aln_[A-Za-z0-9_-]+$/),
})
const ExperimentParam = z.object({ experimentId: z.string().startsWith("exp_") })
const TrialParam = z.object({ trialId: z.string().startsWith("trl_") })
const RunParam = z.object({ runId: z.string().startsWith("run_") })
const JobParam = z.object({ jobId: z.string().startsWith("job_") })

function idempotencyKey(value?: string): string {
  return value?.trim() || `request:${crypto.randomUUID()}`
}

export const ResearchRoutes = lazy(() =>
  new Hono()
    .use(async (_c, next) => {
      ResearchJobRunner.wake()
      await next()
    })
    .get(
      "/design-adapters",
      describeRoute({
        summary: "List installed design adapters",
        operationId: "research.design-adapter.list",
        responses: { 200: { description: "Mock and pinned Proto adapter availability" } },
      }),
      async (c) => c.json(await DesignAdapters.list()),
    )
    .get(
      "/evaluators",
      describeRoute({
        summary: "List installed locked evaluators",
        operationId: "research.evaluator.list",
        responses: { 200: { description: "Installed evaluator identities and source hashes" } },
      }),
      async (c) => c.json(await ResearchExecution.evaluators()),
    )
    .get(
      "/program-templates",
      describeRoute({
        summary: "Get immutable trial program templates",
        operationId: "research.program-template.list",
        responses: { 200: { description: "Mock and Proto trial.py templates" } },
      }),
      (c) => c.json(ResearchPrograms.templates()),
    )
    .post(
      "/targets",
      describeRoute({
        summary: "Validate and freeze a target artifact",
        description: "Stores a Target Artifact v1 by its canonical content hash.",
        operationId: "research.target.author",
        responses: { 200: { description: "Content-addressed target artifact" } },
      }),
      validator("json", ResearchArtifacts.AuthorTargetInput),
      async (c) => c.json(await ResearchArtifacts.authorTargetInput(Instance.directory, c.req.valid("json"))),
    )
    .get(
      "/campaigns",
      describeRoute({
        summary: "List research campaigns",
        operationId: "research.campaign.list",
        responses: { 200: { description: "Project-scoped campaigns" } },
      }),
      async (c) => c.json(await Research.listCampaigns(Instance.project.id)),
    )
    .post(
      "/campaigns",
      describeRoute({
        summary: "Create a research campaign",
        operationId: "research.campaign.create",
        responses: { 200: { description: "Created campaign" } },
      }),
      validator("json", ResearchService.CreateCampaignInput),
      async (c) => c.json(await Research.createCampaign(Instance.project.id, c.req.valid("json"))),
    )
    .post(
      "/campaigns/:campaignId/activate",
      describeRoute({
        summary: "Activate a research campaign",
        operationId: "research.campaign.activate",
        responses: { 200: { description: "Activated campaign" } },
      }),
      validator("param", CampaignParam),
      async (c) =>
        c.json(await Research.activateCampaign(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/skills/initialize",
      describeRoute({
        summary: "Initialize campaign domain skills",
        operationId: "research.campaign.skill.initialize",
        responses: { 200: { description: "Campaign-scoped immutable skill versions" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await CampaignSkills.service.initialize(
        Instance.project.id, c.req.valid("param").campaignId, Instance.directory,
      )),
    )
    .get(
      "/campaigns/:campaignId/skills",
      describeRoute({
        summary: "List campaign skill versions",
        operationId: "research.campaign.skill.list",
        responses: { 200: { description: "All candidate, active, rejected, and superseded skill versions" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await CampaignSkills.service.list(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/skills/:skillId/candidates",
      describeRoute({
        summary: "Propose an immutable campaign skill refinement",
        operationId: "research.campaign.skill.propose",
        responses: { 200: { description: "Unevaluated candidate skill version" } },
      }),
      validator("param", CampaignSkillParam),
      validator("json", CampaignSkills.ProposeInput),
      async (c) => {
        const param = c.req.valid("param")
        return c.json(await CampaignSkills.service.propose(
          Instance.project.id, param.campaignId, Instance.directory, param.skillId, c.req.valid("json"),
        ))
      },
    )
    .post(
      "/campaigns/:campaignId/skills/:skillId/refine",
      describeRoute({
        summary: "Queue evidence-bounded capability refinement",
        description: "Freezes referenced campaign trajectories and lets one bounded child agent author one candidate SKILL.md. Promotion still requires replay.",
        operationId: "research.campaign.skill.refine",
        responses: { 202: { description: "Persisted capability-refinement job" } },
      }),
      validator("param", CampaignSkillParam),
      validator("json", CapabilityRefinement.Input.omit({ campaignId: true, skillId: true }).extend({
        idempotencyKey: z.string().trim().min(1).max(500).optional(),
        replayExperimentId: z.string().startsWith("exp_").optional(),
        replayAgent: z.enum(["biology", "ml", "task"]).optional(),
        replayRepetitions: z.number().int().min(3).max(5).optional(),
      })),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        await CampaignSkills.service.initialize(Instance.project.id, param.campaignId, Instance.directory)
        const job = await ResearchJobs.enqueue(Instance.project.id, {
          idempotencyKey: idempotencyKey(body.idempotencyKey ?? c.req.header("Idempotency-Key")),
          payload: {
            kind: "capability_refinement",
            campaignId: param.campaignId,
            skillId: param.skillId,
            sessionId: body.sessionId,
            trajectoryRefs: body.trajectoryRefs,
            replayExperimentId: body.replayExperimentId,
            replayAgent: body.replayAgent ?? "biology",
            replayRepetitions: body.replayRepetitions ?? 3,
          },
        })
        ResearchJobRunner.wake()
        return c.json(job, 202)
      },
    )
    .post(
      "/campaigns/:campaignId/skill-versions/:versionId/evaluate",
      describeRoute({
        summary: "Replay-evaluate a candidate skill",
        operationId: "research.campaign.skill.evaluate",
        responses: { 200: { description: "Activated or rejected skill version" } },
      }),
      validator("param", SkillVersionParam),
      validator("json", CampaignSkills.ReplayInput),
      async (c) => {
        const param = c.req.valid("param")
        return c.json(await CampaignSkills.service.evaluate(
          Instance.project.id, param.campaignId, param.versionId, c.req.valid("json"),
        ))
      },
    )
    .post(
      "/campaigns/:campaignId/skill-versions/:versionId/replay",
      describeRoute({
        summary: "Queue trusted parent-versus-candidate shadow replay",
        description: "Runs both skills from one frozen context as non-promotable trials and derives promotion evidence from locked evaluations.",
        operationId: "research.campaign.skill.shadow-replay",
        responses: { 202: { description: "Persisted skill shadow-replay job" } },
      }),
      validator("param", SkillVersionParam),
      validator("json", SkillShadowReplay.Input.omit({ campaignId: true, candidateVersionId: true }).extend({
        idempotencyKey: z.string().trim().min(1).max(500).optional(),
      })),
      async (c) => {
        const param = c.req.valid("param")
        const body = c.req.valid("json")
        const job = await ResearchJobs.enqueue(Instance.project.id, {
          idempotencyKey: idempotencyKey(body.idempotencyKey ?? c.req.header("Idempotency-Key")),
          payload: {
            kind: "skill_shadow_replay",
            campaignId: param.campaignId,
            candidateVersionId: param.versionId,
            experimentId: body.experimentId,
            sessionId: body.sessionId,
            agent: body.agent,
            repetitions: body.repetitions,
          },
        })
        ResearchJobRunner.wake()
        return c.json(job, 202)
      },
    )
    .post(
      "/campaigns/:campaignId/skill-versions/:versionId/rollback",
      describeRoute({
        summary: "Roll back a campaign skill",
        operationId: "research.campaign.skill.rollback",
        responses: { 200: { description: "Reactivated historical skill version" } },
      }),
      validator("param", SkillVersionParam),
      async (c) => {
        const param = c.req.valid("param")
        return c.json(await CampaignSkills.service.rollback(Instance.project.id, param.campaignId, param.versionId))
      },
    )
    .post(
      "/campaigns/:campaignId/skill-versions/:versionId/promote-library",
      describeRoute({
        summary: "Promote a cross-campaign validated skill to the project library",
        operationId: "research.campaign.skill.promote-library",
        responses: { 200: { description: "Project skill library entry" } },
      }),
      validator("param", SkillVersionParam),
      async (c) => {
        const param = c.req.valid("param")
        return c.json(await CampaignSkills.service.promoteToLibrary(Instance.project.id, param.campaignId, param.versionId))
      },
    )
    .get(
      "/campaigns/:campaignId/knowledge",
      describeRoute({
        summary: "List campaign knowledge concepts",
        description: "Lists the campaign-scoped OKF v0.2 evaluation knowledge catalog.",
        operationId: "research.knowledge.list",
        responses: { 200: { description: "Campaign knowledge concepts" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await Research.listKnowledge(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .get(
      "/campaigns/:campaignId/orchestration/observation",
      describeRoute({
        summary: "Build the canonical campaign-supervisor observation",
        operationId: "research.orchestration.observe",
        responses: { 200: { description: "Policy-safe recursive campaign state" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await ResearchOrchestration.observe(c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/orchestration/moves/compile",
      describeRoute({
        summary: "Compile an agent-proposed campaign move without executing it",
        operationId: "research.orchestration.move.compile",
        responses: { 200: { description: "Authorized, rejected, or approval-required move" } },
      }),
      validator("param", CampaignParam),
      validator("json", ResearchOrchestration.Move),
      async (c) =>
        c.json(
          ResearchOrchestration.compile(
            await ResearchOrchestration.observe(c.req.valid("param").campaignId),
            c.req.valid("json"),
          ),
        ),
    )
    .post(
      "/campaigns/:campaignId/orchestration/moves/execute",
      describeRoute({
        summary: "Compile and execute one authorized campaign move",
        operationId: "research.orchestration.move.execute",
        responses: { 200: { description: "Policy decision and optional durable job" } },
      }),
      validator("param", CampaignParam),
      validator(
        "json",
        z.object({
          move: ResearchOrchestration.Move,
          sessionId: z.string().startsWith("ses_"),
          idempotencyKey: z.string().trim().min(1).max(500).optional(),
        }),
      ),
      async (c) => {
        const campaignId = c.req.valid("param").campaignId
        const input = c.req.valid("json")
        const decision = ResearchOrchestration.compile(await ResearchOrchestration.observe(campaignId), input.move)
        if (decision.status !== "authorized" || !decision.executable) return c.json({ decision })
        const payload =
          decision.move.kind === "iterate_experiment"
            ? {
                kind: "autoresearch" as const,
                experimentId: decision.move.experimentId,
                sessionId: input.sessionId,
                iterations: decision.move.iterations,
                agent: decision.move.agent,
                recursionMode: decision.move.recursionMode,
                trialIntent: decision.move.trialIntent,
                baselineTrialId: decision.move.baselineTrialId,
                rationale: decision.move.rationale,
                expectedInformationGain: decision.move.expectedInformationGain,
                decisionMode: decision.move.decisionMode,
                searchPolicy: decision.move.searchPolicy,
                evidenceRefs: decision.move.evidenceRefs,
                allowEquivalent: decision.move.allowEquivalent,
                equivalenceJustification: decision.move.equivalenceJustification,
                staticControlScope: decision.move.staticControlScope,
              }
            : {
                kind: "knowledge_refresh" as const,
                campaignId,
                sessionId: input.sessionId,
                question: decision.move.kind === "refresh_knowledge" ? decision.move.question : undefined,
                maxSources: 20,
                maxClaims: 20,
              }
        const job = await ResearchJobs.enqueue(Instance.project.id, {
          idempotencyKey: idempotencyKey(input.idempotencyKey ?? c.req.header("Idempotency-Key")),
          payload,
        })
        ResearchJobRunner.wake()
        return c.json({ decision, job })
      },
    )
    .post(
      "/campaigns/:campaignId/orchestration/loops",
      describeRoute({
        summary: "Start one bounded dynamic campaign-supervisor loop",
        operationId: "research.orchestration.loop.start",
        responses: { 202: { description: "Durable campaign-loop job" } },
      }),
      validator("param", CampaignParam),
      validator(
        "json",
        z.object({
          sessionId: z.string().startsWith("ses_"),
          maxSteps: z.number().int().min(1).max(20).default(3),
          experimentId: z.string().startsWith("exp_").optional(),
          maximumTrajectories: z.number().int().min(1).max(100).optional(),
          idempotencyKey: z.string().trim().min(1).max(500).optional(),
        }),
      ),
      async (c) => {
        const campaignId = c.req.valid("param").campaignId
        const input = c.req.valid("json")
        const key = idempotencyKey(input.idempotencyKey ?? c.req.header("Idempotency-Key"))
        const existing = (await ResearchJobs.list(Instance.project.id)).find((job) => job.idempotencyKey === key)
        if (existing) return c.json(existing, 202)
        const observation = await ResearchOrchestration.observe(campaignId)
        if (observation.activeJobs.some((job) => job.kind === "campaign_loop")) {
          throw new ResearchJobService.ConflictError({
            code: "campaign_loop_active",
            message: `Campaign ${campaignId} already has an active supervisor loop`,
          })
        }
        const job = await ResearchJobs.enqueue(Instance.project.id, {
          idempotencyKey: key,
          payload: {
            kind: "campaign_loop",
            campaignId,
            experimentId: input.experimentId,
            sessionId: input.sessionId,
            maxSteps: input.maxSteps,
            maximumTrajectories: input.maximumTrajectories,
          },
        })
        ResearchJobRunner.wake()
        return c.json(job, 202)
      },
    )
    .get(
      "/campaigns/:campaignId/knowledge/status",
      describeRoute({
        summary: "Inspect the campaign knowledge refresh watermark",
        operationId: "research.knowledge.status",
        responses: { 200: { description: "Whether literature alignment is due and which outcomes are unprocessed" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await Research.knowledgeRefreshStatus(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .get(
      "/campaigns/:campaignId/knowledge/alignments",
      describeRoute({
        summary: "List literature-to-experiment evidence alignments",
        operationId: "research.knowledge.alignment.list",
        responses: { 200: { description: "Typed campaign evidence alignments" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await Research.listAlignments(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .get(
      "/campaigns/:campaignId/knowledge/cycles",
      describeRoute({
        summary: "List recursive campaign knowledge cycles",
        operationId: "research.knowledge.cycle.list",
        responses: { 200: { description: "Campaign knowledge cycle history" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await Research.listKnowledgeCycles(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/knowledge/alignments/:alignmentId/review",
      describeRoute({
        summary: "Review a proposed literature-to-experiment alignment",
        operationId: "research.knowledge.alignment.review",
        responses: { 200: { description: "Reviewed, contested, or deprecated evidence alignment" } },
      }),
      validator("param", AlignmentParam),
      validator("json", ResearchService.ReviewAlignmentInput),
      async (c) => {
        const params = c.req.valid("param")
        const alignment = await Research.reviewAlignment(
          Instance.project.id,
          params.campaignId,
          params.alignmentId,
          c.req.valid("json"),
        )
        await Research.publishCampaignKnowledge(Instance.project.id, params.campaignId, Instance.directory)
        return c.json(alignment)
      },
    )
    .get(
      "/campaigns/:campaignId/literature",
      describeRoute({
        summary: "List immutable campaign literature records",
        operationId: "research.literature.list",
        responses: { 200: { description: "Campaign literature search records" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await Research.listLiterature(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/literature/search",
      describeRoute({
        summary: "Search literature sources into campaign knowledge",
        description: "Searches public literature connectors and freezes normalized results by content hash.",
        operationId: "research.literature.search",
        responses: { 200: { description: "Frozen literature records and per-source errors" } },
      }),
      validator("param", CampaignParam),
      validator("json", ResearchLiterature.SearchInput.omit({ campaignId: true })),
      async (c) =>
        c.json(
          await ResearchLiterature.search(
            { campaignId: c.req.valid("param").campaignId, ...c.req.valid("json") },
            c.req.raw.signal,
          ),
        ),
    )
    .post(
      "/campaigns/:campaignId/literature/review",
      describeRoute({
        summary: "Queue a campaign evidence refresh",
        description: "Persists a restart-safe literature review job and returns immediately.",
        operationId: "research.literature.review.enqueue",
        responses: { 202: { description: "Persisted knowledge-refresh job" } },
      }),
      validator("param", CampaignParam),
      validator(
        "json",
        ResearchLiteratureReview.Input.omit({ campaignId: true }).extend({
          maxSources: ResearchLiteratureReview.Input.shape.maxSources.optional(),
          maxClaims: ResearchLiteratureReview.Input.shape.maxClaims.optional(),
          idempotencyKey: z.string().trim().min(1).max(500).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const job = await ResearchJobs.enqueue(Instance.project.id, {
          idempotencyKey: idempotencyKey(body.idempotencyKey ?? c.req.header("Idempotency-Key")),
          payload: {
            kind: "knowledge_refresh",
            campaignId: c.req.valid("param").campaignId,
            sessionId: body.sessionId,
            question: body.question,
            maxSources: body.maxSources ?? 20,
            maxClaims: body.maxClaims ?? 20,
            resumeProposalPath: body.resumeProposalPath,
            resumeChildSessionId: body.resumeChildSessionId,
          },
        })
        ResearchJobRunner.wake()
        return c.json(job, 202)
      },
    )
    .get(
      "/campaigns/:campaignId/claims",
      describeRoute({
        summary: "List campaign literature claims",
        operationId: "research.claim.list",
        responses: { 200: { description: "Proposed and reviewed campaign claims" } },
      }),
      validator("param", CampaignParam),
      async (c) => c.json(await Research.listClaims(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/claims",
      describeRoute({
        summary: "Create an evidence-linked campaign claim",
        description: "Creates a proposed claim; literature evidence is not mislabeled as experimental verification.",
        operationId: "research.claim.create",
        responses: { 200: { description: "Created proposed claim" } },
      }),
      validator("param", CampaignParam),
      validator("json", ResearchService.CreateClaimInput),
      async (c) => {
        const campaignId = c.req.valid("param").campaignId
        const claim = await Research.createClaim(Instance.project.id, campaignId, c.req.valid("json"))
        await Research.publishCampaignKnowledge(Instance.project.id, campaignId, Instance.directory)
        return c.json(claim)
      },
    )
    .post(
      "/campaigns/:campaignId/claims/:claimId/review",
      describeRoute({
        summary: "Review a campaign literature claim",
        operationId: "research.claim.review",
        responses: { 200: { description: "Reviewed, contested, or deprecated claim" } },
      }),
      validator("param", ClaimParam),
      validator("json", ResearchService.ReviewClaimInput),
      async (c) => {
        const params = c.req.valid("param")
        const claim = await Research.reviewClaim(
          Instance.project.id,
          params.campaignId,
          params.claimId,
          c.req.valid("json"),
        )
        await Research.publishCampaignKnowledge(Instance.project.id, params.campaignId, Instance.directory)
        return c.json(claim)
      },
    )
    .get(
      "/campaigns/:campaignId/knowledge/:conceptId",
      describeRoute({
        summary: "Get a campaign knowledge concept",
        operationId: "research.knowledge.get",
        responses: { 200: { description: "Campaign knowledge concept" } },
      }),
      validator("param", KnowledgeParam),
      async (c) => {
        const params = c.req.valid("param")
        return c.json(await Research.getKnowledge(Instance.project.id, params.campaignId, params.conceptId))
      },
    )
    .get(
      "/campaigns/:campaignId/experiments",
      describeRoute({
        summary: "List campaign experiments",
        operationId: "research.experiment.list",
        responses: { 200: { description: "Campaign experiments" } },
      }),
      validator("param", CampaignParam),
      async (c) =>
        c.json(await Research.listExperiments(Instance.project.id, c.req.valid("param").campaignId)),
    )
    .post(
      "/campaigns/:campaignId/experiments",
      describeRoute({
        summary: "Create a versioned experiment",
        operationId: "research.experiment.create",
        responses: { 200: { description: "Created experiment" } },
      }),
      validator("param", CampaignParam),
      validator("json", ResearchService.CreateExperimentInput),
      async (c) => {
        const input = c.req.valid("json")
        await ResearchArtifacts.readTarget(Instance.directory, input.contract.targetArtifactHash)
        return c.json(
          await Research.createExperiment(
            Instance.project.id,
            c.req.valid("param").campaignId,
            input,
          ),
        )
      },
    )
    .post(
      "/experiments/:experimentId/activate",
      describeRoute({
        summary: "Freeze and activate an experiment",
        operationId: "research.experiment.activate",
        responses: { 200: { description: "Activated experiment" } },
      }),
      validator("param", ExperimentParam),
      async (c) => {
        const experimentId = c.req.valid("param").experimentId
        const history = await Research.history(Instance.project.id, experimentId)
        await ResearchArtifacts.readTarget(Instance.directory, history.experiment.contract.targetArtifactHash)
        return c.json(await Research.activateExperiment(Instance.project.id, experimentId))
      },
    )
    .post(
      "/experiments/:experimentId/autoresearch",
      describeRoute({
        summary: "Queue bounded experiment-level RSI",
        description:
          "Persists a restart-safe job that creates dynamic child agents, freezes Proto proposals, and executes locked evaluations.",
        operationId: "research.autoresearch.enqueue",
        responses: { 202: { description: "Persisted autoresearch job" } },
      }),
      validator("param", ExperimentParam),
      validator(
        "json",
        ResearchAutoresearch.Input.omit({ experimentId: true }).extend({
          iterations: ResearchAutoresearch.Input.shape.iterations.optional(),
          agent: ResearchAutoresearch.Input.shape.agent.optional(),
          recursionMode: z.enum(["autonomous_discovery", "single_intent"]).optional(),
          automaticSkillRefinement: z.boolean().optional(),
          idempotencyKey: z.string().trim().min(1).max(500).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const job = await ResearchJobs.enqueue(Instance.project.id, {
          idempotencyKey: idempotencyKey(body.idempotencyKey ?? c.req.header("Idempotency-Key")),
          payload: {
            kind: "autoresearch",
            experimentId: c.req.valid("param").experimentId,
            sessionId: body.sessionId,
            iterations: body.iterations ?? (
              body.recursionMode === "single_intent" ? 1 : MAX_AUTONOMOUS_ITERATIONS
            ),
            agent: body.agent ?? "biology",
            recursionMode: body.recursionMode,
            automaticSkillRefinement: body.automaticSkillRefinement ?? true,
          },
        })
        ResearchJobRunner.wake()
        return c.json(job, 202)
      },
    )
    .get(
      "/experiments/:experimentId/discovery-benchmark",
      describeRoute({
        summary: "Audit recursive discovery progress",
        description:
          "Projects the frozen-contract lineage into direction-normalized improvement, evidence response, executable diversity, generator coverage, observational baselines, and evaluator calibration.",
        operationId: "research.experiment.discovery-benchmark",
        responses: { 200: { description: "Deterministic recursive-discovery benchmark" } },
      }),
      validator("param", ExperimentParam),
      async (c) => {
        const context = await ResearchAutoresearch.loadContext(c.req.valid("param").experimentId)
        return c.json(ResearchAutoresearch.discoveryBenchmark(context))
      },
    )
    .get(
      "/experiments/:experimentId/history",
      describeRoute({
        summary: "Get experiment trial history",
        operationId: "research.experiment.history",
        responses: { 200: { description: "Experiment, trials, and evaluations" } },
      }),
      validator("param", ExperimentParam),
      async (c) => c.json(await Research.history(Instance.project.id, c.req.valid("param").experimentId)),
    )
    .post(
      "/experiments/:experimentId/trials",
      describeRoute({
        summary: "Create an experiment trial",
        operationId: "research.trial.create",
        responses: { 200: { description: "Created trial" } },
      }),
      validator("param", ExperimentParam),
      validator("json", ResearchService.CreateTrialInput),
      async (c) =>
        c.json(
          await Research.createTrial(
            Instance.project.id,
            c.req.valid("param").experimentId,
            c.req.valid("json"),
          ),
        ),
    )
    .post(
      "/experiments/:experimentId/authored-trials",
      describeRoute({
        summary: "Author and freeze an experiment trial program",
        description: "Stores trial.py by content hash before creating the immutable trial record.",
        operationId: "research.trial.author",
        responses: { 200: { description: "Created content-addressed trial" } },
      }),
      validator("param", ExperimentParam),
      validator("json", ResearchPrograms.AuthorInput),
      async (c) => {
        const input = c.req.valid("json")
        const program = await ResearchPrograms.author(Instance.directory, input)
        return c.json(
          await Research.createTrial(Instance.project.id, c.req.valid("param").experimentId, {
            hypothesis: input.hypothesis,
            intent: input.intent,
            designAdapter: input.designAdapter,
            parentTrialId: input.parentTrialId,
            ...program,
          }),
        )
      },
    )
    .post(
      "/trials/:trialId/transition",
      describeRoute({
        summary: "Advance a trial lifecycle",
        operationId: "research.trial.transition",
        responses: { 200: { description: "Updated trial" } },
      }),
      validator("param", TrialParam),
      validator("json", z.object({ status: ResearchDomain.TrialStatus })),
      async (c) =>
        c.json(
          await Research.transitionTrial(
            Instance.project.id,
            c.req.valid("param").trialId,
            c.req.valid("json").status,
          ),
        ),
    )
    .post(
      "/trials/:trialId/evaluations",
      describeRoute({
        summary: "Record a locked trial evaluation",
        description: "Records the evaluation and atomically promotes the trial when its comparable score improves.",
        operationId: "research.evaluation.create",
        responses: { 200: { description: "Evaluation and promotion decision" } },
      }),
      validator("param", TrialParam),
      validator("json", ResearchService.RecordEvaluationInput),
      async (c) =>
        c.json(
          await Research.recordEvaluation(
            Instance.project.id,
            c.req.valid("param").trialId,
            c.req.valid("json"),
          ),
        ),
    )
    .post(
      "/trials/:trialId/run",
      describeRoute({
        summary: "Execute a trial through the scientific worker",
        description: "Creates an asynchronous, sandboxed compute run using the experiment's locked evaluator.",
        operationId: "research.run.start",
        responses: { 200: { description: "Started research run" } },
      }),
      validator("param", TrialParam),
      validator("json", z.object({ sessionID: z.string().startsWith("ses_") })),
      async (c) =>
        c.json(
          await ResearchExecution.start({
            trialId: c.req.valid("param").trialId,
            sessionId: c.req.valid("json").sessionID,
          }),
        ),
    )
    .get(
      "/runs/:runId",
      describeRoute({
        summary: "Get and reconcile a research run",
        operationId: "research.run.get",
        responses: { 200: { description: "Current research run" } },
      }),
      validator("param", RunParam),
      async (c) => c.json(await ResearchExecution.get(c.req.valid("param").runId)),
    )
    .post(
      "/runs/:runId/reconcile",
      describeRoute({
        summary: "Retry verified finalization after remote transport failure",
        operationId: "research.run.reconcile",
        responses: { 200: { description: "Reconciled research run" } },
      }),
      validator("param", RunParam),
      async (c) => c.json(await ResearchExecution.reconcile(c.req.valid("param").runId)),
    )
    .get(
      "/runs/:runId/artifacts",
      describeRoute({
        summary: "Read verified run evidence",
        description: "Revalidates the frozen manifest before returning candidates and evaluation evidence.",
        operationId: "research.run.artifacts",
        responses: { 200: { description: "Verified candidates, evaluation, and manifest" } },
      }),
      validator("param", RunParam),
      async (c) => c.json(await ResearchExecution.artifacts(c.req.valid("param").runId)),
    )
    .get(
      "/jobs",
      describeRoute({
        summary: "List durable research jobs",
        operationId: "research.job.list",
        responses: { 200: { description: "Project-scoped orchestration jobs" } },
      }),
      async (c) => c.json(await ResearchJobs.list(Instance.project.id)),
    )
    .get(
      "/jobs/:jobId",
      describeRoute({
        summary: "Get a durable research job",
        operationId: "research.job.get",
        responses: { 200: { description: "Current job state, attempts, error, and result" } },
      }),
      validator("param", JobParam),
      async (c) => c.json(await ResearchJobs.get(Instance.project.id, c.req.valid("param").jobId)),
    )
    .post(
      "/jobs/:jobId/cancel",
      describeRoute({
        summary: "Cancel a durable research job",
        operationId: "research.job.cancel",
        responses: { 200: { description: "Cancelled job" } },
      }),
      validator("param", JobParam),
      async (c) => {
        const jobId = c.req.valid("param").jobId
        const job = await ResearchJobs.cancel(Instance.project.id, jobId)
        ResearchJobRunner.abort(jobId)
        return c.json(job)
      },
    )
    .post(
      "/jobs/:jobId/retry",
      describeRoute({
        summary: "Retry a failed or cancelled durable research job",
        operationId: "research.job.retry",
        responses: { 200: { description: "Requeued job" } },
      }),
      validator("param", JobParam),
      async (c) => {
        const job = await ResearchJobs.retry(Instance.project.id, c.req.valid("param").jobId)
        ResearchJobRunner.wake()
        return c.json(job)
      },
    ),
)
