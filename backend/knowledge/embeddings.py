"""Embedding facade backed by the authenticated local model provider."""

from __future__ import annotations

import math
from typing import Any


EMBEDDING_DIM = 384
MAX_BATCH_SIZE = 32


class EmbeddingError(RuntimeError):
    """Raised when local embedding generation is unavailable or invalid."""


class EmbeddingClient:
    """Generate embeddings through ``ModelLifecycleManager`` without cloud calls."""

    def __init__(self, model_manager: Any) -> None:
        self._model_manager = model_manager

    def _get_provider(self) -> Any:
        provider = self._model_manager.get_embedding_provider()
        if provider is None:
            raise EmbeddingError(
                "No embedding model is loaded. Activate the bundled BGE embedding model."
            )
        return provider

    async def embed_single(self, text: str) -> list[float]:
        if not text.strip():
            raise EmbeddingError("Cannot embed empty text")
        return (await self.embed_batch([text]))[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if any(not text.strip() for text in texts):
            raise EmbeddingError("Cannot embed empty text")
        provider = self._get_provider()
        vectors: list[list[float]] = []
        try:
            for start in range(0, len(texts), MAX_BATCH_SIZE):
                vectors.extend(await provider.embed_batch(texts[start : start + MAX_BATCH_SIZE]))
        except Exception as exc:
            raise EmbeddingError(f"Local embedding request failed: {exc}") from exc
        if len(vectors) != len(texts):
            raise EmbeddingError(f"Expected {len(texts)} embeddings, got {len(vectors)}")
        for vector in vectors:
            if len(vector) != EMBEDDING_DIM:
                raise EmbeddingError(
                    f"Expected {EMBEDDING_DIM}-dimensional embedding, got {len(vector)}"
                )
            if not all(math.isfinite(value) for value in vector):
                raise EmbeddingError("Embedding contains a non-finite value")
        return vectors
