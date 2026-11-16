# Sherlock pilot: implementation tasks

Date: 2026-11-15  
Status: Simplified specification; application implementation pending.

This guide implements `PLAN-RAG-30-DAY-ASSISTANT.md` in five milestones and replaces the previous 12-PR distributed-system design. Target one serving process, 2–3 simultaneous chats, and typically fewer than 500 messages/account. Larger eligible sets must still be fully paginated.

## 1. Minimal code structure

Retain existing modules/routes. Add focused helpers only when needed:

| File | Work |
| --- | --- |
| New `email_scope.py` | Authorized account selection, UTC cutoff, common query predicates |
| New `email_sync.py` | Account task/lock, complete reconciliation, persisted progress |
| New `retrieval.py` | Exact dense search, BM25, rank fusion, bounded cache |
| `main.py` | Existing routes and task wiring |
| `reader.py` | Reuse/extend normalization and safe presentation helpers |
| `chunk_index.py` | Structural splitting, token limits, chunk persistence/repair |
| `embeddings.py` | Single model instance and direct LangChain embedding integration |
| `agent_search.py` | Structured query rewriting/filter extraction |
| `agent.py` | Structured generation and citation validation |
| `labels.py` | Keep rule-first labeling; count Gemini fallback calls in usage and cost measurements |
| Dashboard/types | Refresh status, citations, purpose selection, SSE adaptation, send `conv_id` instead of full history |
| `tests/`, `evals/` | Focused regressions and evaluation script |

Avoid a generic service hierarchy, compatibility facades around adapters, new API versions, and a dedicated jobs/outbox collection. Authentication scope is passed explicitly to functions; do not put mutable user identity in a global retriever.

## 2. Milestone 1 — fix current behavior

Tasks:

- [ ] Implement `eligible_filter(owner, accounts, now, requested_filters)` with a controllable UTC clock.
- [ ] Save Gmail `internalDate` as a UTC `message_timestamp` at ingest. Current records store only the `Date` header string.
- [ ] Backfill existing records before enforcing the cutoff (`scripts/backfill_message_timestamps.py`). List each account's message IDs from the last 31 days, then call `messages.get(format=minimal)`, which returns `internalDate` without the body, only for stored records in that list. Records outside it are older than the window, deleted, or in Spam/Trash; they keep no timestamp, so the cutoff excludes them. Skipping this step would hide all indexed mail until Milestone 3.
- [ ] Apply scope on search, reader, prior IDs, citations, and thread reads.
- [ ] Correct hard filters: no matches must return zero, not the previous candidate list. Filter chips (unread, attachment, account) and explicit dates are hard filters; a sender the model infers only boosts ranking, because the guess can be wrong.
- [ ] Intersect requested dates with the last 30 days; enforce Spam/Trash exclusion and sent/archived inclusion.
- [ ] Remove the 1,000-record retrieval cap through complete iteration/pagination.
- [ ] Remove the candidate-count BM25 cache initially; add caching only after correctness.
- [ ] Prioritize explicit ordinal references over open-email state; clarify invalid references.
- [ ] Preserve ownership fields internally until public serialization.
- [ ] Create 30 labeled synthetic/anonymized questions with reference time, scope, expected IDs/spans, expected facts, and answerability. Include filters, no-answer, exact identifiers, deep-body, dates, and follow-ups. Reserve some threads for evaluation rather than tuning on every example.
- [ ] Add one evaluation script that reports retrieval hits/recall per question. Record the current system's results as the baseline before Milestone 2.

Run early AWS resource/billing and OAuth consent checks alongside this work. Measure current model startup/RAM/encoding before deciding instance size. Test a local ONNX implementation as a measured comparison, not an assumed saving. Verify applicable OAuth Testing token expiration and production exceptions before inviting testers. Record the Gemini data-sharing decision for the live app, which already sends answer context and label-classification previews to Gemini.

Acceptance: zero-match, cutoff-edge, unauthorized-ID, expired-source, ordinal-conflict, and >1,000-record regression tests pass. Backfilled records remain searchable, and the retrieval baseline is recorded. Existing lint/typecheck/build remain green.

## 3. Milestone 2 — full bodies, chunks, and hybrid retrieval

