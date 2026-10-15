import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ResearchPrograms } from "./programs"
import { ResearchArtifacts } from "./artifacts"
import { confinedPath } from "../util/confinement"

const target = { format: "autofold.target-artifact.v1" as const, name: "Test target",
  chains: [{ id: "A", sequence: "ACDEFG" }], bindingSite: { residues: [{ chainId: "A", position: 1 }] } }
const program = { hypothesis: "Confined authoring", designAdapter: "mock" as const, program: "# confined trial\n" }
async function fixture(fn: (workspace: string, outside: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autofold-confinement-"))
  const workspace = path.join(root, "workspace"), outside = path.join(root, "outside")
  await fs.mkdir(workspace); await fs.mkdir(outside)
  try { await fn(workspace, outside) } finally { await fs.rm(root, { recursive: true, force: true }) }
}

test("symlinked programs and target directories cannot redirect authoring outside the workspace", async () => {
  for (const collection of ["programs", "targets"]) await fixture(async (workspace, outside) => {
    await fs.mkdir(path.join(workspace, ".autofold"))
    await fs.symlink(outside, path.join(workspace, ".autofold", collection))
    const operation = collection === "programs" ? ResearchPrograms.author(workspace, program)
      : ResearchArtifacts.authorTarget(workspace, target)
    await expect(operation).rejects.toThrow("escapes the project")
    expect(await fs.readdir(outside)).toEqual([])
  })
})

test("existing leaf symlinks cannot redirect artifact reads or immutable program collision checks", async () => {
  await fixture(async (workspace, outside) => {
    const authored = await ResearchPrograms.author(workspace, program)
    const externalProgram = path.join(outside, "trial.py")
    await fs.writeFile(externalProgram, program.program)
    await fs.unlink(path.join(workspace, authored.programPath))
    await fs.symlink(externalProgram, path.join(workspace, authored.programPath))
    await expect(ResearchPrograms.author(workspace, program)).rejects.toThrow("escapes the project")
    expect(await fs.readFile(externalProgram, "utf8")).toBe(program.program)
    const artifact = await ResearchArtifacts.authorTarget(workspace, target)
    const externalTarget = path.join(outside, "target.json")
    const original = await fs.readFile(path.join(workspace, artifact.targetArtifactPath), "utf8")
    await fs.writeFile(externalTarget, original)
    await fs.unlink(path.join(workspace, artifact.targetArtifactPath))
    await fs.symlink(externalTarget, path.join(workspace, artifact.targetArtifactPath))
    await expect(ResearchArtifacts.readTarget(workspace, artifact.targetArtifactHash)).rejects.toThrow("escapes the project")
    await expect(ResearchArtifacts.authorTarget(workspace, target)).rejects.toThrow("escapes the project")
    expect(await fs.readFile(externalTarget, "utf8")).toBe(original)
  })
})

test("structure escape is rejected before a target JSON artifact is created", async () => {
  await fixture(async (workspace, outside) => {
    const structure = Buffer.from("HEADER confined structure\n")
    const artifact = { ...target, structure: { format: "pdb" as const,
      contentHash: `sha256:${new Bun.CryptoHasher("sha256").update(structure).digest("hex")}` } }
    const hash = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(ResearchArtifacts.TargetArtifact.parse(artifact), null, 2) + "\n").digest("hex")}`
    const relative = ResearchArtifacts.targetPath(hash), directory = path.dirname(path.join(workspace, relative))
    await fs.mkdir(directory, { recursive: true })
    const externalStructure = path.join(outside, "structure.pdb")
    await fs.writeFile(externalStructure, structure)
    await fs.symlink(externalStructure, path.join(directory, "structure.pdb"))
    await expect(ResearchArtifacts.authorTarget(workspace, artifact, structure)).rejects.toThrow("escapes the project")
    expect(await fs.readdir(directory)).toEqual(["structure.pdb"])
    expect(await fs.readFile(externalStructure)).toEqual(structure)
  })
})

test("in-workspace links preserve public artifact paths and content identities", async () => {
  await fixture(async (workspace) => {
    await fs.mkdir(path.join(workspace, ".autofold"))
    for (const collection of ["programs", "targets"]) {
      const internal = path.join(workspace, `${collection}-storage`)
      await fs.mkdir(internal)
      await fs.symlink(internal, path.join(workspace, ".autofold", collection))
    }
    const authored = await ResearchPrograms.author(workspace, program)
    expect(authored.programPath).toBe(`.autofold/programs/${authored.programHash.slice(7)}/trial.py`)
    expect(await ResearchPrograms.author(workspace, program)).toEqual(authored)
    const artifact = await ResearchArtifacts.authorTarget(workspace, target)
    expect(await ResearchArtifacts.readTarget(workspace, artifact.targetArtifactHash)).toEqual(artifact)
    expect(await ResearchArtifacts.authorTarget(workspace, target)).toEqual(artifact)
  })
})

test("lexical escapes and dangling links are rejected before filesystem changes", async () => {
  await fixture(async (workspace, outside) => {
    await expect(confinedPath(workspace, "../outside/file")).rejects.toThrow("escapes the project")
    await fs.symlink(path.join(outside, "missing"), path.join(workspace, ".autofold"))
    await expect(ResearchPrograms.author(workspace, program)).rejects.toThrow()
    expect(await fs.readdir(outside)).toEqual([])
  })
})
