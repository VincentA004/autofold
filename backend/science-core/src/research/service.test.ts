import { ResearchScientistMemory } from "./scientist-memory"
import { ExperimentBranches } from "./experiment-branches"
import { ResearchQuestions } from "./research-questions"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import matter from "gray-matter"
import { ResearchDomain } from "./domain"
import { ResearchService } from "./service"
import { StorageResearchStore, MemoryResearchStore } from "./store"

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

test('fresh Proto records require explicit native admission while mechanism and intent remain separate', async () => {
  const {service, store, projectId} = fixture(), experiment = await activeExperiment(service, projectId)
  const input = {hypothesis: 'Native mechanism requires host admission', designAdapter: 'proto' as const, programPath: 'trial.py', programHash: digest('a')}
  await expect(service.createTrial(projectId, experiment.id, input)).rejects.toMatchObject({data: {code: 'native_protocol_required'}})
  await expect(service.createTrial(projectId, experiment.id, {...input, executionProtocol: 'native_fixed_control_v1'})).rejects.toMatchObject({data: {code: 'native_protocol_mismatch'}})
  const searched = await service.createTrial(projectId, experiment.id, {...input, intent: 'calibrate', executionProtocol: 'native_search_v1'})
  expect(searched.executionProtocol).toBe('native_search_v1')
  expect(Object.hasOwn(searched,'generationSeed')).toBe(false)
  expect(Object.values((await store.read(projectId)).trials)).toHaveLength(1)
  const seeded=await service.createTrial(projectId,experiment.id,{...input,hypothesis:'Host-bound generation seed',executionProtocol:'native_search_v1',generationSeed:0xffff_ffff})
  expect(seeded.generationSeed).toBe(0xffff_ffff)
})

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
  test("activates long campaign objectives without truncating charter intent or overflowing the default success criterion", async () => {
    for (const objective of ["Evidence ".repeat(280), "Discovery ".repeat(600), "🧬候補を比較する ".repeat(650)]) {
      const { service, store, projectId } = fixture()
      const campaign = await service.createCampaign(projectId, { objective })
      await service.activateCampaign(projectId, campaign.id)
      const state = await store.read(projectId)
      const charter = state.campaignCharters[campaign.id]!
      expect(state.campaigns[campaign.id]!.status).toBe("active")
      expect(charter.objective).toBe(objective.trim())
      expect(charter.successCriteria[0]!.statement).toContain("full campaign objective recorded in this charter")
      expect(charter.successCriteria[0]!.statement.length).toBeLessThanOrEqual(2000)
      expect((await service.campaignResearchState(projectId, campaign.id)).charter).toEqual(charter)
    }
  })

  test("reopens a persisted long campaign charter with its full objective and existing criterion intact", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-long-charter-"))
    try {
      const projectId = "long-charter-storage", objective = "Preserve the complete scientific objective. ".repeat(150)
      const first = new ResearchService.Service(new StorageResearchStore({ directory: workspace }))
      const campaign = await first.createCampaign(projectId, { objective })
      await first.activateCampaign(projectId, campaign.id)
      const before = (await first.campaignResearchState(projectId, campaign.id)).charter
      const reopened = new ResearchService.Service(new StorageResearchStore({ directory: workspace }))
      expect((await reopened.campaignResearchState(projectId, campaign.id)).charter).toEqual(before)
      expect(before.objective).toBe(objective.trim())
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("empirical closeout does not establish or postpone the semantic wiki review watermark", async () => {
    const {service, projectId} = fixture()
    const experiment = await activeExperiment(service, projectId)
    const closeout = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      sources: [], claims: [], unresolvedQuestions: ["What independent evidence is still needed?"], generatedBy: "trusted-closeout:first", trigger: "run_completed", campaignSummary: "One locked observation; no semantic source review.",
    })
    const before = await service.knowledgeRefreshStatus(projectId, experiment.campaignId)
    expect(before.reasons).toContain("no_prior_knowledge_cycle")
    expect(before.nextReviewAt).toBeUndefined()
    const review = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      sources: [], claims: [], unresolvedQuestions: ["What independent evidence is still needed?"], generatedBy: "pi-literature:review", trigger: "manual", campaignSummary: "Reconciled prior evidence and open hypotheses.",
    })
    await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      sources: [], claims: [], unresolvedQuestions: ["What independent evidence is still needed?"], generatedBy: "trusted-closeout:second", trigger: "run_completed", campaignSummary: "Another empirical observation.",
    })
    const after = await service.knowledgeRefreshStatus(projectId, experiment.campaignId)
    expect(after.reasons).not.toContain("no_prior_knowledge_cycle")
    expect(after.nextReviewAt).toBe(review.cycle.nextReviewAt)
    expect(after.nextReviewAt).not.toBe(closeout.cycle.nextReviewAt)
  })

  test("repeated citations and reviewed wiki claims do not manufacture computational support", async () => {
    const {service, store, projectId} = fixture()
    const experiment = await activeExperiment(service, projectId)
    const literature = await service.ingestLiterature(projectId, experiment.campaignId, {
      database: "fixture", sourceId: "citation-only", title: "Source interpretation", query: "limitations",
      excerpts: ["Predictions require independent measurement."],
    })
    const claim = await service.createClaim(projectId, experiment.campaignId, {
      kind: "hypothesis", statement: "The predicted candidate might bind.", stance: "supports", confidence: 0.9,
      evidence: [{literatureId: literature.id, excerpt: literature.excerpts[0]}], generatedBy: "literature-agent",
    })
    await service.reviewClaim(projectId, experiment.campaignId, claim.id, {status: "reviewed", reviewedBy: "separate-reviewer"})
    const update = {category: "biology" as const, statement: "The candidate is a physically confirmed binder.", status: "supported" as const,
      confidence: 0.9, evidenceLevel: "experimentally_confirmed" as const, supportingEvidenceRefs: [claim.id, literature.id], opposingEvidenceRefs: [],
      prediction: "A matched assay will detect binding.", falsificationCriterion: "The assay fails to detect binding.", recommendedExperiment: "Obtain independent measurement.", limitations: []}
    const first = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      generatedBy: "wiki:first", sources: [], claims: [], unresolvedQuestions: ["Which independent measurement supports binding?"], hypothesisUpdates: [update],
    })
    const hypothesisId = first.cycle.outputs.hypothesisIds[0]!
    let hypothesis = (await store.read(projectId)).hypotheses[hypothesisId]!
    expect(hypothesis.evidenceLevel).toBe("model_observation")
    expect(hypothesis.statement).toBe("The candidate is a hypothesized binder.")
    expect(hypothesis.limitations.join(" ")).toContain("at most model_observation")
    await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      generatedBy: "wiki:repetition", sources: [], claims: [], unresolvedQuestions: ["Independent measurement still absent."],
      hypothesisUpdates: [{...update, hypothesisId, supportingEvidenceRefs: [hypothesisId]}],
    })
    hypothesis = (await store.read(projectId)).hypotheses[hypothesisId]!
    expect(hypothesis.evidenceLevel).toBe("model_observation")
    expect(Object.keys((await store.read(projectId)).evaluations)).toHaveLength(0)
  })

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
      generators: ["boltzgen-binder"],
      generatorAllocations: [{ generator: "boltzgen-binder", maximumCandidates: 12, maximumGpuSeconds: 900 }],
    })
    expect(trial.skills).toEqual([reference])
    expect(trial.generators).toEqual(["boltzgen-binder"])
    expect(trial.generatorAllocations).toEqual([
      { generator: "boltzgen-binder", maximumCandidates: 12, maximumGpuSeconds: 900 },
    ])
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
    expect(result.cycle.inputs).toEqual({ knowledgeIds: [], claimIds: [], literatureIds: [] })

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
    const priorLiterature = await service.ingestLiterature(projectId, experiment.campaignId, {
      database: "pubmed", sourceId: "prior", title: "Prior context", summary: "Context visible to the review.",
      excerpts: ["This prior context is frozen but did not cause the current review."], query: "prior context",
    })
    const priorClaim = await service.createClaim(projectId, experiment.campaignId, {
      kind: "limitation", statement: "Prior context may not apply.", stance: "context", confidence: 0.5,
      evidence: [{ literatureId: priorLiterature.id, excerpt: priorLiterature.excerpts[0] }], generatedBy: "fixture",
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
    expect(result.cycle.inputs).toEqual({ knowledgeIds: [evaluation.knowledge.id], claimIds: [], literatureIds: [] })
    expect(result.cycle.inputs.claimIds).not.toContain(priorClaim.id)
    expect(result.cycle.inputs.literatureIds).not.toContain(priorLiterature.id)

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

  test("atomically reinforces a typed hypothesis and trusted search landscape without upgrading computational evidence to experimental confirmation", async () => {
    const { service, store, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "A cross-model portfolio will retain its ranking across the frozen seeds.",
      generators:["boltzgen-binder","pxdesign-binder"],
      designAdapter: "mock",
      programPath: "trials/recursive-state.py",
      programHash: digest("e"),
    })
    const run = await service.beginRun(projectId, trial.id, {
      bundlePath: ".autofold/runs/run/bundle.json",
      outputPath: ".autofold/runs/run/output",
    })
    await service.attachRunJob(projectId, run.id, "compute-one")
    const completed = await service.completeRun(projectId, run.id, {
      contractHash: experiment.contractHash,
      evaluatorHash: experiment.contract.evaluator.sourceHash,
      valid: true,
      score: 0.31,
      diagnostics: { panel_diversity: 0.8 },
    }, digest("f"))

    const review = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      generatedBy: "autofold-literature-review/ses_recursive_state",
      trigger: "run_completed",
      inputKnowledgeIds: [completed.knowledge.id],
      sources: [],
      claims: [],
      unresolvedQuestions: ["Physical binding remains experimentally unresolved."],
      searchObservations: [{
        experimentId: experiment.id,
        trialId: trial.id,
        runId: run.id,
        evaluationId: completed.evaluation.id,
        knowledgeId: completed.knowledge.id,
        intent: "optimize",
        programHash: trial.programHash,
        pipelineHash: digest("1"),
        generatorPortfolio: ["boltzgen-binder", "pxdesign-binder"],
        candidateSequences: ["ACDEFGHIK"],
        modelIds: ["boltz2-prediction", "chai1-prediction"],
        seeds: [41, 42],
        score: completed.evaluation.score,
        decision: completed.decision,
        diagnostics: completed.evaluation.diagnostics,
        hypothesis: trial.hypothesis,
      }],
      hypothesisUpdates: [{
        category: "biology",
        statement: "The candidate is a physically confirmed selective binder.",
        status: "supported",
        confidence: 0.9,
        evidenceLevel: "experimentally_confirmed",
        supportingEvidenceRefs: [completed.knowledge.id],
        opposingEvidenceRefs: [],
        prediction: "Independent assays will reproduce selective binding.",
        falsificationCriterion: "A matched experimental assay fails to detect selective binding.",
        recommendedExperiment: "Run a matched physical binding and selectivity assay.",
        limitations: [],
      }],
    })

    const state = await store.read(projectId)
    const observation = Object.values(state.searchObservations)[0]!
    const hypothesis = Object.values(state.hypotheses)[0]!
    expect(observation).toMatchObject({
      knowledgeId: completed.knowledge.id,
      epistemicLevel: "multi_seed_support",
      generatorPortfolio: ["boltzgen-binder", "pxdesign-binder"],
    })
    expect(hypothesis.evidenceLevel).toBe("multi_seed_support")
    expect(hypothesis.statement).toBe("The candidate is a computationally supported selective binder.")
    expect(hypothesis.limitations.join(" ")).toContain("computational evidence cannot establish physical binding")
    expect(hypothesis.limitations.join(" ")).toContain("trusted service bounded it to computational support")
    expect(review.cycle.outputs.hypothesisIds).toEqual([hypothesis.id])
    expect(review.cycle.outputs.searchObservationIds).toEqual([observation.id])
    expect((await service.campaignResearchState(projectId, experiment.campaignId)).charter.constraints)
      .toMatchObject({ requireMatchedControlCardinality: true, requireMultiSeedConfirmation: true })
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
        summary: "A model-authored summary says interface hotspots improved binder recovery.",
        excerpts: ["Interface hotspots improved binder recovery."],
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
      await expect(service.createClaim(projectId, campaign.id, {
        kind: "design_rule", statement: "An uncited paraphrase must not become evidence.", stance: "supports",
        confidence: 0.7, evidence: [{ literatureId: first.id }], generatedBy: "literature-agent",
      })).rejects.toMatchObject({ data: { code: "claim_excerpt_not_frozen" } })
      await expect(service.createClaim(projectId, campaign.id, {
        kind: "design_rule",
        statement: "A summary-only statement must not become evidence.",
        stance: "supports",
        confidence: 0.7,
        evidence: [{ literatureId: first.id, excerpt: input.summary }],
        generatedBy: "literature-agent",
      })).rejects.toMatchObject({ data: { code: "claim_excerpt_not_frozen" } })
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

      await service.ingestLiteratureReview(projectId, experiment.campaignId, {
        generatedBy: "autofold-trusted-failure-closeout/v1",
        trigger: "run_completed",
        inputKnowledgeIds: [concepts[0]!.id],
        sources: [],
        claims: [],
        unresolvedQuestions: ["Can the repaired execution path complete the frozen evaluator?"],
        searchObservations: [{
          experimentId: experiment.id,
          trialId: trial.id,
          runId: run.id,
          knowledgeId: concepts[0]!.id,
          intent: trial.intent,
          programHash: trial.programHash,
          generatorPortfolio: ["boltzgen-binder", "pxdesign-binder"],
          candidateSequences: [],
          modelIds: ["boltz2-prediction", "chai1-prediction"],
          seeds: [41, 42],
          score: null,
          decision: "failed",
          diagnostics: {},
          hypothesis: trial.hypothesis,
        }],
      })
      const failureObservation = (await service.listSearchObservations(projectId, experiment.campaignId))[0]
      expect(failureObservation?.epistemicLevel).toBe("model_observation")

      const root = path.join(workspace, ".autofold", "campaigns", experiment.campaignId, "knowledge")
      const index = await Bun.file(path.join(root, "index.md")).text()
      const concept = await Bun.file(path.join(root, "concepts", `${concepts[0]?.id}.md`)).text()
      expect(index).toContain("## Research knowledge")
      const frontmatter = matter(concept).data
      expect(frontmatter.type).toBe("Research Failure")
      expect(frontmatter.evaluation_id).toBeUndefined()
      expect(frontmatter.error).toBe("Worker exited with code 2")
      expect(frontmatter.sources[0].resource).toBe("autofold://runs/run_failure")

      const failedEvent = {
        experimentId: experiment.id, campaignId: experiment.campaignId, contractHash: experiment.contractHash,
        iteration: 1, status: "run_failed" as const, trialId: trial.id, runId: run.id,
        programHash: trial.programHash, hypothesis: trial.hypothesis, error: "Worker exited with code 2", decision: "failed" as const,
      }
      await ResearchScientistMemory.append(failedEvent, workspace)
      const reopened = await service.reopenRunFinalization(projectId, run.id)
      expect(reopened).toMatchObject({ id: run.id, status: "running", jobId: "job-failure" })
      expect(reopened.error).toBeUndefined()
      expect((await service.getTrialContext(projectId, trial.id)).trial.status).toBe("running")
      await expect(service.reopenRunFinalization(projectId, run.id)).rejects.toBeInstanceOf(
        ResearchService.ConflictError,
      )
      await service.completeRun(projectId, run.id, {
        contractHash: experiment.contractHash,
        evaluatorHash: experiment.contract.evaluator.sourceHash,
        valid: true,
        score: 0.25,
        diagnostics: { recovered: 1 },
      }, digest("9"), workspace)
      const recoveredState = await store.read(projectId)
      expect(recoveredState.knowledge[concepts[0]!.id]).toMatchObject({
        status: "deprecated",
        tags: expect.arrayContaining(["recovered", "superseded-by-evaluation"]),
      })
      expect(Object.values(recoveredState.knowledge)).toContainEqual(
        expect.objectContaining({ type: "Research Evaluation", runId: run.id, status: "stable" }),
      )
      expect(Object.values(recoveredState.evaluations).filter(e => e.trialId === trial.id)).toHaveLength(1)

    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("reuses the exact trial created by a replayed job phase", async () => {
    const { service, store, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const input = {
      hypothesis: "Checkpointed agent proposal",
      designAdapter: "proto" as const, executionProtocol: "native_search_v1" as const,
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
    await store.mutate(projectId, state => {state.experiments[experiment.id]!.status="paused";state.campaigns[experiment.campaignId]!.status="paused"})
    expect(await service.createTrial(projectId,experiment.id,input)).toEqual(first)
    await expect(service.createTrial(projectId,experiment.id,{...input,origin:{jobId:"job_replay",phase:"iteration:2"}})).rejects.toMatchObject({data:{code:"experiment_not_active"}})
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


test("campaign GPU reservations include shadow replay and survive failed runs", async () => {
  const { service, store, projectId } = fixture()
  const experiment = await activeExperiment(service, projectId)
  await service.campaignResearchState(projectId, experiment.campaignId)
  await store.mutate(projectId, (state) => {
    state.campaignCharters[experiment.campaignId]!.constraints.maximumCampaignGpuHours = contract.budget.gpuHours
  })
  const first = await service.createTrial(projectId, experiment.id, {
    hypothesis: "Replay shares campaign compute", intent: "shadow_replay", designAdapter: "mock",
    programPath: "replay.py", programHash: digest("e"),
  })
  const run = await service.beginRun(projectId, first.id, { bundlePath: "bundle.json", outputPath: "output" })
  await service.failRun(projectId, run.id, "Unknown remote termination")
  const next = await service.createTrial(projectId, experiment.id, {
    hypothesis: "Another draw", designAdapter: "mock", programPath: "next.py", programHash: digest("f"),
  })
  await expect(service.beginRun(projectId, next.id, { bundlePath: "next.json", outputPath: "next" })).rejects.toMatchObject({ data: { code: "campaign_gpu_budget_exhausted" } })
  const state = await service.campaignResearchState(projectId, experiment.campaignId)
  expect(state.resources.allocatedGpuHours).toBe(contract.budget.gpuHours)
  expect(state.resources.remainingGpuHours).toBe(0)
  expect(state.resources.entries[0]?.intent).toBe("shadow_replay")
})

test("run compute identity is durable before launch and mismatched attachment cannot replace it", async () => {
  const { service, projectId } = fixture()
  const experiment = await activeExperiment(service, projectId)
  const trial = await service.createTrial(projectId, experiment.id, {
    hypothesis: "Persist launch identity", designAdapter: "mock", programPath: "identity.py", programHash: digest("d"),
  })
  const queued = await service.beginRun(projectId, trial.id, {
    runId: "run_durable", bundlePath: "bundle.json", outputPath: "output", jobId: "research-run_durable",
  })
  expect(queued).toMatchObject({ status: "queued", jobId: "research-run_durable" })
  expect(await service.getActiveRunForTrial(projectId, trial.id)).toEqual(queued)
  await expect(service.attachRunJob(projectId, queued.id, "research-wrong"))
    .rejects.toMatchObject({ data: { code: "run_compute_job_mismatch" } })
  expect(await service.getRun(projectId, queued.id)).toEqual(queued)
  const running = await service.attachRunJob(projectId, queued.id, "research-run_durable")
  expect(running.status).toBe("running")
  expect(await service.attachRunJob(projectId, queued.id, "research-run_durable")).toEqual(running)
  expect(await service.getActiveRunForTrial(projectId, trial.id)).toEqual(running)
})

describe("durable research-question lifecycle", () => {
  test("scientist research requests persist without a run and explicit reopen preserves identity", async () => {
    const { store, service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const request = {
      action: "create" as const,
      question: "Does the source sequence apply to this target?",
      competingExplanations: ["The sequence is target matched", "The sequence belongs to another target"],
      requiredEvidence: "A frozen primary-source passage naming the target and sequence",
      applicabilityChecks: "Match target identity and assay context",
      decisionIfResolved: "Admit or reject the source-backed calibration",
    }
    const created = await service.requestResearch(projectId, experiment.id, {
      request,
      evidenceRefs: [experiment.id],
      generatedBy: "scientist:job_one",
    })
    expect(created).toEqual({ requestId: expect.stringMatching(/^rq_/), status: "open", scheduledAction: "iterate_experiment" })
    expect(await service.requestResearch(projectId, experiment.id, {
      request,
      evidenceRefs: [experiment.id],
      generatedBy: "scientist:job_one",
    })).toEqual(created)
    const restarted = new ResearchService.Service(store)
    expect((await restarted.campaignResearchState(projectId, experiment.campaignId)).researchQuestions[0]).toMatchObject({
      requestId: created.requestId,
      experimentId: experiment.id,
      status: "open",
      evidenceRefs: [experiment.id],
    })
    await expect(service.requestResearch(projectId, experiment.id, {
      request: { ...request, action: "reference", existingRequestId: created.requestId },
      generatedBy: "scientist:annotation",
    })).rejects.toThrow("schedules no work")

    const assessed = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      generatedBy: "literature-review:research-request",
      sources: [{ key: "pubmed:request", database: "pubmed", sourceId: "request", title: "Target sequence study",
        excerpts: ["The stated sequence was evaluated against the matched target."], query: "matched target sequence" }],
      claims: [],
      unresolvedQuestions: ["Physical validation remains outstanding."],
      researchRequestUpdates: [{ requestId: created.requestId, expectedRevision: null, status: "answered",
        assessment: "The cited record names the matched target.", remainingGap: "Physical validation remains outstanding.",
        nextAction: "Use the sequence as a computational calibration.", sourceKeys: ["pubmed:request"] }],
    })
    const reopen = {
      ...request,
      action: "reopen" as const,
      existingRequestId: created.requestId,
      expectedRevision: assessed.cycle.id,
      reopenReason: "A new full-text source can resolve the remaining assay-context gap",
    }
    await expect(service.requestResearch(projectId, experiment.id, {
      request: { ...reopen, question: "Does a different sequence apply?" },
      generatedBy: "scientist:job_two",
    })).rejects.toMatchObject({ data: { code: "invalid_research_request_reopen", message: expect.stringContaining("action=create") } })
    const reopened = await service.requestResearch(projectId, experiment.id, {
      request: reopen,
      evidenceRefs: [assessed.records[0]!.id],
      generatedBy: "scientist:job_two",
    })
    expect(reopened).toEqual({ ...created, status: "open", scheduledAction: "iterate_experiment" })
    expect(await service.requestResearch(projectId, experiment.id, {
      request: reopen,
      evidenceRefs: [assessed.records[0]!.id],
      generatedBy: "scientist:job_two",
    })).toEqual(reopened)
    const resolvedAgain = await service.ingestLiteratureReview(projectId, experiment.campaignId, {
      generatedBy: "literature-review:after-reopen", sources: [], claims: [],
      unresolvedQuestions: ["The reopened question remains blocked."],
      researchRequestUpdates: [{ requestId: created.requestId, expectedRevision: assessed.cycle.id, status: "blocked",
        assessment: "The new source was unavailable.", remainingGap: "Full text is still unavailable.",
        nextAction: "Wait for repository access.", sourceKeys: [] }],
    })
    expect(resolvedAgain.cycle.outputs.researchRequestUpdates[0]?.status).toBe("blocked")
    await expect(service.requestResearch(projectId, experiment.id, {
      request: reopen,
      evidenceRefs: [assessed.records[0]!.id],
      generatedBy: "scientist:job_two",
    })).rejects.toMatchObject({ data: { code: "research_request_retry_stale" } })
    const state = await store.read(projectId)
    expect(Object.values(state.researchRequests)).toHaveLength(2)
    expect((await service.campaignResearchState(projectId, experiment.campaignId)).researchQuestions[0]).toMatchObject({
      requestId: created.requestId,
      status: "blocked",
      revision: resolvedAgain.cycle.id,
      nextAction: "Wait for repository access.",
    })
  })

  test("atomic evidence assessment, idempotent retry, recovery, stale rejection, block and reopen", async () => {
    const { store, service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const request = { question: "Does the evidence apply?", competingExplanations: ["site mismatch", "model error"],
      requiredEvidence: "Matched controls", applicabilityChecks: "Same epitope", decisionIfResolved: "Select next test" }
    const observation = ResearchDomain.SearchObservation.parse({ id: "sobs_question", campaignId: experiment.campaignId,
      experimentId: experiment.id, trialId: "trl_question", runId: "run_question", knowledgeId: "knw_question",
      knowledgeCycleId: "kcy_origin", intent: "optimize", programHash: digest("a"), generatorPortfolio: [],
      candidateSequences: [], modelIds: [], seeds: [41], score: 0.2, decision: "rejected", diagnostics: {},
      hypothesis: "Test applicability", epistemicLevel: "computational_support", createdAt: "2026-08-01T00:00:00Z",
      decisionPlan: { question: "Which test?", researchRequest: request, alternatives: [
        {id:"a",experiment:"A",expectedInformation:"A",estimatedGpuHours:1},
        {id:"b",experiment:"B",expectedInformation:"B",estimatedGpuHours:1}], selectedAlternativeId:"a",
        rationale:"Resolve a gap",evidenceRefs:[],outcomeBranches:[{observation:"A",nextDecision:"A"},{observation:"B",nextDecision:"B"}] },
    })
    await store.mutate(projectId, state => { state.searchObservations[observation.id] = observation })
    expect((await service.knowledgeRefreshStatus(projectId, experiment.campaignId)).reasons).toContain("open_research_questions")
    const update = {requestId:observation.id, expectedRevision:null, status:"answered" as const,
      assessment:"Source supports applicability under stated conditions",remainingGap:"Physical binding untested",
      nextAction:"Design matched test",sourceKeys:["source"]}
    const review = {generatedBy:"question-review", sources:[{key:"source",database:"pubmed",sourceId:"1",
      title:"Control study",query:"matched controls",excerpts:["Matched controls were evaluated."]}],
      claims:[],unresolvedQuestions:["Physical binding"],researchRequestUpdates:[update]}
    await expect(service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,
      researchRequestUpdates:[{...update,sourceKeys:["missing"]}]})).rejects.toThrow("source key")
    expect(Object.keys((await store.read(projectId)).literature)).toHaveLength(0)
    const first = await service.ingestLiteratureReview(projectId, experiment.campaignId, review)
    expect((await service.ingestLiteratureReview(projectId, experiment.campaignId, review)).cycle.id).toBe(first.cycle.id)
    const state = await store.read(projectId)
    const queue = ResearchQuestions.project(JSON.parse(JSON.stringify(Object.values(state.searchObservations))),
      JSON.parse(JSON.stringify(Object.values(state.knowledgeCycles))))
    expect(queue[0]).toMatchObject({status:"answered",revision:first.cycle.id,runId:"run_question",
      literatureIds:[first.records[0].id],remainingGap:"Physical binding untested"})
    expect((await service.knowledgeRefreshStatus(projectId, experiment.campaignId)).reasons).not.toContain("open_research_questions")
    await expect(service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,generatedBy:"stale"})).rejects.toThrow("Stale")
    expect(Object.keys((await store.read(projectId)).knowledgeCycles)).toHaveLength(1)
    const blocked = await service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,generatedBy:"blocked",
      sources:[],researchRequestUpdates:[{...update,expectedRevision:first.cycle.id,status:"blocked",sourceKeys:[]}]})
    expect((await service.knowledgeRefreshStatus(projectId, experiment.campaignId)).reasons).not.toContain("open_research_questions")
    const reopened = await service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,generatedBy:"reopened",
      sources:[],researchRequestUpdates:[{...update,expectedRevision:blocked.cycle.id,status:"open",sourceKeys:[],reopenReason:"New full-text retrieval capability"}]})
    expect((await service.knowledgeRefreshStatus(projectId, experiment.campaignId)).reasons).toContain("open_research_questions")
    expect(ResearchQuestions.project([observation],[reopened.cycle,first.cycle,blocked.cycle])[0].revision).toBe(reopened.cycle.id)
    await expect(service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,generatedBy:"no-evidence",
      sources:[],researchRequestUpdates:[{...update,expectedRevision:reopened.cycle.id,sourceKeys:[]}]})).rejects.toThrow("require frozen")
    await expect(service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,generatedBy:"foreign",
      researchRequestUpdates:[{...update,requestId:"sobs_foreign"}]})).rejects.toThrow("Unknown")
    await service.ingestLiteratureReview(projectId, experiment.campaignId, { ...review, generatedBy:"blocked-again",
      sources:[], researchRequestUpdates:[{...update,expectedRevision:reopened.cycle.id,status:"blocked",sourceKeys:[]}] })
    await store.mutate(projectId, state => { state.searchObservations.sobs_repeat = { ...observation,
      id:"sobs_repeat",runId:"run_repeat", createdAt:"2026-09-08T00:00:00Z", decisionPlan:{...observation.decisionPlan!,
        researchRequest:{...request,applicabilityChecks:"Same site, additional diagnostic predictor"}} } })
    const rebuilt = await new ResearchService.Service(store).campaignResearchState(projectId, experiment.campaignId)
    expect(rebuilt.researchQuestions).toHaveLength(1)
    expect(rebuilt.researchQuestions[0]).toMatchObject({status:"blocked",occurrenceIds:[observation.id,"sobs_repeat"]})
    expect((await service.knowledgeRefreshStatus(projectId,experiment.campaignId)).reasons).not.toContain("open_research_questions")
    await expect(service.ingestLiteratureReview(projectId, experiment.campaignId, {...review,generatedBy:"silent-reopen",sources:[],
      researchRequestUpdates:[{...update,expectedRevision:rebuilt.researchQuestions[0].revision,status:"open",sourceKeys:[]}]})).rejects.toThrow("requires a concrete")
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"question-okf-"))
    try { await service.publishCampaignKnowledge(projectId,experiment.campaignId,dir)
      const body=await fs.readFile(path.join(dir,".autofold","campaigns",experiment.campaignId,"knowledge","cycles",first.cycle.id+".md"),"utf8")
      expect(body).toContain("Research question updates")
      expect(body).toContain(first.records[0].id)
    } finally { await fs.rm(dir,{recursive:true,force:true}) }
  })
})

