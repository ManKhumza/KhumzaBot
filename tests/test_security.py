"""
Security tests for encryption and key management.

These tests use temporary directories and NEVER touch the real
%APPDATA%\\NOC AI Assistant profile.
"""

import os
import platform
import secrets
import tempfile
from pathlib import Path

import pytest


class TestKeyManager:
    """Tests for the KeyManager class."""

    def test_create_key_returns_32_bytes(self, tmp_path):
        from backend.security.dpapi import KeyManager, KEY_LENGTH

        km = KeyManager(tmp_path)
        key = km.get_or_create_key()

        assert isinstance(key, bytes)
        assert len(key) == KEY_LENGTH

    def test_load_key_returns_same_key(self, tmp_path):
        from backend.security.dpapi import KeyManager

        km = KeyManager(tmp_path)
        key1 = km.get_or_create_key()
        key2 = km.get_or_create_key()

        assert key1 == key2

    def test_key_file_created(self, tmp_path):
        from backend.security.dpapi import KeyManager

        km = KeyManager(tmp_path)
        km.get_or_create_key()

        assert km.key_path.exists()

        if platform.system() == "Windows":
            assert km.key_path.read_bytes() != km.get_or_create_key()

    def test_invalid_key_length_is_rejected(self, tmp_path, monkeypatch):
        from backend.security import dpapi
        from backend.security.dpapi import DPAPIError, KeyManager

        km = KeyManager(tmp_path)
        monkeypatch.setattr(dpapi, "is_windows", lambda: False)
        km.data_dir.mkdir(parents=True, exist_ok=True)
        km.key_path.write_bytes(b"short")

        with pytest.raises(DPAPIError, match="invalid length"):
            km.get_or_create_key()

    def test_delete_key(self, tmp_path):
        from backend.security.dpapi import KeyManager

        km = KeyManager(tmp_path)
        km.get_or_create_key()
        assert km.key_path.exists()

        km.delete_key()
        assert not km.key_path.exists()

    def test_different_dirs_get_different_keys(self, tmp_path):
        from backend.security.dpapi import KeyManager

        dir1 = tmp_path / "dir1"
        dir2 = tmp_path / "dir2"

        km1 = KeyManager(dir1)
        km2 = KeyManager(dir2)

        key1 = km1.get_or_create_key()
        key2 = km2.get_or_create_key()

        assert key1 != key2


class TestEncryptionConfig:
    """Tests for encryption configuration."""

    def test_encryption_enabled_by_default(self):
        from backend.security.encryption import is_encryption_enabled

        # Ensure the env var is not set
        old_value = os.environ.pop("NOCAI_ENCRYPTION", None)
        try:
            assert is_encryption_enabled() is True
        finally:
            if old_value is not None:
                os.environ["NOCAI_ENCRYPTION"] = old_value

    def test_encryption_disabled_via_env(self):
        from backend.security.encryption import is_encryption_enabled

        old_value = os.environ.get("NOCAI_ENCRYPTION")
        try:
            os.environ["NOCAI_ENCRYPTION"] = "disabled"
            assert is_encryption_enabled() is False
        finally:
            if old_value is not None:
                os.environ["NOCAI_ENCRYPTION"] = old_value
            else:
                os.environ.pop("NOCAI_ENCRYPTION", None)

    def test_encryption_enabled_with_other_values(self):
        from backend.security.encryption import is_encryption_enabled

        old_value = os.environ.get("NOCAI_ENCRYPTION")
        try:
            for value in ["enabled", "true", "1", "yes", ""]:
                os.environ["NOCAI_ENCRYPTION"] = value
                assert is_encryption_enabled() is True, (
                    f"Expected encryption enabled for NOCAI_ENCRYPTION='{value}'"
                )
        finally:
            if old_value is not None:
                os.environ["NOCAI_ENCRYPTION"] = old_value
            else:
                os.environ.pop("NOCAI_ENCRYPTION", None)

    def test_enabled_mode_never_silently_falls_back(self, tmp_path, monkeypatch):
        from backend.security import encryption

        monkeypatch.delenv("NOCAI_ENCRYPTION", raising=False)
        monkeypatch.setattr(encryption, "_try_import_sqlcipher", lambda: None)

        with pytest.raises(RuntimeError, match="sqlcipher3 is required"):
            encryption.get_connection(tmp_path / "test.db", secrets.token_bytes(32))

    def test_plain_connection_requires_explicit_disable(self, tmp_path, monkeypatch):
        from backend.security import encryption

        monkeypatch.setenv("NOCAI_ENCRYPTION", "disabled")
        connection = encryption.get_connection(tmp_path / "test.db")
        try:
            assert connection.execute("SELECT 1").fetchone() == (1,)
        finally:
            connection.close()


