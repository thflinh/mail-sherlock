"""Gemini multi-mode email agent for mail-sherlock.

Modes: find, answer, summarize, extract, chitchat
Each mode has a dedicated prompt strategy and returns an AgentResponse.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

import google.genai as genai

from passage_select import body_for_llm

logger = logging.getLogger(__name__)

_api_key = os.environ.get("GEMINI_API_KEY", "")
_client = genai.Client(api_key=_api_key) if _api_key else None

_MODEL = "gemini-2.5-flash"


@dataclass
class AgentResponse:
    reply: str
    results: list[dict] = field(default_factory=list)
    mode: str = "find"


def _call(system: str, user: str, max_tokens: int = 1024) -> str:
    """Single Gemini call. Returns empty string on failure."""
    if not _client:
        return ""
    try:
        resp = _client.models.generate_content(
            model=_MODEL,
            contents=user,
            config={
                "temperature": 0.3,
                "max_output_tokens": max_tokens,
                "system_instruction": system,
            },
        )
        return (resp.text or "").strip()
    except Exception as exc:
        logger.warning("Gemini call failed (%s)", exc)
        return ""


def _format_candidates(emails: list[dict]) -> str:
    lines = []
    for i, e in enumerate(emails):
        lines.append(
            f"[{i+1}] From: {e.get('sender','')} | Date: {e.get('date','')} "
            f"| Subject: {e.get('subject','')} | Preview: {e.get('snippet','')[:200]}"
        )
    return "\n".join(lines)


# ── Mode 1: find ──────────────────────────────────────────────────────────────

_FIND_SYSTEM = """You are Sherlock, a personal email assistant. The user wants to find emails.
You have been given a list of candidate emails that were retrieved by semantic search.
Rank them by relevance to the user's query and write a short natural-language intro (1-2 sentences).
Keep the intro conversational and specific — mention the most relevant email briefly.
Do not add bullet points or headers. Just the intro sentence(s)."""


def find(
    query: str,
    candidates: list[dict],
    conversation: list[dict] | None = None,
) -> AgentResponse:
    if not candidates:
        return AgentResponse(
            reply="I couldn't find any emails matching that description. Try rephrasing or adding more details.",
            results=[],
            mode="find",
        )

    candidate_text = _format_candidates(candidates)
    user_prompt = (
        f'User query: "{query}"\n\n'
        f"Candidate emails:\n{candidate_text}\n\n"
        f"Write a 1-2 sentence intro summarizing what you found. "
        f"Then list the IDs in order from most to least relevant as: RANKED: [1,2,3,...]"
    )

    reply_text = _call(_FIND_SYSTEM, user_prompt, max_tokens=512)

    # Parse ranked order if Gemini provides it
    ranked_results = candidates
    if "RANKED:" in reply_text:
        parts = reply_text.split("RANKED:")
        intro = parts[0].strip()
        try:
            import json
            import re
            raw = re.search(r"\[[\d,\s]+\]", parts[1])
            if raw:
                order = json.loads(raw.group())
                reranked = []
                seen = set()
                for idx in order:
                    i = int(idx) - 1
                    if 0 <= i < len(candidates) and i not in seen:
                        reranked.append(candidates[i])
                        seen.add(i)
                for i, c in enumerate(candidates):
                    if i not in seen:
                        reranked.append(c)
                ranked_results = reranked
        except Exception:
            pass
        reply_text = intro

    if not reply_text:
        n = len(candidates)
        reply_text = f"I found {n} email{'s' if n != 1 else ''} matching your search."

    return AgentResponse(reply=reply_text, results=ranked_results[:5], mode="find")


# ── Mode 2: answer ────────────────────────────────────────────────────────────

_ANSWER_SYSTEM = """You are Sherlock, a personal email assistant. The user has a question about a specific email.
Read the email carefully and answer the question directly and concisely.
Cite the relevant part of the email when possible (e.g., "Section 4 says...").
If the answer is not in the email, say so clearly — do not guess."""


def answer(
    question: str,
    email: dict,
    conversation: list[dict] | None = None,
) -> AgentResponse:
    # Body may already be passage- or chunk-augmented in main._augment_email_body_for_llm
    body = (email.get("body") or email.get("snippet") or "")[:8000]
    user_prompt = (
        f"Email from: {email.get('sender','')}\n"
        f"Subject: {email.get('subject','')}\n"
        f"Date: {email.get('date','')}\n"
        f"Body:\n{body}\n\n"
        f"Question: {question}"
    )

    reply_text = _call(_ANSWER_SYSTEM, user_prompt, max_tokens=512)
    if not reply_text:
        reply_text = "I wasn't able to read that email right now. Please try again."

    return AgentResponse(reply=reply_text, results=[email], mode="answer")


# ── Mode 3: summarize ─────────────────────────────────────────────────────────

_SUMMARIZE_SYSTEM = """You are Sherlock, a personal email assistant. Summarize the following email(s) clearly and concisely.
Focus on: key information, any actions required, decisions made, deadlines mentioned.
Write in plain English. Be brief but complete.
If there are multiple emails, synthesize them into a coherent summary — don't just list each one."""


