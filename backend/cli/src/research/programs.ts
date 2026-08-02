import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"

const MAX_PROGRAM_BYTES = 256 * 1024

const MOCK_TEMPLATE = `"""Autofold deterministic mock design program.

The mock adapter derives candidates from this immutable file's content hash,
the frozen evaluator seeds, and the experiment contract.
"""
`

const PROTO_TEMPLATE = `"""Autofold Proto peptide design program."""

from contextlib import nullcontext

from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig


def build_program(bundle):
    result_count = min(bundle["submissionSize"], bundle["candidateBudget"])
    peptide = Segment(length=24, sequence_type="protein", label="designed-peptide")
    construct = Construct([peptide], label="candidate")

    generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
    generator.assign(peptide)
    diversity = Constraint(
        inputs=[peptide],
        function=protein_diversity_constraint,
        function_config=ProteinDiversityConfig(min_diversity=0.4),
    )
    optimizer = RejectionSamplingOptimizer(
        constructs=[construct],
        generators=[generator],
        constraints=[diversity],
        config=RejectionSamplingOptimizerConfig(
            num_samples=bundle["candidateBudget"],
            num_results=result_count,
            proposal_batch_size=min(4, bundle["candidateBudget"]),
        ),
    )
    return Program(
        optimizers=[optimizer],
        num_results=result_count,
        seed=bundle["seeds"][0],
        compute=nullcontext(),
    )
`

function sha256(content: string): string {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(content)
  return `sha256:${hash.digest("hex")}`
}

function inside(workspace: string, relative: string): string {
  const root = path.resolve(workspace)
  const target = path.resolve(root, relative)
  const relation = path.relative(root, target)
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Research program path escapes the project: ${relative}`)
  }
  return target
}

export namespace ResearchPrograms {
  export const AuthorInput = z.object({
    hypothesis: z.string().trim().min(1),
    designAdapter: z.enum(["mock", "proto"]),
    program: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0"), "Program cannot contain NUL bytes")
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROGRAM_BYTES, "Program is too large"),
    parentTrialId: z.string().startsWith("trl_").optional(),
  })
  export type AuthorInput = z.infer<typeof AuthorInput>

  export interface AuthoredProgram {
    programPath: string
    programHash: string
  }

  export function templates() {
    return {
      mock: MOCK_TEMPLATE,
      proto: PROTO_TEMPLATE,
    } as const
  }

  export async function author(workspace: string, raw: AuthorInput): Promise<AuthoredProgram> {
    const input = AuthorInput.parse(raw)
    const programHash = sha256(input.program)
    const digest = programHash.slice("sha256:".length)
    const programPath = path.posix.join(".autofold", "programs", digest, "trial.py")
    const absolute = inside(workspace, programPath)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    try {
      await fs.writeFile(absolute, input.program, { encoding: "utf8", mode: 0o600, flag: "wx" })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      const existing = await fs.readFile(absolute, "utf8")
      if (sha256(existing) !== programHash) {
        throw new Error(`Immutable research program collision at ${programPath}`)
      }
    }
    return { programPath, programHash }
  }
}
