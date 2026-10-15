import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { confinedPath } from "../util/confinement"
import { ResearchDomain } from "./domain"

const MAX_PROGRAM_BYTES = 256 * 1024

const MOCK_TEMPLATE = `"""Autofold deterministic mock design program.

The mock adapter derives candidates from this immutable file's content hash,
the frozen evaluator seeds, and the experiment contract.
"""
`

function sha256(content: string): string {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(content)
  return `sha256:${hash.digest("hex")}`
}


export namespace ResearchPrograms {
  export const AuthorInput = z.object({
    hypothesis: z.string().trim().min(1),
    intent: ResearchDomain.Trial.shape.intent.default("optimize"),
    designAdapter: z.enum(["mock", "proto"]),
    program: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0"), "Program cannot contain NUL bytes")
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROGRAM_BYTES, "Program is too large"),
    parentTrialId: z.string().startsWith("trl_").optional(),
  }).passthrough()
  export type AuthorInput = z.input<typeof AuthorInput>

  export interface AuthoredProgram {
    programPath: string
    programHash: string
  }

  export function templates() {
    return {
      mock: MOCK_TEMPLATE,
      proto: nativeProtoTemplate({intent: "optimize", portfolio: false}),
    } as const
  }

  /** Native authoring example; host admission appends the independently frozen scoring panel. */
  export function nativeProtoTemplate(input: {evidenceRefs?: string[]; gpuHours?: number; intent?: ResearchDomain.Trial["intent"]; hypothesis?: string; portfolio?: boolean} = {}) {
    const portfolio = input.portfolio === true
    const evidence = z.array(z.string().trim().min(1).max(200)).max(30).parse(input.evidenceRefs ?? [])
    const gpuHours = z.number().finite().nonnegative().parse(input.gpuHours ?? 0)
    const intent = ResearchDomain.Trial.shape.intent.parse(input.intent ?? "shadow_replay")
    const hypothesis = z.string().trim().min(1).max(20_000).parse(input.hypothesis ?? "An independently drawn peptide gives a comparable frozen-panel observation.")
    return `"""Native authoring example. Replace the hypothesis, intervention and reasoning for this arm.
The host appends the frozen scoring panel; do not add AUTOFOLD_WORKFLOW or build_program.
Construction and declaration inspection do not call Program.run().
"""
from contextlib import nullcontext
from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment${portfolio ? ', PortfolioProgram, PortfolioLane' : ''}
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeSearch, NativeOutput

HYPOTHESIS = ${JSON.stringify(hypothesis)}
EVIDENCE_REFS = ${JSON.stringify(evidence)}
DECISION_PLAN = {
    "question": "Which independently authored intervention informs the next frozen-panel comparison?",
    "alternatives": [
        {"id": "draw", "experiment": "Draw a new peptide under the frozen candidate ceiling",
         "expectedInformation": "A comparable locked measurement", "estimatedGpuHours": ${gpuHours}},
        {"id": "inspect", "experiment": "Inspect existing receipts without another evaluation",
         "expectedInformation": "Determine whether prior evidence already answers the question", "estimatedGpuHours": 0},
    ],
    "selectedAlternativeId": "draw",
    "rationale": "Seek an independent computational observation; do not infer biological binding.",
    "evidenceRefs": EVIDENCE_REFS,
    "outcomeBranches": [
        {"observation": "The frozen score improves", "nextDecision": "Require independent replication before adopting the method"},
        {"observation": "The score does not improve", "nextDecision": "Retain the measured baseline and reconsider the intervention"},
    ],
}

def _build_program(ctx, *, seed=None):
    result_count = min(ctx.submission_size, ctx.candidate_budget)
    peptide = Segment(length=24, sequence_type="protein", label="designed-peptide")
    generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
    generator.assign(peptide)
    diversity = Constraint(inputs=[peptide], function=protein_diversity_constraint,
        function_config=ProteinDiversityConfig(min_diversity=0.4))
    optimizer = RejectionSamplingOptimizer(constructs=[Construct([peptide], label="candidate")],
        generators=[generator], constraints=[diversity],
        config=RejectionSamplingOptimizerConfig(num_samples=ctx.candidate_budget,
            num_results=result_count, proposal_batch_size=min(4, ctx.candidate_budget)))
    program = Program(optimizers=[optimizer], num_results=result_count,
        seed=ctx.generation_seed if seed is None else seed, compute=nullcontext())
    return program
${portfolio ? `
def _build_portfolio(ctx):
    if 2 * min(ctx.submission_size, ctx.candidate_budget) > ctx.candidate_budget:
        raise ValueError("This two-lane example requires a candidate ceiling covering both complete native result pools")
    return PortfolioProgram([
        PortfolioLane(_build_program(ctx), name="baseline-draw"),
        PortfolioLane(_build_program(ctx, seed=(ctx.generation_seed + 1) & 0xFFFFFFFF), name="independent-draw"),
    ])
` : ''}

def _native_search(ctx):
    return NativeSearch(maximum_candidates=${portfolio ? '2 * ' : ''}min(ctx.submission_size, ctx.candidate_budget),
        maximum_proposals=${portfolio ? '2 * ' : ''}ctx.candidate_budget, maximum_sampling_calls=${portfolio ? '2 * ' : ''}ctx.candidate_budget,
        maximum_tool_calls=${portfolio ? '2 * ' : ''}ctx.candidate_budget, maximum_wall_seconds=30,
        outputs=${portfolio ? '(NativeOutput(construct="candidate", lane=0), NativeOutput(construct="candidate", lane=1))' : '(NativeOutput(construct="candidate"),)'}, allowed_tools=("random-protein-sample",))

def build_trial(ctx):
    return ProtoTrial(program=${portfolio ? '_build_portfolio' : '_build_program'}(ctx), hypothesis=HYPOTHESIS, intent=${JSON.stringify(intent)},
        decision_plan=DECISION_PLAN, evidence_refs=tuple(EVIDENCE_REFS), search=_native_search(ctx))
`
  }

  export async function author(workspace: string, raw: AuthorInput): Promise<AuthoredProgram> {
    const input = AuthorInput.parse(raw)
    const programHash = sha256(input.program)
    const digest = programHash.slice("sha256:".length)
    const programPath = path.posix.join(".autofold", "programs", digest, "trial.py")
    let absolute = await confinedPath(workspace, programPath)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    absolute = await confinedPath(workspace, programPath)
    try {
      await fs.writeFile(absolute, input.program, { encoding: "utf8", mode: 0o600, flag: "wx" })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      const existing = await fs.readFile(await confinedPath(workspace, programPath), "utf8")
      if (sha256(existing) !== programHash) {
        throw new Error(`Immutable research program collision at ${programPath}`)
      }
    }
    return { programPath, programHash }
  }
}
