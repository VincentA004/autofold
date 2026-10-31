"""Retain native Boltz evidence before temporary-directory cleanup.

Optional evidence writer, not a model route or scoring policy. Infrastructure
supplies the same CCD mol directory used by the qualified native Boltz worker.
Use synchronously; ToolInstance.dispatch is restored on context exit.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import shutil

import yaml
from proto_tools.utils import ToolInstance


def _write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


@contextmanager
def capture_boltz_native(directory, *, ccd_mol_dir=None):
    directory = Path(directory)
    descriptor = ToolInstance.__dict__['dispatch']
    original = ToolInstance.dispatch
    calls = []

    def captured(cls, toolkit, input_dict, **kwargs):
        if toolkit != 'boltz2':
            return original(toolkit, input_dict, **kwargs)
        destination = directory / f'worker-{len(calls):03}'
        destination.mkdir(parents=True, exist_ok=False)
        calls.append(destination)
        _write(destination/'request.json', {'toolkit': toolkit, 'input': input_dict})
        source = Path(input_dict['input_yaml_path'])
        shutil.copyfile(source, destination/'input.yaml')
        try:
            doc = yaml.safe_load(source.read_text())
            codes = set()
            for entry in doc.get('sequences', []):
                code = entry.get('ligand', {}).get('ccd')
                if code:
                    codes.update(code if isinstance(code, list) else [code])
            references = []
            for code in sorted(codes):
                if not ccd_mol_dir or not code.isalnum():
                    raise ValueError('Infrastructure must supply native CCD evidence for ligand inputs')
                native = Path(ccd_mol_dir) / f'{code}.pkl'
                if not native.is_file():
                    raise ValueError(f'Missing native CCD molecule: {code}')
                saved = destination/'native-ccd'/native.name
                saved.parent.mkdir(exist_ok=True)
                shutil.copyfile(native, saved)
                references.append({'ccd': code, 'source': str(native),
                    'path': saved.relative_to(destination).as_posix(),
                    'sha256': hashlib.sha256(saved.read_bytes()).hexdigest()})
            _write(destination/'chemical-references.json', references)
            result = original(toolkit, input_dict, **kwargs)
            _write(destination/'response.json', result)
            return result
        except Exception as error:
            _write(destination/'error.json', {'type': type(error).__name__, 'message': str(error)})
            raise
        finally:
            output = Path(input_dict['output_dir'])
            if output.exists():
                shutil.copytree(output, destination/'native')

    ToolInstance.dispatch = classmethod(captured)
    try:
        yield calls
    finally:
        ToolInstance.dispatch = descriptor
