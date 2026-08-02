import { For, Show, createEffect, createMemo, createResource, onCleanup, type JSX } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { AsciiSpinner } from "@/atlas/shared/AsciiSpinner"
import { StatusDot } from "@/atlas/shared/StatusDot"
import {
  createResearchApi,
  type AdapterInfo,
  type Campaign,
  type DesignAdapter,
  type EvaluatorInfo,
  type Experiment,
  type ExperimentContract,
  type RunArtifacts,
  type Trial,
} from "./api"
import { candidateSummary, evaluationFor, formatScore, promotionLabel, runFor, shortDigest, statusTone } from "./model"
import "./research.css"

const MOCK_PROGRAM = `"""Deterministic peptide proposal authored by Autofold."""

# The mock adapter uses the frozen experiment seeds and candidate budget.
# Keep trial-specific reasoning here so this source becomes part of provenance.
TRIAL_NOTES = {
    "strategy": "baseline deterministic sequence panel",
    "change": "describe the proposed improvement",
}
`

const PROTO_PROGRAM = `"""Proto Language peptide design program."""

from contextlib import nullcontext
from proto_language.core import Construct, Program, Segment
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig


def build_program(bundle):
    peptide = Segment(length=24, sequence_type="protein")
    construct = Construct([peptide])
    generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
    generator.assign(peptide)
    optimizer = RejectionSamplingOptimizer(
        constructs=[construct],
        generators=[generator],
        constraints=[],
        config=RejectionSamplingOptimizerConfig(
            num_samples=bundle["candidateBudget"],
            num_results=bundle["submissionSize"],
        ),
    )
    return Program(
        optimizers=[optimizer],
        num_results=bundle["submissionSize"],
        seed=bundle["seeds"][0],
        compute=nullcontext(),
    )
`

interface WorkspaceState {
  campaignId?: string
  experimentId?: string
  campaignObjective: string
  experimentObjective: string
  modality: ExperimentContract["modality"]
  targetArtifactHash: string
  maximumCandidates: string
  gpuHours: string
  wallTimeMinutes: string
  evaluatorId: string
  seeds: string
  submissionSize: string
  hypothesis: string
  designAdapter: DesignAdapter
  program: string
  runArtifacts: Record<string, RunArtifacts | undefined>
  artifactLoading: Record<string, boolean | undefined>
  busy?: string
  error?: string
}

export interface ResearchWorkspaceProps {
  /** Runs are session-scoped so compute cancellation follows the active research conversation. */
  sessionID?: string
}

