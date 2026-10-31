# Validate the method and retain usable evidence

## Before scale-up

For the captured-trial runner, command cwd is the trial root containing `program/`,
`inputs/` and `output/`. Resolve configured paths once; `inputs/target.json` means
`Path.cwd() / value`, with no second `inputs/` prefix. Resolve required files before
expensive calls. A `--check-inputs` mode can exercise actual loading without inference;
keep executable settings in the configuration the program really reads.

Check imports and construct the exact program in the intended interpreter; importing
authored code is not a sandbox. Inspect the actual design space, chains, proposal
coverage and budget. Exercise a small handoff through native input conversion,
output parsing and export, including rejection. Check the [molecular contract](molecular-contract.md)
rather than assuming a successful schema construction preserves chemistry. CPU
substitutes prove wiring, not GPU readiness or biological validity.

Exercise a scorer on retained responses before a prediction batch. After calculation
failure, reuse saved predictions before requesting replacements. Missing inputs,
unsupported chemistry or unavailable measurements are execution/evidence gaps, not
bad candidate scores. Record a changed scientific question if replacing a decisive
measurement with a proxy; cache reuse is not independent measurement.

## A trial as files

Use the [shared record contract](../../scientific-research/references/notebook-contract.md)
for prepared trial addresses, frozen plans/inputs, assessment commits and notebook
corrections. The runner inventories files actually saved; it cannot retain model
responses left only in memory. Native `Program.export` and histories are useful but
may omit discarded proposals.

For prediction capture, copy the [response writer](../examples/prediction_capture.py)
into the source bundle or verify equivalent native retention. Call
`predict_captured(..., capture_dir=...)` inside shared prediction constraints or
assessments. It returns `(native_output, capture_directory)` and saves complete
requests/configuration, responses, actual PAE and native-format coordinates; it
neither caches nor selects. Name exports from `Structure.structure_format`; do not
label CIF as PDB. Coordinates alone need not preserve chemical connectivity.

Read a discarded candidate's full response and PAE back from disk. Reconcile requested,
returned, rejected and failed counts. Requested missing/nonfinite PAE is a capture/
measurement failure; an unfinished request records interruption, not a completed
prediction. Record actual seed support, relevant model versions and observed usage;
reserved time is not measured GPU utilization. Derived calculations and post-hoc
analyses follow the record contract rather than changing the original procedure.
Confirm native operations and enabled phases from captured settings/logs: parameters
for a disabled refinement or search phase do not establish that it ran.

## Native compatibility checks

Exercise a rejected proposal in CPU wiring checks; infrastructure owns compatibility
patches. Rejected members have no objective
vector, rank after eligible members and are excluded from results. They may fill
unused working-population slots; fewer than requested results, including zero, can
return. Missing/fallback/nonfinite objectives on eligible members still raise.
Check the execution version; an all-passing run cannot validate this case.

For scientific follow-ups, use the [investigation table](science.md#choose-an-investigation-when-fitness-is-questionable)
and [promotion guidance](science.md#promotion-and-claims). Distinguish a broken
handoff from a rejected biological hypothesis before spending on another batch.
