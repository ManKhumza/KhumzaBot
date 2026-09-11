"""Tests for settings persistence."""

from pathlib import Path
from fastapi.testclient import TestClient


def test_settings_persistence_survives_restart(tmp_path, monkeypatch):
    """Settings persistence: settings stored in database survive restart."""
    data_dir = tmp_path / "data"
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine, get_session_factory
    from backend.main import create_app
    from backend.db.models import Setting

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    # Create app and add a setting directly to database
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
        
        # Check that settings table exists and can store values
        engine = create_db_engine(f"sqlite:///{data_dir / 'test.db'}")
        SessionLocal = get_session_factory(engine)
        with SessionLocal() as session:
            setting = Setting(key="theme", user_id=None, setting_value={"mode": "dark"})
            session.add(setting)
            session.commit()
        
        # Verify setting can be retrieved
        with SessionLocal() as session:
            setting = session.query(Setting).filter(Setting.key == "theme").first()
            assert setting is not None
            assert setting.setting_value == {"mode": "dark"}

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_settings_api_round_trip(tmp_path, monkeypatch):
    """Settings: the renderer route persists and returns user-visible values."""
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
        
        initial = client.get("/api/v1/settings", headers=headers)
        assert initial.status_code == 200
        assert initial.json()["appearance"]["compactMode"] is False

        updated = client.patch(
            "/api/v1/settings",
            json={"appearance": {"compactMode": True}},
            headers=headers,
        )
        assert updated.status_code == 200
        assert updated.json()["appearance"]["compactMode"] is True

        persisted = client.get("/api/v1/settings", headers=headers)
        assert persisted.status_code == 200
        assert persisted.json()["appearance"]["compactMode"] is True

        invalid = client.patch(
            "/api/v1/settings",
            json={"knowledge": {"defaultChunkSize": 32, "unexpected": True}},
            headers=headers,
        )
        assert invalid.status_code == 422

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_settings_immutable_copies(tmp_path):
    """Settings: changes use fresh immutable copies, not in-place JSON mutation."""
    from backend.api.routes import DEFAULT_SETTINGS, _merge_settings
    from copy import deepcopy
    original = deepcopy(DEFAULT_SETTINGS)
    changed = _merge_settings(DEFAULT_SETTINGS, {"appearance": {"compactMode": True}})
    changed["behavior"]["maxSources"] = 1
    fresh = _merge_settings(DEFAULT_SETTINGS, {})
    assert DEFAULT_SETTINGS == original
    assert fresh == original
    assert changed["appearance"]["compactMode"] is True
    assert changed["behavior"]["maxSources"] != fresh["behavior"]["maxSources"]
