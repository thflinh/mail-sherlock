# Sherlock: 30-day conversational email RAG pilot

Date: 2026-11-15  
Status: Revised for a small pilot; implementation pending.

## Purpose

**Ask about your last 30 days of email, refreshed when you open Sherlock.**

Build for a small group with 2–3 concurrent questions and typically fewer than 500 messages per account. Five hundred is expected volume, not a limit. Support English received/sent/archived message text; exclude Spam and Trash. Attachment contents and OCR are deferred.

First deliver find, answer/extract, and follow-ups with citations. Then introduce General Search and Job Search guidance, followed by Purchases, Conversations & Commitments, timelines, and comparisons. All modes share one index.

This revision replaces the previous infrastructure-heavy pilot plan and supersedes the full-history assumptions in `PLAN-RAG.md`. Concrete tasks are in `IMPLEMENTATION-RAG-30-DAY-ASSISTANT.md`. The architecture guide describes the original implementation.

## Fixed requirements

- Enforce a rolling 30 × 24-hour window on every email read. No expansion setting or older-mail fallback.
- Refresh on authenticated page entry and manual Refresh; no recurring Gmail ingestion while the app is closed.
- Keep ready indexed messages usable during refresh and expose partial coverage.
- Persist and reuse embeddings. Re-embed only missing/changed content or deliberately changed processing versions.
- Cite factual email claims and explicitly clarify/abstain when evidence is missing.
- Keep ownership, account selection, and cutoff enforcement in application code.
- Use LangChain directly for embeddings and structured query/answer calls.
- Target ordinary warm answers within 8–10 seconds with 2–3 concurrent requests; validate through measurements.
- Target USD 10/month total operating cost; actual hosting feasibility remains unverified.

## Architecture and stack

```text
Page open / Refresh
  -> one account sync task
  -> list IDs and reconcile metadata
  -> fetch missing text -> normalize -> chunk -> embed
  -> existing MongoDB emails + email_chunks

Question + eligible conversation context
  -> optional structured rewrite/filter interpretation
  -> scoped exact vector search + BM25 -> rank fusion
  -> bounded evidence -> structured answer -> citation validation
```

Keep FastAPI, React/Vite, and MongoDB. Use one application process with bounded background work and per-account task locks. Persist account progress and per-email indexing status for repair. Retain existing API routes and extend their contracts.

Start with complete eligible chunk vectors scored through NumPy, BM25 over full chunks, and reciprocal-rank fusion. Remove the existing candidate cap, truncated search corpus, and count-based cache reuse. A separate vector database is deferred until benchmarks justify its cost.

Keep MiniLM as the comparison baseline. Benchmark PyTorch versus an ONNX implementation early, including tokenizer behavior, retrieval quality, memory, and latency. Use LangChain at two or three direct integration points, without a generic adapter/facade hierarchy.

Hosted Gemini remains the proposed generation provider. The live app already sends email content to Gemini: answer prompts include up to 8,000 characters of an email body, and sync sends sender, subject, and a 200-character preview for emails that keyword rules do not label. The data-sharing decision therefore covers the current deployment, not only new work: record it as accepted, or restrict both paths before inviting testers. Use synthetic inputs for new provider tests until it is recorded. Local embeddings do not make hosted generation local.

## Early deployment and cost checks

Repository documents describe EC2 `t3.small` and MongoDB Atlas; verify the live resources rather than treating documentation as deployment evidence. The historical instance estimate already exceeds USD 10/month. Check compute, disk, public IP/network, database, backups, provider usage, and expiring credits before claiming budget compliance.

Measure model memory before choosing instance size. ONNX may help, but savings and concurrency capacity require testing. Avoid a GPU, separate paid vector service, paid queue, or paid tracing platform initially.

Verify OAuth consent status before inviting testers. External Testing configurations generally issue seven-day refresh tokens for Gmail scopes. Verification/assessment requirements depend on application circumstances and exceptions; changing publishing status alone does not resolve every requirement.

## Sync and indexing

On each refresh, list and compare the complete current-window message set with pagination. Fetch full messages only for new IDs; repair incomplete indexing from stored bodies. A message's `internalDate` and content do not change, and deletion or a move to Spam/Trash shows up as absence from the listing. Refresh unread state for existing IDs with one additional listing of unread messages in the same window, so a routine refresh makes no per-message Gmail calls for known IDs. Only infer removals after a complete successful listing, and verify uncertain absences when provider listing races are possible.

A conservative provider date buffer may be used during ID discovery, but the exact server cutoff must be applied before indexing or serving content. No Gmail history cursor/replay machinery initially. Mail arriving during a scan may appear next refresh; show freshness rather than promise real-time coverage.

Extend existing email/chunk/account records with content hashes, versions, timestamps/expiry, indexing state, counts, and errors. Ready unchanged records reuse vectors. Pending/indexing/failed records are retried even if hashes match.

Compute replacement chunks first, mark the parent unavailable for retrieval while replacing chunks, validate completeness, then mark ready. A crash can temporarily hide that email but must never expose partial evidence as a complete index. The next refresh repairs it. Use deterministic IDs and idempotent writes.

One process means per-account `asyncio.Lock` and active-task tracking suffice for sync coordination. Clear stale active status on restart; repair begins on the next refresh. Multiple workers or overlapping deployment writers require revisiting this design before enabling them.

## Chunking and querying

