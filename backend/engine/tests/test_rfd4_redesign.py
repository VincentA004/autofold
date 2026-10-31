"""Parent consumption, numbering and real native Cycling wiring; no GPU."""
from contextlib import nullcontext
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml
sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/proto-discovery/scripts'))
import rfd4_redesign as bridge
from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment, Sequence
from proto_language.optimizer import CyclingOptimizer, CyclingOptimizerConfig
from proto_tools import Structure


def structure(binder='GLY', offset=0):
    lines=[]
    for chain, aa in [('A','ALA'),('B',binder)]:
        for atom in ['N','CA','C','O']:
            i=len(lines)+1
            x=i+(offset if chain=='B' else 0)
            lines.append(f'ATOM  {i:5d} {atom:^4} {aa} {chain}{15:4d}    {x:8.3f}{0.:8.3f}{0.:8.3f}  1.00 80.00           C  ')
    return Structure(structure='\n'.join(lines)+'\nEND\n')


class RedesignTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.model=self.root/'model';self.model.mkdir()
        for name in ['config.json','model.safetensors']:(self.model/name).write_text('fixture')
        self.cfg=bridge.RFD4RedesignConfig(operation='inverse_folding',binder_chain='B',target_chain='A',
            target_sequence='A',output_dir=str(self.root/'out'),model_path=str(self.model),fixed_positions=[1])
        self.gen=bridge.RFD4RedesignGenerator(self.cfg)
        self.segment=Segment(sequence='G',sequence_type='protein');self.gen.assign(self.segment)

    def tearDown(self):self.temp.cleanup()

    def test_inverse_folding_does_not_claim_a_bioir_velocity_call(self):
        profile=self.root/'runtime.json'
        profile.write_text(json.dumps({'rfd4':{'backend':'bioir'}}))
        import os
        with patch.dict(os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(profile)}):
            self.assertEqual(self.gen._runtime_overrides(),[])
        self.assertEqual(self.gen._execution_backend,'native-autoencoder')

    def parent(self, name='p', binder='G', aa='GLY', offset=0):
        return bridge.RFD4Parent(name,binder,structure(aa,offset),'prediction/response.json')

    def native(self, command, **kwargs):
        args=dict(x.split('=',1) for x in command[1:] if '=' in x)
        spec=yaml.safe_load(Path(args['inputs']).read_text())['parent_redesign']
        parent=Path(spec['input'])
        out=Path(args['out_dir'])/'inference_samples'/'p';out.mkdir(parents=True)
        (out/'p_generated.cif').write_bytes(parent.read_bytes())
        return subprocess.CompletedProcess(command,0)

    def test_real_cycling_consumes_two_distinct_parents_preserves_lineage_and_seed(self):
        seen=[]
        def condition(sequences):
            parent=self.parent(f'p{len(seen)}',offset=len(seen)*3)
            seen.append(parent)
            return [parent]
        opt=CyclingOptimizer(target_segment=self.segment,constructs=[Construct([self.segment])],generators=[self.gen],
            constraints=[Constraint(inputs=[self.segment],function=lambda ins,config:[ConstraintOutput(score=0) for _ in ins],threshold=0)],
            conditioning_fn=condition,config=CyclingOptimizerConfig(num_steps=2,num_results=1))
        with patch('model_generators.subprocess.run',side_effect=self.native):
            Program([opt],num_results=1,seed=17,compute=nullcontext()).run()
        records=[json.loads(p.read_text()) for p in sorted((self.root/'out').glob('*/parent.json'))]
        self.assertEqual([r['parent_id'] for r in records],['p0','p1'])
        self.assertNotEqual(records[0]['parent_sha256'],records[1]['parent_sha256'])
        self.assertEqual(records[0]['numbering'][0]['author'],'15')
        self.assertEqual(records[0]['numbering'][0]['normalized_label'],1)
        # Native RFD4 selects label_asym_id; author-only chain renames are insufficient.
        import gemmi
        block=gemmi.cif.read_file(str(self.root/'out/parent-001/parent.cif')).sole_block()
        self.assertEqual(set(block.find_values('_atom_site.label_asym_id')),{'A','B'})
        child=self.segment.result_sequences[0]
        self.assertEqual(child._generator_metadata['rfd4-redesign']['parent_id'],'p1')
        self.assertEqual(child._generator_metadata['rfd4-redesign']['geometry_role'],'generated')
        requests=[json.loads(p.read_text()) for p in (self.root/'out').glob('*/rfd4-call-*/request.json')]
        self.assertNotEqual(requests[0]['seed'],requests[1]['seed'])
        self.assertTrue(all('generation=inverse_folding' in r['command'] for r in requests))

    def test_bad_parent_identity_mask_and_missing_backbone_fail_before_dispatch(self):
        for parent,positions in [(self.parent(binder='A'),[1]),(self.parent(),[0]),(self.parent(),[1,1])]:
            with self.subTest(positions=positions,parent=parent.sequence):
                self.gen.config.fixed_positions=positions
                with patch('model_generators.subprocess.run') as run:
                    with self.assertRaises(ValueError):self.gen.sample([parent])
                    run.assert_not_called()
        self.gen.config.fixed_positions=[1]
        p=self.parent();p.structure=Structure(structure=p.structure.structure.replace(' CA ',' XX '))
        with self.assertRaisesRegex(ValueError,'backbone'):self.gen.sample([p])

    def test_changed_fixed_identity_keeps_failed_native_outputs(self):
        def bad(command,**kwargs):
            result=self.native(command,**kwargs)
            p=next((self.root/'out').rglob('*generated.cif'))
            p.write_text(structure('VAL').structure_cif)
            return result
        with patch('model_generators.subprocess.run',side_effect=bad):
            with self.assertRaisesRegex(ValueError,'fixed binder'):self.gen.sample([self.parent()])
        self.assertTrue(next((self.root/'out').rglob('*generated.cif')).exists())
        self.assertIn('fixed binder',json.loads(next((self.root/'out').rglob('receipt.json')).read_text())['error'])

    def test_partial_redesign_native_fraction_and_no_static_parent(self):
        self.gen.config.operation='partial_redesign';self.gen.config.partial_fraction=0.25
        with patch('model_generators.subprocess.run',side_effect=self.native):self.gen.sample([self.parent()])
        request=json.loads(next((self.root/'out').rglob('request.json')).read_text())
        self.assertIn('generation.args.partial_trajectory_fraction_steps=0.25',request['command'])
        self.assertNotIn('generation=inverse_folding',request['command'])
        self.gen.config.mode='guided_search'
        with self.assertRaisesRegex(ValueError,'guided partial'):self.gen.sample([self.parent()])

    def test_inverse_geometry_change_is_rejected_and_native_artifact_survives(self):
        def moved(command,**kwargs):
            result=self.native(command,**kwargs)
            p=next((self.root/'out').rglob('*generated.cif'))
            p.write_text(structure(offset=2).structure_cif)
            return result
        with patch('model_generators.subprocess.run',side_effect=moved):
            with self.assertRaisesRegex(ValueError,'fixed parent CA'):self.gen.sample([self.parent()])
        self.assertTrue(next((self.root/'out').rglob('*generated.cif')).exists())

    def test_masks_are_encoded_separately_in_native_label_numbering(self):
        self.gen.config.operation='partial_redesign'
        self.gen.config.backbone_condition_positions=[1];self.gen.config.target_hotspots=[1]
        with patch('model_generators.subprocess.run',side_effect=self.native):self.gen.sample([self.parent()])
        spec=yaml.safe_load(next((self.root/'out').rglob('conditioning.yaml')).read_text())['parent_redesign']
        self.assertEqual(spec['contig'],'A1-1,/0,B1-1')
        self.assertEqual(spec['conditions']['C_HOT'][True],[{'select':"sel('A/*/1')"}])
        self.assertIn({'select':"sel('B/*/1/[N,CA,C,O]')"},spec['conditions']['C_CRDGRP'][1])
        request=json.loads(next((self.root/'out').rglob('request.json')).read_text())
        self.assertNotIn('generation=inverse_folding',request['command'])
        self.assertIn('generation.args.partial_trajectory_fraction_steps=0.25',request['command'])

    def test_partial_backbone_conditioning_does_not_pretend_to_freeze_geometry(self):
        self.gen.config.operation='partial_redesign';self.gen.config.backbone_condition_positions=[1]
        def moved(command,**kwargs):
            result=self.native(command,**kwargs)
            p=next((self.root/'out').rglob('*generated.cif'))
            p.write_text(structure(offset=2).structure_cif)
            return result
        with patch('model_generators.subprocess.run',side_effect=moved):self.gen.sample([self.parent()])
        self.assertEqual(len(self.segment.proposal_sequences),1)


if __name__=='__main__':unittest.main()
