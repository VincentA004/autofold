"""Exercise the real native worker environment builder; no GPU/model downloads."""
import os
import logging
from contextlib import nullcontext
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import proto_tools
import numpy as np
from proto_tools.utils.persistent_worker import _build_subprocess_env, _parse_env_vars_file


class OfflineESMFoldEnvironmentTests(unittest.TestCase):
    def test_asset_paths_survive_native_filter_and_offline_flags_override_parent(self):
        profile=Path(__file__).resolve().parents[1]/'runtime/esmfold2/env_vars.txt'
        variables=_parse_env_vars_file(profile)
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{
            'AUTOFOLD_ESMFOLD2_FAST_MODEL':'/local/fast','AUTOFOLD_ESMFOLD2_MODEL':'/local/full',
            'ESMCFOLD_CCD_PATH':'/local/ccd.pkl','HF_HUB_OFFLINE':'0','TRANSFORMERS_OFFLINE':'0'}):
            actual=_build_subprocess_env('cpu',tool_env_path=Path(directory),tool_env_vars=variables)
        self.assertEqual(actual['AUTOFOLD_ESMFOLD2_FAST_MODEL'],'/local/fast')
        self.assertEqual(actual['AUTOFOLD_ESMFOLD2_MODEL'],'/local/full')
        self.assertEqual(actual['ESMCFOLD_CCD_PATH'],'/local/ccd.pkl')
        self.assertEqual(actual['HF_HUB_OFFLINE'],'1')
        self.assertEqual(actual['TRANSFORMERS_OFFLINE'],'1')
        self.assertEqual(actual['AWS_EC2_METADATA_DISABLED'],'true')


class LocalESMWorkerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name)
        relative = Path('proto-tools/proto_tools/tools/structure_prediction/esmfold2/standalone/inference.py')
        destination = root/relative
        destination.parent.mkdir(parents=True)
        source = Path(proto_tools.__file__).parent/'tools/structure_prediction/esmfold2/standalone/inference.py'
        shutil.copyfile(source, destination)
        if 'Local ESMFold2 capture requires diffusion_samples=1' not in source.read_text():
            artifact = Path(__file__).resolve().parents[1]/'patches/esmfold2-official-local.patch'
            subprocess.run(['patch', '-p1', '-i', str(artifact)], cwd=root,
                           check=True, capture_output=True, text=True)
        helpers = ModuleType('standalone_helpers')
        helpers.get_logger = logging.getLogger
        helpers.get_random_int = lambda: 1
        helpers.release_cuda_memory = MagicMock()
        helpers.serialize_output = lambda value: value
        helpers.set_torch_seed = MagicMock()
        # Exercise the patched worker's boundary without installing Torch/weights
        # into the CPU-only test interpreter. Real inference is a captured GPU run.
        torch = ModuleType('torch')
        torch.cuda = SimpleNamespace(OutOfMemoryError=type('FixtureOOM', (RuntimeError,), {}))
        torch.bfloat16 = 'bfloat16'
        torch.autocast = lambda *args, **kwargs: nullcontext()
        cls.torch = torch
        helpers.is_cuda_oom = lambda error: isinstance(error, torch.cuda.OutOfMemoryError)
        cls.worker = {'__name__': 'tested_esm_worker'}
        with patch.dict(sys.modules, {'standalone_helpers': helpers, 'torch':torch}):
            exec(compile(destination.read_text(), str(destination), 'exec'), cls.worker)
        cls.helpers = helpers

    def model(self):
        model = self.worker['ESMFold2Model']('esmfold2-fast')
        model._loaded = True
        model.device = 'cpu'
        model.model = object()
        model.builder = SimpleNamespace(fold=MagicMock())
        return model

    def arguments(self):
        return dict(chains=[{'id':'B'},{'id':'T'}], msas=None, msas_paired=False,
                    unpaired_msas=None, num_loops=3, num_sampling_steps=50,
                    diffusion_samples=1, step_scale=None, noise_scale=None,
                    max_inference_sigma=None, early_exit=False,
                    include_pae_matrix=True, device='cpu', verbose=False, seed=123)

    def test_unsupported_sample_reduction_and_early_exit_fail_before_loading(self):
        for key, value in [('diffusion_samples', 2), ('early_exit', True)]:
            model = self.worker['ESMFold2Model']('esmfold2-fast')
            args = self.arguments(); args[key] = value
            with patch.object(model, 'load') as load, self.assertRaises(ValueError):
                model(**args)
            load.assert_not_called()

    def test_oom_never_retries_with_a_different_sampling_schedule(self):
        model = self.model()
        model.builder.fold.side_effect = self.torch.cuda.OutOfMemoryError('fixture')
        with patch.dict(self.worker, {'_build_upstream_input': lambda *args: 'input'}):
            with self.assertRaises(self.torch.cuda.OutOfMemoryError):
                model(**self.arguments())
        self.assertEqual(model.builder.fold.call_count, 1)
        self.assertEqual(model.builder.fold.call_args.kwargs['num_sampling_steps'], 50)

    def test_complete_pae_and_requested_settings_survive_native_worker(self):
        model = self.model()
        model.builder.fold.return_value = SimpleNamespace(
            complex=SimpleNamespace(to_mmcif=lambda: 'fixture-cif'),
            plddt=np.array([0.8,0.9]), ptm=0.7, iptm=0.6,
            pae=np.array([[0.,2.],[4.,0.]]))
        with patch.dict(self.worker, {'_build_upstream_input': lambda *args: 'input'}):
            result = model(**self.arguments())
        self.assertEqual(result['metrics']['pae'], [[0.,2.],[4.,0.]])
        config = model.builder.fold.call_args.kwargs
        self.assertEqual((config['num_loops'],config['num_sampling_steps'],
                          config['num_diffusion_samples'],config['seed']), (3,50,1,123))


if __name__=='__main__':unittest.main()
