import z from "zod"
import { Instance } from "@/project/instance"
import { registry } from "@/science/connectors"
import { Research } from "./service"

const DEFAULT_DATABASES = ["pubmed", "europepmc", "openalex"]

export namespace ResearchLiterature {
  export const SearchInput = z.object({
    campaignId: z.string().startsWith("cmp_"),
    query: z.string().trim().min(1).max(2_000),
    databases: z.array(z.string().trim().min(1)).min(1).max(10).default(DEFAULT_DATABASES),
    limit: z.number().int().min(1).max(20).default(5),
  })
  export type SearchInput = z.infer<typeof SearchInput>

  export const SearchResult = z.object({
    query: z.string(),
    databases: z.array(z.string()),
    records: z.array(z.unknown()),
    errors: z.array(z.object({ database: z.string(), message: z.string() })),
  })
  export type SearchResult = z.infer<typeof SearchResult>

  export async function search(raw: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    const input = SearchInput.parse(raw)
    const connectors = input.databases.map((database) => {
      const connector = registry.get(database)
      if (!connector || connector.domain !== "literature") {
        throw new Error(`Unknown literature database: ${database}`)
      }
      return connector
    })
    const settled = await Promise.allSettled(
      connectors.map(async (connector) => ({
        connector,
        hits: await connector.search(input.query, { limit: input.limit, signal }),
      })),
    )
    const records = []
    const errors: Array<{ database: string; message: string }> = []
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index]!
      const database = connectors[index]!.id
      if (result.status === "rejected") {
        errors.push({ database, message: result.reason instanceof Error ? result.reason.message : String(result.reason) })
        continue
      }
      for (const hit of result.value.hits) {
        records.push(
          await Research.ingestLiterature(Instance.project.id, input.campaignId, {
            database,
            sourceId: hit.id,
            title: hit.title,
            summary: hit.summary,
            excerpts: [],
            url: hit.url,
            query: input.query,
          }),
        )
      }
    }
    await Research.publishCampaignKnowledge(Instance.project.id, input.campaignId, Instance.directory)
    return SearchResult.parse({ query: input.query, databases: input.databases, records, errors })
  }
}
