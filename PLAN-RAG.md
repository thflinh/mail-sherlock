# Reliable email RAG implementation plan

Date: 2026-11-08  
Status: Proposed; implementation has not started.

## Objective

Make Mail Sherlock reliably find, explain, summarize, compare, and extract facts from a user's indexed email, with traceable evidence and explicit handling of missing information. Reliability means measurable retrieval quality, correct account isolation, grounded answers, recoverable indexing, and predictable failures; it does not mean guaranteeing that an LLM never makes a mistake.

This plan is based on the current repository implementation. Earlier completion claims in `plan-conversational-memory.md` must be verified against code. This plan supersedes its rule that an open email always overrides an explicit conversational reference.

## Scope and assumptions

- Keep FastAPI, MongoDB, the React client, and the existing Gemini integration initially.
- Keep the current MiniLM model for the baseline. Change models only after evaluation demonstrates a benefit; model changes require a versioned reindex.
- Support plain-text and HTML email bodies, multiple connected accounts, threads, and conversational references.
- Attachment contents and OCR are a separate extension. Identify attachments in results, but do not claim to have searched their contents until attachment indexing exists.
- Store normalized bodies and derived chunks as private mailbox data, with deletion and retention behavior. If persistent bodies are unsuitable for deployment, explicitly choose an alternative before implementation: chunks also contain private body text.
- Begin with exact local vector scoring and a cached lexical index for a bounded pilot. Benchmark before launch; introduce a scalable retrieval backend behind the same interface if the intended mailbox size exceeds the measured memory/latency envelope. Never silently truncate the corpus to meet a limit.
- No external messages, production migrations, or deployment are part of writing this plan.

## Current gaps to resolve

| Gap | Current location | Consequence |
| --- | --- | --- |
| Gmail sync drops bodies and does not build chunks | `backend/main.py` sync functions | Deep-body evidence is unavailable during discovery |
| Email fetch strips the session partition needed by chunk lookup | `backend/main.py::_fetch_email_doc`, `backend/chunk_index.py` | Existing chunks are missed |
| Search reads only 1,000 emails before filtering | `backend/main.py::_semantic_search` | Indexed messages can be unreachable |
| BM25 cache is keyed by session and candidate count | `backend/main.py::_semantic_search` | Scores can be applied to a different corpus |
| Empty filter matches restore the original candidates | `backend/main.py::_semantic_search` | Results violate user constraints |
| Open email overrides explicit references | `backend/main.py::_chat_stream` | Answers can use the wrong message |
| Chunk packing truncates after document-order sorting | `backend/chunk_index.py` | High-value evidence can be discarded |
| Extraction receives a generic field without the question | `backend/agent.py`, `backend/main.py` | Wrong amount/date can be extracted |
| Answers use one email and lack enforceable citations | `backend/agent.py`, `backend/main.py` | Cross-message questions and verification are weak |
| Body extraction misses HTML-only multipart messages | `backend/main.py::_extract_body` | Some messages have no useful indexed body |
| No relevance rejection or quality evaluation suite | Retrieval/generation pipeline | Unrelated results and regressions are hard to detect |

## Target pipeline

```text
Gmail sync -> durable normalized messages -> versioned chunks + embeddings
                   |                              |
                   +---- lexical index -----------+
                                                  |
User turn -> validated intent + reference resolution + hard filters
          -> lexical and dense chunk retrieval across authorized corpus
          -> rank fusion -> rerank -> evidence sufficiency decision
          -> bounded, deduplicated context with source IDs
          -> structured grounded answer -> validation -> UI citations
```

MongoDB remains the source of truth. Derived indexes must be reproducible from normalized messages. All retrieval interfaces require a server-derived owner identity; client-provided IDs never establish authorization.

### Suggested module boundaries

| Module | Responsibility |
| --- | --- |
| `backend/main.py` | HTTP/SSE transport, authentication, orchestration wiring |
| `backend/ingestion.py` | MIME normalization, sync checkpoints, message persistence |
| `backend/rag_models.py` | Validated intent, document identity, hits, evidence, answer contracts |
| `backend/retrieval.py` | Authorized filters, lexical/dense retrieval, fusion, deduplication |
| `backend/agent_search.py` | Query interpretation and reranking adapters |
| `backend/chunk_index.py` | Chunk construction, index versions, indexing jobs |
| `backend/embeddings.py` | Embedding model configuration and batched encoding |
| `backend/context_builder.py` | Passage selection, source mapping, token budgets |
| `backend/conversation.py` | Reference resolution and validated conversation state |
| `backend/agent.py` | Grounded generation, structured output, provider failure handling |
| `backend/evals/` | Labeled fixtures, retrieval and answer quality reports |

