"""Gemini-powered query understanding and re-ranking for mail-sherlock search."""

import json
import logging
import os
import re

import google.genai as genai

logger = logging.getLogger(__name__)

_api_key = os.environ.get("GEMINI_API_KEY", "")
if not _api_key:
    logger.warning(
        "GEMINI_API_KEY is not set — Gemini query understanding is disabled. "
        "Set the env var to enable smarter search."
    )

_client = genai.Client(api_key=_api_key) if _api_key else None

# gemini-2.5-flash: best balance of speed and accuracy for structured extraction
_MODEL = "gemini-2.5-flash"

# ── Query understanding ────────────────────────────────────────────────────────

_UNDERSTAND_SYSTEM = """You are an expert email search assistant. Given a conversation, determine the user's CURRENT search intent.

The latest message may refine a previous one, or be a completely new query.

Your job:
1. If the query is too vague to search accurately (missing key details that would significantly change results), set needs_clarification=true and write ONE short, specific clarifying question.
   - Only ask when it genuinely matters: e.g. "email from John" (which John?), "find that email" (about what?).
   - Do NOT ask if the user has already given enough context, or if this is a follow-up that builds on history.
2. Otherwise, extract structured search intent.

Respond ONLY with a single valid JSON object — no markdown, no code fences, no explanation.

Schema:
{
  "needs_clarification": false,
  "clarifying_question": null,
  "search_query": "<expanded descriptive query for semantic search — resolve pronouns using history>",
  "keywords": ["<verbatim words that must appear: names, order numbers, jargon>"],
  "sender": "<sender name or email if mentioned, else null>",
  "date_hint": "<last_week | last_month | last_year | null>",
  "topic": "<one sentence: what the user is currently looking for>"
}

When needs_clarification=true, set clarifying_question to the question and leave search_query/keywords/sender/date_hint as empty/null — the search will not run until the user replies."""

# ── Re-ranking ─────────────────────────────────────────────────────────────────

_RERANK_SYSTEM = """You are an email relevance judge. Given a user's search query and a list of email candidates, rank the candidates by how well they match what the user is looking for.

Consider: subject relevance, sender relevance, content relevance, and how well the email answers the user's need.

Return ONLY a JSON array of candidate IDs in order from most to least relevant. Include all IDs. No explanation, no markdown."""


def _strip_json(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text


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
        parsed = json.loads(_strip_json(response.text))
        logger.debug("Gemini intent: %s", parsed)
        return parsed
    except Exception as exc:
        logger.warning("Gemini understand_query failed (%s) — raw query fallback.", exc)
        return _fallback(user_query)


def rerank(user_query: str, candidates: list[dict], top_k: int = 5) -> list[dict]:
    """Re-rank semantic search candidates by true relevance using Gemini.

    Passes subject + sender + snippet to Gemini (not full body) to stay fast.
    Falls back to original cosine-score order if Gemini fails.

    Args:
        user_query: The original natural language query.
        candidates: Email dicts already sorted by cosine score (best first).
        top_k: Number of results to return.

    Returns:
        top_k email dicts in Gemini-ranked order.
    """
    if not _client or len(candidates) <= 1:
        return candidates[:top_k]

    # Build compact summaries so the prompt stays small
    summaries = []
    for i, e in enumerate(candidates):
        body_snippet = (e.get("body") or "")[:200].replace("\n", " ")
        summaries.append(
            f'ID {i}: From: {e.get("sender","")} | Subject: {e.get("subject","")} | {body_snippet}'
        )

    prompt = (
        f'Search query: "{user_query}"\n\n'
        f"Candidates:\n" + "\n".join(summaries) + "\n\n"
        f"Return a JSON array of the IDs ranked from most to least relevant. Example: [2, 0, 4, 1, 3]"
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
        ranked_ids = json.loads(_strip_json(response.text))
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


def _fallback(user_query: str) -> dict:
    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "search_query": user_query,
        "keywords": [],
        "sender": None,
        "date_hint": None,
        "topic": user_query,
    }
