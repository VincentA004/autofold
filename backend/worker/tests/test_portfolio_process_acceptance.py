"""CPU integration: real isolated processes; synthetic model work, never GPU proof."""
import json
import tempfile
import unittest
from pathlib import Path

from autofold_worker.cli import _isolated_stage


class PortfolioProcessAcceptanceTest(unittest.TestCase):
    def test_diagnostics_child_socket_lane_timeout_and_next_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / ("run_" + "a" * 80)
            root.mkdir()
            output = root / "output"
            runtime = root / "runtime.json"
            candidates = root / "candidates.json"
            adapter = root / "adapter.py"
            bundle = {"candidateBudget": 1, "seeds": [7], "pipeline": {
                "stages": [{"models": [{"id": "fixture"}], "budget": {"maximumGpuSeconds": 15}}]}}
            runtime.write_text(json.dumps(bundle))
            candidates.write_text('{"candidates": []}')
            adapter.write_text(r"""
import os, subprocess, sys, tempfile
from types import SimpleNamespace
from autofold_worker.generator_diagnostics import GeneratorDiagnosticsCapture
from autofold_worker.proto_portfolio import ProtoPortfolioProgram
from autofold_worker.compatibility.proto_v1 import _run_with_hard_deadline

def enrich(bundle, candidates, output):
    before = (os.environ.get('TMPDIR'), tempfile.tempdir)
    sequences = []
    def successful():
        # The real child inherits the diagnostic environment. Exercise the
        # same Unix-socket boundary used by tensor sharing, plus pipe drainage.
        code = "import tempfile; from multiprocessing.connection import Listener; d=tempfile.TemporaryDirectory(prefix='pymp-'); l=Listener(d.name+'/listener-test', family='AF_UNIX'); print('x'*200000); l.close(); d.cleanup()"
        child = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=5)
        assert child.returncode == 0, child.stderr
        assert len(child.stdout) > 100000
        sequences.append({'id':'one','sequence':'ACDEFGHIK','seed':7})
    def failing():
        def work():
            subprocess.run([sys.executable, '-c', 'import time; time.sleep(30)'], check=True)
        _run_with_hard_deadline(work, 'fixture-failure', 1)
    def lane(fn):
        return SimpleNamespace(run=fn, optimizers=[SimpleNamespace(generators=[])], constructs=[])
    portfolio = ProtoPortfolioProgram([lane(successful), lane(failing)])
    with GeneratorDiagnosticsCapture(output, enabled=True) as diagnostics:
        (diagnostics.root/'rejected_mpnn_full_stats.csv').write_text('Design,Sequence,pLDDT\nfailed,AAAA,1\n')
        portfolio.run()
    assert (os.environ.get('TMPDIR'), tempfile.tempdir) == before
    assert not diagnostics.root.exists()
    assert len(portfolio.lane_failures) == 1
    assert 'allocation' in portfolio.lane_failures[0]['message']
    return {'candidates':sequences, 'laneFailures':portfolio.lane_failures, 'diagnostics':diagnostics.summary()}
""")
            result = _isolated_stage("evidence", bundle, output, runtime,
                output / ".stages/evidence-result.json", candidate_set_path=candidates,
                evidence_adapter_source=adapter)
            self.assertEqual(result["candidates"][0]["sequence"], "ACDEFGHIK")
            self.assertEqual(result["diagnostics"][0]["rejectedCandidates"], 1)
            self.assertEqual(len(result["laneFailures"]), 1)
            # A fresh downstream process sees the surviving candidate, with no
            # diagnostic TMPDIR leak from the terminated lane's stage.
            candidates.write_text(json.dumps(result))
            adapter.write_text("def enrich(bundle, candidates, output):\n    assert len(candidates['candidates']) == 1\n    candidates['downstreamCompleted'] = True\n    return candidates\n")
            following = _isolated_stage("evidence", bundle, output, runtime,
                output / ".stages/following-result.json", candidate_set_path=candidates,
                evidence_adapter_source=adapter)
            self.assertTrue(following["downstreamCompleted"])
