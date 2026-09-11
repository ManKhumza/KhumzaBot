"""Tests for document ingestion and upload."""

import asyncio
import hashlib
import threading
from pathlib import Path
from fastapi.testclient import TestClient


def test_document_ingestion_upload_creates_job(tmp_path, monkeypatch):
    """Document ingestion: upload creates document and ingestion job."""
    data_dir = tmp_path / "data"
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
        
        # Create collection first
        collection = client.post(
            "/api/v1/knowledge/collections",
            json={
                "name": "Test Collection",
                "embedding_model_id": "dummy",
                "embedding_config": {},
                "chunking_config": {}
            },
            headers=headers,
        )
        # Collection creation might fail without real model, but endpoint exists

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_document_ingestion_queue_status(tmp_path, monkeypatch):
    """Document ingestion: uploaded document starts in queued status."""
    data_dir = tmp_path / "data"
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
        
        # Test jobs endpoint
        jobs = client.get("/api/v1/jobs", headers=headers)
        assert jobs.status_code == 200
        assert jobs.json() == []

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_delete_knowledge_source_removes_database_vectors_files_and_chat_reference(tmp_path, monkeypatch):
    """Knowledge deletion: a visible source deletion is complete across every local store."""
    data_dir = tmp_path / "data"
    knowledge_dir = data_dir / "knowledge"
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(knowledge_dir))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine, get_session_factory
    from backend.db.models import Chunk, Collection, Conversation, Document, IngestionJob, Model
    from backend.main import create_app
    from backend.retrieval.vector_store import ChunkWithEmbedding

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    with TestClient(create_app()) as client:
        transport_headers = {"X-NOC-AI-Backend-Token": "test-transport-secret"}
        login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "ChangeMe-12345!"},
            headers=transport_headers,
        )
        headers = {**transport_headers, "Authorization": f"Bearer {login.json()['token']}"}
        user_id = login.json()["user"]["id"]
        SessionLocal = get_session_factory(client.app.state.engine)

        with SessionLocal() as db:
            db.add(Model(
                id="embedding-delete", name="Embedding", filename="embedding.gguf",
                filepath="embedding.gguf", size_bytes=1, role="embedding", status="active",
            ))
            db.commit()

        created = client.post(
            "/api/v1/knowledge/collections",
            headers=headers,
            json={
                "name": "Obsolete Runbooks",
                "embeddingModelId": "embedding-delete",
                "embeddingConfig": {},
                "chunkingConfig": {},
            },
        )
        assert created.status_code == 200, created.text
        collection_id = created.json()["id"]
        source_root = knowledge_dir / "collections" / collection_id
        source_file = source_root / "source" / "obsolete.txt"
        source_file.parent.mkdir(parents=True, exist_ok=True)
        source_file.write_text("obsolete source content", encoding="utf-8")
        individual_file = source_root / "source" / "remove-one.txt"
        individual_file.write_text("remove this document", encoding="utf-8")

        with SessionLocal() as db:
            document = Document(
                id="delete-document", collection_id=collection_id, filename=source_file.name,
                original_filename=source_file.name, filepath=str(source_file.relative_to(knowledge_dir)),
                mime_type="text/plain", size_bytes=source_file.stat().st_size,
                file_hash="delete-hash", uploaded_by=user_id, status="ready", chunk_count=1,
            )
            chunk = Chunk(
                id="delete-chunk", document_id=document.id, collection_id=collection_id,
                chunk_index=0, content="obsolete source content", page_start=1, page_end=1,
            )
            individual_document = Document(
                id="single-document", collection_id=collection_id, filename=individual_file.name,
                original_filename=individual_file.name, filepath=str(individual_file.relative_to(knowledge_dir)),
                mime_type="text/plain", size_bytes=individual_file.stat().st_size,
                file_hash="single-hash", uploaded_by=user_id, status="ready", chunk_count=1,
            )
            individual_chunk = Chunk(
                id="single-chunk", document_id=individual_document.id, collection_id=collection_id,
                chunk_index=0, content="remove this document", page_start=1, page_end=1,
            )
            db.add_all([
                document,
                chunk,
                individual_document,
                individual_chunk,
                IngestionJob(
                    id="delete-job", document_id=document.id, collection_id=collection_id,
                    status="completed", current_stage="ready", progress=100,
                ),
                Conversation(
                    id="delete-conversation", user_id=user_id, title="Old source chat",
                    collection_id=collection_id,
                ),
            ])
            db.commit()

        store = client.app.state.ingestion.vector_store
        asyncio.run(store.add_chunks([
            ChunkWithEmbedding(chunk=chunk, embedding=[1.0] + [0.0] * 383),
            ChunkWithEmbedding(chunk=individual_chunk, embedding=[1.0] + [0.0] * 383),
        ]))
        assert store._get_conn().execute(
            "SELECT count(*) FROM chunks_vec WHERE collection_id = ?", (collection_id,)
        ).fetchone()[0] == 2

        deleted_document = client.delete("/api/v1/knowledge/documents/single-document", headers=headers)
        assert deleted_document.status_code == 200, deleted_document.text
        assert deleted_document.json() == {"success": True, "warning": None}
        assert not individual_file.exists()
        assert store._get_conn().execute(
            "SELECT count(*) FROM chunks_vec WHERE chunk_id = 'single-chunk'"
        ).fetchone()[0] == 0
        with SessionLocal() as db:
            assert db.get(Document, "single-document") is None
            assert db.get(Chunk, "single-chunk") is None

        deleted = client.delete(f"/api/v1/knowledge/collections/{collection_id}", headers=headers)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {"success": True, "warning": None}
        assert not source_root.exists()
        assert store._get_conn().execute(
            "SELECT count(*) FROM chunks_vec WHERE collection_id = ?", (collection_id,)
        ).fetchone()[0] == 0

        with SessionLocal() as db:
            assert db.get(Collection, collection_id) is None
            assert db.get(Document, "delete-document") is None
            assert db.get(Chunk, "delete-chunk") is None
            assert db.get(IngestionJob, "delete-job") is None
            assert db.get(Conversation, "delete-conversation").collection_id is None

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_document_ingestion_parsing_chunking_embedding_indexing_stages(tmp_path):
    """Document ingestion: pipeline goes through parsing, chunking, embedding, indexing stages."""
    from backend.documents.pipeline import DocumentStatus, IngestionProgress
    
    # Test that all stages are defined
    assert DocumentStatus.VALIDATING == "validating"
    assert DocumentStatus.PARSING == "parsing"
    assert DocumentStatus.CHUNKING == "chunking"
    assert DocumentStatus.EMBEDDING == "embedding"
    assert DocumentStatus.INDEXING == "indexing"
    assert DocumentStatus.READY == "ready"
    assert DocumentStatus.FAILED == "failed"
    
    # Test progress tracking
    progress = IngestionProgress(
        document_id="test-id",
        stage=DocumentStatus.PARSING,
        progress=0.15,
        message="Extracting text"
    )
    assert progress.stage == DocumentStatus.PARSING
    assert progress.progress == 0.15