### Schema additions

Extend existing collections:

```text
emails:
  scoped identity, message_timestamp, expires_at, full canonical body
  content_hash, indexing_status (pending/indexing/ready/failed)
  indexed_hash, index_version, expected_chunk_count, last_error

email_chunks:
  scoped parent ID, deterministic ordinal/ID, text, start/end offsets
  section/quote attribution, embedding, model/chunker versions
  message_timestamp, expires_at

existing scoped account record:
  sync_status, started_at, last_successful_sync_at
  discovered/ready/failed counts, last_error
```

Use unique scoped email and parent/ordinal chunk indexes, scoped timestamp/parent lookup indexes, and expiry indexes. Audit legacy duplicates/ownership before adding uniqueness. Never merge unrelated users just because account email addresses match.

### Normalize and split

- [ ] Remove ingestion body truncation and pre-storage body deletion.
- [ ] Parse nested MIME with charset handling, usable plain-text preference, and HTML fallback.
- [ ] Preserve paragraphs/lists/tables and reply attribution; exclude attachment contents.
- [ ] Pack structural blocks within the actual model tokenizer limit, reserving prefix/special-token overhead.
- [ ] Split oversized blocks at sentences, then tokens; preserve canonical source offsets.
- [ ] Start testing around 160 content tokens and up to 24 overlap tokens, reduced as needed to fit the actual model. Tune with fixtures.
- [ ] Remove the 80-chunk limit and whitespace-stop behavior. Large mail is processed in batches, never silently truncated.

### Embedding and replacement

Use one local model through direct LangChain integration. Pin tested dependencies/model versions and validate vector count, dimensions, finite values, and tokenizer behavior. Keep the existing MiniLM baseline while comparing runtimes. CPU encoding runs outside the event loop with bounded concurrency.

For each eligible record:

1. Skip only if status is ready, content/processing versions match, and chunks are complete.
2. Compute replacement chunks/vectors before deleting the old ones.
3. Mark the parent indexing and invalidate its cached retrieval membership.
4. Replace chunks with deterministic idempotent writes.
5. Validate count/dimensions, then mark ready with indexed hash/version.
6. On failure leave indexing/failed. Retry on next refresh even when the content hash matches.

One account sync task owns replacements. Retrieval excludes non-ready parents and checks readiness again while assembling evidence. This accepts temporary unavailability of one email during repair; partial state must never appear as a complete index. No outbox or generation-swap framework is required.

### Retrieval

- [ ] Load all ready eligible scoped chunks, not just email previews.
- [ ] Score normalized vectors with exact NumPy dot products.
- [ ] Build BM25 over full chunk text and concise metadata; preserve useful exact identifiers.
- [ ] Fuse rankings using reciprocal-rank fusion, initially `1 / (60 + rank)` per branch.
- [ ] Start with up to 40 hits per branch, merge duplicates, and select bounded diverse evidence.
- [ ] Merge overlapping spans before token budgeting. Do not sort then truncate away the best evidence.
- [ ] Start without a second model reranker; benchmark it later if necessary.

Add bounded caching only after this works. Key by scoped ordered chunk IDs/hashes and processing versions, account/filter selection, and tokenizer version. Invalidate after writes; restart starts with empty caches. Reapply cutoff and eligibility on each read. A process-local invalidation is sufficient under the one-writer deployment assumption.

Acceptance: HTML-only and deep-body facts are retrieved; unchanged messages generate zero embedding calls; distinct equal-sized corpora cannot share scores; failed replacement is excluded and repaired; evaluation-set retrieval is reported against the Milestone 1 baseline.

## 4. Milestone 3 — page-open reconciliation

### Task coordination

Adapt `/emails/sync` to start or return an account task promptly. Use a per-account `asyncio.Lock` and retained active-task map. Persist progress on scoped account records, not a distributed lock protocol. On restart, clear stale activity status and retry incomplete records at the next refresh.

Deploy one API process. Stop the previous writer before replacing the deployment; the EC2 workflow already stops the old container before starting the new one. `railway.toml` is still in the repository, and Railway's default deploys overlap old and new instances, so remove it or leave Railway unused until coordination is revisited. Multiple workers/overlapping writers require a separate coordination design before use. Cancel/await tasks cleanly during shutdown without declaring incomplete work successful.

