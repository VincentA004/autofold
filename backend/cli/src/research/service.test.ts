import { describe, expect, test } from "bun:test"
import { ResearchDomain } from "./domain"
import { ResearchService } from "./service"
import { MemoryResearchStore } from "./store"

const digest = (character: string) => `sha256:${character.repeat(64)}`

const contract: ResearchDomain.ExperimentContract = {
  version: 1,
  objective: "Discover binders for target X",
  targetArtifactHash: digest("a"),
  modality: "linear_minibinder",
  budget: {
    maximumCandidates: 1_000,
    gpuHours: 20,
    wallTimeMinutes: 180,
  },
  evaluator: {
    id: "peptide-panel",
    version: "1",
    sourceHash: digest("b"),
    direction: "minimize",
    fixedSeeds: [41, 42, 43],
    submissionSize: 20,
  },
}

function fixture() {
  let sequence = 0
  let seconds = 0
  const store = new MemoryResearchStore()
  const service = new ResearchService.Service(store, {
    id: (prefix) => `${prefix}_${++sequence}`,
    now: () => new Date(Date.UTC(2026, 7, 2, 0, 0, seconds++)).toISOString(),
  })
  return { store, service, projectId: "project-test" }
}

async function activeExperiment(service: ResearchService.Service, projectId: string) {
  const campaign = await service.createCampaign(projectId, { objective: "Find a target X binder" })
  await service.activateCampaign(projectId, campaign.id)
  const experiment = await service.createExperiment(projectId, campaign.id, { contract })
  return service.activateExperiment(projectId, experiment.id)
}

async function evaluatingTrial(service: ResearchService.Service, projectId: string, experimentId: string, label: string) {
  let trial = await service.createTrial(projectId, experimentId, {
    hypothesis: label,
    designAdapter: "mock",
    programPath: `trials/${label}.py`,
    programHash: digest(label === "baseline" ? "c" : "d"),
  })
  trial = await service.transitionTrial(projectId, trial.id, "queued")
  trial = await service.transitionTrial(projectId, trial.id, "running")
  return service.transitionTrial(projectId, trial.id, "evaluating")
}

describe("research service", () => {
  test("runs the campaign to incumbent lifecycle", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await evaluatingTrial(service, projectId, experiment.id, "baseline")
    const result = await service.recordEvaluation(projectId, trial.id, {
      contractHash: experiment.contractHash,
      evaluatorHash: experiment.contract.evaluator.sourceHash,
      valid: true,
      score: 0.42,
      diagnostics: { agreement: 0.81 },
    })

    expect(result.decision).toBe("promoted")
    expect(result.experiment.incumbentTrialId).toBe(trial.id)
    expect(result.trial.status).toBe("succeeded")

    const history = await service.history(projectId, experiment.id)
    expect(history.trials).toHaveLength(1)
    expect(history.evaluations).toHaveLength(1)
  })

  test("rejects a worse trial and parents it to the incumbent", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const baseline = await evaluatingTrial(service, projectId, experiment.id, "baseline")
    await service.recordEvaluation(projectId, baseline.id, {
      contractHash: experiment.contractHash,
      evaluatorHash: experiment.contract.evaluator.sourceHash,
      valid: true,
      score: 0.42,
      diagnostics: {},
    })

    const candidate = await evaluatingTrial(service, projectId, experiment.id, "candidate")
    expect(candidate.parentTrialId).toBe(baseline.id)
    const result = await service.recordEvaluation(projectId, candidate.id, {
      contractHash: experiment.contractHash,
      evaluatorHash: experiment.contract.evaluator.sourceHash,
      valid: true,
      score: 0.48,
      diagnostics: {},
    })

    expect(result.decision).toBe("rejected")
    expect(result.experiment.incumbentTrialId).toBe(baseline.id)
  })

  test("rejects an evaluation produced by another contract", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await evaluatingTrial(service, projectId, experiment.id, "baseline")

    await expect(
      service.recordEvaluation(projectId, trial.id, {
        contractHash: digest("f"),
        evaluatorHash: experiment.contract.evaluator.sourceHash,
        valid: true,
        score: 0.3,
        diagnostics: {},
      }),
    ).rejects.toBeInstanceOf(ResearchService.ConflictError)

    const history = await service.history(projectId, experiment.id)
    expect(history.evaluations).toHaveLength(0)
    expect(history.trials[0]?.status).toBe("evaluating")
  })

  test("requires active parents and legal trial transitions", async () => {
    const { service, projectId } = fixture()
    const campaign = await service.createCampaign(projectId, { objective: "Find a target X binder" })
    await expect(service.createExperiment(projectId, campaign.id, { contract })).rejects.toBeInstanceOf(
      ResearchService.ConflictError,
    )

    await service.activateCampaign(projectId, campaign.id)
    const experiment = await service.createExperiment(projectId, campaign.id, { contract })
    await expect(
      service.createTrial(projectId, experiment.id, {
        hypothesis: "Too early",
        designAdapter: "mock",
        programPath: "trials/too-early.py",
        programHash: digest("e"),
      }),
    ).rejects.toBeInstanceOf(ResearchService.ConflictError)

    await service.activateExperiment(projectId, experiment.id)
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "Baseline",
      designAdapter: "mock",
      programPath: "trials/baseline.py",
      programHash: digest("e"),
    })
    await expect(service.transitionTrial(projectId, trial.id, "succeeded")).rejects.toBeInstanceOf(
      ResearchService.ConflictError,
    )
  })

  test("cannot bypass the locked evaluator with a status transition", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await evaluatingTrial(service, projectId, experiment.id, "baseline")

    await expect(service.transitionTrial(projectId, trial.id, "succeeded")).rejects.toBeInstanceOf(
      ResearchService.ConflictError,
    )
    const history = await service.history(projectId, experiment.id)
    expect(history.trials[0]?.status).toBe("evaluating")
    expect(history.evaluations).toHaveLength(0)
  })
})
