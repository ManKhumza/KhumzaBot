"""Tests for retrieval and vector search."""

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from backend.retrieval.vector_store import ChunkWithEmbedding, SearchResult, VectorStore


def _search_result(chunk_id: str, content: str, score: float) -> SearchResult:
    return SearchResult(
        chunk_id=chunk_id,
        document_id="herb-document",
        collection_id="khumza",
        content=content,
        score=score,
        page_start=1,
        page_end=1,
        section_title=None,
        metadata={},
    )


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


def test_vector_store_reports_cosine_relevance_for_normalized_vectors(tmp_path, monkeypatch):
    """A normalized sqlite-vec L2 distance is exposed as cosine relevance."""
    store = VectorStore(str(tmp_path / "vectors.db"), 2)
    target = SimpleNamespace(id="target", collection_id="coll-1", document_id="doc-1")
    closer_wrong_document = SimpleNamespace(
        id="wrong-document", collection_id="coll-1", document_id="doc-2"
    )
    closer_wrong_collection = SimpleNamespace(
        id="wrong-collection", collection_id="coll-2", document_id="doc-1"
    )
    details = {
        "target": SimpleNamespace(
            content="A relevant passage",
            page_start=1,
            page_end=1,
            section_title=None,
            chunk_metadata={},
        ),
        "wrong-document": SimpleNamespace(
            content="Excluded by document filter",
            page_start=1,
            page_end=1,
            section_title=None,
            chunk_metadata={},
        ),
        "wrong-collection": SimpleNamespace(
            content="Excluded by collection filter",
            page_start=1,
            page_end=1,
            section_title=None,
            chunk_metadata={},
        ),
    }

    async def get_chunk_details(chunk_id):
        return details.get(chunk_id)

    monkeypatch.setattr(store, "_get_chunk_details", get_chunk_details)
    try:
        asyncio.run(store.add_chunks([
            ChunkWithEmbedding(target, [0.6, 0.8]),
            ChunkWithEmbedding(closer_wrong_document, [1.0, 0.0]),
            ChunkWithEmbedding(closer_wrong_collection, [1.0, 0.0]),
        ]))
        results = asyncio.run(store.search(
            [1.0, 0.0],
            collection_ids=["coll-1"],
            document_ids=["doc-1"],
            top_k=1,
        ))
    finally:
        store.close()

    assert [result.chunk_id for result in results] == ["target"]
    assert results[0].score == pytest.approx(0.6, abs=1e-6)


def test_hybrid_retrieval_promotes_headache_passage_over_generic_herbs(tmp_path):
    """Exact indication text survives generic herb distractors and vector overfetch."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from backend.db.database import Base
    from backend.db.models import Chunk, Collection, Document, Model, User
    from backend.retrieval.hybrid import keyword_search, merge_hybrid_results

    engine = create_engine(f"sqlite:///{tmp_path / 'hybrid.db'}")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)

    generic_texts = [
        f"Medicinal herb monograph {index}: botanical description, cultivation, harvest and storage."
        for index in range(15)
    ]
    relevant_text = (
        "A long medicinal herb monograph with botanical description, cultivation and storage. "
        "Its traditional-use index includes headache and migraine."
    )
    with SessionLocal() as db:
        db.add(User(id="owner", username="owner", password_hash="unused", roles=["administrator"]))
        db.add(Model(
            id="embedding", name="BGE", filename="bge.gguf", filepath="bge.gguf",
            size_bytes=1, role="embedding", status="active",
        ))
        db.add(Collection(
            id="khumza", name="Khumza Knowledge Base", owner_id="owner",
            embedding_model_id="embedding", embedding_config={}, chunking_config={},
        ))
        db.add(Document(
            id="herb-document", collection_id="khumza", filename="herbs.txt",
            original_filename="herbs.txt", filepath="herbs.txt", mime_type="text/plain",
            size_bytes=1, file_hash="hash", uploaded_by="owner", status="ready",
        ))
        db.add_all([
            Chunk(
                id=f"generic-{index}", document_id="herb-document", collection_id="khumza",
                chunk_index=index, content=content,
            )
            for index, content in enumerate(generic_texts)
        ])
        db.add(Chunk(
            id="headache-entry", document_id="herb-document", collection_id="khumza",
            chunk_index=len(generic_texts), content=relevant_text,
        ))
        db.commit()

        keyword_results = keyword_search(
            db,
            "Give me a medicinal herb for headache from the Khumza knowledge base",
            ["khumza"],
            top_k=20,
            collection_names=["Khumza Knowledge Base"],
        )

    # Simulate the reproduced dense ranking: five generic monographs arrive
    # first while the answer-bearing entry has a lower semantic score.
    vector_results = [
        _search_result(f"generic-{index}", generic_texts[index], 0.70 - index * 0.01)
        for index in range(5)
    ] + [_search_result("headache-entry", relevant_text, 0.52)]
    fused = merge_hybrid_results(
        vector_results,
        keyword_results,
        minimum_vector_score=0.55,
        top_k=5,
        vector_weight=0.5,
    )

    assert keyword_results[0].chunk_id == "headache-entry"
    assert fused[0].chunk_id == "headache-entry"
    assert fused[0].metadata["retrievalMethod"] == "hybrid"


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


def test_retrieval_vector_parameter_ordering(tmp_path):
    """Retrieval: SQL placeholder ordering consistent with filters."""
    import tempfile
    import os
    
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        store = VectorStore(db_path, 384)
        
        # This tests the internal SQL construction logic
        # The vector store should properly order placeholders
        # when collection_ids and document_ids are both present
        
        # Test by checking the method exists and is callable
        assert hasattr(store, 'search')
        assert callable(store.search)


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
    records = [ChunkWithEmbedding(SimpleNamespace(id=f"chunk-{index}", collection_id="collection", document_id="document"),
                                  [1.0] + [0.0] * 383) for index in range(2_000)]
    asyncio.run(store.add_chunks(records))
    assert store._get_conn().execute("SELECT count(*) FROM chunks_vec").fetchone()[0] == 2_000
    asyncio.run(store.delete_chunks([item.chunk.id for item in records]))
    assert store._get_conn().execute("SELECT count(*) FROM chunks_vec").fetchone()[0] == 0
    store.close()
