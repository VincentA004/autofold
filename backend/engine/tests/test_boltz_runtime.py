"""Native scientific calls resolve infrastructure backends without caller changes."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_bioir_boltz as fixtures
from proto_tools import predict_structures
from proto_tools.tools.structure_prediction.boltz2 import Boltz2Config
from proto_tools.utils.tool_cache import _generate_cache_key

RUNTIME = Path(__file__).resolve().parents[1]/'runtime'
boltz = importlib.import_module('proto_tools.tools.structure_prediction.boltz2.boltz2')


class BoltzRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.BioIRTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        self.profile = self.root/'profile.json'
        self.env = patch.dict(os.environ,{
            'AUTOFOLD_BOLTZ2_RUNTIME_HOOK':str(RUNTIME/'boltz_runtime.py'),
            'AUTOFOLD_RUNTIME_PROFILE':str(self.profile),
            'AUTOFOLD_RUNTIME_FINGERPRINT':str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def select(self,backend):
        cfg = self.fixture.config
        route = {'backend':backend}
        if backend=='bioir':
            route.update({k:getattr(cfg,k) for k in ('python_executable','checkpoint','ccd_path','mol_dir')})
            route['checkpoint_sha256']=hashlib.sha256(Path(cfg.checkpoint).read_bytes()).hexdigest()
        self.profile.write_text(json.dumps({'schema_version':1,'boltz2':route,'environment':{}}))

    def predict(self,**extra):
        config={'use_msa':False,'include_pae_matrix':True,'seed':17,**extra}
        return predict_structures(self.fixture.inputs.complexes,'boltz2',config)

    def test_ordinary_boltz_call_uses_pinned_bioir_and_preserves_scientific_controls(self):
        self.select('bioir')
        with patch.object(fixtures.bioir.subprocess,'Popen',side_effect=self.fixture.fake_process):
            output=self.predict(recycling_steps=4,sampling_steps=37)
        self.assertEqual(output.structures[0].source,'boltz2-prediction')
        self.assertEqual(output.structures[0].metrics['execution_backend'],'bioir')
        receipt=json.loads(next((self.root/'output/runtime').glob('*/execution.json')).read_text())
        self.assertEqual(receipt['state'],'completed')
        self.assertEqual(receipt['scientific_config']['sampling_steps'],37)
        request=json.loads(next((self.root/'output/runtime').glob('*/predictions/*/request.json')).read_text())
        self.assertEqual((request['recycling_steps'],request['sampling_steps'],request['seed']),(4,37,17))

    def test_native_profile_keeps_native_implementation_and_receipt(self):
        self.select('native')
        result=fixtures.bioir.Structure(structure=self.fixture.cif,metrics={'iptm':.7})
        with patch.object(boltz,'_run_boltz2_native_on_complex',return_value=result) as native:
            output=self.predict()
        native.assert_called_once()
        self.assertEqual(output.structures[0].metrics['execution_backend'],'native')

    def test_unsupported_protocol_and_worker_failure_never_fall_back(self):
        self.select('bioir')
        with patch.object(boltz,'_run_boltz2_native_on_complex') as native:
            with self.assertRaises(ValueError):self.predict(step_scale=2.0)
            with patch.object(fixtures.bioir.subprocess,'Popen',side_effect=OSError('fixture GPU failure')):
                with self.assertRaises(OSError):self.predict()
        native.assert_not_called()
        receipts=[json.loads(p.read_text()) for p in (self.root/'output/runtime').glob('*/execution.json')]
        self.assertEqual([r['state'] for r in receipts],['failed','failed'])

    def test_weights_mismatch_fails_before_inference(self):
        self.select('bioir')
        Path(self.fixture.config.checkpoint).write_bytes(b'changed weights')
        with patch.object(fixtures.bioir.subprocess,'Popen') as worker,self.assertRaisesRegex(ValueError,'pinned weights'):
            self.predict()
        worker.assert_not_called()

    def test_runtime_identity_changes_prediction_cache_key(self):
        self.select('native')
        first=_generate_cache_key('boltz2-prediction',self.fixture.inputs,Boltz2Config(seed=17))
        with patch.dict(os.environ,{'AUTOFOLD_RUNTIME_FINGERPRINT':'another-runtime'}):
            second=_generate_cache_key('boltz2-prediction',self.fixture.inputs,Boltz2Config(seed=17))
        self.assertNotEqual(first,second)


if __name__=='__main__':unittest.main()
