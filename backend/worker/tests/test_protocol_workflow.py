from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from autofold_worker.protocol import ProtocolError, validate_workflow_source


class FrozenWorkflowSourceTest(unittest.TestCase):
    def test_binds_the_compiled_pipeline_to_the_literal_proto_manifest(self) -> None:
        workflow = {
            "format": "autofold.proto-workflow.v1",
            "id": "dynamic",
            "maximumGpuSeconds": 100,
            "stages": [
                {
                    "id": "primary",
                    "capability": "structure_prediction",
                    "tools": ["boltz2-prediction"],
                    "maximumGpuSeconds": 100,
                }
            ],
        }
        normalized = json.loads(json.dumps(workflow))
        normalized["stages"][0].update({"selection": "all", "configs": {}, "dependsOn": [], "optional": False})
        digest = "sha256:" + hashlib.sha256(
            json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        bundle = {"format": "autofold.trial-bundle.v4", "pipeline": {"sourceHash": digest}}
        with tempfile.TemporaryDirectory() as temporary:
            trial = Path(temporary) / "trial.py"
            trial.write_text(f"AUTOFOLD_WORKFLOW = {workflow!r}\n", encoding="utf-8")
            validate_workflow_source(trial, bundle)
            trial.write_text(trial.read_text(encoding="utf-8").replace("100", "101", 1), encoding="utf-8")
            with self.assertRaisesRegex(ProtocolError, "does not match"):
                validate_workflow_source(trial, bundle)


if __name__ == "__main__":
    unittest.main()
