"""Tests for retrieval and vector search."""

import numpy as np
from backend.retrieval.vector_store import VectorStore, SearchResult


def test_retrieval_vector_store_search(tmp_path):
    """Retrieval: vector store search returns SearchResult objects."""
    import tempfile
    import os
    
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        store = VectorStore(db_path, 384)
        
        # Test that SearchResult is properly defined
        result = SearchResult(
            chunk_id="chunk-1",
            document_id="doc-1",
            collection_id="coll-1",
            content="Test content",
            score=0.9,
            page_start=1,
            page_end=1,
            section_title="Section 1",
            metadata={"key": "value"}
        )
        assert result.chunk_id == "chunk-1"
        assert result.score == 0.9
        assert result.metadata == {"key": "value"}


def test_retrieval_search_with_filters(tmp_path):
    """Retrieval: search supports collection and document filters."""
    import tempfile
    import os
    
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        store = VectorStore(db_path, 384)
        
        # Test that search method accepts collection_ids and document_ids
        import inspect
        sig = inspect.signature(store.search)
        params = list(sig.parameters.keys())
        assert "collection_ids" in params
        assert "document_ids" in params
        assert "top_k" in params
        assert "filter_sql" in params
        assert "filter_params" in params


def _prepare_retrieval_db(tmp_path, monkeypatch, collections, documents, chunks):
    """Create the SQLAlchemy tables the vector store joins against and seed rows.

    Returns the configured VectorStore. `collections`/`documents`/`chunks` are
    lists of dicts mirroring the ORM columns the search join depends on.
    """
    from backend.config import get_settings
    from backend.db.database import Base, create_db_engine, get_session_factory
    from backend.db.models import Chunk, Collection, Document, Model, User

    db_path = str(tmp_path / "retrieval.db")
    database_url = f"sqlite:///{db_path}"
    monkeypatch.setenv("NOC_AI_DATABASE_URL", database_url)
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(tmp_path / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(tmp_path / "logs"))
    get_settings.cache_clear()
    create_db_engine.cache_clear()

    engine = create_db_engine(database_url)
    Base.metadata.create_all(engine)
    session_factory = get_session_factory(engine)

    with session_factory() as db:
        db.add(User(id="user-1", username="operator", password_hash="unused", roles=["operator"]))
        db.add(Model(id="emb-1", name="Embedding", filename="embedding.gguf",
                     filepath="embedding.gguf", size_bytes=1, role="embedding", status="active"))
        for coll in collections:
            db.add(Collection(id=coll["id"], name=coll["id"], owner_id="user-1",
                              embedding_model_id="emb-1", embedding_config={}, chunking_config={}))
        for doc in documents:
            db.add(Document(id=doc["id"], collection_id=doc["collection_id"], filename=doc["id"],
                            original_filename=doc["id"],
                            filepath=f"collections/{doc['collection_id']}/source/{doc['id']}",
                            mime_type="text/plain", size_bytes=10, file_hash="f0" * 32,
                            uploaded_by="user-1", status=doc.get("status", "ready")))
        for chunk in chunks:
            db.add(Chunk(id=chunk["id"], document_id=chunk["document_id"],
                         collection_id=chunk["collection_id"], chunk_index=chunk.get("index", 0),
                         content=chunk.get("content", chunk["id"])))
        db.commit()

    return VectorStore(str(tmp_path / "vectors.db"), 384)


