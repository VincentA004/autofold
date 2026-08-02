import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExecutionProtocol } from "./execution-protocol"

const evaluator = path.resolve(import.meta.dir, "../../../worker/autofold_worker/peptide_panel_v1.py")
const digest = (character: string) => `sha256:${character.repeat(64)}`
const driver = `
import importlib.util
import json
import pathlib
import sys

spec = importlib.util.spec_from_file_location("locked_evaluator", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
print(json.dumps(module.evaluate(payload["bundle"], payload["candidates"]), sort_keys=True))
`

async function evaluate(root: string, label: string, bundle: unknown, candidates: unknown) {
  const input = path.join(root, `${label}.json`)
  await fs.writeFile(input, JSON.stringify({ bundle, candidates }))
  const process = Bun.spawn(["python3", "-c", driver, evaluator, input], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  expect(exitCode, stderr).toBe(0)
  return ExecutionProtocol.EvaluationResult.parse(JSON.parse(stdout))
}

function candidate(id: string, sequence: string, quality: "strong" | "weak" | "ineligible") {
  const values =
    quality === "strong"
      ? [0.9, 0.85, 0.8, 0.8, 0.1, 0.1]
      : quality === "weak"
        ? [0.4, 0.45, 0.4, 0.4, 0.6, 0.6]
        : [0.1, 0.8, 0.8, 0.8, 0.1, 0.1]
  return {
    format: "autofold.peptide-candidate.v1",
    id,
    sequence,
    seed: 7,
    modality: "short_peptide",
    generation: {
      model: "fixture-generator",
      version: "1",
      artifactHash: digest("a"),
      parametersHash: digest("b"),
    },
    evidence: {
      interfaceConfidence: values[0],
      foldConfidence: values[1],
      predictorAgreement: values[2],
      solubility: values[3],
      aggregationRisk: values[4],
      synthesisRisk: values[5],
      predictors: [{ model: "fixture-predictor", version: "1", artifactHash: digest("c") }],
    },
  }
}

describe("locked peptide panel v1", () => {
  test("rewards stronger evidence and invalidates panels with no eligible candidates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-panel-"))
    const bundle = {
      format: "autofold.trial-bundle.v2",
      runId: "run_panel_test",
      trialId: "trl_panel_test",
      contractHash: digest("d"),
      targetArtifactHash: digest("e"),
      designAdapter: "proto",
      programPath: "/immutable/trial.py",
      programHash: digest("f"),
      modality: "short_peptide",
      evaluator: { id: "peptide-panel", version: "1", sourceHash: digest("1"), direction: "minimize" },
      seeds: [7],
      candidateBudget: 2,
      submissionSize: 2,
    }
    const panel = (quality: "strong" | "weak" | "ineligible") => ({
      format: "autofold.candidate-set.v2",
      runId: bundle.runId,
      trialId: bundle.trialId,
      targetArtifactHash: bundle.targetArtifactHash,
      candidates: [
        candidate("pep_one", "ACDEFGHIKLMNPQRSTVWY", quality),
        candidate("pep_two", "YWVTSRQPNMLKIHGFEDCA", quality),
      ],
    })
    try {
      const strong = await evaluate(root, "strong", bundle, panel("strong"))
      const weak = await evaluate(root, "weak", bundle, panel("weak"))
      const ineligible = await evaluate(root, "ineligible", bundle, panel("ineligible"))
      const duplicatePanel = panel("strong")
      duplicatePanel.candidates[1]!.id = duplicatePanel.candidates[0]!.id
      const duplicate = await evaluate(root, "duplicate", bundle, duplicatePanel)
      expect(strong.valid).toBe(true)
      expect(weak.valid).toBe(true)
      expect(strong.score!).toBeLessThan(weak.score!)
      expect(ineligible.valid).toBe(false)
      expect(ineligible.score).toBeNull()
      expect(duplicate.valid).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
