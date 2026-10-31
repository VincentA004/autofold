# Operator-owned scientific model execution

The scientist selects a model/version and scientific protocol. Provisioning owns
interpreter paths, model/CCD caches, devices, precision, compatibility patches and
runtime qualification. Supply installation fields through the existing adapter
environment defaults. Scientific inference stays local.

## Ligand proposals

Apply `patches/proto-ligand-proposals.patch` at the selected Proto root. It adds a
default-off `Generator.allows_ligand_proposals` capability; existing generators
remain unable to mutate ligands. The shipped `ligand_proposals.py` opts in for
RDKit graph edits with chemical validation and captures. Keep its source with the
authored Program. This patch adds no ligand inference runtime or model weights.
Qualify the intended optimizer's variable-length handoff with the focused
`tests/test_ligand_proposals.py` checks. Existing campaign captures remain unchanged.

For complete native Boltz ligand evidence, the optional
`skills/proto-discovery/examples/boltz_native_capture.py` writer consumes the
qualified worker's existing CCD `mols/` directory. Provision that directory to its
`ccd_mol_dir` argument; `PROTO_BOLTZ2_WEIGHTS_DIR/mols` is appropriate when that is
the actual native cache. It copies referenced CCD molecules before dispatch and
retains native outputs before cleanup. It does not select a runtime or alter model
inputs. Generated SMILES molecules and cached CCD molecules are separate sources.

## Pinned execution profiles

Deploy `scripts/run_trial.py` with its sibling `runtime/` directory. Apply
`patches/proto-runtime-profile.patch` and `patches/proto-af2-runtime.patch` at the
pinned Proto repository root; they route native model calls and include execution
identity in model-cache keys. Verify this
patch as part of provisioning, alongside the existing compatibility tests.

Set `AUTOFOLD_RUNTIME_PROFILE` to an operator-authored JSON file before the first
trial. Without it, the runner pins the native Boltz route. Example:

```json
{
  "schema_version": 1,
  "boltz2": {"backend": "native"},
  "environment": {
    "AUTOFOLD_RFD4_EXECUTABLE": "/opt/models/rfd4/bin/rfd4-generate",
    "AUTOFOLD_RFD4_MODEL": "/opt/models/rfd4/checkpoint"
  }
}
```

The runner pins `.autofold/runtime-profile.json` in the campaign, copies the profile
and runtime source into every trial snapshot, and injects the resolved environment.
Later calls reuse the lock; changing the selected policy fails visibly. A new
comparison/campaign can deliberately use a new qualified profile. The fingerprint
includes runtime source bytes so caches cannot mix implementations. The campaign
also locks that fingerprint, rejecting implementation drift within the comparison.

For a qualified BioIR campaign, replace `boltz2` with:

```json
{
  "backend": "bioir",
  "python_executable": "/opt/models/bioir/bin/python",
  "checkpoint": "/opt/models/boltz/boltz2_conf.ckpt",
  "checkpoint_sha256": "REPLACE_WITH_ACTUAL_SHA256",
  "ccd_path": "/opt/models/boltz/ccd.pkl",
  "mol_dir": "/opt/models/boltz/mols"
}
```

Use existing `bionemo-ir==0.2.0` and the intended Boltz2 checkpoint. The verified
BioIR path supports CUDA, canonical proteins, unpaired/single-sequence MSAs, one
sample, full PAE, default step scale/MSA cap, and explicit recycles/steps/seed.
Unsupported requests fail; execution errors never trigger a silent backend switch,
MSA removal or reduced scientific effort. Each call retains normalized output, full
unrounded native output and an execution receipt. Separate BioIR calls reload weights.

Two AaH I seeds showed faster cold calls but 1.07–2.30 Å target-aligned binder pose
differences. This is not general numerical equivalence or steady-state throughput
qualification. Native remains the default. Qualify protocols and provisioning once;
do not benchmark runtimes inside every scientific trial.

The native route keeps existing Proto ToolPool persistence and uses its configured
local environment. Its runtime receipt identifies the pinned profile and scientific
request; native package/checkpoint details must be provisioned and recorded in
compute notes. BioIR additionally verifies the pinned checkpoint hash at execution.

## AF2 forward profile

For BioIR, add an `alphafold2` entry to the same profile:

```json
{
  "backend": "bioir",
  "python_executable": "/opt/models/bioir/bin/python",
  "checkpoints": {
    "alphafold2_1": {"checkpoint": "/opt/models/af2/params_model_1_ptm.pt", "checkpoint_sha256": "ACTUAL_SHA256"},
    "alphafold2_multimer_1": {"checkpoint": "/opt/models/af2/params_model_1_multimer_v3.pt", "checkpoint_sha256": "ACTUAL_SHA256"}
  }
}
```

