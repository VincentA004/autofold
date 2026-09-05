import path from "node:path"

type Fetch = typeof fetch
type Output = (value: string) => void

interface Parsed {
  positionals: string[]
  flags: Record<string, string | boolean>
}

const terminalRunStates = new Set(["succeeded", "failed", "cancelled"])
const terminalJobStates = terminalRunStates

export namespace ResearchTerminal {
  export function parse(argv: string[]): Parsed {
    const positionals: string[] = []
    const flags: Record<string, string | boolean> = {}
    for (let index = 0; index < argv.length; index++) {
      const value = argv[index]!
      if (!value.startsWith("--")) {
        positionals.push(value)
        continue
      }
      const [rawKey, inline] = value.slice(2).split("=", 2)
      if (!rawKey) throw new Error(`Invalid flag: ${value}`)
      if (inline !== undefined) {
        flags[rawKey] = inline
        continue
      }
      const next = argv[index + 1]
      if (next && !next.startsWith("--")) {
        flags[rawKey] = next
        index++
      } else {
        flags[rawKey] = true
      }
    }
    return { positionals, flags }
  }

  export class Client {
    private readonly server: string

    constructor(
      server: string,
      private readonly workspace: string,
      private readonly fetchFn: Fetch = fetch,
    ) {
      this.server = server.replace(/\/+$/, "")
    }

    async request<T>(route: string, method = "GET", body?: unknown): Promise<T> {
      return this.serverRequest<T>(`/research${route}`, method, body)
    }

