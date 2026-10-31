"""Infrastructure-only BioIR prediction worker for provisioned Boltz2/AF2 weights.

No model imports at registration. The installed BioIR worker captures its complete
postprocessed output before the writer rounds scores or renames source chains.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid


def _write(path, value):
    def encode(item):
        if hasattr(item, 'tolist'):
            return item.tolist()
        raise TypeError(f'Cannot capture {type(item).__name__}')
    # Keep nonfinite native values for diagnosis; normalization rejects them.
    Path(path).write_text(json.dumps(value, indent=2, default=encode) + '\n')


def normalize_prediction(raw, cif, chains, *, plddt_scale=1.0):
    """Map explicit source asym/residue indices to requested chain/sequence keys."""
    import gemmi
    import numpy as np

    expected = [(i, p) for i, chain in enumerate(chains)
                for p in range(1, len(chain['sequence']) + 1)]
    keys = list(zip(raw['chain_indices'], raw['residue_indices'], strict=True))
    if len(set(keys)) != len(keys) or set(keys) != set(expected):
        raise ValueError('Native residue mapping does not cover the exact request')
    lookup = {key: i for i, key in enumerate(keys)}
    order = [lookup[key] for key in expected]
    n = len(expected)
    pae = np.asarray(raw['pae'], dtype=float)
    native_plddt = np.asarray(raw['plddt'], dtype=float)
    plddt = native_plddt / plddt_scale
    if pae.shape != (n, n) or not np.isfinite(pae).all() or (pae < 0).any():
        raise ValueError('Expected complete finite nonnegative residue PAE')
    if plddt.shape != (n,) or not np.isfinite(plddt).all() or ((plddt < 0) | (plddt > 1)).any():
        raise ValueError('BioIR pLDDT is outside the declared native scale')
    source = gemmi.make_structure_from_block(gemmi.cif.read_string(cif).sole_block())
    if len(source) != 1 or len(source[0]) != len(chains):
        raise ValueError('Expected exactly one model and every requested chain')
    # BioIR 0.2.0 CIFWriter labels source asym indices 0..25 as A..Z.
    source_ids = [chr(65+i) for i in range(len(chains))]
    if {c.name for c in source[0]} != set(source_ids):
        raise ValueError('Unexpected BioIR source chain IDs')
    model = gemmi.Model('1')
    token_map = []
    for i, requested in enumerate(chains):
        chain = source[0][source_ids[i]].clone()
        positions = [r.seqid.num for r in chain]
        sequence = ''.join(gemmi.find_tabulated_residue(r.name).one_letter_code for r in chain)
        if positions != list(range(1, len(requested['sequence'])+1)) or sequence != requested['sequence']:
            raise ValueError('Coordinates differ from requested source chain sequence/positions')
        chain.name = requested['id']
        for residue in chain:
            idx = lookup[(i, residue.seqid.num)]
            if (raw.get('residue_names') is not None and raw['residue_names'][idx] != residue.name) or residue.seqid.icode.strip():
                raise ValueError('Native tokens and coordinates disagree')
            if 'CA' not in residue:
                raise ValueError('Missing protein CA atom')
            for atom in residue:
                if not all(np.isfinite([atom.pos.x, atom.pos.y, atom.pos.z])):
                    raise ValueError('Nonfinite coordinates')
                if not np.isfinite(atom.b_iso) or abs(atom.b_iso-native_plddt[idx]) > .011:
                    raise ValueError('Native coordinate B-factors disagree with normalized pLDDT')
                atom.b_iso = float(plddt[idx]*100)
            token_map.append({'chain': chain.name, 'position': residue.seqid.num,
                              'identity': requested['sequence'][residue.seqid.num-1],
                              'source_chain_index': i, 'source_token_index': idx})
        model.add_chain(chain)
    normalized = gemmi.Structure()
    normalized.add_model(model)
    normalized.setup_entities()
    metrics = {'ptm': float(raw['ptm']),
               'avg_pae': float(pae.mean()), 'pae': pae[np.ix_(order, order)].tolist()}
    if len(chains)>1 or np.isfinite(raw.get('iptm', float('nan'))):
        metrics['iptm'] = float(raw['iptm'])
    metrics['avg_plddt'] = float(plddt.mean())
    for key in ('complex_plddt', 'complex_iplddt', 'complex_pde', 'complex_ipde', 'protein_iptm', 'ligand_iptm'):
        if key in raw:
            metrics[key] = float(raw[key])
    if not all(np.isfinite(value) for value in metrics.values() if isinstance(value, float)):
        raise ValueError('Nonfinite confidence metrics')
    metrics['confidence_score'] = metrics['iptm'] if len(chains)>1 else metrics['ptm']
    return normalized.make_mmcif_document().as_string(), metrics, token_map


def _worker(request_path, result_path):
    from importlib.metadata import version
    if version('bionemo-ir') != '0.2.0':
        raise ValueError('This compatibility adapter requires bionemo-ir==0.2.0')
    from bionemo_ir.data.schemas import InputRequest, MSARecord, Polymer
    from bionemo_ir.registry import ModelRegistry
    from bionemo_ir.pipeline.processor.engine_proc import EngineProcessorConfig, build_processor
    from bionemo_ir.pipeline.stages.configs import FeatureGeneratorStageConfig, WriterStageConfig
    from bionemo_ir.pipeline.stages.writer_stage import WriterUDF

    request = json.loads(Path(request_path).read_text())
    directory = Path(result_path).parent
    class EvidenceWriter(WriterUDF):
        async def udf_for_item(self, row):
            _write(directory/(row['__record_id']+'-raw.json'), row)
            return await super().udf_for_item(row)

    model_key = request.get('model_key','boltz-2')
    af2 = model_key.startswith('alphafold2')
    cfg = ModelRegistry.get_factory(model_key).get_model_class().get_pretrained_config(model_key)
    cfg.disable_cuda_graphs()
    if af2:
        cfg.max_recycling_iters = request['recycling_steps']-1
        # Native Proto uses the pTM monomer weights. BioIR's named AF2 monomer
        # preset defaults to the older no-pTM head; enable the requested head.
        cfg.confidence_module.tm.enabled = True
        cfg.recycle_early_stop_tolerance = 0.0
        from bionemo_ir.pipeline.models.openfold2.postprocessor import PostProcessor
        class FullPAE(PostProcessor):
            def __call__(self,batch,output):
                result = super().__call__(batch,output)
                if 'predicted_aligned_error' in output:
                    result['pae'] = output['predicted_aligned_error'].detach().cpu().numpy()
                return result
        # Local to this isolated worker; preserve PAE before upstream rounding.
        ModelRegistry.get_factory(model_key).get_postprocessor = classmethod(lambda cls:FullPAE)
    runtime_args = {'recycling_steps':request['recycling_steps']}
    if not af2:
        runtime_args.update(num_sampling_steps=request['sampling_steps'],diffusion_samples=1,sampling_seed=request['seed'])
    config = EngineProcessorConfig(
        model_source=model_key, executor_backend=None, compact_confidence=False,
        metadata=request['metadata'], should_continue_on_error=False,
        runtime_args=runtime_args,
        feature_generator_stage=FeatureGeneratorStageConfig(init_context={'random_seed':request['seed']}),
        writer_stage=WriterStageConfig(output_path=str(directory/'native'), format='cif'),
        engine_kwargs={'config':cfg, 'profile_inference':True})
    _write(directory/'runtime.json', {'bionemo_ir':version('bionemo-ir'),
        'torch':version('torch'), 'config':config.model_dump(mode='json'),
        'checkpoint':request['checkpoint'], 'checkpoint_sha256':request['checkpoint_sha256']})
    processor = build_processor(config)
    writers = [stage for stage in processor.stages.values() if stage.fn is WriterUDF]
    if len(writers)!=1:
        raise ValueError('BioIR writer API changed; cannot guarantee complete output capture')
    writers[0].fn = EvidenceWriter
    records = []
    for i, chains in enumerate(request['complexes']):
        record_id = f'prediction-{i}'
        record = InputRequest(input_id=record_id, polymers=[
            Polymer(chain_id=[c['id']], sequence=c['sequence'],
                    msas=[MSARecord(content=c['a3m'])],
                    paired_msas=[MSARecord(content=c['paired_a3m'])] if c.get('paired_a3m') else None) for c in chains])
        records.append({'record':record, '__record_id':record_id})
    rows = processor(records)
    _write(directory/'native-response.json', rows)
    if len(rows)!=len(records) or any(not r.get('output_path') for r in rows):
        raise ValueError('BioIR returned incomplete predictions')
    _write(result_path, {'record_ids':[r['__record_id'] for r in rows]})


if __name__ == '__main__':
    _worker(*sys.argv[1:])
    sys.exit(0)


from typing import ClassVar, Literal
from pydantic import model_validator
from proto_tools.entities.structures import BFactorType, Structure
from proto_tools.tools.structure_prediction.shared_data_models import (
    StructurePredictionInput, StructurePredictionOutput, StructurePredictionConfig)
from proto_tools.utils import ConfigField


class BioIRBoltzInput(StructurePredictionInput):
    SUPPORTED_ENTITY_TYPES: ClassVar[set[str]] = {'protein'}
    ALLOWS_CHAIN_MODIFICATIONS = False
    ALLOW_PAIRED: ClassVar[bool] = False

    @model_validator(mode='after')
    def supported(self):
        for comp in self.complexes:
            if not 1 <= len(comp.chains) <= 26:
                raise ValueError('BioIR adapter supports 1–26 explicit protein chains')
            for chain in comp.chains:
                if not chain.id or set(chain.sequence)-set('ACDEFGHIKLMNPQRSTVWY'):
                    raise ValueError('Expected explicit chain IDs and canonical protein residues')
        if self.msas is not None:
            from proto_tools.tools.structure_prediction.shared_data_models import _validate_complex_msas_match_chains
            _validate_complex_msas_match_chains(self.complexes, self.msas)
            if not self.ALLOW_PAIRED and any(msa.paired or msa.unpaired_per_chain for msa in self.msas):
                raise ValueError('Paired MSAs are not supported by this BioIR adapter')
        return self


class BioIRAF2Input(BioIRBoltzInput):
    ALLOW_PAIRED: ClassVar[bool] = True


class BioIRBoltzConfig(StructurePredictionConfig):
    model_key: str = ConfigField(default='boltz-2', title='Internal model key', description='Infrastructure-selected BioIR checkpoint family')
    device: Literal['cuda'] = ConfigField(default='cuda', title='Device', description='Local CUDA GPU')
    use_msa: Literal[False] = ConfigField(default=False, title='MSA search', description='No search; caller-supplied unpaired MSAs are always used')
    include_pae_matrix: Literal[True] = ConfigField(default=True, title='Full PAE', description='Always capture complete finite residue PAE')
    diffusion_samples: Literal[1] = ConfigField(default=1, title='Samples per complex', description='One sample; repeat explicit seeds to retain all predictions')
    python_executable: str = ConfigField(default_factory=lambda:os.environ.get('AUTOFOLD_BIOIR_PYTHON',''), title='Installed runtime', description='Absolute Python in bionemo-ir==0.2.0 environment; no installation fallback')
    checkpoint: str = ConfigField(default_factory=lambda:os.environ.get('BOLTZ2_CKPT',''), title='Checkpoint', description='Existing local boltz2_conf.ckpt')
    ccd_path: str = ConfigField(default_factory=lambda:os.environ.get('BOLTZ_CCD_PATH',''), title='CCD', description='Existing local CCD pickle')
    mol_dir: str = ConfigField(default_factory=lambda:os.environ.get('BOLTZ_MOL_DIR',''), title='Molecules', description='Existing local Boltz molecule directory')
    output_dir: str = ConfigField(title='Evidence directory', description='Persistent trial output directory; unique subdirectory per call')
    recycling_steps: int = ConfigField(default=3, ge=0, title='Recycles', description='Model recycling steps')
    sampling_steps: int = ConfigField(default=200, ge=1, title='Denoising steps', description='Diffusion steps')
    timeout: int = ConfigField(default=600, ge=1, title='Timeout', description='Whole batch wall time including startup')


def run_bioir_boltz(inputs: BioIRBoltzInput, config: BioIRBoltzConfig, instance=None):
    import hashlib
    af2 = config.model_key.startswith('alphafold2')
    names = ('python_executable','checkpoint') if af2 else ('python_executable','checkpoint','ccd_path','mol_dir')
    assets = {name:Path(getattr(config,name)) for name in names}
    for name,path in assets.items():
        if not path.is_absolute() or not (path.is_dir() if name=='mol_dir' else path.is_file()):
            raise ValueError(f'Configure existing absolute local {name}; no installation/API fallback')
    directory = Path(config.output_dir).resolve()/uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=False)
    complexes = []
    for index,comp in enumerate(inputs.complexes):
        group = inputs.msas[index] if inputs.msas is not None else None
        msas = (group.unpaired_per_chain or {}) if group and group.paired else group.per_chain if group else {}
        chains = [{'id':c.id, 'sequence':c.sequence,
            'a3m':msas[i].to_a3m_string() if i in msas else f'>query\n{c.sequence}\n'}
            for i,c in enumerate(comp.chains)]
        if group and group.paired:
            for i,c in enumerate(chains):
                if i in group.per_chain:c['paired_a3m'] = group.per_chain[i].to_a3m_string()
        complexes.append(chains)
    with assets['checkpoint'].open('rb') as stream:
        checkpoint_hash = hashlib.file_digest(stream,'sha256').hexdigest()
    request = {'complexes':complexes, 'model_key':config.model_key,
        'seed':config.seed if config.seed is not None else config.get_random_int(),
        'recycling_steps':config.recycling_steps, 'sampling_steps':config.sampling_steps,
        'metadata':{} if af2 else {'ccd_path':str(assets['ccd_path']), 'mol_dir':str(assets['mol_dir'])},
        'checkpoint':str(assets['checkpoint']), 'checkpoint_sha256':checkpoint_hash}
    _write(directory/'request.json',request)
    command = [str(assets['python_executable']),str(Path(__file__).resolve()),str(directory/'request.json'),str(directory/'result.json')]
    _write(directory/'command.json',{'command':command,'timeout':config.timeout})
    process = None
    try:
        with (directory/'stdout.log').open('w') as out, (directory/'stderr.log').open('w') as err:
            checkpoint_env = 'BOLTZ2_CKPT' if config.model_key=='boltz-2' else config.model_key.upper()+'_CKPT'
            metadata_env = {} if af2 else {'BOLTZ_CCD_PATH':str(assets['ccd_path']),'BOLTZ_MOL_DIR':str(assets['mol_dir'])}
            process = subprocess.Popen(command,stdout=out,stderr=err,start_new_session=True,env={**os.environ,
                **metadata_env, checkpoint_env:str(assets['checkpoint']), 'HF_HUB_OFFLINE':'1',
                'TRANSFORMERS_OFFLINE':'1', 'HF_HUB_DISABLE_TELEMETRY':'1'})
            process.wait(timeout=config.timeout)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode,command)
        ids = json.loads((directory/'result.json').read_text())['record_ids']
        if len(ids)!=len(complexes) or set(ids)!={f'prediction-{i}' for i in range(len(complexes))}:
            raise ValueError('Missing, duplicate or unexpected prediction records')
        structures = []
        for i,chains in enumerate(complexes):
            rid = f'prediction-{i}'
            raw = json.loads((directory/(rid+'-raw.json')).read_text())
            cif,metrics,mapping = normalize_prediction(raw,(directory/'native'/(rid+'.cif')).read_text(),chains,
                plddt_scale=100.0 if config.model_key.startswith('alphafold2') else 1.0)
            _write(directory/(rid+'-mapping.json'),mapping)
            (directory/(rid+'.cif')).write_text(cif)
            metrics.update({'bioir_capture_dir':str(directory), 'bioir_runtime':'0.2.0'})
            structures.append(Structure(structure=cif,b_factor_type=BFactorType.PLDDT,
                metrics=metrics,source='alphafold2-bioir-prediction' if config.model_key.startswith('alphafold2') else 'boltz2-bioir-prediction'))
        result = StructurePredictionOutput(success=True, structures=structures)
        _write(directory/'response.json',result.model_dump(mode='json'))
        return result
    except Exception as error:
        if process is not None and process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL)
                process.wait()
        _write(directory/'error.json',{'type':type(error).__name__,'message':str(error)})
        error.add_note(f'Capture directory: {directory}')
        raise

