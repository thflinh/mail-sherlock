"""Gemini-powered query understanding and re-ranking for mail-sherlock search."""

import json
import logging
import os
import re

import google.genai as genai

from passage_select import extract_relevant_passage

logger = logging.getLogger(__name__)

_api_key = os.environ.get("GEMINI_API_KEY", "")
if not _api_key:
    logger.warning(
        "GEMINI_API_KEY is not set — Gemini query understanding is disabled. "
        "Set the env var to enable smarter search."
    )

_client = genai.Client(api_key=_api_key) if _api_key else None

# gemini-2.5-flash: better reliability for structured JSON extraction than flash-lite
_MODEL = "gemini-2.5-flash"

# ── Query understanding ────────────────────────────────────────────────────────

_UNDERSTAND_SYSTEM = """You are an expert email search assistant. Given a conversation, determine the user's CURRENT search intent.

The latest message may refine a previous one, or be a completely new query.

Your job:
1. If the query is too vague to search accurately (missing key details that would significantly change results), set needs_clarification=true and write ONE short, specific clarifying question.
   - Only ask when it genuinely matters: e.g. "email from John" (which John?), "find that email" (about what?).
   - Do NOT ask if the user has already given enough context, or if this is a follow-up that builds on history.
2. Otherwise, extract structured search intent and determine the mode.

Respond ONLY with a single valid JSON object — no markdown, no code fences, no explanation.

Schema:
{
  "needs_clarification": false,
  "clarifying_question": null,
  "mode": "<find | answer | summarize | extract | chitchat>",
  "search_query": "<expanded descriptive query for semantic search — resolve pronouns using history, and include synonyms or related vocabulary that might appear in emails (e.g. 'absence' → 'absence attendance missed session not present')>",
  "keywords": ["<verbatim words that must appear: names, order numbers, jargon, or key topic words from the query>"],
  "sender": "<sender name or email if mentioned, else null>",
  "date_hint": "<last_week | last_month | last_year | null>",
  "topic": "<one sentence: what the user is currently looking for>",
  "search_focus": "<subject | body | sender | any>",
  "extract_field": "<deadline | amount | address | phone | date | name | null>",
  "uses_prior_context": <true | false>,
  "context_ref": "<first | second | third | last | active | null>"
}

mode rules:
- "find"      — user wants to locate emails ("find", "show me", "do I have", "any emails about", "search for")
- "answer"    — user asks a specific question about email content ("what did X say", "does it mention", "what is the", "did they")
- "summarize" — user asks for a summary ("summarize", "what's the gist", "give me an overview", "recap", "overview of")
- "extract"   — user wants a specific data value pulled out ("what's the deadline", "how much", "what date", "what address", "what is the amount")
- "chitchat"  — not a search intent at all ("thanks", "hi", "hello", "what can you do", "help", general non-email questions)

search_focus rules:
- "subject" — query is about email topics/categories ("find emails about X", "emails titled Y")
- "body"    — query asks what someone said/wrote ("what did Mike say about budget?", "did they confirm?")
- "sender"  — query is primarily about who sent emails ("emails from HR")
- "any"     — unclear, or the query spans multiple fields

extract_field: only set when mode="extract". Identify the specific data type to extract.

uses_prior_context:
- true when the user refers to emails already shown in this conversation (assistant search results or prior turns) instead of asking for a brand-new search. Examples: "the first one", "that email", "what about the second?", "did it mention a deadline?", "the one from yesterday" (still about prior results).
- false when they want new results ("find emails about…", "now search for…", a new topic, or no prior results to refer to).

context_ref (only meaningful when uses_prior_context is true; otherwise null):
- "first" / "second" / "third" — ordinal position in the last result list (1-based ranking the user sees).
- "last" — the last email in that list.
- "active" — the email the user has open in the reader (if unclear from text, still set uses_prior_context true and context_ref "active").
- null — no specific ordinal: same email as before, top result, or the one that best fits the follow-up (e.g. "the AWS one" among prior hits).

When needs_clarification=true, set clarifying_question to the question and leave other fields as empty/null — the search will not run until the user replies.
When mode="chitchat", leave search_query/keywords/sender/date_hint as empty/null — no search is needed."""

