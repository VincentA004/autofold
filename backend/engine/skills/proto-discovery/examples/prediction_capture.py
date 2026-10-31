"""Capture a Proto prediction response before its caller scores or selects it.

Copy beside the authored trial and include it in captured program sources. This
does not choose models, cache predictions, or change optimization policy.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import time
import uuid


def _write_json(path, value):
    # Preserve nonfinite backend values as Python JSON extensions for diagnosis;
    # they are rejected below for PAE, never silently converted to null or zero.
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=True) + '\n')
    temporary.replace(path)


def predict_captured(complexes, tool, config, *, capture_dir, msas=None, predictor=None):
    """Return ``(native_output, capture_directory)`` after retaining every response.

    request.json is saved before dispatch; response.json retains the complete
    native output, including all structures, metrics and actual PAE matrices.
    Native-format coordinate files and hashes make inspection easier. A partial
    failed response is retained too. A raised invocation leaves error.json;
    a killed process leaves its request without a completed capture.json.
    """
    from proto_tools import predict_structures

    batch = complexes if isinstance(complexes, list) else [complexes]
    directory = Path(capture_dir) / uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=False)
    configuration = config.model_dump(mode='json') if hasattr(config, 'model_dump') else config
    _write_json(directory / 'request.json', {
        'tool': tool, 'config': configuration,
        'complexes': [item.model_dump(mode='json') for item in batch],
        'msas': None if msas is None else [
            item.model_dump(mode='json') for item in (msas if isinstance(msas, list) else [msas])
        ],
    })
    started = time.monotonic()
    try:
        call = predictor or predict_structures
        output = call(batch, tool, config) if msas is None else call(batch, tool, config, msas=msas)
    except Exception as exc:
        _write_json(directory / 'error.json', {'type': type(exc).__name__, 'message': str(exc)})
        raise

    # Persist the complete response FIRST, including candidates absent from any
    # later native history. Never reduce evidence to selected scalar metrics.
    _write_json(directory / 'response.json', output.model_dump(mode='json'))
    artifacts = []
    problems = []
    for index, structure in enumerate(output.structures):
        fmt = structure.structure_format
        if fmt not in ('pdb', 'cif'):
            raise ValueError(f'Cannot export unknown native structure format: {fmt!r}')
        coordinates = directory / f'structure_{index}.{fmt}'
        coordinates.write_text(structure.structure)
        pae = structure.metrics.get('pae')
        rectangular = (isinstance(pae, list) and bool(pae)
                       and all(isinstance(row, list) and len(row) == len(pae) for row in pae))
        finite = bool(rectangular and all(
            isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v)
            for row in pae for v in row
        ))
        if (configuration or {}).get('include_pae_matrix') and output.success and not finite:
            problems.append(f'structure {index}: requested PAE is missing, malformed or nonfinite')
        artifacts.append({
            'index': index, 'coordinates': coordinates.name,
            'sha256': hashlib.sha256(coordinates.read_bytes()).hexdigest(),
            'pae_path': f'response.json#/structures/{index}/metrics/pae' if pae is not None else None,
            'pae_shape': [len(pae), len(pae[0])] if rectangular else None,
            'pae_finite': finite,
        })
    _write_json(directory / 'capture.json', {
        'success': output.success, 'requested_complexes': len(batch),
        'returned_structures': len(output.structures), 'structures': artifacts,
        'response_sha256': hashlib.sha256((directory / 'response.json').read_bytes()).hexdigest(),
        'wall_seconds': time.monotonic() - started, 'validation_errors': problems,
    })
    if problems:
        raise ValueError('; '.join(problems))
    return output, directory