Normalize full MIME/HTML bodies, preserving paragraphs, lists, tables, and quoted-reply attribution. Pack structural blocks within the embedding tokenizer limit, including prefix/special-token overhead. Split oversized blocks by sentences, then tokens. Preserve source offsets and use measured overlap. Remove the fixed 80-chunk cutoff and whitespace termination bug.

Query understanding may rewrite ambiguous follow-ups and propose structured filters in one call. Preserve exact identifiers for lexical retrieval. Explicit result references outrank an implicitly open email. Model output cannot supply ownership or widen the 30-day scope.

Initially support find, answer/extract, and follow-ups. Defer universal query decomposition and additional reranker calls. Add timeline/comparison routes after basic accuracy is established. Exhaustive lists require paginated coverage checks; top-k matches cannot establish completeness.

## Citations, scope, and retention

Use the authoritative Gmail internal timestamp in UTC for eligibility. Current records store only the `Date` header, so Milestone 1 saves `internalDate` at ingest and backfills existing records before enforcing the cutoff; otherwise enforcement would hide all indexed mail until the Milestone 3 reconciliation. Enforce scope on search, reader endpoints, prior result IDs, source citations, and thread expansion. Newer emails quoting older events retain attribution but do not permit fetching the older originals.

Give the model local source IDs such as `S1`; only the server maps them to actual scoped messages/spans. Validate returned IDs, dates, ownership, and quoted text. Evaluate whether evidence supports claims separately from citation existence. Greetings and abstentions do not need fabricated sources.

TTL indexes help physically delete expired emails/chunks but are asynchronous. Read-time filtering immediately blocks expired evidence. A simple periodic cleanup task handles stale caches and dependent generated content without contacting Gmail.

Today the browser sends the full history, including assistant text, with each chat request and saves whole conversations itself. Move conversation ownership to the server: it persists each assistant turn with its source IDs when generation finishes and builds prompt history from its stored copy. Client-supplied assistant text never enters a prompt.

Store source dependencies per assistant turn. If any source expires or is deleted, omit/redact the whole affected turn and show an unavailable marker. Claim-level redaction is deferred. Expiring conversations by their creation date alone is insufficient because cited mail may expire sooner.

## Five milestones

1. **Fix current correctness:** filters, cache identity, reference precedence, `internalDate` backfill, and common cutoff enforcement. Build the 30-question set and record a retrieval baseline. Run early AWS/OAuth/memory checks alongside this work.
2. **Index full text:** normalization, structural chunks, reusable embeddings, incomplete-index repair, exact dense/BM25 retrieval, and rank fusion.
3. **Refresh on page entry:** full listing/reconciliation, metadata updates, per-account locking, persisted progress, manual refresh, and partial coverage UI.
4. **Deliver cited conversations:** direct LangChain integration, structured generation, validated source mapping, server-owned conversation turns, follow-ups, and answer/citation scoring on the evaluation set.
5. **Add modes and measured improvements:** purpose guidance, timelines/comparisons, exhaustive lists, and optional reranking/model changes supported by evaluation.

Each milestone delivers a usable improvement. Do not make six infrastructure PRs a prerequisite for improving answers.

## Evaluation and rollout

Begin in Milestone 1 with 30 labeled synthetic/anonymized questions covering exact facts, deep-body evidence, follow-ups, filters, missing answers, dates, and expiry. Record the current system's retrieval results before Milestone 2 changes chunking and retrieval, so later changes have a baseline. Reserve some threads for evaluation rather than tuning on all examples. Report counts of correct answers, retrieval hits, unsupported claims, invalid citations, and incorrect abstentions. Expand the set as capabilities grow; a 100-question release gate is deferred.

Ownership/date enforcement, valid citation IDs, correct filters, and no silent pagination omissions are mandatory deterministic checks from the start. Measure warm/cold latency, concurrent ingestion impact, memory, storage, provider calls/tokens, and repeat-sync embedding reuse. Thirty examples are a baseline, not a statistical reliability guarantee.

Back up before schema/rebuild changes. Preserve accounts, credentials, and conversations; rebuild only scoped email/chunk data using normal ingestion logic. Full resets are reserved for explicitly disposable development data. Keep cutoff checks during rollback and apply retention before serving restored backups.

## Deferred infrastructure

- Distributed workers, lease fencing/heartbeats, durable outboxes, and cross-store deletion acknowledgments.
- Dedicated vector service, queue service, and a generic migration framework.
- API v2, shadow traffic, and per-user rollout flags.
- GraphRAG, vLLM, autonomous agent loops, browser extension/MCP, and automated external actions.

Revisit these based on measured need. Correct authorization, complete reconciliation, repairable indexing, and expiry checks remain essential.

## Completion checklist

- [ ] Scope, filters, references, and full-body retrieval are correct.
- [ ] Embeddings persist and incomplete indexing is repaired without duplicates.
- [ ] Page-open refresh keeps existing ready content usable and updates metadata.
- [ ] Answers and follow-ups cite eligible supporting evidence or abstain.
- [ ] Thirty-question results and concurrency/resource measurements are recorded.
- [ ] Actual budget and OAuth behavior are verified; provider data-sharing is recorded for the live app before private pilot rollout.
- [ ] Additional modes and retrieval techniques have relevant tests before enabling them.

## References

- [Google OAuth expiration](https://developers.google.com/identity/protocols/oauth2)
- [Restricted-scope verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [AWS pricing components](https://aws.amazon.com/ec2/pricing/on-demand/)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)
