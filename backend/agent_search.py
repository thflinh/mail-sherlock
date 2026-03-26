"""Gemini-powered query understanding for mail-sherlock search."""

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

_SYSTEM_PROMPT = """You are an expert email search assistant. Given a conversation, determine the user's CURRENT search intent (the latest message may refine a previous one, or be a completely new query).

Extract structured search intent and respond ONLY with a single valid JSON object — no markdown, no code fences, no explanation.

Rules:
- "search_query": rephrase the CURRENT intent into a clean, descriptive sentence for semantic similarity search. Expand abbreviations, resolve pronouns using conversation context.
- "keywords": specific words that MUST appear verbatim in relevant emails (names, order/ticket numbers, exact phrases). Only highly discriminative terms.
- "sender": sender name or email if mentioned, otherwise null.
- "date_hint": if a time range is implied, return exactly one of: last_week, last_month, last_year. Otherwise null.
- "topic": one sentence summarising what the user is currently looking for.

Schema:
{
  "search_query": "<expanded descriptive query reflecting current intent>",
  "keywords": ["<keyword1>", "<keyword2>"],
  "sender": "<name or email, or null>",
  "date_hint": "<last_week | last_month | last_year | null>",
  "topic": "<one sentence summary of current search>"
}"""


def understand_query(user_query: str, history: list[dict] | None = None) -> dict:
    """Call Gemini to extract structured search intent from a natural language query.

    Args:
        user_query: The latest user message.
        history: Optional list of previous turns as {"role": "user"|"assistant", "content": str}.
                 Lets Gemini resolve follow-ups like "narrow to last month" against prior context.

    Returns a dict with keys: search_query, keywords, sender, date_hint, topic.
    Falls back to raw query passthrough if Gemini is unavailable or fails.
    """
    if not _client:
        return _fallback(user_query)

    # Build the conversation: system context + history + current user message
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
                "system_instruction": _SYSTEM_PROMPT,
            },
        )
        text = response.text.strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        parsed = json.loads(text)
        logger.debug("Gemini intent: %s", parsed)
        return parsed
    except Exception as exc:
        logger.warning("Gemini call failed (%s) — using raw query fallback.", exc)
        return _fallback(user_query)


def _fallback(user_query: str) -> dict:
    return {
        "search_query": user_query,
        "keywords": [],
        "sender": None,
        "date_hint": None,
        "topic": user_query,
    }
