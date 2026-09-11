"""Tests for transport secret authentication."""

from pathlib import Path
from fastapi.testclient import TestClient


def test_transport_secret_rejection_missing_token(tmp_path, monkeypatch):
    """Transport secret: missing X-NOC-AI-Backend-Token should be rejected."""
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
        # Missing transport token should return 401
        response = client.get("/health/ready")
        assert response.status_code == 401
        assert "Backend transport authentication failed" in response.text

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_transport_secret_rejection_wrong_token(tmp_path, monkeypatch):
    """Transport secret: wrong X-NOC-AI-Backend-Token should be rejected."""
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
        # Wrong transport token should return 401
        response = client.get("/health/ready", headers={"X-NOC-AI-Backend-Token": "wrong-secret"})
        assert response.status_code == 401

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_transport_secret_correct_token_works(tmp_path, monkeypatch):
    """Transport secret: correct X-NOC-AI-Backend-Token allows access."""
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
        # Correct transport token should work
        response = client.get("/health/ready", headers={"X-NOC-AI-Backend-Token": "test-transport-secret"})
        assert response.status_code == 200
        assert response.json()["ready"] is True
        assert response.json()["components"]["database"]["status"] == "healthy"
        assert response.json()["components"]["vectorStore"]["status"] == "healthy"

    get_settings.cache_clear()
    create_db_engine.cache_clear()
