from sentence_transformers import SentenceTransformer
import numpy as np

model = SentenceTransformer("all-MiniLM-L6-v2")

EMBEDDING_DIM: int = int(model.get_sentence_embedding_dimension())


def encode(texts: list[str]) -> np.ndarray:
    return model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)


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
