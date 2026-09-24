"""Regression tests for the database reset (lockout recovery) mechanism."""

import os
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RESET_SCRIPT = REPO_ROOT / "scripts" / "reset-db.ps1"


def _run_reset(data_dir: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(RESET_SCRIPT),
            "-DataDir",
            str(data_dir),
            *args,
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )


def test_reset_db_scopes_process_block_to_target_profile(tmp_path):
    """Database reset: only an app instance bound to the target profile blocks a reset."""
    target = tmp_path / "target-profile"
    target.mkdir(parents=True)
    database = target / "nocai.db"
    database.write_bytes(b"profile database placeholder")

    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    impostor = tmp_path / "NOC AI Assistant.exe"
    shutil.copy(system_root / "System32" / "cmd.exe", impostor)

    def spawn_bound_to(profile: Path) -> subprocess.Popen:
        # A process whose name matches the packaged app and whose command line
        # carries the profile it is bound to.
        return subprocess.Popen(
            [
                str(impostor),
                "/c",
                f"ping -n 60 127.0.0.1 > nul & rem --data-dir {profile}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def stop(proc: subprocess.Popen) -> None:
        subprocess.run(
            ["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # An instance bound to a different profile must not block this reset.
    other = spawn_bound_to(tmp_path / "other-profile")
    try:
        reset = _run_reset(target, "-Yes")
        assert reset.returncode == 0, f"stdout={reset.stdout}\nstderr={reset.stderr}"
        assert not database.exists()
        assert list((target / "backups").glob("db-reset-*")), "reset must back up before deleting"
    finally:
        stop(other)

    # An instance bound to this profile must still block without -Force.
    database.write_bytes(b"profile database placeholder")
    same = spawn_bound_to(target)
    try:
        blocked = _run_reset(target, "-Yes")
        assert blocked.returncode == 1, f"stdout={blocked.stdout}\nstderr={blocked.stderr}"
        assert "still running" in blocked.stderr
        assert database.exists(), "a blocked reset must not touch the database"
    finally:
        stop(same)


def _configure_profile(monkeypatch, data_dir: Path) -> None:
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'nocai.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "reset-test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_database_reset_backs_up_and_restores_fresh_bootstrap(tmp_path, monkeypatch):
    """Database reset: backup nocai.db, delete it, and regain access via first-run bootstrap login with a new password."""
    data_dir = tmp_path / "data"
    models_dir = data_dir / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    sentinel = models_dir / "must-survive-reset.txt"
    sentinel.write_text("model data must not be deleted by a database reset", encoding="utf-8")

    _configure_profile(monkeypatch, data_dir)

    from fastapi.testclient import TestClient

    from backend.main import create_app

    transport = {"X-NOC-AI-Backend-Token": "reset-test-transport-secret"}
    old_password = "Original-Admin-Password-123!"
    new_password = "Fresh-Admin-Password-123!"

    # Reproduce the lockout: an existing profile has an administrator, the
    # user cannot authenticate, and first-run setup will not run again.
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/auth/status", headers=transport).json() == {"needsSetup": True}
        first_login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": old_password},
            headers=transport,
        )
        assert first_login.status_code == 200, first_login.text
        assert client.get("/api/v1/auth/status", headers=transport).json() == {"needsSetup": False}
        failed_login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "Wrong-Password-12345!"},
            headers=transport,
        )
        assert failed_login.status_code == 401, failed_login.text

    _configure_profile(monkeypatch, data_dir)

    # Run the reset script against the isolated temporary profile only.
    reset = _run_reset(data_dir, "-Yes")
    assert reset.returncode == 0, f"stdout={reset.stdout}\nstderr={reset.stderr}"

    assert not (data_dir / "nocai.db").exists()
    assert not (data_dir / "nocai.db-wal").exists()
    assert not (data_dir / "nocai.db-shm").exists()
    assert sentinel.exists(), "reset must only touch database files, not models"

    backups = sorted((data_dir / "backups").glob("db-reset-*"))
    assert backups, "reset must leave a timestamped backup of the database"
    backup_dir = backups[-1]
    assert (backup_dir / "nocai.db").stat().st_size > 0
    assert (backup_dir / "manifest.json").exists(), "backup must include an integrity manifest"

    # Fresh database: the first-run bootstrap flow creates brand-new credentials.
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/auth/status", headers=transport).json() == {"needsSetup": True}
        fresh_login = client.post(
            "/api/v1/auth/login",
            json={"username": "new-admin", "password": new_password},
            headers=transport,
        )
        assert fresh_login.status_code == 200, fresh_login.text
        assert client.get("/api/v1/auth/status", headers=transport).json() == {"needsSetup": False}

    _configure_profile(monkeypatch, data_dir)

    # Recoverable: restoring the backup brings back the original administrator.
    restore = _run_reset(data_dir, "-RestoreFrom", str(backup_dir), "-Yes")
    assert restore.returncode == 0, f"stdout={restore.stdout}\nstderr={restore.stderr}"

    _configure_profile(monkeypatch, data_dir)
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/auth/status", headers=transport).json() == {"needsSetup": False}
        restored_login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": old_password},
            headers=transport,
        )
        assert restored_login.status_code == 200, restored_login.text