class TestSQLCipher:
    """Tests for SQLCipher encryption.

    These tests are skipped if sqlcipher3 is not installed.
    """

    @pytest.fixture(autouse=True)
    def check_sqlcipher(self):
        try:
            import sqlcipher3
        except ImportError:
            pytest.skip("sqlcipher3 not installed")

    def test_encrypted_db_not_readable_without_key(self, tmp_path):
        import sqlite3
        from backend.security.encryption import create_encrypted_connection

        db_path = tmp_path / "test.db"
        key = secrets.token_bytes(32)

        # Create encrypted database
        conn = create_encrypted_connection(db_path, key)
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO test (value) VALUES ('secret data')")
        conn.commit()
        conn.close()

        # Try to read without key (should fail)
        plain_conn = sqlite3.connect(str(db_path))
        with pytest.raises(sqlite3.DatabaseError):
            plain_conn.execute("SELECT * FROM test").fetchone()
        plain_conn.close()

    def test_encrypted_db_readable_with_correct_key(self, tmp_path):
        from backend.security.encryption import create_encrypted_connection

        db_path = tmp_path / "test.db"
        key = secrets.token_bytes(32)

        # Create encrypted database
        conn = create_encrypted_connection(db_path, key)
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO test (value) VALUES ('secret data')")
        conn.commit()
        conn.close()

        # Read with correct key
        conn2 = create_encrypted_connection(db_path, key)
        result = conn2.execute("SELECT value FROM test").fetchone()
        conn2.close()

        assert result[0] == "secret data"

    def test_wrong_key_fails(self, tmp_path):
        from backend.security.encryption import create_encrypted_connection

        db_path = tmp_path / "test.db"
        key1 = secrets.token_bytes(32)
        key2 = secrets.token_bytes(32)  # Different key

        # Create with key1
        conn = create_encrypted_connection(db_path, key1)
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()

        # Try to open with key2 (should fail)
        with pytest.raises(RuntimeError, match="Failed to open encrypted database"):
            create_encrypted_connection(db_path, key2)

    def test_verify_encryption(self, tmp_path):
        from backend.security.encryption import (
            create_encrypted_connection,
            verify_encryption,
        )

        db_path = tmp_path / "test.db"
        key = secrets.token_bytes(32)

        conn = create_encrypted_connection(db_path, key)
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()

        assert verify_encryption(db_path, key) is True
        assert verify_encryption(db_path, secrets.token_bytes(32)) is False


class TestMigration:
    """Tests for database migration from unencrypted to encrypted."""

    @pytest.fixture(autouse=True)
    def check_sqlcipher(self):
        try:
            import sqlcipher3
        except ImportError:
            pytest.skip("sqlcipher3 not installed")

    def test_migrate_unencrypted_to_encrypted(self, tmp_path):
        import sqlite3
        from backend.security.encryption import (
            migrate_to_encrypted,
            create_encrypted_connection,
        )

        db_path = tmp_path / "test.db"
        key = secrets.token_bytes(32)

        # Create an unencrypted database
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO users (name) VALUES ('Alice')")
        conn.commit()
        conn.close()

        # Migrate to encrypted
        migrate_to_encrypted(db_path, key)

        # Verify data is preserved
        conn = create_encrypted_connection(db_path, key)
        result = conn.execute("SELECT name FROM users").fetchone()
        conn.close()

        assert result[0] == "Alice"

    def test_migrate_creates_backup(self, tmp_path):
        import sqlite3
        from backend.security.encryption import migrate_to_encrypted

        db_path = tmp_path / "test.db"
        key = secrets.token_bytes(32)

        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()

        migrate_to_encrypted(db_path, key)

        backup_path = db_path.with_suffix(".db.bak")
        assert backup_path.exists()


class TestDatabaseIntegration:
    """Exercise the application database factory with an isolated profile."""

    def test_init_db_encrypts_when_data_dir_is_supplied(self, tmp_path, monkeypatch):
        import asyncio
        import sqlite3

        from backend.db.database import close_db, init_db
        from backend.security.dpapi import KeyManager
        from backend.security.encryption import create_encrypted_connection

        monkeypatch.delenv("NOCAI_ENCRYPTION", raising=False)
        data_dir = tmp_path / "profile"
        db_path = data_dir / "nocai.db"
        data_dir.mkdir()

        engine = asyncio.run(
            init_db(f"sqlite:///{db_path.as_posix()}", data_dir=str(data_dir))
        )
        asyncio.run(close_db(engine))

        plain = sqlite3.connect(db_path)
        try:
            with pytest.raises(sqlite3.DatabaseError):
                plain.execute("SELECT count(*) FROM sqlite_master").fetchone()
        finally:
            plain.close()

        encrypted = create_encrypted_connection(
            db_path, KeyManager(data_dir).get_or_create_key()
        )
        try:
            assert encrypted.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] > 0
        finally:
            encrypted.close()


class TestWindowsPackagingPolicy:
    def test_builder_config_is_user_scope_and_as_invoker(self):
        import yaml

        root = Path(__file__).resolve().parents[1]
        config = yaml.safe_load(
            (root / "apps" / "desktop" / "electron-builder.yml").read_text(
                encoding="utf-8"
            )
        )

        assert config["nsis"]["perMachine"] is False
        assert config["win"]["requestedExecutionLevel"] == "asInvoker"

    def test_windows_workflow_uses_repository_quality_gate(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (
            root / ".github" / "workflows" / "build-windows.yml"
        ).read_text(encoding="utf-8")

        assert "./scripts/quality-gate.ps1 -Package" in workflow
        assert "apps/desktop/electron/release" in workflow
        assert "backend/dist/nocai-backend.exe" not in workflow
