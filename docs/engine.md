# Engine and scientific workflow

This guide covers the current embedded Pi engine and native Proto workflow.
For the browser application, start with [the workspace guide](workspace.md).

## Run

Requires Bun, Node.js 22.19+ and npm. Run all commands below from the repository root:

```sh
npm ci --ignore-scripts
mkdir -p ../autofold-campaigns/example
npm run agent -- --workspace ../autofold-campaigns/example
npm run agent -- --workspace ../autofold-campaigns/example --continue
npm run agent -- --workspace ../autofold-campaigns/example --provider openrouter --model YOUR_MODEL_ID
npm run agent -- --workspace ../autofold-campaigns/example --print "Inspect the Python environment and draft a native Proto program."
```

Pi's native terminal UI supplies `/login`, `/model`, `/resume`, `/new` and
`/compact`. Provider environment variables and Pi's normal credential/settings
files work directly. No provider or model is hardcoded by Autofold.

Pi owns the agent loop, read/write/edit/bash tools, model calls, skill loading,
session tree and compaction. Native JSONL sessions live in
`WORKSPACE/.autofold/sessions/`.

## Product source and campaign data

This repository contains the Autofold engine, skills, templates, reusable examples,
documentation and small offline test fixtures. A campaign is a separate user
workspace containing `campaign.md`, `inputs/`, `sources/`, `programs/`, `notebook/`, `output/`
and `.autofold/`. Use `--workspace` to select it; the CLI otherwise uses the current
directory. Campaigns can manage their own source control independently of Autofold.

Local campaign state is ignored if created in this checkout. Prefer a workspace
outside the product repository, such as `../autofold-campaigns/example`. An ignored
`campaigns` compatibility alias may exist locally; it is not required by the app
or tests. The local `.autofold/` cache and historical artifacts are ignored too.

## Durable lab notebook

Each workspace gets three ordinary Markdown pages on first use. Existing pages
are preserved, including when opening a new session or resuming work:

```text
notebook/
  index.md       # Objective, current understanding, next decision and navigation
  findings.md    # Evidence-linked findings, interpretations and connections
  questions.md   # Uncertainty, proposed investigations and resolved questions
```

Substantial investigations use stable pages such as
`notebook/investigations/reporter-response.md`, with Evidence, Interpretation,
Next decision and dated consequential Changes. Keep observations and reasoning
close; split pages only for size or actual reuse. Notebook pages can evolve after
citation; original source captures and captured trials stay fixed. Existing E/F/Q
pages remain readable without bulk migration.

Ordinary relative Markdown links connect notebook pages, sources and trials.
The [document graph contract](../backend/engine/skills/scientific-research/references/notebook-contract.md)
defines identity, corrections and native navigation: source citations, trial inputs
and linked trial motivation. The browser projects these files into local and
full-campaign graphs without a separate persistent knowledge store. Frozen trial plans and initial assessments preserve historical
reasoning separately from the current notebook. Scientific support remains qualified prose, not a
property established by a link.

The scientist reads and edits these with Pi's existing file tools. Its standing
instructions say to consult the notebook before scientific decisions and after
compaction, and update it after meaningful results. Only those short instructions
are included in the prompt; notebook contents are read on demand. The instructions
guide the agent; they do not enforce that it reads or updates every page.

Original trial measurements, programs and artifacts stay at their actual paths
(for example `output/trials/001/`); notebook pages link to them. Findings distinguish
observations, interpretations, scope and contrary evidence. Topic pages can be
added when useful. There is no separate notebook skill or compaction implementation.
Existing user `MEMORY.md` files are left intact; Autofold's scientific notebook lives
under `notebook/`.

## Proto

The agent writes Python files and runs them through its native bash tool. A small
standard-library runner can capture a campaign trial before executing an ordinary
command; there is no execution worker or scheduler.
Select a Python environment with `proto_language` and its dependencies installed:

