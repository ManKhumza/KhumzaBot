"""Observed readiness; optional inference never blocks administrator login."""
import tempfile
from pathlib import Path
import psutil
from sqlalchemy import text


async def health_snapshot(app) -> dict:
    state = app.state
    components = {}
    try:
        with state.engine.connect() as connection:
            connection.execute(text("SELECT 1")).scalar()
        components["database"] = {"status": "healthy"}
    except Exception:
        components["database"] = {"status": "unhealthy", "detail": "Database access failed; restart and review diagnostics"}
    ingestion = getattr(state, "ingestion", None)
    worker_ready = bool(ingestion and ingestion.worker and not ingestion.worker.done() and not ingestion.stopping)
    components["worker"] = {"status": "healthy" if worker_ready else "unhealthy"}
    try:
        ingestion.vector_store._get_conn().execute("SELECT count(*) FROM chunks_vec").fetchone()
        components["vectorStore"] = {"status": "healthy", "dimension": ingestion.vector_store.embedding_dim}
    except Exception:
        components["vectorStore"] = {"status": "unhealthy", "detail": "Knowledge index unavailable; repair the installation or rebuild the index"}
    try:
        directory = Path(state.settings.data_dir)
        disk = psutil.disk_usage(str(directory))
        with tempfile.TemporaryFile(dir=directory) as probe:
            probe.write(b"readiness")
            probe.flush()
        components["storage"] = {"status": "healthy" if disk.free >= 256 * 1024**2 else "unhealthy",
                                 "freeBytes": disk.free, "totalBytes": disk.total}
        if components["storage"]["status"] != "healthy":
            components["storage"]["detail"] = "Free at least 256 MB on the application data drive"
    except (OSError, psutil.Error):
        components["storage"] = {"status": "unhealthy", "detail": "Application data directory is missing or not writable"}
    memory = psutil.virtual_memory()
    components["memory"] = {"status": "healthy" if memory.available >= 128 * 1024**2 else "degraded",
                            "availableBytes": memory.available, "usedBytes": memory.used}
    manager = getattr(state, "model_manager", None)
    for role, key in (("chat", "modelRuntime"), ("embedding", "embeddingRuntime")):
        provider = getattr(manager, f"{role}_provider", None)
        server = getattr(provider, "process", None)
        healthy = bool(server and server.is_running and await server.is_healthy())
        detail = getattr(manager, "last_errors", {}).get(role)
        components[key] = {"status": "healthy" if healthy else "not_loaded" if provider is None and not detail else "unhealthy"}
        if detail:
            components[key]["detail"] = detail
    ready = all(components[name]["status"] == "healthy" for name in ("database", "worker", "vectorStore", "storage"))
    ready = ready and not getattr(state, "stopping", False)
    full = ready and all(components[name]["status"] == "healthy" for name in ("memory", "embeddingRuntime"))
    return {"status": "ready" if full else "degraded" if ready else "not_ready", "ready": ready,
            "service": "nocai-backend", "components": components}
