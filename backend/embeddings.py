import numpy as np

# BAAI/bge-base-en-v1.5 — retrieval-optimised, outperforms MiniLM on search benchmarks.
# Drop-in replacement; produces 768-dim normalised vectors.
EMBEDDING_DIM: int = 384

_model = None


def _get_model():
    """Load SentenceTransformer on first use so OAuth/landing/health start without heavy imports."""
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def encode(texts: list[str]) -> np.ndarray:
    return _get_model().encode(
        texts, convert_to_numpy=True, normalize_embeddings=True
    )


def cosine_similarity(query_vec: np.ndarray, email_vecs: np.ndarray) -> np.ndarray:
    # Both are already L2-normalized, so dot product == cosine similarity
    return email_vecs @ query_vec


def document_search_text(doc: dict) -> str:
    """Build corpus text for embedding.

    Subject carries ~10x more signal than body for search, so we repeat it 3x
    to tilt the embedding space toward it without losing body context.
    """
    subject = doc.get("subject") or ""
    sender = doc.get("sender") or ""
    body = (doc.get("body") or "")[:500]
    return f"{subject}. {subject}. {subject}. From: {sender} {body}"


def add_embeddings_inplace(docs: list[dict]) -> None:
    """Compute and store 2 separate embeddings per doc for field-weighted retrieval.

    Stores:
      emb_subject  — subject only (high signal for topic queries)
      emb_body     — first 1000 chars of body (for "what did X say?" queries)
    """
    if not docs:
        return
    subjects = [d.get("subject") or "" for d in docs]
    bodies   = [(d.get("body") or "")[:1000] for d in docs]

    emb_subj = encode(subjects)
    emb_body = encode(bodies)

    for i, d in enumerate(docs):
        d["emb_subject"] = emb_subj[i].astype(np.float32).tolist()
        d["emb_body"]    = emb_body[i].astype(np.float32).tolist()

def warmup() -> None:
    """Load the model into memory now so the first search request is instant."""
    _get_model()


def field_embeddings_ready(docs: list[dict]) -> bool:
    """True if docs have the 3-field embedding structure from the current schema."""
    return all(
        isinstance(d.get("emb_subject"), list) and len(d["emb_subject"]) == EMBEDDING_DIM
        for d in docs
    )
