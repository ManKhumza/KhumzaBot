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
            except DPAPIError as exc:
                raise DPAPIError(
                    f"Failed to decrypt encryption key: {exc}. "
                    f"This may happen if the app data was copied from "
                    f"another machine or user account."
                ) from exc
        else:
            logger.info("Loaded encryption key from file")
            raw_key = stored_data

        if len(raw_key) != KEY_LENGTH:
            raise DPAPIError(
                f"Stored encryption key has invalid length: {len(raw_key)} bytes"
            )
        return raw_key

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
