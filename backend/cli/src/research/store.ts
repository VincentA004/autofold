import z from "zod"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { ResearchDomain } from "./domain"

export const ResearchState = z.object({
  version: z.literal(1),
  campaigns: z.record(z.string(), ResearchDomain.Campaign),
  experiments: z.record(z.string(), ResearchDomain.Experiment),
  trials: z.record(z.string(), ResearchDomain.Trial),
  evaluations: z.record(z.string(), ResearchDomain.Evaluation),
  runs: z.record(z.string(), ResearchDomain.Run).default({}),
  knowledge: z.record(z.string(), ResearchDomain.KnowledgeConcept).default({}),
  literature: z.record(z.string(), ResearchDomain.LiteratureRecord).default({}),
  claims: z.record(z.string(), ResearchDomain.KnowledgeClaim).default({}),
  alignments: z.record(z.string(), ResearchDomain.KnowledgeAlignment).default({}),
  knowledgeCycles: z.record(z.string(), ResearchDomain.KnowledgeCycle).default({}),
  jobs: z.record(z.string(), ResearchDomain.Job).default({}),
  skillVersions: z.record(z.string(), ResearchDomain.SkillVersion).default({}),
  skillLibrary: z.record(z.string(), ResearchDomain.SkillLibraryEntry).default({}),
})
export type ResearchState = z.infer<typeof ResearchState>

export function emptyResearchState(): ResearchState {
  return {
    version: 1,
    campaigns: {},
    experiments: {},
    trials: {},
    evaluations: {},
    runs: {},
    knowledge: {},
    literature: {},
    claims: {},
    alignments: {},
    knowledgeCycles: {},
    jobs: {},
    skillVersions: {},
    skillLibrary: {},
  }
}

export interface ResearchStore {
  read(projectId: string): Promise<ResearchState>
  mutate<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>): Promise<T>
}

export class StorageResearchStore implements ResearchStore {
  private key(projectId: string) {
    return ["research", projectId]
  }

  private lock(projectId: string) {
    return `research:${projectId}`
  }

  async read(projectId: string): Promise<ResearchState> {
    using _ = await Lock.read(this.lock(projectId))
    const value = await Storage.read<unknown>(this.key(projectId)).catch((error) => {
      if (error instanceof Storage.NotFoundError) return emptyResearchState()
      throw error
    })
    return ResearchState.parse(value)
  }

  async mutate<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>): Promise<T> {
    using _ = await Lock.write(this.lock(projectId))
    const current = await Storage.read<unknown>(this.key(projectId)).catch((error) => {
      if (error instanceof Storage.NotFoundError) return emptyResearchState()
      throw error
    })
    const draft = ResearchState.parse(current)
    const result = await fn(draft)
    await Storage.write(this.key(projectId), ResearchState.parse(draft))
    return result
  }
}

export class MemoryResearchStore implements ResearchStore {
  private readonly projects = new Map<string, ResearchState>()

  async read(projectId: string): Promise<ResearchState> {
    return structuredClone(this.projects.get(projectId) ?? emptyResearchState())
  }

  async mutate<T>(projectId: string, fn: (draft: ResearchState) => T | Promise<T>): Promise<T> {
    const draft = structuredClone(this.projects.get(projectId) ?? emptyResearchState())
    const result = await fn(draft)
    this.projects.set(projectId, ResearchState.parse(draft))
    return result
  }
}
