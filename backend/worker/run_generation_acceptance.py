#!/usr/bin/env python3
"""Run one real Proto generation through Autofold's trusted artifact boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

from autofold_worker.cli import run


def digest(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def canonical(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def commit(path: Path) -> str:
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proto-root", type=Path, required=True)
    parser.add_argument("--target-structure", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-chain", default="A")
    parser.add_argument("--hotspot", action="append", type=int, default=[37, 39, 41])
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=False)
    bundle_dir = args.output / "bundle"
    bundle_dir.mkdir()
    source_root = Path(__file__).resolve().parent
    evaluator = source_root / "autofold_worker" / "peptide_panel_v1.py"
    evidence = source_root / "autofold_worker" / "evidence_boltz2_v1.py"
    trial_source = source_root / "examples" / "rfdiffusion_mpnn_trial.py"
    trial_path = bundle_dir / "trial.py"
    target_structure_path = bundle_dir / "target.pdb"
    shutil.copyfile(trial_source, trial_path)
    shutil.copyfile(args.target_structure, target_structure_path)

    from proto_tools.entities.structures import Structure

    structure_content = target_structure_path.read_bytes()
    structure = Structure(structure=structure_content.decode("utf-8"))
    target_sequence = structure.get_chain_sequence(args.target_chain, remove_non_standard=True)
    target = {
        "format": "autofold.target-artifact.v1",
        "name": "Bounded generation acceptance target",
        "chains": [{"id": args.target_chain, "sequence": target_sequence}],
        "bindingSite": {
            "description": "Acceptance epitope supplied to RFdiffusion3",
            "residues": [{"chainId": args.target_chain, "position": position} for position in args.hotspot],
        },
        "structure": {"contentHash": digest(structure_content), "format": "pdb"},
    }
    target_path = bundle_dir / "target.json"
    target_content = canonical(target)
    target_path.write_bytes(target_content)

    language_commit = commit(args.proto_root)
    tools_commit = commit(args.proto_root / "proto-tools")
    model = {
        "id": "boltz2-prediction",
        "toolKey": "boltz2-prediction",
        "version": tools_commit,
        "config": {"use_msa": False, "recycling_steps": 1, "sampling_steps": 20, "diffusion_samples": 1},
    }
    pipeline = {
        "id": "bounded-generation-acceptance",
        "protoToolsCommit": tools_commit,
        "generation": {
            "mode": "proto_program",
            "generators": [
                {
                    "id": "rfdiffusion-mpnn-binder",
                    "version": language_commit,
                    "toolsCalled": ["ligandmpnn-sample", "proteinmpnn-sample", "rfdiffusion3-design"],
                }
            ],
            "budget": {"maximumCandidates": 1, "maximumGpuSeconds": 1800},
        },
        "stages": [
            {
                "id": "primary",
                "models": [model],
                "dependsOn": [],
                "budget": {"maximumCandidates": 1, "maximumGpuSeconds": 900},
                "required": True,
                "allowSkip": False,
                "allowedSkips": [],
            }
        ],
    }
    pipeline_hash = digest(json.dumps(pipeline, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    bundle = {
        "format": "autofold.trial-bundle.v4",
        "runId": "run_generation_acceptance",
        "trialId": "trl_generation_acceptance",
        "contractHash": digest(canonical({"objective": "bounded real generation acceptance"})),
        "targetArtifactHash": digest(target_content),
        "targetArtifactPath": "target.json",
        "targetStructurePath": "target.pdb",
        "designAdapter": "proto",
        "programPath": "trial.py",
        "programHash": digest(trial_path.read_bytes()),
        "evaluator": {
            "id": "peptide-panel",
            "version": "1",
            "direction": "minimize",
            "sourceHash": digest(evaluator.read_bytes()),
        },
        "evidenceAdapter": {"id": "proto-consensus", "version": "1", "sourceHash": digest(evidence.read_bytes())},
        "proto": {"root": str(args.proto_root.resolve()), "languageCommit": language_commit, "toolsCommit": tools_commit},
        "pipeline": pipeline,
        "pipelineHash": pipeline_hash,
        "modality": "short_peptide",
        "seeds": [20260808],
        "candidateBudget": 1,
        "submissionSize": 1,
    }
    bundle_path = bundle_dir / "bundle.json"
    bundle_path.write_bytes(canonical(bundle))
    run(bundle_path, args.output / "run", evaluator, evidence)
    manifest = json.loads((args.output / "run" / "manifest.json").read_text(encoding="utf-8"))
    generation = json.loads((args.output / "run" / "generation-runs" / "index.json").read_text(encoding="utf-8"))
    print(json.dumps({"manifestFiles": sorted(manifest["files"]), "generation": generation}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
