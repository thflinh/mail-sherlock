# mail-sherlock — enhancement plan

This document describes the approach and step-by-step plan to: sync the **first 300** recent emails, **never store attachments**, add **hybrid search** (semantic + keyword), and support a **conversational** natural-language flow where the user describes what they remember and receives a ranked list of relevant emails.

---

## Goals

| Goal | Intent |
|------|--------|
| 300 emails | Broader recall than the current 100-message sync so search covers more of the recent inbox. |
| No attachment storage | Only index human-readable text (subject, snippet, body). Do not persist binary attachment data or attachment-specific blobs. |
| Hybrid search | Combine embedding similarity with lexical matching so results stay grounded when the user *does* remember words (sender name, product, “invoice”), while still working when they only have a vague description. |
| Conversation | User speaks in chat style (“that email about the lease”, then “the one from November”); the tool responds with a short, helpful reply plus the same structured email list the UI already shows. |

---

## Approach overview

### 1. Gmail sync: 300 messages, text only

- **List messages:** Use `users.messages.list` with `maxResults=300`. The Gmail API allows up to **500** per request for this method, so a single list call can request 300. If you ever need more than 500, use `nextPageToken` and loop until you have enough IDs.
- **Fetch each message:** Keep `format="full"` (or `format="metadata"` plus a second fetch only if you need bodies—full is simpler for body extraction).
- **Body extraction (no attachments):**
  - Walk the MIME tree **recursively** (`payload.parts` can be nested multipart/alternative, multipart/mixed, etc.).
  - For each part:
    - **Include:** `text/plain` (decode `body.data` when present). Optionally strip `text/html` to plain text if no plain part exists (use a small HTML→text step; still no file storage).
    - **Exclude:** Any part with `filename` set (typical attachments), and non-text MIME types you do not want to index (`application/*`, `image/*`, etc.).
  - **Never** write attachment bytes to MongoDB or disk; do not store attachment IDs for “download later” unless you explicitly add that as a separate feature (out of scope here).
- **Caps:** Keep a reasonable max body length for embedding (e.g. 2k–4k chars) to control latency and memory; truncation is acceptable for search.

### 2. Hybrid search: semantic + keyword

**Semantic leg (existing idea):** Encode query and each document field (e.g. `subject + "\n" + body` or `subject + snippet + body`) with the same sentence-transformer; cosine similarity (dot product on L2-normalized vectors).

**Keyword leg:** Build a sparse index over the same searchable text:

- **Practical default:** [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) over tokenized `subject + body` (and optionally `sender` as a separate boosted field). Libraries such as `rank-bm25` in Python fit an in-memory corpus refreshed per request or rebuilt when the DB snapshot changes.
- **Alternative:** MongoDB Atlas Search with a text index + vector search (if you move to Atlas Search). Heavier operationally; use only if you already standardize on Atlas.

**Fusion (how to merge ranks):**

- **Reciprocal Rank Fusion (RRF):** For each document, `score = Σ 1/(k + rank_leg)` across semantic rank and BM25 rank. RRF is robust and does not require normalizing two different score scales. Typical `k` ≈ 60.
- **Weighted blend:** Normalize semantic scores to [0,1], normalize BM25 to [0,1] per query, then `final = α * semantic + (1-α) * lexical` with a tunable `α` (e.g. 0.6–0.7 favoring semantics for vague queries).

**Optional structured filters (improves “reliable” feel):** Parse or lightly infer from the user message (regex + date libraries, or a small LLM later):

- Time window (“last week”, “November”) → filter `date` parsed to UTC before ranking.
- `from:` / domain hints → filter or boost `sender`.

Apply filters **before** or **after** retrieval depending on strictness: strict filters before; soft boosts can be applied on fused scores.

### 3. Conversational UX and API

**User mental model:** Chat with mail-sherlock; each turn can be vague; the assistant answers in natural language and attaches **the same email cards** (subject, sender, date, snippet, relevance).

**Session model:**

- Client sends a **session id** (UUID) and the **latest user message** (and optionally prior turns for stateless servers).
- Server stores (in memory or MongoDB collection `chat_sessions`) recent turns: `{ session_id, messages: [{role, content}], updated_at }`.

**Turn pipeline:**

1. Append user message to session history.
2. **Query understanding (lightweight first):**
   - **MVP:** Use the **concatenation** of the last 1–2 user messages as the search query string, or the last message only if it looks like a refinement (“the second one”, “from my landlord”).
   - **V2:** Call a small LLM with the transcript to emit `{ search_query, filters }` (structured) for hybrid search; keep the LLM prompt strict so it only extracts search intent, not invented emails.
