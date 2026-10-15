# Native Proto GPU validation — October 11, 2026

The single admitted engineering trial failed at worker startup, before scientific model execution. GPU validation has **not passed**. The original remote worker exited 2 with `Pipeline policy hash does not match its canonical content`; its run and trial are canonically failed, the exact original supervisor is terminal, and no original worker, GPU compute or local driver process remains. No retry, replacement, LLM inference or SDK session occurred. Recorded inference is $0; GPU monetary cost is not metered.

The failure was a cross-language serialization defect: a native optimizer temperature was rendered as `0.00001` by ECMAScript and `1e-05` by Python, producing different hashes for the same policy. It occurred at `validate_bundle`, before loading the evaluator or executing the native program. It is an integration failure, not a scientific invalid score. No candidate was generated and no final score exists.

After closing the original grant and verifying shutdown, the main-checkout fix added an exact canonical host JSON byte binding to new native bundles. The worker verifies the full parsed policy matches those bytes, then checks their hash. The host schema requires its exact canonical serialization. Historical bundles retain their original verification path and hashes; the failed original bundle, frozen worker and logs remain unchanged. No model parameters were adjusted to evade the failure.

Offline regression uses a copy of the original bundle: the old error reproduces, and the new byte binding validates without importing/executing protein models. Unicode, numeric object keys, small/exponent-form numbers and nested types are covered; changed policies, duplicate keys, nonfinite inputs and oversized byte strings reject. **349 checks passed** (195 scientific core, 54 execution, 100 worker), with two optional skips and both backend typechecks passing. No additional GPU work was launched after the fix.

The planned fixture had two native MCMC stages sharing a fixed target and binder: CPU sequence constraints, then a Boltz2 interface-confidence penalty, with fresh instances of the same mutation generator. It selected only the binder region for the independently frozen Boltz2/Chai1 final panel. This operator-authored engineering fixture was not an autonomous scientific discovery or a binding assay. Those live behaviors remain untested by this failed attempt.

The conservative grant was one trial, 600 GPU seconds, a 15-minute worker limit and a 45-minute fixed deadline. Its unused authority is closed; no extension or ordinary retry was made. Eight historical workspaces match their exact prelaunch database/file snapshots. The monitor remains paused.

Original run: `run_a36fdea6428c2063572f92fb6dbd79c0f721873571158fb72d216c9a429216b7`.
Original trial: `trl_91c884c2186c4b18985adfb5b45dfeda`.
Original launch: `2026-10-11T15:19:16.694Z`; original deadline: `2026-10-11T16:04:16.694Z` (11:04:16 America/Chicago).

Evidence is preserved under `.autofold/native-proto-gpu-validation-20261011/operator/`: preparation, launch fence, held error, original remote error, shutdown evidence, historical snapshots, grant closeout and post-closeout wire-fix verification. No successful manifest, settlement receipt or GPU score is invented.