export function ResearchWorkspace(props: ResearchWorkspaceProps): JSX.Element {
  const sdk = useSDK()
  const platform = usePlatform()
  const api = createResearchApi({ baseUrl: sdk.url, directory: sdk.directory, fetchFn: platform.fetch ?? fetch })
  const [state, setState] = createStore<WorkspaceState>({
    campaignObjective: "",
    experimentObjective: "",
    modality: "short_peptide",
    targetArtifactHash: "",
    maximumCandidates: "64",
    gpuHours: "0",
    wallTimeMinutes: "30",
    evaluatorId: "",
    seeds: "7, 11, 23",
    submissionSize: "8",
    hypothesis: "",
    designAdapter: "mock",
    program: MOCK_PROGRAM,
    runArtifacts: {},
    artifactLoading: {},
  })

  const [campaigns, campaignCtl] = createResource(api.listCampaigns)
  const [adapters] = createResource(api.listAdapters)
  const [evaluators] = createResource(api.listEvaluators)
  const [programTemplates] = createResource(api.programTemplates)
  const [experiments, experimentCtl] = createResource(
    () => state.campaignId,
    (campaignId) => api.listExperiments(campaignId),
  )
  const [history, historyCtl] = createResource(
    () => state.experimentId,
    (experimentId) => api.history(experimentId),
  )
  const [concepts, conceptCtl] = createResource(
    () => state.campaignId,
    (campaignId) => api.knowledgeConcepts(campaignId),
  )

  const selectedCampaign = createMemo(() => campaigns()?.find((campaign) => campaign.id === state.campaignId))
  const campaignExperiments = createMemo(() =>
    (experiments() ?? []).filter((experiment) => experiment.campaignId === state.campaignId),
  )
  const currentHistory = createMemo(() => {
    const value = history()
    return value?.experiment.id === state.experimentId ? value : undefined
  })
  const campaignConcepts = createMemo(() =>
    (concepts() ?? []).filter((concept) => concept.campaignId === state.campaignId),
  )
  const selectedExperiment = createMemo(
    () => currentHistory()?.experiment ?? campaignExperiments().find((experiment) => experiment.id === state.experimentId),
  )
  const selectedEvaluator = createMemo(() => evaluators()?.find((item) => item.id === state.evaluatorId))
  const selectedAdapter = createMemo(() => adapters()?.find((item) => item.id === state.designAdapter))

  createEffect(() => {
    const list = campaigns()
    if (!list?.length) {
      setState({ campaignId: undefined, experimentId: undefined })
      return
    }
    if (!state.campaignId || !list.some((campaign) => campaign.id === state.campaignId)) {
      setState({ campaignId: list[0].id, experimentId: undefined })
    }
  })

  createEffect(() => {
    const completed = currentHistory()?.runs.filter((run) => run.status === "succeeded") ?? []
    for (const run of completed) {
      if (state.runArtifacts[run.id] || state.artifactLoading[run.id]) continue
      setState("artifactLoading", run.id, true)
      void api
        .runArtifacts(run.id)
        .then((artifacts) => setState("runArtifacts", run.id, artifacts))
        .catch(() => undefined)
        .finally(() => setState("artifactLoading", run.id, false))
    }
  })

  createEffect(() => {
    const list = campaignExperiments()
    if (!list?.length) {
      setState("experimentId", undefined)
      return
    }
    if (!state.experimentId || !list.some((experiment) => experiment.id === state.experimentId)) {
      setState("experimentId", list[0].id)
    }
  })

  createEffect(() => {
    const list = evaluators()
    if (list?.length && !list.some((item) => item.id === state.evaluatorId)) setState("evaluatorId", list[0].id)
  })

  createEffect(() => {
    const loaded = programTemplates()
    if (!loaded || (state.program !== MOCK_PROGRAM && state.program !== PROTO_PROGRAM)) return
    setState("program", loaded[state.designAdapter])
  })

  const poll = setInterval(() => {
    const active = currentHistory()?.runs.filter((run) => run.status === "queued" || run.status === "running") ?? []
    if (!active.length) return
    void Promise.all(active.map((run) => api.getRun(run.id)))
      .then(() => historyCtl.refetch())
      .catch(() => undefined)
  }, 1_500)
  onCleanup(() => clearInterval(poll))

  async function action(key: string, task: () => Promise<void>) {
    if (state.busy) return
    setState({ busy: key, error: undefined })
    try {
      await task()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("busy", undefined)
    }
  }

  const createCampaign = () =>
    action("campaign:create", async () => {
      const objective = state.campaignObjective.trim()
      if (!objective) throw new Error("Campaign objective is required")
      const campaign = await api.createCampaign({ objective })
      campaignCtl.mutate((items) => [campaign, ...(items ?? [])])
      setState({ campaignId: campaign.id, experimentId: undefined, campaignObjective: "" })
    })

  const activateCampaign = (campaign: Campaign) =>
    action(`campaign:${campaign.id}`, async () => {
      const next = await api.activateCampaign(campaign.id)
      campaignCtl.mutate((items) => items?.map((item) => (item.id === next.id ? next : item)))
    })

  const contract = (): ExperimentContract => {
    const evaluator = selectedEvaluator()
    if (!evaluator) throw new Error("Select an installed evaluator")
    const seeds = state.seeds
      .split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger)
    if (!seeds.length) throw new Error("At least one integer seed is required")
    if (!/^sha256:[a-f0-9]{64}$/.test(state.targetArtifactHash.trim())) {
      throw new Error("Target artifact must be a SHA-256 digest")
    }
    return {
      version: 1,
      objective: required(state.experimentObjective, "Experiment objective"),
      targetArtifactHash: state.targetArtifactHash.trim() as `sha256:${string}`,
      modality: state.modality,
      budget: {
        maximumCandidates: positiveInteger(state.maximumCandidates, "Candidate budget"),
        gpuHours: nonnegative(state.gpuHours, "GPU hours"),
        wallTimeMinutes: positiveInteger(state.wallTimeMinutes, "Wall time"),
      },
      evaluator: {
        id: evaluator.id,
        version: evaluator.version,
        sourceHash: evaluator.sourceHash,
        direction: evaluator.direction,
        fixedSeeds: seeds,
        submissionSize: positiveInteger(state.submissionSize, "Submission size"),
      },
    }
  }

  const createExperiment = () =>
    action("experiment:create", async () => {
      const campaign = selectedCampaign()
      if (!campaign) throw new Error("Select a campaign")
      if (campaign.status !== "active") throw new Error("Activate the campaign before freezing an experiment")
      const experiment = await api.createExperiment(campaign.id, contract())
      experimentCtl.mutate((items) => [experiment, ...(items ?? [])])
      setState({ experimentId: experiment.id, experimentObjective: "" })
    })

  const activateExperiment = (experiment: Experiment) =>
    action(`experiment:${experiment.id}`, async () => {
      const next = await api.activateExperiment(experiment.id)
      experimentCtl.mutate((items) => items?.map((item) => (item.id === next.id ? next : item)))
      await historyCtl.refetch()
    })

  const createTrial = () =>
    action("trial:create", async () => {
      const experiment = selectedExperiment()
      if (!experiment) throw new Error("Select an experiment")
      if (experiment.status !== "active") throw new Error("Activate the experiment before proposing a trial")
      if (selectedAdapter()?.available === false) throw new Error(selectedAdapter()?.reason ?? "Adapter is unavailable")
      await api.createAuthoredTrial(experiment.id, {
        hypothesis: required(state.hypothesis, "Hypothesis"),
        designAdapter: state.designAdapter,
        program: required(state.program, "Trial program"),
      })
      setState({ hypothesis: "", program: template(state.designAdapter, programTemplates()) })
      await historyCtl.refetch()
    })

  const startRun = (trial: Trial) =>
    action(`run:${trial.id}`, async () => {
      if (!props.sessionID) throw new Error("A live research session is required to launch compute")
      await api.startRun(trial.id, props.sessionID)
      await historyCtl.refetch()
    })

  return (
    <section class="research-workspace" aria-label="Autofold research workspace" data-component="research-workspace">
      <header class="research-workspace__header">
        <div>
          <p class="research-eyebrow">Autofold · recursive experiment ledger</p>
          <h1>Peptide discovery</h1>
        </div>
        <div class="research-workspace__header-meta">
          <span>{campaigns()?.length ?? 0} campaigns</span>
          <span>{adapters()?.filter((adapter) => adapter.available).length ?? 0} adapters ready</span>
          <button class="research-icon-button" title="refresh research state" onClick={() => void refreshAll()}>
            ↻
          </button>
        </div>
      </header>

      <Show when={state.error}>
        <div class="research-error" role="alert">
          <strong>ledger action failed</strong>
          <span>{state.error}</span>
          <button onClick={() => setState("error", undefined)}>dismiss</button>
        </div>
      </Show>

      <div class="research-workspace__body">
        <aside class="research-campaign-rail" aria-label="Campaigns">
          <RailHeading label="campaigns" count={campaigns()?.length} loading={campaigns.loading} />
          <div class="research-rail-list atlas-scroll">
            <For each={campaigns()}>
              {(campaign) => (
                <button
                  class="research-rail-row"
                  data-active={state.campaignId === campaign.id ? "true" : "false"}
                  onClick={() => setState({ campaignId: campaign.id, experimentId: undefined })}
                >
                  <StatusDot status={campaign.status === "active" ? "active" : campaign.status === "draft" ? "pending" : "muted"} />
                  <span class="research-rail-row__copy">
                    <strong>{campaign.objective}</strong>
                    <small>{campaign.id}</small>
                  </span>
                </button>
              )}
            </For>
            <Show when={!campaigns.loading && !campaigns()?.length}>
              <EmptyLine>no campaigns recorded</EmptyLine>
            </Show>
          </div>
          <form class="research-rail-form" onSubmit={(event) => { event.preventDefault(); void createCampaign() }}>
            <label for="campaign-objective">new objective</label>
            <textarea
              id="campaign-objective"
              rows={3}
              value={state.campaignObjective}
              onInput={(event) => setState("campaignObjective", event.currentTarget.value)}
              placeholder="Design a selective peptide binder for…"
            />
            <button class="research-primary" disabled={!!state.busy || !state.campaignObjective.trim()}>
              {state.busy === "campaign:create" ? "recording…" : "record campaign"}
            </button>
          </form>
        </aside>

        <main class="research-ledger atlas-scroll">
          <Show when={selectedCampaign()} fallback={<ResearchBlank />}>
            {(campaign) => (
              <>
                <section class="research-ledger__campaign">
                  <div class="research-ledger__title">
                    <div>
                      <p class="research-eyebrow">campaign objective</p>
                      <h2>{campaign().objective}</h2>
                    </div>
                    <Lifecycle value={campaign().status} />
                  </div>
                  <div class="research-ledger__identity">
                    <span>{campaign().id}</span>
                    <span>knowledge {campaign().knowledgeCatalogId}</span>
                    <Show when={campaign().status === "draft" || campaign().status === "paused"}>
                      <button class="research-secondary" onClick={() => void activateCampaign(campaign())} disabled={!!state.busy}>
                        activate campaign
                      </button>
                    </Show>
                  </div>
                </section>

                <section class="research-section">
                  <SectionHeading index="01" title="Experiment contracts" note="immutable after activation" />
                  <div class="research-experiment-strip">
                    <For each={campaignExperiments()}>
                      {(experiment) => (
                        <button
                          class="research-experiment-tab"
                          data-active={state.experimentId === experiment.id ? "true" : "false"}
                          onClick={() => setState("experimentId", experiment.id)}
                        >
                          <StatusDot status={experiment.status === "active" ? "active" : experiment.status === "draft" ? "pending" : "muted"} />
                          <span>{experiment.contract.objective}</span>
                          <small>{shortDigest(experiment.contractHash)}</small>
                        </button>
                      )}
                    </For>
                    <Show when={experiments.loading}><AsciiSpinner label="reading contracts" /></Show>
                    <Show when={!experiments.loading && !campaignExperiments().length}><EmptyLine>no frozen contracts</EmptyLine></Show>
                  </div>
                  <ExperimentAuthor
                    state={state}
                    setState={setState}
                    campaign={campaign()}
                    evaluators={evaluators() ?? []}
                    busy={state.busy}
                    onCreate={() => void createExperiment()}
                  />
                </section>

                <Show when={selectedExperiment()}>
                  {(experiment) => (
                    <>
                      <section class="research-section">
                        <SectionHeading index="02" title="Active experiment" note={shortDigest(experiment().contractHash)} />
                        <ContractLedger experiment={experiment()} />
                        <Show when={experiment().status === "draft" || experiment().status === "paused"}>
                          <button class="research-primary research-inline-action" onClick={() => void activateExperiment(experiment())} disabled={!!state.busy}>
                            freeze + activate contract
                          </button>
                        </Show>
                      </section>

                      <section class="research-section">
                        <SectionHeading index="03" title="Trial authoring" note="source-addressed proposal" />
                        <TrialAuthor
                          state={state}
                          setState={setState}
                          adapters={adapters() ?? []}
                          programTemplates={programTemplates()}
                          enabled={experiment().status === "active"}
                          onCreate={() => void createTrial()}
                        />
                      </section>

                      <section class="research-section research-section--last">
                        <SectionHeading index="04" title="Experiment history" note={`${currentHistory()?.trials.length ?? 0} trials`} />
                        <Show when={history.loading}><div class="research-loading"><AsciiSpinner label="reconciling trials" /></div></Show>
                        <div class="research-trial-ledger">
                          <For each={currentHistory()?.trials.toReversed()}>
                            {(trial, index) => {
                              const evaluation = () => evaluationFor(currentHistory(), trial.id)
                              const run = () => runFor(currentHistory(), trial.id)
                              const candidates = () => candidateSummary(evaluation())
                              const artifacts = () => (run() ? state.runArtifacts[run()!.id] : undefined)
                              return (
                                <article class="research-trial" data-status={trial.status}>
                                  <div class="research-trial__ordinal">T{String((currentHistory()?.trials.length ?? 0) - index()).padStart(2, "0")}</div>
                                  <div class="research-trial__body">
                                    <div class="research-trial__topline">
                                      <StatusDot status={statusTone(trial.status)} pulse={trial.status === "running" || trial.status === "evaluating"} />
                                      <strong>{trial.hypothesis}</strong>
                                      <Lifecycle value={trial.status} />
                                    </div>
                                    <div class="research-trial__meta">
                                      <span>{trial.designAdapter}</span>
                                      <span>{shortDigest(trial.programHash)}</span>
                                      <span>{trial.parentTrialId ? `parent ${trial.parentTrialId}` : "root proposal"}</span>
                                    </div>
                                    <div class="research-trial__result">
                                      <Metric label="score" value={formatScore(evaluation()?.score)} />
                                      <Metric label="decision" value={promotionLabel(currentHistory()!.experiment, trial, evaluation())} />
                                      <Metric label="candidates" value={formatCount(artifacts()?.candidates.candidates.length ?? candidates().count)} />
                                      <Metric label="unique" value={formatPercent(candidates().uniqueFraction)} />
                                    </div>
                                    <Show when={run()}>
                                      {(item) => (
                                        <div class="research-artifact-line">
                                          <span>run {item().id}</span>
                                          <span>output {item().outputPath}</span>
                                          <span>manifest {shortDigest(item().manifestHash)}</span>
                                          <Show when={item().error}><span class="research-artifact-line__error">{item().error}</span></Show>
                                        </div>
                                      )}
                                    </Show>
                                    <Show when={artifacts()}>
                                      {(result) => (
                                        <div class="research-candidate-sequences">
                                          <span>candidate set</span>
                                          <For each={result().candidates.candidates.slice(0, 4)}>
                                            {(candidate) => <code title={candidate.id}>{candidate.sequence}</code>}
                                          </For>
                                          <Show when={result().candidates.candidates.length > 4}>
                                            <small>+{result().candidates.candidates.length - 4} more</small>
                                          </Show>
                                        </div>
                                      )}
                                    </Show>
                                  </div>
                                  <div class="research-trial__action">
                                    <Show
                                      when={trial.status === "proposed"}
                                      fallback={<span class="research-run-state">{run()?.status ?? trial.status}</span>}
                                    >
                                      <button class="research-secondary" disabled={!!state.busy || !props.sessionID} onClick={() => void startRun(trial)}>
                                        {state.busy === `run:${trial.id}` ? "launching…" : "launch run"}
                                      </button>
                                    </Show>
                                  </div>
                                </article>
                              )
                            }}
                          </For>
                          <Show when={!history.loading && !currentHistory()?.trials.length}><EmptyLine>no trial proposals</EmptyLine></Show>
                        </div>
                      </section>
                    </>
                  )}
                </Show>
              </>
            )}
          </Show>
        </main>

        <aside class="research-knowledge-rail" aria-label="Campaign knowledge concepts">
          <RailHeading label="knowledge concepts" count={campaignConcepts().length} loading={concepts.loading} />
          <div class="research-knowledge-rail__catalog">
            <Show when={selectedCampaign()}>
              <div class="research-catalog-id">
                <span>OKF catalog</span>
                <strong>{selectedCampaign()!.knowledgeCatalogId}</strong>
              </div>
            </Show>
            <For each={campaignConcepts()}>
              {(concept) => (
                <article class="research-concept">
                  <div class="research-concept__kind">{concept.type} · {concept.status}</div>
                  <h3>{concept.title}</h3>
                  <p>{concept.description}</p>
                  <div class="research-concept__meta">
                    <span>{concept.decision}</span>
                    <span>score {formatScore(concept.score)}</span>
                    <Show when={concept.verified !== undefined}><span>{concept.verified ? "verified" : "unverified"}</span></Show>
                  </div>
                  <div class="research-concept__tags"><For each={concept.tags}>{(tag) => <span>{tag}</span>}</For></div>
                  <small>{concept.trialId} · {new Date(concept.createdAt).toLocaleDateString()}</small>
                </article>
              )}
            </For>
            <Show when={!concepts.loading && selectedCampaign() && !campaignConcepts().length}>
              <EmptyLine>concepts compound here as trials resolve</EmptyLine>
            </Show>
          </div>
          <button class="research-secondary research-knowledge-refresh" onClick={() => void conceptCtl.refetch()} disabled={!state.campaignId}>
            refresh catalog
          </button>
        </aside>
      </div>
    </section>
  )

  async function refreshAll() {
    await campaignCtl.refetch()
    if (state.campaignId) await Promise.all([experimentCtl.refetch(), conceptCtl.refetch()])
    if (state.experimentId) await historyCtl.refetch()
  }
}