The native `alphafold2` call chooses monomer/multimer from the explicit assembly and
uses `model_num` (1–5). Provision each selected set; missing sets fail rather than
substituting another model. Convert existing AF2 NPZ parameters with upstream
OpenFold's weight importer, preserving the original filename/version. Keep source
and converted hashes and converter commit in the operator record. This conversion
downloads no model weights. Monomer uses the pTM checkpoint/head. The worker maps
`num_recycles` to one initial forward pass plus that many recycles, disables early
stopping, retains PAE before upstream rounding, and normalizes native 0–100 pLDDT.
Ensemble averaging and unsupported chemistry fail visibly; paired and unpaired MSAs
are supplied separately. Scientific templates are not exposed by the current shared
AF2 request; this route adds no hidden templates or MSA search.

To keep native execution instead, use `{"backend":"native"}`. For its provisioning,
Select `runtime/alphafold2-forward` via `PROTO_ALPHAFOLD2_STANDALONE_DIR` and set
`PROTO_ALPHAFOLD2_WEIGHTS_DIR` to the local parameter cache. This supports forward
prediction, not gradient design. Installation/downloads belong to provisioning.

## RFD4 velocity-network backend

Add `rfd4` with `backend="bioir"`, the installed BioIR-enabled RFD4 `executable`,
and the existing RFD4 `model_path`. The runner supplies their existing adapter
defaults. Generation/partial redesign select the native `inference_backend=bioir`
switch with CUDA graphs disabled and reference RNG matching. Inverse folding uses
the original autoencoder and is labeled `native-autoencoder`; there is no velocity
network to accelerate in that operation. Guided search is currently rejected on the
BioIR route; it remains available under a native profile. Preserve native rollout
outputs and effective configurations; accelerated execution does not establish an
improved generator or reward.

Protenix v2, ESMFold2, Chai, ProteinMPNN, Complexa and antibody adapters keep their
existing paths. BioIR's Protenix and affinity modules lack complete data pipelines;
no new models or weights are provisioned by this profile.

## ESMFold2 local compatibility

For the pinned Proto checkout, apply
`backend/engine/patches/esmfold2-official-local.patch` at its repository root.
Set `PROTO_ESMFOLD2_STANDALONE_DIR` to the absolute copied
`backend/engine/runtime/esmfold2` directory. This native environment override pins the released
MIT `esm==3.4.1.post1` runtime on Python3.12/Torch2.11. It retains the original
loader before combining dtype conversion with device transfer to reduce host RAM.
The worker uses CUDA bfloat16/autocast and never silently reduces sampling on OOM.

Supply existing local files via `AUTOFOLD_ESMFOLD2_FAST_MODEL` (checkpoint directory)
and `ESMCFOLD_CCD_PATH` (CCD pickle). The profile enforces offline inference and
passes these paths through Proto's worker filter. Public asset: `biohub/ESMFold2-Fast`
revision `45fe8656f5b3ef493c17fcf9abe9a2968902e712`; CCD from `biohub/ESMFold2`
revision `69869f737beffec5294845ede23db5fc0b4f509e`.
Full ESMFold2 needs its own checkpoint, configuration and readiness test.
Apply `backend/engine/patches/proto-tool-monotonic-time.patch` to the same Proto
checkout: tool durations must use a monotonic clock so system-clock corrections
cannot invalidate a completed prediction. This affects timing, not model scores.

## PRODIGY provisioning

Install `prodigy-prot==2.4.0` in an isolated CPU environment (Apache2.0). Set
`AUTOFOLD_PRODIGY_PYTHON` to its absolute interpreter through the runtime profile.
The scientist calls the provisioned scorer with coordinates and explicit chain groups.

## Remaining adapter boundary

RFD4/BoltzGen, antibody and PRODIGY adapters already default their installation fields
from environment variables; provide them before execution. Complexa still consumes
a resolved native configuration mixing scientific and machine settings. Provision
that base configuration and its checkpoint paths; the scientist edits design/search
settings. Separating its remaining native configuration fields is future adapter work.

Managed Boltz2/AF2 boundaries now retain their full requests/responses automatically.
Other predictors still require the authored capture helper; the runner cannot recover
outputs left only in memory. Scientific interpretation and consequential analysis
remain with the scientist. Trial paths and assessment immutability are runner-owned.
