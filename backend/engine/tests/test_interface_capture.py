"""PAE ordering/identity and pLDDT semantics before native interface scoring."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
import numpy as np
from proto_tools import Structure
from proto_tools.entities.structures.structure import BFactorType
path=Path(__file__).parents[1]/'skills/proto-discovery/examples/interface_capture.py'
spec=importlib.util.spec_from_file_location('interface_capture',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
PDB='ATOM      1  CA  ALA A  15       0.000   0.000   0.000  1.00 80.00           C  \nATOM      2  CA  GLY B  26       4.000   0.000   0.000  1.00 90.00           C  \nEND\n'
class InterfaceTests(unittest.TestCase):
 def structure(self,pae=None):return Structure(structure=PDB,b_factor_type=BFactorType.PLDDT,metrics={'pae':pae if pae is not None else [[0,3],[7,0]]})
 def test_reorders_both_axes_retains_asymmetry_without_mutating_source(self):
  source=self.structure();result,keys=module.aligned_structure(source,[('B',1,'G'),('A',1,'A')])
  self.assertEqual(keys,[('A',1,'A'),('B',1,'G')]);self.assertEqual(result.metrics['pae'],[[0,7],[3,0]])
  self.assertEqual(source.metrics['pae'],[[0,3],[7,0]])
 def test_same_shape_wrong_identity_missing_duplicate_and_nonfinite_rejected(self):
  for keys in [[('A',1,'G'),('B',1,'G')],[('A',1,'A')],[('A',1,'A'),('A',1,'A')]]:
   with self.assertRaisesRegex(ValueError,'mapping'):module.aligned_structure(self.structure(),keys)
  for matrix in [[[0]],[[0,float('nan')],[7,0]],[[0,-1],[7,0]]]:
   with self.assertRaisesRegex(ValueError,'PAE'):module.aligned_structure(self.structure(matrix),[('A',1,'A'),('B',1,'G')])
 def test_unknown_bfactor_semantics_rejected(self):
  s=Structure(structure=PDB,metrics={'pae':[[0,3],[7,0]]})
  with self.assertRaisesRegex(ValueError,'pLDDT'):module.aligned_structure(s,[('A',1,'A'),('B',1,'G')])
 def test_nonfinite_native_score_is_retained_but_not_returned_as_fitness(self):
  class Output:
   success=True
   def model_dump(self,**kwargs):return {'success':True,'metrics':{'ipsae':float('nan'),'pdockq2':.5}}
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaisesRegex(ValueError,'nonfinite'):
    module.score_interface_captured(self.structure(),pae_residues=[('A',1,'A'),('B',1,'G')],binder_chain='A',target_chains=['B'],capture_dir=tmp,scorer=lambda i,c:Output())
   directory=next(Path(tmp).iterdir())
   self.assertTrue(np.isnan(json.loads((directory/'response.json').read_text())['metrics']['ipsae']))
   self.assertTrue((directory/'error.json').exists())
if __name__=='__main__':unittest.main()
