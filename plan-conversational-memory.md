# Plan: Conversational Email QA (Updated)

## Goal

Make chat behave like a real assistant: read email content, answer questions conversationally, and keep context across turns.

## Status Snapshot

### Phase 1: History-aware generation (Completed)

| Item | Status | Notes |
|---|---|---|
| `/chat` receives full `messages` history | Done | `backend/main.py` |
| Intent parsing uses history | Done | `understand_query(..., history=...)` |
| Gemini `_call()` accepts and uses history | Done | `backend/agent.py` |
| History trimming added | Done | `_MAX_HISTORY_TURNS = 10`, `_trim_history()` |
| `find/answer/chitchat` pass conversation to `_call()` | Done | `backend/agent.py` |
| `summarize/extract` accept conversation and pass to `_call()` | Done | `backend/agent.py` |
| `/chat` passes history to summarize/extract handlers | Done | `backend/main.py` |
| Rerank uses expanded `search_q` (not raw `q`) | Done | `backend/main.py` |

Result: the model now sees prior turns and can produce contextual answers from email body/snippet content.

## Remaining Gap (What still prevents ChatGPT-like continuity)

History alone is not enough for references like:
- "What about the first one?"
- "Did they mention a deadline in that email?"
- "Compare the second and third results"

Current behavior re-runs search every turn and may select a different top email. We need persistent conversation state that tracks which emails the user is referring to.

## Phase 2: Deterministic Conversation Context (Next)

### Design

Add a lightweight context object returned by `/chat` and echoed back by the client on each request. The server is fully stateless — the client owns the context.

```json
{
  "context": {
    "result_ids": ["id1", "id2", "id3"],
    "active_email_id": "id1",
    "mode": "find"
  }
}
```

> `updated_at` removed — expiry is not needed since context is reset on any new search intent. The client always holds the latest version.

#### Resolution priority (highest to lowest)

1. `active_email_id` from reader (user opened a specific email) — always wins
2. `context_ref` resolved from `context.result_ids` (e.g. "the first one" → index 0)
3. Fresh top search hit — fallback when no context reference exists

#### Context lifecycle rules

| Trigger | Action |
|---|---|
| Mode is `find` and `uses_prior_context: false` | Replace `result_ids` with new results, set `active_email_id` to first |
| Mode is `answer/extract` and `uses_prior_context: true` | Resolve email from `context.result_ids` using `context_ref`, skip new search |
| Mode is `answer/extract` and `uses_prior_context: false` | Run fresh search, update context |
| Filters, account, or `top_k` change materially | Treat as new search, reset context |

### Linchpin: extend `understand_query()` first

All downstream resolution depends on two new fields in the intent JSON returned by `understand_query()` in `agent_search.py`:

```json
{
  "uses_prior_context": true,
  "context_ref": "first"
}
```

- `uses_prior_context`: `true` when the query references prior results rather than starting a new search. Examples: "the first one", "that email", "what about the second?", "did it mention a deadline?"
- `context_ref`: which result to target — one of `"first"`, `"second"`, `"third"`, `"last"`, `"active"`, or `null` (means "same as before / top result").

Add these two fields to `_UNDERSTAND_SYSTEM` prompt in `agent_search.py` and to the `_fallback()` return dict.

#### Why `understand_query()` — not a regex helper

A regex on "first/1st/second..." handles simple ordinals but breaks on:
- "the most recent one" → needs date-awareness
- "the one from yesterday" → needs date reference
- "that AWS email" → anaphora, not ordinal
- "compare the second and third" → multi-reference

Gemini already parses intent from full conversation history — adding two fields costs nothing extra and handles all of these cases naturally.

### File Changes

1. `backend/agent_search.py`
   - Add `uses_prior_context` and `context_ref` to `_UNDERSTAND_SYSTEM` prompt schema
   - Add both fields to `_fallback()` return dict (default: `false` / `null`)

2. `backend/main.py`
   - Extend `ChatRequest` with optional `context: ConversationContext | None`
   - Add `ConversationContext` Pydantic model: `result_ids`, `active_email_id`, `mode`
   - In `answer/extract` handlers: if `uses_prior_context` is true, resolve target email from `context.result_ids[context_ref_index]` instead of running a fresh search
   - On `find` with `uses_prior_context: false`: build and return new context from results
   - Include `context` in every `/chat` response

3. `extension/src/api/search.ts`
   - Add `ConversationContext` interface
   - Add optional `context` to `ChatRequest` payload type
   - Add `context` to `ChatResponse` type

4. `extension/src/panel/PanelApp.tsx`
   - Add `conversationContext` state (initially `null`)
   - Send current `conversationContext` with every `chatSearch()` call
   - Update `conversationContext` from each response

## Acceptance Tests

1. **Context carry-over**
   - User: "Find emails from landlord about rent."
   - User: "What did the first one say about start date?"
   - Expected: `understand_query()` returns `uses_prior_context: true, context_ref: "first"` → answers from `result_ids[0]` email body, no new search.

2. **Ordinal switch**
   - User: "What about the second one?"
   - Expected: `context_ref: "second"` → switches target to `result_ids[1]`.

3. **Non-ordinal reference**
   - User: "The one from yesterday — what did it say about the deadline?"
   - Expected: `uses_prior_context: true, context_ref: null` → resolves to most date-relevant email in `result_ids`, Gemini picks it.

4. **Active reader override**
   - Open email in reader, ask: "Does this mention late fee?"
   - Expected: `active_email_id` from reader wins regardless of `context_ref` or search results.

5. **New search reset**
   - User: "Now find AWS billing emails."
   - Expected: `understand_query()` returns `uses_prior_context: false` → fresh search runs, `context.result_ids` replaced with AWS results, old context discarded.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Context gets stale after account/filter changes | Clear context when filters/account/top_k change materially |
| Ambiguous pronouns ("that one") | Ask a clarification question when no safe resolution exists |
| Extra payload size | Keep only IDs and minimal metadata in `context` |

## Delivery Order

1. **Extend `understand_query()`** — add `uses_prior_context` and `context_ref` to prompt schema and `_fallback()` in `agent_search.py`. Test in isolation by calling it with a fake 2-turn history.
2. **Backend context schema + response plumbing** — add `ConversationContext` Pydantic model, extend `ChatRequest`, include `context` in `/chat` response.
3. **Backend reference resolver** — in `answer/extract` handlers, resolve email from `context.result_ids` when `uses_prior_context` is true. Add context-reset logic on fresh searches.
4. **Frontend wiring** — add `context` to request/response types in `search.ts`, store and send in `PanelApp.tsx`.
5. **End-to-end tests** — run all 5 acceptance tests in the extension popup.

## Summary

Phase 1 is done and already improves conversational behavior.  
Phase 2 is the key step to make follow-up references reliable and truly ChatGPT-like.
