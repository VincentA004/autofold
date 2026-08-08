#!/usr/bin/env python3
"""Run a bounded real-model acceptance graph through the trusted Proto bridge."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from autofold_worker.evidence_boltz2_v1 import _enrich_v4


def digest(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def canonical(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def commit(path: Path) -> str:
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proto-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-sequence", default="ACDEFGHIKLMNPQRSTVWY")
    parser.add_argument("--candidate", action="append")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)

    from proto_tools import ToolRegistry

    language_commit = commit(args.proto_root)
    tools_commit = commit(args.proto_root / "proto-tools")
    target = {
        "format": "autofold.target-artifact.v1",
        "name": "Bounded adaptive acceptance target",
        "chains": [{"id": "A", "sequence": args.target_sequence}],
    }
    target_path = args.output / "target.json"
    target_content = canonical(target)
    target_path.write_bytes(target_content)
    adapter_path = Path(__file__).parent / "autofold_worker" / "evidence_boltz2_v1.py"
    def model(key: str, config: dict[str, object]) -> dict[str, object]:
        return {"id": key, "toolKey": key, "version": tools_commit, "config": config}
    pipeline = {
        "id": "bounded-adaptive-acceptance",
        "protoToolsCommit": tools_commit,
        "stages": [
            {
                "id": "primary",
                "models": [model("boltz2-prediction", {"use_msa": False, "recycling_steps": 1, "sampling_steps": 20, "diffusion_samples": 1})],
                "dependsOn": [],
                "budget": {"maximumCandidates": 2, "maximumGpuSeconds": 900},
                "required": True,
                "allowSkip": False,
                "allowedSkips": [],
            },
            {
                "id": "independent",
                "models": [model("chai1-prediction", {"use_msa": False, "use_esm_embeddings": False, "num_trunk_recycles": 1, "num_diffn_timesteps": 20, "num_diffn_samples": 1, "num_trunk_samples": 1})],
                "dependsOn": ["primary"],
                "candidateRouting": {"source": "primary", "metric": "confidence_score", "direction": "maximize", "maximumCandidates": 1},
                "budget": {"maximumCandidates": 1, "maximumGpuSeconds": 900},
                "required": False,
                "allowSkip": True,
                "allowedSkips": ["candidate_filtered"],
            },
            {
                "id": "resolution",
                "models": [model("protenix-prediction", {"use_msa": False, "model_name": "protenix_tiny_default_v0.5.0", "num_diffusion_samples": 1, "num_diffusion_steps": 5, "num_pairformer_cycles": 2})],
                "dependsOn": ["independent"],
                "candidateRouting": {"source": "independent", "metric": "confidence_score", "direction": "maximize", "maximumCandidates": 1},
                "budget": {"maximumCandidates": 1, "maximumGpuSeconds": 900},
                "required": False,
                "allowSkip": True,
                "allowedSkips": ["candidate_filtered"],
            },
        ],
    }
    pipeline_hash = digest(json.dumps(pipeline, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    bundle = {
        "format": "autofold.trial-bundle.v4",
        "runId": "run_adaptive_acceptance",
        "trialId": "trl_adaptive_acceptance",
        "targetArtifactHash": digest(target_content),
        "targetArtifactPath": str(target_path),
        "evidenceAdapter": {"sourceHash": digest(adapter_path.read_bytes())},
        "proto": {"languageCommit": language_commit, "toolsCommit": tools_commit},
        "programHash": digest(b"adaptive acceptance"),
        "pipelineHash": pipeline_hash,
        "pipeline": pipeline,
        "modality": "short_peptide",
        "seeds": [7],
    }
    sequences = args.candidate or ["KLAEALKEKLAEALKE", "RQLDQLRERLQQLERE"]
    candidates = {
        "format": "autofold.candidate-set.v1",
        "candidates": [
            {"id": f"cand_acceptance_{index}", "sequence": sequence}
            for index, sequence in enumerate(sequences[:2], start=1)
        ],
    }
    (args.output / "bundle.json").write_bytes(canonical(bundle))
    (args.output / "candidates.input.json").write_bytes(canonical(candidates))
    enriched = _enrich_v4(bundle, candidates, args.output, ToolRegistry)
    (args.output / "candidates.enriched.json").write_bytes(canonical(enriched))
    index = json.loads((args.output / "model-runs" / "index.json").read_text(encoding="utf-8"))
    summary = {
        "candidates": len(enriched["candidates"]),
        "completed": sum(entry["status"] == "completed" for entry in index["entries"]),
        "skipped": sum(entry["status"] == "skipped" for entry in index["entries"]),
        "models": sorted({entry["modelId"] for entry in index["entries"] if entry["status"] == "completed"}),
        "output": str(args.output),
    }
    (args.output / "summary.json").write_bytes(canonical(summary))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