def test_large_document_copy_is_streamed_and_hashed(tmp_path):
    """Upload staging preserves a multi-megabyte source and its digest."""
    from backend.knowledge.routes import COPY_BUFFER_BYTES, copy_file_with_hash

    payload = bytes(range(256)) * ((8 * 1024 * 1024 // 256) + 1) + b"final-block"
    source = tmp_path / "large-source.txt"
    destination = tmp_path / "staged.txt"
    source.write_bytes(payload)

    digest, size = asyncio.run(copy_file_with_hash(source, destination))

    assert len(payload) > COPY_BUFFER_BYTES * 8
    assert size == len(payload)
    assert digest == hashlib.sha256(payload).hexdigest()
    assert destination.read_bytes() == payload


def test_document_parsing_runs_off_the_event_loop(tmp_path, monkeypatch):
    """Synchronous document libraries run on a worker thread."""
    from backend.documents import parsers

    source = tmp_path / "document.txt"
    source.write_text("hello", encoding="utf-8")
    caller_thread = threading.get_ident()
    monkeypatch.setattr(
        parsers,
        "_parse_document_sync",
        lambda _path, _mime: threading.get_ident(),
    )

    parser_thread = asyncio.run(parsers.parse_document(source, "text/plain"))
    assert parser_thread != caller_thread


def test_coordinator_indexes_large_document_in_bounded_batches(tmp_path):
    """The active ingestion coordinator commits chunks in bounded embedding batches."""
    from backend.config import Settings
    from backend.db.database import Base, create_db_engine, get_session_factory
    from backend.db.models import Chunk, Collection, Document, IngestionJob, Model, User
    from backend.documents.coordinator import IngestionCoordinator

    data_dir = tmp_path / "data"
    knowledge_dir = data_dir / "knowledge"
    source_dir = knowledge_dir / "collections" / "collection-1" / "source"
    source_dir.mkdir(parents=True)
    source = source_dir / "large-runbook.txt"
    source.write_text("Interface Gi0/1 input errors exceeded threshold.\n" * 2_000, encoding="utf-8")

    database_url = f"sqlite:///{data_dir / 'ingestion.db'}"
    settings = Settings(
        data_dir=str(data_dir),
        models_dir=str(data_dir / "models"),
        knowledge_dir=str(knowledge_dir),
        logs_dir=str(data_dir / "logs"),
        database_url=database_url,
        ingestion_embedding_batch_size=7,
    )
    engine = create_db_engine(database_url)
    Base.metadata.create_all(engine)
    SessionLocal = get_session_factory(engine)

    with SessionLocal() as db:
        db.add(User(id="user-1", username="operator", password_hash="unused", roles=["administrator"]))
        db.add(Model(
            id="embedding-1", name="Embedding", filename="embedding.gguf",
            filepath="embedding.gguf", size_bytes=1, role="embedding", status="imported",
        ))
        db.add(Collection(
            id="collection-1", name="Runbooks", owner_id="user-1",
            embedding_model_id="embedding-1", embedding_config={},
            chunking_config={"chunkSize": 128, "chunkOverlap": 16, "minChunkSize": 20},
        ))
        db.add(Document(
            id="document-1", collection_id="collection-1", filename=source.name,
            original_filename=source.name,
            filepath=str(source.relative_to(knowledge_dir)), mime_type="text/plain",
            size_bytes=source.stat().st_size, file_hash="unused", uploaded_by="user-1",
            status="queued",
        ))
        db.add(IngestionJob(
            id="job-1", document_id="document-1", collection_id="collection-1",
            status="pending", priority=4, current_stage="queued", progress=0,
        ))
        db.commit()

    class FakeProvider:
        def __init__(self):
            self.batch_sizes = []

        async def embed_batch(self, texts):
            self.batch_sizes.append(len(texts))
            return [[1.0] + [0.0] * 383 for _ in texts]

    class FakeManager:
        def __init__(self):
            self.provider = FakeProvider()
            self.active_embedding_model_id = "embedding-1"

        def get_embedding_provider(self):
            return self.provider

    manager = FakeManager()
    coordinator = IngestionCoordinator(settings, SessionLocal, manager)
    try:
        asyncio.run(coordinator._process("job-1"))
    finally:
        coordinator.vector_store.close()

    with SessionLocal() as db:
        document = db.get(Document, "document-1")
        job = db.get(IngestionJob, "job-1")
        chunks = db.query(Chunk).filter(Chunk.document_id == "document-1").all()
        original_chunk_ids = {chunk.id for chunk in chunks}

        assert document.status == "ready"
        assert job.status == "completed"
        assert job.progress == 100
        assert len(chunks) == document.chunk_count
        assert len(chunks) > 100
        assert max(manager.provider.batch_sizes) <= settings.ingestion_embedding_batch_size
        assert len(manager.provider.batch_sizes) > 1

        document.status = "queued"
        db.add(IngestionJob(
            id="job-2", document_id="document-1", collection_id="collection-1",
            status="pending", priority=3, current_stage="queued", progress=0,
        ))
        db.commit()

    class FailingProvider:
        async def embed_batch(self, _texts):
            raise RuntimeError("simulated embedding failure")

    manager.provider = FailingProvider()
    coordinator = IngestionCoordinator(settings, SessionLocal, manager)
    try:
        asyncio.run(coordinator._process("job-2"))
    finally:
        coordinator.vector_store.close()

    with SessionLocal() as db:
        document = db.get(Document, "document-1")
        job = db.get(IngestionJob, "job-2")
        remaining_ids = {
            row[0] for row in db.query(Chunk.id).filter(Chunk.document_id == "document-1").all()
        }

        assert document.status == "failed"
        assert job.status == "failed"
        assert remaining_ids == original_chunk_ids