    async serverRequest<T>(route: string, method = "GET", body?: unknown): Promise<T> {
      const response = await this.fetchFn(`${this.server}${route}`, {
        method,
        headers: {
          "x-openscience-directory": /[^\x00-\x7f]/.test(this.workspace)
            ? encodeURIComponent(this.workspace)
            : this.workspace,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) {
        let message = text
        try {
          const parsed = JSON.parse(text) as { message?: string; data?: { message?: string } }
          message = parsed.data?.message ?? parsed.message ?? text
        } catch {}
        throw new Error(`${method} ${route} failed (${response.status}): ${message || response.statusText}`)
      }
      return (text ? JSON.parse(text) : undefined) as T
    }

    get<T>(route: string) {
      return this.request<T>(route)
    }

    post<T>(route: string, body?: unknown) {
      return this.request<T>(route, "POST", body)
    }
  }

  export async function run(
    argv: string[],
    options: { fetchFn?: Fetch; output?: Output; error?: Output; sleep?: (milliseconds: number) => Promise<void> } = {},
  ): Promise<number> {
    const parsed = parse(argv)
    const output = options.output ?? console.log
    const error = options.error ?? console.error
    const server = stringFlag(parsed, "server") ?? process.env.AUTOFOLD_URL ?? "http://127.0.0.1:4096"
    const workspace = path.resolve(stringFlag(parsed, "workspace") ?? process.cwd())
    const client = new Client(server, workspace, options.fetchFn)
    const command = parsed.positionals[0] ?? "help"
    const noun = parsed.positionals[1]

    try {
      if (command === "help" || command === "--help" || command === "-h") {
        output(help())
        return 0
      }
      if (command === "status") {
        const [adapters, evaluators, campaigns] = await Promise.all([
          client.get("/design-adapters"),
          client.get("/evaluators"),
          client.get("/campaigns"),
        ])
        outputJSON(output, { server, workspace, adapters, evaluators, campaigns })
        return 0
      }
      if (command === "sessions") {
        outputJSON(output, await client.serverRequest("/session/"))
        return 0
      }
      if (command === "session" && noun === "create") {
        outputJSON(
          output,
          await client.serverRequest("/session/", "POST", {
            ...(stringFlag(parsed, "title") ? { title: stringFlag(parsed, "title") } : {}),
          }),
        )
        return 0
      }
      if (command === "campaigns") {
        outputJSON(output, await client.get("/campaigns"))
        return 0
      }
      if (command === "target" && noun === "add") {
        const targetFile = path.resolve(workspace, requiredFlag(parsed, "file"))
        if (!(await Bun.file(targetFile).exists())) throw new Error(`Target file was not found: ${targetFile}`)
        outputJSON(output, await client.post("/targets", await targetAuthoringPayload(workspace, targetFile, parsed)))
        return 0
      }
      if (command === "campaign" && noun === "create") {
        const objective = requiredFlag(parsed, "objective")
        outputJSON(output, await client.post("/campaigns", { objective }))
        return 0
      }
      if (command === "campaign" && noun === "activate") {
        outputJSON(output, await client.post(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/activate`))
        return 0
      }
      if (command === "skills") {
        outputJSON(output, await client.get(`/campaigns/${requiredPosition(parsed, 1, "campaign id")}/skills`))
        return 0
      }
      if (command === "skill" && noun === "initialize") {
        outputJSON(output, await client.post(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/skills/initialize`))
        return 0
      }
      if (command === "skill" && noun === "propose") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const skillId = requiredPosition(parsed, 3, "skill id")
        const file = path.resolve(workspace, requiredFlag(parsed, "file"))
        if (!(await Bun.file(file).exists())) throw new Error(`Skill file was not found: ${file}`)
        const trajectories = stringFlag(parsed, "trajectories")
        outputJSON(output, await client.post(`/campaigns/${campaignId}/skills/${skillId}/candidates`, {
          parentVersionId: requiredFlag(parsed, "parent"),
          markdown: await Bun.file(file).text(),
          trajectoryRefs: trajectories ? trajectories.split(",").map((item) => item.trim()).filter(Boolean) : [],
          createdBy: requiredFlag(parsed, "by"),
        }))
        return 0
      }
      if (command === "skill" && noun === "refine") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const skillId = requiredPosition(parsed, 3, "skill id")
        outputJSON(output, await client.post(`/campaigns/${campaignId}/skills/${skillId}/refine`, {
          sessionId: requiredFlag(parsed, "session"),
          trajectoryRefs: requiredFlag(parsed, "trajectories").split(",").map((item) => item.trim()).filter(Boolean),
          ...(stringFlag(parsed, "experiment") ? { replayExperimentId: stringFlag(parsed, "experiment") } : {}),
          replayAgent: stringFlag(parsed, "agent") ?? "biology",
          replayRepetitions: integerFlag(parsed, "repetitions", 3),
          ...(stringFlag(parsed, "idempotency-key") ? { idempotencyKey: stringFlag(parsed, "idempotency-key") } : {}),
        }))
        return 0
      }
      if (command === "skill" && noun === "evaluate") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const versionId = requiredPosition(parsed, 3, "skill version id")
        const file = path.resolve(workspace, requiredFlag(parsed, "file"))
        if (!(await Bun.file(file).exists())) throw new Error(`Replay file was not found: ${file}`)
        outputJSON(output, await client.post(
          `/campaigns/${campaignId}/skill-versions/${versionId}/evaluate`, await Bun.file(file).json(),
        ))
        return 0
      }
      if (command === "skill" && noun === "replay") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const versionId = requiredPosition(parsed, 3, "skill version id")
        outputJSON(output, await client.post(`/campaigns/${campaignId}/skill-versions/${versionId}/replay`, {
          experimentId: requiredFlag(parsed, "experiment"),
          sessionId: requiredFlag(parsed, "session"),
          agent: stringFlag(parsed, "agent") ?? "biology",
          repetitions: integerFlag(parsed, "repetitions", 3),
          ...(stringFlag(parsed, "idempotency-key") ? { idempotencyKey: stringFlag(parsed, "idempotency-key") } : {}),
        }))
        return 0
      }
      if (command === "skill" && (noun === "rollback" || noun === "promote-library")) {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const versionId = requiredPosition(parsed, 3, "skill version id")
        outputJSON(output, await client.post(`/campaigns/${campaignId}/skill-versions/${versionId}/${noun}`))
        return 0
      }
      if (command === "literature" && noun === "search") {
        const databases = stringFlag(parsed, "databases")
        outputJSON(
          output,
          await client.post(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/literature/search`, {
            query: requiredFlag(parsed, "query"),
            ...(databases ? { databases: databases.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
            limit: integerFlag(parsed, "limit", 5),
          }),
        )
        return 0
      }
      if (command === "literature" && noun === "review") {
        outputJSON(
          output,
          await client.post(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/literature/review`, {
            sessionId: requiredFlag(parsed, "session"),
            ...(stringFlag(parsed, "idempotency-key") ? { idempotencyKey: stringFlag(parsed, "idempotency-key") } : {}),
            ...(stringFlag(parsed, "question") ? { question: stringFlag(parsed, "question") } : {}),
            maxSources: integerFlag(parsed, "max-sources", 20),
            maxClaims: integerFlag(parsed, "max-claims", 20),
          }),
        )
        return 0
      }
      if (command === "literature") {
        outputJSON(output, await client.get(`/campaigns/${requiredPosition(parsed, 1, "campaign id")}/literature`))
        return 0
      }
      if (command === "claim" && noun === "add") {
        const evidence = requiredFlag(parsed, "evidence")
          .split(",")
          .map((literatureId) => ({ literatureId: literatureId.trim() }))
          .filter((item) => item.literatureId)
        outputJSON(
          output,
          await client.post(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/claims`, {
            kind: stringFlag(parsed, "kind") ?? "hypothesis",
            statement: requiredFlag(parsed, "statement"),
            stance: stringFlag(parsed, "stance") ?? "context",
            confidence: numberFlag(parsed, "confidence", 0.5),
            evidence,
            generatedBy: stringFlag(parsed, "by") ?? "autofold-agent/v1",
          }),
        )
        return 0
      }
      if (command === "claims") {
        outputJSON(output, await client.get(`/campaigns/${requiredPosition(parsed, 1, "campaign id")}/claims`))
        return 0
      }
      if (command === "claim" && noun === "review") {
        outputJSON(
          output,
          await client.post(
            `/campaigns/${requiredPosition(parsed, 2, "campaign id")}/claims/${requiredPosition(parsed, 3, "claim id")}/review`,
            {
              status: stringFlag(parsed, "status") ?? "reviewed",
              reviewedBy: requiredFlag(parsed, "by"),
            },
          ),
        )
        return 0
      }
      if (command === "experiments") {
        outputJSON(output, await client.get(`/campaigns/${requiredPosition(parsed, 1, "campaign id")}/experiments`))
        return 0
      }
      if (command === "experiment" && noun === "create") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const targetFile = stringFlag(parsed, "target-file")
        const evaluators = await client.get<Array<{
          id: string
          version: string
          sourceHash: string
          direction: "minimize" | "maximize"
          evidenceAdapter?: { id: string; version: string; sourceHash: string }
        }>>("/evaluators")
        const requestedEvaluator = stringFlag(parsed, "evaluator")
        const evaluator = evaluators.find((item) => item.id === requestedEvaluator) ?? evaluators[0]
        if (!evaluator) throw new Error("No locked evaluator is installed")
        const targetArtifactHash = targetFile
          ? (
              await client.post<{ targetArtifactHash: string }>(
                "/targets",
                await targetAuthoringPayload(workspace, path.resolve(workspace, targetFile), parsed),
              )
            ).targetArtifactHash
          : requiredFlag(parsed, "target")
        const contract = {
          version: 1,
          objective: requiredFlag(parsed, "objective"),
          targetArtifactHash,
          modality: stringFlag(parsed, "modality") ?? "short_peptide",
          budget: {
            maximumCandidates: integerFlag(parsed, "candidates", 64),
            gpuHours: numberFlag(parsed, "gpu-hours", 0),
            wallTimeMinutes: integerFlag(parsed, "wall-minutes", 30),
          },
          evaluator: {
            id: evaluator.id,
            version: evaluator.version,
            sourceHash: evaluator.sourceHash,
            direction: evaluator.direction,
            ...(evaluator.evidenceAdapter ? { evidenceAdapter: evaluator.evidenceAdapter } : {}),
            fixedSeeds: (stringFlag(parsed, "seeds") ?? "7,11,23").split(",").map((value) => Number(value.trim())),
            submissionSize: integerFlag(parsed, "submission", 8),
          },
        }
        outputJSON(output, await client.post(`/campaigns/${campaignId}/experiments`, { contract }))
        return 0
      }
      if (command === "experiment" && noun === "activate") {
        outputJSON(output, await client.post(`/experiments/${requiredPosition(parsed, 2, "experiment id")}/activate`))
        return 0
      }
      if (command === "autoresearch") {
        const experimentId = requiredPosition(parsed, 1, "experiment id")
        outputJSON(
          output,
          await client.post(`/experiments/${experimentId}/autoresearch`, {
            sessionId: requiredFlag(parsed, "session"),
            ...(stringFlag(parsed, "iterations") ? { iterations: integerFlag(parsed, "iterations", 1) } : {}),
            ...(stringFlag(parsed, "agent") ? { agent: stringFlag(parsed, "agent") } : {}),
            ...(stringFlag(parsed, "mode") ? { recursionMode: stringFlag(parsed, "mode") } : {}),
            ...(stringFlag(parsed, "idempotency-key") ? { idempotencyKey: stringFlag(parsed, "idempotency-key") } : {}),
          }),
        )
        return 0
      }
      if (command === "history") {
        outputJSON(output, await client.get(`/experiments/${requiredPosition(parsed, 1, "experiment id")}/history`))
        return 0
      }
      if (command === "template") {
        const adapter = requiredPosition(parsed, 1, "adapter (mock or proto)")
        if (adapter !== "mock" && adapter !== "proto") throw new Error("Adapter must be mock or proto")
        const templates = await client.get<Record<"mock" | "proto", string>>("/program-templates")
        output(templates[adapter])
        return 0
      }
      if (command === "trial" && noun === "create") {
        const experimentId = requiredPosition(parsed, 2, "experiment id")
        const programFile = path.resolve(workspace, requiredFlag(parsed, "program"))
        if (!(await Bun.file(programFile).exists())) throw new Error(`Program file was not found: ${programFile}`)
        const program = await Bun.file(programFile).text()
        outputJSON(
          output,
          await client.post(`/experiments/${experimentId}/authored-trials`, {
            hypothesis: requiredFlag(parsed, "hypothesis"),
            intent: stringFlag(parsed, "intent") ?? "optimize",
            designAdapter: stringFlag(parsed, "adapter") ?? "mock",
            program,
            ...(stringFlag(parsed, "parent") ? { parentTrialId: stringFlag(parsed, "parent") } : {}),
          }),
        )
        return 0
      }
      if (command === "run" && noun === "start") {
        outputJSON(
          output,
          await client.post(`/trials/${requiredPosition(parsed, 2, "trial id")}/run`, {
            sessionID: requiredFlag(parsed, "session"),
          }),
        )
        return 0
      }
      if (command === "run" && noun === "get") {
        outputJSON(output, await client.get(`/runs/${requiredPosition(parsed, 2, "run id")}`))
        return 0
      }
      if (command === "run" && noun === "reconcile") {
        outputJSON(output, await client.post(`/runs/${requiredPosition(parsed, 2, "run id")}/reconcile`))
        return 0
      }
      if (command === "run" && noun === "watch") {
        const runId = requiredPosition(parsed, 2, "run id")
        const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
        let previous = ""
        while (true) {
          const run = await client.get<{ status: string; error?: string }>(`/runs/${runId}`)
          if (run.status !== previous) output(`${new Date().toISOString()}  ${runId}  ${run.status}`)
          previous = run.status
          if (terminalRunStates.has(run.status)) {
            if (run.status === "succeeded") outputJSON(output, await client.get(`/runs/${runId}/artifacts`))
            else if (run.error) error(run.error)
            return run.status === "succeeded" ? 0 : 1
          }
          await sleep(1_500)
        }
      }
      if (command === "artifacts") {
        outputJSON(output, await client.get(`/runs/${requiredPosition(parsed, 1, "run id")}/artifacts`))
        return 0
      }
      if (command === "jobs") {
        outputJSON(output, await client.get("/jobs"))
        return 0
      }
      if (command === "job" && noun === "get") {
        outputJSON(output, await client.get(`/jobs/${requiredPosition(parsed, 2, "job id")}`))
        return 0
      }
      if (command === "job" && noun === "cancel") {
        outputJSON(output, await client.post(`/jobs/${requiredPosition(parsed, 2, "job id")}/cancel`))
        return 0
      }
      if (command === "job" && noun === "retry") {
        outputJSON(output, await client.post(`/jobs/${requiredPosition(parsed, 2, "job id")}/retry`))
        return 0
      }
      if (command === "job" && noun === "watch") {
        const jobId = requiredPosition(parsed, 2, "job id")
        const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
        let previous = ""
        while (true) {
          const job = await client.get<{ status: string; error?: string; result?: unknown }>(`/jobs/${jobId}`)
          if (job.status !== previous) output(`${new Date().toISOString()}  ${jobId}  ${job.status}`)
          previous = job.status
          if (terminalJobStates.has(job.status)) {
            if (job.status === "succeeded") outputJSON(output, job.result ?? job)
            else if (job.error) error(job.error)
            return job.status === "succeeded" ? 0 : 1
          }
          await sleep(1_000)
        }
      }
      if (command === "knowledge" && noun === "status") {
        outputJSON(
          output,
          await client.get(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/knowledge/status`),
        )
        return 0
      }
      if (command === "knowledge" && noun === "alignments") {
        outputJSON(
          output,
          await client.get(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/knowledge/alignments`),
        )
        return 0
      }
      if (command === "knowledge" && noun === "cycles") {
        outputJSON(
          output,
          await client.get(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/knowledge/cycles`),
        )
        return 0
      }
      if (command === "alignment" && noun === "review") {
        outputJSON(
          output,
          await client.post(
            `/campaigns/${requiredPosition(parsed, 2, "campaign id")}/knowledge/alignments/${requiredPosition(parsed, 3, "alignment id")}/review`,
            {
              status: stringFlag(parsed, "status") ?? "reviewed",
              reviewedBy: requiredFlag(parsed, "by"),
            },
          ),
        )
        return 0
      }
      if (command === "knowledge" && noun === "refresh") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const status = await client.get<{ due: boolean; reasons: string[] }>(`/campaigns/${campaignId}/knowledge/status`)
        if (!status.due && parsed.flags.force !== true) {
          outputJSON(output, { refreshed: false, ...status })
          return 0
        }
        outputJSON(
          output,
          await client.post(`/campaigns/${campaignId}/literature/review`, {
            sessionId: requiredFlag(parsed, "session"),
            ...(stringFlag(parsed, "idempotency-key") ? { idempotencyKey: stringFlag(parsed, "idempotency-key") } : {}),
            ...(stringFlag(parsed, "question") ? { question: stringFlag(parsed, "question") } : {}),
            maxSources: integerFlag(parsed, "max-sources", 20),
            maxClaims: integerFlag(parsed, "max-claims", 20),
            ...(stringFlag(parsed, "resume-proposal")
              ? { resumeProposalPath: stringFlag(parsed, "resume-proposal") }
              : {}),
            ...(stringFlag(parsed, "child-session")
              ? { resumeChildSessionId: stringFlag(parsed, "child-session") }
              : {}),
          }),
        )
        return 0
      }
      if (command === "knowledge") {
        outputJSON(output, await client.get(`/campaigns/${requiredPosition(parsed, 1, "campaign id")}/knowledge`))
        return 0
      }
      if (command === "orchestration" && noun === "observe") {
        outputJSON(
          output,
          await client.get(`/campaigns/${requiredPosition(parsed, 2, "campaign id")}/orchestration/observation`),
        )
        return 0
      }
      if (command === "campaign" && noun === "loop") {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        outputJSON(
          output,
          await client.post(`/campaigns/${campaignId}/orchestration/loops`, {
            sessionId: requiredFlag(parsed, "session"),
            maxSteps: integerFlag(parsed, "steps", 3),
            ...(stringFlag(parsed, "idempotency-key")
              ? { idempotencyKey: stringFlag(parsed, "idempotency-key") }
              : {}),
          }),
        )
        return 0
      }
      if (command === "move" && (noun === "compile" || noun === "execute")) {
        const campaignId = requiredPosition(parsed, 2, "campaign id")
        const moveFile = path.resolve(workspace, requiredFlag(parsed, "file"))
        if (!(await Bun.file(moveFile).exists())) throw new Error(`Move file was not found: ${moveFile}`)
        const move = await Bun.file(moveFile).json()
        outputJSON(
          output,
          await client.post(`/campaigns/${campaignId}/orchestration/moves/${noun}`,
            noun === "compile"
              ? move
              : {
                  move,
                  sessionId: requiredFlag(parsed, "session"),
                  ...(stringFlag(parsed, "idempotency-key")
                    ? { idempotencyKey: stringFlag(parsed, "idempotency-key") }
                    : {}),
                }),
        )
        return 0
      }
      throw new Error(`Unknown command: ${parsed.positionals.join(" ") || "(empty)"}`)
    } catch (caught) {
      error(caught instanceof Error ? caught.message : String(caught))
      return 1
    }
  }

  function outputJSON(output: Output, value: unknown): void {
    output(JSON.stringify(value, null, 2))
  }

  async function targetAuthoringPayload(workspace: string, targetFile: string, parsed: Parsed) {
    const artifact = await Bun.file(targetFile).json()
    const structureFlag = stringFlag(parsed, "structure") ?? stringFlag(parsed, "target-structure")
    if (!structureFlag) return { artifact }
    const structureFile = path.resolve(workspace, structureFlag)
    if (!(await Bun.file(structureFile).exists())) throw new Error(`Target structure was not found: ${structureFile}`)
    const structure = new Uint8Array(await Bun.file(structureFile).arrayBuffer())
    const contentHash = `sha256:${new Bun.CryptoHasher("sha256").update(structure).digest("hex")}`
    const requestedFormat = stringFlag(parsed, "structure-format")
    const format = requestedFormat ?? (structureFile.toLowerCase().endsWith(".pdb") ? "pdb" : "mmcif")
    if (format !== "pdb" && format !== "mmcif") throw new Error("Structure format must be pdb or mmcif")
    return {
      artifact: { ...artifact, structure: { format, contentHash } },
      structureBase64: Buffer.from(structure).toString("base64"),
    }
  }

  function stringFlag(input: Parsed, key: string): string | undefined {
    const value = input.flags[key]
    return typeof value === "string" ? value : undefined
  }

  function requiredFlag(input: Parsed, key: string): string {
    const value = stringFlag(input, key)
    if (!value) throw new Error(`Missing required --${key}`)
    return value
  }

  function requiredPosition(input: Parsed, index: number, label: string): string {
    const value = input.positionals[index]
    if (!value) throw new Error(`Missing ${label}`)
    return value
  }

  function integerFlag(input: Parsed, key: string, fallback: number): number {
    const value = numberFlag(input, key, fallback)
    if (!Number.isInteger(value)) throw new Error(`--${key} must be an integer`)
    return value
  }

  function numberFlag(input: Parsed, key: string, fallback: number): number {
    const raw = stringFlag(input, key)
    const value = raw === undefined ? fallback : Number(raw)
    if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`)
    return value
  }

  export function help(): string {
    return `Autofold research terminal

Usage: bun run research:cli -- <command> [arguments] [flags]

Global flags:
  --server URL          backend URL (default http://127.0.0.1:4096)
  --workspace PATH      project workspace (default current directory)

Commands:
  status
  sessions
  session create [--title TEXT]
  campaigns
  target add --file TARGET.json [--structure TARGET.cif] [--structure-format pdb|mmcif]
  campaign create --objective TEXT
  campaign activate CMP_ID
  campaign loop CMP_ID --session SES_ID [--steps N] [--idempotency-key KEY]
  skills CMP_ID
  skill initialize CMP_ID
  skill propose CMP_ID SKILL_ID --parent SKV_ID --file SKILL.md --by ACTOR [--trajectories TRL_ID,EVL_ID]
  skill refine CMP_ID SKILL_ID --session SES_ID --trajectories TRL_ID,EVL_ID [--experiment EXP_ID] [--agent biology|ml|task] [--repetitions 3..5]
  skill evaluate CMP_ID SKV_ID --file replay.json
  skill replay CMP_ID SKV_ID --experiment EXP_ID --session SES_ID [--agent biology|ml|task] [--repetitions 3..5]
  skill rollback CMP_ID SKV_ID
  skill promote-library CMP_ID SKV_ID
  literature search CMP_ID --query TEXT [--databases pubmed,europepmc,openalex] [--limit N]
  literature review CMP_ID --session SES_ID [--question TEXT] [--max-sources N] [--max-claims N] [--idempotency-key KEY]
  literature CMP_ID
  claim add CMP_ID --statement TEXT --evidence LIT_ID[,LIT_ID] [--kind hypothesis] [--stance context] [--confidence 0.5]
  claim review CMP_ID CLM_ID --by REVIEWER [--status reviewed|contested|deprecated]
  claims CMP_ID
  experiments CMP_ID
  experiment create CMP_ID --objective TEXT (--target sha256:... | --target-file TARGET.json) [--target-structure TARGET.cif] [--evaluator ID] [--modality short_peptide]
  experiment activate EXP_ID
  autoresearch EXP_ID --session SES_ID [--iterations N] [--agent biology|ml|task] [--mode autonomous_discovery|single_intent] [--idempotency-key KEY]
    Autonomous mode defaults to a 100-trajectory authorization and may stop earlier from evidence; single_intent defaults to one.
  history EXP_ID
  template mock|proto
  trial create EXP_ID --hypothesis TEXT --adapter mock|proto --program trial.py [--intent optimize|calibrate|negative_control]
  run start TRL_ID --session SES_ID
  run get RUN_ID
  run reconcile RUN_ID
  run watch RUN_ID
  artifacts RUN_ID
  jobs
  job get JOB_ID
  job watch JOB_ID
  job cancel JOB_ID
  job retry JOB_ID
  knowledge CMP_ID
  knowledge status CMP_ID
  knowledge alignments CMP_ID
  knowledge cycles CMP_ID
  knowledge refresh CMP_ID --session SES_ID [--question TEXT] [--max-sources N] [--max-claims N] [--force] [--idempotency-key KEY]
    [--resume-proposal PATH --child-session SES_ID]
  alignment review CMP_ID ALN_ID --by REVIEWER [--status reviewed|contested|deprecated]
  orchestration observe CMP_ID
  move compile CMP_ID --file move.json
  move execute CMP_ID --file move.json --session SES_ID [--idempotency-key KEY]

Typical flow: create + activate campaign, create + activate experiment, author a
trial from a template, start it with a live session ID, then watch the run.`
  }
}

if (import.meta.main) {
  process.exitCode = await ResearchTerminal.run(Bun.argv.slice(2))
}
