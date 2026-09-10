"""Validated synchronous facade over the application's document parsers."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from backend.documents.parsers import _parse_document_sync


MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".markdown", ".docx", ".csv", ".html", ".htm"}


class DocumentParseError(Exception):
    """Raised when a local document cannot yield searchable text."""


def get_content_type(file_path: str | Path) -> str:
    suffix = Path(file_path).suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".csv": "text/csv",
        ".html": "text/html",
        ".htm": "text/html",
    }.get(suffix, mimetypes.guess_type(str(file_path))[0] or "application/octet-stream")


def parse_document(file_path: str | Path) -> str:
    """Return extracted text or raise an actionable parsing error."""
    path = Path(file_path)
    if not path.is_file():
        raise DocumentParseError(f"File not found: {path}")
    size = path.stat().st_size
    if size == 0:
        raise DocumentParseError("File is empty (0 bytes)")
    if size > MAX_FILE_SIZE_BYTES:
        raise DocumentParseError(
            f"File is too large ({size / 1024 / 1024:.1f} MB). Maximum allowed size is 50 MB."
        )
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise DocumentParseError(
            f"Unsupported file type: '{path.suffix.lower()}'. Supported types: {supported}"
        )

    try:
        result = _parse_document_sync(path, get_content_type(path))
    except Exception as exc:
        if path.suffix.lower() == ".pdf" and "encrypt" in str(exc).casefold():
            message = "PDF is password-protected. Remove the password before uploading."
        else:
            message = f"Failed to parse {path.suffix.lower() or 'document'} file: {exc}"
        raise DocumentParseError(message) from exc

    text = result.full_text.strip()
    if not text:
        if path.suffix.lower() == ".pdf":
            raise DocumentParseError(
                "PDF contains no extractable text. It may be scanned; run OCR before uploading."
            )
        raise DocumentParseError("Document contains no text content")
    return text
