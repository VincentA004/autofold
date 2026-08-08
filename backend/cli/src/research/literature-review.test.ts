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
            unresolvedQuestions: proposal.artifact.unresolvedQuestions,
          }
        },
      },
    )
    expect(events).toEqual(["propose", "persist"])
    expect(result.childSessionId).toBe("ses_child")
    expect(result.records).toHaveLength(1)
    expect(result.claims[0]?.status).toBe("proposed")
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
            },
          }),
          persist: async () => {
            persisted = true
            return { records: [], claims: [], unresolvedQuestions: [] }
          },
        },
      ),
    ).rejects.toThrow("maximum is 1")
    expect(persisted).toBe(false)
  })
})
