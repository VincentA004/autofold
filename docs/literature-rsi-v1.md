# Literature RSI v1

Autofold can run a bounded campaign-scoped literature review through a dynamic
child agent. The agent receives the campaign objective, optional focused
question, active experiments, verified run outcomes, existing literature, and
existing claims. It can use only the scientific literature tools plus a single
review artifact path.

```text
campaign objective or knowledge gap
  -> dynamic literature-review child
  -> multi-database search
  -> selected-record fetch
  -> exact evidence excerpts
  -> schema and transcript verification
  -> atomic source + proposed-claim ingestion
  -> campaign OKF publication
  -> experiment RSI context
```

## Trust boundary

The child may propose claims but cannot review them. Every cited excerpt must:

1. appear in the proposal source's frozen excerpt list;
2. occur verbatim in the completed `science_fetch` output for that exact
   database and record ID, or in the corresponding read of a spilled fetch;
3. remain linked to the immutable, content-addressed literature record.

The backend rejects the complete review before persistence when a source was
not fetched, an excerpt is absent, a source key is unknown, or source/claim
budgets are exceeded. A review that finds no support may return zero claims but
must preserve at least one unresolved question. Literature confidence is an
agent estimate and never substitutes for the locked experiment score.

## CLI

```text
bun run research:cli -- literature review CMP_ID \
  --session SES_ID \
  --question "Which interface constraints improve selectivity?" \
  --max-sources 20 \
  --max-claims 20
```

Accepted claims remain `proposed` until a separate reviewer marks them
`reviewed`, `contested`, or `deprecated`.