def test_retrieval_search_returns_ranked_results(tmp_path, monkeypatch):
    """Retrieval: search over indexed chunks returns the matching chunks, nearest first."""
    import asyncio
    from types import SimpleNamespace

    from backend.retrieval.vector_store import ChunkWithEmbedding

    store = _prepare_retrieval_db(
        tmp_path, monkeypatch,
        collections=[{"id": "coll-1"}],
        documents=[{"id": "doc-1", "collection_id": "coll-1"}],
        chunks=[
            {"id": "chunk-1", "document_id": "doc-1", "collection_id": "coll-1",
             "content": "Interface Gi0/1 input errors exceeded threshold."},
            {"id": "chunk-2", "document_id": "doc-1", "collection_id": "coll-1",
             "content": "The routing table is empty."},
        ],
    )
    try:
        near = [0.0] * 384; near[0] = 1.0
        far = [0.0] * 384; far[383] = 1.0
        query = [0.0] * 384; query[0] = 0.9; query[1] = 0.4358898943  # unit vector, closer to `near`
        asyncio.run(store.add_chunks([
            ChunkWithEmbedding(chunk=SimpleNamespace(id="chunk-1", collection_id="coll-1", document_id="doc-1"), embedding=near),
            ChunkWithEmbedding(chunk=SimpleNamespace(id="chunk-2", collection_id="coll-1", document_id="doc-1"), embedding=far),
        ]))
        results = asyncio.run(store.search(query, top_k=10))
    finally:
        store.close()

    assert [r.chunk_id for r in results] == ["chunk-1", "chunk-2"]
    assert results[0].content == "Interface Gi0/1 input errors exceeded threshold."
    assert results[0].document_id == "doc-1"
    assert results[0].collection_id == "coll-1"
    assert results[0].score > results[1].score
    assert results[0].metadata == {}


def test_retrieval_search_filter_placeholders_are_consistent(tmp_path, monkeypatch):
    """Retrieval: combined collection+document filters bind SQL placeholders correctly."""
    import asyncio
    from types import SimpleNamespace

    from backend.retrieval.vector_store import ChunkWithEmbedding

    store = _prepare_retrieval_db(
        tmp_path, monkeypatch,
        collections=[{"id": "coll-a"}, {"id": "coll-b"}],
        documents=[
            {"id": "doc-a", "collection_id": "coll-a"},
            {"id": "doc-b", "collection_id": "coll-b"},
        ],
        chunks=[
            {"id": "chunk-a", "document_id": "doc-a", "collection_id": "coll-a", "content": "A"},
            {"id": "chunk-b", "document_id": "doc-b", "collection_id": "coll-b", "content": "B"},
        ],
    )
    try:
        same = [1.0] + [0.0] * 383  # identical embeddings: distance is not what we are testing
        asyncio.run(store.add_chunks([
            ChunkWithEmbedding(chunk=SimpleNamespace(id="chunk-a", collection_id="coll-a", document_id="doc-a"), embedding=same),
            ChunkWithEmbedding(chunk=SimpleNamespace(id="chunk-b", collection_id="coll-b", document_id="doc-b"), embedding=same),
        ]))
        unfiltered = asyncio.run(store.search(same, top_k=10))
        filtered = asyncio.run(
            store.search(same, collection_ids=["coll-a"], document_ids=["doc-a"], top_k=10)
        )
    finally:
        store.close()

    # Both vectors are stored, but only one survives the combined filter. If the
    # IN(...) placeholders were mis-bound to the wrong params, this returns wrong
    # or empty results (the original P0 placeholder-ordering defect).
    assert {r.chunk_id for r in unfiltered} == {"chunk-a", "chunk-b"}
    assert [r.chunk_id for r in filtered] == ["chunk-a"]
    assert filtered[0].collection_id == "coll-a"
    assert filtered[0].document_id == "doc-a"


def test_retrieval_mutable_default_argument_fixed(tmp_path):
    """Retrieval: mutable default arguments are avoided in vector_store."""
    import tempfile
    import os
    
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        store = VectorStore(db_path, 384)
        
        # The search method should not use mutable default arguments
        # filter_params defaults to None, not []
        import inspect
        sig = inspect.signature(store.search)
        filter_params_param = sig.parameters.get('filter_params')
        assert filter_params_param is not None
        # Default should be None, not []
        assert filter_params_param.default is None or filter_params_param.default == inspect.Parameter.empty


def test_vector_delete_batches_large_id_lists(tmp_path):
    """Cleanup does not exceed SQLite's bound-parameter limit."""
    import asyncio

    store = VectorStore(str(tmp_path / "vectors.db"), 384)
    asyncio.run(store.delete_chunks([f"chunk-{index}" for index in range(2_000)]))
    store.close()
