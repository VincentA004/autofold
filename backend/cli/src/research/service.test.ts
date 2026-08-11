import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import matter from "gray-matter"
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

async function evaluatingTrial(
  service: ResearchService.Service,
  projectId: string,
  experimentId: string,
  label: string,
  intent: ResearchDomain.Trial["intent"] = "optimize",
) {
  let trial = await service.createTrial(projectId, experimentId, {
    hypothesis: label,
    intent,
    designAdapter: "mock",
    programPath: `trials/${label}.py`,
    programHash: digest(label === "baseline" ? "c" : "d"),
  })
  trial = await service.transitionTrial(projectId, trial.id, "queued")
  trial = await service.transitionTrial(projectId, trial.id, "running")
  return service.transitionTrial(projectId, trial.id, "evaluating")
}

describe("research service", () => {
  test("pins exact campaign skill versions on a trial", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const reference = {
      id: "skill_bionemo.sequence-design",
      version: 3,
      versionId: "skv_sequence_v3",
      contentHash: digest("e"),
    }
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "Use the replay-validated sequence policy",
      designAdapter: "mock",
      programPath: "trials/skill-pinned.py",
      programHash: digest("f"),
      skills: [reference],
    })
    expect(trial.skills).toEqual([reference])
  })

  test("atomically ingests a bounded literature-agent review", async () => {
    const { service, store, projectId } = fixture()
    const campaign = await service.createCampaign(projectId, { objective: "Find selective peptide binders" })
    await service.activateCampaign(projectId, campaign.id)
    const result = await service.ingestLiteratureReview(projectId, campaign.id, {
      generatedBy: "literature-review:ses_child",
      sources: [
        {
          key: "pubmed:7",
          database: "pubmed",
          sourceId: "7",
          title: "Primary interface study",
          summary: "A primary study of interface constraints.",
          excerpts: ["Hotspot constraints improved selective recovery."],
          url: "https://pubmed.ncbi.nlm.nih.gov/7/",
          query: "interface hotspot peptide design",
        },
      ],
      claims: [
        {
          kind: "design_rule",
          statement: "Hotspot constraints may improve selective recovery.",
          stance: "supports",
          confidence: 0.72,
          evidence: [{ sourceKey: "pubmed:7", excerpt: "Hotspot constraints improved selective recovery." }],
        },
      ],
      unresolvedQuestions: ["Does this transfer across target families?"],
    })
    expect(result.records).toHaveLength(1)
    expect(result.claims[0]?.evidence[0]?.literatureId).toBe(result.records[0]?.id)
    expect(result.claims[0]?.status).toBe("proposed")
    expect(result.cycle.outputs.claimIds).toEqual([result.claims[0]?.id])

    await expect(
      service.ingestLiteratureReview(projectId, campaign.id, {
        generatedBy: "literature-review:ses_bad",
        sources: [
          {
            key: "pubmed:8",
            database: "pubmed",
            sourceId: "8",
            title: "Another study",
            excerpts: ["The actual frozen excerpt."],
            query: "another query",
          },
        ],
        claims: [
          {
            kind: "hypothesis",
            statement: "Unsupported proposal",
            stance: "supports",
            confidence: 0.9,
            evidence: [{ sourceKey: "pubmed:8", excerpt: "A fabricated excerpt." }],
          },
        ],
        unresolvedQuestions: [],
      }),
    ).rejects.toBeInstanceOf(ResearchService.ConflictError)
    await expect(
      service.ingestLiteratureReview(projectId, campaign.id, {
        generatedBy: "literature-review:ses_bad_alignment",
        sources: [
          {
            key: "pubmed:9",
            database: "pubmed",
            sourceId: "9",
            title: "Alignment study",
            excerpts: ["A valid frozen excerpt."],
            query: "alignment query",
          },
        ],
        claims: [
          {
            kind: "hypothesis",
            statement: "A claim with an invalid graph edge.",
            stance: "supports",
            confidence: 0.5,
            evidence: [{ sourceKey: "pubmed:9", excerpt: "A valid frozen excerpt." }],
            alignments: [
              {
                knowledgeId: "knw_missing",
                relation: "supports",
                rationale: "This edge must not survive validation.",
              },
            ],
          },
        ],
        unresolvedQuestions: [],
      }),
    ).rejects.toBeInstanceOf(ResearchService.NotFoundError)
    const state = await store.read(projectId)
    expect(Object.values(state.literature)).toHaveLength(1)
    expect(Object.values(state.claims)).toHaveLength(1)
    expect(Object.values(state.knowledgeCycles)).toHaveLength(1)
  })

  test("aligns new experiment outcomes with literature inside one durable knowledge cycle", async () => {
    const { service, store, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await evaluatingTrial(service, projectId, experiment.id, "baseline")
    const evaluation = await service.recordEvaluation(projectId, trial.id, {
      contractHash: experiment.contractHash,
      evaluatorHash: experiment.contract.evaluator.sourceHash,
      valid: true,
      score: 0.42,
      diagnostics: { agreement: 0.81 },
    })

    const before = await service.knowledgeRefreshStatus(projectId, experiment.campaignId)
    expect(before.due).toBe(true)
    expect(before.unprocessedKnowledgeIds).toEqual([evaluation.knowledge.id])

    const result = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      generatedBy: "autofold-literature-review/ses_alignment",
      trigger: "run_completed",
      question: "Does published evidence explain the observed model agreement?",
      inputKnowledgeIds: [evaluation.knowledge.id],
      sources: [
        {
          key: "pubmed:alignment",
          database: "pubmed",
          sourceId: "alignment",
          title: "Independent predictor agreement study",
          excerpts: ["Independent predictors reduced false-positive selection."],
          query: "protein binder independent predictor agreement",
        },
      ],
      claims: [
        {
          kind: "design_rule",
          statement: "Independent predictors may reduce false-positive binder selection.",
          stance: "supports",
          confidence: 0.75,
          evidence: [
            { sourceKey: "pubmed:alignment", excerpt: "Independent predictors reduced false-positive selection." },
          ],
          alignments: [
            {
              knowledgeId: evaluation.knowledge.id,
              relation: "context",
              rationale: "The paper provides context for the locked evaluator's predictor-agreement diagnostic.",
            },
          ],
        },
      ],
      unresolvedQuestions: ["Does agreement correlate with measured affinity for this target?"],
      campaignSummary: "The baseline has promising predictor agreement, but experimental affinity remains unknown.",
      nextExperiment: {
        action: "continue_experiment",
        experimentId: experiment.id,
        hypothesis: "Improved predictor agreement increases quality-adjusted binder yield.",
        rationale: "This tests the strongest result while preserving the locked contract.",
        successCriterion: "The locked evaluator improves over the baseline score.",
      },
    })

    expect(result.alignments).toHaveLength(1)
    expect(result.alignments[0]).toMatchObject({
      claimId: result.claims[0]?.id,
      knowledgeId: evaluation.knowledge.id,
      relation: "context",
      status: "proposed",
    })
    expect(result.cycle.inputs.knowledgeIds).toEqual([evaluation.knowledge.id])
    expect(result.cycle.outputs.alignmentIds).toEqual([result.alignments[0]?.id])
    expect(result.cycle.campaignSummary).toContain("predictor agreement")
    expect(result.cycle.nextExperiment?.experimentId).toBe(experiment.id)
    const after = await service.knowledgeRefreshStatus(projectId, experiment.campaignId)
    expect(after.unprocessedKnowledgeIds).toEqual([])
    expect(after.due).toBe(false)
    const state = await store.read(projectId)
    expect(Object.values(state.alignments)).toEqual(result.alignments)
    expect(Object.values(state.knowledgeCycles)).toEqual([result.cycle])
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-knowledge-cycle-"))
    try {
      await service.publishCampaignKnowledge(projectId, experiment.campaignId, workspace)
      const root = path.join(workspace, ".autofold", "campaigns", experiment.campaignId, "knowledge")
      const alignment = matter(await Bun.file(path.join(root, "alignments", `${result.alignments[0]?.id}.md`)).text())
      const cycle = matter(await Bun.file(path.join(root, "cycles", `${result.cycle.id}.md`)).text())
      const claim = matter(await Bun.file(path.join(root, "claims", `${result.claims[0]?.id}.md`)).text())
      const renderedExperiment = matter(await Bun.file(path.join(root, "experiments", `${experiment.id}.md`)).text())
      const renderedTrial = matter(await Bun.file(path.join(root, "trials", `${trial.id}.md`)).text())
      expect(alignment.data.type).toBe("Evidence Alignment")
      expect(alignment.data.sources).toEqual([
        { id: "claim", resource: `/claims/${result.claims[0]?.id}.md` },
        { id: "outcome", resource: `/concepts/${evaluation.knowledge.id}.md` },
      ])
      expect(cycle.data.type).toBe("Knowledge Cycle")
      expect(cycle.data.stale_after).toBe("2026-08-09")
      expect(claim.data.status).toBe("draft")
      expect(claim.data.claim_status).toBe("proposed")
      expect(claim.data.sources[0].resource).toBe(`/sources/${result.records[0]?.id}.md`)
      expect(renderedExperiment.data.contract_hash).toBe(experiment.contractHash)
      expect(JSON.parse(renderedExperiment.content.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? "{}")).toEqual(experiment.contract)
      expect(renderedTrial.data.sources[0].resource).toBe(`/experiments/${experiment.id}.md`)
      expect(renderedTrial.data.program_hash).toBe(trial.programHash)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("compounds immutable literature records into evidence-linked campaign claims", async () => {
    const { service, store, projectId } = fixture()
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-literature-"))
    try {
      const campaign = await service.createCampaign(projectId, { objective: "Find a selective peptide binder" })
      await service.activateCampaign(projectId, campaign.id)
      const input = {
        database: "pubmed",
        sourceId: "12345",
        title: "A peptide binder design study",
        summary: "Interface hotspots improved binder recovery.",
        excerpts: [],
        url: "https://pubmed.ncbi.nlm.nih.gov/12345/",
        query: "peptide binder interface hotspots",
      }
      const first = await service.ingestLiterature(projectId, campaign.id, input)
      const duplicate = await service.ingestLiterature(projectId, campaign.id, input)
      expect(duplicate.id).toBe(first.id)
      const claim = await service.createClaim(projectId, campaign.id, {
        kind: "design_rule",
        statement: "Preserving target interface hotspots may improve binder recovery.",
        stance: "supports",
        confidence: 0.7,
        evidence: [{ literatureId: first.id, excerpt: "Interface hotspots improved binder recovery." }],
        generatedBy: "literature-agent",
      })
      expect(claim.status).toBe("proposed")
      const reviewed = await service.reviewClaim(projectId, campaign.id, claim.id, {
        status: "reviewed",
        reviewedBy: "human-reviewer",
      })
      expect(reviewed.reviewed?.by).toBe("human-reviewer")
      expect(await service.listLiterature(projectId, campaign.id)).toHaveLength(1)
      expect(await service.listClaims(projectId, campaign.id)).toEqual([reviewed])
      const state = await store.read(projectId)
      expect(Object.values(state.literature)).toEqual([first])
      expect(Object.values(state.claims)).toEqual([reviewed])

      await service.publishCampaignKnowledge(projectId, campaign.id, workspace)
      const root = path.join(workspace, ".autofold", "campaigns", campaign.id, "knowledge")
      const index = await Bun.file(path.join(root, "index.md")).text()
      const source = await Bun.file(path.join(root, "sources", `${first.id}.md`)).text()
      const renderedClaim = await Bun.file(path.join(root, "claims", `${reviewed.id}.md`)).text()
      expect(index).toContain("## Literature claims")
      expect(index).toContain(`claims/${reviewed.id}.md`)
      expect(source).toContain(first.contentHash)
      expect(renderedClaim).toContain(`../sources/${first.id}.md`)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

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
    const knowledge = await service.listKnowledge(projectId, experiment.campaignId)
    expect(knowledge).toHaveLength(1)
    expect(knowledge[0]?.decision).toBe("promoted")
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

  test("observes a valid negative control without replacing the incumbent", async () => {
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

    const control = await evaluatingTrial(service, projectId, experiment.id, "scrambled-control", "negative_control")
    const result = await service.recordEvaluation(projectId, control.id, {
      contractHash: experiment.contractHash,
      evaluatorHash: experiment.contract.evaluator.sourceHash,
      valid: true,
      score: 0.1,
      diagnostics: { agreement: 0.9 },
    })

    expect(control.parentTrialId).toBe(baseline.id)
    expect(result.decision).toBe("observed")
    expect(result.experiment.incumbentTrialId).toBe(baseline.id)
    expect(result.knowledge.decision).toBe("observed")
    expect(result.knowledge.status).toBe("stable")
    expect(result.knowledge.description).toContain("not promotion-eligible")
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

  test("atomically records valid run knowledge and writes a campaign OKF v0.2 bundle", async () => {
    const { service, store, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "Bundle-backed baseline",
      designAdapter: "mock",
      programPath: "trials/baseline.py",
      programHash: digest("c"),
    })
    const run = await service.beginRun(projectId, trial.id, {
      runId: "run_valid",
      bundlePath: ".autofold/runs/run_valid/bundle.json",
      outputPath: ".autofold/runs/run_valid/output",
    })
    await service.attachRunJob(projectId, run.id, "job-valid")
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-okf-"))

    try {
      const result = await service.completeRun(
        projectId,
        run.id,
        {
          contractHash: experiment.contractHash,
          evaluatorHash: experiment.contract.evaluator.sourceHash,
          valid: true,
          score: 0.31,
          diagnostics: { agreement: 0.91 },
        },
        digest("e"),
        workspace,
      )

      expect(result.decision).toBe("promoted")
      expect(result.knowledge.status).toBe("stable")
      expect(result.knowledge.verified).toEqual([
        { by: "process:autofold-locked-evaluator", at: result.evaluation.evaluatedAt },
      ])
      expect(result.knowledge.sources.map((source) => source.resource)).toEqual([
        "../../../../runs/run_valid/bundle.json",
        "../../../../runs/run_valid/output",
      ])
      expect(result.knowledge.provenance).toEqual({
        contractHash: experiment.contractHash,
        targetArtifactHash: experiment.contract.targetArtifactHash,
        evaluatorHash: experiment.contract.evaluator.sourceHash,
        programHash: trial.programHash,
        manifestHash: digest("e"),
      })

      const state = await store.read(projectId)
      expect(Object.values(state.evaluations)).toHaveLength(1)
      expect(Object.values(state.knowledge)).toEqual([result.knowledge])
      expect(state.runs[run.id]?.status).toBe("succeeded")

      const root = path.join(workspace, ".autofold", "campaigns", experiment.campaignId, "knowledge")
      const index = await Bun.file(path.join(root, "index.md")).text()
      const concept = await Bun.file(path.join(root, "concepts", `${result.knowledge.id}.md`)).text()
      expect(matter(index).data).toEqual({ okf_version: "0.2" })
      expect(index).toContain(`concepts/${result.knowledge.id}.md`)
      const frontmatter = matter(concept).data
      expect(frontmatter.type).toBe("Research Evaluation")
      expect(frontmatter.status).toBe("stable")
      expect(frontmatter.decision).toBe("promoted")
      expect(frontmatter.verified[0].by).toBe("process:autofold-locked-evaluator")
      expect(frontmatter.sources[0].resource).toBe("../../../../runs/run_valid/bundle.json")
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("records rejected invalid run knowledge without claiming machine verification", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "Invalid candidate set",
      designAdapter: "mock",
      programPath: "trials/invalid.py",
      programHash: digest("d"),
    })
    const run = await service.beginRun(projectId, trial.id, {
      runId: "run_invalid",
      bundlePath: ".autofold/runs/run_invalid/bundle.json",
      outputPath: ".autofold/runs/run_invalid/output",
    })
    await service.attachRunJob(projectId, run.id, "job-invalid")
    const result = await service.completeRun(
      projectId,
      run.id,
      {
        contractHash: experiment.contractHash,
        evaluatorHash: experiment.contract.evaluator.sourceHash,
        valid: false,
        score: null,
        diagnostics: { malformed: 1 },
      },
      digest("f"),
    )

    expect(result.decision).toBe("rejected")
    expect(result.knowledge.status).toBe("draft")
    expect(result.knowledge.verified).toBeUndefined()
    expect(result.knowledge.score).toBeNull()
    expect(await service.getKnowledge(projectId, experiment.campaignId, result.knowledge.id)).toEqual(result.knowledge)
  })

  test("records an idempotent unverified OKF concept for a terminal worker failure", async () => {
    const { service, store, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "Malformed worker program",
      designAdapter: "mock",
      programPath: "trials/failure.py",
      programHash: digest("f"),
    })
    const run = await service.beginRun(projectId, trial.id, {
      runId: "run_failure",
      bundlePath: ".autofold/runs/run_failure/bundle.json",
      outputPath: ".autofold/runs/run_failure/output",
    })
    await service.attachRunJob(projectId, run.id, "job-failure")
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-okf-failure-"))

    try {
      const failed = await service.failRun(projectId, run.id, "Worker exited with code 2", workspace)
      expect(failed.status).toBe("failed")
      await service.failRun(projectId, run.id, "A duplicate finalizer must not create another concept", workspace)

      const state = await store.read(projectId)
      const concepts = Object.values(state.knowledge)
      expect(concepts).toHaveLength(1)
      expect(concepts[0]).toMatchObject({
        type: "Research Failure",
        decision: "failed",
        status: "draft",
        score: null,
        error: "Worker exited with code 2",
        runId: run.id,
      })
      expect(concepts[0]?.evaluationId).toBeUndefined()
      expect(concepts[0]?.verified).toBeUndefined()
      expect(concepts[0]?.provenance).toEqual({
        contractHash: experiment.contractHash,
        targetArtifactHash: experiment.contract.targetArtifactHash,
        evaluatorHash: experiment.contract.evaluator.sourceHash,
        programHash: trial.programHash,
      })

      const root = path.join(workspace, ".autofold", "campaigns", experiment.campaignId, "knowledge")
      const index = await Bun.file(path.join(root, "index.md")).text()
      const concept = await Bun.file(path.join(root, "concepts", `${concepts[0]?.id}.md`)).text()
      expect(index).toContain("## Research knowledge")
      const frontmatter = matter(concept).data
      expect(frontmatter.type).toBe("Research Failure")
      expect(frontmatter.evaluation_id).toBeUndefined()
      expect(frontmatter.error).toBe("Worker exited with code 2")
      expect(frontmatter.sources[0].resource).toBe("autofold://runs/run_failure")
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("reuses the exact trial created by a replayed job phase", async () => {
    const { service, store, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const input = {
      hypothesis: "Checkpointed agent proposal",
      designAdapter: "proto" as const,
      programPath: "trials/checkpointed.py",
      programHash: digest("a"),
      origin: { jobId: "job_replay", phase: "iteration:1" },
    }
    const first = await service.createTrial(projectId, experiment.id, input)
    expect(await service.createTrial(projectId, experiment.id, input)).toEqual(first)
    expect(Object.values((await store.read(projectId)).trials)).toEqual([first])
    await expect(
      service.createTrial(projectId, experiment.id, { ...input, hypothesis: "Conflicting replay" }),
    ).rejects.toBeInstanceOf(ResearchService.ConflictError)
  })

  test("returns the committed knowledge cycle when its child proposal is replayed", async () => {
    const { service, store, projectId } = fixture()
    const campaign = await service.createCampaign(projectId, { objective: "Checkpoint knowledge ingestion" })
    await service.activateCampaign(projectId, campaign.id)
    const input = {
      generatedBy: "autofold-literature-review/ses_checkpoint",
      sources: [
        {
          key: "pubmed:checkpoint",
          database: "pubmed",
          sourceId: "checkpoint",
          title: "Checkpointed evidence",
          excerpts: ["This exact evidence was fetched."],
          query: "checkpoint peptide evidence",
        },
      ],
      claims: [
        {
          kind: "hypothesis" as const,
          statement: "Checkpointed evidence supports a bounded hypothesis.",
          stance: "supports" as const,
          confidence: 0.6,
          evidence: [{ sourceKey: "pubmed:checkpoint", excerpt: "This exact evidence was fetched." }],
        },
      ],
      unresolvedQuestions: ["Does the result reproduce experimentally?"],
    }
    const first = await service.ingestLiteratureReview(projectId, campaign.id, input)
    const replay = await service.ingestLiteratureReview(projectId, campaign.id, input)
    expect(replay).toEqual(first)
    const state = await store.read(projectId)
    expect(Object.values(state.knowledgeCycles)).toHaveLength(1)
    expect(Object.values(state.claims)).toHaveLength(1)
  })
})
