# Browser workspace

Autofold's browser application and terminal scientist share the embedded Pi
engine in `backend/engine`, native sessions, campaign notebook and captured trial
records. No OpenScience backend, generated SDK or separate worker is required.

## Run

From the repository root, with Bun, Node.js 22.19+ and npm installed:

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open [localhost:4450](http://127.0.0.1:4450). The opening screen lists saved
campaigns; selecting one opens its own chat, trial atlas, notebook and artifacts.
The workspace back arrow returns to the chooser. The campaign title opens a
compact switcher. Search and grid/list views help navigate larger collections.

`npm start` creates an empty default campaign under
`.autofold/workspace/campaign`. **New campaign** records an objective and creates
another notebook workspace. **New research** does the same from an open campaign.
These actions do not start inference. A native scientist session is initialized
when you explicitly open/resume a conversation, select its settings or send a
message; sending a message starts the scientist's work.

The model picker uses providers configured in Pi. Configure credentials through
the terminal UI's `/login` or Pi's standard provider environment variables; see
[the engine guide](engine.md#run). Thinking options follow the selected model's
supported levels. Provider keys and private thinking are not sent to the browser.

## Chat and trials

The composer streams native scientist text and tool status, accepts evidence
uploads and can stop active work. Trials and notebook records update as tools
write them. New conversations share the campaign's notebook while starting fresh
native conversation history. Refreshing the page reconnects to active work.

The trial atlas shows saved execution states and recorded references. Click a
trial to inspect its prospective plan, initial assessment, captured Proto/code
bundle and output files. The sidebar scrolls independently for larger campaigns;
its expand button opens the full trial list.

"Assessment recorded" describes a saved record. It does not establish scientific
validity or assert that the browser has verified its hashes. Execution completion,
model confidence and measured biological activity remain distinct.

Structure previews use saved coordinates. The gray/teal backbone view includes
a Mol* mode and scientific controls. Chemical and table artifacts use their
respective renderers. A saved preview is displayed separately from an original
conversation; it is not inserted into the historical transcript.

## Linked Markdown notebook

The notebook opens a reader beside a local graph of the selected document and
its direct connections. Clicking a node or a relative Markdown link opens the
document and refocuses the graph. Reader back/forward controls preserve navigation
history within that notebook inspection.

**Full campaign** shows the complete projected graph, with Notes/Trials/Sources
filters, document search, drag-to-pan, zoom and Fit controls. Short labels and
hover/selection details keep large campaigns readable. Graph connections record
links and captured inputs; they do not by themselves establish scientific support.

## Select another archive directory

Campaigns are filesystem workspaces. To configure an explicit initial campaign
and a directory of archives:

```sh
npm run archive -- --live --workspace /path/to/campaign \
  --archives-dir /path/to/archive-parent --port 4450 \
  --web-root frontend/workspace/dist
```

The catalog discovers direct `<run>/campaign/campaign.md` children. Nested prior
runs and symlinks are excluded. Selection changes `?campaign=<run>` in the same
tab; conversation, file, download, trial and structure requests all remain scoped
to that campaign. Navigation remounts the workspace to dispose old viewers and
requests.

Omit `--live` for a GET-only archive viewer that cannot create agents or execute
commands:

```sh
npm run archive -- --workspace /path/to/campaign \
  --archives-dir /path/to/archive-parent --port 4450 \
  --web-root frontend/workspace/dist
```

For separate frontend development servers, the archive API defaults to port
4096 and `npm run frontend` opens the frontend on port 4447 with its API proxy.

The service binds to loopback and confines file access to the selected campaign.
Private files and outward paths/symlinks are excluded. Saved Pi sessions are
available through a memory-only conversation projection; raw private session
files are not exposed. Stop cancels the native scientist and its local tools;
inspect execution receipts separately for detached or remote work.

## Optional presentation metadata

`analysis/display.json` version 1 can supply selected metric references and
structure previews. See [the display example](../examples/mdm2-display.json).
Metrics reference campaign-relative JSON source paths and RFC 6901 pointers,
with units and meanings. Their sources must appear in the producing trial's
captured inventory. Values are read from the captured source, not duplicated in
the manifest; missing or invalid sources remain visibly unavailable.

The optional `workspace` section supplies campaign-authored overview copy,
trial summaries and source references for summary metrics. The UI labels this
as curated presentation and keeps the original Pi conversation available.
Presentation metadata can be added outside captured trials after a campaign
finishes. It is not an assessment, a design registry or scientific evidence.
Unannotated archives remain usable through their saved records and artifacts.