function ExperimentAuthor(props: {
  state: WorkspaceState
  setState: SetWorkspaceState
  campaign: Campaign
  evaluators: EvaluatorInfo[]
  busy?: string
  onCreate: () => void
}) {
  return (
    <details class="research-author" open={!props.campaign || props.campaign.status === "active"}>
      <summary>author next contract</summary>
      <fieldset disabled={props.campaign.status !== "active" || !!props.busy}>
        <div class="research-form-grid research-form-grid--wide">
          <Field label="objective" wide>
            <input value={props.state.experimentObjective} onInput={(e) => props.setState("experimentObjective", e.currentTarget.value)} placeholder="Minimize evaluator score while preserving…" />
          </Field>
          <Field label="modality">
            <select value={props.state.modality} onChange={(e) => props.setState("modality", e.currentTarget.value as ExperimentContract["modality"])}>
              <option value="short_peptide">short peptide</option>
              <option value="cyclic_peptide">cyclic peptide</option>
              <option value="modified_peptide">modified peptide</option>
              <option value="linear_minibinder">linear minibinder</option>
            </select>
          </Field>
          <Field label="evaluator">
            <select value={props.state.evaluatorId} onChange={(e) => props.setState("evaluatorId", e.currentTarget.value)}>
              <For each={props.evaluators}>{(item) => <option value={item.id}>{item.id}@{item.version}</option>}</For>
            </select>
          </Field>
          <Field label="candidate budget"><input inputmode="numeric" value={props.state.maximumCandidates} onInput={(e) => props.setState("maximumCandidates", e.currentTarget.value)} /></Field>
          <Field label="submission size"><input inputmode="numeric" value={props.state.submissionSize} onInput={(e) => props.setState("submissionSize", e.currentTarget.value)} /></Field>
          <Field label="GPU hours"><input inputmode="decimal" value={props.state.gpuHours} onInput={(e) => props.setState("gpuHours", e.currentTarget.value)} /></Field>
          <Field label="wall time · min"><input inputmode="numeric" value={props.state.wallTimeMinutes} onInput={(e) => props.setState("wallTimeMinutes", e.currentTarget.value)} /></Field>
          <Field label="fixed seeds"><input value={props.state.seeds} onInput={(e) => props.setState("seeds", e.currentTarget.value)} /></Field>
          <Field label="target artifact SHA-256" wide><input class="research-code-input" value={props.state.targetArtifactHash} onInput={(e) => props.setState("targetArtifactHash", e.currentTarget.value)} /></Field>
        </div>
        <button type="button" class="research-primary" onClick={props.onCreate}>record draft contract</button>
      </fieldset>
    </details>
  )
}

