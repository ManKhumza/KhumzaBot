#!/usr/bin/env python3
"""
NOC AI Assistant Backend Entry Point
Packaged as standalone executable via PyInstaller
"""
import argparse
import asyncio
import logging
import os
import hashlib
import hmac
import shutil
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.auth.routes import router as auth_router
from backend.auth.dependencies import set_session_token
from backend.chat.routes import router as chat_router
from backend.models.routes import router as models_router
from backend.knowledge.routes import router as knowledge_router
from backend.admin.routes import router as admin_router
from backend.health.routes import router as health_router
from backend.api.routes import router as api_router
from backend.retrieval.routes import router as retrieval_router
from backend.jobs.routes import router as jobs_router
from backend.config import Settings, get_settings
from backend.db.database import init_db, close_db, get_session_factory
from backend.db.models import Model
from backend.db.migrations import run_migrations
from backend.inference.lifecycle import ModelLifecycleManager
from backend.documents.coordinator import IngestionCoordinator

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("nocai.backend")

# Global state
settings: Settings | None = None

BUNDLED_EMBEDDING_MODEL = {
    "filename": "bge-small-en-v1.5-q8_0.gguf",
    "name": "BGE Small English v1.5 (Bundled)",
    "sha256": "f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804",
    "architecture": "bert",
    "quantization": "Q8_0",
    "parameter_count": "33.2M",
    "context_length": 512,
}


def provision_bundled_embedding_model(app_settings: Settings, engine) -> None:
    """Copy and register the bundled embedding model on first run."""
    bundle_dir = os.getenv("NOC_AI_BUNDLED_MODELS_DIR")
    if not bundle_dir:
        return

    source = Path(bundle_dir) / BUNDLED_EMBEDDING_MODEL["filename"]
    if not source.is_file():
        logger.warning("Bundled embedding model not found: %s", source)
        return

    actual_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if actual_hash != BUNDLED_EMBEDDING_MODEL["sha256"]:
        raise RuntimeError("Bundled embedding model checksum validation failed")

    destination_dir = Path(app_settings.models_dir) / "embedding"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / source.name
    if not destination.exists() or destination.stat().st_size != source.stat().st_size:
        shutil.copy2(source, destination)

    SessionLocal = get_session_factory(engine)
    with SessionLocal() as db:
        model = db.query(Model).filter(
            Model.role == "embedding",
            Model.filename == source.name,
        ).first()
        if model is None:
            model = Model(
                id=str(uuid.uuid4()),
                name=BUNDLED_EMBEDDING_MODEL["name"],
                filename=source.name,
                filepath=str(destination),
                format="GGUF",
                size_bytes=destination.stat().st_size,
                architecture=BUNDLED_EMBEDDING_MODEL["architecture"],
                quantization=BUNDLED_EMBEDDING_MODEL["quantization"],
                parameter_count=BUNDLED_EMBEDDING_MODEL["parameter_count"],
                context_length=BUNDLED_EMBEDDING_MODEL["context_length"],
                role="embedding",
                status="imported",
                model_metadata={"bundled": True, "sha256": actual_hash},
                hardware_compatibility={"cpu": True},
                imported_at=datetime.utcnow(),
            )
            db.add(model)
        else:
            model.filepath = str(destination)
            model.size_bytes = destination.stat().st_size

        active = db.query(Model).filter(
            Model.role == "embedding", Model.status == "active"
        ).first()
        if active is None:
            model.status = "active"
            model.activated_at = datetime.utcnow()
        db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global settings
    
    logger.info("Starting NOC AI Backend...")
    
    # Load settings
    settings = get_settings()
    
    # Ensure directories exist
    settings.ensure_directories()
    
    # Initialize database
    engine = await init_db(settings.database_url)
    
    # Run migrations
    await run_migrations(engine)

    # Ensure Knowledge has a usable, offline embedding model on first run.
    provision_bundled_embedding_model(settings, engine)
    
    # Set session token for auth middleware
    session_token = os.getenv("NOC_AI_SESSION_TOKEN", "")
    if session_token:
        set_session_token(session_token)
    
    # Store in app state
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_token = session_token
    app.state.model_manager = ModelLifecycleManager(settings)
    SessionLocal = get_session_factory(engine)
    await app.state.model_manager.startup(SessionLocal)
    app.state.ingestion = IngestionCoordinator(settings, SessionLocal, app.state.model_manager)
    await app.state.ingestion.start()
    
    logger.info("Backend startup complete")
    
    yield
    
    # Shutdown
    logger.info("Shutting down backend...")
    await app.state.ingestion.stop()
    await app.state.model_manager.shutdown()
    await close_db(engine)
    logger.info("Backend shutdown complete")


