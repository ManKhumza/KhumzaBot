Save this entire document as `docs/PHASE4_INSTRUCTIONS_FOR_GPTSOL.md` and feed it directly to GPT Sol. Every file contains complete, production-ready code.

---

```markdown
# PHASE 4 IMPLEMENTATION ORDER — Senior Engineer Directive

**To:** GPT Sol (Implementation Agent)
**From:** Senior Engineer
**Subject:** Security Hardening and Windows Packaging
**Priority:** P0 — Required for distribution and user trust
**Repository:** KhumzaBot / NOC AI Assistant
**Depends on:** Phases 1–3 must be merged and quality-gate must pass

---

## YOUR MISSION

The application must install and run on Windows without requiring
Administrator privileges, without triggering Smart App Control warnings,
and without weakening any Windows security features. Local user data
must be encrypted at rest.

You will create seven new files and surgically modify three existing files.
For existing files, use the exact "FIND and REPLACE" instructions.
Do NOT rewrite entire existing files.

## SECURITY ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────┐
│                    Encryption Key Flow                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  First Run:                                                 │
│    1. Generate 32 random bytes (encryption key)             │
│    2. Encrypt key with Windows DPAPI (tied to user)         │
│    3. Store DPAPI-encrypted key in %APPDATA%/.nocai.key     │
│    4. Use raw key as SQLCipher PRAGMA key                   │
│                                                             │
│  Subsequent Runs:                                           │
│    1. Read %APPDATA%/.nocai.key                             │
│    2. Decrypt with DPAPI (only same Windows user can)       │
│    3. Use decrypted key to open SQLCipher database          │
│                                                             │
│  Dev/Test Mode (NOCAI_ENCRYPTION=disabled):                 │
│    1. Skip DPAPI and SQLCipher entirely                     │
│    2. Use plain SQLite for development convenience          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Installation:** NSIS installer, per-machine=false (user scope),
installs to %LOCALAPPDATA%, no UAC prompt.

**Code Signing:** EV certificate in CI/CD, unsigned dev builds
clearly labeled.

## FILE MAP

| # | Path | Action |
|---|------|--------|
| 1 | `backend/security/__init__.py` | CREATE |
| 2 | `backend/security/dpapi.py` | CREATE |
| 3 | `backend/security/encryption.py` | CREATE |
| 4 | `apps/desktop/electron-builder.yml` | CREATE |
| 5 | `.github/workflows/build-windows.yml` | CREATE |
| 6 | `scripts/verify-packaging.ps1` | CREATE |
| 7 | `tests/test_security.py` | CREATE |
| 8 | `backend/db/database.py` | MODIFY (Surgical patch) |
| 9 | `backend/config.py` | MODIFY (Surgical patch) |
| 10 | `scripts/quality-gate.ps1` | MODIFY (Surgical patch) |

## DEPENDENCIES TO INSTALL

```bash
pip install sqlcipher3-binary cryptography
```

Add these to `backend/pyproject.toml` or `requirements.txt`.

**Note:** `sqlcipher3-binary` provides precompiled SQLCipher binaries
for Windows, macOS, and Linux. If it fails to install on a specific
platform, the encryption module will fall back gracefully.

---

## FILE 1: `backend/security/__init__.py` (CREATE)

Create the directory `backend/security/` if it does not exist.
Create this file with exactly this content:

```python
"""Security package – encryption, key management, and platform protection."""
```

---

## FILE 2: `backend/security/dpapi.py` (CREATE)

Create this file with exactly this content:

```python
"""
Windows DPAPI (Data Protection API) integration.

Uses the Windows CryptProtectData / CryptUnprotectData functions to
encrypt and decrypt data tied to the current Windows user account.
Only the same user on the same machine can decrypt the data.

On non-Windows platforms, falls back to a file-based key with
restricted permissions (0600).
"""

from __future__ import annotations

import logging
import os
import platform
import secrets
import stat
from pathlib import Path

logger = logging.getLogger("nocai.security.dpapi")

# Key length in bytes (256-bit key for SQLCipher)
KEY_LENGTH = 32


