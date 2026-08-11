"""Run an auditable Protenix resolution diagnostic outside a locked trial score.

This intentionally does not emit an Autofold candidate set or evaluation.  It is
for investigating a predictor outlier without mutating a frozen experiment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


def _sha256(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def _structure_cif(structure: Any) -> str:
    value = structure.structure_cif
    return value() if callable(value) else value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="Target protein sequence")
    parser.add_argument("--binder", required=True, help="Peptide binder sequence")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="protenix-v2")
    parser.add_argument("--seed", default=20260809, type=int)
    parser.add_argument("--samples", default=1, type=int)
    parser.add_argument("--steps", default=200, type=int)
    parser.add_argument("--cycles", default=10, type=int)
    parser.add_argument("--use-msa", action="store_true")
    args = parser.parse_args()

    proto_root = os.environ.get("AUTOFOLD_PROTO_ROOT")
    if proto_root:
        sys.path.insert(0, str(Path(proto_root) / "proto-tools"))
        sys.path.insert(0, proto_root)

    from proto_tools import ToolRegistry

    spec = ToolRegistry.get("protenix-prediction")
    config = spec.config_model(
        model_name=args.model,
        seed=args.seed,
        num_diffusion_samples=args.samples,
        num_diffusion_steps=args.steps,
        num_pairformer_cycles=args.cycles,
        use_msa=args.use_msa,
        include_pae_matrix=False,
    )
    inputs = spec.input_model(complexes=[[args.target, args.binder]])

    started = time.monotonic()
    prediction = spec.function(inputs, config)
    wall_seconds = time.monotonic() - started
    if not prediction.structures:
        raise RuntimeError("Protenix returned no structures")

    structure = prediction.structures[0]
    structure_text = _structure_cif(structure)
    metrics = structure.metrics.model_dump(mode="json")
    args.output.mkdir(parents=True, exist_ok=True)
    structure_path = args.output / "prediction.cif"
    structure_path.write_text(structure_text, encoding="utf-8")
    artifact = {
        "format": "autofold.predictor-diagnostic.v1",
        "purpose": "resolution_predictor_outlier",
        "candidateSequenceHash": _sha256(args.binder.encode("utf-8")),
        "targetSequenceHash": _sha256(args.target.encode("utf-8")),
        "tool": "protenix-prediction",
        "config": config.model_dump(mode="json"),
        "runtime": {"wallSeconds": wall_seconds},
        "outputs": {
            "structure": "prediction.cif",
            "structureHash": _sha256(structure_text.encode("utf-8")),
        },
        "metrics": metrics,
    }
    artifact_path = args.output / "diagnostic.json"
    artifact_path.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(artifact, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