# ── Re-ranking ─────────────────────────────────────────────────────────────────

_RERANK_SYSTEM = """You are an email relevance judge. Given a user's search query and a list of email candidates, rank the candidates by how well they match what the user is looking for.

Consider: subject relevance, sender relevance, content relevance, and how well the email answers the user's need.

Return ONLY a JSON array of candidate IDs in order from most to least relevant. Include all IDs. No explanation, no markdown."""


def _strip_json(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text


def _parse_ranked_ids(text: str) -> list[int]:
    """Parse a JSON array of ints from Gemini rerank response.

    Gemini sometimes wraps the array in explanatory text (e.g. 'Here are
    the rankings: [2, 0, 4]'). Falls back to regex extraction if direct
    JSON parsing fails.
    """
    stripped = _strip_json(text or "")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\[[\d,\s]+\]", text or "")
        if match:
            return json.loads(match.group())
        raise


def understand_query(user_query: str, history: list[dict] | None = None) -> dict:
    """Call Gemini to understand query intent and detect if clarification is needed.

    Args:
        user_query: The latest user message.
        history: Prior turns as {"role": "user"|"assistant", "content": str}.

    Returns a dict with keys:
        needs_clarification, clarifying_question,
        search_query, keywords, sender, date_hint, topic.
    """
    if not _client:
        return _fallback(user_query)

    contents = []
    if history:
        for turn in history:
            role = "user" if turn.get("role") == "user" else "model"
            contents.append({"role": role, "parts": [{"text": turn["content"]}]})
    contents.append({"role": "user", "parts": [{"text": user_query}]})

    try:
        response = _client.models.generate_content(
            model=_MODEL,
            contents=contents,
            config={
                "temperature": 0,
                "max_output_tokens": 512,
                "system_instruction": _UNDERSTAND_SYSTEM,
            },
        )
        raw = (response.text or "").strip()
        logger.debug("Gemini understand_query raw response: %r", raw[:200])
        if not raw:
            logger.warning("Gemini understand_query returned empty response — fallback.")
            return _fallback(user_query)
        stripped = _strip_json(raw)
        if not stripped:
            logger.warning("Gemini understand_query returned no JSON after stripping — fallback.")
            return _fallback(user_query)
        parsed = json.loads(stripped)
        upc = parsed.get("uses_prior_context", False)
        if isinstance(upc, str):
            parsed["uses_prior_context"] = upc.strip().lower() in ("true", "1", "yes")
        elif isinstance(upc, bool):
            pass
        elif upc in (1, 1.0):
            parsed["uses_prior_context"] = True
        else:
            parsed["uses_prior_context"] = False
        logger.debug("Gemini intent: %s", parsed)
        return parsed
    except Exception as exc:
        logger.warning("Gemini understand_query failed (%s) — raw query fallback.", exc)
        return _fallback(user_query)


async def understand_query_async(user_query: str, history: list[dict] | None = None) -> dict:
    """Async version of understand_query — uses aio client to avoid blocking the event loop."""
    if not _client:
        return _fallback(user_query)

    contents = []
    if history:
        for turn in history:
            role = "user" if turn.get("role") == "user" else "model"
            contents.append({"role": role, "parts": [{"text": turn["content"]}]})
    contents.append({"role": "user", "parts": [{"text": user_query}]})

    try:
        response = await _client.aio.models.generate_content(
            model=_MODEL,
            contents=contents,
            config={
                "temperature": 0,
                "max_output_tokens": 512,
                "system_instruction": _UNDERSTAND_SYSTEM,
            },
        )
        raw = (response.text or "").strip()
        logger.debug("Gemini understand_query raw response: %r", raw[:200])
        if not raw:
            logger.warning("Gemini understand_query returned empty response — fallback.")
            return _fallback(user_query)
        stripped = _strip_json(raw)
        if not stripped:
            logger.warning("Gemini understand_query_async returned no JSON after stripping — fallback.")
            return _fallback(user_query)
        parsed = json.loads(stripped)
        upc = parsed.get("uses_prior_context", False)
        if isinstance(upc, str):
            parsed["uses_prior_context"] = upc.strip().lower() in ("true", "1", "yes")
        elif isinstance(upc, bool):
            pass
        elif upc in (1, 1.0):
            parsed["uses_prior_context"] = True
        else:
            parsed["uses_prior_context"] = False
        logger.debug("Gemini intent: %s", parsed)
        return parsed
    except Exception as exc:
        logger.warning("Gemini understand_query_async failed (%s) — raw query fallback.", exc)
        return _fallback(user_query)


def rerank(user_query: str, candidates: list[dict], top_k: int = 5, keywords: list[str] | None = None) -> list[dict]:
    """Re-rank semantic search candidates by true relevance using Gemini.

    Passes subject + sender + snippet to Gemini (not full body) to stay fast.
    Falls back to original cosine-score order if Gemini fails.

    Args:
        user_query: The original natural language query.
        candidates: Email dicts already sorted by cosine score (best first).
        top_k: Number of results to return.
        keywords: Specific content keywords from query intent — if present, always re-rank.

    Returns:
        top_k email dicts in Gemini-ranked order.
    """
    if not _client or len(candidates) <= 1:
        return candidates[:top_k]

    # Skip rerank when top result is already clearly ahead (saves 1 Gemini call).
    # But never skip when keywords are present — cosine similarity can't distinguish
    # specific content like "absence" from other emails by the same sender.
    if not keywords and len(candidates) >= 2:
        top_score = float(candidates[0].get("score", 0))
        second_score = float(candidates[1].get("score", 0))
        if top_score > 0.6 and (top_score - second_score) > 0.15:
            return candidates[:top_k]

    # Build summaries with more context so Gemini can distinguish similar emails
    summaries = []
    for i, e in enumerate(candidates):
        body_snippet = extract_relevant_passage(e.get("body") or e.get("snippet") or "", user_query, window=400).replace("\n", " ")
        date = e.get("date", "unknown date")
        summaries.append(
            f'ID {i}: [{date}] From: {e.get("sender","")} '
            f'| Subject: {e.get("subject","")} '
            f'| Body: {body_snippet}'
        )

    prompt = (
        f'Search query: "{user_query}"\n\n'
        f"Candidates:\n" + "\n".join(summaries) + "\n\n"
        "Return a JSON array of the IDs ranked from most to least relevant. Example: [2, 0, 4, 1, 3]"
    )

    try:
        response = _client.models.generate_content(
            model=_MODEL,
            contents=prompt,
            config={
                "temperature": 0,
                "max_output_tokens": 1024,
                "system_instruction": _RERANK_SYSTEM,
            },
        )
        ranked_ids = _parse_ranked_ids(response.text)
        # Build result list in Gemini's order, guard against bad indices
        seen = set()
        reranked = []
        for idx in ranked_ids:
            if isinstance(idx, int) and 0 <= idx < len(candidates) and idx not in seen:
                reranked.append(candidates[idx])
                seen.add(idx)
        # Append any candidates Gemini missed (shouldn't happen, but be safe)
        for i, c in enumerate(candidates):
            if i not in seen:
                reranked.append(c)
        logger.debug("Re-ranked order: %s", ranked_ids)
        return reranked[:top_k]
    except Exception as exc:
        logger.warning("Gemini rerank failed (%s) — using cosine order.", exc)
        return candidates[:top_k]


async def rerank_async(user_query: str, candidates: list[dict], top_k: int = 5, keywords: list[str] | None = None) -> list[dict]:
    """Async version of rerank — uses aio client to avoid blocking the event loop."""
    if not _client or len(candidates) <= 1:
        return candidates[:top_k]

    if not keywords and len(candidates) >= 2:
        top_score = float(candidates[0].get("score", 0))
        second_score = float(candidates[1].get("score", 0))
        if top_score > 0.6 and (top_score - second_score) > 0.15:
            return candidates[:top_k]

    summaries = []
    for i, e in enumerate(candidates):
        body_snippet = extract_relevant_passage(e.get("body") or e.get("snippet") or "", user_query, window=400).replace("\n", " ")
        date = e.get("date", "unknown date")
        summaries.append(
            f'ID {i}: [{date}] From: {e.get("sender","")} '
            f'| Subject: {e.get("subject","")} '
            f'| Body: {body_snippet}'
        )

    prompt = (
        f'Search query: "{user_query}"\n\n'
        f"Candidates:\n" + "\n".join(summaries) + "\n\n"
        "Return a JSON array of the IDs ranked from most to least relevant. Example: [2, 0, 4, 1, 3]"
    )

    try:
        response = await _client.aio.models.generate_content(
            model=_MODEL,
            contents=prompt,
            config={
                "temperature": 0,
                "max_output_tokens": 1024,
                "system_instruction": _RERANK_SYSTEM,
            },
        )
        ranked_ids = _parse_ranked_ids(response.text)
        seen = set()
        reranked = []
        for idx in ranked_ids:
            if isinstance(idx, int) and 0 <= idx < len(candidates) and idx not in seen:
                reranked.append(candidates[idx])
                seen.add(idx)
        for i, c in enumerate(candidates):
            if i not in seen:
                reranked.append(c)
        logger.debug("Re-ranked order: %s", ranked_ids)
        return reranked[:top_k]
    except Exception as exc:
        logger.warning("Gemini rerank_async failed (%s) — using cosine order.", exc)
        return candidates[:top_k]


def synthesize_answer(query: str, results: list[dict]) -> str:
    """Reason across top results and return a direct 2-3 sentence answer with citations.

    Falls back to empty string if Gemini is unavailable or fails.
    """
    if not _client or not results:
        return ""

    context_parts = []
    for i, r in enumerate(results[:5]):
        body_preview = extract_relevant_passage(r.get("body") or "", query, window=600)
        context_parts.append(
            f"Email {i + 1} [{r.get('date', '')}] from {r.get('sender', '')}:\n"
            f"Subject: {r.get('subject', '')}\n"
            f"Body: {body_preview}"
        )
    context = "\n\n".join(context_parts)

    prompt = (
        f"User question: {query}\n\n"
        f"Emails found:\n{context}\n\n"
        f"Write 1-2 sentences summarizing what these emails contain in relation to the user's question. "
        f"Reference specific emails by number (e.g. 'Email 2 mentions...'). "
        f"Always present what was found — if the match isn't exact, describe what's closest."
    )

    try:
        response = _client.models.generate_content(
            model=_MODEL,
            contents=prompt,
            config={"temperature": 0, "max_output_tokens": 512},
        )
        return response.text.strip()
    except Exception as exc:
        logger.warning("synthesize_answer failed (%s)", exc)
        return ""


def _fallback(user_query: str) -> dict:
    """Best-effort intent extraction without Gemini, so hard filters still apply."""
    q = user_query.lower()

    sender = None
    sender_match = re.search(r"\bfrom\s+([a-z0-9._@+-]+)", q)
    if sender_match:
        sender = sender_match.group(1).strip()

    date_hint = None
    if re.search(r"\blast\s+week\b", q):
        date_hint = "last_week"
    elif re.search(r"\blast\s+month\b", q):
        date_hint = "last_month"
    elif re.search(r"\blast\s+year\b", q):
        date_hint = "last_year"

    # Extract meaningful topic words after "about" as keywords
    keywords = []
    about_match = re.search(r"\babout\s+(?:my\s+)?([a-z0-9 ]+?)(?:\s+from|\s+in|\s+last|\s*$)", q)
    if about_match:
        keywords = [w for w in about_match.group(1).strip().split() if len(w) > 3]

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "mode": "find",
        "search_query": user_query,
        "keywords": keywords,
        "sender": sender,
        "date_hint": date_hint,
        "topic": user_query,
        "search_focus": "any",
        "extract_field": None,
        "uses_prior_context": False,
        "context_ref": None,
    }
