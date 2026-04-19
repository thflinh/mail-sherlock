"""Sliding-window passage selection for long email bodies (cheap RAG augmentation)."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def extract_relevant_passage(body: str, query: str, window: int = 400, step: int = 100) -> str:
    """Return the fixed-size window in body whose token overlap with the query is highest."""
    if not body:
        return ""
    q = (query or "").strip().lower()
    query_words = {w for w in q.split() if len(w) > 1}
    if not query_words:
        return body[:window]
    best_score = -1
    best_passage = body[:window]
    upper = max(1, len(body) - window + 1)
    for i in range(0, upper, step):
        chunk = body[i : i + window]
        score = sum(1 for w in query_words if w in chunk.lower())
        if score > best_score:
            best_score = score
            best_passage = chunk
    return best_passage


def body_for_llm(
    raw: str,
    query: str,
    *,
    max_chars: int = 5200,
    primary_window: int = 1800,
    tail_chars: int = 600,
) -> tuple[str, dict[str, Any]]:
    """Pick query-relevant spans plus optional tail for signatures; cap total length.

    Returns (text_for_model, meta) where meta includes instrumentation fields.
    """
    text = raw or ""
    raw_len = len(text)
    meta: dict[str, Any] = {
        "raw_body_len": raw_len,
        "max_chars": max_chars,
        "truncated_vs_raw": False,
        "strategy": "full",
        "sent_len": raw_len,
    }
    if raw_len <= max_chars:
        meta["sent_len"] = raw_len
        return text, meta

    primary = extract_relevant_passage(text, query, window=min(primary_window, raw_len), step=120)
    tail = text[-tail_chars:] if raw_len > tail_chars else text
    tail_redundant = tail.strip() and tail in primary

    if tail_redundant or len(primary) >= max_chars - 40:
        out = primary[:max_chars]
        meta["strategy"] = "primary_window_only"
        meta["truncated_vs_raw"] = len(out) < raw_len
        meta["sent_len"] = len(out)
        return out, meta

    sep = "\n\n[... middle of message omitted ...]\n\n"
    budget = max_chars - len(sep) - len(tail)
    head_part = primary[: max(budget, 0)]
    out = (head_part + sep + tail)[:max_chars]
    meta["strategy"] = "primary_plus_tail"
    meta["truncated_vs_raw"] = True
    meta["sent_len"] = len(out)
    return out, meta


def log_rag_passage_context(
    mode: str,
    email_id: str | None,
    meta: dict[str, Any],
    *,
    top_retrieval_score: float | None = None,
    chunk_meta: dict[str, Any] | None = None,
) -> None:
    """Structured INFO log to justify chunk RAG / tuning."""
    parts = [
        f"mode={mode}",
        f"email_id={email_id or '-'}",
        f"raw_body_len={meta.get('raw_body_len')}",
        f"sent_len={meta.get('sent_len')}",
        f"truncated_vs_raw={meta.get('truncated_vs_raw')}",
        f"passage_strategy={meta.get('strategy')}",
    ]
    if top_retrieval_score is not None:
        parts.append(f"top_retrieval_score={top_retrieval_score}")
    if chunk_meta:
        parts.append(f"chunks_hit={chunk_meta.get('chunk_row_count', 0)}")
        parts.append(f"chunks_merged={chunk_meta.get('chunks_used', 0)}")
        parts.append(f"chunk_context={chunk_meta.get('used_chunk_rag', False)}")
    logger.info("rag_context %s", " ".join(parts))