### Algorithm

1. Capture current time/cutoff and enumerate Gmail IDs with complete pagination. A conservative discovery buffer can avoid date-boundary misses.
2. List unread IDs in the same window with one additional paginated listing, and set unread state on existing records from that set.
3. Fetch full messages only for new IDs, in bounded batches. Take `internalDate` and labels from that fetch, and enforce the exact cutoff and label policy in code before indexing/serving.
4. Repair pending/failed indexing from stored bodies; fetch again only when a body is missing. Ready unchanged content reuses embeddings.
5. Only after complete successful discovery reconcile missing IDs (deleted, moved to Spam/Trash, or aged out). Partial/failed listing never authorizes deletion. Verify uncertain removals individually when listing races are possible.
6. Record counts and last success only when the refresh is complete; expose partial/failed status otherwise.

Existing IDs need no per-message Gmail calls on a routine refresh: `internalDate` and message content do not change, and Spam/Trash/deletion appears as absence from the listing. Each `messages.get` costs 5 quota units against a per-user limit of 250 units per second, so re-fetching 500 messages on every page open would take about 10 seconds and risk rate-limit errors.

No Gmail history cursor/replay initially. Full current-window reconciliation is also the recovery path. New arrivals during listing may appear on the next refresh; expose scan freshness instead of claiming real-time completeness. More than 500 messages requires more pages, not an early stop.

### UI and response fields

Extend existing sync/account responses with status, started/last-success times, discovered/ready/failed counts, and discovery/index completeness. Reuse account status for progress where possible; add one small status route only if needed.

Dashboard authentication/account availability triggers refresh once per entry. Server deduplication handles multiple tabs and React double effects. Poll status while running, then stop. Status polling never initiates another sync. Existing ready results remain usable; an initially empty index displays indexing progress rather than “no matching mail.”

Acceptance: two tabs share one task; unread changes update without embedding; a refresh with no new mail makes no per-message Gmail calls; incomplete discovery cannot delete valid data; restart+refresh repairs partial writes; all eligible pages are covered.

## 5. Milestone 4 — citations and conversational accuracy

### Direct LangChain usage

Use direct embedding and structured model/prompt calls. Add LangChain `Document` objects where useful without requiring a generic retriever hierarchy. Pin integration versions through installation/smoke tests rather than copying unverified API examples.

An optional single planning call produces a validated standalone question, action (`find/answer/extract/clarify/chitchat`), explicit references, and proposed sender/date/unread/attachment filters. Authenticated ownership stays server-supplied. Preserve original identifiers for BM25. Skip the call for deterministic cases; defer universal query splitting.

### Answer flow

1. Resolve explicit references and validate current scope.
2. Retrieve/merge evidence and recheck parent readiness, ownership, and expiry.
3. Assign `S1`, `S2`, etc.; retain actual message IDs/offsets in a server-owned map.
4. Include full resolved question, attribution, and coverage in the prompt.
5. Generate structured `status`, `claims[{text, source_ids}]`, and caveat.
6. Validate IDs, eligibility, and quotes. Invalid citations fail validation; a real source still must support the claim, evaluated separately.
7. Return supported claims, clarification, or insufficient evidence. No source does not mean an event never happened.
8. Persist the turn server-side with its claims and source IDs; these stored dependencies drive retention.

Stream progress through existing SSE. Buffer final factual text until source/schema checks pass; adapt the existing frontend event contract instead of adding API v2. Provider failure must emit an explicit error/terminal state, not successful empty output or duplicated fallback text. Cap retries at one within an overall configurable deadline.

### Retention and conversation reuse

Add TTL expiry to mail/chunks as a cleanup backstop; read-time checks remain authoritative. TTL cannot expire records that still lack `message_timestamp` after the Milestone 1 backfill, so delete those explicitly. Run lightweight cleanup of dependent turns/caches without Gmail calls.