```sh
export PROTO_PYTHON=/absolute/path/to/proto/environment/bin/python
"$PROTO_PYTHON" -c 'import proto_language; print(proto_language.__file__)'
"$PROTO_PYTHON" examples/hello_proto.py
npm run agent -- --workspace ../autofold-campaigns/example "Load the Proto skill and author a native program for my task."
```

The starter is a CPU-only DNA search demonstrating native composition. It makes
no provider or GPU calls. Protein-model programs need their own installed models,
weights and compute environment. An existing local interpreter, when available,
is `.autofold/envs/proto/bin/python`; Python dependencies are not installed by npm.

The optional [BoltzGen registry extension](../backend/engine/skills/proto-discovery/references/generative-design.md)
lets native Proto programs generate target-conditioned peptide backbones and
sequences using an independently installed BoltzGen environment. Import the
extension explicitly and capture it with the authored program; importing it does
not install or load models. With a Proto environment, its offline bridge tests run
with `"$PROTO_PYTHON" -m unittest discover -s backend/engine/tests -p 'test_*generator*.py'`.
The same extension provides `rfd4-binder` for an independently installed RFD4-Proteina
CLI and pinned local weights. It generates sequences and all-atom structures jointly,
verifies target/chain identity, and preserves outputs. Plain generation is the default;
optional native beam search uses captured local structural rewards without a refolding
oracle. See the generation reference for its condition-spec and readiness contract.

The scientist's [model menu](../backend/engine/skills/proto-discovery/references/models.md)
lists the five exercised core models and the native RFAntibody/AntiFold proposal adapters.
The inspection helper includes bundled generator/assessment extensions automatically; authored
Programs still import the selected module explicitly. Inspecting metadata never installs
model assets. Antibody adapters use one mutable chain with fixed partner context;
see the generation reference for runtime requirements and current limits.

[Local evaluation](../backend/engine/skills/proto-discovery/references/local-evaluation.md)
adds a CPU `prodigy-affinity` tool usable inside native Proto constraints and an
offline environment profile for native ESMFold2-Fast prediction. Both run on owned
hardware without inference API charges. ESMFold2 needs the retained compatibility
patch, separately downloaded MIT weights and explicit local asset paths; model
assets are not installed by npm. PRODIGY returns a pose-conditioned empirical
DeltaG/Kd estimate, not measured binding affinity. Preserve it separately from
structural confidence and challenge apparent improvements across poses/models.
The retained [tool timing fix](../backend/engine/patches/proto-tool-monotonic-time.patch)
uses a monotonic duration clock so wall-clock corrections cannot discard outputs;
fresh Proto installations need this patch as well.

The native NSGA-II/filter fix is retained in [proto-nsga2-filters.patch](../backend/engine/patches/proto-nsga2-filters.patch).
Fresh dependency installations need that fix until it is incorporated upstream.
It ranks rejected proposals last without fabricated scores and excludes them from
accepted results. The patch includes native CPU regressions.

## Captured trials

Use one workspace per campaign, with its objective and assessment revisions in
`campaign.md`. Keep editable program bundles under `programs/`. The runner requires
Python 3.11+ on Linux or macOS and adds no Python dependencies:

```sh
npm run trial -- --campaign /path/to/campaign --prepare
# Write plan.md in the returned output/trials/t-ID directory, then:
npm run trial -- --campaign /path/to/campaign --trial output/trials/t-ID \
  --program programs/baseline --input target.json=inputs/target.json \
  --intent "Establish a baseline" --evaluation E1 --timeout 300 -- \
  /path/to/python program/main.py
```

The permanent trial address is allocated before its standalone plan is authored.
The plan records the question, qualified evidence, model/measurement/search choice,
an alternative and discriminating outcomes. Evidence links point directly to preserved
campaign sources and earlier trials; notebook links explicitly navigate to current
understanding. There is no context mirror or whole-notebook snapshot in new trials.
Export the campaign as the archive unit, retaining its relative links.

