"""Regression coverage for the Phase 3 RAG compatibility entry points."""

from __future__ import annotations

import asyncio
import math

import pytest


def test_phase3_vector_store_round_trip_and_cleanup(tmp_path) -> None:
    from backend.db.vector_store import VectorStore

    store = VectorStore(tmp_path / "vectors.db")
    try:
        store.insert_chunk("doc-1", 0, "hello world", [0.1] * 384, "test.txt")
        store.insert_chunk("doc-2", 0, "other text", [0.0] * 383 + [1.0], "other.txt")
        results = store.search([0.1] * 384, top_k=1, document_ids=["doc-1"])
        assert [result["content"] for result in results] == ["hello world"]
        assert store.get_document_chunk_count("doc-1") == 1
        assert store.delete_document_chunks("doc-1") == 1
        assert store.get_document_chunk_count("doc-1") == 0
    finally:
        store.close()


def test_phase3_vector_store_rejects_invalid_vectors(tmp_path) -> None:
    from backend.db.vector_store import VectorStore

    store = VectorStore(tmp_path / "vectors.db")
    try:
        with pytest.raises(ValueError, match="384"):
            store.insert_chunk("doc", 0, "text", [0.0], "test.txt")
        with pytest.raises(ValueError, match="non-finite"):
            store.insert_chunk("doc", 0, "text", [math.nan] * 384, "test.txt")
    finally:
        store.close()


def test_phase3_parser_and_chunking_contract(tmp_path) -> None:
    from backend.knowledge.ingestion import chunk_text
    from backend.knowledge.parser import DocumentParseError, parse_document

    source = tmp_path / "runbook.txt"
    source.write_text("This is a searchable test document.", encoding="utf-8")
    assert "searchable test" in parse_document(source)

    empty = tmp_path / "empty.txt"
    empty.touch()
    with pytest.raises(DocumentParseError, match="empty"):
        parse_document(empty)

    chunks = chunk_text("Hello world. " * 100, chunk_size=128, overlap=16)
    assert len(chunks) > 1
    assert all(len(chunk) <= 128 for chunk in chunks)


def test_phase3_embedding_client_uses_bounded_local_batches() -> None:
    from backend.knowledge.embeddings import EmbeddingClient

    class Provider:
        def __init__(self) -> None:
            self.batch_sizes: list[int] = []

        async def embed_batch(self, texts: list[str]) -> list[list[float]]:
            self.batch_sizes.append(len(texts))
            return [[1.0] + [0.0] * 383 for _ in texts]

    class Manager:
        def __init__(self) -> None:
            self.provider = Provider()

        def get_embedding_provider(self) -> Provider:
            return self.provider

    manager = Manager()
    vectors = asyncio.run(EmbeddingClient(manager).embed_batch(["text"] * 33))
    assert len(vectors) == 33
    assert manager.provider.batch_sizes == [32, 1]


def test_phase3_facade_uses_authoritative_coordinator_and_routes() -> None:
    from backend.documents.coordinator import IngestionCoordinator as ActiveCoordinator
    from backend.knowledge.ingestion import IngestionCoordinator
    from backend.main import create_app

    assert IngestionCoordinator is ActiveCoordinator
    paths = create_app().openapi()["paths"]
    assert "get" in paths["/api/v1/jobs/{job_id}"]
    assert "get" in paths["/api/v1/knowledge/documents/{document_id}/status"]
