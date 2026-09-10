"""
Database encryption using SQLCipher.

Provides transparent encryption for the SQLite database. Unencrypted SQLite
is available only when NOCAI_ENCRYPTION is explicitly set to "disabled".

This module does not silently downgrade when SQLCipher is unavailable.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("nocai.security.encryption")

# Environment variable to disable encryption (dev/test only)
ENCRYPTION_ENV_VAR = "NOCAI_ENCRYPTION"

# SQLCipher configuration
CIPHER_PAGE_SIZE = 4096
KDF_ITERATIONS = 256000


def is_encryption_enabled() -> bool:
    """Check whether database encryption is enabled.

    Encryption is enabled by default. It is only disabled when
    the NOCAI_ENCRYPTION environment variable is explicitly set
    to "disabled".
    """
    value = os.getenv(ENCRYPTION_ENV_VAR, "").lower().strip()
    if value == "disabled":
        logger.warning(
            "Database encryption is DISABLED via %s=disabled. "
            "Do NOT use this in production.",
            ENCRYPTION_ENV_VAR,
        )
        return False
    return True


def _try_import_sqlcipher():
    """Attempt to import sqlcipher3. Returns the module or None."""
    try:
        import sqlcipher3
        return sqlcipher3
    except ImportError:
        logger.warning(
            "sqlcipher3 is not installed. "
            "Database encryption is unavailable. "
            "Install with: pip install sqlcipher3-binary"
        )
        return None


def create_encrypted_connection(
    db_path: str | Path,
    encryption_key: bytes,
) -> Any:
    """Create an encrypted SQLite connection using SQLCipher.

    Args:
        db_path: Path to the SQLite database file.
        encryption_key: 32-byte encryption key.

    Returns:
        A sqlcipher3 connection object.

    Raises:
        RuntimeError: If sqlcipher3 is not available.
    """
    sqlcipher = _try_import_sqlcipher()
    if sqlcipher is None:
        raise RuntimeError(
            "sqlcipher3 is required for database encryption. "
            "Install with: pip install sqlcipher3-binary"
        )

    # FastAPI executes synchronous SQLAlchemy work on worker threads. Match the
    # existing SQLite engine's thread policy while StaticPool serializes access.
    conn = sqlcipher.connect(str(db_path), check_same_thread=False)

    # Set the encryption key
    # Convert bytes to hex string for PRAGMA key
    key_hex = encryption_key.hex()
    conn.execute(f"PRAGMA key = \"x'{key_hex}'\"")

    # Configure SQLCipher
    conn.execute(f"PRAGMA cipher_page_size = {CIPHER_PAGE_SIZE}")
    conn.execute(f"PRAGMA kdf_iter = {KDF_ITERATIONS}")

    # Verify the key works by trying to read from sqlite_master
    try:
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except Exception as exc:
        conn.close()
        raise RuntimeError(
            f"Failed to open encrypted database. "
            f"The encryption key may be incorrect or the database "
            f"may be corrupted. Error: {exc}"
        ) from exc

    logger.info("Opened encrypted database: %s", db_path)
    return conn


def create_plain_connection(db_path: str | Path) -> Any:
    """Create an unencrypted SQLite connection (dev/test fallback).

    Args:
        db_path: Path to the SQLite database file.

    Returns:
        A sqlite3 connection object.
    """
    import sqlite3
    conn = sqlite3.connect(str(db_path))
    logger.info("Opened unencrypted database (dev mode): %s", db_path)
    return conn


def get_connection(db_path: str | Path, encryption_key: bytes | None = None) -> Any:
    """Get a database connection, encrypted or plain based on configuration.

    Args:
        db_path: Path to the SQLite database file.
        encryption_key: 32-byte key. Required if encryption is enabled.

    Returns:
        A database connection object.
    """
    if not is_encryption_enabled():
        return create_plain_connection(db_path)

    if encryption_key is None:
        raise RuntimeError("An encryption key is required when encryption is enabled")
    return create_encrypted_connection(db_path, encryption_key)


def migrate_to_encrypted(
    db_path: str | Path,
    encryption_key: bytes,
    backup_path: str | Path | None = None,
) -> None:
    """Migrate an existing unencrypted database to SQLCipher encryption.

    This uses SQLCipher's sqlcipher_export() to create an encrypted
    copy of the database, then replaces the original.

    Args:
        db_path: Path to the existing unencrypted database.
        encryption_key: 32-byte key for the new encrypted database.
        backup_path: Optional path to back up the original database.

    Raises:
        RuntimeError: If migration fails.
    """
    import sqlite3

    db_path = Path(db_path)
    if not db_path.exists():
        logger.info("No existing database to migrate")
        return

    # Check if already encrypted by trying to open without key
    try:
        conn = sqlite3.connect(str(db_path))
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        conn.close()
        # If we get here, the database is unencrypted
    except sqlite3.DatabaseError:
        logger.info("Database appears to already be encrypted, skipping migration")
        return

    sqlcipher = _try_import_sqlcipher()
    if sqlcipher is None:
        raise RuntimeError(
            "sqlcipher3 required for migration. "
            "Install with: pip install sqlcipher3-binary"
        )

    if backup_path is None:
        backup_path = db_path.with_suffix(".db.bak")
    else:
        backup_path = Path(backup_path)

    encrypted_path = db_path.with_suffix(".db.encrypted")

    logger.info("Migrating database to encrypted format...")

    try:
        # Step 1: Back up the original
        import shutil
        shutil.copy2(db_path, backup_path)
        logger.info("Backed up original database to %s", backup_path)

        # Step 2: Open the unencrypted database
        plain_conn = sqlcipher.connect(str(db_path))

        # Step 3: Attach a new encrypted database
        key_hex = encryption_key.hex()
        plain_conn.execute(
            f"ATTACH DATABASE '{encrypted_path}' AS encrypted "
            f"KEY \"x'{key_hex}'\""
        )
        plain_conn.execute(f"PRAGMA encrypted.cipher_page_size = {CIPHER_PAGE_SIZE}")
        plain_conn.execute(f"PRAGMA encrypted.kdf_iter = {KDF_ITERATIONS}")

        # Step 4: Export data to the encrypted database
        plain_conn.execute("SELECT sqlcipher_export('encrypted')")

        # Step 5: Detach and close
        plain_conn.execute("DETACH DATABASE encrypted")
        plain_conn.close()

        # Step 6: Replace original with encrypted version
        db_path.unlink()
        encrypted_path.rename(db_path)

        logger.info("Database migration to encrypted format complete")

    except Exception as exc:
        # Clean up on failure
        if encrypted_path.exists():
            encrypted_path.unlink()
        raise RuntimeError(
            f"Database migration failed: {exc}. "
            f"Original database backed up at: {backup_path}"
        ) from exc


def verify_encryption(db_path: str | Path, encryption_key: bytes) -> bool:
    """Verify that a database is properly encrypted and the key works.

    Args:
        db_path: Path to the database file.
        encryption_key: The encryption key to test.

    Returns:
        True if the database is encrypted and the key is correct.
    """
    try:
        conn = create_encrypted_connection(db_path, encryption_key)
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        conn.close()
        return True
    except Exception:
        return False