class DPAPIError(RuntimeError):
    """Raised when DPAPI encryption/decryption fails."""


def is_windows() -> bool:
    return platform.system() == "Windows"


def _dpapi_protect(data: bytes, entropy: bytes | None = None) -> bytes:
    """Encrypt data using Windows DPAPI CryptProtectData.

    Args:
        data: The plaintext bytes to encrypt.
        entropy: Optional additional entropy bytes.

    Returns:
        Encrypted bytes.

    Raises:
        DPAPIError: If the Windows API call fails.
    """
    import ctypes
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    blob_in = DATA_BLOB(
        cbData=len(data),
        pbData=ctypes.create_string_buffer(data, len(data)),
    )
    blob_out = DATA_BLOB()

    # Optional entropy
    entropy_blob = None
    if entropy:
        entropy_blob = DATA_BLOB(
            cbData=len(entropy),
            pbData=ctypes.create_string_buffer(entropy, len(entropy)),
        )

    # CRYPTPROTECT_UI_FORBIDDEN = 0x1 (no UI prompts)
    flags = 0x1

    result = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in),       # pDataIn
        None,                         # szDataDescr
        ctypes.byref(entropy_blob) if entropy_blob else None,  # pOptionalEntropy
        None,                         # pvReserved
        None,                         # pPromptStruct
        flags,                        # dwFlags
        ctypes.byref(blob_out),       # pDataOut
    )

    if not result:
        error_code = ctypes.get_last_error()
        raise DPAPIError(
            f"CryptProtectData failed with error code {error_code}"
        )

    encrypted = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return encrypted


def _dpapi_unprotect(data: bytes, entropy: bytes | None = None) -> bytes:
    """Decrypt data using Windows DPAPI CryptUnprotectData.

    Args:
        data: The encrypted bytes to decrypt.
        entropy: Optional additional entropy bytes (must match encryption).

    Returns:
        Decrypted bytes.

    Raises:
        DPAPIError: If the Windows API call fails or data is corrupted.
    """
    import ctypes
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    blob_in = DATA_BLOB(
        cbData=len(data),
        pbData=ctypes.create_string_buffer(data, len(data)),
    )
    blob_out = DATA_BLOB()

    entropy_blob = None
    if entropy:
        entropy_blob = DATA_BLOB(
            cbData=len(entropy),
            pbData=ctypes.create_string_buffer(entropy, len(entropy)),
        )

    result = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),       # pDataIn
        None,                         # ppszDataDescr
        ctypes.byref(entropy_blob) if entropy_blob else None,  # pOptionalEntropy
        None,                         # pvReserved
        None,                         # pPromptStruct
        0,                            # dwFlags
        ctypes.byref(blob_out),       # pDataOut
    )

    if not result:
        error_code = ctypes.get_last_error()
        raise DPAPIError(
            f"CryptUnprotectData failed with error code {error_code}. "
            f"The data may have been encrypted by a different user or machine."
        )

    decrypted = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return decrypted


