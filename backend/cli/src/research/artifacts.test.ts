import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchArtifacts } from "./artifacts"

const target = {
  format: "autofold.target-artifact.v1" as const,
  name: "Acceptance receptor",
  chains: [{ id: "A", sequence: "ACDEFGHIKLMNPQRSTVWY" }],
  bindingSite: {
    description: "Small deterministic test pocket",
    residues: [
      { chainId: "A", position: 4 },
      { chainId: "A", position: 9 },
    ],
  },
}

describe("research scientific artifacts", () => {
  test("stores and reloads a target by canonical content hash", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-target-"))
    try {
      const first = await ResearchArtifacts.authorTarget(workspace, target)
      const second = await ResearchArtifacts.authorTarget(workspace, { ...target, ignored: true } as never)
      expect(second.targetArtifactHash).toBe(first.targetArtifactHash)
      expect(second.targetArtifactPath).toBe(first.targetArtifactPath)
      expect(await ResearchArtifacts.readTarget(workspace, first.targetArtifactHash)).toEqual(first)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("rejects binding-site residues outside the declared chains", () => {
    expect(() =>
      ResearchArtifacts.TargetArtifact.parse({
        ...target,
        bindingSite: { residues: [{ chainId: "A", position: 21 }] },
      }),
    ).toThrow("exceeds chain A length")
  })

  test("stores a declared structure blob and rejects mismatched content", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-target-structure-"))
    const structure = new TextEncoder().encode("data_test\n#\n")
    const hash = new Bun.CryptoHasher("sha256").update(structure).digest("hex")
    const structured = {
      ...target,
      structure: { format: "mmcif" as const, contentHash: `sha256:${hash}` },
    }
    try {
      const stored = await ResearchArtifacts.authorTarget(workspace, structured, structure)
      expect(stored.structureArtifactPath).toEndWith("structure.cif")
      expect(await ResearchArtifacts.readTarget(workspace, stored.targetArtifactHash)).toEqual(stored)
      await expect(
        ResearchArtifacts.authorTarget(workspace, structured, new TextEncoder().encode("tampered")),
      ).rejects.toThrow("does not match")
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})
