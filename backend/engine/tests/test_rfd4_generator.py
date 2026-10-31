"""Native Proto handoff against a fake RFD4 CLI; no weights, GPU or network."""
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

from proto_language.core import Constraint, ConstraintOutput, Construct, Program, Segment, Sequence
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools.entities.structures import Structure

MODULE = Path(__file__).parents[1] / "skills/proto-discovery/scripts/model_generators.py"
if "model_generators" not in sys.modules:
    spec = importlib.util.spec_from_file_location("model_generators", MODULE)
    sys.modules[spec.name] = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sys.modules[spec.name])
bridge = sys.modules["model_generators"]


def cif(target="ALA"):
    lines = [f"ATOM  {i:5d}  CA  {aa} {chain}{1:4d}    {i*4.:8.3f}{0.:8.3f}{0.:8.3f}  1.00 20.00           C  "
             for i, (chain, aa) in enumerate((("A", target), ("G", "GLY")), 1)]
    return Structure(structure="\n".join(lines)+"\nEND\n").structure_cif


class RFD4Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rfd4 test ")
        self.root = Path(self.temp.name)
        self.model = self.root / "bundle"
        self.model.mkdir()
        for name in ("config.json", "model.safetensors"):
            (self.model/name).write_text("fixture")
        self.design = self.root / "design.yaml"
        self.design.write_text("binder: {input: target.cif, contig: '1,/0,A1'}\n")

    def tearDown(self):
        self.temp.cleanup()

    def generator(self, *, target="ALA", fail=False, partial=False, timeout=False):
        cli = self.root / "fake-rfd4"
        cli.write_text(f"#!{sys.executable}\n" +
            "import pathlib,sys,time\n"+
            "args=dict(x.split('=',1) for x in sys.argv[1:] if '=' in x)\n"+
            "out=pathlib.Path(args['out_dir']); out.mkdir(parents=True)\n"+
            "(out/'raw.json').write_text('{}')\n"+
            ("time.sleep(3)\n" if timeout else "")+
            ("sys.exit(7)\n" if fail else
             "count=int(args['num_replicates'])\n"+
             ("count-=1\n" if partial else "")+
             "for i in range(count):\n"+
             " d=out/'inference_samples'/str(i); d.mkdir(parents=True)\n"+
             f" (d/f'example_{{i}}_generated.cif').write_text({cif(target)!r})\n"))
        cli.chmod(0o755)
        return bridge.RFD4BinderGenerator(bridge.RFD4BinderConfig(
            design_spec=str(self.design), binder_chain="G", target_chain="A", target_sequence="A",
            output_dir=str(self.root / "evidence"), model_path=str(self.model),
            executable=str(cli), timeout_seconds=1 if timeout else 10))

    def test_native_selection_preserves_structure_complete_pool_and_command(self):
        generator = self.generator()
        segment = Segment(length=1, sequence_type="protein")
        generator.assign(segment)
        def keep_glycine(inputs, config):
            return [ConstraintOutput(score=0 if s.sequence == "G" else 1) for (s,) in inputs]
        optimizer = RejectionSamplingOptimizer(
            constructs=[Construct([segment])], generators=[generator],
            constraints=[Constraint(inputs=[segment], function=keep_glycine, threshold=0)],
            config=RejectionSamplingOptimizerConfig(num_samples=2, num_results=2, proposal_batch_size=2))
        Program([optimizer], num_results=2, seed=17, compute=nullcontext()).run()
        self.assertEqual(len(segment.result_sequences), 2)
        self.assertTrue(all(s.structure and s.sequence == "G" for s in segment.result_sequences))
        receipt = json.loads((self.root/"evidence/rfd4-call-001/receipt.json").read_text())
        self.assertEqual(receipt["returned_designs"], 2)
        self.assertIsInstance(receipt["seed"], int)
        self.assertIn("num_replicates=2", receipt["command"])
        self.assertIn("~metrics", receipt["command"])
        self.assertTrue((self.root/"evidence/rfd4-call-001/native/raw.json").exists())

    def test_infrastructure_profile_selects_bioir_without_scientific_config_fields(self):
        profile=self.root/'runtime.json'
        profile.write_text(json.dumps({'rfd4':{'backend':'bioir'}}))
        generator=self.generator()
        with patch.dict(bridge.os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(profile)}):
            flags=generator._runtime_overrides()
        self.assertEqual(generator._execution_backend,'bioir')
        self.assertIn('inference_backend=bioir',flags)
        self.assertIn('bioir.match_reference_rng=true',flags)
        self.assertNotIn('backend',type(generator.config).model_fields)
        generator.config.mode='guided_search'
        with patch.dict(bridge.os.environ,{'AUTOFOLD_RUNTIME_PROFILE':str(profile)}):
            with self.assertRaisesRegex(ValueError,'not qualified'):generator._runtime_overrides()

    def test_program_seed_stream_advances_and_is_reproducible(self):
        generator = self.generator()
        generator.assign(Segment(length=1, sequence_type="protein"))
        generator._set_program_seed(99)
        generator.sample(); generator.sample()
        seeds = [json.loads((self.root/f"evidence/rfd4-call-{i:03}/request.json").read_text())["seed"] for i in (1,2)]
        self.assertNotEqual(*seeds)
        generator._set_program_seed(99)
        generator.sample()
        self.assertEqual(seeds[0], json.loads((self.root/"evidence/rfd4-call-003/request.json").read_text())["seed"])

    def test_target_identity_mismatch_preserves_raw_output_and_error(self):
        generator = self.generator(target="VAL")
        generator.assign(Segment(length=1, sequence_type="protein"))
        with self.assertRaisesRegex(ValueError, "target identity"):
            generator.sample()
        receipt = json.loads((self.root/"evidence/rfd4-call-001/receipt.json").read_text())
        self.assertIn("target identity", receipt["error"])
        self.assertTrue((self.root/"evidence/rfd4-call-001/native/inference_samples/0/example_0_generated.cif").exists())

    def test_missing_or_wrong_binder_is_not_replaced_with_target(self):
        for chain, length in (("Z",1),("G",2)):
            with self.subTest(chain=chain,length=length):
                generator = self.generator()
                generator.config.binder_chain = chain
                generator.assign(Segment(length=length, sequence_type="protein"))
                with self.assertRaisesRegex(ValueError, "binder chain/sequence/length"):
                    generator.sample()

    def test_multiple_examples_and_missing_weights_fail_before_dispatch(self):
        generator = self.generator()
        generator.assign(Segment(length=1, sequence_type="protein"))
        self.design.write_text("one: {}\ntwo: {}\n")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            generator.sample()
        self.design.write_text("one: {}\n")
        (self.model/"model.safetensors").unlink()
        with self.assertRaisesRegex(ValueError, "bundle must contain"):
            generator.sample()
        self.assertFalse((self.root/"evidence").exists())

    def test_partial_cli_output_and_failed_process_are_retained(self):
        for mode in ("partial", "fail", "timeout"):
            with self.subTest(mode=mode):
                generator = self.generator(**{mode: True})
                generator.assign(Segment(length=1, sequence_type="protein"))
                with self.assertRaises((ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired)):
                    generator.sample()
                receipts = list((self.root/"evidence").glob("*/receipt.json"))
                self.assertTrue(all("error" in json.loads(p.read_text()) for p in receipts))
                self.assertTrue(all((p.parent/"native/raw.json").is_file() for p in receipts))

    def guided(self):
        generator = self.generator()
        example = MODULE.parents[1]/'examples/rfd4_local_search.yaml'
        path = self.root/'reward.yaml'; path.write_bytes(example.read_bytes())
        generator.config.mode = 'guided_search'; generator.config.search_spec = str(path)
        generator.assign(Segment(length=1,sequence_type='protein'))
        generator.segment.proposal_sequences = [Sequence(sequence='G',sequence_type='protein') for _ in range(2)]
        return generator, path

    def test_guided_native_beams_are_returned_and_scoring_rollouts_are_preserved(self):
        generator, spec = self.guided(); original = spec.read_bytes()
        def native(command, **kwargs):
            self.assertEqual(kwargs['env']['HF_HUB_OFFLINE'],'1')
            self.assertIn('num_replicates=1',command)
            self.assertNotIn('~metrics',command)
            self.assertEqual(command[1], '--config-dir')
            config = Path(command[command.index('--config-dir')+1])
            metrics = yaml.safe_load((config/'metrics/autofold_local.yaml').read_text())
            self.assertTrue(all(metrics[k] is None for k in ['refolding_oracles','refolding_metrics','pre_oracle_filters','pass_criteria']))
            root = Path(next(a.split('=',1)[1] for a in command if a.startswith('out_dir=')))
            for name in ['example_bsfinal_0','example_bsfinal_1','example_bsc0_0','example_bsc0_1','example_bsc1_0']:
                directory=root/'inference_samples'/name;directory.mkdir(parents=True)
                (directory/(name+'_generated.cif')).write_text(cif())
            return subprocess.CompletedProcess(command,0)
        with patch.object(bridge.subprocess,'run',side_effect=native):generator.sample()
        self.assertEqual(len(generator.segment.proposal_sequences),2)
        self.assertTrue(all('_bsfinal_' in s._generator_metadata['rfd4-binder']['artifact'] for s in generator.segment.proposal_sequences))
        directory=self.root/'evidence/rfd4-call-001'
        receipt=json.loads((directory/'receipt.json').read_text())
        self.assertEqual((receipt['mode'],receipt['returned_designs'],receipt['scoring_rollouts']),('guided_search',2,3))
        self.assertEqual(len(json.loads((directory/'outputs.json').read_text())),5)
        self.assertEqual((directory/'search-spec.yaml').read_bytes(),original)
        self.assertEqual(spec.read_bytes(),original)

    def test_local_search_rejects_oracles_unmarked_final_selection_and_incompatible_counts(self):
        generator,path=self.guided();original=yaml.safe_load(path.read_text())
        changes=[
            lambda x:x['metrics'].update(refolding_oracles={'remote':{}}),
            lambda x:x['metrics']['inline_metrics']['interchain_interactions'].update(_target_='remote.Oracle'),
            lambda x:x['search']['checkpoints'].update({'60':x['search']['checkpoints']['40']}),
            lambda x:x['search'].update(save_rollouts=False),
            lambda x:x['search'].update(resume_from='/some/state.pt'),
            lambda x:x['search']['checkpoints']['20'].update(metrics=['missing']),
            lambda x:x['search']['checkpoints']['20'].update(rewards={1:{'weight':1}}),
            lambda x:x['search']['checkpoints']['20'].update(use_clean_prediction='false'),
        ]
        for change in changes:
            value=yaml.safe_load(yaml.safe_dump(original));change(value);path.write_text(yaml.safe_dump(value))
            with self.subTest(value=value),patch.object(bridge.subprocess,'run',side_effect=AssertionError('launched')):
                with self.assertRaises(ValueError):generator.sample()
        path.write_text(yaml.safe_dump(original));generator.segment.proposal_sequences=generator.segment.proposal_sequences[:1]
        with self.assertRaisesRegex(ValueError,'multiple'):generator.sample()
        self.assertFalse((self.root/'evidence').exists())

    def test_search_mode_and_spec_must_agree(self):
        generator,path=self.guided();generator.config.mode='generation'
        with self.assertRaisesRegex(ValueError,'only used'):generator.sample()
        generator.config.mode='guided_search';generator.config.search_spec=None
        with self.assertRaisesRegex(ValueError,'requires'):generator.sample()


if __name__ == "__main__":
    unittest.main()