The command runs at the trial root with captured `program/`, runtime `inputs/` and
writable `output/`. The frozen pre-execution `trial.json` schema 2 records command,
intent, optional evaluation, timeout, environment, origin paths and captured hashes.
`brief.md` quotes the campaign text at launch; links inside that quoted text are
not canonical citations. `execution.json` records process state and final saved
output/log hashes, including partial work on failure or interruption. The runner
never retries or reuses an attempted trial address.

After inspecting the evidence, the scientist drafts an assessment outside captured
trials, with measurements, interpretation, limitations and its initial next decision:

```sh
python3 backend/engine/scripts/run_trial.py --campaign PATH \
  --trial output/trials/t-ID --assess programs/assessments/t-ID.md
```

This exclusively creates read-only `assessment.md` and a hash/timestamp receipt,
`assessment.json`. A completed
execution can have an assessment pending; neither process exit nor file hashes
establish scientific validity. Later corrections update the notebook and cite the
preserved assessment and correcting evidence. Actual data consumed from an earlier
trial is copied via `--input`; scientific citations alone do not duplicate artifacts.
Pi blocks direct assessment/receipt writes and edits, verifies after mutating tools
and at handoff, and reports integrity failures. The runner verifies before further
trial preparation/execution; `--verify-assessments` checks explicitly before handoff.
Legacy assessments without receipts need operator review, not automatic migration.
Unrestricted Bash can bypass permissions or rewrite receipts; this is accidental-edit
protection and change detection, not a security sandbox. Other captured records
remain preserved by convention. The runner checks whether captured files changed
during execution and inventories saved outputs;
it cannot capture model responses that the program never persisted.

The timeout terminates the launched local process group. Programs must await their
work. A killed runner can leave stale status, and local exit does not establish
the state of detached remote work. Inspect uncertain work before launching a
replacement. SSH transport and remote-job recovery are not implemented by this
runner. Environment capture records discovered Proto source commits, not every
dependency, model weight or cache hit; programs must retain relevant model details.

## Proto skill

The bundled `proto-discovery` skill is registered through Pi's native resource
loader, including when `--workspace` points outside this repository. Pi sees its
short description first and reads the instructions and references on demand.
Use `/skill:proto-discovery` in the terminal UI to select it explicitly.

The skill connects objectives to generators, constraints, optimizers and trial
types. Separate references cover scientific interpretation, parameter tradeoffs,
installed API discovery, validation and target-aware cycling. Its small inspection
helper reads native registries without executing models. A focused conditioning
example preserves target/binder chain identity and requests binder-only redesign;
it supplies no binding thresholds or complete discovery protocol.

The skill and helper live in `backend/engine/skills/proto-discovery/`.
The target-aware handoff is checked with real native objects and CPU substitutes;
actual learned-model behavior requires a separate model-backed smoke test.

## Scientific research

The bundled `scientific-research` skill helps Pi investigate a focused uncertainty,
assess applicability and record what the evidence changes in the existing notebook.
It uses ordinary bash/read/write tools; there is no separate research agent or
controller. Its Python 3.11+ standard-library helper searches Europe PMC, UniProt
and experimental RCSB PDB entries, then captures selected records:

```sh
python3 backend/engine/skills/scientific-research/scripts/research.py search 'your query' --workspace /path/to/campaign
python3 backend/engine/skills/scientific-research/scripts/research.py fetch MED/36108050 --full-text --workspace /path/to/campaign
python3 backend/engine/skills/scientific-research/scripts/research.py uniprot fetch P05067 --workspace /path/to/campaign
python3 backend/engine/skills/scientific-research/scripts/research.py pdb search --uniprot P05067 --workspace /path/to/campaign
python3 backend/engine/skills/scientific-research/scripts/research.py pdb fetch 1AAP --assembly 1 --workspace /path/to/campaign
```

