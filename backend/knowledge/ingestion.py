"""Compatibility entry points for the authoritative document ingestion pipeline."""

from __future__ import annotations

from enum import Enum

from backend.documents.coordinator import IngestionCoordinator


CHUNK_SIZE = 512
CHUNK_OVERLAP = 64


class JobStatus(str, Enum):
    """Public names mapped to the durable statuses used by the application."""

    QUEUED = "pending"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    READY = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


def chunk_text(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Split text into bounded, overlapping character chunks."""
    if not text:
        return []
    if chunk_size < 1:
        raise ValueError("chunk_size must be positive")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be non-negative and smaller than chunk_size")

    chunks: list[str] = []
    start = 0
    while start < len(text):
        hard_end = min(len(text), start + chunk_size)
        end = hard_end
        if hard_end < len(text):
            search_start = max(start + 1, hard_end - min(100, chunk_size // 2))
            region = text[search_start:hard_end]
            boundaries = [region.rfind(marker) for marker in ("\n\n", ". ", "? ", "! ")]
            boundary = max(boundaries)
            if boundary >= 0:
                marker_length = 2
                end = search_start + boundary + marker_length
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)
    return chunks


__all__ = ["IngestionCoordinator", "JobStatus", "chunk_text"]
