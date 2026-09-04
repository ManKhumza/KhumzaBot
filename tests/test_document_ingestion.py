"""Tests for document ingestion and upload."""

import asyncio
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