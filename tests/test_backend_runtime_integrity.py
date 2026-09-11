"""Production regressions exercised against isolated databases and owned children."""
import asyncio
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base
from backend.db.models import Collection, Document, IngestionJob, Model, User
from backend.documents.coordinator import IngestionCoordinator
from backend.inference.lifecycle import ModelLifecycleManager


@pytest.fixture
def isolated_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("NOCAI_ENCRYPTION", "disabled")
    from backend.config import Settings
    settings = Settings(data_dir=str(tmp_path), models_dir=str(tmp_path / "models"),
                        knowledge_dir=str(tmp_path / "knowledge"), logs_dir=str(tmp_path / "logs"),
                        database_url=f"sqlite:///{tmp_path / 'test.db'}")
    settings.ensure_directories()
    engine = create_engine(settings.database_url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add(User(id="owner", username="owner", password_hash="unused", roles=["administrator"]))
        db.add(Model(id="embedding", name="BGE", filename="bge.gguf", filepath="missing.gguf",
                     size_bytes=1, role="embedding", status="imported"))
        db.add(Collection(id="collection", name="Runbooks", owner_id="owner", embedding_model_id="embedding",
                          embedding_config={}, chunking_config={}))
        db.add(Document(id="document", collection_id="collection", filename="runbook.txt",
                        original_filename="runbook.txt", filepath="runbook.txt", mime_type="text/plain",
                        size_bytes=1, file_hash="fixture", uploaded_by="owner", status="queued"))
        db.commit()
    yield settings, engine, factory
    engine.dispose()


def test_startup_repairs_orphan_queued_document(isolated_backend):
    settings, _, factory = isolated_backend
    async def scenario():
        coordinator = IngestionCoordinator(settings, factory, ModelLifecycleManager(settings))
        try:
            await coordinator.start()
            with factory() as db:
                jobs = db.query(IngestionJob).filter_by(document_id="document").all()
                assert len(jobs) == 1
                assert jobs[0].status == "pending"
        finally:
            await coordinator.stop()
    asyncio.run(scenario())


def test_queued_cancellation_updates_document(isolated_backend):
    _, _, factory = isolated_backend
    from backend.jobs.routes import cancel_job
    with factory() as db:
        db.add(IngestionJob(id="job", document_id="document", collection_id="collection", status="pending"))
        db.commit()
        asyncio.run(cancel_job("job", current_user=db.get(User, "owner"), db=db))
        db.expire_all()
        assert db.get(Document, "document").status == "cancelled"
        assert db.get(IngestionJob, "job").completed_at is not None


def test_migrations_create_real_384_dimension_vector_index(isolated_backend):
    _, engine, _ = isolated_backend
    from backend.db.migrations import run_migrations
    asyncio.run(run_migrations(engine))
    with engine.connect() as conn:
        schema = conn.execute(text("SELECT sql FROM sqlite_master WHERE name='chunks_vec'")).scalar()
        assert schema is not None
        assert "FLOAT[384]" in schema
        assert conn.execute(text("SELECT max(version) FROM schema_version")).scalar() >= 6


def test_runtime_crash_reconciles_active_model(isolated_backend):
    settings, _, factory = isolated_backend
    from backend.inference.lifecycle import ModelProvider, ModelStatus
    class ExitedServer:
        is_running = False
        port = 0
        async def stop(self):
            pass
        async def is_healthy(self):
            return False
        def diagnostics(self):
            return {"running": False, "exit_code": 7}
    async def scenario():
        manager = ModelLifecycleManager(settings)
        await manager.startup(factory)
        with factory() as db:
            db.get(Model, "embedding").status = "active"
            db.commit()
        server = ExitedServer()
        manager._servers["embedding"] = server
        manager.embedding_provider = ModelProvider("embedding", "embedding", process=server, status=ModelStatus.READY)
        manager.active_embedding_model_id = "embedding"
        try:
            await manager.reconcile_runtime_state()
            with factory() as db:
                model = db.get(Model, "embedding")
                assert model.status == "error"
                assert "7" in model.validation_error
            assert manager.get_embedding_provider() is None
            assert manager.active_embedding_model_id is None
        finally:
            await manager.shutdown()
    asyncio.run(scenario())


def test_concurrent_sessions_do_not_share_uncommitted_writes(isolated_backend):
    settings, _, _ = isolated_backend
    from backend.db.database import create_db_engine, get_session_factory
    shared_engine = create_db_engine(settings.database_url)
    factory = get_session_factory(shared_engine)
    try:
        with factory() as writer, factory() as reader:
            writer.execute(text("UPDATE documents SET chunk_count=42 WHERE id='document'"))
            assert reader.execute(text("SELECT chunk_count FROM documents WHERE id='document'")).scalar() == 0
            reader.rollback()
            writer.commit()
        with factory() as reader:
            assert reader.get(Document, "document").chunk_count == 42
    finally:
        shared_engine.dispose()
        create_db_engine.cache_clear()


def test_dimension_migration_retains_source_and_requeues_index(isolated_backend):
    settings, engine, factory = isolated_backend
    from backend.db.models import Chunk
    from backend.db.vector_schema import load_vector_extension, ensure_vector_schema
    from backend.retrieval.vector_store import VectorStore
    with factory() as db:
        db.get(Document, "document").status = "ready"
        db.add(Chunk(id="preserved", document_id="document", collection_id="collection", chunk_index=0,
                     content="deterministic migration fixture"))
        db.commit()
    with engine.begin() as transaction:
        raw = transaction.connection.driver_connection
        load_vector_extension(raw)
        ensure_vector_schema(raw, 768)
    store = VectorStore(settings.database_url, 384)
    try:
        assert store._get_conn().execute("SELECT count(*) FROM chunks_vec").fetchone()[0] == 0
        with factory() as db:
            assert db.get(Chunk, "preserved") is not None
            assert db.get(Document, "document").status == "queued"
            assert db.get(Collection, "collection").reindex_required is True
    finally:
        store.close()
