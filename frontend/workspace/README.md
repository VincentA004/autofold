# Autofold workspace

The campaign chooser, chat, trial atlas and linked Markdown notebook share the
native discovery engine in `backend/engine`. The UI retains the OpenScience-derived
visual theme and scientific viewers; the old session server and generated SDK are
not required.

From the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open [http://127.0.0.1:4450](http://127.0.0.1:4450). Root opens the campaign chooser;
`?campaign=<run>` opens the selected campaign. The workspace back arrow returns to
the chooser, and the campaign title opens the compact switcher.

The notebook defaults to the selected document and its direct links. Its full
campaign view adds filters, document search, zoom and pan. Clicking graph nodes
or Markdown links opens the saved document beside the graph.

See [workspace setup](../../docs/workspace.md) for archive/live mode and
[the repository README](../../README.md) for prerequisites, checks and provider
configuration. The service binds to loopback; omitting `--live` serves archives
read only.

```sh
npm run typecheck --workspace @synsci/workspace
npm run test --workspace @synsci/workspace
npm run build
```
