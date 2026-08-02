import { describe, expect, test } from "bun:test"
import { createResearchApi, ResearchApiError } from "./api"

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

describe("research API client", () => {
  test("carries the selected project directory and authored source to the research route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createResearchApi({
      baseUrl: "http://127.0.0.1:4096/",
      directory: "/work/peptides",
      fetchFn: (async (input, init) => {
        calls.push({ url: String(input), init })
        return json({
          id: "trl_one",
          experimentId: "exp_one",
          hypothesis: "improve charge balance",
          designAdapter: "proto",
          programPath: ".autofold/trials/trl_one/trial.py",
          programHash: `sha256:${"a".repeat(64)}`,
          status: "proposed",
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        })
      }) as typeof fetch,
    })

    await client.createAuthoredTrial("exp_one", {
      hypothesis: "improve charge balance",
      designAdapter: "proto",
      program: "def build_program(bundle): pass\n",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:4096/research/experiments/exp_one/authored-trials")
    expect(calls[0].init?.method).toBe("POST")
    expect(new Headers(calls[0].init?.headers).get("x-openscience-directory")).toBe("/work/peptides")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      hypothesis: "improve charge balance",
      designAdapter: "proto",
      program: "def build_program(bundle): pass\n",
    })
  })

  test("uses the OKF campaign knowledge route and treats an absent catalog projection as empty", async () => {
    const paths: string[] = []
    const client = createResearchApi({
      baseUrl: "http://server",
      directory: "/work",
      fetchFn: (async (input) => {
        paths.push(String(input))
        return json({ message: "not found" }, 404)
      }) as typeof fetch,
    })
    expect(await client.knowledgeConcepts("cmp_one")).toEqual([])
    expect(paths).toEqual(["http://server/research/campaigns/cmp_one/knowledge"])
  })

  test("targets the reconciled run-artifact envelope", async () => {
    const paths: string[] = []
    const client = createResearchApi({
      baseUrl: "http://server",
      directory: "/work",
      fetchFn: (async (input) => {
        paths.push(String(input))
        return json({ run: {}, trial: {}, candidates: { candidates: [] }, evaluation: {}, manifest: {}, incumbent: false })
      }) as typeof fetch,
    })
    await client.runArtifacts("run_one")
    expect(paths[0]).toBe("http://server/research/runs/run_one/artifacts")
  })

  test("surfaces structured research conflicts without losing HTTP context", async () => {
    const client = createResearchApi({
      baseUrl: "http://server",
      directory: "/work",
      fetchFn: (async (_input: RequestInfo | URL) =>
        json({ data: { message: "Campaign must be active" } }, 409)) as typeof fetch,
    })
    const error = await client.listCampaigns().catch((value) => value)
    expect(error).toBeInstanceOf(ResearchApiError)
    expect(error.message).toBe("Campaign must be active")
    expect(error.status).toBe(409)
  })
})
