from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from autofold_worker.cli import _isolated_stage, _validate_worker_tree, _display_lock_stalled


class StageIsolationTest(unittest.TestCase):
    def test_display_watchdog_requires_three_consecutive_main_thread_lock_samples(self) -> None:
        blocked = "Timeout (0:02:00)!\nThread main:\n tqdm/std.py in acquire in refresh in __iter__ in run_chai1\n"
        active = "Timeout (0:02:00)!\nThread main:\n waiting for a legitimate model request\n"
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "stack.log"
            for samples, expected in [(blocked * 2, False), (blocked * 3, True), (blocked * 3 + active, False)]:
                file.write_text(samples)
                self.assertEqual(_display_lock_stalled(file), expected)

    def test_headless_environment_and_injected_display_lock_stall(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            runtime, candidates, adapter = (root / name for name in ("runtime.json", "candidates.json", "adapter.py"))
            runtime.write_text(json.dumps(self.bundle()))
            candidates.write_text('{"candidates": []}')
            sample = "Timeout (0:02:00)!\nThread main:\n tqdm/std.py in acquire in refresh in __iter__ in run_chai1\n"
            adapter.write_text(
                "import os, time\n"
                "def enrich(bundle, candidates, output):\n"
                "    assert os.environ['PROTO_NO_SPINNER'] == '1'\n"
                "    assert os.environ['TQDM_DISABLE'] == '1'\n"
                f"    (output / '.stages/evidence-stack.log').write_text({sample * 3!r})\n"
                "    time.sleep(60)\n"
            )
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, "terminal progress rendering"):
                _isolated_stage("evidence", self.bundle(), output, runtime, output / '.stages/evidence-result.json',
                    candidate_set_path=candidates, evidence_adapter_source=adapter)
            self.assertLess(time.monotonic() - started, 15)
            state = json.loads((output / 'execution-stage.json').read_text())
            self.assertEqual(state['errorType'], 'ProgressRenderingStall')

    def test_worker_tree_identity_rejects_changed_runtime_bytes(self) -> None:
        with self.assertRaisesRegex(ValueError, "Worker tree hash mismatch"):
            _validate_worker_tree({
                "worker": {
                    "format": "autofold.worker-tree.v1",
                    "sourceHash": "sha256:" + "0" * 64,
                }
            })

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

    def test_aggregate_allocation_stops_before_launching_another_stage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            runtime = root / "runtime.json"
            result = output / ".stages" / "generation-result.json"
            runtime.write_text(json.dumps(self.bundle()), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "aggregate worker GPU allocation"):
                _isolated_stage(
                    "generation",
                    self.bundle(),
                    output,
                    runtime,
                    result,
                    aggregate_deadline=time.monotonic() - 1,
                )
            state = json.loads((output / "execution-stage.json").read_text(encoding="utf-8"))
            self.assertEqual(state["status"], "timed_out")


if __name__ == "__main__":
    unittest.main()
