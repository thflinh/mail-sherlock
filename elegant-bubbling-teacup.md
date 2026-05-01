# Plan: Option A — Store Embeddings + Metadata Only, Fetch Body On Demand

## Context

The landing page currently claims emails are "indexed locally" and "never sent to third-party servers," which is false. The backend stores full email body text in MongoDB (cloud-hosted) and sends it to Google Gemini for AI features.

**Option A** fixes this by removing body text from persistent storage. Embeddings are still computed locally during sync (using `all-MiniLM-L6-v2`), but the raw body is discarded after embedding. When a user triggers an AI feature (answer, summarize, extract, reader), the body is fetched fresh from the Gmail API at that moment and never saved.

**After this change the privacy claim becomes accurate:** We store only email metadata and search indexes. Email content is fetched directly from Gmail when you use AI features and is never saved on our servers.

---

## What Changes and Why

| Area | Current | After |
|---|---|---|
| Sync (`_sync_account_bulk`, `_incremental_sync_account`) | Stores `body` (2000 chars) in MongoDB | Compute embeddings from body in memory, then strip `body` before write |
| Chunk store (`email_chunks` collection) | Stores body text split into 480-char chunks + embeddings | Removed — all calls to `rebuild_chunks_for_emails` dropped |
| BM25 in `_semantic_search` | Tokenizes `subject + body` | Tokenizes `subject + snippet` (snippet already stored) |
| Rerank (`rerank_async` / `rerank`) | Sends body excerpt to Gemini | Uses `snippet` as fallback when body absent |
| AI modes: answer, summarize, extract | Reads `body` from MongoDB doc | Fetches fresh body from Gmail API via new `_fetch_body_from_gmail` helper |
| Reader (`/email/{email_id}`) | Reads `bodyHtml`/`body` from MongoDB | Fetches full email from Gmail, sanitizes in `reader.py` |
| Privacy claim (`Landing.tsx`) | Inaccurate | Updated to reflect actual behavior |

---

## Critical Files

| File | Role |
|---|---|
| `backend/main.py` | Sync logic, AI chat stream, reader endpoint, semantic search |
| `backend/reader.py` | `get_email_for_reader` — reads body for reading panel |
| `backend/agent_search.py` | `rerank_async` / `rerank` — sends body snippet to Gemini |
| `backend/chunk_index.py` | Stores body chunks in `email_chunks` — calls to be removed |
| `backend/embeddings.py` | `add_embeddings_inplace` — reads `body` to compute `emb_body`; no change needed |
| `web/src/pages/Landing.tsx` | Privacy claim string — line 74 |

---

## Step-by-Step Implementation

### Step 1 — Strip body before MongoDB write (main.py)

In `_sync_account_bulk` (around line 1797) and `_incremental_sync_account` (around line 443), after `add_embeddings_inplace` and `assign_labels_bulk` finish, add one line before the `bulk_write`:

```python
for e in emails:
    e.pop("body", None)
```

Then remove the `await rebuild_chunks_for_emails(db, emails)` call from both functions.

> `add_embeddings_inplace` already ran and computed `emb_body` from the body text, so stripping it here loses nothing for search.

---

### Step 2 — Fix BM25 to use snippet instead of body (main.py)

In `_semantic_search` (around line 1186), change:

```python
# before
(e.get("subject", "") + " " + e.get("body", "")).lower().split()

# after
(e.get("subject", "") + " " + e.get("snippet", "")).lower().split()
```

---

### Step 3 — Fix rerank to use snippet as fallback (agent_search.py)

In `rerank` (line ~252) and `rerank_async` (line ~308), change:

```python
# before
body_snippet = extract_relevant_passage(e.get("body") or "", user_query, window=400)

# after
body_snippet = extract_relevant_passage(e.get("body") or e.get("snippet") or "", user_query, window=400)
```

This is a one-line change in each function. When body is absent, snippet (~160 chars) is used.

---

### Step 4 — Add `_fetch_body_from_gmail` helper (main.py)

Add this new async helper near the other Gmail helpers (after `_persist_refreshed_credentials`):

```python
async def _fetch_body_from_gmail(
    db, session_id: str, email_id: str, account_email: str
) -> str:
    """Fetch a single email's plain-text body from Gmail on demand."""
    rows = await _get_gmail_account_rows(db, session_id=session_id)
    row = next((r for r in rows if (r.get("email") or "").strip() == account_email), rows[0] if rows else None)
    if not row:
        return ""
    creds = await _credentials_from_row(row)
    if not creds:
        return ""
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GoogleRequest())
            await _persist_refreshed_credentials(db, account_email, creds)
        except Exception:
            return ""
    loop = asyncio.get_running_loop()
    def _do_fetch():
        svc = build("gmail", "v1", credentials=creds)
        raw = svc.users().messages().get(userId="me", id=email_id, format="full").execute()
        return _extract_body(raw.get("payload", {}))
    try:
        return await loop.run_in_executor(None, _do_fetch)
    except Exception as exc:
        logger.warning("_fetch_body_from_gmail failed for %s: %s", email_id, exc)
        return ""
```