describe("executable experiment frontier", () => {
  test("ordinary program files retain independent revision ancestry across service reconstruction", async () => {
    const { store, service, projectId } = fixture()
    const exp = await activeExperiment(service, projectId)
    const input = { program: "a1", draftPath: "programs/a.py", title: "A", rationale: "Explore", revisitWhen: "After evidence", evidenceRefs: [] }
    const a = await service.saveExperimentBranch(projectId, exp.id, input)
    await service.restoreExperimentBranch(projectId, exp.id, a.id)
    const b = await service.saveExperimentBranch(projectId, exp.id, { ...input, program: "b1", draftPath: "programs/b.py" })
    expect(b.parentBranchId).toBeUndefined()
    const restarted = new ResearchService.Service(store)
    const a2 = await restarted.saveExperimentBranch(projectId, exp.id, { ...input, program: "a2" })
    expect(a2.parentBranchId).toBe(a.id)
    const child = await restarted.saveExperimentBranch(projectId, exp.id, { ...input, program: "b-child", draftPath: "programs/child.py", parentBranchId: b.id })
    expect(child.parentBranchId).toBe(b.id)
    expect((await restarted.saveExperimentBranch(projectId, exp.id, { ...input, program: "a2" })).id).toBe(a2.id)
    await expect(restarted.saveExperimentBranch(projectId, exp.id, { ...input, program: "bad", parentBranchId: "brn_missing" })).rejects.toThrow("Invalid branch parent")
    expect((await restarted.experimentBranches(projectId, exp.id))).toHaveLength(4)
    await restarted.bindExperimentDraft(projectId, exp.id, "new-job/trial.py", "a2")
    await restarted.bindExperimentDraft(projectId, exp.id, "new-job/trial.py", "b1") // must not reset after resume
    const continued = await restarted.saveExperimentBranch(projectId, exp.id, { ...input, program: "a3", draftPath: "new-job/trial.py" })
    expect(continued.parentBranchId).toBe(a2.id)
    const independent = await restarted.saveExperimentBranch(projectId, exp.id, { ...input, program: "root", draftPath: "other/trial.py", parentBranchId: null })
    expect(independent.parentBranchId).toBeUndefined()
  })

  test("branches, restores, revisits and rebuilds outcomes in OKF without compute", async () => {
    const {store,service,projectId}=fixture()
    const exp=await activeExperiment(service,projectId)
    const input={program:"def build_trial(ctx): return root\n",title:"Root",rationale:"Baseline alternative",revisitWhen:"New evidence",evidenceRefs:[]}
    const root=await service.saveExperimentBranch(projectId,exp.id,input)
    expect((await service.saveExperimentBranch(projectId,exp.id,input)).id).toBe(root.id)
    await service.restoreExperimentBranch(projectId,exp.id,root.id)
    const a=await service.saveExperimentBranch(projectId,exp.id,{...input,program:"def build_trial(ctx): return option_a\n",title:"A"})
    await service.restoreExperimentBranch(projectId,exp.id,a.id)
    const child=await service.saveExperimentBranch(projectId,exp.id,{...input,program:"def build_trial(ctx): return child\n",title:"Child"})
    await service.restoreExperimentBranch(projectId,exp.id,root.id)
    const b=await service.saveExperimentBranch(projectId,exp.id,{...input,program:"def build_trial(ctx): return option_b\n",title:"B"})
    expect(a.parentBranchId).toBe(root.id);expect(b.parentBranchId).toBe(root.id);expect(child.parentBranchId).toBe(a.id)
    expect((await service.readExperimentBranch(projectId,exp.id,a.id)).program).toBe(a.program)
    expect((await service.experimentBranches(projectId,exp.id)).find(x=>x.selected)?.id).toBe(root.id)
    const deferred=await service.updateExperimentBranch(projectId,exp.id,{action:"status",branchId:a.id,expectedRevision:0,status:"deferred",rationale:"Need calibration",revisitWhen:"Controls ready"})
    expect(deferred.history).toHaveLength(2)
    await expect(service.restoreExperimentBranch(projectId,exp.id,a.id)).rejects.toThrow("Reopen")
    await expect(service.updateExperimentBranch(projectId,exp.id,{action:"status",branchId:a.id,expectedRevision:0,status:"open",rationale:"Evidence arrived",revisitWhen:"Now"})).rejects.toThrow("Stale")
    await service.updateExperimentBranch(projectId,exp.id,{action:"status",branchId:a.id,expectedRevision:1,status:"open",rationale:"Controls ready",revisitWhen:"Now"})
    await service.restoreExperimentBranch(projectId,exp.id,a.id)
    await store.mutate(projectId,state=>{state.searchObservations.sobs_branch=ResearchDomain.SearchObservation.parse({
      id:"sobs_branch",campaignId:exp.campaignId,experimentId:exp.id,trialId:"trl_branch",runId:"run_branch",
      knowledgeId:"knw_branch",knowledgeCycleId:"kcy_branch",intent:"optimize",programHash:a.programHash,
      generatorPortfolio:[],candidateSequences:[],modelIds:[],seeds:[41],score:0.2,decision:"rejected",diagnostics:{},
      hypothesis:"Result of A",epistemicLevel:"computational_support",createdAt:"2026-08-02T00:00:00Z"})})
    const recovered=new ResearchService.Service(store)
    const frontier=await recovered.experimentBranches(projectId,exp.id)
    expect(frontier).toHaveLength(4)
    expect(frontier.find(x=>x.id===a.id)?.outcomes[0]).toMatchObject({runId:"run_branch",knowledgeCycleId:"kcy_branch",score:0.2})
    expect(frontier.find(x=>x.id===b.id)?.outcomes).toEqual([])
    expect(Object.keys((await store.read(projectId)).runs)).toHaveLength(0)
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"branch-okf-"))
    try {await recovered.publishCampaignKnowledge(projectId,exp.campaignId,dir)
      const folder=path.join(dir,".autofold","campaigns",exp.campaignId,"knowledge","branches")
      expect(await fs.readFile(path.join(folder,a.id+".py"),"utf8")).toBe(a.program)
      const page=await fs.readFile(path.join(folder,a.id+".md"),"utf8")
      expect(page).toContain("kcy_branch");expect(page).toContain(root.id)
    } finally {await fs.rm(dir,{recursive:true,force:true})}
  })
  test("prevents cross-experiment restores and corrupt source restoration", async()=>{
    const {store,service,projectId}=fixture();const a=await activeExperiment(service,projectId);const b=await activeExperiment(service,projectId)
    const branch=await service.saveExperimentBranch(projectId,a.id,{program:"source",title:"A",rationale:"A",revisitWhen:"A",evidenceRefs:[]})
    await expect(service.restoreExperimentBranch(projectId,b.id,branch.id)).rejects.toThrow("outside")
    await store.mutate(projectId,s=>{s.experimentBranches[branch.id].program="tampered"})
    await expect(service.restoreExperimentBranch(projectId,a.id,branch.id)).rejects.toThrow("integrity")
    expect(ExperimentBranches.hash("source")).toBe(branch.programHash)
  })

  test("shared evidence scope admits campaign literature and reports exact cross-boundary offenders", async () => {
    const { service, projectId } = fixture()
    const experiment = await activeExperiment(service, projectId)
    const sibling = await service.createExperiment(projectId, experiment.campaignId, { contract })
    await expect(service.requestResearch(projectId, sibling.id, { generatedBy: "scientist:draft",
      request: { action: "create", question: "Should a draft experiment schedule research?", competingExplanations: ["yes", "no"],
        requiredEvidence: "An active frozen experiment", applicabilityChecks: "Check lifecycle status", decisionIfResolved: "Schedule or wait" } }))
      .rejects.toMatchObject({ data: { code: "experiment_not_active" } })
    const literature = await service.ingestLiterature(projectId, experiment.campaignId, {
      database: "pubmed", sourceId: "shared", title: "Campaign-wide source",
      excerpts: ["Campaign evidence can inform more than one frozen experiment."], query: "campaign evidence",
    })
    const input = { program: "source", title: "Evidence-scoped branch", rationale: "Cite persisted evidence",
      revisitWhen: "More evidence", evidenceRefs: [literature.id] }
    expect((await service.campaignResearchState(projectId, experiment.campaignId)).evidenceCatalog)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: literature.id, kind: "literature" }),
        expect.objectContaining({ id: sibling.id, kind: "experiment", experimentId: sibling.id })]))
    expect((await service.saveExperimentBranch(projectId, experiment.id, input)).evidenceRefs).toEqual([literature.id])
    await expect(service.saveExperimentBranch(projectId, experiment.id, { ...input, program: "sibling", evidenceRefs: [sibling.id] }))
      .rejects.toMatchObject({ data: { code: "evidence_outside_scope", message: expect.stringContaining(`${sibling.id} (outside_experiment`) } })
    const foreignCampaign = await service.createCampaign(projectId, { objective: "Foreign campaign" })
    await expect(service.saveExperimentBranch(projectId, experiment.id, { ...input, program: "foreign", evidenceRefs: [foreignCampaign.id] }))
      .rejects.toMatchObject({ data: { code: "evidence_outside_scope", message: expect.stringContaining(`${foreignCampaign.id} (outside_campaign`) } })
    await expect(service.saveExperimentBranch(projectId, experiment.id, { ...input, program: "unknown", evidenceRefs: ["lit_missing"] }))
      .rejects.toMatchObject({ data: { code: "evidence_outside_scope", message: expect.stringContaining("lit_missing (unknown") } })
  })
})