Extract modules as their behavior changes; avoid a large preliminary rewrite. Reuse `passage_select.py` as a labeled fallback until the new context builder replaces its responsibilities.

## Phase 0 — Establish contracts and a baseline

- [ ] Add regression fixtures for every confirmed bug above before fixing it.
- [ ] Define typed contracts for `SearchIntent`, `DocumentKey`, `RetrievalHit`, `EvidencePassage`, `ConversationState`, and `GroundedAnswer`.
- [ ] Validate intent enums, booleans, date ranges, keyword lists, reference targets, and malformed provider responses. Bound query size, history, `top_k`, and retrieved context.
- [ ] Record the actual embedding model, dimension, normalization, and tokenizer configuration. Correct stale BGE/768-dimensional comments in `embeddings.py`.
- [ ] Validate both subject and body vectors where legacy field embeddings remain supported.
- [ ] Pin a tested dependency set after confirming compatibility in the development environment.
- [ ] Create an evaluation runner that records configuration, corpus version, ranking results, answer citations, stage latency, and provider failures.

Acceptance: the current defects have reproducible tests, a baseline report exists, and malformed intent cannot crash search or bypass scope enforcement.

## Phase 1 — Correct identity, filters, and reference handling

- [ ] Use a stable server-authorized owner identity. Prefer the application's persistent user identity where available; map legacy session-owned data explicitly. Cookie rotation must not silently orphan mail or expose another owner's mail.
- [ ] Represent email identity as `(owner_id, account_id, provider_message_id)` and thread identity with the same scope. Audit reads, writes, cache keys, context IDs, and reader endpoints.
- [ ] Preserve internal owner/account metadata until serialization. Strip it only from public response objects.
- [ ] Apply account, sender, attachment, unread, and date constraints before retrieval. Zero matching documents means zero results.
- [ ] Implement `last_30_days`; normalize message timestamps to UTC and define calendar-period versus rolling-window semantics using the user's timezone. Use bounded start/end intervals.
- [ ] Remove the unsorted 1,000-document search cap. Enumerate the complete authorized corpus or use a retrieval backend that searches it fully.
- [ ] Remove the count-based BM25 cache. Initially rebuild for correctness; then cache an immutable corpus generation with ordered document/chunk IDs, owner/account scope, tokenizer version, and content version.
- [ ] Resolve explicit ordinals/IDs before implicit reader context. Use the reader only when the question refers to it. A new-topic query must not inherit an unrelated open email.
- [ ] Support references to multiple results for comparison and summarization. Invalid ordinals require clarification, not fallback to a different result.
- [ ] Resolve pronouns into a standalone question used consistently by retrieval, passage selection, and generation.

Acceptance: filter tests return no violating rows; equal-sized filtered corpora cannot share incorrect BM25 scores; explicit references select the intended email; unauthorized IDs reveal no content.

## Phase 2 — Complete and recoverable ingestion

- [ ] Normalize MIME recursively: prefer a usable plain-text alternative, otherwise convert HTML to text; preserve meaningful tables, links, lists, and dates. Decode character sets safely and distinguish attachment text from message text.
- [ ] Persist normalized full text, metadata, provider timestamp, original message identity, content hash, and normalization version. Do not store only the beginning of a body.
- [ ] Use paragraph/sentence-aware chunks bounded by the embedding tokenizer's actual input limit, with modest measured overlap. Preserve character offsets and deterministic chunk IDs.
- [ ] Remove the 80-chunk silent cutoff and whitespace termination bug. Large-message limits must produce visible partial-indexing status and a retry/large-document path.
- [ ] Give each chunk owner/account/message/thread keys, offsets, content hash, chunker version, embedding model/version/dimension, and index generation.
- [ ] Build chunks for bulk sync, incremental sync, mock seed, and backfill through one indexing path.
- [ ] Introduce durable pending/running/ready/failed indexing state, bounded retries, and resumable jobs. A worker restart must not lose work.
- [ ] Publish a new document generation only after its chunks are complete. Retain the previous valid generation until publication; clean old generations afterward. Never expose a partially replaced chunk set.
- [ ] Handle new messages, updates to unread/attachment metadata, deletions, and account removal. Delete derived chunks and invalidate caches with their parent records.
- [ ] Paginate sync fully. Advance checkpoints only after the corresponding provider changes are durably captured; retry failed messages without skipping them.
- [ ] Add a resumable backfill command for existing messages whose bodies/chunks are missing. Report progress and failures; honor provider quotas.
- [ ] Expose indexed/pending/failed counts and last successful sync so partial mailbox coverage is visible.

Acceptance: interrupted indexing resumes without duplicates; deep-body and HTML-only fixtures are searchable; removed messages disappear from every index; all eligible messages reconcile with indexing state.

## Phase 3 — Retrieve evidence across the whole mailbox

