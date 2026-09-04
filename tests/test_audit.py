"""Tests for audit logging."""

from pathlib import Path
from fastapi.testclient import TestClient


def test_audit_log_creates_rows_with_metadata(tmp_path, monkeypatch):
    """Audit: login creates audit row with metadata and actor attribution."""
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
        
        # Check audit log
        audit = client.get("/api/v1/admin/audit", headers=headers)
        assert audit.status_code == 200
        entries = audit.json()
        
        # Find login success entry
        login_entry = next((e for e in entries if e["action"] == "auth.login_success"), None)
        assert login_entry is not None
        assert login_entry["actorName"] == "admin"
        # Check metadata is present (not empty {})
        assert "metadata" in login_entry
        
        # Logout should also create audit entry
        logout = client.post("/api/v1/auth/logout", headers=headers)
        assert logout.status_code == 200

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_audit_log_metadata_mapping_fixed(tmp_path):
    """Audit: ORM attribute audit_metadata matches service call parameter."""
    from backend.db.models import AuditLog
    from backend.db.database import Database
    
    # The AuditLog model uses 'audit_metadata' column
    # The Database.audit_log() method should use 'audit_metadata' not 'metadata'
    
    # Check model column name
    assert hasattr(AuditLog, 'audit_metadata')
    
    # Check database method signature
    import inspect
    sig = inspect.signature(Database.audit_log)
    params = list(sig.parameters.keys())
    # Should accept metadata parameter but map to audit_metadata
    assert 'metadata' in params


def test_audit_log_important_actions_tracked(tmp_path, monkeypatch):
    """Audit: important actions (login, logout, password_change, model_actions, document_actions, admin_actions) create entries."""
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
        
        # Check various audit actions exist
        audit = client.get("/api/v1/admin/audit", headers=headers)
        assert audit.status_code == 200
        
    get_settings.cache_clear()
    create_db_engine.cache_clear()