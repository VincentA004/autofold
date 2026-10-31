#!/bin/bash
# Pinned native Proto environment; all inference is local.
set -euo pipefail
python -m pip install uv
uv pip install -r requirements.txt
python - <<'PYLOADER'
"""Avoid materializing a second full checkpoint in host RAM before CUDA transfer.

For the pinned esm release only. Dtype/device at return are unchanged; casting
and transfer occur together per tensor. The original source is retained beside it.
"""
from importlib.util import find_spec
from pathlib import Path

path=Path(find_spec('esm.models.hub').origin)
old='''        if dtype is not None:
            model.to(dtype)
        model.to(device)'''
new='''        # Autofold: cast during transfer, avoiding a full host-RAM dtype copy.
        model.to(device=device, dtype=dtype)'''
source=path.read_text()
if old in source:
    if source.count(old)!=1:
        raise RuntimeError('Unexpected esm loader layout')
    path.with_suffix('.py.autofold-original').write_text(source)
    path.write_text(source.replace(old,new))
elif new not in source:
    raise RuntimeError('Unrecognized esm version; inspect before changing the loader')

PYLOADER