- [ ] Define a retrieval interface independent of storage implementation. Require authorized scope and structured filters on every call.
- [ ] Build lexical search over normalized full-body chunks plus subject/sender metadata. Preserve useful exact tokens such as invoice IDs, email addresses, amounts, and hyphenated identifiers.
- [ ] Search dense chunk embeddings across the eligible corpus, not just inside an already selected email. Include concise subject context during chunk embedding and version this choice.
- [ ] Retrieve lexical and dense candidate lists separately. Fuse ranks using reciprocal-rank fusion initially; tune candidate counts and fusion parameters on development queries.
- [ ] Preserve the original query for exact matches and use a resolved/expanded query for semantic retrieval. Do not let generated synonyms replace required identifiers.
- [ ] Group chunks by message while preserving evidence hits; limit duplicate quoted replies and prevent a single long message from occupying the entire shortlist.
- [ ] Rerank using relevant passages and metadata with validated outputs. Require relevance judgments as well as ordering so all candidates can be rejected.
- [ ] Add an evidence-sufficiency gate using calibrated retrieval/reranker features and explicit constraints. Do not treat max-normalized hybrid scores or LLM confidence as probabilities.
- [ ] Return distinct states for supported evidence, ambiguous evidence, no relevant evidence, incomplete index, and provider failure.
- [ ] Benchmark pilot corpus sizes of 1k, 10k, and 50k messages. Record chunk counts, memory, cold/warm latency, and concurrency. Use results to select the supported deployment envelope and whether a scalable index is necessary.

Acceptance: a fact found only near the end of a message can retrieve that message; exact IDs survive query expansion; unrelated queries can return no evidence; retrieval never omits documents because of an implicit corpus cap.

## Phase 4 — Grounded generation and source citations

- [ ] Construct context from the strongest evidence across messages, with diversity limits. Merge overlapping source spans before budgeting.
- [ ] Allocate the token budget by relevance before arranging passages in document order. Reserve space for instructions, question, history, and output. Keep stable passage IDs and offsets.
- [ ] Give generation the resolved question, relevant conversational context, message timestamps, and explicit source IDs. Prior assistant answers are conversation context, not evidence.
- [ ] Pass the full question to extraction. Define field/value/source outputs so deposit, total, payment date, and due date remain distinguishable.
- [ ] Support multi-message answers and comparisons. Expand threads only within authorized scope and context budgets; distinguish revised statements and contradictory dates instead of silently merging them.
- [ ] For broad summaries, define coverage separately from relevance search. Summarize the requested set through bounded batches when necessary, carrying source IDs through aggregation; disclose excluded or unavailable messages.
- [ ] Request structured answer output with status, answer text, and claim/source references. Validate schema and ensure citations refer only to supplied evidence.
- [ ] Validate quoted evidence against canonical source spans. Citation existence alone does not prove a claim; evaluate entailment and unsupported claims separately.
- [ ] Instruct the model to treat email contents as untrusted evidence and ignore instructions embedded in mail. Test malicious emails requesting fabricated answers or instruction overrides.
- [ ] Retry invalid structured output once within a bounded deadline; otherwise return a clear failure or evidence-only response, not invented citations.
- [ ] Stream progress events immediately, but buffer the grounded answer until validation for the initial release. Optimize answer streaming only with an explicit provisional/final correction protocol.

Acceptance: factual claims have traceable supporting sources; the UI can open the cited message and highlight the relevant span; missing evidence leads to abstention; comparisons use all referenced messages.

## Phase 5 — Operational reliability and client behavior

- [ ] Move CPU-heavy embedding/index construction off the event loop with bounded workers. Avoid loading or recomputing the entire corpus per request.
- [ ] Set per-stage and overall deadlines, bounded retries with backoff, and concurrency limits. Retry only retryable failures; cancel work when clients disconnect.
- [ ] Make streaming failures explicit. Do not append a complete fallback answer after partially streamed text or emit successful completion with no answer.
- [ ] Define SSE events for progress, evidence metadata, validated answer, recoverable warning, error, and terminal completion. Preserve compatibility or version the endpoint.
- [ ] Update `web/src/types.ts` and `web/src/pages/Dashboard.tsx` for citations, coverage status, no-evidence responses, retry behavior, and reference selection.
- [ ] Log request IDs, index generation, candidate counts, stage latency, token usage, fallback reason, and citation validation status. Avoid logging raw mail, credentials, or full prompts by default.
- [ ] Add readiness checks for model availability/index compatibility; distinguish an unavailable dependency from an empty mailbox.
- [ ] Keep retrieval usable when generation/reranking is unavailable, with a visible degraded-mode message. Do not claim a generated answer succeeded.
- [ ] Document retention, backup/restore, account deletion, reindex, quota exhaustion, and failed-job recovery.