test("SQLite service reconstruction preserves a completed run and incumbent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-persistence-lifecycle-"))
  try {
    const projectId = "prj_lifecycle"
    const service = new ResearchService.Service(new StorageResearchStore({ directory }))
    const experiment = await activeExperiment(service, projectId)
    const trial = await service.createTrial(projectId, experiment.id, {
      hypothesis: "Persistent bounded mock trial", designAdapter: "mock", programPath: "trial.py", programHash: digest("d"),
    })
    const run = await service.beginRun(projectId, trial.id, { bundlePath: "bundle.json", outputPath: "output" })
    await service.attachRunJob(projectId, run.id, "local-compute-fixture")
    const completed = await service.completeRun(projectId, run.id, {
      contractHash: experiment.contractHash, evaluatorHash: contract.evaluator.sourceHash,
      valid: true, score: 0.25, diagnostics: { confidence: 0.75 },
    }, digest("e"))
    expect(completed.decision).toBe("promoted")
    const reopened = new ResearchService.Service(new StorageResearchStore({ directory }))
    expect(await reopened.getRun(projectId, run.id)).toEqual(completed.run)
    const history = await reopened.history(projectId, experiment.id)
    expect(history.experiment.incumbentTrialId).toBe(trial.id)
    expect(history.evaluations).toContainEqual(completed.evaluation)
    expect((await reopened.getTrialContext(projectId, trial.id)).trial.status).toBe("succeeded")
    expect(await reopened.cancelRun(projectId, run.id)).toEqual(completed.run)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("run cancellation is terminal, idempotent, and creates no scientific failure claim", async () => {
  const { service, store, projectId } = fixture()
  const experiment = await activeExperiment(service, projectId)
  const trial = await service.createTrial(projectId, experiment.id, {
    hypothesis: "Cancelled execution", designAdapter: "mock", programPath: "cancel.py", programHash: digest("d"),
  })
  const run = await service.beginRun(projectId, trial.id, { bundlePath: "bundle.json", outputPath: "output" })
  await service.attachRunJob(projectId, run.id, "local-cancel-fixture")
  const cancelled = await service.cancelRun(projectId, run.id, "Operator cancellation")
  expect(cancelled.status).toBe("cancelled")
  expect(await service.cancelRun(projectId, run.id, "Repeated cancellation")).toEqual(cancelled)
  expect((await service.getTrialContext(projectId, trial.id)).trial.status).toBe("cancelled")
  const state = await store.read(projectId)
  expect(Object.values(state.knowledge)).toEqual([])
  expect(Object.values(state.evaluations)).toEqual([])
  await expect(service.completeRun(projectId, run.id, {
    contractHash: experiment.contractHash, evaluatorHash: contract.evaluator.sourceHash,
    valid: true, score: 0.1, diagnostics: {},
  }, digest("e"))).rejects.toBeInstanceOf(ResearchService.ConflictError)
})

test("typed research routing binds a knowledge prerequisite to an intact branch without changing the draft cursor", async () => {
 const {store,service,projectId}=fixture(),exp=await activeExperiment(service,projectId),other=await activeExperiment(service,projectId)
 const branch=await service.saveExperimentBranch(projectId,exp.id,{program:"frozen source",title:"Intervention",rationale:"Bound knowledge",revisitWhen:"Evidence available",evidenceRefs:[]})
 const request={action:"create" as const,purpose:"knowledge_lookup" as const,prerequisiteBranchId:branch.id,question:"Does the residue map apply to this intervention?",competingExplanations:["Correct map","Incorrect map"],requiredEvidence:"Original residue map",applicabilityChecks:"Frozen structure",decisionIfResolved:"Admit this branch"}
 const before=(await store.read(projectId)).branchCursors
 await expect(service.requestResearch(projectId,other.id,{request,generatedBy:"scientist:other"})).rejects.toMatchObject({data:{code:"invalid_research_prerequisite_branch"}})
 const accepted=await service.requestResearch(projectId,exp.id,{request,generatedBy:"scientist:bound"})
 expect(accepted.scheduledAction).toBe("iterate_experiment")
 expect((await store.read(projectId)).branchCursors).toEqual(before)
 const question=(await service.campaignResearchState(projectId,exp.campaignId)).researchQuestions[0]!
 expect(ResearchQuestions.blocksExperiment(question)).toBe(false);expect(ResearchQuestions.blocksBranch(question,branch.id)).toBe(false)
 const empirical=await service.requestResearch(projectId,exp.id,{request:{...request,prerequisiteBranchId:undefined,purpose:"empirical_test",question:"Would independent repeats change the conclusion?"},generatedBy:"scientist:replicate"})
 expect(empirical.scheduledAction).toBe("iterate_experiment")
 await store.mutate(projectId,state=>{state.experimentBranches[branch.id]!.program="tampered"})
 await expect(service.requestResearch(projectId,exp.id,{request,generatedBy:"scientist:tampered"})).rejects.toMatchObject({data:{code:"invalid_research_prerequisite_branch"}})
})


test('explicit run IDs preserve original binding and return identical original admission idempotently', async () => {
  const {service, store, projectId} = fixture(), experiment = await activeExperiment(service, projectId)
  const input = {hypothesis:'Original identity fixture', designAdapter:'mock' as const, programPath:'fixture.py', programHash:digest('e')}
  const first = await service.createTrial(projectId, experiment.id, input)
  const second = await service.createTrial(projectId, experiment.id, {...input, hypothesis:'Conflicting original'})
  const paths = {runId:'run_explicit_original', bundlePath:'original/bundle.json', outputPath:'original/output', jobId:'job_original_compute'}
  const original = await service.beginRun(projectId, first.id, paths), before = await store.read(projectId)
  expect(await service.beginRun(projectId, first.id, paths)).toEqual(original)
  await expect(service.beginRun(projectId, second.id, paths)).rejects.toMatchObject({data:{code:'run_identity_conflict'}})
  await expect(service.beginRun(projectId, first.id, {...paths, bundlePath:'replacement/bundle.json'})).rejects.toMatchObject({data:{code:'run_identity_conflict'}})
  expect(await store.read(projectId)).toEqual(before)
})
