Save this entire document as `docs/PHASE3_INSTRUCTIONS_FOR_GPTSOL.md` and feed it directly to GPT Sol. Every file contains complete, production-ready code.

---

```markdown
# PHASE 3 IMPLEMENTATION ORDER — Senior Engineer Directive

**To:** GPT Sol (Implementation Agent)
**From:** Senior Engineer
**Subject:** Complete the RAG Pipeline End-to-End
**Priority:** P0 — Core product feature is non-functional
**Repository:** KhumzaBot / NOC AI Assistant
**Depends on:** Phase 1 (llama-server inference) must be merged and working

---

## YOUR MISSION

Document upload currently copies files and marks them "queued" but never
executes ingestion. Search endpoints return empty arrays. Job management
returns empty lists. This phase builds the complete pipeline:

```
upload → parse → chunk → embed → store vectors → semantic search → cite
```

You will create four new files and surgically modify four existing files.
For existing files, use the exact "FIND and REPLACE" instructions.
Do NOT rewrite entire existing files.

## ARCHITECTURE OVERVIEW

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Upload API  │────▶│ IngestionCoordinator│────▶│ DocumentParser   │
│  (routes.py) │     │  (async task queue)│     │ (PDF/TXT/DOCX/MD)│
└──────────────┘     └──────────────────┘     └──────────────────┘
                              │                         │
                              ▼                         ▼
                     ┌──────────────────┐     ┌──────────────────┐
                     │  Chunker         │────▶│ EmbeddingClient  │
                     │  (512 char/64 ov)│     │ (llama-server)   │
                     └──────────────────┘     └──────────────────┘
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │  VectorStore     │
                                              │  (sqlite-vec)    │
                                              └──────────────────┘
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │  Search API      │
                                              │  (retrieval)     │
                                              └──────────────────┘
```

**Job State Machine:**
```
QUEUED → PARSING → CHUNKING → EMBEDDING → READY
   │         │          │           │
   └─────────┴──────────┴───────────┴──→ FAILED
```

**Vector Storage:** sqlite-vec extension, 384-dimensional float32 vectors,
stored in the same SQLite database as the rest of the application.

**Embedding Model:** bge-small-en-v1.5-q8_0.gguf (already bundled,
SHA-256: f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804)

## FILE MAP

| # | Path | Action |
|---|------|--------|
| 1 | `backend/db/vector_store.py` | CREATE |
| 2 | `backend/knowledge/parser.py` | CREATE |
| 3 | `backend/knowledge/ingestion.py` | CREATE |
| 4 | `backend/knowledge/embeddings.py` | CREATE |
| 5 | `backend/knowledge/routes.py` | MODIFY (Surgical patches) |
| 6 | `backend/retrieval/routes.py` | MODIFY (Surgical patches) |
| 7 | `backend/jobs/routes.py` | MODIFY (Surgical patches) |
| 8 | `backend/main.py` | MODIFY (Surgical patches) |

## DEPENDENCIES TO INSTALL

```bash
pip install sqlite-vec pypdf python-docx
```

Add these to `backend/pyproject.toml` or `requirements.txt`.

---

## FILE 1: `backend/db/vector_store.py` (CREATE)

Create this file with exactly this content:

```python
"""
Vector storage using sqlite-vec.

Stores document chunk embeddings in the same SQLite database as the
rest of the application. Uses the sqlite-vec extension for efficient
KNN similarity search.

Embedding dimension: 384 (BGE Small English v1.5)
"""

from __future__ import annotations

import logging
import sqlite3
import struct
from pathlib import Path
from typing import Any

logger = logging.getLogger("nocai.knowledge.vector_store")

EMBEDDING_DIM = 384


def serialize_f32(vector: list[float]) -> bytes:
    """Serialize a float32 vector to bytes for sqlite-vec.

    sqlite-vec expects little-endian float32 arrays.
    """
    if len(vector) != EMBEDDING_DIM:
        raise ValueError(
            f"Expected {EMBEDDING_DIM}-dimensional vector, got {len(vector)}"
        )
    return struct.pack(f"<{len(vector)}f", *vector)


def deserialize_f32(data: bytes) -> list[float]:
    """Deserialize bytes back to a float32 vector."""
    count = len(data) // 4
    return list(struct.unpack(f"<{count}f", data))


class VectorStore:
    """Manages vector embeddings and chunk metadata in SQLite.

    Usage:
        store = VectorStore("/path/to/database.db")
        store.insert_chunk("doc-123", 0, "Hello world", [0.1, 0.2, ...], "file.pdf")
        results = store.search([0.1, 0.2, ...], top_k=5)
    """

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self.conn = sqlite3.connect(self.db_path)
        self._load_extension()
        self._ensure_tables()
        logger.info("VectorStore initialized at %s", self.db_path)

    def _load_extension(self) -> None:
        """Load the sqlite-vec extension."""
        try:
            self.conn.enable_load_extension(True)
            self.conn.load_extension("vec0")
            self.conn.enable_load_extension(False)
            logger.info("sqlite-vec extension loaded")
        except sqlite3.OperationalError as exc:
            self.conn.enable_load_extension(False)
            raise RuntimeError(
                f"Failed to load sqlite-vec extension. "
                f"Ensure sqlite-vec is installed: pip install sqlite-vec. "
                f"Error: {exc}"
            ) from exc

    def _ensure_tables(self) -> None:
        """Create vector and metadata tables if they don't exist."""
        self.conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING vec0(
                embedding float[384]
            )
        """)

        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS chunk_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                source_file TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_chunk_metadata_document_id
            ON chunk_metadata(document_id)
        """)

        self.conn.commit()

    def insert_chunk(
        self,
        document_id: str,
        chunk_index: int,
        content: str,
        embedding: list[float],
        source_file: str,
    ) -> int:
        """Insert a single chunk embedding and its metadata.

        Returns the row ID of the inserted chunk.
        """
        serialized = serialize_f32(embedding)

        cursor = self.conn.execute(
            "INSERT INTO document_chunks(embedding) VALUES (?)",
            (serialized,),
        )
        row_id = cursor.lastrowid

        self.conn.execute(
            """INSERT INTO chunk_metadata
               (id, document_id, chunk_index, content, source_file)
               VALUES (?, ?, ?, ?, ?)""",
            (row_id, document_id, chunk_index, content, source_file),
        )
        self.conn.commit()
        return row_id

    def insert_chunks_batch(
        self,
        document_id: str,
        chunks: list[dict[str, Any]],
        source_file: str,
    ) -> int:
        """Insert multiple chunks in a single transaction.

        Args:
            document_id: The document these chunks belong to.
            chunks: List of {"index": int, "content": str, "embedding": list[float]}
            source_file: Original filename.

        Returns the number of chunks inserted.
        """
        if not chunks:
            return 0

        try:
            for chunk in chunks:
                serialized = serialize_f32(chunk["embedding"])
                cursor = self.conn.execute(
                    "INSERT INTO document_chunks(embedding) VALUES (?)",
                    (serialized,),
                )
                row_id = cursor.lastrowid
                self.conn.execute(
                    """INSERT INTO chunk_metadata
                       (id, document_id, chunk_index, content, source_file)
                       VALUES (?, ?, ?, ?, ?)""",
                    (row_id, document_id, chunk["index"],
                     chunk["content"], source_file),
                )
            self.conn.commit()
            return len(chunks)
        except Exception:
            self.conn.rollback()
            raise

    def search(
        self,
        query_embedding: list[float],
        top_k: int = 5,
        document_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Perform KNN similarity search.

        Args:
            query_embedding: The query vector (384 dimensions).
            top_k: Maximum number of results to return.
            document_ids: Optional filter to search only specific documents.

        Returns:
            List of dicts with keys: content, source_file, document_id,
            chunk_index, distance.
        """
        serialized_query = serialize_f32(query_embedding)

        query = """
            SELECT
                c.id,
                c.content,
                c.source_file,
                c.document_id,
                c.chunk_index,
                v.distance
            FROM document_chunks v
            JOIN chunk_metadata c ON c.id = v.id
            WHERE v.embedding MATCH ?
        """
        params: list[Any] = [serialized_query]

        if document_ids:
            placeholders = ",".join("?" for _ in document_ids)
            query += f" AND c.document_id IN ({placeholders})"
            params.extend(document_ids)

        query += " ORDER BY v.distance LIMIT ?"
        params.append(top_k)

        try:
            results = self.conn.execute(query, params).fetchall()
        except sqlite3.OperationalError as exc:
            logger.error("Vector search failed: %s", exc)
            return []

        return [
            {
                "content": row[1],
                "source_file": row[2],
                "document_id": row[3],
                "chunk_index": row[4],
                "distance": row[5],
            }
            for row in results
        ]

    def delete_document_chunks(self, document_id: str) -> int:
        """Delete all chunks and metadata for a document.

        Returns the number of chunks deleted.
        """
        # Get row IDs for this document
        cursor = self.conn.execute(
            "SELECT id FROM chunk_metadata WHERE document_id = ?",
            (document_id,),
        )
        row_ids = [row[0] for row in cursor.fetchall()]

        if not row_ids:
            return 0

        # Delete from vector table
        placeholders = ",".join("?" for _ in row_ids)
        self.conn.execute(
            f"DELETE FROM document_chunks WHERE id IN ({placeholders})",
            row_ids,
        )

        # Delete from metadata table
        self.conn.execute(
            "DELETE FROM chunk_metadata WHERE document_id = ?",
            (document_id,),
        )

        self.conn.commit()
        logger.info(
            "Deleted %d chunks for document %s", len(row_ids), document_id
        )
        return len(row_ids)

    def get_document_chunk_count(self, document_id: str) -> int:
        """Return the number of chunks stored for a document."""
        cursor = self.conn.execute(
            "SELECT COUNT(*) FROM chunk_metadata WHERE document_id = ?",
            (document_id,),
        )
        return cursor.fetchone()[0]

    def close(self) -> None:
        """Close the database connection."""
        if self.conn:
            self.conn.close()
            logger.info("VectorStore connection closed")
```

---

## FILE 2: `backend/knowledge/parser.py` (CREATE)

Create this file with exactly this content:

