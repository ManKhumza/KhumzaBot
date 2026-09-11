"""Deterministic CI resource checks; the release gate also runs the extended soak."""
import asyncio
import gc
import logging
import math
import os
from pathlib import Path

import psutil
from sqlalchemy import text

from test_backend_runtime_integrity import isolated_backend
from backend.documents.coordinator import IngestionCoordinator
from backend.inference.lifecycle import ModelLifecycleManager
from backend.db.models import Model

ROOT = Path(__file__).resolve().parents[1]


def test_soak_resource_leaks_process_count(isolated_backend):
    settings, engine, factory = isolated_backend
    process = psutil.Process()
    baseline_children = {child.pid for child in process.children(recursive=True)}
    baseline_threads = process.num_threads()
    baseline_handles = process.num_handles() if os.name == "nt" else process.num_fds()
    baseline_memory = process.memory_info().rss
    async def scenario():
        for index in range(8):
            manager = ModelLifecycleManager(settings)
            await manager.startup(factory)
            worker = IngestionCoordinator(settings, factory, manager)
            await worker.start()
            await worker.stop()
            await manager.shutdown()
            assert worker.worker is None
            assert manager._monitor_task is None
            assert not manager.list_servers()
            with engine.begin() as db:
                db.execute(text("UPDATE documents SET error_message=:value"), {"value": f"cycle-{index}"})
            with engine.connect() as db:
                assert db.execute(text("PRAGMA integrity_check")).scalar() == "ok"
    asyncio.run(scenario())
    gc.collect()
    assert {child.pid for child in process.children(recursive=True)} == baseline_children
    assert process.num_threads() <= baseline_threads + 2
    handles = process.num_handles() if os.name == "nt" else process.num_fds()
    assert handles <= baseline_handles + 12
    assert process.memory_info().rss < baseline_memory + 64 * 1024**2


def test_soak_resource_leaks_database_locks(isolated_backend):
    settings, engine, factory = isolated_backend
    from backend.retrieval.vector_store import VectorStore
    import sqlite3
    for _ in range(12):
        store = VectorStore(settings.database_url, 384)
        store._get_conn().execute("SELECT count(*) FROM chunks_vec").fetchone()
        store.close()
        with sqlite3.connect(str(Path(settings.data_dir) / "test.db"), timeout=0.1) as independent:
            independent.execute("BEGIN IMMEDIATE")
            independent.execute("UPDATE documents SET chunk_count=chunk_count+1")
            independent.commit()
    with factory() as db:
        from backend.db.models import Document
        assert db.get(Document, "document").chunk_count == 12
    with engine.connect() as db:
        assert db.execute(text("PRAGMA integrity_check")).scalar() == "ok"


def test_soak_resource_leaks_log_growth(tmp_path, monkeypatch):
    from backend.system.diagnostics import open_diagnostics, close_diagnostics
    import secrets
    secret = secrets.token_urlsafe(32)
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", secret)
    handler = open_diagnostics(tmp_path, max_bytes=1024, backups=3)
    logger = logging.getLogger("nocai.soak")
    old_level = logger.level
    logger.setLevel(logging.INFO)
    try:
        for index in range(500):
            logger.info("Owned component diagnostic %s token=%s", index, secret)
        handler.flush()
    finally:
        logger.setLevel(old_level)
        close_diagnostics(handler)
    files = list(tmp_path.glob("backend.log*"))
    assert len(files) == 4
    assert sum(file.stat().st_size for file in files) <= 4 * 1200
    combined = "".join(file.read_text(encoding="utf-8") for file in files)
    assert secret not in combined
    assert "[REDACTED]" in combined


def test_soak_resource_leaks_orphan_processes(isolated_backend):
    settings, _, factory = isolated_backend
    model_path = ROOT / "resources/models/bge-small-en-v1.5-q8_0.gguf"
    settings.llama_server_path = str(ROOT / "runtimes/llama/llama-server.exe")
    with factory() as db:
        model = db.get(Model, "embedding")
        model.filepath = str(model_path)
        model.context_length = 512
        db.commit()
    children = []
    async def scenario():
        manager = ModelLifecycleManager(settings)
        await manager.startup(factory)
        try:
            for _ in range(3):
                with factory() as db:
                    provider = await manager.load_model(db.get(Model, "embedding"), "embedding")
                child = psutil.Process(provider.process.process.pid)
                children.append(child)
                assert provider.api_key not in " ".join(child.cmdline())
                vectors = await provider.embed_batch(["Network link status", "Maintenance window"])
                assert len(vectors) == 2
                assert all(len(vector) == 384 and all(math.isfinite(value) for value in vector) for vector in vectors)
                await manager.unload_model("embedding")
                assert not child.is_running()
                assert manager._port_pool.in_use_count == 0
        finally:
            await manager.shutdown()
    asyncio.run(scenario())
    assert all(not child.is_running() for child in children)


def test_soak_bounded_queues_and_backpressure(isolated_backend):
    settings, _, factory = isolated_backend
    worker = IngestionCoordinator(settings, factory, ModelLifecycleManager(settings))
    async def scenario():
        for index in range(10_000):
            await worker.enqueue(f"job-{index}")
        for _ in range(100):
            await worker.enqueue("job-0")
        assert worker.queue.qsize() == 256
        assert len(worker._queued_ids) == 256
        assert worker.queue.get_nowait() == "job-0"
        await worker.stop()
    asyncio.run(scenario())
