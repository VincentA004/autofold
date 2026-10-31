# Product and historical-code boundary

The current application has three npm workspaces:

- `backend/engine`: embedded Pi scientist, campaign/archive API, native sessions,
  notebook initialization, assessment protection and bounded read-only helpers.
- `frontend/workspace`: campaign chooser, chat, trial atlas, linked Markdown
  notebook and scientific artifact viewers.
- `frontend/ui`: shared theme, styling and sanitization support retained from
  the OpenScience-derived interface.

Root commands and current backend imports use these workspaces. Scientific
execution also depends on files reached through skills and shell commands:
`backend/engine/scripts`, `runtime`, `patches`, `skills`, notebook templates and
offline tests are part of the current engine even when absent from a TypeScript
import graph. Python/model environments and weights are installed separately.

The retired `backend/science-core`, `backend/worker`, generated SDK/plugin code,
old acceptance tooling and obsolete experiment launchers have been removed from
the product source tree. They are not needed to browse saved current-engine
campaigns or run the embedded scientist. Historical architecture, acceptance and
operator documents for that implementation were removed with them. Git history
preserves the earlier implementation; checkpoint `ebf2f49` predates this cleanup.

Campaign workspaces, native session histories, scientific outputs and local
environments are user data. Cleanup must not delete or rewrite them. Keep them
outside the product repository, or in its ignored campaign directories. Old job
databases and receipts are not automatically migrated into native Pi sessions.

Retained OpenScience-derived code still requires its attribution and license
notices: preserve `NOTICE.openscience`, `LICENSE`, `LICENSES/` and
[upstream provenance](upstream-provenance.md). Internal `@synsci/ui` package and
theme identifiers are compatibility names, not evidence that the retired backend
is still required. Evaluate future cleanup through runtime reachability, package
exports, CSS/assets, skill references and validation, rather than names alone.