```python
"""
Document parsing utilities.

Extracts raw text from uploaded files. Supports PDF, TXT, MD, and DOCX.
Unsupported, corrupt, encrypted, or empty files raise DocumentParseError
with a descriptive message so the UI can show actionable feedback.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("nocai.knowledge.parser")

# Maximum file size: 50 MB
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".docx", ".markdown"}


class DocumentParseError(Exception):
    """Raised when a document cannot be parsed."""


def parse_document(file_path: str | Path) -> str:
    """Extract raw text from a document file.

    Args:
        file_path: Path to the uploaded file.

    Returns:
        Extracted text content.

    Raises:
        DocumentParseError: If the file is unsupported, corrupt,
            encrypted, empty, or too large.
    """
    path = Path(file_path)

    if not path.is_file():
        raise DocumentParseError(f"File not found: {path}")

    # Check file size
    file_size = path.stat().st_size
    if file_size == 0:
        raise DocumentParseError("File is empty (0 bytes)")
    if file_size > MAX_FILE_SIZE_BYTES:
        raise DocumentParseError(
            f"File is too large ({file_size / 1024 / 1024:.1f} MB). "
            f"Maximum allowed size is 50 MB."
        )

    suffix = path.suffix.lower()

    if suffix == ".pdf":
        return _parse_pdf(path)
    elif suffix in (".txt", ".md", ".markdown"):
        return _parse_text(path)
    elif suffix == ".docx":
        return _parse_docx(path)
    else:
        raise DocumentParseError(
            f"Unsupported file type: '{suffix}'. "
            f"Supported types: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
        )


def _parse_pdf(path: Path) -> str:
    """Extract text from a PDF file using pypdf."""
    try:
        from pypdf import PdfReader
    except ImportError:
        raise DocumentParseError(
            "PDF parsing requires the 'pypdf' package. "
            "Install it with: pip install pypdf"
        )

    try:
        reader = PdfReader(str(path))
    except Exception as exc:
        raise DocumentParseError(
            f"Failed to open PDF (file may be corrupt or encrypted): {exc}"
        ) from exc

    # Check for encryption
    if reader.is_encrypted:
        try:
            # Try empty password (some PDFs are "encrypted" but with no password)
            reader.decrypt("")
        except Exception:
            raise DocumentParseError(
                "PDF is password-protected. "
                "Remove the password before uploading."
            )

    pages_text: list[str] = []
    total_pages = len(reader.pages)

    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text()
            if text:
                pages_text.append(text)
        except Exception as exc:
            logger.warning(
                "Failed to extract text from page %d of %s: %s",
                i + 1, path.name, exc,
            )

    result = "\n\n".join(pages_text).strip()

    if not result:
        raise DocumentParseError(
            f"PDF contains no extractable text ({total_pages} pages). "
            f"The file may be a scanned image. "
            f"Use OCR or upload a text-based PDF."
        )

    logger.info(
        "Parsed PDF '%s': %d pages, %d characters",
        path.name, total_pages, len(result),
    )
    return result


def _parse_text(path: Path) -> str:
    """Read a plain text or markdown file."""
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            text = path.read_text(encoding="latin-1")
        except Exception as exc:
            raise DocumentParseError(
                f"Unable to decode text file: {exc}"
            ) from exc
    except Exception as exc:
        raise DocumentParseError(
            f"Failed to read text file: {exc}"
        ) from exc

    result = text.strip()
    if not result:
        raise DocumentParseError("Text file is empty after reading")

    logger.info("Parsed text file '%s': %d characters", path.name, len(result))
    return result


def _parse_docx(path: Path) -> str:
    """Extract text from a DOCX file using python-docx."""
    try:
        import docx
    except ImportError:
        raise DocumentParseError(
            "DOCX parsing requires the 'python-docx' package. "
            "Install it with: pip install python-docx"
        )

    try:
        doc = docx.Document(str(path))
    except Exception as exc:
        raise DocumentParseError(
            f"Failed to open DOCX file (may be corrupt): {exc}"
        ) from exc

    paragraphs = [para.text for para in doc.paragraphs if para.text.strip()]

    # Also extract text from tables
    for table in doc.tables:
        for row in table.rows:
            row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
            if row_text:
                paragraphs.append(row_text)

    result = "\n\n".join(paragraphs).strip()

    if not result:
        raise DocumentParseError("DOCX file contains no text content")

    logger.info(
        "Parsed DOCX '%s': %d paragraphs, %d characters",
        path.name, len(paragraphs), len(result),
    )
    return result


def get_content_type(file_path: str | Path) -> str:
    """Return a MIME-like content type string for the file."""
    suffix = Path(file_path).suffix.lower()
    mapping = {
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    return mapping.get(suffix, "application/octet-stream")
```

---

## FILE 3: `backend/knowledge/embeddings.py` (CREATE)

Create this file with exactly this content:

```python
"""
Embedding client for the local BGE model.

Communicates with the llama-server instance running the embedding model
(set up in Phase 1) to generate 384-dimensional vectors.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("nocai.knowledge.embeddings")

# Maximum number of texts to embed in a single request
MAX_BATCH_SIZE = 32

# Timeout for embedding requests (seconds)
EMBED_TIMEOUT = 120.0


class EmbeddingError(RuntimeError):
    """Raised when embedding generation fails."""


class EmbeddingClient:
    """Client for generating embeddings via the local llama-server.

    This client talks directly to the embedding model's llama-server
    instance, bypassing the FastAPI proxy for lower latency during
    bulk ingestion.
    """

    def __init__(self, model_manager: Any) -> None:
        """
        Args:
            model_manager: The ModelLifecycleManager instance from
                app.state.model_manager (Phase 1).
        """
        self._model_manager = model_manager

    def _get_embedding_server(self) -> Any:
        """Get the running embedding model server."""
        server = self._model_manager.get_server_by_role(
            "embedding", self._get_session_factory()
        )
        if server is None or not server.is_running:
            raise EmbeddingError(
                "No embedding model is loaded. "
                "Ensure the BGE embedding model is active."
            )
        return server

    def _get_session_factory(self) -> Any:
        """Get the DB session factory from the model manager's settings."""
        # The model manager doesn't directly hold the session factory,
        # so we import it here. This is a pragmatic choice to avoid
        # circular imports.
        from backend.db.database import get_session_factory
        from backend.config import get_settings
        settings = get_settings()
        return get_session_factory(settings.database_url)

    async def embed_single(self, text: str) -> list[float]:
        """Embed a single text string.

        Args:
            text: The text to embed.

        Returns:
            A 384-dimensional float vector.

        Raises:
            EmbeddingError: If the embedding model is unavailable
                or returns an error.
        """
        results = await self.embed_batch([text])
        return results[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of text strings.

        Args:
            texts: List of texts to embed.

        Returns:
            List of 384-dimensional float vectors, one per input text.

        Raises:
            EmbeddingError: If the embedding model is unavailable
                or returns an error.
        """
        if not texts:
            return []

        server = self._get_embedding_server()
        url = f"http://{server.host}:{server.port}/v1/embeddings"

        all_embeddings: list[list[float]] = []

        # Process in batches to avoid overwhelming the server
        for i in range(0, len(texts), MAX_BATCH_SIZE):
            batch = texts[i : i + MAX_BATCH_SIZE]

            payload = {
                "input": batch,
                "model": "bge-small-en-v1.5",
            }

            try:
                async with httpx.AsyncClient(timeout=EMBED_TIMEOUT) as client:
                    resp = await client.post(url, json=payload)

                    if resp.status_code != 200:
                        raise EmbeddingError(
                            f"Embedding server returned HTTP {resp.status_code}: "
                            f"{resp.text[:200]}"
                        )

                    data = resp.json()

                    # OpenAI-compatible response format
                    if "data" in data:
                        for item in data["data"]:
                            all_embeddings.append(item["embedding"])
                    elif "embedding" in data:
                        # Single embedding response
                        all_embeddings.append(data["embedding"])
                    else:
                        raise EmbeddingError(
                            f"Unexpected embedding response format: "
                            f"{list(data.keys())}"
                        )

            except httpx.HTTPError as exc:
                raise EmbeddingError(
                    f"Failed to connect to embedding server: {exc}"
                ) from exc

        if len(all_embeddings) != len(texts):
            raise EmbeddingError(
                f"Expected {len(texts)} embeddings, got {len(all_embeddings)}"
            )

        return all_embeddings
```

---

## FILE 4: `backend/knowledge/ingestion.py` (CREATE)

Create this file with exactly this content:

```python
"""
Document ingestion pipeline.

Orchestrates the full flow: parse → chunk → embed → store.
Managed by IngestionCoordinator which runs jobs as background asyncio tasks.

Job State Machine:
    QUEUED → PARSING → CHUNKING → EMBEDDING → READY
       │         │          │           │
       └─────────┴──────────┴───────────┴──→ FAILED
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from enum import Enum
from pathlib import Path
from typing import Any

from backend.knowledge.parser import parse_document, DocumentParseError
from backend.knowledge.embeddings import EmbeddingClient, EmbeddingError
from backend.db.vector_store import VectorStore

logger = logging.getLogger("nocai.knowledge.ingestion")

# Chunking parameters
CHUNK_SIZE = 512       # characters per chunk
CHUNK_OVERLAP = 64     # characters of overlap between chunks


class JobStatus(str, Enum):
    QUEUED = "queued"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    READY = "ready"
    FAILED = "failed"
    CANCELLED = "cancelled"


def chunk_text(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Split text into overlapping chunks by character count.

    Args:
        text: The full document text.
        chunk_size: Maximum characters per chunk.
        overlap: Number of overlapping characters between chunks.

    Returns:
        List of text chunks.
    """
    if not text:
        return []

    chunks: list[str] = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = start + chunk_size

        # Try to break at a sentence or paragraph boundary
        if end < text_len:
            # Look for paragraph break in the last 100 chars
            search_region = text[max(start, end - 100) : end]
            para_break = search_region.rfind("\n\n")
            if para_break > 0:
                end = max(start, end - 100) + para_break + 2
            else:
                # Look for sentence break
                sentence_break = search_region.rfind(". ")
                if sentence_break > 0:
                    end = max(start, end - 100) + sentence_break + 2

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        # Move start forward, accounting for overlap
        start = end - overlap
        if start <= (end - chunk_size):
            # Safety: prevent infinite loop
            start = end

    return chunks


class DocumentIngestionPipeline:
    """Processes a single document through the ingestion pipeline."""

    def __init__(
        self,
        settings: Any,
        vector_store: VectorStore,
        embedding_client: EmbeddingClient,
        session_factory: Any,
    ) -> None:
        self.settings = settings
        self.vector_store = vector_store
        self.embedding_client = embedding_client
        self.session_factory = session_factory

    async def process_document(
        self,
        job_id: str,
        document_id: str,
        file_path: str,
        source_filename: str,
    ) -> None:
        """Run the full ingestion pipeline for one document.

        Updates the job status in the database at each step.
        On failure, sets job status to FAILED with a descriptive error.
        """
        try:
            # Step 1: Parse
            await self._update_job(job_id, JobStatus.PARSING, 0.05)
            logger.info("Parsing document %s", document_id)

            try:
                raw_text = await asyncio.get_event_loop().run_in_executor(
                    None, parse_document, file_path
                )
            except DocumentParseError as exc:
                raise RuntimeError(str(exc)) from exc

            if not raw_text or not raw_text.strip():
                raise RuntimeError(
                    "Document parsed successfully but contains no text"
                )

            # Step 2: Chunk
            await self._update_job(job_id, JobStatus.CHUNKING, 0.20)
            logger.info(
                "Chunking document %s (%d characters)",
                document_id, len(raw_text),
            )

            chunks = await asyncio.get_event_loop().run_in_executor(
                None, chunk_text, raw_text
            )

            if not chunks:
                raise RuntimeError("Chunking produced zero chunks")

            logger.info("Document %s split into %d chunks", document_id, len(chunks))

            # Step 3: Embed
            await self._update_job(job_id, JobStatus.EMBEDDING, 0.35)
            logger.info("Embedding %d chunks for document %s", len(chunks), document_id)

            try:
                embeddings = await self.embedding_client.embed_batch(chunks)
            except EmbeddingError as exc:
                raise RuntimeError(f"Embedding failed: {exc}") from exc

            # Step 4: Store vectors
            await self._update_job(job_id, JobStatus.EMBEDDING, 0.70)
            logger.info("Storing vectors for document %s", document_id)

            # Delete any existing chunks for this document (re-processing)
            self.vector_store.delete_document_chunks(document_id)

            # Prepare batch data
            chunk_data = [
                {
                    "index": i,
                    "content": chunk,
                    "embedding": emb,
                }
                for i, (chunk, emb) in enumerate(zip(chunks, embeddings))
            ]

            await asyncio.get_event_loop().run_in_executor(
                None,
                self.vector_store.insert_chunks_batch,
                document_id,
                chunk_data,
                source_filename,
            )

            # Step 5: Done
            await self._update_job(job_id, JobStatus.READY, 1.0)
            logger.info(
                "Document %s ingestion complete: %d chunks stored",
                document_id, len(chunks),
            )

        except asyncio.CancelledError:
            await self._update_job(job_id, JobStatus.CANCELLED, 0.0)
            logger.info("Document %s ingestion cancelled", document_id)
            raise

        except Exception as exc:
            error_msg = str(exc)[:500]
            logger.error(
                "Ingestion failed for document %s: %s",
                document_id, error_msg,
            )
            await self._update_job(
                job_id, JobStatus.FAILED, 0.0, error_message=error_msg
            )

    async def _update_job(
        self,
        job_id: str,
        status: JobStatus,
        progress: float,
        error_message: str | None = None,
    ) -> None:
        """Update the job record in the database."""
        from backend.db.models import IngestionJob

        SessionLocal = self.session_factory
        with SessionLocal() as db:
            job = db.query(IngestionJob).filter(IngestionJob.id == job_id).first()
            if job:
                job.status = status.value
                job.progress = min(progress, 1.0)
                job.error_message = error_message
                db.commit()


class IngestionCoordinator:
    """Manages background ingestion tasks.

    Instantiated by main.py during lifespan startup:
        app.state.ingestion = IngestionCoordinator(settings, SessionLocal, model_manager)
        await app.state.ingestion.start()

    Shutdown:
        await app.state.ingestion.stop()
    """

    def __init__(
        self,
        settings: Any,
        session_factory: Any,
        model_manager: Any,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.model_manager = model_manager

        # Initialize components
        db_path = getattr(settings, "database_url", "nocai.db")
        # Strip sqlite:/// prefix if present
        if db_path.startswith("sqlite:///"):
            db_path = db_path[len("sqlite:///"):]

        self.vector_store = VectorStore(db_path)
        self.embedding_client = EmbeddingClient(model_manager)
        self.pipeline = DocumentIngestionPipeline(
            settings, self.vector_store, self.embedding_client, session_factory
        )

        self._tasks: dict[str, asyncio.Task] = {}  # job_id -> task
        self._running = False

    async def start(self) -> None:
        """Called during app startup. Recovers interrupted jobs."""
        self._running = True
        await self._recover_interrupted_jobs()
        logger.info("IngestionCoordinator started")

    async def stop(self) -> None:
        """Called during app shutdown. Cancels all running tasks."""
        self._running = False

        # Cancel all running ingestion tasks
        for job_id, task in self._tasks.items():
            if not task.done():
                task.cancel()

        # Wait for all tasks to finish cancellation
        if self._tasks:
            await asyncio.gather(
                *self._tasks.values(), return_exceptions=True
            )

        self._tasks.clear()
        self.vector_store.close()
        logger.info("IngestionCoordinator stopped")

    async def enqueue(
        self,
        job_id: str,
        document_id: str,
        file_path: str,
        source_filename: str,
    ) -> None:
        """Add a document to the ingestion queue."""
        if not self._running:
            raise RuntimeError("IngestionCoordinator is not running")

        if job_id in self._tasks and not self._tasks[job_id].done():
            logger.warning("Job %s is already running", job_id)
            return

        task = asyncio.create_task(
            self.pipeline.process_document(
                job_id, document_id, file_path, source_filename
            ),
            name=f"ingest-{document_id}",
        )
        self._tasks[job_id] = task
        logger.info("Enqueued ingestion job %s for document %s", job_id, document_id)

    async def cancel_job(self, job_id: str) -> bool:
        """Cancel a running ingestion job.

        Returns True if the job was found and cancelled.
        """
        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            return True
        return False

    def get_task(self, job_id: str) -> asyncio.Task | None:
        return self._tasks.get(job_id)

    async def _recover_interrupted_jobs(self) -> None:
        """Mark any jobs that were mid-processing when the app crashed."""
        from backend.db.models import IngestionJob

        interrupted_statuses = [
            JobStatus.PARSING.value,
            JobStatus.CHUNKING.value,
            JobStatus.EMBEDDING.value,
        ]

        SessionLocal = self.session_factory
        with SessionLocal() as db:
            interrupted = (
                db.query(IngestionJob)
                .filter(IngestionJob.status.in_(interrupted_statuses))
                .all()
            )

            for job in interrupted:
                job.status = JobStatus.FAILED.value
                job.error_message = (
                    "Ingestion was interrupted by application restart. "
                    "Please retry the document."
                )
                db.commit()
                logger.warning(
                    "Marked interrupted job %s as failed", job.id
                )

            if interrupted:
                logger.info(
                    "Recovered %d interrupted job(s)", len(interrupted)
                )
```

