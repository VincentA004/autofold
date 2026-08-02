import { describe, expect, test } from "bun:test"
import { ResearchTerminal } from "./terminal"

describe("research terminal", () => {
  test("parses positionals, value flags, inline flags, and booleans", () => {
    expect(
      ResearchTerminal.parse([
        "trial",
        "create",
        "exp_one",
        "--adapter=proto",
        "--program",
        "trial.py",
        "--verbose",
      ]),
    ).toEqual({
      positionals: ["trial", "create", "exp_one"],
      flags: { adapter: "proto", program: "trial.py", verbose: true },
    })
  })

  test("sends project scope and authored trial source to the backend", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const output: string[] = []
    const code = await ResearchTerminal.run(
      ["campaign", "create", "--objective", "Discover a peptide", "--workspace", "/work/peptides"],
      {
        output: (value) => output.push(value),
        fetchFn: (async (input, init) => {
          calls.push({ url: String(input), init })
          return new Response(JSON.stringify({ id: "cmp_one" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }) as typeof fetch,
      },
    )
    expect(code).toBe(0)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/research/campaigns")
    expect(new Headers(calls[0]?.init?.headers).get("x-openscience-directory")).toBe("/work/peptides")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ objective: "Discover a peptide" })
    expect(JSON.parse(output[0]!)).toEqual({ id: "cmp_one" })
  })

  test("watches a run through completion and then prints verified artifacts", async () => {
    const output: string[] = []
    let reads = 0
    const code = await ResearchTerminal.run(["run", "watch", "run_one"], {
      output: (value) => output.push(value),
      sleep: async () => undefined,
      fetchFn: (async (input) => {
        const url = String(input)
        if (url.endsWith("/artifacts")) return new Response(JSON.stringify({ candidates: { candidates: [] } }))
        reads++
        return new Response(JSON.stringify({ status: reads === 1 ? "running" : "succeeded" }))
      }) as typeof fetch,
    })
    expect(code).toBe(0)
    expect(output.some((line) => line.includes("running"))).toBe(true)
    expect(output.some((line) => line.includes('"candidates"'))).toBe(true)
  })

  test("creates a session through the same project-scoped terminal client", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const code = await ResearchTerminal.run(["session", "create", "--title", "Acceptance compute"], {
      output: () => undefined,
      fetchFn: (async (input, init) => {
        calls.push({ url: String(input), init })
        return new Response(JSON.stringify({ id: "ses_one" }))
      }) as typeof fetch,
    })
    expect(code).toBe(0)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session/")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ title: "Acceptance compute" })
  })
})
