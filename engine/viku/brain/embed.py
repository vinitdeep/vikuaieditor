"""Embedding hook (Phase 3: intfloat/multilingual-e5-small, ONNX/CPU).

Interface the rest of the engine uses - keep it when the real model lands:
  available() -> bool
  embed_texts(texts: list[str]) -> np.ndarray (n, d), L2-normalised
  similarity_to_favourites(text) -> float in [-1, 1]  (mean cos to kept reels - mean cos to rejected reels)
Until a model is installed these return False / raise / 0.0, so the "semantic" feature is neutral.
Library search can also call embed_texts() on image titles+tags and the query.
"""
from __future__ import annotations

import numpy as np

_MODEL = None  # Phase 3: lazily loaded onnxruntime session + tokenizer


def available() -> bool:
    return _MODEL is not None


def embed_texts(texts: list[str]) -> np.ndarray:
    raise NotImplementedError("embedding model not installed (Phase 3)")


def similarity_to_favourites(text: str) -> float:
    return 0.0  # neutral until the Phase 3 model + favourite/rejected reel embeddings exist
