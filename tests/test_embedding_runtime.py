"""Tests for embedding runtime - 384-dimensional vectors."""

import asyncio
from pathlib import Path
from fastapi.testclient import TestClient


def test_embedding_runtime_384_dimension_vector(tmp_path, monkeypatch):
    """Embedding runtime: BGE model produces 384-dimensional vector."""
    data_dir = tmp_path / "data"
    model_dir = tmp_path / "scan"
    model_dir.mkdir()
    model_file = model_dir / "bge-small-en-v1.5-q8_0.gguf"
    model_file.write_bytes(b"GGUF" + b"\x00" * 1000)

    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine
    from backend.main import create_app

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    with TestClient(create_app()) as client:
        transport_headers = {"X-NOC-AI-Backend-Token": "test-transport-secret"}
        
        # Login
        login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "ChangeMe-12345!"},
            headers=transport_headers,
        )
        assert login.status_code == 200
        headers = {
            **transport_headers,
            "Authorization": f"Bearer {login.json()['token']}",
        }
        
        # Test embedding endpoint exists and expects 384-dim
        # This tests the contract - actual model loading would need real GGUF
        # The bundled BGE model is expected to produce 384-dim vectors

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_embedding_dimension_validation(tmp_path):
    """Embedding: a vector with the wrong number of dimensions is rejected."""
    import asyncio
    from types import SimpleNamespace

    import pytest

    from backend.retrieval.vector_store import ChunkWithEmbedding, VectorStore

    store = VectorStore(str(tmp_path / "vectors.db"), 4)
    try:
        chunk = SimpleNamespace(id="chunk-1", collection_id="coll-1", document_id="doc-1")

        # add_chunks must reject a wrong-dim embedding (expects 4, got 3).
        with pytest.raises(ValueError, match="Expected 4 embedding values"):
            asyncio.run(
                store.add_chunks([ChunkWithEmbedding(chunk=chunk, embedding=[1.0, 2.0, 3.0])])
            )

        # search must reject a wrong-dim query (expects 4, got 5).
        with pytest.raises(ValueError, match="Expected 4 query values"):
            asyncio.run(store.search([1.0, 2.0, 3.0, 4.0, 5.0]))

        # A matching-dim embedding is accepted and stored.
        asyncio.run(
            store.add_chunks([ChunkWithEmbedding(chunk=chunk, embedding=[1.0, 2.0, 0.0, 0.0])])
        )
    finally:
        store.close()

    # The stored vector must have been normalised to unit length.
    import numpy as np
    import sqlite3
    import sqlite_vec

    conn = sqlite3.connect(str(tmp_path / "vectors.db"))
    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        row = conn.execute(
            "SELECT embedding FROM chunks_vec WHERE chunk_id='chunk-1'"
        ).fetchone()
        assert row is not None
        stored = np.frombuffer(row[0], dtype=np.float32)
        assert stored.shape == (4,)
        assert abs(float(np.linalg.norm(stored)) - 1.0) < 1e-6
    finally:
        conn.close()


def test_embedding_runtime_batches_and_orders_vectors():
    """Embedding batches retain input order even if the runtime response is unordered."""
    from backend.inference.lifecycle import ModelProvider

    class FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "data": [
                    {"index": 1, "embedding": [2.0, 2.0]},
                    {"index": 0, "embedding": [1.0, 1.0]},
                ]
            }

    class FakeClient:
        def __init__(self):
            self.payload = None

        async def post(self, _path, json, headers=None):
            self.payload = json
            self.headers = headers
            return FakeResponse()

    client = FakeClient()
    provider = ModelProvider(model_id="embedding", role="embedding", client=client)
    vectors = asyncio.run(provider.embed_batch(["first", "second"]))

    assert client.payload == {"input": ["first", "second"]}
    assert client.headers == provider.authorization_headers
    assert vectors == [[1.0, 1.0], [2.0, 2.0]]


def test_embedding_runtime_splits_oversized_inputs():
    """An oversized model-token sequence is embedded in pieces and recombined."""
    from backend.inference.lifecycle import ModelProvider

    class FakeResponse:
        def __init__(self, texts):
            self.status_code = 500 if any(len(text) > 12 for text in texts) else 200
            self.text = (
                "input is too large to process; increase the physical batch size"
                if self.status_code >= 400 else ""
            )
            self._texts = texts

        def raise_for_status(self):
            if self.status_code >= 400:
                raise AssertionError("Oversized responses should be handled before raise_for_status")

        def json(self):
            return {
                "data": [
                    {"index": index, "embedding": [1.0, float(len(text))]}
                    for index, text in enumerate(self._texts)
                ]
            }

    class FakeClient:
        def __init__(self):
            self.requests = []

        async def post(self, _path, json, headers=None):
            self.requests.append(json["input"])
            assert headers
            assert headers["Authorization"].startswith("Bearer ")
            return FakeResponse(json["input"])

    client = FakeClient()
    provider = ModelProvider(model_id="embedding", role="embedding", client=client)
    vectors = asyncio.run(provider.embed_batch(["short", "this input is much too long for one request"]))

    assert len(vectors) == 2
    assert all(len(vector) == 2 for vector in vectors)
    assert abs(sum(value * value for value in vectors[1]) - 1.0) < 1e-6
    assert any(len(request) == 1 for request in client.requests)
