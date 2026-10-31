"""Execute the documented native command against actual live and captured files."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ENGINE = Path(__file__).parents[1]
recipe = (ENGINE / 'skills/scientific-research/references/link-verification.md').read_text()
COMMAND = recipe.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
spec = importlib.util.spec_from_file_location('runner', ENGINE / 'scripts/run_trial.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class NativeLinkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
        return file

    def check(self, *files, root=None):
        result = subprocess.run([sys.executable, '-', str(root or self.root), *files],
                                input=COMMAND, text=True, capture_output=True)
        self.assertIn(result.returncode, (0, 1), result.stderr)
        return result.returncode, json.loads(result.stdout)

    def campaign(self):
        self.write('campaign.md', '# Synthetic case\n')
        self.write('sources/note.txt', 'Reported observation.\n')
        self.write('sources/source.json', '{\"scope\": \"synthetic fixture\"}\n')
        self.write('notebook/investigations/response.md',
                   '# Response\n\n## Evidence\n[Capture](../../sources/source.json)\n'
                   '[Text](../../sources/note.txt): line 1.\n\n'
                   '## Interpretation\nOriginal provisional conclusion.\n\n'
                   '## Next decision\nCheck applicability.\n')
        self.write('programs/screen/rationale.md', '## Motivation\n[Investigation](../../notebook/investigations/response.md)\n')
        self.write('programs/screen/main.py', "print('completed')\n")

    def test_relocated_campaign_keeps_plan_assessment_and_source_links(self):
        self.campaign()
        self.write('campaign.md', '# Campaign\n[Source](sources/note.txt)\n```sh\nexample\n```\n')
        trial = runner.prepare_trial(self.root)
        (trial / 'plan.md').write_text('# Plan\n[Source](../../../sources/note.txt): line 1.\n')
        trial, _ = runner.run_trial(self.root, 'programs/screen', [],
                                    [sys.executable, 'program/main.py'], 'Check evidence',
                                    trial=trial.relative_to(self.root).as_posix())
        self.write('programs/assessment.md', '# Assessment\n[Execution](execution.json).\n[Code](program/main.py).\n')
        runner.commit_assessment(self.root, trial.relative_to(self.root).as_posix(), 'programs/assessment.md')
        files = ['notebook/investigations/response.md',
                 (trial / 'plan.md').relative_to(self.root).as_posix(),
                 (trial / 'brief.md').relative_to(self.root).as_posix(),
                 (trial / 'assessment.md').relative_to(self.root).as_posix()]
        with tempfile.TemporaryDirectory() as moved:
            destination = Path(moved) / 'campaign'
            shutil.copytree(self.root, destination)
            self.assertEqual(self.check(*files, root=destination)[0], 0)
            page = self.root / 'notebook/investigations/response.md'
            page.write_text(page.read_text() + '[Missing](missing.md)\n')
            self.assertEqual(self.check(*files, root=destination)[0], 0)
            self.assertEqual(self.check(files[0])[0], 1)

    def test_missing_preserved_evidence_does_not_fall_back_to_working_file(self):
        self.campaign()
        self.write('programs/screen/result.json', '{}')
        self.write('notebook/claim.md', '[Result](../output/trials/t-missing/output/result.json)\n')
        code, result = self.check('notebook/claim.md')
        self.assertEqual(code, 1)
        self.assertIn('t-missing', result['errors'][0]['target'])

    def test_wrong_depth_and_nonexistent_future_evidence_fail(self):
        self.write('campaign.md', '# Campaign\n')
        self.write('handoff.md', '[Brief](../campaign.md)\n[Future](notebook/evidence/e-future.md)\n')
        code, result = self.check('handoff.md')
        self.assertEqual(code, 1)
        self.assertEqual(len(result['errors']), 2)

    def test_code_examples_external_urls_and_fragments_are_not_file_failures(self):
        self.write('note.md', '''# Note
`[example](missing.txt)`
```markdown
[another example](also-missing.txt)
```
[Web](https://example.org/paper) [Email](mailto:author@example.org)
[Heading](#unknown-heading)
''')
        code, result = self.check('note.md')
        self.assertEqual(code, 0)
        self.assertEqual(result['local_links'], 0)
        self.assertEqual(result['fragments_not_verified'], 1)

    def test_encoded_files_images_and_directory_links(self):
        self.write('data/my file.txt', 'data')
        self.write('data/image.png', 'image placeholder')
        self.write('note.md', '[Data](data/my%20file.txt)\n![Image](data/image.png)\n[Folder](data/)\n')
        code, result = self.check('note.md')
        self.assertEqual((code, result['local_links']), (0, 3))

    def test_unsupported_reference_syntax_and_missing_documents_do_not_pass_silently(self):
        self.write('note.md', '[Source][paper]\n[paper]: missing.txt\n')
        code, result = self.check('note.md', 'absent.md')
        self.assertEqual(code, 1)
        self.assertEqual(len(result['errors']), 3)


if __name__ == '__main__':
    unittest.main()
