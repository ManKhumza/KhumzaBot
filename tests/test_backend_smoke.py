from pathlib import Path

from fastapi.testclient import TestClient


def test_bootstrap_login_and_protected_model_endpoints(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    model_dir = tmp_path / "scan"
    model_dir.mkdir()
    model_file = model_dir / "sample.gguf"
    model_file.write_bytes(b"GGUF")

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
        assert client.get("/health/ready").status_code == 401
        assert client.get("/health/ready", headers=transport_headers).json()["status"] == "ready"
        assert client.get("/api/v1/models").status_code == 401

        login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "ChangeMe-12345!"},
            headers=transport_headers,
        )
        assert login.status_code == 200, login.text
        headers = {
            **transport_headers,
            "Authorization": f"Bearer {login.json()['token']}",
        }

        session = client.get("/api/v1/auth/session", headers=headers)
        assert session.status_code == 200
        assert "administrator" in session.json()["user"]["roles"]

        scan = client.post("/api/v1/models/scan", headers=headers, json={"path": str(model_dir)})
        assert scan.status_code == 200, scan.text
        assert scan.json()["models"][0]["filename"] == model_file.name

        estimate = client.post("/api/v1/models/estimate", headers=headers, json={"path": str(model_file)})
        assert estimate.status_code == 200, estimate.text

        audit = client.get("/api/v1/admin/audit", headers=headers)
        assert audit.status_code == 200, audit.text
        login_entry = next(item for item in audit.json() if item["action"] == "auth.login_success")
        assert login_entry["actorName"] == "admin"
        assert login_entry["metadata"]["username"] == "admin"

        logout = client.post("/api/v1/auth/logout", headers=headers)
        assert logout.status_code == 200, logout.text
        assert client.get("/api/v1/auth/session", headers=headers).status_code == 401

    get_settings.cache_clear()
    create_db_engine.cache_clear()