Acceptance: provider timeouts, malformed responses, database outages, and client disconnects terminate predictably; concurrent requests do not block health endpoints; partial sync is visible to users.

## Phase 6 — Evaluation and release gates

Create at least 150 labeled queries across synthetic and consented, anonymized fixtures. Separate development and held-out test sets; prevent near-duplicate threads from crossing the split. Include relevant message IDs, supporting spans, expected facts, filters, and whether the question is answerable. Human-review the labels and a sample of generated answers; do not use an LLM judge as the only validator.

Required cases:

- Exact names/IDs, paraphrases, deep-body evidence, HTML-only messages, very long messages, and quoted duplicate threads.
- Zero-match filters, calendar boundaries, multiple accounts, changed metadata, deleted mail, stale indexes, and interrupted jobs.
- First/second/last references, open-email conflicts, new topics, multiple selected results, and pronoun resolution.
- Multiple amounts/dates in one message, conflicting messages, revised deadlines, and multi-message comparisons.
- Truly absent facts, ambiguous questions, malicious source instructions, malformed model output, and provider failures.
- Cross-owner message IDs, cross-account filters, cache isolation, and disconnected accounts.

Proposed initial gates, to be ratified after the baseline rather than represented as measured performance:

| Metric | Release gate |
| --- | --- |
| Retrieval Recall@20 | At least 95% overall; at least 90% in each critical retrieval category |
| Ranking MRR@10 | At least 0.85 on answerable queries |
| Citation validity | 100% resolve to authorized supplied evidence |
| Supported factual claims | At least 95% on human-reviewed held-out answers |
| Answer correctness | At least 90% on answerable held-out queries |
| Correct abstention | At least 95% on unanswerable queries |
| False abstention | At most 5% on answerable queries |
| Filter/reference/isolation regressions | 100% pass deterministic suites |
| Index completeness | 100% of eligible messages accounted for as ready/pending/failed; zero unexplained omissions |
| Warm retrieval p95 | Target under 1 second on declared hardware/corpus/concurrency |
| Validated answer p95 | Initial target under 10 seconds; measure provider-dependent limits explicitly |

Report sample counts, uncertainty, category breakdowns, and failures alongside aggregates. Measure cost per indexed message and per answered query; establish a deployment budget before launch.

Test layers: pure unit tests for filters/packing/references; integration tests against disposable MongoDB for scope, generations, and job recovery; deterministic provider stubs for failure paths; opt-in live-provider evaluations; frontend tests for citation navigation and stream errors.

## Migration and rollout

1. Capture baseline results and back up data before any schema migration.
2. Add new identities, timestamps, indexing state, and version fields without deleting legacy fields. Detect identity collisions and resolve ownership before merging records.
3. Backfill normalized bodies and chunks in resumable batches. Track expected versus indexed counts per owner/account.
4. Build new indexes alongside the old retrieval path. Compare both on the evaluation set and shadow queries without altering visible results.
5. Enable the new path for a small pilot only after isolation and correctness gates pass. Expose index coverage during backfill.
6. Roll back by selecting the prior published index generation and retrieval flag if quality or latency regresses. Do not mix embedding versions.
7. Expand rollout after evaluating failures and costs; remove legacy code/indexes only after the rollback window closes.

## Recommended pull-request sequence

| PR | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Regression fixtures, contracts, baseline evaluation | None |
| 2 | Correct filters, cache behavior, ownership propagation, reference precedence | 1 |
| 3 | MIME normalization, persistent bodies, scoped identities, timestamps | 2 |
| 4 | Versioned chunking, durable indexing jobs, sync recovery, backfill | 3 |
| 5 | Full-corpus hybrid chunk retrieval, fusion, relevance rejection | 4 |
| 6 | Evidence packing, multi-message QA, extraction, validated citations | 5 |
| 7 | UI citations, coverage/failure states, streaming contract | 6 |
| 8 | Load testing, observability, recovery runbook, rollout gates | 4–7 |

Each PR should include its relevant regression tests and a small evaluation delta. Begin with PRs 1–2; do not change embedding models or add a new vector database before baseline measurements justify it.

## Definition of done

- [ ] All phases have passing acceptance checks and the held-out report meets agreed gates.
- [ ] Every eligible message is accounted for, including deep-body evidence and deletion propagation.
- [ ] Search honors filters and account ownership; conversation references select the intended evidence.
- [ ] Answers and extracted values cite verifiable sources and abstain when evidence is insufficient.
- [ ] Multi-message questions, conflicts, and summary coverage behave explicitly.
- [ ] Indexing resumes after interruption, failures are visible, and rollback is tested.
- [ ] Supported corpus size, latency, cost, attachment limitations, and operations procedures are documented.
