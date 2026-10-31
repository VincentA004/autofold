# Autofold

Autofold is a local AI workspace for protein-discovery research. Chat with a
scientist, inspect its captured Proto experiments, explore saved molecular
structures and navigate the linked Markdown notebook behind its conclusions.

The browser and terminal use the same embedded Pi scientist, native sessions and
campaign files. The application does not require the retired OpenScience backend,
a separate job worker or a generated API client.

## What is in the workspace

- **Campaign chooser:** searchable saved research with grid and list views.
- **Scientist chat:** native tool use, streaming responses, model/thinking
  selection, evidence uploads and session continuation.
- **Trial atlas:** execution states, prospective plans, initial assessments,
  captured code and saved outputs, including failed or interrupted trials.
- **Scientific viewers:** a gray/teal backbone view with Mol* controls, compound
  rendering and data tables, all connected to saved artifacts.
- **Linked notebook:** readable Markdown beside a focused local graph, with a
  full-campaign graph, filters, search, zoom, pan and navigation history.

These are research tools for computational hypotheses. Model confidence,
structural comparisons and pose-conditioned estimates are not measured binding
activity. The notebook and trial records preserve qualifications and corrections.

## Quick start

Requires Bun, Node.js 22.19+ and npm. Python 3.11+ is needed for trial capture and
the offline backend tests.

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open [http://127.0.0.1:4450](http://127.0.0.1:4450). Choose a saved campaign or
create a new one. Merely browsing saved research does not start inference.
Sending a message starts the scientist after provider credentials are configured.

Provider configuration uses Pi's native `/login` and `/model` commands or its
standard provider environment variables. To open the terminal scientist in a
separate campaign workspace:

```sh
mkdir -p ../autofold-campaigns/example
npm run agent -- --workspace ../autofold-campaigns/example
# Resume its latest session:
npm run agent -- --workspace ../autofold-campaigns/example --continue
```

Protein-model execution additionally needs a Python environment with Proto,
selected model integrations, weights and compute resources. `npm ci` does not
install those. [The engine guide](docs/engine.md) explains the native program,
trial-capture and research workflows;
[the runtime operations guide](backend/engine/runtime/OPERATIONS.md) documents
optional local model environments and compatibility patches.

For a saved campaign without live scientist commands:

```sh
npm run archive -- --workspace /path/to/campaign --port 4450 \
  --web-root frontend/workspace/dist
```

Add `--archives-dir /path/to/archive-parent` to browse direct
`<run>/campaign/campaign.md` children. See [workspace setup](docs/workspace.md)
for live mode, archive selection and optional display metadata. Saved development
campaigns and model weights are not bundled with this repository.

## Source and campaign data

```text
backend/engine/        Native scientist, campaign API, skills and trial runner
frontend/workspace/   Campaign interface and scientific viewers
frontend/ui/          Shared theme, styles and sanitization
examples/             Small reusable Proto and presentation examples
docs/                 Current architecture and usage guides
```

A campaign is its own filesystem workspace containing `campaign.md`, `programs/`,
`inputs/`, `sources/`, `notebook/`, `output/` and `.autofold/`. Prefer campaign
workspaces outside this product checkout. Local campaign state, sessions, model
environments and generated outputs are ignored; they are not product source.
Existing scientific records are preserved when the app opens them.

Pi owns the agent loop, tools, providers, history and compaction. Autofold supplies
scientific guidance, notebook templates, native Proto integrations, trial capture
and assessment protection. There is no second agent loop or duplicate transcript
store. The [engine guide](docs/engine.md) describes these boundaries and their
limitations.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

The default suite uses offline fixtures and no model calls; its research HTTP
fixture needs permission to bind a temporary loopback server. Additional native
Proto/measurement checks need the separately configured Python environment and
are listed in [the engine guide](docs/engine.md#validation).

## Documentation and provenance

- [Browser workspace](docs/workspace.md)
- [Engine, notebooks, captured trials and scientific research](docs/engine.md)
- [Scientific model menu](backend/engine/skills/proto-discovery/references/models.md)
- [Runtime environments and patches](backend/engine/runtime/OPERATIONS.md)
- [Current product and historical-code boundary](docs/cleanup-boundary.md)
- [OpenScience provenance and retained attribution](docs/upstream-provenance.md)

The interface adapts OpenScience-derived design and scientific renderers. Preserve
[NOTICE.openscience](NOTICE.openscience), [LICENSE](LICENSE) and [LICENSES](LICENSES)
when redistributing derived work. Earlier orchestration/worker code and its
historical acceptance documents remain in Git history rather than the active
product tree.
