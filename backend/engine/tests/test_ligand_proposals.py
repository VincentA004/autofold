"""Real RDKit graph edits and native Proto search; no inference or network."""
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

from rdkit import Chem
from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment, Sequence
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig, MCMCOptimizer, MCMCOptimizerConfig

FILE = Path(__file__).parents[1]/'skills/proto-discovery/scripts/ligand_proposals.py'
spec = importlib.util.spec_from_file_location('ligand_proposals', FILE)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class LigandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def generator(self, edits=None, core='CC(=O)', **kwargs):
        return module.LigandAnalogGenerator(module.LigandAnalogConfig(
            edits=edits or [dict(name='ester_extension', smarts='[C:1](=[O:2])[O:3][CH3]>>[C:1](=[O:2])[O:3]CC')],
            fixed_core_smarts=core, output_dir=str(self.root/'captures'), **kwargs))

    def test_native_variable_length_proposals_selection_and_capture(self):
        gen = self.generator()
        seg = Segment(sequence='CC(=O)OC', sequence_type='ligand')
        gen.assign(seg)
        observed = []
        def score(rows, config):
            observed.extend(s.sequence for (s,) in rows)
            return [ConstraintOutput(score=0.1) for _ in rows]
        opt = RejectionSamplingOptimizer(constructs=[Construct([seg])], generators=[gen],
            constraints=[Constraint(inputs=[seg], function=score)],
            config=RejectionSamplingOptimizerConfig(num_samples=2, num_results=2, proposal_batch_size=2,track_proposals=True))
        Program([opt],num_results=2,seed=19,compute=nullcontext()).run()
        self.assertEqual(set(observed), {'CCOC(C)=O'})
        self.assertTrue(all(s.sequence_type=='ligand' and s.structure is None for s in seg.result_sequences))
        selected = json.loads(next((self.root/'captures').glob('*/selected.json')).read_text())
        self.assertEqual(selected[0]['parent_smiles'], 'COC(C)=O')
        self.assertNotEqual(len(seg.result_sequences[0].sequence), seg.sequence_length)

    def test_existing_protein_generator_still_rejects_ligands(self):
        with self.assertRaisesRegex(ValueError,'Ligand segments cannot be mutated'):
            RandomProteinGenerator(RandomProteinGeneratorConfig()).assign(Segment(sequence='CCO',sequence_type='ligand'))
        with self.assertRaisesRegex(ValueError,'Supported types'):
            self.generator().assign(Segment(sequence='ACDE',sequence_type='protein'))

    def test_mcmc_uses_changed_parent_in_next_step(self):
        gen=self.generator(edits=[dict(name='add_carbon',smarts='[CH3:1]>>C[CH2:1]')],core='C(=O)O')
        seg=Segment(sequence='CC(=O)OC',sequence_type='ligand');gen.assign(seg)
        def longer(rows,config):
            return [ConstraintOutput(score=1/(1+Chem.MolFromSmiles(s.sequence).GetNumHeavyAtoms())) for (s,) in rows]
        opt=MCMCOptimizer(constructs=[Construct([seg])],generators=[gen],constraints=[Constraint(inputs=[seg],function=longer)],
            config=MCMCOptimizerConfig(num_steps=2,num_results=1,track_proposals=True))
        Program([opt],num_results=1,seed=12,compute=nullcontext()).run()
        self.assertEqual(Chem.MolFromSmiles(seg.result_sequences[0].sequence).GetNumHeavyAtoms(),7)
        requests=[json.loads(p.read_text()) for p in (self.root/'captures').glob('*/request.json')]
        self.assertEqual(len(requests),2)
        self.assertEqual({Chem.MolFromSmiles(x['parents'][0]).GetNumHeavyAtoms() for x in requests},{5,6})

    def test_stereo_preserved_and_insufficient_core_rejected(self):
        parent='C[C@H](O)CC(=O)OC'
        gen=self.generator(core='C[C@H](O)CC(=O)')
        _, options, _=gen._enumerate(parent)
        self.assertEqual(len(options),1)
        product=next(iter(options))
        self.assertTrue(Chem.MolFromSmiles(product).HasSubstructMatch(Chem.MolFromSmarts('C[C@H](O)CC(=O)'),useChirality=True))
        with self.assertRaisesRegex(ValueError,'stereocenters'):
            self.generator()._enumerate(parent)
        with self.assertRaisesRegex(ValueError,'stereochemistry'):
            module.molecule('CC(O)CC(=O)OC')

    def test_rejected_unchanged_core_charge_size_and_invalid_products(self):
        cases=[
            ([dict(name='identity',smarts='[C:1]>>[C:1]')],'CC(=O)OC','CC(=O)',{},'Unchanged'),
            ([dict(name='core_change',smarts='[C:1](=[O:2])>>[C:1](=[S:2])')],'CC(=O)OC','CC(=O)',{},'core'),
            ([dict(name='charge',smarts='[NH2:1]>>[NH3+:1]')],'CCN','CC',{},'charge'),
            (None,'CC(=O)OC','CC(=O)',{'max_heavy_atoms':5},'limit'),
            ([dict(name='valence',smarts='[C:1]>>[C:1](F)(F)(F)(F)(F)')],'CC(=O)OC','CC',{},'valence'),
        ]
        for edits,parent,core,kwargs,reason in cases:
            with self.subTest(reason=reason):
                gen=self.generator(edits=edits,core=core,**kwargs)
                _,opts,records=gen._enumerate(parent)
                self.assertFalse(opts)
                self.assertTrue(any(reason.lower() in r.get('reason','').lower() for r in records))

    def test_failure_retains_enumeration_and_seed_reproducibility(self):
        gen=self.generator();gen.assign(Segment(sequence='CCO',sequence_type='ligand'))
        with self.assertRaisesRegex(ValueError,'Parent does not match'):
            gen.sample()
        self.assertFalse(json.loads(next((self.root/'captures').glob('*/receipt.json')).read_text())['success'])
        edits=[dict(name='ethyl',smarts='[C:1](=[O:2])[O:3][CH3]>>[C:1](=[O:2])[O:3]CC'),dict(name='propyl',smarts='[C:1](=[O:2])[O:3][CH3]>>[C:1](=[O:2])[O:3]CCC')]
        values=[]
        for _ in range(2):
            g=self.generator(edits=edits);g.assign(Segment(sequence='CC(=O)OC',sequence_type='ligand'));g._set_program_seed(99);g.sample();values.append(g.segment.proposal_sequences[0].sequence)
        self.assertEqual(*values)

    def test_unsupported_inputs_rejected_before_search(self):
        for s in ['CCO.O','C[CH2]','not-a-smiles']:
            with self.subTest(s=s),self.assertRaises(ValueError):module.molecule(s)
        with self.assertRaisesRegex(ValueError,'one reactant'):
            self.generator(edits=[dict(name='two',smarts='[C:1].[O:2]>>[C:1][O:2]')])

    def test_double_bond_stereo_and_enumeration_bound(self):
        with self.assertRaisesRegex(ValueError,'double-bond stereochemistry'):
            self.generator(core='C(=O)O')._enumerate('C/C=C/CC(=O)OC')
        _,options,_=self.generator(core='C/C=C/CC(=O)O')._enumerate('C/C=C/CC(=O)OC')
        self.assertTrue(options)
        gen=self.generator(edits=[dict(name='many',smarts='[CH3:1]>>C[CH2:1]')],core='C',max_products_per_edit=1)
        with self.assertRaisesRegex(ValueError,'Enumeration limit exceeded'):
            gen._enumerate('CCC')


if __name__=='__main__':unittest.main()
