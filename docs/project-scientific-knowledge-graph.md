# Project scientific knowledge graph — first implementation, October 8, 2026

Status: implemented on the main checkout; offline verification is recorded separately below. This is a retrieval layer around the existing scientific records, not a new execution harness or a replacement for canonical evidence storage.

## Graph and permanent storage

Authoritative records remain in the existing transactional project SQLite store. A deterministic graph projection exposes campaigns, scientific charters, bounded operation provenance, experiments, trials, runs, evaluations, receipt closeouts, papers, claims, alignments, hypotheses, scientist interpretations, knowledge cycles and skill versions. Exact target artifact hashes, candidate amino-acid sequences and recorded configuration fingerprints provide shared scientific entity identities. Relationships are derived from persisted record references; no LLM enrichment or graph-ingestion job is needed to preserve an experiment. Repeated reads and restarts produce the same identities and snapshot hash. Failed transactions leave the previous snapshot intact.

The graph traverses campaigns belonging to the bound project in that store. It does not search unrelated projects, scan other workspaces, or silently import historical acceptance data. Future discovery campaigns must reuse the same durable project/store for accumulated scientific memory. The historical campaign-per-project acceptance workspaces remain separate; bringing their evidence into a common project requires an explicit provenance-preserving import. Target identity uses exact artifact hashes; matching target names, changed structures, epitope aliases and scaffold ontology require later explicit entity reconciliation.

Nodes retain lifecycle labels, original record hashes and applicability. Structural links connect trials to configurations, runs to trials, evaluations to runs, observations to candidate sequences, and knowledge summaries to their evidence. Claim/source, supporting/opposing hypothesis, alignment and procedural-learning links retain their interpretation status and originating record hash. A `refutes` alignment does not become a measured fact. Candidate-sequence identity does not imply binding or scaffold equivalence. Other-contract scores remain non-comparable.

## Agent working context

The persistent native scientist receives a bounded graph brief and exact focus target ID in `read_context.knowledgeGraph`, and three tools:

- `search_graph`: keyword search with kind filters, pagination and lifecycle selection across the bound project.
- `read_graph_node`: source/receipt identity, original record hash, applicability and bounded details; an optional expected hash rejects stale reads.
- `traverse_graph`: one to four hops, at most forty nodes and 120 edges, relationships in either direction, source paths and explicit truncation. Contradicting links receive priority. Read source nodes for original citation and receipt details; a truncated neighborhood is not evidence of absence.

Graph retrieval is advisory. Missing records or a graph-read failure return an explicit gap, without scheduling literature, cancelling discovery, or changing the current trial allowance. Frozen contract, cancellation, ownership, compute and original receipt guards remain authoritative. Cross-campaign graph references are context for reasoning; they are not automatically valid current-campaign `evidenceRefs`, authorized comparator IDs, or new execution permission. Existing campaign-scoped knowledge readers and skill activation remain unchanged.

## Avoiding prior failures

No graph write, review, enrichment or source fetch becomes mandatory before a trial. The host's canonical closeout supplies deterministic links; semantic assessments can be added separately. Source ingestion and review still use the existing bounded, idempotent, provenance-checked operations. This change adds no online requests, new recipients or automatic enrichment cadence. PubMed/full-text integration into the core scientist remains a separate next slice.

The discovered GPU accounting boundary is also repaired. Frozen allocations are summed in integer seconds; near-integer binary conversion noise is normalized, reservations round upward and grants round downward. Genuine fractional excess does not become free authorization. Campaign scheduling, scientist admission and `beginRun` use the same calculation. Failed or uncertain runs remain charged. Existing reported hour fields are derived from the integer ledger. This whole-second policy is conservative for genuinely fractional-second budgets.

Job failures now preserve bounded structured `NamedError` code/message fields from scientific admission as well as job conflicts. The historical terminal replay was not rewritten, resumed, retried or dispatched.

## Offline acceptance

The graph fixture contains two campaigns on one target, different evaluator contracts, a paper, a proposed claim, a contested refuting alignment, original run/evaluation identities and a missing link. Tests retrieve previous-campaign evidence and its source/receipt hashes, preserve the contradiction and score-applicability distinction, reject foreign-project access and model-supplied scope changes, detect stale revisions and focus tampering, bound traversal, and verify SQLite restart/rollback behavior. Scientist-tool tests prohibit mutation/dispatch during lookup; a simulated graph read failure is followed by a successful native CPU fixture trial with no online research job.

Resource tests admit all fourteen 600-second allocations, including the last slot, then reject a fifteenth allocation. Failed runs remain charged, and an actual 0.01-second shortage is not rounded into permission. A job-service regression preserves the scientific conflict code and its message.

An additional read-only projection successfully loads the thirteen verified executions from the historical long-range evidence workspace without changing it. This proves compatibility with those stored records; it does not merge them into another project or establish new scientific findings.

Current-source product check results and fingerprints are saved under `.autofold/okf-project-graph-20261008/operator/verification.json`. No provider inference or GPU campaign is part of this implementation. Computational CPU fixtures validate software behavior, not biology.

## Next scientific milestones

Use this retrieval in a single persistent scientific project, then evaluate whether connected evidence changes a useful experiment decision. Add bounded literature/full-text retrieval and attributable source transfer, explicit epitope/scaffold entity relationships, richer retrieval ranking, and provenance-preserving cross-store import as separately tested slices. Keyword retrieval and snapshot projection are sufficient for this first acceptance case; indexed/semantic retrieval at larger scale remains future work. Independent knowledge improvement, procedural benefit, long-context compaction and biological validity are not established by these tests.

Final composite verification: **519 product tests passed**, backend/UI typechecks and production UI build passed, with source fingerprint unchanged through these checks. Source `sha256:84bc7425fc7b5dfb97a9d65f66efac735fe49b41b2fbb19998c4bb00cf7da28b`; worker `sha256:0164029d60ac557279981f09b9722ab8a81c0a2f5e6b9e5c601f7bd86f2f47dd`. Evidence is in `.autofold/okf-project-graph-20261008/operator/verification.json`. No current-source live GPU acceptance is claimed.