Each command creates a separate capture under `sources/<provider>/`, preserving raw
responses, request metadata and failures. Successful fetches add readable text,
artifact hashes and an explicit `abstract`, `full_text` or `metadata_only` scope.
Unavailable full text stays explicit; malformed responses and transport failures
exit nonzero. UniProt captures retain annotation evidence and full-record sequence;
PDB captures include entity sequences, chain/reference mappings and unchanged mmCIF.
Without an explicit assembly, PDB fetch returns deposited coordinates. Retrieval
does not select a mature chain, prepare structures or replace campaign inputs.
These adapters do not cover arbitrary websites or all publisher full text.
Evidence interpretation and notebook updates remain scientist
responsibilities, guided by the skill rather than enforced by a new schema.

Before handoff, guidance asks the scientist to compare consequential saved assertions
with exact source passages and execution artifacts. Pages stay focused; actual source
limitations replace generic caveat checklists, and planned results cannot support a
finding before they exist. The [native link-verification command](../backend/engine/skills/scientific-research/references/link-verification.md)
runs through ordinary bash/Python against selected live or captured Markdown files.
It checks file targets and root boundaries, not heading anchors or scientific meaning.
The command is regression-tested as documented; there is no new registered tool,
review controller or automatic dependency collector.

An investigation page keeps observations and qualified interpretation in distinct
sections, followed by the next decision and dated consequential corrections.
Index/questions link to it rather than duplicating the evidence. A research-informed
trial's permanent plan.md explains the decision using direct source and prior-trial
citations. Its assessment.md preserves the initial interpretation after inspection.
Current notebook links provide navigation; the trial plan must retain the actual
historical reasoning. The runner captures runtime inputs, not every cited scientific
record. Sources and previous trials stay once in the campaign; no recursive capture
or graph service is needed. Existing older context-based trials remain unchanged.

## Embed

```ts
import { createAutofold } from '@autofold/engine'

const runtime = await createAutofold({ cwd: '/absolute/path/to/research' })
try {
  await runtime.session.prompt('Inspect this environment and write a Proto program.')
  console.log(runtime.session.getLastAssistantText())
} finally {
  await runtime.dispose()
}
```

`createAutofold()` returns Pi's native `AgentSessionRuntime`. The integration adds
a short authoring brief, the bundled skills, missing notebook pages and the workspace
session directory.

The `delegate` tool awaits up to two read-only Pi investigators/reviewers. Helpers
inherit the current model, receive explicit questions/evidence rather than full
conversation history, and return reports with usage and native session references.
The head owns execution, notebook reconciliation and promotion. No helper has shell,
write or recursive delegation tools. Records live under `.autofold/helpers/`.
Defaults per campaign: four helper tasks, 16 assistant turns per task, three minutes
per task and $0.25 estimated total helper usage. Each response is capped at 16,384
tokens (including reasoning), or the model's lower limit. Cost is checked after responses;
in-flight responses can exceed it. Reserve this allowance from the campaign budget
and account for returned costs separately from parent session statistics.
Pass `delegation: false` to disable, or configure `delegation: { maxTasks: 4,
maxCostUsd: 0.2, maxTurns: 12, timeoutMs: 120000 }` in `createAutofold()`.

## Validation

Run these commands from the repository root:

```sh
npm test
npm run typecheck
# With the Proto interpreter selected above, run the offline native handoff checks:
"$PROTO_PYTHON" backend/engine/tests/test_proto_skill.py
# Native Pareto selection and full prediction/PAE capture, using CPU substitutes:
"$PROTO_PYTHON" backend/engine/tests/test_proto_scoring.py
"$PROTO_PYTHON" backend/engine/tests/test_prediction_capture.py
# Shared RMSD and mapped cross-chain PAE arithmetic (NumPy; no model calls):
"$PROTO_PYTHON" backend/engine/tests/test_structure_measurements.py
# Source-informed native selection and preserved research-to-trial inputs:
"$PROTO_PYTHON" backend/engine/tests/test_research_handoff.py
```

Research regressions use a loopback HTTP fixture server; the default tests make
no external requests or model calls. Live provider/API checks belong in separate
campaign workspaces.
