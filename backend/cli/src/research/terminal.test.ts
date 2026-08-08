import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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

  test("searches literature into the campaign knowledge plane", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const code = await ResearchTerminal.run(
      [
        "literature",
        "search",
        "cmp_one",
        "--query",
        "PD-L1 peptide binder design",
        "--databases",
        "pubmed,europepmc",
        "--limit",
        "4",
      ],
      {
        output: () => undefined,
        fetchFn: (async (input, init) => {
          calls.push({ url: String(input), init })
          return new Response(JSON.stringify({ records: [], errors: [] }))
        }) as typeof fetch,
      },
    )
    expect(code).toBe(0)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/research/campaigns/cmp_one/literature/search")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "PD-L1 peptide binder design",
      databases: ["pubmed", "europepmc"],
      limit: 4,
    })
  })

  test("starts a bounded dynamic literature review", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const code = await ResearchTerminal.run(
      [
        "literature",
        "review",
        "cmp_one",
        "--session",
        "ses_parent",
        "--question",
        "Which constraints improve selectivity?",
        "--max-sources",
        "12",
        "--max-claims",
        "8",
      ],
      {
        output: () => undefined,
        fetchFn: (async (input, init) => {
          calls.push({ url: String(input), init })
          return new Response(JSON.stringify({ records: [], claims: [], unresolvedQuestions: [] }))
        }) as typeof fetch,
      },
    )
    expect(code).toBe(0)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/research/campaigns/cmp_one/literature/review")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "ses_parent",
      question: "Which constraints improve selectivity?",
      maxSources: 12,
      maxClaims: 8,
    })
  })

  test("refreshes literature only when the knowledge watermark is due", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const code = await ResearchTerminal.run(["knowledge", "refresh", "cmp_one", "--session", "ses_parent"], {
      output: () => undefined,
      fetchFn: (async (input, init) => {
        calls.push({ url: String(input), init })
        if (String(input).endsWith("/knowledge/status")) {
          return new Response(
            JSON.stringify({ due: true, reasons: ["new_experiment_results"], unprocessedKnowledgeIds: ["knw_one"] }),
          )
        }
        return new Response(JSON.stringify({ records: [], claims: [], alignments: [], unresolvedQuestions: [] }))
      }) as typeof fetch,
    })
    expect(code).toBe(0)
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/research/campaigns/cmp_one/knowledge/status",
      "http://127.0.0.1:4096/research/campaigns/cmp_one/literature/review",
    ])
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      sessionId: "ses_parent",
      maxSources: 20,
      maxClaims: 20,
    })
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

  test("starts a bounded autoresearch loop through the research API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const output: string[] = []
    const code = await ResearchTerminal.run(
      ["autoresearch", "exp_one", "--session", "ses_one", "--iterations", "3", "--agent", "biology"],
      {
        output: (value) => output.push(value),
        fetchFn: (async (input, init) => {
          calls.push({ url: String(input), init })
          return new Response(JSON.stringify({ experimentId: "exp_one", completedIterations: 3, iterations: [] }))
        }) as typeof fetch,
      },
    )
    expect(code).toBe(0)
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/research/experiments/exp_one/autoresearch")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "ses_one",
      iterations: 3,
      agent: "biology",
    })
    expect(output[0]).toContain('"completedIterations": 3')
  })

  test("authors a target file before freezing an experiment with the scientific evaluator", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-terminal-target-"))
    const target = {
      format: "autofold.target-artifact.v1",
      name: "CLI receptor",
      chains: [{ id: "A", sequence: "ACDEFGHIK" }],
      bindingSite: { residues: [{ chainId: "A", position: 4 }] },
    }
    await fs.writeFile(path.join(workspace, "target.json"), JSON.stringify(target))
    const structure = "data_cli_receptor\n#\n"
    await fs.writeFile(path.join(workspace, "target.cif"), structure)
    const structureHasher = new Bun.CryptoHasher("sha256")
    structureHasher.update(structure)
    const calls: Array<{ url: string; init?: RequestInit }> = []
    try {
      const code = await ResearchTerminal.run(
        [
          "experiment",
          "create",
          "cmp_one",
          "--objective",
          "Improve binding",
          "--target-file",
          "target.json",
          "--target-structure",
          "target.cif",
          "--evaluator",
          "peptide-panel",
          "--workspace",
          workspace,
        ],
        {
          output: () => undefined,
          fetchFn: (async (input, init) => {
            calls.push({ url: String(input), init })
            const url = String(input)
            if (url.endsWith("/evaluators")) {
              return new Response(
                JSON.stringify([
                  { id: "mock-peptide-panel", version: "1", sourceHash: `sha256:${"a".repeat(64)}`, direction: "minimize" },
                  {
                    id: "peptide-panel",
                    version: "1",
                    sourceHash: `sha256:${"b".repeat(64)}`,
                    direction: "minimize",
                    evidenceAdapter: {
                      id: "boltz2",
                      version: "2.2.1",
                      sourceHash: `sha256:${"d".repeat(64)}`,
                    },
                  },
                ]),
              )
            }
            if (url.endsWith("/targets")) {
              return new Response(JSON.stringify({ targetArtifactHash: `sha256:${"c".repeat(64)}` }))
            }
            return new Response(JSON.stringify({ id: "exp_one" }))
          }) as typeof fetch,
        },
      )
      expect(code).toBe(0)
      expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
        artifact: {
          ...target,
          structure: { format: "mmcif", contentHash: `sha256:${structureHasher.digest("hex")}` },
        },
        structureBase64: Buffer.from(structure).toString("base64"),
      })
      const contract = JSON.parse(String(calls[2]?.init?.body)).contract
      expect(contract.targetArtifactHash).toBe(`sha256:${"c".repeat(64)}`)
      expect(contract.evaluator.id).toBe("peptide-panel")
      expect(contract.evaluator.evidenceAdapter).toEqual({
        id: "boltz2",
        version: "2.2.1",
        sourceHash: `sha256:${"d".repeat(64)}`,
      })
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})
