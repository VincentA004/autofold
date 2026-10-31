# Bounded lab advice

Use `delegate` when an alternative investigation or independent review could change
the next decision. It awaits one or two helpers concurrently, inheriting the current
model/thinking level without copying the head's conversation.

Give each task a precise question and campaign-relative evidence paths. Investigators
propose a discriminating hypothesis/trial or draft code; reviewers check claims,
measurements and proposed decisions against original artifacts. For independent
judgment, provide the underlying evidence rather than the head's preferred verdict.
Ask one decision per helper, not a duplicate full campaign review. Neither role
needs to agree or invent objections; separate decision-changing errors from optional
checks, and accept supported provisional conclusions without demanding every metric improve.

Helpers have only native read access to non-hidden campaign files and bundled skills.
They cannot execute, write, launch GPU work or delegate. The tool retains each prompt,
native session, report and result under `.autofold/helpers/`. A report is advice, not
an executed trial or primary evidence. Check consequential claims and code; incorporate
accepted reasoning into the existing notebook with original source/trial links.

Limits cover the campaign's helper calls, turns, wall time and estimated cost. Check
returned status: incomplete reports cannot stand in for completed reviews. Reserve
helper allowance from the campaign LLM budget and include actual helper usage in
the log; parent Pi session statistics do not include child usage. Count per-result
costs once, or use the cumulative total, not both. GPU work remains sequential with
the head through the existing runner. Do not create a separate notebook or trial
lifecycle for advice.
