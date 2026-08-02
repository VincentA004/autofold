# Upstream provenance

AutoFold selectively reuses frontend code from the OpenScience project rather
than vendoring the complete repository.

- Upstream project: `synthetic-sciences/openscience`
- Original inspected snapshot: `/Users/vincentallam/Downloads/openscience-main`
- UI release source: tag `v2.0.1`, commit
  `dfef67701f665cc03340bf7b592f53ea876b27db`
- Published binary build commit (npm signed provenance):
  `c174183a6fd4e1cf66b72898023bc98e29675114`; its UI tree is identical to
  the `v2.0.1` tag
- Imported areas: the `backend/cli` runtime source, `frontend/workspace`,
  `frontend/ui`, `tooling/sdk/js`, and `tooling/util`
- Excluded areas: documentation and landing sites, launchers, release tooling,
  the backend's bundled test corpus and skill catalog, and unrelated site packages
- License: Apache License 2.0; see `LICENSES/Apache-2.0.txt`
- Upstream notices: see `NOTICE.openscience`

The initial downloaded `main` snapshot rendered a newer replacement home shell
than the globally installed OpenScience 2.0.1 release. The frontend was
therefore replaced with the canonical `v2.0.1` tag above. Package manifests
retain npm-workspace compatibility edits; UI source and assets are taken from
that release. Files modified for AutoFold should retain prominent modification
notices where required by Apache-2.0.

The backend runtime was imported from the downloaded `main` snapshot. Its
workspace/catalog dependency references were replaced with pinned package
versions so Autofold can run as a smaller standalone npm workspace. Autofold's
research control plane lives under `backend/cli/src/research` and is not
upstream OpenScience code.
