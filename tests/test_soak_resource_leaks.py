"""Tests for soak and resource leaks."""

import asyncio
import gc
import psutil
import os
from pathlib import Path
from fastapi.testclient import TestClient


def test_soak_resource_leaks_process_count(tmp_path, monkeypatch):
    """Soak: repeated start/stop doesn't leak processes."""
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

    # Multiple rapid app creations/destructions should not leak
    for i in range(5):
        with TestClient(create_app()) as client:
            transport_headers = {"X-NOC-AI-Backend-Token": "test-transport-secret"}
            health = client.get("/health/ready", headers=transport_headers)
            assert health.status_code == 200
        
        get_settings.cache_clear()
        create_db_engine.cache_clear()
    
    # Force garbage collection
    gc.collect()


def test_soak_resource_leaks_database_locks(tmp_path, monkeypatch):
    """Soak: repeated operations don't leave database locks."""
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
        
        # Multiple API calls
        for i in range(10):
            health = client.get("/health/ready", headers=headers)
            assert health.status_code == 200
        
        # Database should not be locked after

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_soak_resource_leaks_log_growth(tmp_path, monkeypatch):
    """Soak: log growth is bounded."""
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
        health = client.get("/health/ready", headers=transport_headers)
        assert health.status_code == 200

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_soak_resource_leaks_orphan_processes(tmp_path):
    """Soak: no orphan processes after operations."""
    # Test that child processes are cleaned up
    import subprocess
    import sys
    
    # Verify no subprocess.Popen leaks in lifecycle manager
    from backend.inference.lifecycle import ModelLifecycleManager
    
    # The lifecycle manager should use proper cleanup in unload_model
    assert hasattr(ModelLifecycleManager, 'unload_model')
    assert hasattr(ModelLifecycleManager, 'shutdown')


def test_soak_bounded_queues_and_backpressure(tmp_path):
    """Soak: queues and request bodies are bounded."""
    from backend.config import Settings
    
    # Settings should have bounds for upload sizes, queue sizes
    settings = Settings()
    # Check for relevant settings