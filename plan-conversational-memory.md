# Plan: Conversational Memory

## Current State (what's already done)

The infrastructure is mostly in place. Here's the exact status:

| Component | Status | Notes |
|---|---|---|
| `ChatRequest` has `messages` field | Done | Frontend already sends full message history |
| `/chat` extracts `history` from messages | Done | `main.py:923` |
| `understand_query()` accepts `history` | Done | `agent_search.py:86` — Gemini already uses history to resolve pronouns in search |
| `find()` accepts `conversation=` | Done | `agent.py:72` — parameter exists |
| `answer()` accepts `conversation=` | Done | `agent.py:131` — parameter exists |
| `chitchat()` accepts `conversation=` | Done | `agent.py:227` — parameter exists |
| **`_call()` uses conversation history** | **NOT done** | `_call()` only takes `system` and `user` strings — history is silently dropped |
| **`summarize()` accepts `conversation=`** | **NOT done** | No parameter, no history support |
| **`extract()` accepts `conversation=`** | **NOT done** | No parameter, no history support |
| **History truncation** | **NOT done** | Long conversations will eventually overflow token limit |

### The Core Bug

The `conversation` parameter is passed into `find()`, `answer()`, `chitchat()` — but those functions call `_call(system, user)` which throws the history away. The LLM never sees prior turns.

```python
# agent.py:145 — conversation is received but never passed to _call()
def answer(question, email, conversation=None):
    ...
    reply_text = _call(_ANSWER_SYSTEM, user_prompt)  # ← history lost here
```

---

## What Needs to Change

### File 1: `backend/agent.py` — 4 changes

#### Change 1: Update `_call()` to support multi-turn history

`_call()` currently takes a plain string for user input. It needs a new optional `history` parameter that formats prior turns in Gemini's multi-turn format.

**Current `_call()` signature:**
```python
def _call(system: str, user: str, max_tokens: int = 1024) -> str:
```

**New `_call()` signature:**
```python
def _call(
    system: str,
    user: str,
    max_tokens: int = 1024,
    history: list[dict] | None = None,   # ← ADD THIS
) -> str:
```

**How Gemini's multi-turn format works:**
```python
contents = [
    {"role": "user",  "parts": [{"text": "What did my landlord say?"}]},
    {"role": "model", "parts": [{"text": "Your landlord said rent increases by $150..."}]},
    {"role": "user",  "parts": [{"text": "When does that start?"}]},  # ← current turn
]
```

Inside `_call()`, build the `contents` list from history + current message:
```python
contents = []
if history:
    for turn in history:
        role = "user" if turn.get("role") == "user" else "model"
        contents.append({"role": role, "parts": [{"text": turn["content"]}]})
contents.append({"role": "user", "parts": [{"text": user}]})
```

Then pass `contents` (not the bare string) to `generate_content()`.

---

#### Change 2: Add history truncation helper

Long conversations will eventually exceed Gemini's token limit. Add a helper at the top of `agent.py`:

```python
_MAX_HISTORY_TURNS = 10  # Keep last 10 turns (5 user + 5 assistant)

def _trim_history(history: list[dict] | None) -> list[dict] | None:
    if not history:
        return history
    return history[-_MAX_HISTORY_TURNS:] if len(history) > _MAX_HISTORY_TURNS else history
```

---

#### Change 3: Thread history through `find()`, `answer()`, `chitchat()`

These already accept `conversation=` but don't use it. Pass it to `_call()`:

```python
# find() — add to _call():
reply_text = _call(_FIND_SYSTEM, user_prompt, max_tokens=512, history=_trim_history(conversation))

# answer() — add to _call():
reply_text = _call(_ANSWER_SYSTEM, user_prompt, max_tokens=512, history=_trim_history(conversation))

# chitchat() — add to _call():
reply_text = _call(_CHITCHAT_SYSTEM, message, max_tokens=256, history=_trim_history(conversation))
```

---

#### Change 4: Add `conversation=` to `summarize()` and `extract()`

These two modes currently have no history support at all.

**`summarize()` — add parameter and pass to `_call()`:**
```python
def summarize(
    emails: list[dict],
    user_request: str,
    conversation: list[dict] | None = None,   # ← ADD
) -> AgentResponse:
    ...
    reply_text = _call(_SUMMARIZE_SYSTEM, user_prompt, max_tokens=768, history=_trim_history(conversation))
```

