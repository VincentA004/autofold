import { describe, expect, test } from "bun:test"
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
})
