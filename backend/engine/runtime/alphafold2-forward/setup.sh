#!/bin/bash
set -euo pipefail
# Environment-definition override for Proto's existing alphafold2 worker.
# Installation is a separate readiness operation, never a scientific API call.
: "${PIP_EXE:?Proto installer must supply PIP_EXE}"
: "${PROTO_ALPHAFOLD2_WEIGHTS_DIR:?Select the local weight directory explicitly}"
runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$PIP_EXE" install -r "$runtime_dir/requirements.txt"
params_dir="$PROTO_ALPHAFOLD2_WEIGHTS_DIR/params"
mkdir -p "$params_dir"
if [ ! -f "$params_dir/params_model_1_multimer_v3.npz" ]; then
    archive="$PROTO_ALPHAFOLD2_WEIGHTS_DIR/alphafold_params_2022-12-06.tar"
    curl -fL --retry 2 https://storage.googleapis.com/alphafold/alphafold_params_2022-12-06.tar -o "$archive.partial"
    mv "$archive.partial" "$archive"
    tar -xf "$archive" -C "$params_dir"
fi
"$PYTHON_EXE" -c 'import jax, colabdesign; assert jax.devices("gpu"), "No local GPU visible"'
