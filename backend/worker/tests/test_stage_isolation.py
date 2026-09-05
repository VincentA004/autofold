from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from autofold_worker.cli import _isolated_stage


class StageIsolationTest(unittest.TestCase):
    def bundle(self) -> dict[str, object]:
        return {
            "candidateBudget": 1,
            "seeds": [7],
            "pipeline": {
                "stages": [{"models": [{"id": "fixture"}], "budget": {"maximumGpuSeconds": 1}}]
            },
        }

    def test_evidence_runs_in_a_disposable_process_and_persists_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            runtime = root / "runtime.json"
            candidates = root / "candidates.json"
            adapter = root / "adapter.py"
            result = output / ".stages" / "evidence-result.json"
            runtime.write_text(json.dumps(self.bundle()), encoding="utf-8")
            candidates.write_text(json.dumps({"candidates": [{"id": "one", "sequence": "ACDE"}]}), encoding="utf-8")
            adapter.write_text(
                "def enrich(bundle, candidate_set, output):\n"
                "    candidate_set['stagePid'] = __import__('os').getpid()\n"
                "    return candidate_set\n",
                encoding="utf-8",
            )
            observed = _isolated_stage(
                "evidence",
                self.bundle(),
                output,
                runtime,
                result,
                candidate_set_path=candidates,
                evidence_adapter_source=adapter,
            )
            state = json.loads((output / "execution-stage.json").read_text(encoding="utf-8"))
            self.assertNotEqual(observed["stagePid"], __import__("os").getpid())
            self.assertEqual(state["stage"], "evidence")
            self.assertEqual(state["status"], "completed")
            self.assertTrue((output / ".stages" / "evidence-stack.log").is_file())

    def test_stage_failure_records_the_original_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            runtime = root / "runtime.json"
            candidates = root / "candidates.json"
            adapter = root / "adapter.py"
            result = output / ".stages" / "evidence-result.json"
            runtime.write_text(json.dumps(self.bundle()), encoding="utf-8")
            candidates.write_text(json.dumps({"candidates": []}), encoding="utf-8")
            # RuntimeError deliberately sits outside the old hand-maintained
            # exception tuple. Plugin/model integrations routinely raise it,
            # and their diagnostic must survive the disposable stage boundary.
            adapter.write_text("def enrich(bundle, candidate_set, output):\n    raise RuntimeError('validator exploded')\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "validator exploded"):
                _isolated_stage(
                    "evidence",
                    self.bundle(),
                    output,
                    runtime,
                    result,
                    candidate_set_path=candidates,
                    evidence_adapter_source=adapter,
                )
            state = json.loads((output / "execution-stage.json").read_text(encoding="utf-8"))
            self.assertEqual(state["status"], "failed")
            self.assertEqual(state["error"], "validator exploded")


if __name__ == "__main__":
    unittest.main()