---

## FILE 5: `backend/knowledge/routes.py` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patches.

### Patch 5.1: Add imports at the top

**FIND:** The import block at the top of the file.

**ADD these imports** (if not already present):
```python
import uuid
from fastapi import HTTPException, UploadFile, File, Request
from backend.knowledge.parser import get_content_type, SUPPORTED_EXTENSIONS
from backend.knowledge.ingestion import JobStatus
```

### Patch 5.2: Fix the upload endpoint

**FIND:** The existing `POST /documents` upload endpoint. It likely saves the file and sets status to "queued" but does NOT create a job or enqueue it.

**REPLACE the function body** so that after saving the file, it creates an IngestionJob and enqueues it:

```python
@router.post("/documents")
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a document and start ingestion."""
    from backend.db.models import Document, IngestionJob
    from pathlib import Path
    import shutil

    # Validate file extension
    filename = file.filename or "unnamed"
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: '{suffix}'. "
                   f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
        )

    # Generate IDs
    doc_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())

    # Save file to disk
    upload_dir = Path(request.app.state.settings.knowledge_dir) / doc_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_path = upload_dir / filename

    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Create document record
    doc = Document(
        id=doc_id,
        filename=filename,
        filepath=str(file_path),
        content_type=get_content_type(filename),
        status="uploaded",
    )
    db.add(doc)

    # Create ingestion job record
    job = IngestionJob(
        id=job_id,
        document_id=doc_id,
        status=JobStatus.QUEUED.value,
        progress=0.0,
        error_message=None,
    )
    db.add(job)
    db.commit()

    # Enqueue the ingestion task
    ingestion = request.app.state.ingestion
    await ingestion.enqueue(
        job_id=job_id,
        document_id=doc_id,
        file_path=str(file_path),
        source_filename=filename,
    )

    return {
        "document_id": doc_id,
        "job_id": job_id,
        "status": "queued",
    }
```

### Patch 5.3: Add the reprocess endpoint

**FIND:** The end of the file or the section with document routes.

**ADD this endpoint** (if not already added in Phase 2):
```python
@router.post("/documents/{document_id}/reprocess")
async def reprocess_document(
    document_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Reset a document's ingestion job and re-enqueue it."""
    from backend.db.models import Document, IngestionJob

    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    job = (
        db.query(IngestionJob)
        .filter(IngestionJob.document_id == document_id)
        .order_by(IngestionJob.created_at.desc())
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="No ingestion job found")

    # Reset job state
    job.status = JobStatus.QUEUED.value
    job.progress = 0.0
    job.error_message = None
    db.commit()

    # Re-enqueue
    ingestion = request.app.state.ingestion
    await ingestion.enqueue(
        job_id=job.id,
        document_id=document_id,
        file_path=doc.filepath,
        source_filename=doc.filename,
    )

    return {"status": "re-queued", "document_id": document_id, "job_id": job.id}
```

### Patch 5.4: Add document status endpoint

**ADD this endpoint:**
```python
@router.get("/documents/{document_id}/status")
async def document_status(
    document_id: str,
    db: Session = Depends(get_db),
):
    """Return the ingestion status for a document."""
    from backend.db.models import Document, IngestionJob

    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    job = (
        db.query(IngestionJob)
        .filter(IngestionJob.document_id == document_id)
        .order_by(IngestionJob.created_at.desc())
        .first()
    )

    return {
        "document_id": document_id,
        "filename": doc.filename,
        "status": job.status if job else "no_job",
        "progress": job.progress if job else 0.0,
        "error_message": job.error_message if job else None,
    }
```

### Patch 5.5: Add document delete endpoint

**ADD this endpoint:**
```python
@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Delete a document and all its chunks."""
    from backend.db.models import Document
    from pathlib import Path
    import shutil

    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Delete vector chunks
    ingestion = request.app.state.ingestion
    ingestion.vector_store.delete_document_chunks(document_id)

    # Delete file from disk
    file_path = Path(doc.filepath)
    if file_path.exists():
        parent_dir = file_path.parent
        file_path.unlink()
        # Remove the document directory if empty
        if parent_dir.exists() and not any(parent_dir.iterdir()):
            shutil.rmtree(parent_dir)

    # Delete from database
    db.delete(doc)
    db.commit()

    return {"status": "deleted", "document_id": document_id}
```

---

## FILE 6: `backend/retrieval/routes.py` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patch.

### Patch 6.1: Replace the search endpoint

**FIND:** The existing `POST /search` endpoint. It currently returns empty results.

**REPLACE the function body** with:

```python
@router.post("/search")
async def semantic_search(
    request: Request,
    db: Session = Depends(get_db),
):
    """Perform semantic search across ingested documents."""
    from pydantic import BaseModel

    class SearchRequest(BaseModel):
        query: str
        top_k: int = 5
        document_ids: list[str] | None = None

    body = await request.json()
    search_req = SearchRequest(**body)

    if not search_req.query.strip():
        return {"results": []}

    # Get the ingestion coordinator from app state
    ingestion = request.app.state.ingestion
    embedding_client = ingestion.embedding_client
    vector_store = ingestion.vector_store

    # Embed the query
    try:
        query_embedding = await embedding_client.embed_single(search_req.query)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Embedding model unavailable: {exc}",
        )

    # Search vectors
    results = vector_store.search(
        query_embedding=query_embedding,
        top_k=search_req.top_k,
        document_ids=search_req.document_ids,
    )

    return {"results": results}
```

