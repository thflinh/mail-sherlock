import re
import zlib

import numpy as np
import pytest

from evals import harness

main = harness.import_main(live=False)  # blanks the database URI and Gemini key before import


def fake_encode(texts: list[str]) -> np.ndarray:
    """Deterministic bag-of-words vectors, so tests never download the embedding model."""
    out = np.zeros((len(texts), 384), dtype=np.float32)
    for i, text in enumerate(texts):
        for token in re.findall(r"[a-z0-9]+", text.lower()):
            out[i, zlib.crc32(token.encode()) % 384] += 1.0
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.where(norms == 0, 1, norms)


@pytest.fixture(autouse=True)
def no_embedding_model(monkeypatch):
    import chunk_index
    import embeddings

    for module in (main, embeddings, chunk_index):
        monkeypatch.setattr(module, "encode", fake_encode)