3. Run **hybrid search** with the resolved query (+ filters).
4. **Assistant reply text (MVP):** Template or tiny model: one sentence summarizing count and theme (“Here are 5 emails that look relevant to your lease renewal.”) plus optional “Try adding a date if these aren’t right.”
5. Return JSON: `{ reply: string, results: EmailResult[], debug?: { resolved_query } }` for the extension to render as chat bubbles + `ResultCard` list.

**Extension UI:** Chat layout: scrollable messages; user input at bottom; assistant messages contain markdown/plain text and embedded result list (reuse `ResultCard`).

---

## Step-by-step implementation plan

### Phase A — Data ingestion (300 emails, no attachments)

1. Change `maxResults` from `100` to `300` in the Gmail list call; if the API ever returns fewer than 300 without an error, optionally follow `nextPageToken` until 300 IDs or exhaustion.
2. Refactor body extraction into a dedicated function that **recursively** walks MIME parts, collects `text/plain` (and optional HTML→text), and **skips** parts with `filename` or disallowed MIME types.
3. Add unit-style tests or manual fixtures with nested multipart samples to ensure attachments are ignored and plain text is still found.
4. Keep storing only: `id`, `subject`, `sender`, `date`, `snippet`, `body` (text), and any index fields you add later—not attachment metadata unless needed for display (optional: store `has_attachments: bool` from Gmail payload without storing files).

### Phase B — Hybrid retrieval

1. Add a module (e.g. `hybrid_search.py`) that:
   - Loads the candidate set from MongoDB (same cap as today or raise to match 300 synced emails).
   - Computes **semantic** scores for all candidates vs query (batch encode documents periodically or on each query depending on performance—start with per-query encoding for simplicity).
   - Tokenizes documents and query; fits BM25 on the current corpus (or incremental update if you optimize later).
   - Produces two ranked lists; merges with **RRF** or weighted fusion.
2. Replace or wrap `/ask` to use hybrid scoring; expose optional query params: `top_k`, `alpha` (if using weighted blend), or `fusion=rrf|weighted`.
3. Tune on a small set of real queries: vague (“something about the interview”) vs keyword-heavy (“Amazon keyboard shipped”).

### Phase C — Conversation API + UI

1. Add MongoDB (or in-memory) persistence for `session_id` → message list with TTL or max messages per session.
2. New endpoint e.g. `POST /chat` with body `{ session_id, message }` returning `{ reply, results }`.
3. Implement **MVP query resolution** from history (concat / last message); log `resolved_query` for debugging.
4. Update the extension to a chat-style layout calling `/chat`; keep `search.ts` or add `chat.ts`.
5. **Optional V2:** Integrate an LLM for query rewriting only; keep hybrid search as the source of truth for which emails appear.

### Phase D — Quality and operations

1. Add simple **evaluation notes** in README: example queries and expected top results.
2. Consider **background embedding cache**: store `embedding` per email in MongoDB, invalidate on sync, to avoid re-encoding 300 bodies every query.
3. Rate-limit `/chat` and `/ask` if exposed beyond localhost.

---

## Success criteria (checklist)

- [ ] Sync pulls **300** messages (or documents that the API allows in one or paginated batch).
- [ ] Indexed text comes only from headers/snippet/body text paths; **no** attachment binary or attachment file content in the database.
- [ ] For mixed queries, results visibly improve vs pure embedding (e.g. exact product name matches surface when semantic alone might miss).
- [ ] User can send multiple chat messages; each response includes a **natural-language reply** and a **list of relevant emails**.

---

## Out of scope (for later)

- Searching inside PDFs or images from attachments.
- Sending or replying to email from the extension.
- Multi-account Gmail.

---

## File touch map (reference)

| Area | Likely files |
|------|----------------|
| Gmail sync | `backend/main.py` (or `gmail_sync.py`) |
| Hybrid logic | new `backend/hybrid_search.py`, `backend/requirements.txt` (`rank-bm25` or similar) |
| Embeddings cache | `backend/embeddings.py`, MongoDB schema |
| Chat API | `backend/main.py`, new `backend/chat.py` or session helpers |
| Extension | `extension/src/popup/App.tsx`, new chat components, `extension/src/api/chat.ts` |

This plan is intentionally incremental: **Phase A** and **B** already improve reliability without conversation; **Phase C** adds the chat experience on top of the same retrieval core.