function TrialAuthor(props: {
  state: WorkspaceState
  setState: SetWorkspaceState
  adapters: AdapterInfo[]
  programTemplates?: { mock: string; proto: string }
  enabled: boolean
  onCreate: () => void
}) {
  return (
    <div class="research-trial-author">
      <fieldset disabled={!props.enabled || !!props.state.busy}>
        <Field label="falsifiable hypothesis" wide>
          <textarea rows={2} value={props.state.hypothesis} onInput={(e) => props.setState("hypothesis", e.currentTarget.value)} placeholder="Changing X should improve the locked score because…" />
        </Field>
        <div class="research-adapter-row">
          <span class="research-field-label">design substrate</span>
          <For each={props.adapters}>
            {(adapter) => (
              <button
                type="button"
                class="research-adapter"
                data-active={props.state.designAdapter === adapter.id ? "true" : "false"}
                disabled={!adapter.available}
                title={adapter.reason ?? adapter.label}
                onClick={() => {
                  props.setState("designAdapter", adapter.id)
                  props.setState("program", template(adapter.id, props.programTemplates))
                }}
              >
                <StatusDot status={adapter.available ? "active" : "error"} />
                <span>{adapter.id}</span>
                <small>{adapter.available ? adapter.label : adapter.reason}</small>
              </button>
            )}
          </For>
        </div>
        <div class="research-program-head">
          <span>trial.py · immutable after record</span>
          <button type="button" onClick={() => props.setState("program", template(props.state.designAdapter, props.programTemplates))}>load template</button>
        </div>
        <textarea
          class="research-program-editor atlas-scroll"
          spellcheck={false}
          value={props.state.program}
          onInput={(e) => props.setState("program", e.currentTarget.value)}
          aria-label="Trial Python source"
        />
        <div class="research-author-footer">
          <span>Server freezes source, path, and SHA-256 before execution.</span>
          <button type="button" class="research-primary" onClick={props.onCreate}>record trial proposal</button>
        </div>
      </fieldset>
    </div>
  )
}

