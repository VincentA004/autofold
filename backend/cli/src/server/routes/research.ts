import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import {
  DesignAdapters,
  Research,
  ResearchArtifacts,
  ResearchDomain,
  ResearchExecution,
  ResearchPrograms,
  ResearchService,
} from "@/research"
import { lazy } from "@/util/lazy"

const CampaignParam = z.object({ campaignId: z.string().startsWith("cmp_") })
const KnowledgeParam = z.object({
  campaignId: z.string().startsWith("cmp_"),
  conceptId: z.string().regex(/^knw_[A-Za-z0-9_-]+$/),
})
const ExperimentParam = z.object({ experimentId: z.string().startsWith("exp_") })
const TrialParam = z.object({ trialId: z.string().startsWith("trl_") })
const RunParam = z.object({ runId: z.string().startsWith("run_") })

export const ResearchRoutes = lazy(() =>
  new Hono()
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
      async (c) =>
        c.json(
          await Research.createExperiment(
            Instance.project.id,
            c.req.valid("param").campaignId,
            c.req.valid("json"),
          ),
        ),
    )
    .post(
      "/experiments/:experimentId/activate",
      describeRoute({
        summary: "Freeze and activate an experiment",
        operationId: "research.experiment.activate",
        responses: { 200: { description: "Activated experiment" } },
      }),
      validator("param", ExperimentParam),
      async (c) =>
        c.json(await Research.activateExperiment(Instance.project.id, c.req.valid("param").experimentId)),
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
    ),
)
