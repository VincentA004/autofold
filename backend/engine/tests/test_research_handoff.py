"""Offline native Proto and captured-evidence regressions; use PROTO_PYTHON.

These verify the pressure-test's measurement and snapshot mechanics, not LLM taste.
The separate live scientist runs determine whether guidance changes authored trials.
"""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'fixtures/research_handoff'
sys.path.insert(0, str(FIXTURE))
from cases import ASSESSMENT, CASE_SOURCES

spec = importlib.util.spec_from_file_location('handoff_trial_runner', HERE.parent/'scripts/run_trial.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ResearchHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root/'campaign.md').write_text('Synthetic selection objective; no biology claims.\n')
        (self.root/'programs/baseline').mkdir(parents=True)
        (self.root/'notebook').mkdir()
        (self.root/'sources').mkdir()
        for name in ['baseline.py','toolbox.py']:
            shutil.copyfile(FIXTURE/name, self.root/'programs/baseline'/name)
        (self.root/'programs/baseline/method.md').write_text('Question Q1; finding notebook/findings.md; use head u pending calibration.\n')
        (self.root/'notebook/findings.md').write_text('Calibration applies only to this synthetic library. [Source](../sources/note.txt).\n')
        (self.root/'sources/note.txt').write_text(CASE_SOURCES['reroute'])

    def run_trial(self, head):
        code=(FIXTURE/'baseline.py').read_text().replace("HEAD = 'u'", f'HEAD = {head!r}')
        (self.root/'programs/baseline/baseline.py').write_text(code)
        prepared=runner.prepare_trial(self.root)
        (prepared/'plan.md').write_text(f'# Selection plan\nUse head {head} on the fixed library; applicability remains to be checked.\n[Source](../../../sources/note.txt): captured calibration note.\n')
        with redirect_stdout(io.StringIO()):
            directory,status=runner.run_trial(self.root,'programs/baseline',
                [],
                [sys.executable,'program/baseline.py'],'Test source-informed native selection',
                evaluation='fixture-common-assessment',timeout=30,trial=prepared.relative_to(self.root).as_posix())
        self.assertEqual(status['state'],'completed',(directory/'stderr.log').read_text())
        return directory,json.loads((directory/'output/result.json').read_text())

    def test_native_selection_can_improve_independent_assessment(self):
        _,old=self.run_trial('u');_,new=self.run_trial('v')
        self.assertGreater(old['history_snapshots'],0)
        self.assertGreater(new['history_snapshots'],0)
        self.assertEqual(old['selected'],['ATGCATGC'])
        self.assertEqual(new['selected'],['GATCGATC'])
        # Assessment is independent of the native fitness table.
        assess=ASSESSMENT['reroute']
        self.assertGreater(assess[new['selected'][0]],assess[old['selected'][0]])

    def test_changing_policy_without_applicability_can_make_it_worse(self):
        _,old=self.run_trial('u');_,changed=self.run_trial('v')
        assess=ASSESSMENT['retain']
        self.assertGreater(assess[old['selected'][0]],assess[changed['selected'][0]])
        # Equal inputs and objective, opposing calibration: "always change" fails.
        self.assertNotEqual(CASE_SOURCES['retain'],CASE_SOURCES['reroute'])

    def test_plan_and_captured_procedure_survive_notebook_edits_and_new_source(self):
        directory,_=self.run_trial('u')
        plan=(directory/'plan.md').read_bytes()
        code=(directory/'program/baseline.py').read_bytes()
        source=(self.root/'sources/note.txt').read_bytes()
        (self.root/'notebook/findings.md').write_text('Later correction.\n')
        (self.root/'sources/new-capture.txt').write_text('New evidence, not a replacement capture.\n')
        (self.root/'programs/baseline/baseline.py').write_text('Later policy.\n')
        self.assertEqual((directory/'plan.md').read_bytes(),plan)
        self.assertEqual((directory/'program/baseline.py').read_bytes(),code)
        self.assertEqual((directory/'../../../sources/note.txt').resolve().read_bytes(),source)
        manifest=json.loads((directory/'trial.json').read_text())
        self.assertEqual(manifest['inputs'],[])
        self.assertFalse((directory/'context').exists())
        for item in manifest['snapshot']:
            self.assertEqual(hashlib.sha256((directory/item['path']).read_bytes()).hexdigest(),item['sha256'])


if __name__=='__main__':
    unittest.main()