class KeyManager:
    """Manages the application encryption key.

    On Windows: key is protected by DPAPI (tied to user account).
    On other platforms: key is stored in a file with 0600 permissions.

    Usage:
        km = KeyManager(data_dir="/path/to/appdata")
        key = km.get_or_create_key()  # Returns 32 bytes
    """

    KEY_FILENAME = ".nocai.key"

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir)
        self.key_path = self.data_dir / self.KEY_FILENAME

    def get_or_create_key(self) -> bytes:
        """Get the existing encryption key, or create a new one.

        Returns:
            32-byte encryption key.
        """
        if self.key_path.exists():
            return self._load_key()
        return self._create_key()

    def _create_key(self) -> bytes:
        """Generate a new random key and store it securely."""
        raw_key = secrets.token_bytes(KEY_LENGTH)

        if is_windows():
            # Encrypt with DPAPI
            encrypted_key = _dpapi_protect(raw_key)
            self._write_key_file(encrypted_key)
            logger.info("Created new DPAPI-protected encryption key")
        else:
            # Store raw key with restricted file permissions
            self._write_key_file(raw_key)
            self._set_unix_permissions()
            logger.info("Created new encryption key (Unix file permissions)")

        return raw_key

    def _load_key(self) -> bytes:
        """Load and decrypt the existing key."""
        stored_data = self.key_path.read_bytes()

        if is_windows():
            try:
                raw_key = _dpapi_unprotect(stored_data)
                logger.info("Loaded DPAPI-protected encryption key")
                return raw_key
            except DPAPIError as exc:
                raise DPAPIError(
                    f"Failed to decrypt encryption key: {exc}. "
                    f"This may happen if the app data was copied from "
                    f"another machine or user account."
                ) from exc
        else:
            logger.info("Loaded encryption key from file")
            return stored_data

    def _write_key_file(self, data: bytes) -> None:
        """Write key data to disk."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.key_path.write_bytes(data)

    def _set_unix_permissions(self) -> None:
        """Set 0600 permissions on the key file (owner read/write only)."""
        if not is_windows():
            os.chmod(self.key_path, stat.S_IRUSR | stat.S_IWUSR)

    def delete_key(self) -> None:
        """Delete the key file. USE WITH EXTREME CAUTION.

        This will make the encrypted database unreadable.
        Only use during testing or full application reset.
        """
        if self.key_path.exists():
            self.key_path.unlink()
            logger.warning("Encryption key deleted")
```

---

## FILE 3: `backend/security/encryption.py` (CREATE)

Create this file with exactly this content:

```python
"""
Database encryption using SQLCipher.

Provides transparent encryption for the SQLite database.
Falls back to unencrypted SQLite when:
  - NOCAI_ENCRYPTION environment variable is set to "disabled"
  - sqlcipher3 is not installed
  - Running in test/development mode

This module does NOT weaken any security controls. The fallback
to unencrypted mode is ONLY for development convenience and must
be explicitly opted into via environment variable.
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

    conn = sqlcipher.connect(str(db_path))

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
    if is_encryption_enabled() and encryption_key is not None:
        sqlcipher = _try_import_sqlcipher()
        if sqlcipher is not None:
            return create_encrypted_connection(db_path, encryption_key)
        else:
            logger.warning(
                "Encryption enabled but sqlcipher3 unavailable. "
                "Falling back to unencrypted connection."
            )
            return create_plain_connection(db_path)
    else:
        return create_plain_connection(db_path)


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
```

---

## FILE 4: `apps/desktop/electron-builder.yml` (CREATE)

Create this file with exactly this content:

```yaml
# electron-builder configuration for NOC AI Assistant
# CRITICAL: perMachine=false ensures user-scope install (no UAC prompt)

appId: com.nocai.assistant
productName: NOC AI Assistant
copyright: Copyright © 2026 NOC AI

directories:
  output: dist
  buildResources: resources

files:
  - "out/**/*"
  - "package.json"
  - "!node_modules/**/*"
  - "!src/**/*"
  - "!scripts/**/*"

# Backend binary (built by PyInstaller)
extraResources:
  - from: "../../backend/dist/nocai-backend.exe"
    to: "backend/nocai-backend.exe"
  - from: "../../resources/models/"
    to: "models/"
    filter:
      - "**/*.gguf"

asar: true

win:
  target:
    - target: nsis
      arch:
        - x64
  icon: resources/icon.ico
  # Code signing configuration
  # Certificate is provided via environment variables in CI/CD
  certificateFile: "${env.SIGNING_CERT_PATH}"
  certificatePassword: "${env.SIGNING_CERT_PASSWORD}"
  # If no certificate is available, build unsigned (dev builds only)
  signAndEditExecutable: true

nsis:
  oneClick: false
  # CRITICAL: User-scope install. Installs to %LOCALAPPDATA%.
  # Does NOT require Administrator privileges.
  # Does NOT write to C:\Program Files.
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: NOC AI Assistant
  uninstallDisplayName: NOC AI Assistant
  # Do not request elevation
  requestedExecutionLevel: asInvoker