function ContractLedger(props: { experiment: Experiment }) {
  const contract = () => props.experiment.contract
  return (
    <div class="research-contract-ledger">
      <Metric label="status" value={props.experiment.status} />
      <Metric label="modality" value={contract().modality.replaceAll("_", " ")} />
      <Metric label="direction" value={contract().evaluator.direction} />
      <Metric label="candidates" value={String(contract().budget.maximumCandidates)} />
      <Metric label="submission" value={String(contract().evaluator.submissionSize)} />
      <Metric label="wall time" value={`${contract().budget.wallTimeMinutes} min`} />
      <div class="research-contract-ledger__objective"><span>objective</span><strong>{contract().objective}</strong></div>
      <div class="research-contract-ledger__hash"><span>target</span><code>{contract().targetArtifactHash}</code></div>
      <div class="research-contract-ledger__hash"><span>evaluator</span><code>{contract().evaluator.id}@{contract().evaluator.version} · {shortDigest(contract().evaluator.sourceHash)}</code></div>
    </div>
  )
}

type SetWorkspaceState = SetStoreFunction<WorkspaceState>

function Field(props: { label: string; wide?: boolean; children: JSX.Element }) {
  return <label class="research-field" data-wide={props.wide ? "true" : "false"}><span>{props.label}</span>{props.children}</label>
}