**`extract()` — add parameter and pass to `_call()`:**
```python
def extract(
    extract_field: str,
    email: dict,
    conversation: list[dict] | None = None,   # ← ADD
) -> AgentResponse:
    ...
    reply_text = _call(_EXTRACT_SYSTEM, user_prompt, max_tokens=256, history=_trim_history(conversation))
```

---

### File 2: `backend/main.py` — 2 changes

The `/chat` endpoint already builds `history`. It just isn't passed to `summarize` and `extract` calls.

#### Change 5: Pass history to `agent_summarize()`

**Current (`main.py:981`):**
```python
resp = agent_summarize(emails_to_summarize, query_text)
```

**New:**
```python
resp = agent_summarize(emails_to_summarize, query_text, conversation=history)
```

---

#### Change 6: Pass history to `agent_extract()`

**Current (`main.py:1002`):**
```python
resp = agent_extract(extract_field, email_doc)
```

**New:**
```python
resp = agent_extract(extract_field, email_doc, conversation=history)
```

---

## Implementation Order

Do these in order — each step is independently testable.

### Step 1 — Update `_call()` in `agent.py`
- Add `history` parameter
- Build multi-turn `contents` list
- Pass `contents` to `generate_content()`
- Add `_trim_history()` helper

**Test:** Call `_call()` directly in a Python shell with a fake 2-turn history. Verify the Gemini response references the prior turn.

---

### Step 2 — Wire history into `find()`, `answer()`, `chitchat()`
- Pass `history=_trim_history(conversation)` to `_call()` in all three functions

**Test:** 
```
Turn 1: "Find emails about my lease"        → shows lease emails
Turn 2: "When did the first one arrive?"    → should answer without re-searching
Turn 3: "Who sent it?"                      → should still reference the same email
```

---

### Step 3 — Add `conversation=` to `summarize()` and `extract()`
- Add parameter signature
- Pass to `_call()`

**Test:**
```
Turn 1: "Summarize emails about AWS"        → summary with 3 emails
Turn 2: "What was the total amount?"        → extract from those same emails
```

---

### Step 4 — Update `main.py` calls
- Add `conversation=history` to both `agent_summarize()` and `agent_extract()` calls

**Test:** Full end-to-end chat in the extension popup.

---

## What a Good Conversation Looks Like After This

```
User:      "Find emails from my landlord about rent"
Sherlock:  "I found 2 emails. The most recent is from Nov 15 — your landlord
            confirmed a rent increase starting January."
            [shows email cards]

User:      "How much is the increase?"       ← follow-up, no re-search needed
Sherlock:  "The November 15 email states the rent will increase by $150/month,
            from $1,800 to $1,950, effective January 1st."

User:      "Did they give a reason?"         ← still referring to same email
Sherlock:  "Yes — the email cites rising property tax assessments and
            maintenance cost increases as the reason."

User:      "What about the earlier email?"   ← switches context
Sherlock:  "The earlier email from August 3rd mentioned a potential increase
            was being considered, but no amount was confirmed at that time."
```

---

## What Doesn't Change

- No frontend changes needed — the extension already sends `messages` array
- No schema changes — `ChatRequest` and `AgentResponse` are unchanged
- No new dependencies — all changes are inside existing files
- The `/ask` endpoint is untouched (it bypasses the chat pipeline entirely)
- `understand_query()` already uses history for search — no change needed there

---

## Risk & Mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Token overflow on long conversations | Low | `_trim_history()` caps at 10 turns |
| History confuses mode-switching | Low | `understand_query()` already handles this — Gemini sees history and interprets mode changes correctly |
| Gemini API latency increase | Very Low | History adds ~500–2000 extra tokens; Gemini 2.5-flash handles this in <100ms extra |
| `_call()` breaking existing behavior | None | `history=None` is default — all existing callers that don't pass history are unaffected |

---

## Summary

| | |
|---|---|
| **Files to change** | `backend/agent.py`, `backend/main.py` |
| **Lines added** | ~30 lines total |
| **Lines changed** | ~10 lines total |
| **New dependencies** | None |
| **Estimated time** | 1–2 hours |
| **Breaking changes** | None |
