"""Remote process control acceptance, entirely within local temporary directories."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'autofold_worker' / 'remote_supervisor.py'
spec = importlib.util.spec_from_file_location('remote_supervisor', SOURCE)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)

class RemoteSupervisorTest(unittest.TestCase):
    def test_fresh_runtime_freeze_excludes_unassigned_paths_but_preserves_historical_environment(self):
        inherited = {"PATH":"/native/bin", "PROTO_HOME":"/changed/cache", "AUTOFOLD_PROTO_ROOT":"/changed/source", "AUTOFOLD_PXDESIGN_EXECUTABLE":"/changed/executable"}
        frozen = control.worker_environment({"freezeRuntimeEnvironment":True,"environment":{"AUTOFOLD_PROTO_ROOT":"/frozen/source"}}, inherited)
        self.assertEqual(frozen["AUTOFOLD_PROTO_ROOT"],"/frozen/source")
        self.assertNotIn("PROTO_HOME",frozen)
        self.assertNotIn("AUTOFOLD_PXDESIGN_EXECUTABLE",frozen)
        self.assertEqual(frozen["PATH"],"/native/bin")
        historical = control.worker_environment({},inherited)
        self.assertEqual(historical["PROTO_HOME"],inherited["PROTO_HOME"])
        with self.assertRaisesRegex(ValueError,"flag"):
            control.worker_environment({"freezeRuntimeEnvironment":1},inherited)
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='remote-control-')
        self.root = Path(self.temporary.name).resolve()
        self.worker = self.root / 'worker'
        (self.worker / 'autofold_worker').mkdir(parents=True)
        shutil.copyfile(SOURCE, self.worker / 'autofold_worker/remote_supervisor.py')
        (self.worker / 'autofold_worker/evaluator.py').write_text('# frozen fixture evaluator\n')

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self, script, timeout_ms=5000):
        (self.worker / 'run_worker.py').write_text(script)
        bundle = self.root / 'bundle.json'
        bundle.write_text(json.dumps({'runId': 'run_fixture'}))
        self.bundle_hash = 'sha256:' + hashlib.sha256(bundle.read_bytes()).hexdigest()
        self.source_hash = control.worker_hash(self.worker)
        plan = {'format': 'autofold.remote-plan.v1', 'runId': 'run_fixture', 'bundleHash': self.bundle_hash, 'workerHash': self.source_hash,
                'timeoutMs': timeout_ms, 'argv': [sys.executable, str(self.worker / 'run_worker.py'), '--bundle', str(bundle), '--output', str(self.root / 'output'), '--evaluator-source', str(self.worker / 'autofold_worker/evaluator.py')], 'environment': {}}
        (self.root / 'remote-plan.json').write_text(json.dumps(plan))
        return plan

    def call(self, action, *flags):
        result = subprocess.run([sys.executable, str(self.worker / 'autofold_worker/remote_supervisor.py'), action, '--directory', str(self.root), '--bundle-hash', self.bundle_hash, '--worker-hash', self.source_hash, *flags], text=True, capture_output=True, timeout=10)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return json.loads(result.stdout)

    def final(self):
        for _ in range(100):
            result = self.call('status')
            if result['state'] not in ('absent', 'launching', 'running'):
                return result
            time.sleep(.05)
        self.fail('Remote controller did not settle')

    def test_duplicate_launch_is_one_process_and_strips_provider_keys(self):
        self.prepare("from pathlib import Path\nimport os,time\np=Path('count');p.write_text(p.read_text()+'x' if p.exists() else 'x')\nassert not any(os.environ.get(k) for k in ('OPENROUTER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY'))\ntime.sleep(.2)\nPath('output').mkdir();Path('output/manifest.json').write_text('{}')\n")
        prior = os.environ.get('OPENROUTER_API_KEY'); os.environ['OPENROUTER_API_KEY'] = 'fixture-secret'
        try:
            self.call('launch'); self.call('launch')
            self.assertEqual(self.final()['state'], 'succeeded')
            self.call('launch')
            self.assertEqual((self.root / 'count').read_text(), 'x')
        finally:
            if prior is None: os.environ.pop('OPENROUTER_API_KEY', None)
            else: os.environ['OPENROUTER_API_KEY'] = prior

    def test_environment_allowlist_removes_all_credentials_and_preserves_runtime_paths(self):
        removed = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
                   'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_API_KEY',
                   'CUSTOM_SECRET_CREDENTIAL', 'HF_TOKEN', 'SSH_AUTH_SOCK', 'UNKNOWN_PUBLIC_SETTING']
        preserved = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(self.root / 'home'),
                     'LANG': 'C.UTF-8', 'TMPDIR': str(self.root), 'LD_LIBRARY_PATH': '/host/cuda/lib',
                     'CUDA_VISIBLE_DEVICES': '0', 'CUDA_DEVICE_ORDER': 'PCI_BUS_ID',
                     'CUDA_HOME': '/host/cuda', 'HF_HOME': '/host/cache/huggingface',
                     'TORCH_HOME': '/host/cache/torch', 'OMP_NUM_THREADS': '2',
                     'PYTORCH_CUDA_ALLOC_CONF': 'expandable_segments:True'}
        overrides = {'AUTOFOLD_PROTO_ROOT': '/host/frozen/proto', 'PROTO_HOME': '/host/frozen/cache',
                     'AUTOFOLD_BOLTZGEN_CACHE': '/host/frozen/boltzgen'}
        script = "from pathlib import Path\nimport os,json\n" + \
                 "assert all(key not in os.environ for key in " + repr(removed) + ")\n" + \
                 "assert all(os.environ.get(key)==value for key,value in " + repr({**preserved, **overrides}) + ".items())\n" + \
                 "assert os.environ['PYTHONNOUSERSITE']=='1'\n" + \
                 "Path('output').mkdir();Path('output/manifest.json').write_text('{}')\n"
        plan = self.prepare(script)
        plan['environment'] = overrides
        (self.root / 'remote-plan.json').write_text(json.dumps(plan))
        with patch.dict(os.environ, {**preserved, **{key: 'fixture-only-sentinel' for key in removed}}):
            self.call('launch')
            self.assertEqual(self.final()['state'], 'succeeded')

    def test_frozen_plan_cannot_reintroduce_credentials_or_unknown_environment(self):
        plan = self.prepare('pass\n')
        for key in ('AWS_SECRET_ACCESS_KEY', 'GOOGLE_API_KEY', 'CUSTOM_SECRET_CREDENTIAL', 'PYTHONPATH', 'LD_PRELOAD'):
            plan['environment'] = {key: 'fixture-only-sentinel'}
            (self.root / 'remote-plan.json').write_text(json.dumps(plan))
            with self.assertRaisesRegex(ValueError, 'environment override'):
                control.load(str(self.root), self.bundle_hash, self.source_hash)
            with self.assertRaisesRegex(ValueError, 'environment override'):
                control.worker_environment(plan, {})
        plan['environment'] = {'PROTO_HOME': 'invalid\0path'}
        with self.assertRaisesRegex(ValueError, 'environment override'):
            control.worker_environment(plan, {})

    def test_cancel_and_wall_deadline_are_durable_terminal_receipts(self):
        self.prepare("import time\ntime.sleep(30)\n")
        self.call('launch'); self.call('cancel')
        self.assertEqual(self.final()['state'], 'cancelled')
        self.call('launch')
        self.assertEqual(self.call('status')['state'], 'cancelled')

    def test_cancel_before_launch_never_starts_worker(self):
        self.prepare("from pathlib import Path\nPath('started').touch()\n")
        self.call('cancel'); self.call('launch')
        self.assertEqual(self.final()['state'], 'cancelled')
        self.assertFalse((self.root / 'started').exists())

    def test_deleted_running_receipt_requires_actual_controller_cancel_acknowledgement(self):
        self.prepare("from pathlib import Path\nimport time\np=Path('count');p.write_text(p.read_text()+'x' if p.exists() else 'x')\ntime.sleep(30)\n")
        self.call('launch')
        for _ in range(100):
            running = self.call('status')
            if running['state'] == 'running' and (self.root / 'count').exists():
                break
            time.sleep(.05)
        else:
            self.fail('Scientific child did not start')
        os.kill(running['workerPid'], 0)
        (self.root / 'remote-receipt.json').unlink()
        pending = self.call('cancel', '--require-cancel-ack')
        self.assertIn(pending['state'], ('absent', 'running'))
        self.assertTrue((self.root / 'cancel.request').exists())
        final = self.final()
        self.assertEqual(final['state'], 'cancelled')
        self.assertIsNotNone(final['exitCode'])
        with self.assertRaises(ProcessLookupError):
            os.kill(running['workerPid'], 0)
        self.call('launch')
        self.assertEqual((self.root / 'count').read_text(), 'x')

    def test_require_cancel_ack_does_not_invent_an_absent_terminal_receipt(self):
        self.prepare("raise RuntimeError('must not launch')\n")
        self.assertEqual(self.call('cancel', '--require-cancel-ack')['state'], 'absent')
        self.assertFalse((self.root / 'remote-receipt.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'only valid with cancel'):
            self.call('status', '--require-cancel-ack')
        self.assertEqual(self.call('cancel')['state'], 'cancelled')

    def test_timeout_is_not_success_even_if_partial_manifest_exists(self):
        self.prepare("from pathlib import Path\nimport time\nPath('output').mkdir();Path('output/manifest.json').write_text('{}');time.sleep(30)\n", 100)
        self.call('launch')
        self.assertEqual(self.final()['state'], 'timed_out')

    def test_interrupted_launch_intent_never_relaunches(self):
        plan = self.prepare("raise RuntimeError('must not launch')\n")
        receipt = {**control.identity(plan), 'state': 'launching'}
        (self.root / 'remote-receipt.json').write_text(json.dumps(receipt))
        self.assertEqual(self.call('launch')['state'], 'launching')
        self.assertFalse((self.root / 'worker.log').exists())

    def test_tampered_worker_and_escaping_command_are_rejected(self):
        plan = self.prepare('pass\n')
        (self.worker / 'run_worker.py').write_text('changed\n')
        with self.assertRaisesRegex(ValueError, 'source hash'):
            control.load(str(self.root), self.bundle_hash, self.source_hash)
        self.source_hash = control.worker_hash(self.worker)
        plan['workerHash'] = self.source_hash; plan['argv'][1] = '/outside/worker.py'
        (self.root / 'remote-plan.json').write_text(json.dumps(plan))
        with self.assertRaisesRegex(ValueError, 'staged scientific worker'):
            control.load(str(self.root), self.bundle_hash, self.source_hash)

    def running(self):
        for _ in range(100):
            value = self.call('status')
            if value['state'] == 'running':
                return value
            time.sleep(.02)
        self.fail('Original worker did not register')

    def test_independent_deadline_survives_launch_controller_sigkill(self):
        self.prepare("from pathlib import Path\nimport time\nPath('count').write_text('x')\ntime.sleep(30)\n", 500)
        self.call('launch')
        running = self.running()
        os.kill(running['controllerPid'], signal.SIGKILL)
        final = self.final()
        self.assertEqual(final['state'], 'timed_out')
        self.assertFalse(control.process_matches(running['workerIdentity']))
        self.call('launch')
        self.assertEqual((self.root / 'count').read_text(), 'x')
        self.assertEqual(final['planHash'], control.plan_hash(json.loads((self.root / 'remote-plan.json').read_text())))

    def test_original_child_adoption_survives_both_supervisors_and_runner_death(self):
        self.prepare("from pathlib import Path\nimport time\nPath('count').write_text('x')\ntime.sleep(30)\n", 1000)
        self.call('launch')
        running = self.running()
        os.kill(running['controllerPid'], signal.SIGKILL)
        os.kill(running['watchdogPid'], signal.SIGKILL)
        os.kill(running['runnerPid'], signal.SIGKILL)
        self.call('adopt')
        final = self.final()
        self.assertEqual(final['state'], 'timed_out')
        self.assertTrue(final['adopted'])
        self.assertFalse(control.process_matches(running['workerIdentity']))
        self.call('launch')
        self.assertEqual((self.root / 'count').read_text(), 'x')

    def test_cancel_adopted_original_child_is_an_acknowledged_terminal_effect(self):
        self.prepare("import time\ntime.sleep(30)\n")
        self.call('launch')
        running = self.running()
        for key in ('controllerPid', 'watchdogPid', 'runnerPid'):
            os.kill(running[key], signal.SIGKILL)
        self.call('adopt')
        self.call('cancel', '--require-cancel-ack')
        self.assertEqual(self.final()['state'], 'cancelled')
        self.assertFalse(control.process_matches(running['workerIdentity']))

    def test_process_birth_or_boot_mismatch_never_signals_a_reused_pid(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'])
        try:
            original = control.process_identity(child.pid)
            self.assertTrue(control.process_matches(original))
            for key in ('birth', 'boot'):
                forged = {**original, key:'different-original-identity'}
                self.assertFalse(control.process_matches(forged))
                self.assertTrue(control.stop_original(forged))
                self.assertIsNone(child.poll())
        finally:
            child.kill(); child.wait()

    def test_frozen_plan_binds_runtime_environment_and_timeout(self):
        plan = self.prepare('pass\n')
        expected = control.plan_hash(plan)
        for change in ({'timeoutMs': 1234}, {'environment': {'PROTO_HOME':'/other/cache'}}, {'argv':['/other/python',*plan['argv'][1:]]}):
            changed = {**plan,**change}
            (self.root / 'remote-plan.json').write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'plan hash'):
                control.load(str(self.root),self.bundle_hash,self.source_hash,expected)

    def test_adoption_cannot_repeat_an_ambiguous_pre_spawn_launch(self):
        plan = self.prepare("from pathlib import Path\nPath('must-not-run').touch()\n")
        (self.root / 'remote-receipt.json').write_text(json.dumps({**control.identity(plan),'state':'launching'}))
        (self.root / 'process-launch.json').write_text(json.dumps(control.identity(plan)))
        self.call('adopt'); self.call('launch')
        self.assertEqual(self.call('status')['state'],'launching')
        self.assertFalse((self.root / 'must-not-run').exists())

    def test_delayed_original_runner_cannot_reset_launch_deadline_or_start_compute(self):
        plan = self.prepare("from pathlib import Path\nPath('must-not-run').touch()\n", 100)
        now = time.time()
        initial = {**control.identity(plan),'state':'launching','recordedAt':now,'boot':control.boot_identity(),
                   'deadlineAt':now+.1,'deadlineMonotonic':time.monotonic()+.1}
        (self.root / 'remote-receipt.json').write_text(json.dumps(initial))
        time.sleep(.15)
        final = control.run_original(self.root,plan)
        self.assertEqual(final['state'],'timed_out')
        self.assertTrue(final['neverStarted'])
        self.assertFalse((self.root / 'must-not-run').exists())

    def test_missing_original_process_birth_proof_cannot_adopt_or_signal(self):
        plan = self.prepare('pass\n')
        child = subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        try:
            value = {**control.identity(plan),'boot':control.boot_identity(),'runner':None,
                     'worker':{**control.process_identity(child.pid),'birth':None},'deadlineMonotonic':time.monotonic()-1,'deadlineAt':time.time()-1}
            (self.root / 'process-registry.json').write_text(json.dumps(value))
            (self.root / 'remote-receipt.json').write_text(json.dumps({**control.identity(plan),'state':'running'}))
            self.call('adopt')
            time.sleep(.1)
            self.assertIsNone(child.poll())
            self.assertEqual(self.call('status')['state'],'running')
        finally:
            child.kill();child.wait()

    def test_original_exit_journal_recovers_a_lost_receipt_without_compute_replay(self):
        self.prepare("from pathlib import Path\nPath('count').write_text('x')\nPath('output').mkdir();Path('output/manifest.json').write_text('{}')\n")
        self.call('launch')
        final = self.final()
        self.assertEqual(final['state'],'succeeded')
        (self.root / 'remote-receipt.json').unlink()
        self.assertEqual(self.call('status')['state'],'succeeded')
        self.assertEqual((self.root / 'count').read_text(),'x')
        # The registry's permanent launch fence remains authoritative even if
        # an operational receipt file is lost; never accept a fresh launch.
        self.assertEqual(self.call('adopt')['state'],'succeeded')
        self.assertEqual(self.call('launch')['state'],'succeeded')
        self.assertEqual((self.root / 'count').read_text(),'x')

if __name__ == '__main__':
    unittest.main()
