"""Per-email body chunk store + embedding retrieval for answer/extract (chunk-level RAG)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import numpy as np
from pymongo.errors import PyMongoError

from embeddings import EMBEDDING_DIM, cosine_similarity, encode

logger = logging.getLogger(__name__)

EMAIL_CHUNKS = "email_chunks"

CHUNK_CHARS = 480
CHUNK_STRIDE = 240
MAX_CHUNKS_PER_EMAIL = 80
INSERT_BATCH = 400


def ingest_key_for_email(doc: dict) -> str:
    """Partition chunks the same way emails are scoped in Mongo (session or account)."""
    s = (doc.get("owner_session") or "").strip()
    if s:
        return s
    return (doc.get("accountEmail") or "").strip()


def _split_body_chunks(body: str) -> list[tuple[int, str]]:
    if not body or not body.strip():
        return []
    out: list[tuple[int, str]] = []
    i = 0
    while i < len(body) and len(out) < MAX_CHUNKS_PER_EMAIL:
        piece = body[i : i + CHUNK_CHARS]
        if not piece.strip():
            break
        out.append((i, piece))
        i += CHUNK_STRIDE
    return out


def build_chunk_documents(emails: list[dict]) -> list[dict]:
    """CPU: chunk bodies + batch-encode; returns flat Mongo docs (no _id)."""
    if not emails:
        return []
    texts: list[str] = []
    meta: list[tuple[str, str, int, int]] = []  # ingest_key, email_id, chunk_idx, start

    for doc in emails:
        ikey = ingest_key_for_email(doc)
        eid = doc.get("id") or ""
        if not ikey or not eid:
            continue
        body = doc.get("body") or ""
        for chunk_idx, (start, chunk_text) in enumerate(_split_body_chunks(body)):
            texts.append(chunk_text)
            meta.append((ikey, eid, chunk_idx, start))

    if not texts:
        return []

    records: list[dict] = []
    batch = 256
    offset = 0
    while offset < len(texts):
        batch_texts = texts[offset : offset + batch]
        vecs = encode(batch_texts)
        for j in range(len(batch_texts)):
            idx = offset + j
            ikey, eid, chunk_idx, start = meta[idx]
            vec = vecs[j]
            records.append(
                {
                    "ingest_key": ikey,
                    "email_id": eid,
                    "chunk_idx": chunk_idx,
                    "start": start,
                    "text": texts[idx],
                    "embedding": vec.astype(np.float32).tolist(),
                }
            )
        offset += batch

    return records


async def ensure_chunk_indexes(db) -> None:
    try:
        coll = db[EMAIL_CHUNKS]
        await coll.create_index([("ingest_key", 1), ("email_id", 1)])
        await coll.create_index([("ingest_key", 1), ("email_id", 1), ("chunk_idx", 1)])
    except PyMongoError as exc:
        logger.warning("email_chunks index create failed: %s", exc)


async def rebuild_chunks_for_emails(db, emails: list[dict]) -> None:
    if not emails:
        return
    try:
        import asyncio

        loop = asyncio.get_running_loop()
        records = await loop.run_in_executor(None, build_chunk_documents, emails)
    except RuntimeError:
        records = build_chunk_documents(emails)

    keys = {ingest_key_for_email(e) for e in emails}
    keys.discard("")
    ids = [e.get("id") for e in emails if e.get("id")]
    if not keys or not ids:
        return
    if len(keys) != 1:
        logger.warning("rebuild_chunks_for_emails: skip mixed ingest_key batch %s", keys)
        return
    ingest_key = next(iter(keys))

    coll = db[EMAIL_CHUNKS]
    try:
        await coll.delete_many({"ingest_key": ingest_key, "email_id": {"$in": ids}})
        if records:
            for i in range(0, len(records), INSERT_BATCH):
                batch = records[i : i + INSERT_BATCH]
                await coll.insert_many(batch, ordered=False)
    except PyMongoError as exc:
        logger.warning("rebuild_chunks_for_emails failed: %s", exc)


async def merged_chunk_body_for_query(
    db,
    email_doc: dict,
    query: str,
    *,
    max_chars: int = 5200,
    top_chunks: int = 14,
) -> tuple[str | None, dict[str, Any]]:
    meta: dict[str, Any] = {
        "chunk_row_count": 0,
        "chunks_used": 0,
        "used_chunk_rag": False,
    }
    ikey = ingest_key_for_email(email_doc)
    email_id = str(email_doc.get("id") or "")
    if not ikey or not email_id:
        return None, meta

    coll = db[EMAIL_CHUNKS]
    try:
        rows = await coll.find(
            {"ingest_key": ikey, "email_id": email_id},
            {"embedding": 1, "text": 1, "chunk_idx": 1, "start": 1},
        ).to_list(length=500)
    except PyMongoError as exc:
        logger.warning("merged_chunk_body_for_query read failed: %s", exc)
        return None, meta

    meta["chunk_row_count"] = len(rows)
    clean = [
        r
        for r in rows
        if isinstance(r.get("embedding"), list) and len(r["embedding"]) == EMBEDDING_DIM
    ]
    if not clean:
        return None, meta

    qtext = (query or "").strip() or (clean[0].get("text") or "")[:200]
    try:
        enc = await asyncio.to_thread(encode, [qtext])
        qvec = enc[0].astype(np.float32)
    except Exception as exc:
        logger.warning("chunk query encode failed: %s", exc)
        return None, meta

    mat = np.asarray([r["embedding"] for r in clean], dtype=np.float32)
    scores = cosine_similarity(qvec, mat)
    order = np.argsort(scores)[::-1][:top_chunks]
    picked = [clean[int(i)] for i in order]
    picked.sort(key=lambda r: (r.get("start", 0), r.get("chunk_idx", 0)))

    parts: list[str] = []
    total = 0
    for r in picked:
        t = (r.get("text") or "").strip()
        if not t:
            continue
        sep = "\n\n---\n\n" if parts else ""
        if total + len(sep) + len(t) > max_chars:
            remain = max_chars - total - len(sep)
            if remain < 80:
                break
            t = t[:remain]
        parts.append(sep + t)
        total += len(sep) + len(t)
        if total >= max_chars:
            break

    if not parts:
        return None, meta

    out = "".join(parts)[:max_chars]
    meta["chunks_used"] = len(parts)
    meta["used_chunk_rag"] = True
    return out, meta
