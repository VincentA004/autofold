"""Align explicit protein-residue PAE rows, then capture native ipSAE/pDockQ2.

The caller supplies the predictor's documented token order; shape alone cannot
prove alignment. Keys are (chain ID, observed 1-based sequence position, identity).
This helper supports complete canonical protein chains only, not ligand tokens.
"""
import json
from pathlib import Path
import uuid

import gemmi
import numpy as np


def aligned_structure(structure, pae_residues):
    from proto_tools.entities.structures.structure import BFactorType
    if structure.b_factor_type not in (BFactorType.PLDDT, BFactorType.NORMALIZED_PLDDT):
        raise ValueError('ipSAE/pDockQ2 requires explicit pLDDT B-factor semantics')
    model = (gemmi.read_pdb_string(structure.structure) if structure.structure_format == 'pdb' else
             gemmi.make_structure_from_block(gemmi.cif.read_string(structure.structure).sole_block()))
    if len(model) != 1: raise ValueError('Expected one complete protein model')
    observed=[]
    for chain in model[0]:
        if len(chain.name)!=1: raise ValueError('Remap multi-character chains explicitly before scoring')
        for i,residue in enumerate(chain,1):
            aa=gemmi.find_tabulated_residue(residue.name).one_letter_code
            if aa not in 'ACDEFGHIKLMNPQRSTVWY' or residue.find_atom('CA','*') is None:
                raise ValueError('Only complete canonical protein residue tokens are supported')
            observed.append((chain.name,i,aa))
    keys=[tuple(x) for x in pae_residues]
    if len(set(keys))!=len(keys) or len(set(observed))!=len(observed) or set(keys)!=set(observed):
        raise ValueError('Explicit PAE residue mapping differs from observed protein residues')
    matrix=np.asarray(structure.metrics.get('pae'),dtype=float)
    if matrix.shape!=(len(keys),len(keys)) or not np.isfinite(matrix).all() or (matrix<0).any():
        raise ValueError('PAE dimensions/values do not match the complete explicit residue mapping')
    lookup={k:i for i,k in enumerate(keys)}; order=[lookup[k] for k in observed]
    result=structure.model_copy(deep=True)
    result.metrics['pae']=matrix[np.ix_(order,order)].tolist()
    return result, observed


def score_interface_captured(structure, *, pae_residues, binder_chain, target_chains,
                             capture_dir, config=None, scorer=None):
    from proto_tools import ToolRegistry
    spec=ToolRegistry.get('ipsae-scoring')
    directory=Path(capture_dir)/uuid.uuid4().hex;directory.mkdir(parents=True)
    def save(name,value):
        # Retain nonfinite backend diagnostics before rejecting their use as scores.
        (directory/name).write_text(json.dumps(value,indent=2,allow_nan=True)+'\n')
    save('source.json',{'structure':structure.model_dump(mode='json'),'pae_residues':pae_residues})
    try:
        aligned, order=aligned_structure(structure,pae_residues)
        inputs=spec.input_model(structure=aligned,binder_chain=binder_chain,target_chains=target_chains)
        cfg=spec.config_model(**(config or {}))
        save('request.json',{'input':inputs.model_dump(mode='json'),'config':cfg.model_dump(mode='json'),
                             'coordinate_residue_order':order,'scope':'interface-quality estimates, not affinity'})
        result=(scorer or spec.function)(inputs,cfg)
        save('response.json',result.model_dump(mode='json'))
        values=result.model_dump(mode='json').get('metrics',{})
        if not result.success or any(not isinstance(values.get(key),(float,int)) or
                                     not np.isfinite(values[key]) for key in ('ipsae','pdockq2')):
            raise ValueError('Native interface scoring failed or returned nonfinite/missing measurements')
        return result,directory
    except Exception as error:
        save('error.json',{'type':type(error).__name__,'message':str(error)})
        raise
