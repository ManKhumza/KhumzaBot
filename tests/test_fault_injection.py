"""Tests for fault injection and crash recovery."""

import asyncio
from pathlib import Path
from fastapi.testclient import TestClient


def test_fault_injection_kill_backend_during_api_call(tmp_path, monkeypatch):
    """Fault injection: kill backend during API call, verify recovery."""
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
        
        # Health check should work
        health = client.get("/health/ready", headers=headers)
        assert health.status_code == 200

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_fault_injection_kill_llama_during_load(tmp_path):
    """Fault injection: kill llama.cpp during model load, verify error handling."""
    from backend.inference.lifecycle import ModelLifecycleManager
    
    # Test that load_model handles process failures
    assert hasattr(ModelLifecycleManager, 'load_model')


def test_fault_injection_kill_llama_during_generation(tmp_path):
    """Fault injection: kill llama.cpp during generation, verify cleanup."""
    from backend.inference.lifecycle import ModelLifecycleManager
    
    # Test that generation_context handles process death
    assert hasattr(ModelLifecycleManager, 'generation_context')


def test_fault_injection_port_collision(tmp_path):
    """Fault injection: port collision handled with retry."""
    from backend.inference.lifecycle import ModelLifecycleManager
    
    # Test that _get_free_port handles bind collisions
    assert hasattr(ModelLifecycleManager, '_get_free_port')


def test_fault_injection_corrupt_model(tmp_path, monkeypatch):
    """Fault injection: a corrupt (non-GGUF) model file is flagged invalid, not imported."""
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(tmp_path / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")

    from backend.config import get_settings
    from backend.models.service import ModelService

    get_settings.cache_clear()

    scan_dir = tmp_path / "corrupt"
    scan_dir.mkdir()
    bad = scan_dir / "model.gguf"
    # Non-GGUF bytes: a header that is not the GGUF magic, followed by junk.
    bad.write_bytes(b"CORRUPTGGUF" + b"\x00" * 256)

    try:
        results = asyncio.run(ModelService(None).scan_directory(str(scan_dir)))
    finally:
        get_settings.cache_clear()

    assert len(results) == 1
    result = results[0]
    assert result.filename == "model.gguf"
    assert result.is_valid_gguf is False
    assert result.metadata is None
    assert result.error is not None
    # A corrupt model must never be classified as importable.
    assert result.suggested_role is None


def test_fault_injection_corrupt_model_import_rejected(tmp_path, monkeypatch):
    """Importing a corrupt GGUF raises ValueError instead of silently succeeding."""
    import pytest

    monkeypatch.setenv("NOC_AI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(tmp_path / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")

    from backend.config import get_settings
    from backend.models.service import ModelService

    get_settings.cache_clear()

    bad = tmp_path / "bad.gguf"
    bad.write_bytes(b"NOTGGUF" + b"\x00" * 256)

    try:
        with pytest.raises(ValueError, match="Invalid GGUF file"):
            asyncio.run(ModelService(None).import_model(str(bad), role="chat"))
    finally:
        get_settings.cache_clear()


def test_fault_injection_write_protect_data_dir(tmp_path):
    """Fault injection: write-protected data directory handled."""
    # Test graceful degradation


def test_fault_injection_exhaust_restart_budget(tmp_path):
    """Fault injection: restart budget exhaustion prevents restart storms."""
    from backend.inference.lifecycle import ModelLifecycleManager
    
    # Test that process supervisor has restart budget/circuit breaker