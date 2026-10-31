"""Native Complexa final-sample handoff without inference dependencies."""
from contextlib import nullcontext
import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml
sys.path.insert(0,str(Path(__file__).parents[1]/'skills/proto-discovery/scripts'))
import complexa_generator as bridge
from proto_language.core import Segment,Construct,Constraint,ConstraintOutput,Program
from proto_language.optimizer import RejectionSamplingOptimizer,RejectionSamplingOptimizerConfig

PDB='ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 80.00           C  \nATOM      2  CA  GLY B   1       4.000   0.000   0.000  1.00 80.00           C  \nEND\n'

class ComplexaTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  for n in ['flow.ckpt','ae.ckpt']:(self.root/n).write_text('fixture')
  self.spec=self.root/'native.yaml'
  self.spec.write_text(yaml.safe_dump({'ckpt_path':str(self.root),'ckpt_name':'flow.ckpt','autoencoder_ckpt_path':str(self.root/'ae.ckpt'),'generation':{'dataloader':{'batch_size':8,'dataset':{'conditional_features':[]}},'search':{'max_batch_size':8,'algorithm':'single-pass'}}}))
  self.gen=bridge.ComplexaBinderGenerator(bridge.ComplexaBinderConfig(design_spec=str(self.spec),binder_chain='B',target_chain='A',target_sequence='A',output_dir=str(self.root/'out'),repo_dir=str(self.root),python_executable=sys.executable))
  self.seg=Segment(length=1,sequence_type='protein');self.gen.assign(self.seg);self.gen._set_program_seed(17)
 def tearDown(self):self.temp.cleanup()
 def native(self,command,**kwargs):
  self.assertEqual(command[1:3],['-m','proteinfoundation.generate']);self.assertEqual(kwargs['env']['HF_HUB_OFFLINE'],'1')
  config=yaml.safe_load((Path(command[4])/(command[6]+'.yaml')).read_text())
  self.assertEqual(config['generation']['dataloader']['batch_size'],1)
  self.assertEqual(config['hydra']['run']['dir'],str(Path(command[4])/'hydra'))
  out=Path(config['root_path']);out.mkdir()
  rows=[]
  for role in ['final','lookahead','final_unrefined']:
   p=out/(role+'.pdb');p.write_text(PDB)
   rows.append({'pdb_path':str(p),'sample_type':role,'total_reward':'1.5'})
  with (out/'rewards_effective_0.csv').open('w') as f:
   writer=csv.DictWriter(f,fieldnames=rows[0].keys());writer.writeheader();writer.writerows(rows)
  return subprocess.CompletedProcess(command,0)
 def test_native_proto_selection_returns_only_final_preserves_all_roles(self):
  opt=RejectionSamplingOptimizer(constructs=[Construct([self.seg])],generators=[self.gen],constraints=[Constraint(inputs=[self.seg],function=lambda ins,config:[ConstraintOutput(score=0) for _ in ins],threshold=0)],config=RejectionSamplingOptimizerConfig(num_samples=1,num_results=1,proposal_batch_size=1))
  with patch.object(bridge.subprocess,'run',side_effect=self.native):Program([opt],num_results=1,seed=21,compute=nullcontext()).run()
  self.assertEqual(self.seg.result_sequences[0].sequence,'G')
  capture=self.root/'out/complexa-call-001'
  self.assertEqual([r['role'] for r in json.loads((capture/'outputs.json').read_text())],['final','lookahead','final_unrefined'])
  self.assertTrue(self.seg.result_sequences[0].structure)
  self.assertEqual((capture/'authored.yaml').read_bytes(),self.spec.read_bytes())
 def test_target_mismatch_and_partial_output_fail_with_receipts(self):
  self.gen.config.target_sequence='V'
  with patch.object(bridge.subprocess,'run',side_effect=self.native):
   with self.assertRaisesRegex(ValueError,'target identity'):self.gen.sample()
  self.assertIn('target identity',json.loads(next((self.root/'out').rglob('receipt.json')).read_text())['error'])
  self.assertTrue(next((self.root/'out').rglob('final.pdb')).exists())
 def test_missing_assets_and_unresolved_config_rejected_before_dispatch(self):
  for contents in ['defaults: [inference_base]\n', self.spec.read_text().replace(str(self.root/'ae.ckpt'),'/missing/ae.ckpt')]:
   self.spec.write_text(contents)
   with patch.object(bridge.subprocess,'run') as call:
    with self.assertRaises(ValueError):self.gen.sample()
    call.assert_not_called()
 def test_missing_final_role_is_not_guessed_from_filename(self):
  def invalid(command,**kwargs):
   result=self.native(command,**kwargs)
   p=next((self.root/'out').rglob('rewards_*.csv'));p.write_text(p.read_text().replace('final,','unknown,'))
   return result
  with patch.object(bridge.subprocess,'run',side_effect=invalid):
   with self.assertRaisesRegex(ValueError,'role'):self.gen.sample()
 def test_native_numbering_gaps_are_not_extra_residues_and_raw_is_retained(self):
  path=self.root/'gapped.pdb'
  text=PDB.replace('GLY B   1','GLY B   2').replace('END\n','ATOM      3  CA  VAL B   5       8.000   0.000   0.000  1.00 80.00           C  \nEND\n')
  path.write_text(text)
  result,chains,mapping=bridge.normalize_output(path)
  self.assertEqual(chains,{'A':'A','B':'GV'})
  self.assertEqual(result.get_chain_sequences(),chains)
  self.assertEqual([x['native_author'] for x in mapping],['1','2','5'])
  self.assertEqual(path.read_text(),text)
 def test_missing_native_hotspot_mask_is_rejected_before_model_dispatch(self):
  doc=yaml.safe_load(self.spec.read_text());doc['generation']['dataloader']['dataset']['conditional_features']=[{'_target_':'proteinfoundation.datasets.gen_dataset.TargetFeatures','target_hotspots':None}]
  self.spec.write_text(yaml.safe_dump(doc))
  with patch.object(bridge.subprocess,'run') as call:
   with self.assertRaisesRegex(ValueError,'target_hotspots'):self.gen.sample()
   call.assert_not_called()
if __name__=='__main__':unittest.main()