Move conversation ownership to the server. Today the dashboard sends the full history, including assistant text, with each `/chat` request and posts whole conversations to `/chat/history` after each reply; the server stores them as received. Instead, the chat request sends `conv_id` and the new user message, and the server builds prompt history from its stored turns. Keep `/chat/history` for listing, loading, and deleting conversations, but stop accepting client-written turns. Client-supplied assistant text never enters a prompt. Existing saved messages carry `results`; treat those IDs as each legacy turn's dependencies, and treat turns without them as unavailable.

Store source dependencies per assistant turn. If any source expires/deletes, omit/redact the entire affected turn and show unavailable evidence. Conversation-age TTL alone is wrong because a cited email can expire sooner. Claim-level redaction can wait. Keep private text out of routine logs and purge stale prompt/evidence caches.

### Evaluation and CI

Extend the Milestone 1 evaluation script to also print answer correctness, unsupported claims, invalid citations, correct/incorrect abstentions, and latency. Human review checks support; optional LLM judging supplements it. Fake providers run in CI without keys/downloads; live synthetic-provider evaluation is opt-in.

Add backend tests to the existing CI workflow and require them before deployment alongside lint/typecheck/build. Thirty questions give a practical baseline, not statistical guarantees or a mandatory 100-question gate.

Acceptance: find/answer/follow-ups work with valid supporting evidence; ambiguity, missing evidence, and provider errors are visible; an expired source removes its turn from the stored conversation and from the next prompt, even while an open tab still displays it.

## 6. Milestone 5 — modes and measured extensions

- [ ] Add General Search and Job Search guidance over one shared index.
- [ ] Add Purchases and Commitments after core evaluation passes review.
- [ ] Build timelines/comparisons using attributed evidence and normalized event/message dates. A newer proposal is not automatic acceptance.
- [ ] Implement exhaustive lists separately with pagination and coverage; top-k alone cannot mean “all.”
- [ ] Benchmark reranking, alternative models, and optional query decomposition using the same fixtures.
- [ ] Expand evaluation with each added capability; add formal statistical quality gates when dataset size supports them.

Do not delay the first usable pilot for GraphRAG, vLLM, an autonomous agent loop, or a paid vector service.

## 7. Resource verification and recovery

Measure warm p50/p95 completed-answer latency at 2–3 concurrent requests, including concurrent ingestion. Target ordinary warm p95 within 10 seconds; report cold starts and complex tasks separately. Matrix scoring alone is not the latency benchmark.

Benchmark 100/500-message accounts and a larger pagination case. Record peak memory, CPU, chunk counts, stored bytes, model calls/tokens, import time, and unchanged-refresh encodes. Compare ONNX and PyTorch for quality/tokenization/compatibility as well as memory. Runtime/model changes may require reindexing; equal dimensions alone do not prove compatibility.

Check actual AWS/Atlas/model billing against USD 10 including fixed charges, expiring credits, and label-classification calls during sync. Alerts do not stop fixed costs. Record a concrete hosting/budget resolution if current deployment exceeds the target. The Gemini data-sharing decision applies to the live app, which already sends email content in answer prompts and label-classification previews; record it before the private pilot. Synthetic tests can proceed.

Before live rebuilds, back up and inspect identity/timestamp compatibility. Preserve accounts, credentials, and conversations. Rebuild only selected owner/account email/chunk data via normal indexing state; a small scoped maintenance command suffices. Full resets are only for explicitly disposable development data.

Stop the old single writer before deploying the new process, verify health, then request refresh. Rollbacks retain scope/expiry controls. Backups have separate retention; clean expired data before serving a restore.

## 8. Completion checklist

- [ ] Correct scope/filter/reference behavior, `internalDate` backfill, retrieval baseline, and early AWS/OAuth/memory facts.
- [ ] Full-body structural chunks, reused embeddings, and exact hybrid search.
- [ ] Page-open reconciliation without per-message calls for known IDs, unread updates, task locking, partial-write repair, and progress.
- [ ] Direct LangChain integration, validated citations, server-owned conversation turns, follow-ups, 30-question report, and CI tests.
- [ ] Focused modes and advanced features added incrementally with relevant tests.
- [ ] Concurrency/resource results, actual cost estimate, provider decision, and scoped rebuild procedure recorded before private pilot rollout.
