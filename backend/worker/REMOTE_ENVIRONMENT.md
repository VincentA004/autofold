# Remote scientific process environment

`remote_supervisor.worker_environment` builds a fresh environment for both the detached remote supervisor and its scientific child. The local SSH controller retains its host authentication environment.

The explicit inherited allowlist covers:

- Runtime paths: `PATH`, `HOME`, `VIRTUAL_ENV`, `CONDA_PREFIX`.
- Locale and temporary storage: `LANG`, `LANGUAGE`, the named standard `LC_*` categories listed in the source, `TZ`, `TMPDIR`, `TMP`, `TEMP`.
- Compiler and dynamic library paths: `LD_LIBRARY_PATH`, `LIBRARY_PATH`, `DYLD_LIBRARY_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`, `CPATH`, `C_INCLUDE_PATH`, `CPLUS_INCLUDE_PATH`, `CC`, `CXX`, `CMAKE_PREFIX_PATH`.
- CUDA/device policy: `CUDA_HOME`, `CUDA_PATH`, `CUDA_VISIBLE_DEVICES`, `CUDA_DEVICE_ORDER`, `NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`, `CUDA_MODULE_LOADING`, `CUDA_CACHE_PATH`, `CUDA_CACHE_MAXSIZE`, `CUDA_LAUNCH_BLOCKING`.
- CPU threading and allocation: `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`, `NUMEXPR_NUM_THREADS`, `VECLIB_MAXIMUM_THREADS`, `PYTORCH_CUDA_ALLOC_CONF`, `PYTORCH_ALLOC_CONF`.
- Model caches and offline switches: `TORCH_HOME`, `TORCH_EXTENSIONS_DIR`, `HF_HOME`, `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE`, `TRANSFORMERS_CACHE`, `HF_DATASETS_CACHE`, `XDG_CACHE_HOME`, `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HF_DATASETS_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY`, `HF_HUB_DISABLE_PROGRESS_BARS`, `PYTHONHASHSEED`.
- Host scientific tool paths: `PROTO_HOME`, `AUTOFOLD_PROTO_ROOT`, `AUTOFOLD_BOLTZGEN_EXECUTABLE`, `AUTOFOLD_BOLTZGEN_CACHE`, `AUTOFOLD_PXDESIGN_EXECUTABLE`.

Only the five host scientific tool path variables may be overridden by the frozen remote plan. Overrides must be strings without NUL bytes and no larger than 64 KiB each. The staged plan is checked against the run, bundle and worker identities before launch.

The supervisor fixes `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`, `PYTHONNOUSERSITE=1`, `PROTO_NO_SPINNER=1` and `TQDM_DISABLE=1`. It drops all other inherited variables, including provider/cloud credentials, tokens, SSH agent sockets, `PYTHONPATH` and preload injection variables. This restricts environment inheritance; filesystem access remains subject to the selected remote host account.
