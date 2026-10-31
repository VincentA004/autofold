# Upstream provenance

Autofold selectively reuses interface code from
[`synthetic-sciences/openscience`](https://github.com/synthetic-sciences/openscience).
It does not require the OpenScience backend or generated SDK to run.

## Original import

- UI release source: tag `v2.0.1`, commit
  `dfef67701f665cc03340bf7b592f53ea876b27db`.
- Published binary build commit recorded with the import:
  `c174183a6fd4e1cf66b72898023bc98e29675114`; its UI tree matched that release.
- Initially imported areas included `backend/cli`, `frontend/workspace`,
  `frontend/ui`, `tooling/sdk/js` and `tooling/util`.
- License: Apache License 2.0; see [the retained license](../LICENSES/Apache-2.0.txt)
  and [upstream notice](../NOTICE.openscience).

The UI was aligned with the canonical release after an initial newer snapshot
rendered a different home screen. The imported code was subsequently modified
for Autofold. These upstream commits identify provenance, not an assertion that
the current UI remains identical to the original release.

## Current retained work

The current interface preserves and adapts the visual theme, typography,
molecular/chemical viewers, table renderer and campaign chooser design.
Autofold's chat workspace, trial atlas, filesystem-backed notebook navigation
and native-engine integration replace the old session/synchronization layers.
The `@synsci/ui` workspace name and some theme identifiers remain internal
compatibility names.

The imported OpenScience backend, generated SDK/plugin code and obsolete utility
tooling have been removed. The active backend in `backend/engine` embeds the
separately pinned Pi library and runs ordinary native Proto programs. Earlier
Autofold science-core/worker implementations are historical code, not runtime
dependencies of this application.

Preserve the upstream notices when redistributing derived code, and retain
modification notices where required by the license. See
[the cleanup boundary](cleanup-boundary.md) for the current source/data split.
