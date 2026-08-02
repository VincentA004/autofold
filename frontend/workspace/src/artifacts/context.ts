import { createSignal } from "solid-js"
import type { ArtifactKind } from "./model"
import type { ArtifactInspection } from "@/science/renderers"

export type ArtifactContextKind = ArtifactKind | "file"

export interface ArtifactContext {
  id: string
  directory: string
  path: string
  name: string
  format: string
  kind: ArtifactContextKind
  scienceKind?: string
  inspection?: ArtifactInspection
}

export interface ArtifactContextInput {
  directory: string
  path: string
  format?: string
  scienceKind?: string
  inspection?: ArtifactInspection
}

const kinds: Partial<Record<string, ArtifactContextKind>> = {
  ipynb: "notebook",
  csv: "dataset",
  tsv: "dataset",
  jsonl: "dataset",
  parquet: "dataset",
  arrow: "dataset",
  feather: "dataset",
  h5: "dataset",
  hdf5: "dataset",
  h5ad: "dataset",
  loom: "dataset",
  zarr: "dataset",
  png: "figure",
  jpg: "figure",
  jpeg: "figure",
  gif: "figure",
  webp: "figure",
  bmp: "figure",
  svg: "figure",
  pdf: "report",
  md: "report",
  markdown: "report",
  mdx: "report",
  tex: "report",
  latex: "report",
  docx: "report",
  pptx: "report",
  pdb: "structure",
  ent: "structure",
  cif: "structure",
  mmcif: "structure",
  bcif: "structure",
  pdbqt: "structure",
  gro: "structure",
  xyz: "structure",
  sdf: "structure",
  mol: "structure",
  mol2: "structure",
  smi: "structure",
  smiles: "structure",
  fa: "sequence",
  fasta: "sequence",
  faa: "sequence",
  fna: "sequence",
  ffn: "sequence",
  frn: "sequence",
  aln: "sequence",
  clustal: "sequence",
  bam: "genomics",
  cram: "genomics",
  sam: "genomics",
  vcf: "genomics",
  bcf: "genomics",
  bed: "genomics",
  gff: "genomics",
  gff3: "genomics",
  gtf: "genomics",
  bigwig: "genomics",
  bw: "genomics",
  bigbed: "genomics",
  mzml: "spectrum",
  mzxml: "spectrum",
  mgf: "spectrum",
  msp: "spectrum",
  onnx: "model",
  pt: "model",
  pth: "model",
  safetensors: "model",
  pkl: "model",
  joblib: "model",
  zip: "archive",
  tar: "archive",
  tgz: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
}

const science: Partial<Record<string, ArtifactContextKind>> = {
  "protein-structure": "structure",
  "chem-2d": "structure",
  "chem-3d": "structure",
  sequence: "sequence",
  msa: "sequence",
  "genome-track": "genomics",
  pdf: "report",
  latex: "report",
}

function cleanDirectory(value: string): string {
  const next = value.replaceAll("\\", "/").replace(/\/+$/, "")
  return next || "/"
}

function cleanPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/")
}

function extension(value: string): string {
  const name = cleanPath(value).split("/").pop() ?? ""
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
}

export function inferArtifactKind(path: string, scienceKind?: string): ArtifactContextKind {
  if (scienceKind && science[scienceKind]) return science[scienceKind]
  return kinds[extension(path)] ?? "file"
}

export function createArtifactContext(input: ArtifactContextInput): ArtifactContext {
  const directory = cleanDirectory(input.directory)
  const path = cleanPath(input.path)
  const name = path.split("/").pop() || path
  const format = (input.format ?? extension(path)).replace(/^\./, "").toLowerCase()
  return {
    id: `artifact:${encodeURIComponent(directory)}::${encodeURIComponent(path)}`,
    directory,
    path,
    name,
    format,
    kind: inferArtifactKind(path, input.scienceKind),
    ...(input.scienceKind ? { scienceKind: input.scienceKind } : {}),
    ...(input.inspection ? { inspection: input.inspection } : {}),
  }
}

export function clearOwnedArtifact(current: ArtifactContext | undefined, owner: string): ArtifactContext | undefined {
  if (current?.id === owner) return
  return current
}

const [active, setActive] = createSignal<ArtifactContext | undefined>()

export const artifactContext = {
  active,
  activate(value: ArtifactContext) {
    setActive(value)
  },
  clear(owner: string) {
    setActive((current) => clearOwnedArtifact(current, owner))
  },
}