function SectionHeading(props: { index: string; title: string; note?: string }) {
  return <div class="research-section-heading"><span>{props.index}</span><h3>{props.title}</h3><small>{props.note}</small></div>
}

function RailHeading(props: { label: string; count?: number; loading?: boolean }) {
  return <div class="research-rail-heading"><span>{props.label}</span><Show when={props.loading} fallback={<b>{props.count ?? 0}</b>}><AsciiSpinner size={9} /></Show></div>
}

function Lifecycle(props: { value: string }) {
  return <span class="research-lifecycle" data-status={props.value}>{props.value}</span>
}

function Metric(props: { label: string; value: string }) {
  return <div class="research-metric"><span>{props.label}</span><strong>{props.value}</strong></div>
}

function EmptyLine(props: { children: JSX.Element }) {
  return <div class="research-empty">— {props.children}</div>
}

function ResearchBlank() {
  return <div class="research-blank"><span>∅</span><h2>No campaign selected</h2><p>Record a campaign objective to begin a compounding research program.</p></div>
}

function template(adapter: DesignAdapter, templates?: { mock: string; proto: string }) {
  return templates?.[adapter] ?? (adapter === "proto" ? PROTO_PROGRAM : MOCK_PROGRAM)
}

function required(value: string, label: string) {
  const result = value.trim()
  if (!result) throw new Error(`${label} is required`)
  return result
}

function positiveInteger(value: string, label: string) {
  const result = Number(value)
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`)
  return result
}

function nonnegative(value: string, label: string) {
  const result = Number(value)
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label} must be nonnegative`)
  return result
}

function formatPercent(value?: number) {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`
}

function formatCount(value?: number) {
  return value === undefined ? "—" : value.toLocaleString()
}
