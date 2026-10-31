"""CPU fixtures exercise token identity, units, dispatcher and failure capture."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import gemmi
import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]/'runtime'
spec = importlib.util.spec_from_file_location('bioir_boltz',SCRIPTS/'bioir_boltz.py')
bioir = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bioir
spec.loader.exec_module(bioir)


class BioIRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('weights','ccd'):
            (self.root/name).write_bytes(b'fixture')
        self.config = bioir.BioIRBoltzConfig(python_executable=sys.executable,
            checkpoint=str(self.root/'weights'),ccd_path=str(self.root/'ccd'),
            mol_dir=str(self.root),output_dir=str(self.root/'captures'),seed=17)
        self.chains = [{'id':'T','sequence':'AA'},{'id':'B','sequence':'AA'}]
        # Identical sequences deliberately cannot establish partner identity.
        self.raw = {'chain_indices':[1,0,1,0], 'residue_indices':[2,1,1,2],
            'residue_names':['ALA']*4,'plddt':[.81,.92,.83,.94],
            'pae':np.arange(16).reshape(4,4).tolist(),'ptm':.8,'iptm':.7}
        structure = gemmi.Structure()
        model = gemmi.Model('1')
        for idx,name in enumerate(['A','B']):
            chain = gemmi.Chain(name)
            for pos in [1,2]:
                residue = gemmi.Residue()
                residue.name = 'ALA'
                residue.seqid = gemmi.SeqId(pos,' ')
                token = list(zip(self.raw['chain_indices'],self.raw['residue_indices'])).index((idx,pos))
                for atom_name in ['N','CA','C','O']:
                    atom = gemmi.Atom()
                    atom.name = atom_name
                    atom.element = gemmi.Element('N' if atom_name=='N' else 'O' if atom_name=='O' else 'C')
                    atom.pos = gemmi.Position(idx*10+pos,0,0)
                    atom.b_iso = self.raw['plddt'][token]
                    residue.add_atom(atom)
                chain.add_residue(residue)
            model.add_chain(chain)
        structure.add_model(model)
        structure.setup_entities()
        self.cif = structure.make_mmcif_document().as_string()
        self.inputs = bioir.BioIRBoltzInput(complexes=[{'chains':[
            {'id':c['id'],'sequence':c['sequence'],'entity_type':'protein'} for c in self.chains]}])

    def test_source_indices_reorder_both_pae_axes_and_keep_identical_partners(self):
        cif,metrics,mapping = bioir.normalize_prediction(self.raw,self.cif,self.chains)
        order = [1,3,2,0]
        np.testing.assert_equal(metrics['pae'],np.asarray(self.raw['pae'])[np.ix_(order,order)])
        self.assertEqual([row['source_token_index'] for row in mapping],order)
        self.assertEqual([row['chain'] for row in mapping],['T','T','B','B'])
        model = gemmi.make_structure_from_block(gemmi.cif.read_string(cif).sole_block())[0]
        self.assertEqual([c.name for c in model],['T','B'])
        self.assertAlmostEqual(model['T'][0]['CA'][0].b_iso,92,places=3)
        self.assertAlmostEqual(model['B'][0]['CA'][0].pos.x,11)

    def test_bad_mapping_matrix_units_and_coordinates_fail(self):
        cases = [('chain_indices',[0,0,1,0]),('residue_indices',[1,1,1,2]),
                 ('pae',[[1]]),('pae',[[float('nan')]*4]*4),
                 ('plddt',[81,92,83,94]),('plddt',[float('nan')]*4),
                 ('residue_names',['GLY']*4),('ptm',float('nan'))]
        for key,value in cases:
            raw = copy.deepcopy(self.raw)
            raw[key] = value
            with self.subTest(key=key),self.assertRaises(ValueError):
                bioir.normalize_prediction(raw,self.cif,self.chains)
        chains = copy.deepcopy(self.chains)
        chains[0]['sequence'] = 'GG'
        with self.assertRaises(ValueError):
            bioir.normalize_prediction(self.raw,self.cif,chains)

    def test_unsupported_options_do_not_silently_change_requests(self):
        for extra in [{'diffusion_samples':2},{'use_msa':True},{'step_scale':2},
                      {'include_pae_matrix':False},{'device':'cpu'}]:
            with self.subTest(extra=extra),self.assertRaises(ValueError):
                bioir.BioIRBoltzConfig(output_dir='out',**extra)
        with self.assertRaises(ValueError):
            bioir.BioIRBoltzInput(complexes=[{'chains':[{'id':'A','sequence':'AX','entity_type':'protein'}]}])
        from proto_tools.tools.structure_prediction.shared_data_models import ComplexMSAs,MSA
        paired = ComplexMSAs(per_chain={0:MSA(aligned_sequences=['AA','AA'])},paired=True)
        with self.assertRaises(ValueError):
            bioir.BioIRBoltzInput(complexes=self.inputs.complexes,msas=[paired])

    def fake_process(self,command,**kwargs):
        request = json.loads(Path(command[-2]).read_text())
        directory = Path(command[-1]).parent
        self.assertEqual(kwargs['env']['HF_HUB_OFFLINE'],'1')
        model=request.get('model_key','boltz-2')
        checkpoint_env='BOLTZ2_CKPT' if model=='boltz-2' else model.upper()+'_CKPT'
        self.assertEqual(kwargs['env'][checkpoint_env],self.config.checkpoint)
        self.assertTrue(kwargs['start_new_session'])
        self.assertEqual(request['seed'],17)
        (directory/'native').mkdir()
        ids = [f'prediction-{i}' for i in range(len(request['complexes']))]
        for rid in ids:
            bioir._write(directory/(rid+'-raw.json'),self.raw)
            (directory/'native'/(rid+'.cif')).write_text(self.cif)
        bioir._write(command[-1],{'record_ids':ids})
        class Process:
            returncode = 0
            def wait(self,timeout): return 0
            def poll(self): return 0
        return Process()

    def test_existing_dispatcher_captures_full_response_and_keeps_native_default(self):
        from proto_tools.tools.structure_prediction.dispatch import SP_TOOL_MAP
        from proto_tools.tools.structure_prediction.boltz2 import Boltz2Config
        native = SP_TOOL_MAP['boltz2']['config']
        with patch.object(bioir.subprocess,'Popen',side_effect=self.fake_process):
            result = bioir.run_bioir_boltz(self.inputs,self.config)
        self.assertTrue(result.success)
        self.assertIs(native,Boltz2Config)
        self.assertIs(SP_TOOL_MAP['boltz2']['config'],native)
        capture = Path(result.structures[0].metrics['bioir_capture_dir'])
        self.assertEqual(json.loads((capture/'prediction-0-raw.json').read_text()),self.raw)
        self.assertTrue((capture/'response.json').exists())
        self.assertEqual(result.structures[0].source,'boltz2-bioir-prediction')
        self.assertEqual(result.structures[0].b_factor_type,bioir.BFactorType.PLDDT)

    def test_batch_retains_each_prediction_and_can_compose_in_a_native_program(self):
        from contextlib import nullcontext
        from proto_tools import predict_structures
        from proto_language.core import Constraint,ConstraintOutput,Construct,Program,Segment,Sequence
        from proto_language.optimizer import RejectionSamplingOptimizer,RejectionSamplingOptimizerConfig
        with patch.object(bioir.subprocess,'Popen',side_effect=self.fake_process):
            result = bioir.run_bioir_boltz(bioir.BioIRBoltzInput(complexes=self.inputs.complexes*2),self.config)
        self.assertEqual(len(result.structures),2)
        capture = Path(result.structures[0].metrics['bioir_capture_dir'])
        self.assertEqual(len(list(capture.glob('*-raw.json'))),2)
        segment = Segment(sequence='AA',sequence_type='protein')
        segment.result_sequences = [Sequence(sequence='AA',sequence_type='protein')]
        def assess(input_sequences,config):
            prediction = bioir.run_bioir_boltz(self.inputs,self.config).structures[0]
            input_sequences[0][0].structure = prediction
            return [ConstraintOutput(score=1-prediction.metrics['iptm'],metadata={'capture':prediction.metrics['bioir_capture_dir']})]
        optimizer = RejectionSamplingOptimizer(constructs=[Construct([segment])],generators=[],
            constraints=[Constraint(inputs=[segment],function=assess)],
            config=RejectionSamplingOptimizerConfig(num_samples=1,num_results=1))
        with patch.object(bioir.subprocess,'Popen',side_effect=self.fake_process):
            Program([optimizer],num_results=1,seed=1,compute=nullcontext()).run()
        self.assertEqual(segment.result_sequences[0].structure.source,'boltz2-bioir-prediction')

    def test_timeout_stops_worker_group_and_keeps_failure_evidence(self):
        class TimedOut:
            pid = 123456
            returncode = None
            calls = 0
            def wait(self,timeout):
                self.calls += 1
                if self.calls==1: raise subprocess.TimeoutExpired(['fixture'],timeout)
                self.returncode = -15
                return -15
            def poll(self): return self.returncode
        with patch.object(bioir.subprocess,'Popen',return_value=TimedOut()),patch.object(bioir.os,'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                bioir.run_bioir_boltz(self.inputs,self.config)
        kill.assert_called_once_with(123456,bioir.signal.SIGTERM)
        self.assertEqual(len(list((self.root/'captures').glob('*/error.json'))),1)

    def test_missing_assets_do_not_start_worker(self):
        config = self.config.model_copy(update={'checkpoint':'/missing/weights'})
        with patch.object(bioir.subprocess,'Popen') as worker,self.assertRaises(ValueError):
            bioir.run_bioir_boltz(self.inputs,config)
        worker.assert_not_called()

    def test_worker_errors_and_invalid_predictions_remain_visible(self):
        with patch.object(bioir.subprocess,'Popen',side_effect=OSError('fixture worker failure')):
            with self.assertRaises(OSError):
                bioir.run_bioir_boltz(self.inputs,self.config)
        self.raw['pae'] = [[float('nan')]*4]*4
        with patch.object(bioir.subprocess,'Popen',side_effect=self.fake_process):
            with self.assertRaises(ValueError):
                bioir.run_bioir_boltz(self.inputs,self.config)
        captures = self.root/'captures'
        self.assertEqual(len(list(captures.glob('*/error.json'))),2)
        self.assertFalse(list(captures.glob('*/response.json')))
        self.assertTrue(list(captures.glob('*/prediction-0-raw.json')))


if __name__=='__main__': unittest.main()