**Also add this import at the top of the file if not present:**
```python
from fastapi import HTTPException, Request
```

---

## FILE 7: `backend/jobs/routes.py` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patches.

### Patch 7.1: Replace the list endpoint

**FIND:** The `GET /` endpoint that returns an empty list.

**REPLACE with:**
```python
@router.get("/")
async def list_jobs(
    db: Session = Depends(get_db),
    status: str | None = None,
    limit: int = 50,
):
    """List all ingestion jobs, optionally filtered by status."""
    from backend.db.models import IngestionJob

    query = db.query(IngestionJob)

    if status:
        query = query.filter(IngestionJob.status == status)

    jobs = query.order_by(IngestionJob.created_at.desc()).limit(limit).all()

    return {
        "jobs": [
            {
                "id": job.id,
                "document_id": job.document_id,
                "status": job.status,
                "progress": job.progress,
                "error_message": job.error_message,
                "created_at": job.created_at.isoformat() if job.created_at else None,
            }
            for job in jobs
        ]
    }
```

### Patch 7.2: Replace the single job endpoint

**FIND:** The `GET /{job_id}` endpoint.

**REPLACE with:**
```python
@router.get("/{job_id}")
async def get_job(job_id: str, db: Session = Depends(get_db)):
    """Get details for a specific job."""
    from backend.db.models import IngestionJob

    job = db.query(IngestionJob).filter(IngestionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    return {
        "id": job.id,
        "document_id": job.document_id,
        "status": job.status,
        "progress": job.progress,
        "error_message": job.error_message,
        "created_at": job.created_at.isoformat() if job.created_at else None,
    }
```

### Patch 7.3: Replace the retry endpoint

**FIND:** The `POST /{job_id}/retry` endpoint.

**REPLACE with:**
```python
@router.post("/{job_id}/retry")
async def retry_job(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Retry a failed job."""
    from backend.db.models import IngestionJob, Document
    from backend.knowledge.ingestion import JobStatus

    job = db.query(IngestionJob).filter(IngestionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in (JobStatus.FAILED.value, JobStatus.CANCELLED.value):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot retry job with status '{job.status}'. "
                   f"Only failed or cancelled jobs can be retried.",
        )

    doc = db.query(Document).filter(Document.id == job.document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Reset job state
    job.status = JobStatus.QUEUED.value
    job.progress = 0.0
    job.error_message = None
    db.commit()

    # Re-enqueue
    ingestion = request.app.state.ingestion
    await ingestion.enqueue(
        job_id=job.id,
        document_id=job.document_id,
        file_path=doc.filepath,
        source_filename=doc.filename,
    )

    return {"status": "re-queued", "job_id": job_id}
```

### Patch 7.4: Replace the cancel endpoint

**FIND:** The `POST /{job_id}/cancel` endpoint.

**REPLACE with:**
```python
@router.post("/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Cancel a running job."""
    from backend.db.models import IngestionJob
    from backend.knowledge.ingestion import JobStatus

    job = db.query(IngestionJob).filter(IngestionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status in (JobStatus.READY.value, JobStatus.FAILED.value):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel job with status '{job.status}'",
        )

    ingestion = request.app.state.ingestion
    cancelled = await ingestion.cancel_job(job_id)

    if cancelled:
        job.status = JobStatus.CANCELLED.value
        job.error_message = "Cancelled by user"
        db.commit()
        return {"status": "cancelled", "job_id": job_id}

    return {"status": "already_completed", "job_id": job_id}
```

**Also add this import at the top if not present:**
```python
from fastapi import HTTPException, Request
```

---

## FILE 8: `backend/main.py` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patches.

### Patch 8.1: Wire IngestionCoordinator into lifespan

**FIND:** The `lifespan` function. Look for the section after model manager startup:
```python
    app.state.model_manager = ModelLifecycleManager(settings)
    SessionLocal = get_session_factory(engine)
    await app.state.model_manager.startup(SessionLocal)
```

**ADD immediately after that block:**
```python
    # Initialize RAG pipeline components
    from backend.knowledge.ingestion import IngestionCoordinator

    app.state.ingestion = IngestionCoordinator(
        settings, SessionLocal, app.state.model_manager
    )
    await app.state.ingestion.start()
```

### Patch 8.2: Wire IngestionCoordinator shutdown

**FIND:** The shutdown section of the lifespan:
```python
    # Shutdown
    logger.info("Shutting down backend...")
    await app.state.ingestion.stop()
    await app.state.model_manager.shutdown()
```

**VERIFY** that `await app.state.ingestion.stop()` is called BEFORE
`await app.state.model_manager.shutdown()`. The ingestion coordinator
needs the model manager to still be running so it can finish or
cancel in-flight embedding requests.

If the order is wrong, fix it so ingestion stops first.

---

## DATABASE MODELS NOTE

The code above references `IngestionJob` from `backend.db.models`.
If this model does not already exist in your database models file,
**ADD it to `backend/db/models.py`:**

```python
class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"

    id = Column(String, primary_key=True)
    document_id = Column(String, ForeignKey("documents.id"), nullable=False)
    status = Column(String, nullable=False, default="queued")
    progress = Column(Float, nullable=False, default=0.0)
    error_message = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
```

If `IngestionJob` already exists, verify it has at least these columns:
`id`, `document_id`, `status`, `progress`, `error_message`, `created_at`.
Adapt the code above to match your existing column names if they differ.

---

## VERIFICATION CHECKLIST

Run these checks IN ORDER. Do not skip any.

