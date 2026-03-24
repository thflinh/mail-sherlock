import numpy as np

# all-MiniLM-L6-v2 — fixed size; avoids loading PyTorch/transformers at import time.
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
    return f"{doc.get('subject', '')} {doc.get('body', '')}"


def add_embeddings_inplace(docs: list[dict]) -> None:
    """Fill each doc's ``embedding`` (list[float]) for MongoDB storage. Call after sync/seed."""
    if not docs:
        return
    texts = [document_search_text(d) for d in docs]
    vecs = encode(texts)
    for i, d in enumerate(docs):
        d["embedding"] = vecs[i].astype(np.float32).tolist()


def embeddings_ready(docs: list[dict]) -> bool:
    return all(
        isinstance(d.get("embedding"), list) and len(d["embedding"]) == EMBEDDING_DIM
        for d in docs
    )
