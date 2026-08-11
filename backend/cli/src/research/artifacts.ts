import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Sequence = z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/)

function inside(workspace: string, relative: string): string {
  const root = path.resolve(workspace)
  const target = path.resolve(root, relative)
  const relation = path.relative(root, target)
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Research artifact path escapes the project: ${relative}`)
  }
  return target
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}

function sha256(content: string | Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(content)
  return `sha256:${hash.digest("hex")}`
}

export namespace ResearchArtifacts {
  export const TargetChain = z.object({
    id: z.string().trim().regex(/^[A-Za-z0-9]{1,4}$/),
    sequence: Sequence.min(1).max(20_000),
  })

  export const TargetArtifact = z
    .object({
      format: z.literal("autofold.target-artifact.v1"),
      name: z.string().trim().min(1).max(256),
      chains: z.array(TargetChain).min(1).max(128),
      structure: z
        .object({
          format: z.enum(["pdb", "mmcif"]),
          contentHash: Digest,
        })
        .optional(),
      bindingSite: z.object({
        description: z.string().trim().min(1).max(2_000).optional(),
        residues: z
          .array(
            z.object({
              chainId: z.string().trim().regex(/^[A-Za-z0-9]{1,4}$/),
              position: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(10_000),
      }),
    })
    .superRefine((artifact, context) => {
      const chains = new Map(artifact.chains.map((chain) => [chain.id, chain.sequence]))
      if (chains.size !== artifact.chains.length) {
        context.addIssue({ code: "custom", path: ["chains"], message: "Target chain IDs must be unique" })
      }
      const residues = new Set<string>()
      for (const [index, residue] of artifact.bindingSite.residues.entries()) {
        const sequence = chains.get(residue.chainId)
        if (!sequence) {
          context.addIssue({
            code: "custom",
            path: ["bindingSite", "residues", index, "chainId"],
            message: `Unknown target chain ${residue.chainId}`,
          })
        } else if (residue.position > sequence.length) {
          context.addIssue({
            code: "custom",
            path: ["bindingSite", "residues", index, "position"],
            message: `Residue position exceeds chain ${residue.chainId} length`,
          })
        }
        const key = `${residue.chainId}:${residue.position}`
        if (residues.has(key)) {
          context.addIssue({
            code: "custom",
            path: ["bindingSite", "residues", index],
            message: `Duplicate binding-site residue ${key}`,
          })
        }
        residues.add(key)
      }
    })
  export type TargetArtifact = z.infer<typeof TargetArtifact>

  export const AuthorTargetInput = z.object({
    artifact: TargetArtifact,
    structureBase64: z.string().max(140_000_000).optional(),
  })
  export type AuthorTargetInput = z.infer<typeof AuthorTargetInput>

  export interface StoredTarget {
    artifact: TargetArtifact
    targetArtifactHash: string
    targetArtifactPath: string
    structureArtifactPath?: string
  }

  export function targetPath(targetArtifactHash: string): string {
    const digest = Digest.parse(targetArtifactHash).slice("sha256:".length)
    return path.posix.join(".autofold", "targets", digest, "target.json")
  }

  export function structurePath(targetArtifactHash: string, format: "pdb" | "mmcif"): string {
    const targetArtifactPath = targetPath(targetArtifactHash)
    return path.posix.join(path.posix.dirname(targetArtifactPath), format === "pdb" ? "structure.pdb" : "structure.cif")
  }

  export async function authorTarget(
    workspace: string,
    raw: TargetArtifact,
    structureContent?: Uint8Array,
  ): Promise<StoredTarget> {
    const artifact = TargetArtifact.parse(raw)
    if (artifact.structure && !structureContent) {
      throw new Error("A target declaring a structure must include the structure content")
    }
    if (!artifact.structure && structureContent) {
      throw new Error("Structure content requires target structure metadata")
    }
    if (artifact.structure && structureContent && sha256(structureContent) !== artifact.structure.contentHash) {
      throw new Error("Target structure content does not match its declared hash")
    }
    const content = canonicalJSON(artifact)
    const targetArtifactHash = sha256(content)
    const targetArtifactPath = targetPath(targetArtifactHash)
    const absolute = inside(workspace, targetArtifactPath)
    const structureArtifactPath = artifact.structure
      ? structurePath(targetArtifactHash, artifact.structure.format)
      : undefined
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    try {
      await fs.writeFile(absolute, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      const existing = await fs.readFile(absolute, "utf8")
      if (sha256(existing) !== targetArtifactHash) {
        throw new Error(`Immutable target artifact collision at ${targetArtifactPath}`)
      }
    }
    if (structureArtifactPath && structureContent) {
      const absoluteStructure = inside(workspace, structureArtifactPath)
      try {
        await fs.writeFile(absoluteStructure, structureContent, { mode: 0o600, flag: "wx" })
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
        const existing = await fs.readFile(absoluteStructure)
        if (sha256(existing) !== artifact.structure?.contentHash) {
          throw new Error(`Immutable target structure collision at ${structureArtifactPath}`)
        }
      }
    }
    return { artifact, targetArtifactHash, targetArtifactPath, structureArtifactPath }
  }

  export async function authorTargetInput(workspace: string, raw: AuthorTargetInput): Promise<StoredTarget> {
    const input = AuthorTargetInput.parse(raw)
    const structure = input.structureBase64 ? Buffer.from(input.structureBase64, "base64") : undefined
    return authorTarget(workspace, input.artifact, structure)
  }

  export async function readTarget(workspace: string, targetArtifactHash: string): Promise<StoredTarget> {
    const targetArtifactPath = targetPath(targetArtifactHash)
    const absolute = inside(workspace, targetArtifactPath)
    const content = await fs.readFile(absolute, "utf8").catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Target artifact ${targetArtifactHash} is missing at ${targetArtifactPath}`)
      }
      throw error
    })
    if (sha256(content) !== targetArtifactHash) {
      throw new Error(`Target artifact no longer matches ${targetArtifactHash}`)
    }
    const artifact = TargetArtifact.parse(JSON.parse(content))
    const structureArtifactPath = artifact.structure
      ? structurePath(targetArtifactHash, artifact.structure.format)
      : undefined
    if (structureArtifactPath) {
      const structure = await fs.readFile(inside(workspace, structureArtifactPath))
      if (sha256(structure) !== artifact.structure?.contentHash) {
        throw new Error(`Target structure no longer matches ${artifact.structure?.contentHash}`)
      }
    }
    return { artifact, targetArtifactHash, targetArtifactPath, structureArtifactPath }
  }
}