def summarize(
    emails: list[dict],
    user_request: str,
) -> AgentResponse:
    if not emails:
        return AgentResponse(
            reply="I couldn't find any emails to summarize.",
            results=[],
            mode="summarize",
        )

    blocks = []
    for i, e in enumerate(sorted(emails, key=lambda x: x.get("date", ""))):
        raw = e.get("body") or e.get("snippet") or ""
        body, _ = body_for_llm(raw, user_request, max_chars=2400)
        blocks.append(
            f"--- Email {i+1} ---\n"
            f"From: {e.get('sender','')}\n"
            f"Subject: {e.get('subject','')}\n"
            f"Date: {e.get('date','')}\n"
            f"Body: {body}"
        )

    user_prompt = "\n\n".join(blocks) + f"\n\nUser's request: {user_request}"

    reply_text = _call(_SUMMARIZE_SYSTEM, user_prompt, max_tokens=768)
    if not reply_text:
        reply_text = f"Here {'is' if len(emails) == 1 else 'are'} the {len(emails)} email{'s' if len(emails) != 1 else ''} I found."

    return AgentResponse(reply=reply_text, results=emails[:5], mode="summarize")


# ── Mode 4: extract ───────────────────────────────────────────────────────────

_EXTRACT_SYSTEM = """You are a data extraction assistant. Extract only the requested field from the email.
Return the value as plainly as possible — just the value, no preamble.
If not found, say exactly: "Not mentioned in this email." """


def extract(
    extract_field: str,
    email: dict,
) -> AgentResponse:
    body = (email.get("body") or email.get("snippet") or "")[:8000]
    user_prompt = (
        f"Extract: {extract_field}\n\n"
        f"Email:\n"
        f"Subject: {email.get('subject','')}\n"
        f"From: {email.get('sender','')}\n"
        f"Date: {email.get('date','')}\n"
        f"Body:\n{body}"
    )

    reply_text = _call(_EXTRACT_SYSTEM, user_prompt, max_tokens=256)
    if not reply_text:
        reply_text = "I wasn't able to extract that information right now."

    return AgentResponse(reply=reply_text, results=[email], mode="extract")


# ── Mode 5: chitchat ──────────────────────────────────────────────────────────

_CHITCHAT_SYSTEM = """You are Sherlock, a friendly personal email assistant.
Respond conversationally. Keep it brief (1-3 sentences).
If the user seems to want to search for something, gently prompt them.
Never pretend to have searched when you haven't."""


def chitchat(
    message: str,
    conversation: list[dict] | None = None,
) -> AgentResponse:
    reply_text = _call(_CHITCHAT_SYSTEM, message, max_tokens=256)
    if not reply_text:
        reply_text = "I'm here to help you find and understand your emails. What are you looking for?"

    return AgentResponse(reply=reply_text, results=[], mode="chitchat")
