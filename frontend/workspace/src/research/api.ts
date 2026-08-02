export type Digest = `sha256:${string}`
export type DesignAdapter = "mock" | "proto"
export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived"
export type ExperimentStatus = "draft" | "active" | "paused" | "completed" | "failed" | "archived"
export type TrialStatus = "proposed" | "queued" | "running" | "evaluating" | "succeeded" | "failed" | "cancelled"
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface Campaign {
  id: string
  projectId: string
  objective: string
  status: CampaignStatus
  knowledgeCatalogId: string
  createdAt: string
  updatedAt: string
}

export interface Evaluator {
  id: string
  version: string
  sourceHash: Digest
  containerHash?: Digest
  direction: "minimize" | "maximize"
  fixedSeeds: number[]
  submissionSize: number
}

export interface ExperimentContract {
  version: 1
  objective: string
  targetArtifactHash: Digest
  modality: "linear_minibinder" | "short_peptide" | "cyclic_peptide" | "modified_peptide"
  budget: {
    maximumCandidates: number
    gpuHours: number
    wallTimeMinutes: number
  }
  evaluator: Evaluator
}

export interface Experiment {
  id: string
  campaignId: string
  status: ExperimentStatus
  contract: ExperimentContract
  contractHash: Digest
  incumbentTrialId?: string
  createdAt: string
  updatedAt: string
}

export interface Trial {
  id: string
  experimentId: string
  parentTrialId?: string
  hypothesis: string
  designAdapter: DesignAdapter
  programPath: string
  programHash: Digest
  status: TrialStatus
  createdAt: string
  updatedAt: string
}

export interface Evaluation {
  id: string
  trialId: string
  contractHash: Digest
  evaluatorHash: Digest
  valid: boolean
  score: number | null
  diagnostics: Record<string, number>
  evaluatedAt: string
}

export interface Run {
  id: string
  trialId: string
  status: RunStatus
  bundlePath: string
  outputPath: string
  jobId?: string
  manifestHash?: Digest
  error?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export interface ExperimentHistory {
  experiment: Experiment
  trials: Trial[]
  evaluations: Evaluation[]
  runs: Run[]
}

export interface AdapterInfo {
  id: DesignAdapter
  label: string
  available: boolean
  reason?: string
  python: string
  proto?: { root: string; languageCommit: string; toolsCommit: string }
}

export interface EvaluatorInfo {
  id: string
  version: string
  sourceHash: Digest
  direction: "minimize" | "maximize"
  implementation: string
}

export interface KnowledgeConcept {
  id: string
  campaignId: string
  experimentId: string
  trialId: string
  evaluationId: string
  runId?: string
  type: "Research Evaluation"
  title: string
  description: string
  tags: string[]
  sources: Array<{ uri?: string; title?: string; digest?: string } | string>
  generated: boolean
  verified?: boolean
  status: string
  score: number | null
  decision: "promoted" | "rejected"
  diagnostics: Record<string, number>
  provenance: Record<string, unknown>
  createdAt: string
}

export interface CandidateArtifact {
  id: string
  sequence: string
  seed: number
}

export interface RunArtifacts {
  run: Run
  trial: Trial
  candidates: { candidates: CandidateArtifact[] }
  evaluation: Evaluation
  manifest: {
    workerVersion?: string
    pythonVersion?: string
    files?: Record<string, Digest>
    [key: string]: unknown
  }
  incumbent: boolean
}

export interface ProgramTemplates {
  mock: string
  proto: string
}

export interface ResearchApiOptions {
  baseUrl: string
  directory: string
  fetchFn?: typeof fetch
}

export class ResearchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message)
    this.name = "ResearchApiError"
  }
}

export function createResearchApi(options: ResearchApiOptions) {
  const fetchFn = options.fetchFn ?? fetch
  const base = options.baseUrl.replace(/\/+$/, "")

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const normalized = path === "/" ? "" : path.replace(/\/+$/, "")
    const response = await fetchFn(`${base}/research${normalized}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-openscience-directory": options.directory,
        ...(init?.headers ?? {}),
      },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      let message = body
      try {
        const parsed = JSON.parse(body) as { message?: string; data?: { message?: string } }
        message = parsed.data?.message ?? parsed.message ?? body
      } catch {}
      throw new ResearchApiError(message || `${response.status} ${response.statusText}`, response.status, normalized)
    }
    if (response.status === 204) return undefined as T
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) {
      throw new ResearchApiError(`Expected JSON, received ${contentType || "no content type"}`, response.status, normalized)
    }
    return (await response.json()) as T
  }

  const post = <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })

  return {
    listAdapters: () => request<AdapterInfo[]>("/design-adapters"),
    listEvaluators: () => request<EvaluatorInfo[]>("/evaluators"),
    programTemplates: () => request<ProgramTemplates>("/program-templates"),
    listCampaigns: () => request<Campaign[]>("/campaigns"),
    createCampaign: (input: { objective: string; knowledgeCatalogId?: string }) =>
      post<Campaign>("/campaigns", input),
    activateCampaign: (campaignId: string) => post<Campaign>(`/campaigns/${campaignId}/activate`),
    listExperiments: (campaignId: string) => request<Experiment[]>(`/campaigns/${campaignId}/experiments`),
    createExperiment: (campaignId: string, contract: ExperimentContract) =>
      post<Experiment>(`/campaigns/${campaignId}/experiments`, { contract }),
    activateExperiment: (experimentId: string) => post<Experiment>(`/experiments/${experimentId}/activate`),
    history: (experimentId: string) => request<ExperimentHistory>(`/experiments/${experimentId}/history`),
    createAuthoredTrial: (
      experimentId: string,
      input: { hypothesis: string; designAdapter: DesignAdapter; program: string },
    ) => post<Trial>(`/experiments/${experimentId}/authored-trials`, input),
    startRun: (trialId: string, sessionID: string) => post<Run>(`/trials/${trialId}/run`, { sessionID }),
    getRun: (runId: string) => request<Run>(`/runs/${runId}`),
    runArtifacts: (runId: string) => request<RunArtifacts>(`/runs/${runId}/artifacts`),
    knowledgeConcepts: async (campaignId: string) => {
      try {
        return await request<KnowledgeConcept[]>(`/campaigns/${campaignId}/knowledge`)
      } catch (error) {
        if (error instanceof ResearchApiError && error.status === 404) return []
        throw error
      }
    },
  }
}

export type ResearchApi = ReturnType<typeof createResearchApi>
