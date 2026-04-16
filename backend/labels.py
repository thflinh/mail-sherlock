"""Smart label assignment for mail-sherlock.

Strategy: rule-based first (fast, no API call).
Gemini fallback for emails where no rule matches and a body is available.
"""

from __future__ import annotations

import logging
import os

import google.genai as genai

logger = logging.getLogger(__name__)

_api_key = os.environ.get("GEMINI_API_KEY", "")
_client = genai.Client(api_key=_api_key) if _api_key else None
_MODEL = "gemini-2.5-flash"

# ── Rule-based matching ───────────────────────────────────────────────────────

LABEL_RULES: dict[str, list[str]] = {
    "housing": [
        "lease", "rent", "landlord", "tenant", "utilities", "apartment",
        "mortgage", "eviction", "deposit", "sublease", "maintenance request",
        "property", "roommate",
    ],
    "finance": [
        "invoice", "payment", "receipt", "bank", "paypal", "venmo", "zelle",
        "subscription", "charge", "refund", "credit card", "statement",
        "transaction", "billing", "tax", "irs", "w-2", "1099",
    ],
    "work": [
        "offer letter", "interview", "onboarding", "salary", "recruiter",
        "linkedin", "job offer", "performance review", "hr@", "your application",
        "start date", "background check", "direct deposit", "payroll",
    ],
    "school": [
        "deadline", "assignment", "grade", "canvas", "professor", "course",
        "enrollment", "semester", "tuition", "financial aid", "transcript",
        "gpa", "class schedule", "syllabus", "final exam",
    ],
}

_GEMINI_LABELS = list(LABEL_RULES.keys())

_CLASSIFY_SYSTEM = f"""You are an email classifier. Assign one or more labels from this list: {_GEMINI_LABELS}.
Return ONLY a JSON array of matching label strings, e.g. ["finance", "work"].
If none apply, return an empty array [].
No explanation, no markdown."""


def _rule_match(email: dict) -> list[str]:
    """Return all labels whose keywords appear in the email's subject + snippet + sender."""
    text = " ".join([
        (email.get("subject") or ""),
        (email.get("snippet") or ""),
        (email.get("sender") or ""),
        (email.get("body") or "")[:500],
    ]).lower()

    matched = []
    for label, keywords in LABEL_RULES.items():
        if any(kw in text for kw in keywords):
            matched.append(label)
    return matched


def _gemini_classify(email: dict) -> list[str]:
    """Ask Gemini to classify an email when no rules matched."""
    if not _client:
        return []
    subject = email.get("subject") or ""
    snippet = email.get("snippet") or ""
    sender = email.get("sender") or ""
    body = (email.get("body") or "")[:500]

    user_prompt = (
        f"Sender: {sender}\n"
        f"Subject: {subject}\n"
        f"Preview: {snippet}\n"
        f"Body excerpt: {body}"
    )
    try:
        resp = _client.models.generate_content(
            model=_MODEL,
            contents=user_prompt,
            config={
                "temperature": 0,
                "max_output_tokens": 64,
                "system_instruction": _CLASSIFY_SYSTEM,
            },
        )
        import json
        import re
        text = (resp.text or "").strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        result = json.loads(text)
        if isinstance(result, list):
            return [label for label in result if label in _GEMINI_LABELS]
    except Exception as exc:
        logger.debug("Gemini classify failed (%s)", exc)
    return []


def assign_labels(email: dict, custom_rules: dict[str, list[str]] | None = None) -> list[str]:
    """Assign smart labels to an email.

    Checks subject + snippet + sender + body excerpt against LABEL_RULES
    and any custom_rules provided. Falls back to Gemini classification
    if no rule matches and the email has a body.

    Args:
        email: Email dict with at least subject, snippet, sender keys.
        custom_rules: Optional extra label rules keyed by label name.

    Returns:
        List of matching label strings (may be empty).
    """
    merged_rules = {**LABEL_RULES, **(custom_rules or {})}
    text = " ".join([
        (email.get("subject") or ""),
        (email.get("snippet") or ""),
        (email.get("sender") or ""),
        (email.get("body") or "")[:500],
    ]).lower()

    matched = []
    for label, keywords in merged_rules.items():
        if any(kw in text for kw in keywords):
            matched.append(label)

    if not matched and (email.get("body") or email.get("snippet")):
        matched = _gemini_classify(email)

    return matched


def assign_labels_bulk(emails: list[dict], custom_rules: dict[str, list[str]] | None = None) -> None:
    """Assign smart labels in-place for a list of emails (modifies each dict)."""
    for email in emails:
        email["smartLabels"] = assign_labels(email, custom_rules)
