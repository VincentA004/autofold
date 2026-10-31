# Current molecular representation and handoffs

This documents the locally inspected implementation, not a new schema or a promise
of upstream capabilities. Recheck the execution environment through [API inspection](api.md)
when versions differ. Class labels in briefs are guidance, not enforced molecular types.

## What the shared objects carry

| Object | Implemented meaning | Boundary |
| --- | --- | --- |
| `Sequence` | Typed string, metadata, optional logits/structure; protein default alphabet is the canonical 20 residues | No first-class bond, terminal chemistry or chain-pairing fields; free metadata does not make adapters consume chemistry |
| `Segment` / `Construct` | Design region / assembly of segments | A joined string does not encode separate molecular chains or covalent topology |
| Tool `Chain` | `id`, `sequence`, `entity_type`, `modifications` | Modifications use validated CCD codes at 1-based sequence positions; this is not arbitrary chemical support |
| Tool `Complex` | Ordered `chains` (polymer chains or ligand fragments) | No shared covalent-bond or cyclic fields; separate chains can represent partners, including antibody chains |

For small molecules, use `Sequence(..., sequence_type="ligand")` for SMILES and
tool `Fragment(id=..., smiles=...)` or `Fragment(..., ccd_code=...)` inside `Complex`.
`Sequence` validation can warn without rejecting invalid SMILES; explicitly parse
and sanitize with RDKit. `Fragment` can resolve SMILES to a CCD code, which Boltz
YAML prefers. Verify the emitted component's graph, charge and stereochemistry
against the intended molecule; local CCD agreement does not verify a worker's CCD.
Keep original and canonical isomeric SMILES, preparation choices and atom maps with
artifacts. Coordinates alone do not establish bond orders or chemical identity.
Ligand Segments can carry fixed candidates. The operator-applied ligand proposal
patch permits explicit chemistry-aware generator opt-in; unadapted generators still
reject ligands. See [small molecules](small-molecules.md) for the implemented adapter.

`Chain` currently ignores unknown constructor fields: `cyclic=True` is silently
discarded. `Complex` rejects extra fields. Inspect serialized input and native
conversion; successful construction does not prove the intended molecule survived.

## Adapter support observed in the installed source

| Path | Preserved | Unsupported or lost |
| --- | --- | --- |
| Boltz2 shared `complex_to_yaml` | Chain sequence/type, resolved IDs, MSA assignment and supported ligand representation | Does not emit `Chain.modifications`, cyclic flags or explicit bonds |
| Protenix `ProtenixInput.to_json` | Chain sequences/order and declared CCD modifications | Does not emit explicit covalent bonds or antibody region semantics |
| Bundled `condition_on_target` example | One target and one mutable binder sequence; checks returned identities; supplies binder-only redesign and optional fixed positions | Rebuilds `Chain`s from strings; does not carry modifications, topology, fixed target coordinates or extra antibody chains |
| BoltzGen/RFD4 generator bridges | Native design specification and full native outputs; one canonical binder sequence with attached generated complex | Not a general chemistry handoff; their `protein` registration does not prove cyclic/modified or antibody support |
| RFAntibody generator bridge | One mutable H/L chain, native HLT loop labels, fixed framework/partner sequence checks and full native geometry | Fixed loop lengths; no joint H/L Segment updates, arbitrary chemistry or independent structure assessment |
| AntiFold generator bridge | Native log-probability CSV, explicit chain/sequence mapping and mutable sequence positions; fixed partner context | Attached structure is conditioning only; no new backbone, arbitrary chemistry or affinity measurement |

The installed input classes for Boltz2, Protenix and Chai-1 expose `complexes`/`msas`;
the shared `Complex` cannot carry explicit bonds. Do not infer other chemistry support
from this field inventory or transfer one adapter's modification support to another.

The SFTI-1 diagnostic used captured native Boltz YAML and Protenix JSON through the
existing worker, bypassing this shared conversion to supply closure/disulfides. That
demonstrated one known cyclic system, not a reusable native-Program design handoff.
Its raw Boltz CIF omitted explicit connectivity records; coordinates alone were
insufficient to preserve molecular identity. Find the retained campaign via compute/
notebook notes when using its evidence; it is not a universal model guarantee.

## Authoring within these limits

Keep separate explicit chains and map their roles in captured inputs. Record required
chemistry and region/position maps alongside native model inputs; do not replace
unsupported requirements with an unqualified sequence-only call. If support is absent,
report the gap or use a deliberately captured, verified native-input diagnostic.

Map sequence positions, coordinate author IDs/insertion codes and predictor token
indices explicitly. The [measurement helper](structure-measurements.md) checks arithmetic,
not correspondence or chemical identity. Mutation/selection must preserve required
positions through actual constraints; a label or notebook statement is not enforcement.

The runner captures declared input files and saved outputs; it has no enforced
candidate/molecular-class schema. Retain candidate IDs, parent/artifact links, chain
maps and chemistry with those files. No automatic chemistry validation or lossless
topology round trip is supplied. Shared core objects do not number antibodies;
AntiFold's upstream worker performs ANARCII and its native maps are retained.
