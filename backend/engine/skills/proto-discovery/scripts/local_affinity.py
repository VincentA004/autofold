"""Local PRODIGY assessment, callable from native Proto constraints.

Capture this file with the Program. The CPU worker uses an explicitly installed
interpreter; importing the registry extension loads no models or remote services.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import uuid


def _write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def _worker(request_path, result_path):
    from importlib.metadata import version
    from Bio.PDB import MMCIFParser, PDBParser
    from Bio.PDB.Polypeptide import is_aa
    from prodigy_prot.modules.prodigy import Prodigy

    request = json.loads(Path(request_path).read_text())
    parser = MMCIFParser(QUIET=True) if request['format']=='cif' else PDBParser(QUIET=True)
    structure = parser.get_structure('complex', request['coordinates'])
    if len(structure)!=1:
        raise ValueError('Select exactly one structural model before scoring')
    model = structure[0]
    groups = request['target_chains'], request['binder_chains']
    selected = [chain for group in groups for chain in group]
    if any(not group for group in groups) or len(selected)!=len(set(selected)):
        raise ValueError('Specify two nonempty, disjoint chain groups')
    if set(selected)!={chain.id for chain in model}:
        raise ValueError('Chain groups must cover the exact complex; prepare other partners explicitly')
    for chain in model:
        if not len(chain) or any(not is_aa(r, standard=True) for r in chain):
            raise ValueError('This scorer supports canonical protein-only structures; prepare other chemistry explicitly')
        if any(not all(atom in r for atom in ['N','CA','C','O']) for r in chain):
            raise ValueError('Missing backbone atoms; affinity estimate would be inapplicable')
    predictor = Prodigy(model, selection=[','.join(group) for group in groups], temp=request['temperature_celsius'])
    predictor.predict(distance_cutoff=5.5, acc_threshold=0.05)
    if not predictor.ic_network:
        raise ValueError('No inter-partner contacts; cannot assess this pose with PRODIGY')
    result = {'prodigy_delta_g_kcal_mol': float(predictor.ba_val),
              'prodigy_kd_molar': float(predictor.kd_val),
              'contacts_5_5A': len(predictor.ic_network),
              'features': {'contact_bins': predictor.bins, 'nis_apolar': float(predictor.nis_a),
                           'nis_charged': float(predictor.nis_c)},
              'version': version('prodigy-prot'),
              'temperature_celsius': request['temperature_celsius'],
              'meaning': 'Contact/NIS regression estimate conditional on this supplied pose; not measured affinity or proof of binding.'}
    if not all(math.isfinite(result[k]) for k in ['prodigy_delta_g_kcal_mol','prodigy_kd_molar']) or result['prodigy_kd_molar']<=0:
        raise ValueError('Nonfinite or nonpositive native affinity result')
    _write(result_path, result)


if __name__=='__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Installed local PRODIGY CPU worker; no network')
    parser.add_argument('request')
    parser.add_argument('result')
    args = parser.parse_args()
    _worker(args.request, args.result)
    sys.exit(0)


from typing import Literal
from pydantic import Field, model_validator
from proto_tools import Structure
from proto_tools.tools.tool_registry import tool
from proto_tools.utils import BaseConfig, ConfigField
from proto_tools.utils.tool_io import BaseToolInput, BaseToolOutput


class ProdigyInput(BaseToolInput):
    structure: Structure
    target_chains: list[str] = Field(min_length=1)
    binder_chains: list[str] = Field(min_length=1)

    @model_validator(mode='after')
    def exact_groups(self):
        ids = self.target_chains + self.binder_chains
        if len(ids)!=len(set(ids)) or any(not x or ',' in x or x.strip()!=x for x in ids):
            raise ValueError('Use unique, explicit chain IDs in two disjoint groups')
        if self.structure.structure_format not in ('pdb','cif'):
            raise ValueError('Expected native PDB or mmCIF coordinates')
        return self


class ProdigyConfig(BaseConfig):
    device: Literal['cpu'] = ConfigField(default='cpu', title='Device', description='Local CPU only; no hosted service')
    python_executable: str = ConfigField(default_factory=lambda: os.environ.get('AUTOFOLD_PRODIGY_PYTHON',''),
        title='Installed interpreter', description='Absolute interpreter in an existing prodigy-prot environment; no automatic installation')
    output_dir: str = ConfigField(title='Evidence directory', description='Persistent trial output directory; each call gets a new capture')
    temperature_celsius: float = ConfigField(default=25.0, gt=-273.15,
        title='Temperature', description='Temperature for native free-energy-to-Kd conversion; not a calibrated temperature-dependence model')
    timeout: int = ConfigField(default=120, ge=1, title='Timeout', description='Bounded local worker wall time in seconds')


class ProdigyOutput(BaseToolOutput):
    prodigy_delta_g_kcal_mol: float
    prodigy_kd_molar: float
    contacts_5_5A: int
    features: dict
    capture_dir: str
    version: str
    temperature_celsius: float
    meaning: str

    @property
    def output_format_options(self):
        return ['json']

    @property
    def output_format_default(self):
        return 'json'

    def _export_output(self, export_path, file_format):
        if file_format!='json':
            raise ValueError('PRODIGY output exports as JSON')
        _write(export_path, self.model_dump(mode='json'))


@tool(key='prodigy-affinity', label='Local PRODIGY affinity estimate', category='binding_affinity',
      input_class=ProdigyInput, config_class=ProdigyConfig, output_class=ProdigyOutput,
      uses_gpu=False, cacheable=False,
      description='Estimate protein–protein DeltaG (kcal/mol) and Kd (M) from an explicit canonical complex and chain groups, using installed local PRODIGY. Captures coordinates, native features and errors; no API calls. Not measured affinity.')
def run_prodigy(inputs: ProdigyInput, config: ProdigyConfig, instance=None):
    executable = Path(config.python_executable).absolute()
    if not config.python_executable or not executable.is_file():
        raise ValueError('Configure an installed AUTOFOLD_PRODIGY_PYTHON; no installation or API fallback')
    directory = Path(config.output_dir).resolve()/uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=False)
    coordinates = directory/('structure.'+inputs.structure.structure_format)
    coordinates.write_text(inputs.structure.structure)
    request = {'coordinates': str(coordinates), 'format': inputs.structure.structure_format,
               'target_chains': inputs.target_chains, 'binder_chains': inputs.binder_chains,
               'temperature_celsius': config.temperature_celsius,
               'coordinates_sha256': hashlib.sha256(coordinates.read_bytes()).hexdigest(),
               'contact_cutoff_angstrom': 5.5, 'accessibility_threshold': 0.05}
    _write(directory/'request.json', request)
    command = [str(executable), str(Path(__file__).absolute()), str(directory/'request.json'), str(directory/'native.json')]
    _write(directory/'command.json', {'command': command, 'timeout': config.timeout})
    try:
        with (directory/'stdout.log').open('w') as out, (directory/'stderr.log').open('w') as err:
            subprocess.run(command, stdout=out, stderr=err, check=True, timeout=config.timeout,
                           env={**os.environ, 'HF_HUB_OFFLINE':'1', 'HF_HUB_DISABLE_TELEMETRY':'1'})
        native = json.loads((directory/'native.json').read_text())
        if (not all(math.isfinite(native[k]) for k in ['prodigy_delta_g_kcal_mol','prodigy_kd_molar'])
                or native['prodigy_kd_molar']<=0 or native['contacts_5_5A']<1):
            raise ValueError('Invalid native PRODIGY result')
        result = ProdigyOutput(**native, capture_dir=str(directory))
        _write(directory/'response.json', result.model_dump(mode='json'))
        return result
    except Exception as error:
        _write(directory/'error.json', {'type':type(error).__name__, 'message':str(error)})
        error.add_note(f'Capture directory: {directory}')
        raise