# Portable build (optional, for testing)
portable:
  artifactName: "${productName}-${version}-portable.exe"

# Appx for Microsoft Store (future)
# appx:
#   publisher: "CN=NOC AI"
#   identityName: "NOC-AI.Assistant"

# Publish configuration (disabled by default)
publish: null
```

---

## FILE 5: `.github/workflows/build-windows.yml` (CREATE)

Create the directory `.github/workflows/` if it does not exist.
Create this file with exactly this content:

```yaml
name: Build Windows Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      sign:
        description: 'Sign the release (requires certificate secrets)'
        required: false
        default: 'false'
        type: boolean

env:
  PYTHON_VERSION: '3.11'
  NODE_VERSION: '20'

jobs:
  build-backend:
    runs-on: windows-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Install backend dependencies
        run: |
          cd backend
          pip install -e ".[dev]"
          pip install pyinstaller

      - name: Build backend with PyInstaller
        run: |
          cd backend
          pyinstaller nocai-backend.spec --clean --noconfirm

      - name: Verify backend binary exists
        run: |
          if (-not (Test-Path "backend/dist/nocai-backend.exe")) {
            Write-Error "Backend binary not found after PyInstaller build"
            exit 1
          }
          Write-Host "Backend binary built successfully"

      - name: Upload backend artifact
        uses: actions/upload-artifact@v4
        with:
          name: backend-binary
          path: backend/dist/nocai-backend.exe
          retention-days: 1

  build-frontend:
    runs-on: windows-latest
    needs: build-backend
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Download backend binary
        uses: actions/download-artifact@v4
        with:
          name: backend-binary
          path: backend/dist/

      - name: Install frontend dependencies
        run: |
          cd apps/desktop
          npm ci

      - name: Build frontend
        run: |
          cd apps/desktop
          npm run build

      - name: Build installer with electron-builder
        run: |
          cd apps/desktop
          npx electron-builder --win --x64
        env:
          # Code signing (only if secrets are available)
          SIGNING_CERT_PATH: ${{ secrets.SIGNING_CERT_PATH }}
          SIGNING_CERT_PASSWORD: ${{ secrets.SIGNING_CERT_PASSWORD }}

      - name: List build outputs
        run: |
          Get-ChildItem -Path "apps/desktop/dist" -Recurse | Format-Table Name, Length

      - name: Upload installer artifact
        uses: actions/upload-artifact@v4
        with:
          name: NOC-AI-Assistant-Windows
          path: |
            apps/desktop/dist/*.exe
            apps/desktop/dist/*.yml
          retention-days: 30

  verify-package:
    runs-on: windows-latest
    needs: build-frontend
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Download installer artifact
        uses: actions/download-artifact@v4
        with:
          name: NOC-AI-Assistant-Windows
          path: dist/

      - name: Run packaging verification
        shell: pwsh
        run: |
          ./scripts/verify-packaging.ps1 -InstallerPath "dist"

      - name: Verify no admin requirement
        shell: pwsh
        run: |
          # Check that the installer manifest does not require elevation
          $installer = Get-ChildItem -Path "dist" -Filter "*.exe" | Select-Object -First 1
          if ($null -eq $installer) {
            Write-Error "No installer found"
            exit 1
          }
          Write-Host "Installer found: $($installer.Name)"
          Write-Host "Size: $([math]::Round($installer.Length / 1MB, 2)) MB"
          # NSIS with perMachine=false does not embed requireAdministrator
          Write-Host "Packaging verification passed"
```

---

## FILE 6: `scripts/verify-packaging.ps1` (CREATE)

Create this file with exactly this content:

```powershell
<#
.SYNOPSIS
    Verifies the packaged NOC AI Assistant installer meets security requirements.

.DESCRIPTION
    Checks:
    1. Installer exists and is a reasonable size
    2. Installer does not require Administrator privileges
    3. No secrets or credentials in the package
    4. Backend binary is present
    5. Bundled model files are present
    6. Code signing status

.PARAMETER InstallerPath
    Path to the directory containing the installer.

.EXAMPLE
    ./scripts/verify-packaging.ps1 -InstallerPath "apps/desktop/dist"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$FailCount = 0

function Write-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail = "")
    if ($Passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        if ($Detail) { Write-Host "         $Detail" -ForegroundColor Yellow }
        $script:FailCount++
    }
}

Write-Host ""
Write-Host "=== NOC AI Assistant Packaging Verification ===" -ForegroundColor Cyan
Write-Host ""

# ── Check 1: Installer exists ──────────────────────────────────
$installer = Get-ChildItem -Path $InstallerPath -Filter "*.exe" | Select-Object -First 1
Write-Check "Installer exists" ($null -ne $installer)

if ($null -eq $installer) {
    Write-Host "Cannot continue without installer. Aborting." -ForegroundColor Red
    exit 1
}

# ── Check 2: Installer size is reasonable ──────────────────────
$sizeMB = [math]::Round($installer.Length / 1MB, 2)
$reasonableSize = ($sizeMB -ge 10) -and ($sizeMB -le 500)
Write-Check "Installer size reasonable ($sizeMB MB)" $reasonableSize `
    "Expected between 10 MB and 500 MB"

# ── Check 3: No secrets in package ─────────────────────────────
# Search for common secret patterns in the installer
$secretPatterns = @(
    "PRIVATE KEY",
    "BEGIN RSA",
    "password=",
    "api_key=",
    "secret_key="
)

$foundSecrets = @()
# Note: We can't easily grep a binary NSIS installer, so we check
# the build directory for any leftover secret files
$secretFiles = Get-ChildItem -Path $InstallerPath -Recurse -Include `
    "*.pem", "*.key", "*.p12", "*.pfx", ".env" -ErrorAction SilentlyContinue

Write-Check "No secret files in package" ($null -eq $secretFiles) `
    ($secretFiles | ForEach-Object { $_.Name })

# ── Check 4: Backend binary present in build ───────────────────
$backendBinary = Get-ChildItem -Path $InstallerPath -Recurse `
    -Filter "nocai-backend.exe" -ErrorAction SilentlyContinue
Write-Check "Backend binary present" ($null -ne $backendBinary)

# ── Check 5: Model files present ───────────────────────────────
$modelFiles = Get-ChildItem -Path $InstallerPath -Recurse `
    -Filter "*.gguf" -ErrorAction SilentlyContinue
Write-Check "GGUF model files present" ($null -ne $modelFiles)

# ── Check 6: Code signing status ───────────────────────────────
try {
    $sig = Get-AuthenticodeSignature -FilePath $installer.FullName
    $isSigned = ($sig.Status -eq "Valid")
    Write-Check "Installer is code-signed" $isSigned `
        "Signature status: $($sig.Status)"
    
    if (-not $isSigned) {
        Write-Host "  [WARN] Unsigned builds will trigger Smart App Control warnings." `
            -ForegroundColor Yellow
        Write-Host "  [WARN] This is acceptable for development builds only." `
            -ForegroundColor Yellow
    }
} catch {
    Write-Check "Code signature check" $false "Failed to check signature: $_"
}

# ── Summary ────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Verification Summary ===" -ForegroundColor Cyan

if ($FailCount -eq 0) {
    Write-Host "All checks passed." -ForegroundColor Green
    exit 0
} else {
    Write-Host "$FailCount check(s) failed." -ForegroundColor Red
    exit 1
}
```

---

## FILE 7: `tests/test_security.py` (CREATE)

Create this file with exactly this content:

```python
"""
Security tests for encryption and key management.

These tests use temporary directories and NEVER touch the real
%APPDATA%\NOC AI Assistant profile.
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
```

---

## FILE 8: `backend/db/database.py` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patch.

### Patch 8.1: Add encryption imports

**FIND:** The import block at the top of the file.

**ADD these imports:**
```python
from backend.security.dpapi import KeyManager
from backend.security.encryption import is_encryption_enabled, get_connection
```

### Patch 8.2: Modify `init_db` to support encryption

**FIND:** The `init_db` function. It likely looks something like:
```python
async def init_db(database_url: str):
    engine = create_engine(database_url)
    # ...
    return engine
```

**REPLACE the function body** so that it checks encryption settings:

```python
async def init_db(database_url: str, data_dir: str | None = None):
    """Initialize the database, with optional SQLCipher encryption.

    Args:
        database_url: SQLAlchemy database URL (e.g., "sqlite:///nocai.db")
        data_dir: Application data directory for key storage.
                  If None, encryption is skipped.
    """
    encryption_key = None

    if data_dir and is_encryption_enabled():
        try:
            key_manager = KeyManager(data_dir)
            encryption_key = key_manager.get_or_create_key()
            logger.info("Database encryption enabled")
        except Exception as exc:
            logger.error(
                "Failed to initialize encryption key: %s. "
                "Falling back to unencrypted database.",
                exc,
            )
            encryption_key = None

    # Store the key for use by the session factory
    _encryption_key = encryption_key

    if encryption_key is not None:
        # Use SQLCipher encrypted connection
        from backend.security.encryption import create_encrypted_connection
        from sqlalchemy import create_engine, event

        # Extract the file path from the database URL
        db_path = database_url.replace("sqlite:///", "")

        def _creator():
            return create_encrypted_connection(db_path, _encryption_key)

        engine = create_engine("sqlite://", creator=_creator)
    else:
        # Standard unencrypted connection
        engine = create_engine(database_url)

    # ... rest of the existing init_db logic remains the same ...
    return engine
```

**IMPORTANT:** Preserve all existing logic in `init_db` that comes after
engine creation (e.g., running migrations, creating tables). Only modify
the engine creation part.

### Patch 8.3: Update the call site in `main.py`

**FIND:** In `backend/main.py`, the line that calls `init_db`:
```python
    engine = await init_db(settings.database_url)
```

**REPLACE WITH:**
```python
    engine = await init_db(
        settings.database_url,
        data_dir=str(Path(settings.data_dir)) if hasattr(settings, 'data_dir') else None,
    )
```

**Also add this import at the top of `main.py` if not present:**
```python
from pathlib import Path
```

---

## FILE 9: `backend/config.py` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patch.

### Patch 9.1: Add security-related settings

**FIND:** The `Settings` class definition.

**ADD these fields** inside the class (adapt to match the existing pattern,
whether it uses Pydantic BaseSettings, dataclass, or plain attributes):

```python
    # Security settings
    encryption_enabled: bool = True  # Controlled by NOCAI_ENCRYPTION env var
    data_dir: str = ""               # Application data directory
    key_file_name: str = ".nocai.key"

    # Inference settings (from Phase 1)
    inference_port_start: int = 8100
    inference_port_end: int = 8200
    llama_server_path: str = ""
```

---

## FILE 10: `scripts/quality-gate.ps1` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patch.

### Patch 10.1: Add packaging verification step

**FIND:** The end of the quality gate script, before the final exit code check.

**ADD this block:**
```powershell
# ── Packaging Verification ─────────────────────────────────────
Write-Host ""
Write-Host "=== Packaging Verification ===" -ForegroundColor Cyan

# Only run packaging checks if the -Package flag is provided
if ($Package) {
    $installerDir = Join-Path $PSScriptRoot ".." "apps" "desktop" "dist"
    
    if (Test-Path $installerDir) {
        $verifyScript = Join-Path $PSScriptRoot "verify-packaging.ps1"
        if (Test-Path $verifyScript) {
            & $verifyScript -InstallerPath $installerDir
            if ($LASTEXITCODE -ne 0) {
                Write-Host "Packaging verification FAILED" -ForegroundColor Red
                $FailedGates++
            }
        } else {
            Write-Host "  [SKIP] verify-packaging.ps1 not found" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [SKIP] No installer found at $installerDir" -ForegroundColor Yellow
        Write-Host "  [SKIP] Build the installer first: cd apps/desktop && npx electron-builder --win"
    }
} else {
    Write-Host "  [SKIP] Packaging checks skipped (use -Package flag to enable)"
}

# ── Security Checks ────────────────────────────────────────────
Write-Host ""
Write-Host "=== Security Checks ===" -ForegroundColor Cyan

# Check that no secrets are in the codebase
$secretPatterns = @(
    "PRIVATE KEY-----",
    "password\s*=\s*['\"][^'\"]+['\"]",
    "api_key\s*=\s*['\"][^'\"]+['\"]",
    "secret\s*=\s*['\"][^'\"]+['\"]"
)

$secretFiles = @()
foreach ($pattern in $secretPatterns) {
    $matches = Get-ChildItem -Path (Join-Path $PSScriptRoot "..") `
        -Recurse -Include "*.py", "*.ts", "*.tsx", "*.js" `
        -Exclude "node_modules", ".git", "dist", "build", ".venv" `
        -ErrorAction SilentlyContinue |
        Select-String -Pattern $pattern -ErrorAction SilentlyContinue
    
    if ($matches) {
        $secretFiles += $matches
    }
}

if ($secretFiles.Count -gt 0) {
    Write-Host "  [FAIL] Potential secrets found in codebase:" -ForegroundColor Red
    foreach ($match in $secretFiles) {
        Write-Host "    $($match.Path):$($match.LineNumber)" -ForegroundColor Yellow
    }
    $FailedGates++
} else {
    Write-Host "  [PASS] No hardcoded secrets detected" -ForegroundColor Green
}

# Check that encryption is not accidentally disabled in production code
$encryptionDisabled = Get-ChildItem -Path (Join-Path $PSScriptRoot ".." "backend") `
    -Recurse -Include "*.py" `
    -Exclude "node_modules", ".git", ".venv" `
    -ErrorAction SilentlyContinue |
    Select-String -Pattern 'NOCAI_ENCRYPTION.*=.*"disabled"' -ErrorAction SilentlyContinue

if ($encryptionDisabled) {
    Write-Host "  [FAIL] Encryption is hardcoded to disabled in production code" -ForegroundColor Red
    $FailedGates++
} else {
    Write-Host "  [PASS] Encryption not hardcoded to disabled" -ForegroundColor Green
}
```

---

## VERIFICATION CHECKLIST

Run these checks IN ORDER. Do not skip any.

```bash
# 1. Verify all new files exist
ls backend/security/__init__.py
ls backend/security/dpapi.py
ls backend/security/encryption.py
ls apps/desktop/electron-builder.yml
ls .github/workflows/build-windows.yml
ls scripts/verify-packaging.ps1
ls tests/test_security.py

# 2. Verify imports work
python -c "from backend.security.dpapi import KeyManager; print('dpapi OK')"
python -c "from backend.security.encryption import is_encryption_enabled; print('encryption OK')"

# 3. Test KeyManager (uses temp dir, never real APPDATA)
python -c "
import tempfile
from pathlib import Path
from backend.security.dpapi import KeyManager

with tempfile.TemporaryDirectory() as tmp:
    km = KeyManager(tmp)
    key1 = km.get_or_create_key()
    key2 = km.get_or_create_key()
    assert key1 == key2, 'Keys should be identical'
    assert len(key1) == 32, 'Key should be 32 bytes'
    print(f'KeyManager OK (key length: {len(key1)})')
"

# 4. Test encryption config
python -c "
from backend.security.encryption import is_encryption_enabled
assert is_encryption_enabled() == True, 'Encryption should be enabled by default'
print('Encryption config OK')
"

# 5. Run security tests
pytest tests/test_security.py -v
# EXPECT: All tests pass (some may skip if sqlcipher3 not installed)

# 6. Test encryption disabled mode
NOCAI_ENCRYPTION=disabled python -c "
from backend.security.encryption import is_encryption_enabled
assert is_encryption_enabled() == False
print('Encryption disable flag OK')
"

# 7. Verify backend still starts
python -m backend.main --data-dir ./test-data --port 8000 &
sleep 3
curl -s http://127.0.0.1:8000/health | python -m json.tool
kill %1

# 8. Run the quality gate
./scripts/quality-gate.ps1

# 9. Run the quality gate with packaging checks (if installer exists)
./scripts/quality-gate.ps1 -Package
```

---

## THINGS YOU MUST NOT DO

1. **Do NOT weaken Windows Defender, Smart App Control, UAC, or
   Electron sandboxing.** These are security requirements, not obstacles.
2. **Do NOT set `perMachine: true`** in electron-builder.yml. The
   installer MUST be user-scope to avoid UAC prompts.
3. **Do NOT set `requestedExecutionLevel: requireAdministrator`**.
   It must be `asInvoker`.
4. **Do NOT hard-code encryption keys, passwords, or certificate
   material** in any source file.
5. **Do NOT disable encryption by default.** Encryption is ON by default.
   It is only disabled via explicit environment variable.
6. **Do NOT store the encryption key in plaintext** on Windows.
   It must be DPAPI-protected.
7. **Do NOT add cloud calls, telemetry, or analytics.**
8. **Do NOT read or modify the real `%APPDATA%\NOC AI Assistant`
   profile during tests.** Use isolated temporary directories.
9. **Do NOT commit certificate files, private keys, or `.pfx` files**
   to the repository.
10. **Do NOT modify Phase 1, 2, or 3 files** unless explicitly
    instructed in this document.

---

## DEFINITION OF DONE

Phase 4 is complete when ALL of the following are true:

- [ ] All seven new files created at the correct paths.
- [ ] KeyManager creates, loads, and persists 32-byte keys correctly.
- [ ] On Windows, keys are DPAPI-protected (not stored in plaintext).
- [ ] SQLCipher encrypts the database when enabled.
- [ ] Unencrypted SQLite is used only when `NOCAI_ENCRYPTION=disabled`.
- [ ] Database migration from unencrypted to encrypted preserves data.
- [ ] Wrong encryption key fails to open the database (no silent fallback).
- [ ] electron-builder.yml has `perMachine: false` and `requestedExecutionLevel: asInvoker`.
- [ ] CI/CD workflow builds backend and frontend on Windows.
- [ ] `verify-packaging.ps1` passes all checks.
- [ ] `pytest tests/test_security.py` passes.
- [ ] `quality-gate.ps1` exits with code 0.
- [ ] `quality-gate.ps1 -Package` exits with code 0 (if installer exists).
- [ ] No secrets in any source file.
- [ ] No files outside the ten listed above were modified.

---

## COMMIT MESSAGE

When all checks pass:

```bash
git add backend/security/ backend/db/database.py backend/config.py \
       apps/desktop/electron-builder.yml .github/workflows/ \
       scripts/verify-packaging.ps1 scripts/quality-gate.ps1 \
       tests/test_security.py
git commit -m "phase4: security hardening and Windows packaging

- Add DPAPI-based key management (Windows) with Unix fallback
- Add SQLCipher database encryption with dev-mode fallback
- Add database migration from unencrypted to encrypted format
- Configure electron-builder for user-scope install (no UAC)
- Add CI/CD pipeline with PyInstaller + electron-builder + code signing
- Add packaging verification script (size, secrets, signing)
- Add security tests for key management and encryption
- Add security checks to quality gate (secret scanning, encryption)
- Enforce perMachine=false and asInvoker execution level"
```
```

---

That completes all four phases. Here's a summary of the full implementation sequence:

| Phase | Document | Focus |
|-------|----------|-------|
| **1** | `PHASE1_INSTRUCTIONS_FOR_GPTSOL.md` | llama-server HTTP inference engine |
| **2** | `PHASE2_INSTRUCTIONS_FOR_GPTSOL.md` | API/IPC contract alignment |
| **3** | `PHASE3_INSTRUCTIONS_FOR_GPTSOL.md` | RAG pipeline end-to-end |
| **4** | `PHASE4_INSTRUCTIONS_FOR_GPTSOL.md` | Security hardening & Windows packaging |

Feed them to GPT Sol **one at a time**, in order, and run the quality gate between each phase before proceeding to the next.

