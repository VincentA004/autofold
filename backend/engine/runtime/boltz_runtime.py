"""Infrastructure hook behind native Boltz2; scientific callers keep one API."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid


def _write(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')


def predict(config, sp_complex, complex_msas, instance, seed, native_predict):
    profile_path = Path(os.environ['AUTOFOLD_RUNTIME_PROFILE'])
    content = profile_path.read_bytes()
    profile = json.loads(content)
    route = profile['boltz2']
    directory = Path('output/runtime').resolve()/uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=False)
    receipt = {'model':'boltz2', 'backend':route['backend'],
        'profile_sha256':hashlib.sha256(content).hexdigest(),
        'scientific_config':config.model_dump(mode='json'), 'seed':seed,
        'state':'started',
        'runtime_fingerprint':os.environ.get('AUTOFOLD_RUNTIME_FINGERPRINT')}
    _write(directory/'execution.json',receipt)
    _write(directory/'request.json',{'complex':sp_complex.model_dump(mode='json'),
        'msas':complex_msas.model_dump(mode='json') if complex_msas is not None else None})
    started = time.monotonic()
    try:
        if route['backend']=='native':
            result = native_predict(config,sp_complex,complex_msas,instance,seed)
        elif route['backend']=='bioir':
            # These settings have exact counterparts in the verified BioIR bridge.
            # Fail rather than dropping controls or switching numerical procedures.
            if (config.device!='cuda' or config.diffusion_samples!=1 or config.step_scale!=1.5
                    or config.max_msa_seqs!=8192 or config.subsample_msa or not config.include_pae_matrix):
                raise ValueError('Pinned BioIR profile does not support the requested Boltz2 protocol')
            worker_path = Path(__file__).with_name('bioir_boltz.py')
            spec = importlib.util.spec_from_file_location('_autofold_bioir_worker',worker_path)
            worker = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = worker
            spec.loader.exec_module(worker)
            checkpoint = Path(route['checkpoint'])
            with checkpoint.open('rb') as stream:
                observed = hashlib.file_digest(stream,'sha256').hexdigest()
            if observed != route['checkpoint_sha256']:
                raise ValueError('Provisioned BioIR checkpoint differs from pinned weights')
            receipt['checkpoint_sha256'] = observed
            inputs = worker.BioIRBoltzInput(complexes=[sp_complex],
                msas=[complex_msas] if complex_msas is not None else None)
            cfg = worker.BioIRBoltzConfig(**{k:route[k] for k in
                ('python_executable','checkpoint','ccd_path','mol_dir')},
                seed=seed, recycling_steps=config.recycling_steps, sampling_steps=config.sampling_steps,
                timeout=config.timeout or 1200, output_dir=str(directory/'predictions'))
            output = worker.run_bioir_boltz(inputs,cfg)
            if not output.success or len(output.structures)!=1:
                raise ValueError('Infrastructure predictor returned incomplete output')
            result = output.structures[0]
            result.source = 'boltz2-prediction'
        else:
            raise ValueError('Unknown pinned Boltz2 runtime')
        result.metrics['execution_backend'] = route['backend']
        result.metrics['execution_profile_sha256'] = receipt['profile_sha256']
        result.metrics['execution_receipt'] = str(directory/'execution.json')
        (directory/'response.json').write_text(json.dumps(result.model_dump(mode='json'),indent=2)+'\n')
        receipt['state'] = 'completed'
        return result
    except Exception as error:
        receipt.update(state='failed', error={'type':type(error).__name__,'message':str(error)})
        raise
    finally:
        receipt['wall_seconds'] = time.monotonic()-started
        _write(directory/'execution.json',receipt)


def predict_alphafold2(inputs, config, instance, native_predict):
    """AF2 monomer/multimer resolution with explicit scientific model selection."""
    from proto_tools.tools.structure_prediction.shared_data_models import StructurePredictionOutput
    content = Path(os.environ['AUTOFOLD_RUNTIME_PROFILE']).read_bytes()
    route = json.loads(content).get('alphafold2',{'backend':'native'})
    directory = Path('output/runtime').resolve()/uuid.uuid4().hex
    directory.mkdir(parents=True,exist_ok=False)
    receipt = {'model':'alphafold2','backend':route['backend'],'state':'started',
        'profile_sha256':hashlib.sha256(content).hexdigest(),
        'runtime_fingerprint':os.environ.get('AUTOFOLD_RUNTIME_FINGERPRINT'),
        'scientific_config':config.model_dump(mode='json')}
    _write(directory/'request.json',inputs.model_dump(mode='json'))
    started = time.monotonic()
    try:
        if route['backend']=='native':
            output = native_predict(inputs,config,instance)
            if output.success is None:output.success = True
        else:
            if config.device!='cuda' or config.num_ensemble_models!=1 or not config.include_pae_matrix:
                raise ValueError('BioIR AF2 requires CUDA, one selected parameter set, and full PAE')
            spec = importlib.util.spec_from_file_location('_autofold_bioir_worker',Path(__file__).with_name('bioir_boltz.py'))
            worker = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = worker
            spec.loader.exec_module(worker)
            structures = []
            receipt['models'] = []
            for i,comp in enumerate(inputs.complexes):
                key = f'alphafold2_{"multimer_" if len(comp.chains)>1 else ""}{config.model_num}'
                asset = route['checkpoints'].get(key)
                if asset is None:raise ValueError(f'No converted local weights provisioned for {key}')
                with Path(asset['checkpoint']).open('rb') as stream:
                    observed = hashlib.file_digest(stream,'sha256').hexdigest()
                if observed!=asset['checkpoint_sha256']:raise ValueError('AF2 weights differ from pinned conversion')
                seed = (config.seed if config.seed is not None else config.get_random_int())+i
                cfg = worker.BioIRBoltzConfig(model_key=key,python_executable=route['python_executable'],
                    checkpoint=asset['checkpoint'],
                    output_dir=str(directory/'predictions'),seed=seed,recycling_steps=config.num_recycles+1,
                    timeout=config.timeout or 1200)
                request = worker.BioIRAF2Input(complexes=[comp],msas=[inputs.msas[i]] if inputs.msas else None)
                result = worker.run_bioir_boltz(request,cfg)
                if not result.success or len(result.structures)!=1:raise ValueError('Incomplete BioIR AF2 output')
                structure = result.structures[0]
                structure.source = 'alphafold2-prediction'
                structures.append(structure)
                receipt['models'].append({'key':key,'seed':seed,'checkpoint_sha256':observed,
                    'recycles':config.num_recycles,'total_forward_passes':config.num_recycles+1})
            output = StructurePredictionOutput(success=True,structures=structures)
        for structure in output.structures:
            structure.metrics['execution_backend'] = route['backend']
            structure.metrics['execution_profile_sha256'] = receipt['profile_sha256']
            structure.metrics['execution_receipt'] = str(directory/'execution.json')
        (directory/'response.json').write_text(json.dumps(output.model_dump(mode='json'),indent=2)+'\n')
        receipt['state'] = 'completed'
        return output
    except Exception as error:
        receipt.update(state='failed',error={'type':type(error).__name__,'message':str(error)})
        raise
    finally:
        receipt['wall_seconds'] = time.monotonic()-started
        _write(directory/'execution.json',receipt)
