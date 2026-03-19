from sentence_transformers import SentenceTransformer
import numpy as np

model = SentenceTransformer("all-MiniLM-L6-v2")


def encode(texts: list[str]) -> np.ndarray:
    return model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)


def cosine_similarity(query_vec: np.ndarray, email_vecs: np.ndarray) -> np.ndarray:
    # Both are already L2-normalized, so dot product == cosine similarity
    return email_vecs @ query_vec
