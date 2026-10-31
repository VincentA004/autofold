"""Native Proto bridge to the independently installed Complexa generate stage.

The scientist supplies a fully composed/resolved native Hydra configuration.
No second pipeline, remote inference, model installation or implicit assessment.
"""
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess

import gemmi
import yaml
from proto_language.core import Generator, GeneratorInputType, Sequence
from proto_language.generator.generator_registry import generator
from proto_language.utils.base import BaseConfig, ConfigField
from proto_tools import Structure


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def normalize_output(path):
    """Keep raw output, but do not turn native author-number gaps into residues."""
    model=gemmi.read_pdb(str(path))
    if len(model)!=1: raise ValueError('Complexa output must contain one model')
    chains={};mapping=[]
    for chain in model[0]:
        if chain.name in chains: raise ValueError('Duplicate native chain ID')
        sequence=''
        for i,residue in enumerate(chain,1):
            info=gemmi.find_tabulated_residue(residue.name)
            if not info.is_amino_acid() or info.one_letter_code not in 'ACDEFGHIKLMNPQRSTVWY':
                raise ValueError('Unsupported native output chemistry')
            sequence+=info.one_letter_code
            mapping.append({'chain':chain.name,'position':i,'native_author':str(residue.seqid)})
            residue.seqid=gemmi.SeqId(i,' ');residue.label_seq=i;residue.subchain=chain.name
        chains[chain.name]=sequence
    model.setup_entities()
    return Structure(structure=model.make_mmcif_document().as_string()),chains,mapping


class ComplexaBinderConfig(BaseConfig):
    design_spec: str = ConfigField(title="Native resolved configuration", description="Fully composed native Complexa YAML, without defaults/interpolations; absolute captured target/checkpoint paths. Dataset/search must yield exactly the Proto proposal count.")
    binder_chain: str = ConfigField(title="Binder chain", description="Exact native output binder chain; never inferred from length")
    target_chain: str = ConfigField(title="Target chain", description="Exact native output target chain")
    target_sequence: str = ConfigField(title="Target identity", description="Complete canonical target sequence; checked in every final output")
    output_dir: str = ConfigField(title="Evidence directory", description="Persistent trial output; every invocation creates a new capture")
    repo_dir: str = ConfigField(default_factory=lambda: os.environ.get("AUTOFOLD_COMPLEXA_REPO", ""), title="Pinned installed checkout", description="Native configs/source location; no install on import or call")
    python_executable: str = ConfigField(default_factory=lambda: os.environ.get("AUTOFOLD_COMPLEXA_PYTHON", ""), title="Isolated interpreter", description="Absolute installed Complexa Python interpreter; calls the native generate module directly, without the multi-stage CLI wrapper")
    timeout_seconds: int = ConfigField(default=1200, ge=1, title="Timeout", description="Bound by the enclosing trial/campaign budget")


@generator(key="complexa-binder", label="Proteina-Complexa protein binder design",
           config=ComplexaBinderConfig, uses_gpu=True, tools_called=[], supported_sequence_types=["protein"],
           description="Joint protein binder sequence/all-atom generation using native Complexa generate only. Authored native configuration owns search/refinement/rewards. Returns final samples, preserves lookaheads and unrefined controls. Requires an independently installed local runtime.")
class ComplexaBinderGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_empty_starting_sequence = True

    def __init__(self, config):
        super().__init__(); self.config = config

    def _preserve_structure_after_sample(self): return True

    def _sample(self):
        cfg = self.config
        source = Path(cfg.design_spec).resolve(strict=True)
        document = yaml.safe_load(source.read_text())
        if not isinstance(document, dict) or 'defaults' in document or '${' in source.read_text():
            raise ValueError("Supply a fully composed/resolved native configuration, without Hydra defaults")
        if not cfg.repo_dir or not Path(cfg.repo_dir).is_dir():
            raise ValueError("Select an existing pinned Complexa checkout")
        if not cfg.python_executable or not Path(cfg.python_executable).is_absolute() or not Path(cfg.python_executable).is_file():
            raise ValueError("Select an absolute isolated Complexa Python interpreter")
        if cfg.binder_chain == cfg.target_chain or not cfg.target_sequence or set(cfg.target_sequence)-set('ACDEFGHIKLMNPQRSTVWY'):
            raise ValueError("Declare distinct output chains and a complete canonical target")
        checkpoint = Path(document['ckpt_path']) / document['ckpt_name']
        ae = Path(document['autoencoder_ckpt_path'])
        if not checkpoint.is_absolute() or not checkpoint.is_file() or not ae.is_absolute() or not ae.is_file():
            raise ValueError("Select existing absolute native checkpoint and autoencoder paths")
        features=document['generation']['dataloader']['dataset'].get('conditional_features',[])
        for feature in features:
            if str(feature.get('_target_','')).endswith('.TargetFeatures'):
                if not isinstance(feature.get('target_hotspots'),list):
                    raise ValueError("Native protein checkpoint requires target_hotspots as a list; use [] for no hotspot preference")
        root = Path(cfg.output_dir).resolve();root.mkdir(parents=True,exist_ok=True)
        n=1
        while (root/f'complexa-call-{n:03}').exists(): n+=1
        capture=root/f'complexa-call-{n:03}';capture.mkdir()
        (capture/'authored.yaml').write_bytes(source.read_bytes())
        # Preserve the authored policy, with explicit single-device execution and
        # a fresh output root. Do not silently change its dataset/search budget.
        document.update(root_path=str(capture/'native'),gen_njobs=1,job_id=0)
        document.setdefault('hydra',{}).setdefault('run',{})['dir']=str(capture/'hydra')
        document['generation']['dataloader']['batch_size']=1
        document['generation']['search']['max_batch_size']=1
        seed=self._next_seed()
        if seed is None: raise ValueError("Complexa requires an explicit Program seed")
        document['seed']=seed
        effective=capture/'effective.yaml';effective.write_text(yaml.safe_dump(document))
        command=[cfg.python_executable,'-m','proteinfoundation.generate',
                 '--config-path',str(capture),'--config-name',effective.stem]
        receipt={'command':command,'seed':seed,'requested_designs':self.segment.num_proposals,
                 'checkpoints':{str(p):file_hash(p) for p in [checkpoint,ae]},
                 'config_sha256':hashlib.sha256(effective.read_bytes()).hexdigest(),
                 'geometry_role':'generated; native rewards are not independent binding evidence'}
        (capture/'request.json').write_text(json.dumps(receipt,indent=2)+'\n')
        try:
            with (capture/'stdout.log').open('w') as out,(capture/'stderr.log').open('w') as err:
                subprocess.run(command,cwd=cfg.repo_dir,stdout=out,stderr=err,check=True,timeout=cfg.timeout_seconds,
                    env={**os.environ,'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','WANDB_MODE':'disabled'})
            tables=list((capture/'native').glob('rewards_*.csv'))
            if len(tables)!=1: raise ValueError("Expected exactly one native per-sample reward table")
            with tables[0].open() as table:
                rows=list(csv.DictReader(table))
            inventory=[];proposals=[];seen=set()
            for row in rows:
                path=Path(row['pdb_path']).resolve(strict=True)
                if not path.is_relative_to(capture/'native'): raise ValueError("Native sample escapes this invocation capture")
                if path in seen: raise ValueError("Duplicate sample path in native output table")
                seen.add(path)
                role=row.get('sample_type')
                if role not in ('final','lookahead','final_unrefined'):
                    raise ValueError("Native sample lacks an explicit recognized final/lookahead role")
                inventory.append({'path':str(path.relative_to(capture)),'role':role,
                                  'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
                if role!='final': continue
                structure,chains,mapping=normalize_output(path)
                sequence=chains.get(cfg.binder_chain,'')
                if chains.get(cfg.target_chain)!=cfg.target_sequence: raise ValueError("Complexa target identity mismatch")
                if len(sequence)!=self.segment.sequence_length or set(sequence)-set('ACDEFGHIKLMNPQRSTVWY'):
                    raise ValueError("Complexa binder chain/sequence/length mismatch")
                normalized=capture/f'normalized-{len(proposals):03}.cif'
                normalized.write_text(structure.structure)
                normalized.with_suffix('.mapping.json').write_text(json.dumps(mapping,indent=2)+'\n')
                proposal=Sequence(sequence=sequence,sequence_type='protein',structure=structure)
                proposal._generator_metadata[self._spec.key]={'artifact':str(path),'request':str(capture/'request.json'),
                    'normalized_artifact':str(normalized),'numbering_map':str(normalized.with_suffix('.mapping.json')),
                    'binder_chain':cfg.binder_chain,'target_chain':cfg.target_chain,'seed':seed,'geometry_role':'generated'}
                proposals.append(proposal)
            (capture/'outputs.json').write_text(json.dumps(inventory,indent=2)+'\n')
            if len(proposals)!=self.segment.num_proposals: raise ValueError(f"Expected {self.segment.num_proposals} final designs; got {len(proposals)}")
            self.segment.proposal_sequences=proposals;receipt['returned_designs']=len(proposals)
        except Exception as error:
            receipt['error']=str(error);raise
        finally:
            (capture/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
