import { describe, expect, test } from "bun:test"
import { clearOwnedArtifact, createArtifactContext, inferArtifactKind, type ArtifactContext } from "./context"

describe("artifact context", () => {
  test("normalizes equivalent locations to one stable identity", () => {
    const first = createArtifactContext({
      directory: "/work/project/",
      path: "./results\\water.xyz",
      format: ".XYZ",
      scienceKind: "chem-3d",
    })
    const second = createArtifactContext({
      directory: "/work/project",
      path: "results/water.xyz",
      format: "xyz",
      scienceKind: "chem-3d",
    })

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      name: "water.xyz",
      path: "results/water.xyz",
      format: "xyz",
      kind: "structure",
      scienceKind: "chem-3d",
    })
  })

  test("classifies scientific and publication formats without pretending unknown files are reports", () => {
    expect(inferArtifactKind("analysis.ipynb")).toBe("notebook")
    expect(inferArtifactKind("aligned.fasta", "msa")).toBe("sequence")
    expect(inferArtifactKind("variants.vcf")).toBe("genomics")
    expect(inferArtifactKind("sample.mzML")).toBe("spectrum")
    expect(inferArtifactKind("figure.svg")).toBe("figure")
    expect(inferArtifactKind("paper.tex")).toBe("report")
    expect(inferArtifactKind("weights.onnx")).toBe("model")
    expect(inferArtifactKind("pipeline.ts")).toBe("file")
  })

  test("uses the active renderer kind when an extension is ambiguous", () => {
    expect(inferArtifactKind("result.dat", "protein-structure")).toBe("structure")
    expect(inferArtifactKind("result.dat", "chem-2d")).toBe("structure")
    expect(inferArtifactKind("result.dat", "sequence")).toBe("sequence")
    expect(inferArtifactKind("result.dat", "genome-track")).toBe("genomics")
  })

  test("carries live scientific facts, capabilities, and selections without changing artifact identity", () => {
    const context = createArtifactContext({
      directory: "/work/project",
      path: "results/water.xyz",
      scienceKind: "chem-3d",
      inspection: {
        facts: [{ label: "atoms", value: "3" }],
        capabilities: ["Representations", "PNG export"],
        selection: { kind: "molecule", label: "O 1", count: 1 },
      },
    })

    expect(context.id).toContain("water.xyz")
    expect(context.inspection).toEqual({
      facts: [{ label: "atoms", value: "3" }],
      capabilities: ["Representations", "PNG export"],
      selection: { kind: "molecule", label: "O 1", count: 1 },
    })
  })

  test("only the owning document can clear active artifact state", () => {
    const active: ArtifactContext = createArtifactContext({
      directory: "/work/project",
      path: "results/current.pdb",
      format: "pdb",
      scienceKind: "protein-structure",
    })

    expect(clearOwnedArtifact(active, "artifact:/another/file")).toBe(active)
    expect(clearOwnedArtifact(active, active.id)).toBeUndefined()
    expect(clearOwnedArtifact(undefined, active.id)).toBeUndefined()
  })
})