Reuses: `_get_gmail_account_rows`, `_credentials_from_row`, `_persist_refreshed_credentials`, `_extract_body`, `GoogleRequest`, `build` — all already imported.

---

### Step 5 — Wire body fetch into AI chat modes (main.py)

In `_chat_stream`, for **answer** and **extract** modes, after the email doc is resolved from MongoDB (the doc will now have no `body`), fetch body from Gmail before calling `_augment_email_body_for_llm`:

```python
# Fetch body on demand if not stored
if not email_doc.get("body"):
    fetched = await _fetch_body_from_gmail(
        db, session_id, email_doc["id"], email_doc.get("accountEmail", "")
    )
    if fetched:
        email_doc = {**email_doc, "body": fetched}
```

For **summarize** mode, apply the same fetch to each email in `emails_to_summarize`:

```python
enriched = []
for e in emails_to_summarize:
    if not e.get("body"):
        body = await _fetch_body_from_gmail(db, session_id, e["id"], e.get("accountEmail", ""))
        enriched.append({**e, "body": body} if body else e)
    else:
        enriched.append(e)
emails_to_summarize = enriched
```

If the Gmail fetch fails, `body` stays absent and Gemini falls back to `snippet` (already handled by the prompt functions with `or email.get("snippet")`).

---

### Step 6 — Update reader endpoint to fetch from Gmail (main.py + reader.py)

**`reader.py` — update `get_email_for_reader` signature:**

Add an optional `body_override: str = ""` parameter. When provided, use it instead of reading body from the doc:

```python
async def get_email_for_reader(
    email_id: str, db, session_id: str | None = None, body_override: str = ""
) -> dict | None:
    ...
    body_text = body_override or doc.get("body") or ""
```

**`main.py` — update `/email/{email_id}` endpoint:**

```python
@app.get("/email/{email_id}")
async def get_email(email_id: str, request: Request, response: Response):
    session_id = await _resolve_session(request, response)
    db = get_db()
    # Fetch metadata from Mongo first to get accountEmail
    meta = await db["emails"].find_one(
        {"id": email_id, "owner_session": session_id},
        {"accountEmail": 1, "_id": 0}
    )
    body = ""
    if meta:
        body = await _fetch_body_from_gmail(
            db, session_id, email_id, meta.get("accountEmail", "")
        )
    doc = await get_email_for_reader(email_id, db, session_id=session_id, body_override=body)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Email {email_id} not found.")
    return doc
```

---

### Step 7 — Update privacy claim (Landing.tsx)

In `web/src/pages/Landing.tsx` line 74, replace:

```tsx
Your emails are indexed <strong>locally on your machine</strong>. We never send your inbox content to third-party servers.
```

With:

```tsx
We store only email <strong>metadata and search indexes</strong>. Email content is fetched directly from Gmail when you use AI features and is never saved on our servers.
```

---

## What Is NOT Changed

- `embeddings.py` — unchanged; `add_embeddings_inplace` reads `body` during sync (before it's stripped), which is correct
- `passage_select.py` — unchanged; still used for sliding-window selection on fetched bodies
- `labels.py` — unchanged; `assign_labels_bulk` runs before body is stripped
- `agent.py` — unchanged; prompt functions already fall back to `snippet` when body is absent
- The `email_chunks` collection in MongoDB — existing data can remain (it's stale after the change but harmless); a one-time `db.email_chunks.drop()` is optional cleanup

---

## Verification

1. **Sync test**: Trigger `/emails/sync`, then inspect a document in MongoDB `emails` collection — confirm no `body` field is present, but `emb_subject` and `emb_body` vectors are present.
2. **Search test**: Run a keyword search (`/ask` or `/chat` with `mode=find`) — results should still return with correct ranking.
3. **AI answer test**: Open an email in the reader, ask a question about its content — verify Gemini answers correctly (body fetched live from Gmail).
4. **AI summarize test**: Ask to summarize 3 emails — verify Gemini produces a coherent summary.
5. **Reader test**: Open an email in the reader panel — verify full body text renders correctly.
6. **Offline/expired token test**: With an expired token, AI features should fail gracefully (fall back to snippet, not crash).
7. **Landing page**: Confirm the updated privacy string renders correctly.