```bash
# 1. Verify all new files exist
ls backend/db/vector_store.py
ls backend/knowledge/parser.py
ls backend/knowledge/ingestion.py
ls backend/knowledge/embeddings.py

# 2. Verify imports work
python -c "from backend.db.vector_store import VectorStore; print('vector_store OK')"
python -c "from backend.knowledge.parser import parse_document; print('parser OK')"
python -c "from backend.knowledge.ingestion import IngestionCoordinator; print('ingestion OK')"
python -c "from backend.knowledge.embeddings import EmbeddingClient; print('embeddings OK')"

# 3. Test chunking logic
python -c "
from backend.knowledge.ingestion import chunk_text
text = 'Hello world. ' * 100
chunks = chunk_text(text, chunk_size=512, overlap=64)
print(f'Chunks: {len(chunks)}')
assert len(chunks) > 1, 'Should produce multiple chunks'
assert all(len(c) <= 600 for c in chunks), 'Chunks should be bounded'
print('Chunking OK')
"

# 4. Test parser with a text file
python -c "
from pathlib import Path
from backend.knowledge.parser import parse_document
import tempfile, os

# Create a temp text file
with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
    f.write('This is a test document for parsing.')
    tmp_path = f.name

try:
    result = parse_document(tmp_path)
    assert 'test document' in result
    print('Parser OK')
finally:
    os.unlink(tmp_path)
"

# 5. Test parser rejects empty files
python -c "
from backend.knowledge.parser import parse_document, DocumentParseError
import tempfile, os

with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
    tmp_path = f.name

try:
    parse_document(tmp_path)
    assert False, 'Should have raised DocumentParseError'
except DocumentParseError as e:
    print(f'Correctly rejected empty file: {e}')
finally:
    os.unlink(tmp_path)
"

# 6. Test vector store (requires sqlite-vec)
python -c "
import tempfile, os
from backend.db.vector_store import VectorStore

with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
    tmp_db = f.name

try:
    store = VectorStore(tmp_db)
    store.insert_chunk('doc-1', 0, 'Hello world', [0.1]*384, 'test.txt')
    results = store.search([0.1]*384, top_k=1)
    assert len(results) == 1
    assert results[0]['content'] == 'Hello world'
    store.close()
    print('VectorStore OK')
finally:
    os.unlink(tmp_db)
"

# 7. Start the backend and verify routes exist
python -m backend.main --data-dir ./test-data --port 8000 &
sleep 3

curl -s http://127.0.0.1:8000/api/v1/jobs | python -m json.tool
# EXPECT: {"jobs": []}

curl -s -X POST http://127.0.0.1:8000/api/v1/retrieval/search \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "top_k": 3}'
# EXPECT: 503 if no embedding model loaded, NOT 500

# Kill the test backend
kill %1

# 8. Run the quality gate
./scripts/quality-gate.ps1
```

---

## THINGS YOU MUST NOT DO

1. **Do NOT add cloud API calls.** All embedding and search must be local.
2. **Do NOT add telemetry or analytics.**
3. **Do NOT return empty arrays from search when documents have been ingested.**
   If the vector store has data, search must return results.
4. **Do NOT swallow exceptions silently.** Every error must be logged and
   surfaced to the job status so the UI can show it.
5. **Do NOT hard-code health or success responses.**
6. **Do NOT modify Phase 1 files** (`backend/inference/`).
7. **Do NOT modify Phase 2 files** (`apps/desktop/shared/`, `preload.ts`).
8. **Do NOT use the real `%APPDATA%\NOC AI Assistant` profile for tests.**
9. **Do NOT skip the document deletion cleanup.** When a document is deleted,
   its vector chunks MUST also be deleted.
10. **Do NOT change the bundled embedding model or its SHA-256 checksum:**
    `bge-small-en-v1.5-q8_0.gguf`
    `f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804`

---

## DEFINITION OF DONE

Phase 3 is complete when ALL of the following are true:

- [ ] All four new files created at the correct paths.
- [ ] Upload a TXT file → job progresses QUEUED → PARSING → CHUNKING → EMBEDDING → READY.
- [ ] Upload a corrupt/empty file → job reaches FAILED with actionable error message.
- [ ] Upload an unsupported file type → HTTP 400 with clear message.
- [ ] POST /retrieval/search returns relevant chunks with content and source.
- [ ] GET /jobs returns real job list with status and progress.
- [ ] POST /jobs/{id}/retry re-enqueues a failed job.
- [ ] POST /jobs/{id}/cancel cancels a running job.
- [ ] DELETE /documents/{id} removes file, DB record, and vector chunks.
- [ ] App restart marks interrupted jobs as FAILED (not stuck in PARSING).
- [ ] `quality-gate.ps1` exits with code 0.
- [ ] No data written to real `%APPDATA%` during tests.

---

## COMMIT MESSAGE

When all checks pass:

```bash
git add backend/db/vector_store.py backend/knowledge/ backend/retrieval/ backend/jobs/ backend/main.py
git commit -m "phase3: complete RAG pipeline end-to-end

- Add VectorStore with sqlite-vec for 384-dim embedding storage
- Add DocumentParser supporting PDF, TXT, MD, DOCX with error handling
- Add EmbeddingClient for local BGE model via llama-server
- Add IngestionCoordinator with async task queue and job state machine
- Add chunk_text with sentence-boundary-aware splitting
- Wire upload endpoint to create jobs and enqueue ingestion
- Implement semantic search endpoint with real vector queries
- Implement job list, retry, and cancel endpoints
- Add document delete with vector chunk cleanup
- Add interrupted job recovery on app restart
- Enforce 50MB file size limit and unsupported type rejection"
```
```
