# Native Proto GPU validation after wire fix — October 11, 2026

The newly authorized single trial passed exact host/Python bundle validation and reached the GPU-backed native objective. **One Boltz2 API request completed**, but the operator-authored fixture then failed while selecting its objective component. It produced no complete native search receipt, final candidate submission, frozen-panel evaluation or final score. This is a fixture configuration failure, not a scientifically invalid score or a coordinator crash.

The pinned Boltz binding constraint selects `protein_iptm` when it is positive, otherwise `iptm`. It builds a penalty only for the selected branch. The fixture requested `return_component="iptm"`, which the configuration schema permits, but that return component is unavailable when the primary protein metric is selected. The GPU call completed before the error `Requested component 'iptm' not available`.

The immutable call ledger records one completed CPU mutation request and one completed `boltz2-prediction` request, with typed input/config/output hashes. The original worker log records Boltz2 execution. API request counts include possible native caches; cache origin was not observed. The numerical model output was in the terminated process and is not available in a complete scientific receipt, so its metric values remain unknown. No score or recovered tool return is invented. Original run wall time is approximately 44 seconds; GPU-only duration and monetary cost are unmetered. LLM requests and recorded inference cost are zero.

The original run and trial are canonically failed. The receipt-bound supervisor is terminal, and worker processes, GPU compute processes and local driver/caffeinate are absent. The one-trial grant is closed, with zero retries/replacement dispatches. Nine prior workspaces, including the first serialization-failure workspace, remain exactly unchanged. Production/worker source and dependency pins remained unchanged throughout this validation and its closeout.

The corrected fixture uses native `total_penalty`, weights only `protein_iptm` and `iptm`, and supplies unit target/tolerance for both. This gives `1 - selected_interface_confidence` for the metric actually chosen by the pinned constraint, while retaining that component identity in native metadata. It rejects absent interface evidence. This is a computational search diagnostic, not measured binding affinity.

Offline validation reproduced the old fixture error, checked positive-primary and zero/absent-primary fallback cases, and verified missing evidence rejects. The complete corrected native program ran with mocked Boltz outputs: two stages, two history rows per stage, two mocked Boltz requests, one binder and unchanged fixed target. A registry guard prohibited real learned-model dispatch. These are mocked CPU checks, not successful live GPU acceptance. No further GPU trial was launched after this correction.

Original run: `run_28c5edaf2784dcb5ec9a82801479b2673d1197fa48554c9c160a01adb8c0266c`.
Original trial: `trl_95534b1260284105884f505f1585aaa7`.
Authorized launch: `2026-10-11T15:35:02.734Z`; original deadline: `2026-10-11T16:20:02.734Z` (11:20:02 America/Chicago). No reset or extension.

Evidence: `.autofold/native-proto-gpu-validation-fixed-20261011/operator/` contains portable-bundle preflight, original failed state, original generation log, native call ledger, shutdown proof, historical snapshots, grant closeout, corrected fixture, offline test/log and post-closeout fixture verification. The [earlier serialization failure](native-proto-gpu-validation-2026-10-11.md) remains separately preserved.
