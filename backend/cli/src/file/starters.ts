import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"

export namespace StarterFile {
  export const Template = z.enum(["single-cell", "dose-response", "protein-structure"])
  export type Template = z.infer<typeof Template>

  export const Result = z.object({
    template: Template,
    directory: z.string(),
    files: z.string().array(),
    notebook: z.string(),
    readme: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export async function create(root: string, template: Template): Promise<Result> {
    const parsed = Template.parse(template)
    const directory = path.join("openscience-starters", parsed)
    const target = path.join(root, directory)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const created = await fs
      .mkdir(target)
      .then(() => true)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
        throw error
      })
    if (!created) throw new Error(`The ${parsed} starter already exists at ${directory}`)
    const content = files(parsed)
    const names = Object.keys(content).toSorted()
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(target, name)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, content[name]!)
      }),
    )
    return Result.parse({
      template: parsed,
      directory,
      files: names.map((name) => path.join(directory, name).split(path.sep).join("/")),
      notebook: path.join(directory, "analysis.ipynb").split(path.sep).join("/"),
      readme: path.join(directory, "README.md").split(path.sep).join("/"),
    })
  }

  function files(template: Template): Record<string, string> {
    if (template === "single-cell") return singleCell()
    if (template === "dose-response") return doseResponse()
    return proteinStructure()
  }

  function notebook(title: string, intro: string, cells: string[]): string {
    return JSON.stringify(
      {
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: [`# ${title}\n`, `${intro}\n`],
          },
          ...cells.map((source) => ({
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: source.split("\n").map((line) => `${line}\n`),
          })),
        ],
        metadata: {
          kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
          language_info: { name: "python", version: "3" },
          openscience: { starter: true },
        },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      2,
    )
  }

  function singleCell(): Record<string, string> {
    return {
      "README.md":
        "# Single-cell starter\n\nA small, local-first expression matrix for exploring QC, normalization, clustering, and cell-type annotation. Open `analysis.ipynb` in OpenScience and run each cell. Replace `data/cells.csv` with your own matrix when ready.\n",
      "data/cells.csv":
        "cell,cell_type,CD3D,MS4A1,LYZ,NKG7,MKI67\ncell_001,T cell,9,0,1,6,0\ncell_002,T cell,8,0,0,7,1\ncell_003,B cell,0,10,1,0,0\ncell_004,B cell,0,8,0,1,0\ncell_005,Monocyte,1,0,11,2,0\ncell_006,Monocyte,0,0,9,1,1\ncell_007,NK cell,2,0,0,12,0\ncell_008,NK cell,1,0,1,10,0\ncell_009,Cycling,4,1,2,3,13\ncell_010,Cycling,3,2,1,4,11\n",
      "analysis.ipynb": notebook(
        "Single-cell expression starter",
        "Inspect a tiny expression matrix, calculate per-cell QC, and visualize marker structure without external downloads.",
        [
          "import csv\nfrom pathlib import Path\nrows = list(csv.DictReader(Path('data/cells.csv').open()))\ngenes = ['CD3D', 'MS4A1', 'LYZ', 'NKG7', 'MKI67']\nlen(rows), genes",
          "qc = [{'cell': row['cell'], 'type': row['cell_type'], 'total': sum(int(row[g]) for g in genes), 'detected': sum(int(row[g]) > 0 for g in genes)} for row in rows]\nqc",
          "from collections import defaultdict\nmeans = defaultdict(lambda: defaultdict(list))\nfor row in rows:\n    for gene in genes:\n        means[row['cell_type']][gene].append(int(row[gene]))\nsummary = {kind: {gene: round(sum(values[gene]) / len(values[gene]), 2) for gene in genes} for kind, values in means.items()}\nsummary",
        ],
      ),
    }
  }

  function doseResponse(): Record<string, string> {
    return {
      "README.md":
        "# Dose-response starter\n\nA compact plate-style dose-response dataset with vehicle controls and replicates. Use `analysis.ipynb` to aggregate response, estimate the half-maximal crossing, and review assay quality before replacing the sample CSV.\n",
      "data/dose_response.csv":
        "compound,dose_uM,replicate,response_pct\nVehicle,0,1,100\nVehicle,0,2,98\nCompound-A,0.001,1,96\nCompound-A,0.001,2,94\nCompound-A,0.01,1,87\nCompound-A,0.01,2,84\nCompound-A,0.1,1,62\nCompound-A,0.1,2,58\nCompound-A,1,1,31\nCompound-A,1,2,28\nCompound-A,10,1,9\nCompound-A,10,2,11\n",
      "analysis.ipynb": notebook(
        "Dose-response assay starter",
        "Aggregate technical replicates and estimate the observed half-response crossing using only the Python standard library.",
        [
          "import csv\nfrom pathlib import Path\nrows = list(csv.DictReader(Path('data/dose_response.csv').open()))\nrows[:3]",
          "from collections import defaultdict\nseries = defaultdict(list)\nfor row in rows:\n    if row['compound'] != 'Vehicle':\n        series[float(row['dose_uM'])].append(float(row['response_pct']))\nmeans = {dose: round(sum(values) / len(values), 2) for dose, values in sorted(series.items())}\nmeans",
          "crossing = min(means, key=lambda dose: abs(means[dose] - 50))\n{'nearest_half_max_dose_uM': crossing, 'response_pct': means[crossing], 'replicates_per_dose': {dose: len(values) for dose, values in series.items()}}",
        ],
      ),
    }
  }

  function proteinStructure(): Record<string, string> {
    return {
      "README.md":
        "# Protein-structure starter\n\nA tiny alanine peptide structure for learning the native PDB viewer, measuring geometry, and preparing downstream docking or molecular-dynamics work. Open `data/alanine.pdb` for the 3D view and `analysis.ipynb` for a dependency-free inspection.\n",
      "data/alanine.pdb":
        "HEADER    OPENSCIENCE ALANINE STARTER\nATOM      1  N   ALA A   1      -1.458   0.000   0.000  1.00 20.00           N\nATOM      2  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C\nATOM      3  C   ALA A   1       0.540   1.430   0.000  1.00 20.00           C\nATOM      4  O   ALA A   1      -0.160   2.390   0.000  1.00 20.00           O\nATOM      5  CB  ALA A   1       0.510  -0.770  -1.220  1.00 20.00           C\nTER\nEND\n",
      "analysis.ipynb": notebook(
        "Protein structure starter",
        "Parse atoms and calculate the structure centroid before moving to docking or molecular dynamics.",
        [
          "from pathlib import Path\nlines = Path('data/alanine.pdb').read_text().splitlines()\natoms = [line for line in lines if line.startswith(('ATOM  ', 'HETATM'))]\nlen(atoms)",
          "coords = [(float(line[30:38]), float(line[38:46]), float(line[46:54])) for line in atoms]\ncentroid = tuple(round(sum(axis) / len(coords), 3) for axis in zip(*coords))\n{'atoms': len(atoms), 'centroid_angstrom': centroid}",
          "elements = {}\nfor line in atoms:\n    element = line[76:78].strip() or line[12:16].strip()[0]\n    elements[element] = elements.get(element, 0) + 1\nelements",
        ],
      ),
    }
  }
}
