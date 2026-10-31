"""Retain the actual CCD/native worker evidence, including failed calls."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from proto_tools.utils import ToolInstance

FILE=Path(__file__).parents[1]/'skills/proto-discovery/examples/boltz_native_capture.py'
spec=importlib.util.spec_from_file_location('boltz_native_capture',FILE)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class CaptureTests(unittest.TestCase):
    def test_ccd_and_raw_outputs_survive_source_cleanup_and_dispatch_is_restored(self):
        with tempfile.TemporaryDirectory() as temp:
            d=Path(temp);source=d/'input.yaml';source.write_text('sequences: [{ligand: {id: L, ccd: WG0}}]\n')
            mols=d/'mols';mols.mkdir();(mols/'WG0.pkl').write_bytes(b'fixture-native-molecule')
            output=d/'temporary';output.mkdir()
            def worker(cls,toolkit,request,**kwargs):
                (output/'pose.cif').write_text('native coordinates')
                return {'metrics':{'affinity_pred_value':-1.0}}
            with patch.object(ToolInstance,'dispatch',classmethod(worker)):
                before=ToolInstance.__dict__['dispatch']
                with module.capture_boltz_native(d/'capture',ccd_mol_dir=mols) as calls:
                    result=ToolInstance.dispatch('boltz2',{'input_yaml_path':str(source),'output_dir':str(output)})
                self.assertIs(ToolInstance.__dict__['dispatch'],before)
            source.unlink();(mols/'WG0.pkl').unlink();(output/'pose.cif').unlink()
            self.assertEqual(len(calls),1)
            self.assertEqual((calls[0]/'native-ccd/WG0.pkl').read_bytes(),b'fixture-native-molecule')
            self.assertEqual((calls[0]/'native/pose.cif').read_text(),'native coordinates')
            self.assertEqual(json.loads((calls[0]/'response.json').read_text()),result)
            self.assertEqual(json.loads((calls[0]/'chemical-references.json').read_text())[0]['ccd'],'WG0')

    def test_missing_ccd_evidence_prevents_an_uncapturable_model_call(self):
        with tempfile.TemporaryDirectory() as temp:
            d=Path(temp);source=d/'input.yaml';source.write_text('sequences: [{ligand: {ccd: WG0}}]\n')
            with patch.object(ToolInstance,'dispatch') as worker:
                with module.capture_boltz_native(d/'capture'):
                    with self.assertRaisesRegex(ValueError,'native CCD evidence'):
                        ToolInstance.dispatch('boltz2',{'input_yaml_path':str(source),'output_dir':str(d/'output')})
                worker.assert_not_called()
            self.assertTrue((d/'capture/worker-000/error.json').exists())

    def test_failed_prediction_keeps_partial_outputs_and_non_boltz_calls_pass_through(self):
        with tempfile.TemporaryDirectory() as temp:
            d=Path(temp);source=d/'input.yaml';source.write_text('sequences: [{ligand: {smiles: CCO}}]\n')
            output=d/'output';output.mkdir()
            def worker(cls,toolkit,request,**kwargs):
                if toolkit!='boltz2':return {'other':True}
                (output/'partial.json').write_text('{}');raise RuntimeError('native failure')
            with patch.object(ToolInstance,'dispatch',classmethod(worker)):
                with module.capture_boltz_native(d/'capture'):
                    self.assertEqual(ToolInstance.dispatch('other',{}),{'other':True})
                    with self.assertRaisesRegex(RuntimeError,'native failure'):
                        ToolInstance.dispatch('boltz2',{'input_yaml_path':str(source),'output_dir':str(output)})
            self.assertTrue((d/'capture/worker-000/native/partial.json').exists())


if __name__=='__main__':unittest.main()
