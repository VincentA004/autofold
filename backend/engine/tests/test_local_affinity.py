"""Native Proto composition and evidence/failure tests; subprocess results are fixtures."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]/'skills/proto-discovery/scripts'
spec = importlib.util.spec_from_file_location('local_affinity', SCRIPTS/'local_affinity.py')
affinity = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = affinity
spec.loader.exec_module(affinity)


class LocalAffinityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.structure = affinity.Structure(structure='ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 90.00           C  \nEND\n')
        self.inputs = affinity.ProdigyInput(structure=self.structure,target_chains=['A'],binder_chains=['B'])
        self.config = affinity.ProdigyConfig(python_executable=sys.executable,output_dir=str(self.root))
        self.native = {'prodigy_delta_g_kcal_mol':-8.123456,'prodigy_kd_molar':1.1e-6,
            'contacts_5_5A':12,'features':{'contact_bins':{'CC':3}},'version':'fixture',
            'temperature_celsius':25.0,'meaning':'Synthetic fixture, not biological evidence'}

    def fake_worker(self, command, **kwargs):
        Path(command[-1]).write_text(json.dumps(self.native))
        return subprocess.CompletedProcess(command,0)

    def test_capture_keeps_full_precision_inputs_features_and_exact_command(self):
        with patch.object(affinity.subprocess,'run',side_effect=self.fake_worker) as worker:
            result=affinity.run_prodigy(self.inputs,self.config)
        self.assertTrue(result.success)
        self.assertEqual(result.prodigy_delta_g_kcal_mol,-8.123456)
        directory=Path(result.capture_dir)
        request=json.loads((directory/'request.json').read_text())
        self.assertEqual(hashlib.sha256((directory/'structure.pdb').read_bytes()).hexdigest(),request['coordinates_sha256'])
        self.assertEqual((directory/'structure.pdb').read_text(),self.structure.structure)
        self.assertEqual(json.loads((directory/'native.json').read_text()),self.native)
        self.assertEqual(worker.call_args.args[0][0],str(Path(sys.executable).absolute()))
        self.assertEqual(worker.call_args.kwargs['env']['HF_HUB_OFFLINE'],'1')

    def test_independent_calls_never_replace_evidence(self):
        with patch.object(affinity.subprocess,'run',side_effect=self.fake_worker):
            a=affinity.run_prodigy(self.inputs,self.config)
            b=affinity.run_prodigy(self.inputs,self.config)
        self.assertNotEqual(a.capture_dir,b.capture_dir)
        self.assertEqual(len(list(self.root.glob('*/response.json'))),2)

    def test_chain_overlap_and_remote_device_are_rejected(self):
        for groups in [(['A'],['A']),(['A','A'],['B']),(['A,B'],['C']),([''],['B'])]:
            with self.subTest(groups=groups),self.assertRaises(ValueError):
                affinity.ProdigyInput(structure=self.structure,target_chains=groups[0],binder_chains=groups[1])
        with self.assertRaises(ValueError):
            affinity.ProdigyConfig(output_dir=str(self.root),device='modal')

    def test_missing_runtime_does_not_fall_back_to_api_or_install(self):
        with patch.object(affinity.subprocess,'run') as worker,self.assertRaises(ValueError):
            affinity.run_prodigy(self.inputs,affinity.ProdigyConfig(python_executable='/missing/python',output_dir=str(self.root)))
        worker.assert_not_called()

    def test_timeout_and_worker_failure_retain_inputs_and_error(self):
        for error in [subprocess.TimeoutExpired(['fixture'],1),subprocess.CalledProcessError(1,['fixture'])]:
            with self.subTest(error=error),patch.object(affinity.subprocess,'run',side_effect=error),self.assertRaises(type(error)):
                affinity.run_prodigy(self.inputs,self.config)
        self.assertEqual(len(list(self.root.glob('*/error.json'))),2)
        self.assertEqual(len(list(self.root.glob('*/request.json'))),2)
        self.assertFalse(list(self.root.glob('*/response.json')))

    def test_invalid_native_affinities_never_become_successful_scores(self):
        for field,value in [('prodigy_kd_molar',0),('prodigy_delta_g_kcal_mol',float('nan')),('contacts_5_5A',0)]:
            with self.subTest(field=field),patch.object(affinity.subprocess,'run',side_effect=self.fake_worker):
                self.native[field]=value
                with self.assertRaises(ValueError):affinity.run_prodigy(self.inputs,self.config)
                self.native[field]={'prodigy_kd_molar':1.1e-6,'prodigy_delta_g_kcal_mol':-8.123456,'contacts_5_5A':12}[field]
        self.assertFalse(list(self.root.glob('*/response.json')))

    def test_native_program_can_select_existing_structures_by_local_assessment(self):
        from contextlib import nullcontext
        from proto_language.core import Constraint,ConstraintOutput,Construct,Program,Segment,Sequence
        from proto_language.optimizer import RejectionSamplingOptimizer,RejectionSamplingOptimizerConfig
        segment=Segment(sequence='AAAA',sequence_type='protein')
        segment.result_sequences=[Sequence(sequence=s,sequence_type='protein',structure=self.structure) for s in ['AAAA','GGGG']]
        energies={'AAAA':-8.0,'GGGG':-10.0}
        def score(input_sequences,config):
            outputs=[]
            for (sequence,) in input_sequences:
                self.native['prodigy_delta_g_kcal_mol']=energies[sequence.sequence]
                value=affinity.run_prodigy(affinity.ProdigyInput(structure=sequence.structure,target_chains=['A'],binder_chains=['B']),self.config)
                outputs.append(ConstraintOutput(score=value.prodigy_delta_g_kcal_mol,
                    metadata={'estimated_kd_M':value.prodigy_kd_molar,'capture':value.capture_dir}))
            return outputs
        score._constraint_allow_raw_scores=True
        optimizer=RejectionSamplingOptimizer(constructs=[Construct([segment])],generators=[],
            constraints=[Constraint(inputs=[segment],function=score,label='prodigy_delta_g')],
            config=RejectionSamplingOptimizerConfig(num_samples=2,num_results=1,proposal_batch_size=2,track_proposals=True))
        with patch.object(affinity.subprocess,'run',side_effect=self.fake_worker):
            Program([optimizer],num_results=1,seed=1,compute=nullcontext()).run()
        self.assertEqual([s.sequence for s in segment.result_sequences],['GGGG'])
        self.assertTrue(list(self.root.glob('*/native.json')))


if __name__=='__main__':unittest.main()
