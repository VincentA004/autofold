"""Real subprocess checks for preserved plans, runtime lineage and execution receipts."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('trial_runner', Path(__file__).parents[1] / 'scripts/run_trial.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'campaign.md').write_text('# Test campaign\nAssessment E1\n')
        (self.root / 'programs/draft').mkdir(parents=True)
        (self.root / 'inputs').mkdir()
        (self.root / 'inputs/data.txt').write_text('original input')

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self, plan='# Plan\nTest the captured input under E1.\n'):
        directory = runner.prepare_trial(self.root)
        (directory / 'plan.md').write_text(plan)
        return directory

    def run_program(self, source, inputs=(), timeout=5, directory=None):
        (self.root / 'programs/draft/main.py').write_text(source)
        directory = directory or self.prepare()
        return runner.run_trial(self.root, 'programs/draft', inputs,
                                [sys.executable, 'program/main.py'], 'Test execution', 'E1', timeout,
                                trial=directory.relative_to(self.root).as_posix())

    def assert_hashes(self, directory):
        manifest = json.loads((directory / 'trial.json').read_text())
        receipt = json.loads((directory / 'execution.json').read_text())
        for record in manifest['snapshot'] + receipt['artifacts']:
            self.assertEqual(record['sha256'], runner.digest(directory / record['path']))

    def test_runtime_profile_is_pinned_frozen_and_supplies_adapter_defaults(self):
        profile=self.root/'operator-profile.json'
        profile.write_text(json.dumps({'schema_version':1,'boltz2':{'backend':'native'},
            'environment':{'AUTOFOLD_RFD4_MODEL':'/provisioned/model'}}))
        source="import os,json\nfrom pathlib import Path\nPath('output/runtime.json').write_text(json.dumps({'asset':os.environ['AUTOFOLD_RFD4_MODEL'],'profile':json.loads(Path(os.environ['AUTOFOLD_RUNTIME_PROFILE']).read_text()),'fingerprint':os.environ['AUTOFOLD_RUNTIME_FINGERPRINT']}))\n"
        with patch.dict(runner.os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(profile)}):
            first,status=self.run_program(source)
        self.assertEqual(status['state'],'completed')
        second,status=self.run_program(source)
        self.assertEqual(status['state'],'completed')
        self.assertEqual((first/'output/runtime.json').read_bytes(),(second/'output/runtime.json').read_bytes())
        self.assertEqual(json.loads((first/'output/runtime.json').read_text())['asset'],'/provisioned/model')
        self.assertEqual((first/'runtime-profile.json').read_bytes(),(self.root/'.autofold/runtime-profile.json').read_bytes())
        self.assertTrue((first/'runtime/boltz_runtime.py').is_file())
        self.assert_hashes(first)
        self.assert_hashes(second)

    def test_changed_runtime_policy_fails_without_rewriting_prior_evidence(self):
        first,status=self.run_program("print('native run')\n")
        original=(first/'trial.json').read_bytes()
        profile=self.root/'operator-profile.json'
        profile.write_text(json.dumps({'schema_version':1,'boltz2':{'backend':'native'},
            'environment':{'AUTOFOLD_RFD4_MODEL':'/different/model'}}))
        with patch.dict(runner.os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(profile)}):
            second,status=self.run_program("print('must not run')\n")
        self.assertEqual(status['state'],'failed')
        self.assertIn('runtime profile changed',status['error'])
        self.assertEqual((first/'trial.json').read_bytes(),original)
        self.assert_hashes(first)

    def test_runtime_profile_cannot_override_science_or_copy_provider_credentials(self):
        for profile in [
            {'schema_version':1,'boltz2':{'backend':'native','sampling_steps':1},'environment':{}},
            {'schema_version':1,'boltz2':{'backend':'native'},'environment':{'OPENROUTER_API_KEY':'fixture-not-a-key'}}]:
            path=self.root/'invalid-profile.json';path.write_text(json.dumps(profile))
            with self.subTest(profile=profile),patch.dict(runner.os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(path)}):
                directory,status=self.run_program("print('must not run')\n")
            self.assertEqual(status['state'],'failed')
            self.assertFalse((directory/'trial.json').exists())

    def test_changed_runtime_implementation_cannot_silently_continue_comparison(self):
        first,status=self.run_program("print('first run')\n")
        self.assertEqual(status['state'],'completed')
        (self.root/'.autofold/runtime-fingerprint.sha256').write_text('different implementation')
        second,status=self.run_program("print('must not run')\n")
        self.assertEqual(status['state'],'failed')
        self.assertIn('runtime implementation changed',status['error'])
        self.assert_hashes(first)

    def assess(self, directory, content='# Initial assessment\nObserved execution, not biology.\n'):
        draft = self.root / 'programs/assessment.md'
        draft.write_text(content)
        return runner.commit_assessment(self.root, directory.relative_to(self.root).as_posix(),
                                        draft.relative_to(self.root).as_posix())

    def test_capture_helpers_and_reuse_exact_runtime_input(self):
        (self.root / 'programs/draft/helper.py').write_text("value = 'captured helper'\n")
        source = "from pathlib import Path\nfrom helper import value\nprint(value)\nPath('output/result.txt').write_text(Path('inputs/data.txt').read_text())\n"
        first, status = self.run_program(source, ['data.txt=inputs/data.txt'])
        self.assertEqual(status['state'], 'completed')
        first_manifest = (first / 'trial.json').read_bytes()
        (self.root / 'inputs/data.txt').write_text('changed input')
        (self.root / 'campaign.md').write_text('Assessment E2\n')
        self.assertEqual((first / 'inputs/data.txt').read_text(), 'original input')
        self.assertIn('E1', (first / 'brief.md').read_text())
        second, _ = self.run_program("from pathlib import Path\nprint(Path('inputs/previous.txt').read_text())\n",
                                    ['previous.txt=' + (first / 'output/result.txt').relative_to(self.root).as_posix()])
        manifest = json.loads((second / 'trial.json').read_text())
        self.assertIn(first.name, manifest['inputs'][0]['source'])
        self.assertEqual((second / 'stdout.log').read_text(), 'original input\n')
        self.assertEqual(first_manifest, (first / 'trial.json').read_bytes())
        self.assert_hashes(first)
        self.assert_hashes(second)

    def test_failure_keeps_partial_output_stderr_and_final_hashes(self):
        directory, status = self.run_program("from pathlib import Path\nimport sys\nPath('output/partial.txt').write_text('partial')\nprint('failed measurement', file=sys.stderr)\nsys.exit(7)\n")
        self.assertEqual((status['state'], status['exit_code']), ('failed', 7))
        self.assertTrue((directory / 'output/partial.txt').is_file())
        self.assertIn('failed measurement', (directory / 'stderr.log').read_text())
        self.assert_hashes(directory)

    def test_plan_and_assessment_have_separate_lifecycles_without_notebook_mirror(self):
        (self.root / 'notebook').mkdir()
        page = self.root / 'notebook/finding.md'
        page.write_text('Current working interpretation.\n')
        directory = self.prepare('# Plan\nOriginal reasoning: test E1.\n')
        directory, status = self.run_program("print('executed')\n", directory=directory)
        self.assertEqual(status['state'], 'completed')
        self.assertFalse((directory / 'assessment.md').exists())
        self.assertFalse((directory / 'context').exists())
        self.assertFalse((directory / 'notebook').exists())
        frozen = {p.name: p.read_bytes() for p in (directory / 'plan.md', directory / 'trial.json', directory / 'execution.json')}
        self.assess(directory)
        page.write_text('Corrected current understanding.\n')
        for name, data in frozen.items():
            self.assertEqual((directory / name).read_bytes(), data)
        self.assert_hashes(directory)

    def test_assessment_commits_exact_bytes_once_and_corrections_stay_mutable(self):
        directory, _ = self.run_program("print('evidence')\n")
        text = '# Initial assessment\n\nProvisional interpretation: α.\n'
        record = self.assess(directory, text)
        assessment, receipt = directory / 'assessment.md', directory / 'assessment.json'
        self.assertEqual(assessment.read_bytes(), text.encode())
        self.assertEqual(record['sha256'], runner.digest(assessment))
        self.assertEqual(record, json.loads(receipt.read_text()))
        self.assertEqual(assessment.stat().st_mode & 0o222, 0)
        self.assertEqual(receipt.stat().st_mode & 0o222, 0)
        frozen = (assessment.read_bytes(), receipt.read_bytes())
        with self.assertRaisesRegex(ValueError, 'already recorded'):
            self.assess(directory, '# Revised interpretation\n')
        page = self.root / 'notebook/investigations/test.md'
        page.parent.mkdir(parents=True)
        page.write_text('# Changes\nCorrects [initial assessment](../../output/trials/' +
                        directory.name + '/assessment.md): new interpretation; see captured evidence.\n')
        self.assertEqual((assessment.read_bytes(), receipt.read_bytes()), frozen)
        self.assertEqual(runner.require_assessment_integrity(self.root)['verified'], [directory.name])

    def test_pending_assessment_is_allowed_but_prepared_trial_cannot_be_assessed(self):
        directory = self.prepare()
        self.assertEqual(runner.verify_assessments(self.root)['pending'], [directory.name])
        with self.assertRaisesRegex(ValueError, 'terminal execution'):
            self.assess(directory)
        self.assertFalse((directory / 'assessment.json').exists())
        failed, _ = self.run_program('raise RuntimeError("record the failure")\n')
        self.assess(failed)
        runner.require_assessment_integrity(self.root)

    def test_changed_assessment_blocks_preparation_and_execution(self):
        directory, _ = self.run_program("print('evidence')\n")
        self.assess(directory)
        next_trial = self.prepare()
        assessment = directory / 'assessment.md'
        assessment.chmod(0o644)  # Unrestricted shell access can bypass read-only protection.
        assessment.write_text('silently replaced interpretation\n')
        self.assertIn('hash mismatch', ' '.join(runner.verify_assessments(self.root)['errors']))
        with self.assertRaisesRegex(ValueError, 'integrity failure'):
            self.prepare()
        with self.assertRaisesRegex(ValueError, 'integrity failure'):
            self.run_program("print('must not execute')\n", directory=next_trial)
        self.assertFalse((next_trial / 'trial.json').exists())

    def test_trial_that_changes_an_earlier_assessment_fails_capture(self):
        first, _ = self.run_program("print('evidence')\n")
        self.assess(first)
        _, status = self.run_program("from pathlib import Path\np = Path('../" + first.name +
                                     "/assessment.md')\np.chmod(0o644)\np.write_text('changed')\n")
        self.assertEqual(status['exit_code'], 0)
        self.assertEqual(status['state'], 'failed')
        self.assertIn('hash mismatch', ' '.join(status['capture_errors']))

    def test_uncommitted_incomplete_and_symlink_records_are_not_adopted(self):
        directory, _ = self.run_program("print('evidence')\n")
        assessment, receipt = directory / 'assessment.md', directory / 'assessment.json'
        assessment.write_text('Legacy assessment\n')
        with self.assertRaisesRegex(ValueError, 'uncommitted or incomplete'):
            self.assess(directory)
        assessment.unlink()
        receipt.write_text('{}')  # Interrupted/incomplete commit.
        self.assertTrue(runner.verify_assessments(self.root)['errors'])
        assessment.symlink_to(self.root / 'inputs/data.txt')
        self.assertTrue(runner.verify_assessments(self.root)['errors'])
        self.assertEqual((self.root / 'inputs/data.txt').read_text(), 'original input')

    def test_concurrent_cli_commits_have_one_winner_and_verify_at_handoff(self):
        directory, _ = self.run_program("print('evidence')\n")
        drafts = []
        for text in ['first interpretation', 'second interpretation']:
            path = self.root / 'programs' / (str(len(drafts)) + '.md')
            path.write_text(text)
            drafts.append(path)
        base = [sys.executable, str(Path(runner.__file__)), '--campaign', str(self.root)]
        processes = [subprocess.Popen(base + ['--trial', directory.relative_to(self.root).as_posix(),
                                             '--assess', draft.relative_to(self.root).as_posix()],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for draft in drafts]
        results = [process.communicate(timeout=10) for process in processes]
        self.assertEqual(sorted(process.returncode for process in processes), [0, 1], results)
        self.assertIn((directory / 'assessment.md').read_text(), [path.read_text() for path in drafts])
        verified = subprocess.run(base + ['--verify-assessments'], capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(json.loads(verified.stdout)['verified'], [directory.name])
        assessment = directory / 'assessment.md'
        assessment.chmod(0o644)
        assessment.write_text('later shell change')
        failed = subprocess.run(base + ['--verify-assessments'], capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1)
        self.assertIn('hash mismatch', failed.stdout)

    def test_prepared_trial_without_plan_cannot_launch_and_can_be_completed(self):
        directory = runner.prepare_trial(self.root)
        with self.assertRaises(ValueError):
            self.run_program("print('must not execute')", directory=directory)
        self.assertFalse((directory / 'trial.json').exists())
        self.assertFalse((directory / 'stdout.log').exists())
        (directory / 'plan.md').write_text('# Plan\nNow supplied.\n')
        _, status = self.run_program("print('now execute')", directory=directory)
        self.assertEqual(status['state'], 'completed')

    def test_attempted_trial_cannot_be_reused_even_after_failure(self):
        directory, status = self.run_program('raise RuntimeError("failure")\n')
        self.assertEqual(status['state'], 'failed')
        frozen = (directory / 'execution.json').read_bytes()
        with self.assertRaises(ValueError):
            self.run_program("print('must not overwrite')", directory=directory)
        self.assertEqual((directory / 'execution.json').read_bytes(), frozen)

    def test_evidence_citations_do_not_become_runtime_input_copies(self):
        source = self.root / 'sources/capture/text.txt'
        source.parent.mkdir(parents=True)
        source.write_text('Independent replication not reported.\n')
        directory = self.prepare('# Plan\n[Source](../../../sources/capture/text.txt): line 1.\n')
        directory, status = self.run_program("print('ok')\n", directory=directory)
        self.assertEqual(status['state'], 'completed')
        self.assertEqual(json.loads((directory / 'trial.json').read_text())['inputs'], [])
        self.assertFalse((directory / 'sources').exists())
        with tempfile.TemporaryDirectory() as moved:
            archive = Path(moved) / 'campaign'
            shutil.copytree(self.root, archive)
            plan = archive / directory.relative_to(self.root) / 'plan.md'
            self.assertEqual((plan.parent / '../../../sources/capture/text.txt').read_text(), source.read_text())

    def test_mutable_notebook_as_actual_runtime_data_is_explicitly_captured(self):
        (self.root / 'notebook').mkdir()
        page = self.root / 'notebook/finding.md'
        page.write_text('Prospective.\n')
        directory, _ = self.run_program("from pathlib import Path\nprint(Path('inputs/finding.md').read_text())\n",
                                       ['finding.md=notebook/finding.md'])
        page.write_text('Revised.\n')
        self.assertEqual((directory / 'inputs/finding.md').read_text(), 'Prospective.\n')
        self.assert_hashes(directory)

    def test_timeout_preserves_checkpoint_and_does_not_retry(self):
        directory, status = self.run_program("from pathlib import Path\nimport time\nPath('output/checkpoint.txt').write_text('checkpoint')\ntime.sleep(20)\n", timeout=0.3)
        self.assertEqual(status['state'], 'interrupted')
        self.assertTrue((directory / 'output/checkpoint.txt').is_file())
        self.assertEqual(len(list((self.root / 'output/trials').iterdir())), 1)
        self.assert_hashes(directory)

    def test_rejects_paths_outside_campaign_before_launch(self):
        directory = self.prepare()
        with self.assertRaises(ValueError):
            self.run_program("raise RuntimeError('must not execute')", ['../escape=inputs/data.txt'], directory=directory)
        self.assertFalse((directory / 'trial.json').exists())

    def test_documented_cli_prepare_then_execute(self):
        script = str(Path(runner.__file__))
        prepared = subprocess.run([sys.executable, script, '--campaign', str(self.root), '--prepare'],
                                  text=True, capture_output=True, check=True)
        directory = Path(json.loads(prepared.stdout)['directory'])
        (directory / 'plan.md').write_text('# Plan\nExercise the documented CLI.\n')
        (self.root / 'programs/draft/main.py').write_text("print('CLI completed')\n")
        executed = subprocess.run([sys.executable, script, '--campaign', str(self.root),
                                   '--trial', directory.relative_to(self.root).as_posix(),
                                   '--program', 'programs/draft', '--intent', 'Check CLI', '--',
                                   sys.executable, 'program/main.py'], text=True, capture_output=True)
        self.assertEqual(executed.returncode, 0, executed.stderr)
        self.assertEqual((directory / 'stdout.log').read_text(), 'CLI completed\n')
        self.assert_hashes(directory)

    def test_rejects_program_symlinks(self):
        (self.root / 'programs/draft/external').symlink_to('/etc/hosts')
        directory = self.prepare()
        with self.assertRaises(ValueError):
            self.run_program("print('must not execute')", directory=directory)
        self.assertFalse((directory / 'trial.json').exists())

    def test_detects_modification_of_captured_procedure(self):
        directory, status = self.run_program("from pathlib import Path\nPath('program/main.py').write_text('changed')\n")
        self.assertEqual(status['state'], 'failed')
        self.assertIn('program/main.py', ' '.join(status['capture_errors']))

    def test_symlink_output_is_reported_without_hashing_external_target(self):
        directory, status = self.run_program("from pathlib import Path\nPath('output/external').symlink_to('/etc/hosts')\n")
        self.assertEqual(status['state'], 'failed')
        self.assertIn('output/external', ' '.join(status['capture_errors']))
        self.assertNotIn('output/external', {item['path'] for item in status['artifacts']})


if __name__ == '__main__':
    unittest.main()
