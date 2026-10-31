"""AF2 scientific settings survive infrastructure routing; no local GPU calls."""
import hashlib,importlib,json,os
from pathlib import Path
import unittest
from unittest.mock import patch

import gemmi
import test_bioir_boltz as fixtures
from proto_tools import predict_structures
from proto_tools.tools.structure_prediction.shared_data_models import ComplexMSAs,MSA

RUNTIME=Path(__file__).resolve().parents[1]/'runtime'
af2=importlib.import_module('proto_tools.tools.structure_prediction.alphafold2.alphafold2')


class AF2RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.BioIRTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        previous=Path.cwd();os.chdir(self.f.root);self.addCleanup(os.chdir,previous)
        self.profile=self.f.root/'profile.json'
        cfg=self.f.config
        asset={'checkpoint':cfg.checkpoint,'checkpoint_sha256':hashlib.sha256(Path(cfg.checkpoint).read_bytes()).hexdigest()}
        self.route={'backend':'bioir','python_executable':cfg.python_executable,
            'ccd_path':cfg.ccd_path,'mol_dir':cfg.mol_dir,
            'checkpoints':{'alphafold2_1':asset,'alphafold2_multimer_1':asset}}
        self.select(self.route)
        env=patch.dict(os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(self.profile),
            'AUTOFOLD_BOLTZ2_RUNTIME_HOOK':str(RUNTIME/'boltz_runtime.py'),
            'AUTOFOLD_RUNTIME_FINGERPRINT':str(self.f.root)})
        env.start();self.addCleanup(env.stop)
        self.f.raw['plddt']=[100*v for v in self.f.raw['plddt']]
        structure=gemmi.make_structure_from_block(gemmi.cif.read_string(self.f.cif).sole_block())
        for c in structure[0]:
            for r in c:
                for a in r:a.b_iso*=100
        self.f.cif=structure.make_mmcif_document().as_string()

    def select(self,route):
        self.profile.write_text(json.dumps({'schema_version':1,'boltz2':{'backend':'native'},'alphafold2':route,'environment':{}}))

    def predict(self,**config):
        return predict_structures(self.f.inputs.complexes,'alphafold2',
            {'use_msa':False,'include_pae_matrix':True,'seed':17,**config})

    def test_multimer_preserves_model_recycles_units_and_all_pae(self):
        with patch.object(fixtures.bioir.subprocess,'Popen',side_effect=self.f.fake_process):
            result=self.predict(model_num=1,num_recycles=2)
        s=result.structures[0]
        self.assertEqual(s.source,'alphafold2-prediction')
        self.assertEqual(s.metrics['execution_backend'],'bioir')
        self.assertEqual(s.metrics['pae'][0],[5.0,7.0,6.0,4.0])
        request=json.loads(next(Path('output/runtime').glob('*/predictions/*/request.json')).read_text())
        self.assertEqual(request['model_key'],'alphafold2_multimer_1')
        self.assertEqual(request['recycling_steps'],3)
        captured=json.loads(next(Path('output/runtime').glob('*/predictions/*/response.json')).read_text())
        self.assertEqual(captured['structures'][0]['source'],'alphafold2-bioir-prediction')
        self.assertEqual(s.get_chain_sequence('T'),'AA')
        model=gemmi.make_structure_from_block(gemmi.cif.read_string(s.structure).sole_block())[0]
        self.assertAlmostEqual(model['T'][0]['CA'][0].b_iso,92,places=3)

    def test_missing_models_and_unsupported_ensembles_never_substitute(self):
        with patch.object(fixtures.bioir.subprocess,'Popen') as worker:
            with self.assertRaisesRegex(ValueError,'No converted'):self.predict(model_num=2)
            with self.assertRaisesRegex(ValueError,'one selected'):self.predict(num_ensemble_models=2)
        worker.assert_not_called()

    def test_paired_and_deep_unpaired_alignments_remain_distinct(self):
        group=ComplexMSAs(per_chain={i:MSA(aligned_sequences=['AA','AA']) for i in [0,1]},paired=True,
            unpaired_per_chain={i:MSA(aligned_sequences=['AA','AG']) for i in [0,1]})
        with patch.object(fixtures.bioir.subprocess,'Popen',side_effect=self.f.fake_process):
            predict_structures(self.f.inputs.complexes,'alphafold2',
                {'use_msa':False,'include_pae_matrix':True,'seed':17},msas=group)
        request=json.loads(next(Path('output/runtime').glob('*/predictions/*/request.json')).read_text())
        self.assertIn('AG',request['complexes'][0][0]['a3m'])
        self.assertNotIn('AG',request['complexes'][0][0]['paired_a3m'])

    def test_native_route_stays_available(self):
        self.select({'backend':'native'})
        out=fixtures.bioir.StructurePredictionOutput(success=True,structures=[])
        with patch.object(af2,'_run_alphafold2_native',return_value=out) as native:
            result=self.predict()
        native.assert_called_once();self.assertTrue(result.success)


if __name__=='__main__':unittest.main()
