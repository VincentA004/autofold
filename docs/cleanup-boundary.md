# Autofold donor-code boundary

Autofold selectively retains the OpenScience runtime and interface. Cleanup must
follow runtime reachability and product value rather than folder names.

## Preserve

- The frontend entry chain, home and session routes, Atlas visual shell, styles,
  public assets, shared UI package, and persisted-layout compatibility keys.
- Session rendering, prompt input, skills browser, file explorer, artifact
  inspector, compute jobs, terminal, evidence graph, and project selection.
- Scientific file dispatch, molecular and chemical renderers, notebooks,
  manuscripts, tables, and provenance views. These are part of peptide research.
- The backend project/session/agent/provider/tool runtime required by the current
  interface.
- The research control plane, worker, compute authority, project context,
  storage, and server routes.
- `NOTICE.openscience`, `LICENSES/`, and `docs/upstream-provenance.md`.

## Compatibility identifiers to defer

The following remain intentionally even when users see the Autofold name:

- `@synsci/*` package imports and the internal `OpenScience` backend namespace.
- The `openscience` executable until an Autofold wrapper and packaging path ship.
- `OPENSCIENCE_*` environment aliases, `openscience.json`, XDG storage, and
  `.openscience` project data until a three-generation Autofold/OpenScience/synsc
  migration is tested.
- Serialized format names, HTTP headers, DOM events, theme identifiers, generated
  SDK names, and local-storage keys. Renaming these without dual-read support can
  orphan existing state or break clients.

## Research-kernel extraction order

1. Split legacy project/session migration out of project identity.
2. Extract compute secret-redaction and environment policy from the broad
   OpenScience service dependency.
3. Split project bootstrap into base research, chat, and optional developer-tool
   bootstraps.
4. Add a dedicated Autofold server entrypoint before removing donor CLI commands.
5. Consolidate the three artifact systems only after UI consumers move to the
   campaign/trial/run model.

## Verified cleanup candidates

Generated build/test directories and Python caches may be discarded and rebuilt.
The following frontend source batch has no inbound import from the browser entry
graph and can be quarantined together after typecheck and production-build checks:

- `atlas/Composer.tsx`, `atlas/OpenScienceFileTree.tsx`
- `atlas/model-tier.ts`, `utils/model-cost.ts`
- `atlas/store/files.ts`, `atlas/store/projects.ts`
- `components/status-popover.tsx`
- `utils/dom.ts`, `utils/index.ts`, `utils/prompt.ts`, `utils/solid-dnd.tsx`

Do not infer that workers, CSS, declaration files, tests, or package exports are
dead from ordinary static imports alone.