def create_app() -> FastAPI:
    app = FastAPI(
        title="NOC AI Assistant API",
        version="1.0.2",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )

    @app.post("/internal/prepare-shutdown")
    async def prepare_shutdown(request: Request):
        """Stop owned workers before Electron terminates Python on Windows."""
        await request.app.state.ingestion.stop()
        await request.app.state.model_manager.shutdown()
        return {"success": True}
    
    # CORS - only allow Electron origin
    # Electron main is the sole API proxy; renderer JavaScript does not need
    # direct network access to the loopback service.
    app.add_middleware(CORSMiddleware, allow_origins=[], allow_methods=[], allow_headers=[])
    
    # Session token middleware (applies to all routes except health)
    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        expected_transport_token = request.app.state.session_token
        supplied_transport_token = request.headers.get("X-NOC-AI-Backend-Token", "")
        if not expected_transport_token or not hmac.compare_digest(
            supplied_transport_token, expected_transport_token
        ):
            return JSONResponse({"detail": "Backend transport authentication failed"}, status_code=401)

        if request.url.path in [
            "/health", "/health/ready", "/health/live",
            "/api/v1/auth/login", "/api/v1/auth/status", "/internal/prepare-shutdown",
        ]:
            return await call_next(request)
        
        auth_header = request.headers.get("Authorization")
        if not auth_header:
            return JSONResponse({"detail": "Missing Authorization header"}, status_code=401)
        
        scheme, _, token = auth_header.partition(" ")
        if scheme.lower() != "bearer":
            return JSONResponse({"detail": "Invalid auth scheme"}, status_code=401)
        
        # Route dependencies validate the hashed user session, its expiry and
        # permissions. The middleware only enforces the Bearer scheme globally.
        return await call_next(request)
    
    # Routes
    app.include_router(auth_router, prefix="/api/v1/auth", tags=["auth"])
    app.include_router(chat_router, prefix="/api/v1/chat", tags=["chat"])
    app.include_router(models_router, prefix="/api/v1/models", tags=["models"])
    app.include_router(knowledge_router, prefix="/api/v1/knowledge", tags=["knowledge"])
    app.include_router(admin_router, prefix="/api/v1/admin", tags=["admin"])
    app.include_router(health_router, prefix="/health", tags=["health"])
    app.include_router(api_router, prefix="/api/v1", tags=["api"])
    app.include_router(retrieval_router, prefix="/api/v1/retrieval", tags=["retrieval"])
    app.include_router(jobs_router, prefix="/api/v1/jobs", tags=["jobs"])
    
    return app


def main():
    parser = argparse.ArgumentParser(description="NOC AI Assistant Backend")
    parser.add_argument("--port", type=int, default=0, help="Port to bind (0 = random)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind")
    parser.add_argument("--data-dir", type=str, required=True, help="Data directory")
    parser.add_argument("--log-level", type=str, default="info", help="Log level")
    args = parser.parse_args()
    
    # Set environment for child processes
    if not os.getenv("NOC_AI_SESSION_TOKEN"):
        parser.error("NOC_AI_SESSION_TOKEN must be provided through the inherited environment")
    os.environ["NOC_AI_DATA_DIR"] = args.data_dir
    os.environ["NOC_AI_MODELS_DIR"] = str(Path(args.data_dir) / "models")
    os.environ["NOC_AI_KNOWLEDGE_DIR"] = str(Path(args.data_dir) / "knowledge")
    os.environ["NOC_AI_LOG_LEVEL"] = args.log_level.upper()
    get_settings.cache_clear()
    
    # Configure logging level
    logging.getLogger().setLevel(args.log_level.upper())
    
    app = create_app()
    
    # Run with uvicorn
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level.lower(),
        access_log=False,
        server_header=False,
        date_header=False,
    )


if __name__ == "__main__":
    main()
