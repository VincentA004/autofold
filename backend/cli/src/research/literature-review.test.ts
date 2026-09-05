import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchDomain } from "./domain"
import { ResearchLiteratureReview } from "./literature-review"

const timestamp = "2026-08-07T12:00:00.000Z"

function campaign(): ResearchDomain.Campaign {
  return ResearchDomain.Campaign.parse({
    id: "cmp_review",
    projectId: "project-review",
    objective: "Find selective peptide binders",
    status: "active",
    knowledgeCatalogId: "okf_review",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

describe("bounded literature review", () => {
  test("confines a trajectory closeout continuation to its frozen experiment", () => {
    expect(() => ResearchLiteratureReview.verifyFocusExperimentBoundary({
      action: "continue_experiment",
      experimentId: "exp_other",
      hypothesis: "Continue elsewhere",
      rationale: "Wrong trajectory",
      successCriterion: "A score",
    }, "exp_focus")).toThrow("cannot continue a different experiment")
  })

  test("compacts recursive knowledge context while preserving exact scientific provenance", () => {
    const huge = "mechanistic narrative ".repeat(600)
    const concept = ResearchDomain.KnowledgeConcept.parse({
      id: "knw_compact", campaignId: "cmp_review", experimentId: "exp_compact", trialId: "trl_compact",
      evaluationId: "evl_compact", runId: "run_compact", type: "Research Evaluation", title: huge,
      description: huge, tags: ["portfolio"], sources: [{ id: "run_compact", resource: "runs/run_compact" }],
      generated: { by: "test", at: timestamp }, verified: [{ by: "test", at: timestamp }], status: "stable",
      score: 0.21, decision: "promoted", diagnostics: { predictor_disagreement: 0.28 },
      provenance: {
        contractHash: `sha256:${"a".repeat(64)}`, evaluatorHash: `sha256:${"b".repeat(64)}`,
        programHash: `sha256:${"c".repeat(64)}`, manifestHash: `sha256:${"d".repeat(64)}`,
      },
      createdAt: timestamp,
    })
    const literature = ResearchDomain.LiteratureRecord.parse({
      id: "lit_compact", campaignId: "cmp_review", database: "pubmed", sourceId: "123",
      title: huge, summary: huge, excerpts: [huge.slice(0, 4_000)], query: huge,
      contentHash: `sha256:${"e".repeat(64)}`, retrievedAt: timestamp,
    })
    const claim = ResearchDomain.KnowledgeClaim.parse({
      id: "clm_compact", campaignId: "cmp_review", kind: "design_rule", statement: huge.slice(0, 8_000),
      stance: "supports", confidence: 0.7, evidence: [{ literatureId: "lit_compact", excerpt: huge.slice(0, 4_000) }],
      status: "proposed", generated: { by: "test", at: timestamp }, createdAt: timestamp,
    })
    const modelEvidence = {
      candidateId: "candidate_exact", modelId: "boltz2", seed: 20260809, status: "completed" as const,
      metrics: { confidence_score: 0.91, nativeNarrative: huge },
    } as unknown as ResearchLiteratureReview.Context["newRunEvidence"][number]["modelEvidence"][number]
    const context: ResearchLiteratureReview.Context = {
      campaign: campaign(),
      experiments: [],
      runKnowledge: Array.from({ length: 30 }, () => concept),
      literature: Array.from({ length: 50 }, () => literature),
      claims: Array.from({ length: 50 }, () => claim),
      alignments: [],
      cycles: [],
      newRunKnowledge: Array.from({ length: 30 }, () => concept),
      newRunEvidence: [{
        knowledgeId: concept.id,
        runId: "run_compact",
        trial: ResearchDomain.Trial.parse({
          id: "trl_compact", experimentId: "exp_compact", hypothesis: huge, intent: "optimize",
          designAdapter: "proto", programPath: ".autofold/trial.py", programHash: `sha256:${"c".repeat(64)}`,
          status: "succeeded", createdAt: timestamp, updatedAt: timestamp,
        }),
        candidates: [{ id: "candidate_exact", sequence: "SAEEELRKLREELE", narrative: huge }],
        evaluation: { id: "evl_compact", score: 0.21, diagnostics: { predictor_disagreement: 0.28 } },
        pipeline: { stages: Array.from({ length: 60 }, (_, index) => ({ id: `stage_${index}`, narrative: huge })) },
        pipelineHash: `sha256:${"f".repeat(64)}`,
        modelEvidence: Array.from({ length: 50 }, () => modelEvidence),
      }],
    }
    const serialized = JSON.stringify(ResearchLiteratureReview.compactKnowledgePacket(context, {
      question: "What should the next iteration test?", maxSources: 8, maxClaims: 8,
    }))
    expect(serialized.length).toBeLessThan(140_000)
    expect(serialized).toContain("SAEEELRKLREELE")
    expect(serialized).toContain("run_compact")
    expect(serialized).toContain(`sha256:${"f".repeat(64)}`)
    expect(serialized).toContain('"seed":20260809')
    expect(serialized).toContain('"confidence_score":0.91')
    expect(serialized).not.toContain(huge)
  })

  test("scaffolds a readable agent artifact without overwriting resumed work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-literature-draft-"))
    const file = path.join(root, "nested", "review.json")
    try {
      await ResearchLiteratureReview.prepareAgentDraft(file)
      expect(await fs.readFile(file, "utf8")).toBe("{}\n")
      await fs.writeFile(file, '{"preserved":true}\n')
      await ResearchLiteratureReview.prepareAgentDraft(file)
      expect(await fs.readFile(file, "utf8")).toBe('{"preserved":true}\n')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("requires both resume identifiers", () => {
    expect(
      ResearchLiteratureReview.Input.safeParse({
        campaignId: "cmp_review",
        sessionId: "ses_parent",
        resumeProposalPath: ".autofold/literature-reviews/cmp_review/review.json",
      }).success,
    ).toBe(false)
    expect(
      ResearchLiteratureReview.Input.safeParse({
        campaignId: "cmp_review",
        sessionId: "ses_parent",
        resumeProposalPath: ".autofold/literature-reviews/cmp_review/review.json",
        resumeChildSessionId: "ses_child",
      }).success,
    ).toBe(true)
  })

  test("binds every frozen excerpt to the exact fetched record", () => {
    const artifact = {
      sources: [
        {
          key: "pubmed:1",
          database: "pubmed",
          sourceId: "1",
          title: "Interface constraint study",
          excerpts: ["Hotspot constraints increased selective recovery."],
          query: "peptide interface constraints",
        },
      ],
      claims: [
        {
          kind: "design_rule" as const,
          statement: "Hotspot constraints may improve selective recovery.",
          stance: "supports" as const,
          confidence: 0.7,
          evidence: [{ sourceKey: "pubmed:1", excerpt: "Hotspot constraints increased selective recovery." }],
        },
      ],
      unresolvedQuestions: [],
      campaignSummary: "One source supports testing hotspot constraints.",
      nextExperiment: {
        action: "new_experiment" as const,
        hypothesis: "Hotspot constraints improve selective recovery.",
        rationale: "This directly tests the source-backed design rule.",
        successCriterion: "The locked score improves over the baseline.",
      },
    }
    expect(() =>
      ResearchLiteratureReview.verifyFetchedExcerpts(artifact, [
        {
          tool: "science_fetch",
          input: { db: "pubmed", id: "1" },
          output: '{"abstract":"Hotspot constraints increased selective recovery."}',
        },
      ]),
    ).not.toThrow()
    expect(() =>
      ResearchLiteratureReview.verifyFetchedExcerpts(artifact, [
        {
          tool: "science_fetch",
          input: { db: "pubmed", id: "1" },
          output: '{"abstract":"Hotspot constraints\\n  increased selective recovery.","note":"A \\"quoted\\" field."}',
        },
      ]),
    ).not.toThrow()
    expect(() =>
      ResearchLiteratureReview.verifyFetchedExcerpts(artifact, [
        {
          tool: "science_fetch",
          input: { db: "pubmed", id: "1" },
          output: '{"abstract":"Hotspot constraints\n  increased selective recovery."}',
        },
      ]),
    ).not.toThrow()
    expect(() =>
      ResearchLiteratureReview.verifyFetchedExcerpts(artifact, [
        { tool: "science_fetch", input: { db: "pubmed", id: "1" }, output: '{"abstract":"Different evidence."}' },
      ]),
    ).toThrow("does not occur")
  })

  test("persists a validated dynamic-agent proposal", async () => {
    const events: string[] = []
    const result = await ResearchLiteratureReview.run(
      {
        campaignId: "cmp_review",
        sessionId: "ses_parent",
        question: "Which interface constraints improve peptide selectivity?",
        maxSources: 3,
        maxClaims: 2,
      },
      {
        context: async () => ({
          campaign: campaign(),
          experiments: [],
          runKnowledge: [],
          literature: [],
          claims: [],
          alignments: [],
          cycles: [],
          newRunKnowledge: [],
          newRunEvidence: [],
        }),
        propose: async () => {
          events.push("propose")
          return {
            childSessionId: "ses_child",
            proposalPath: ".autofold/literature-reviews/cmp_review/review.json",
            artifact: {
              sources: [
                {
                  key: "pubmed:1",
                  database: "pubmed",
                  sourceId: "1",
                  title: "Interface constraint study",
                  summary: "A primary peptide design study.",
                  excerpts: ["Hotspot constraints increased selective recovery."],
                  url: "https://pubmed.ncbi.nlm.nih.gov/1/",
                  query: "peptide interface constraints",
                },
              ],
              claims: [
                {
                  kind: "design_rule",
                  statement: "Hotspot constraints may improve selective recovery.",
                  stance: "supports",
                  confidence: 0.7,
                  evidence: [{ sourceKey: "pubmed:1", excerpt: "Hotspot constraints increased selective recovery." }],
                },
              ],
              unresolvedQuestions: ["Does the effect transfer across target families?"],
              campaignSummary: "Hotspot constraints are promising, but transfer remains unresolved.",
              nextExperiment: {
                action: "new_experiment",
                hypothesis: "Hotspot constraints improve selective peptide recovery.",
                rationale: "It is the strongest source-backed unresolved design rule.",
                successCriterion: "The locked evaluator improves over the current baseline.",
              },
            },
          }
        },
        persist: async ({ proposal }) => {
          events.push("persist")
          const source = proposal.artifact.sources[0]!
          return {
            records: [
              ResearchDomain.LiteratureRecord.parse({
                id: "lit_1",
                campaignId: "cmp_review",
                database: source.database,
                sourceId: source.sourceId,
                title: source.title,
                summary: source.summary,
                excerpts: source.excerpts,
                url: source.url,
                query: source.query,
                contentHash: `sha256:${"a".repeat(64)}`,
                retrievedAt: timestamp,
              }),
            ],
            claims: [
              ResearchDomain.KnowledgeClaim.parse({
                id: "clm_1",
                campaignId: "cmp_review",
                kind: "design_rule",
                statement: "Hotspot constraints may improve selective recovery.",
                stance: "supports",
                confidence: 0.7,
                evidence: [{ literatureId: "lit_1", excerpt: "Hotspot constraints increased selective recovery." }],
                status: "proposed",
                generated: { by: "literature-review:ses_child", at: timestamp },
                createdAt: timestamp,
              }),
            ],
            alignments: [],
            cycle: ResearchDomain.KnowledgeCycle.parse({
              id: "kcy_1",
              campaignId: "cmp_review",
              trigger: "literature_review",
              question: "Which interface constraints improve peptide selectivity?",
              inputs: { knowledgeIds: [], claimIds: [], literatureIds: [] },
              outputs: { literatureIds: ["lit_1"], claimIds: ["clm_1"], alignmentIds: [], unresolvedQuestions: proposal.artifact.unresolvedQuestions },
              generated: { by: "autofold-literature-review/ses_child", at: timestamp },
              campaignSummary: proposal.artifact.campaignSummary,
              nextExperiment: proposal.artifact.nextExperiment,
              createdAt: timestamp,
              nextReviewAt: "2026-08-14T12:00:00.000Z",
            }),
            unresolvedQuestions: proposal.artifact.unresolvedQuestions,
          }
        },
      },
    )
    expect(events).toEqual(["propose", "persist"])
    expect(result.childSessionId).toBe("ses_child")
    expect(result.records).toHaveLength(1)
    expect(result.claims[0]?.status).toBe("proposed")
    expect(result.cycle.id).toBe("kcy_1")
    expect(result.campaignSummary).toBe("Hotspot constraints are promising, but transfer remains unresolved.")
    expect(result.nextExperiment.action).toBe("new_experiment")
    expect(result.unresolvedQuestions).toEqual(["Does the effect transfer across target families?"])
  })

  test("enforces the campaign source budget before persistence", async () => {
    let persisted = false
    await expect(
      ResearchLiteratureReview.run(
        { campaignId: "cmp_review", sessionId: "ses_parent", maxSources: 1, maxClaims: 1 },
        {
          context: async () => ({
            campaign: campaign(),
            experiments: [],
            runKnowledge: [],
            literature: [],
            claims: [],
            alignments: [],
          cycles: [],
          newRunKnowledge: [],
          newRunEvidence: [],
          }),
          propose: async () => ({
            childSessionId: "ses_child",
            proposalPath: "review.json",
            artifact: {
              sources: ["1", "2"].map((id) => ({
                key: `pubmed:${id}`,
                database: "pubmed",
                sourceId: id,
                title: `Study ${id}`,
                excerpts: [`Evidence ${id}`],
                query: "query",
              })),
              claims: [
                {
                  kind: "hypothesis",
                  statement: "Bounded hypothesis",
                  stance: "context",
                  confidence: 0.5,
                  evidence: [{ sourceKey: "pubmed:1", excerpt: "Evidence 1" }],
                },
              ],
              unresolvedQuestions: [],
              campaignSummary: "Two sources inform one bounded hypothesis.",
              nextExperiment: {
                action: "new_experiment",
                hypothesis: "Test the bounded hypothesis.",
                rationale: "It would resolve the main uncertainty.",
                successCriterion: "The locked evaluator improves.",
              },
            },
          }),
          persist: async () => {
            persisted = true
            return {
              records: [],
              claims: [],
              alignments: [],
              cycle: ResearchDomain.KnowledgeCycle.parse({
                id: "kcy_unused",
                campaignId: "cmp_review",
                trigger: "literature_review",
                question: "unused",
                inputs: { knowledgeIds: [], claimIds: [], literatureIds: [] },
                outputs: { literatureIds: [], claimIds: [], alignmentIds: [], unresolvedQuestions: [] },
                generated: { by: "autofold-literature-review/test", at: timestamp },
                createdAt: timestamp,
                nextReviewAt: "2026-08-14T12:00:00.000Z",
              }),
              unresolvedQuestions: [],
            }
          },
        },
      ),
    ).rejects.toThrow("maximum is 1")
    expect(persisted).toBe(false)
  })

  test("rejects a continuation that explicitly requires a new experiment contract", async () => {
    let persisted = false
    await expect(
      ResearchLiteratureReview.run(
        { campaignId: "cmp_review", sessionId: "ses_parent", maxSources: 1, maxClaims: 1 },
        {
          context: async () => ({
            campaign: campaign(),
            experiments: [],
            runKnowledge: [],
            literature: [],
            claims: [],
            alignments: [],
            cycles: [],
            newRunKnowledge: [],
            newRunEvidence: [],
          }),
          propose: async () => ({
            childSessionId: "ses_child",
            proposalPath: "review.json",
            artifact: {
              sources: [],
              claims: [],
              unresolvedQuestions: [],
              campaignSummary: "Target specificity remains unresolved.",
              nextExperiment: {
                action: "continue_experiment",
                experimentId: "exp_review",
                hypothesis: "Score the incumbent against an unrelated receptor.",
                rationale: "Changing the target requires a new experiment contract.",
                successCriterion: "Observe the locked result without cross-contract comparison.",
              },
            },
          }),
          persist: async () => {
            persisted = true
            throw new Error("should not persist")
          },
        },
      ),
    ).rejects.toThrow("use new_experiment")
    expect(persisted).toBe(false)
  })
})
