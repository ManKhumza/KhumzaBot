"""Small synchronous sqlite-vec store kept for Phase 3 compatibility tools.

The desktop application's authoritative RAG store remains
``backend.retrieval.vector_store``.  This class provides the documented
synchronous API for diagnostics and isolated utility use without changing the
live chunk schema.
"""

from __future__ import annotations

import math
import sqlite3
import struct
import threading
from pathlib import Path
from typing import Any

import sqlite_vec


EMBEDDING_DIM = 384


def serialize_f32(vector: list[float]) -> bytes:
    """Serialize one finite 384-dimensional vector as little-endian float32."""
    if len(vector) != EMBEDDING_DIM:
        raise ValueError(
            f"Expected {EMBEDDING_DIM}-dimensional vector, got {len(vector)}"
        )
    if not all(math.isfinite(value) for value in vector):
        raise ValueError("Embedding contains a non-finite value")
    return struct.pack(f"<{EMBEDDING_DIM}f", *vector)


def deserialize_f32(data: bytes) -> list[float]:
    """Deserialize a little-endian float32 vector."""
    if len(data) % 4:
        raise ValueError("Float32 vector byte length must be divisible by four")
    return list(struct.unpack(f"<{len(data) // 4}f", data))


class VectorStore:
    """Synchronous 384-dimensional sqlite-vec compatibility store."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path).removeprefix("sqlite:///")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._lock = threading.RLock()
        self._load_extension()
        self._ensure_tables()

    def _load_extension(self) -> None:
        try:
            self.conn.enable_load_extension(True)
            sqlite_vec.load(self.conn)
        except (AttributeError, sqlite3.Error) as exc:
            raise RuntimeError(f"Failed to load the bundled sqlite-vec extension: {exc}") from exc
        finally:
            self.conn.enable_load_extension(False)

    def _ensure_tables(self) -> None:
        with self._lock:
            self.conn.execute(
                """CREATE VIRTUAL TABLE IF NOT EXISTS phase3_document_chunks
                   USING vec0(embedding FLOAT[384])"""
            )
            self.conn.execute(
                """CREATE TABLE IF NOT EXISTS phase3_chunk_metadata (
                       id INTEGER PRIMARY KEY AUTOINCREMENT,
                       document_id TEXT NOT NULL,
                       chunk_index INTEGER NOT NULL,
                       content TEXT NOT NULL,
                       source_file TEXT NOT NULL,
                       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                       UNIQUE(document_id, chunk_index)
                   )"""
            )
            self.conn.execute(
                """CREATE INDEX IF NOT EXISTS idx_phase3_chunk_document
                   ON phase3_chunk_metadata(document_id)"""
            )
            self.conn.commit()

    def insert_chunk(
        self,
        document_id: str,
        chunk_index: int,
        content: str,
        embedding: list[float],
        source_file: str,
    ) -> int:
        """Insert or replace one document chunk and return its vector row id."""
        if not document_id or not content:
            raise ValueError("Document id and chunk content are required")
        serialized = serialize_f32(embedding)
        with self._lock:
            try:
                existing = self.conn.execute(
                    "SELECT id FROM phase3_chunk_metadata WHERE document_id = ? AND chunk_index = ?",
                    (document_id, chunk_index),
                ).fetchone()
                if existing:
                    row_id = int(existing[0])
                    self.conn.execute(
                        "UPDATE phase3_chunk_metadata SET content = ?, source_file = ? WHERE id = ?",
                        (content, source_file, row_id),
                    )
                    self.conn.execute("DELETE FROM phase3_document_chunks WHERE rowid = ?", (row_id,))
                else:
                    cursor = self.conn.execute(
                        """INSERT INTO phase3_chunk_metadata
                           (document_id, chunk_index, content, source_file)
                           VALUES (?, ?, ?, ?)""",
                        (document_id, chunk_index, content, source_file),
                    )
                    row_id = int(cursor.lastrowid)
                self.conn.execute(
                    "INSERT INTO phase3_document_chunks(rowid, embedding) VALUES (?, ?)",
                    (row_id, serialized),
                )
                self.conn.commit()
                return row_id
            except Exception:
                self.conn.rollback()
                raise

    def insert_chunks_batch(
        self,
        document_id: str,
        chunks: list[dict[str, Any]],
        source_file: str,
    ) -> int:
        """Insert multiple chunks atomically."""
        if not chunks:
            return 0
        prepared = [
            (
                int(chunk["index"]),
                str(chunk["content"]),
                serialize_f32(chunk["embedding"]),
            )
            for chunk in chunks
        ]
        with self._lock:
            try:
                for chunk_index, content, embedding in prepared:
                    existing = self.conn.execute(
                        "SELECT id FROM phase3_chunk_metadata WHERE document_id = ? AND chunk_index = ?",
                        (document_id, chunk_index),
                    ).fetchone()
                    if existing:
                        row_id = int(existing[0])
                        self.conn.execute(
                            "UPDATE phase3_chunk_metadata SET content = ?, source_file = ? WHERE id = ?",
                            (content, source_file, row_id),
                        )
                        self.conn.execute("DELETE FROM phase3_document_chunks WHERE rowid = ?", (row_id,))
                    else:
                        cursor = self.conn.execute(
                            """INSERT INTO phase3_chunk_metadata
                               (document_id, chunk_index, content, source_file)
                               VALUES (?, ?, ?, ?)""",
                            (document_id, chunk_index, content, source_file),
                        )
                        row_id = int(cursor.lastrowid)
                    self.conn.execute(
                        "INSERT INTO phase3_document_chunks(rowid, embedding) VALUES (?, ?)",
                        (row_id, embedding),
                    )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return len(prepared)

    def search(
        self,
        query_embedding: list[float],
        top_k: int = 5,
        document_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Return nearest chunks, optionally restricted to document ids."""
        if top_k < 1:
            raise ValueError("top_k must be at least one")
        serialized = serialize_f32(query_embedding)
        candidate_count = top_k if not document_ids else min(4096, max(top_k * 8, top_k))
        sql = """SELECT m.content, m.source_file, m.document_id,
                        m.chunk_index, v.distance
                 FROM phase3_document_chunks AS v
                 JOIN phase3_chunk_metadata AS m ON m.id = v.rowid
                 WHERE v.embedding MATCH ? AND k = ?"""
        params: list[Any] = [serialized, candidate_count]
        if document_ids:
            placeholders = ",".join("?" for _ in document_ids)
            sql += f" AND m.document_id IN ({placeholders})"
            params.extend(document_ids)
        sql += " ORDER BY v.distance LIMIT ?"
        params.append(top_k)
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [
            {
                "content": row[0],
                "source_file": row[1],
                "document_id": row[2],
                "chunk_index": row[3],
                "distance": row[4],
            }
            for row in rows
        ]

    def delete_document_chunks(self, document_id: str) -> int:
        """Delete vector and metadata rows for one document atomically."""
        with self._lock:
            row_ids = [
                row[0]
                for row in self.conn.execute(
                    "SELECT id FROM phase3_chunk_metadata WHERE document_id = ?",
                    (document_id,),
                )
            ]
            if not row_ids:
                return 0
            try:
                for start in range(0, len(row_ids), 500):
                    batch = row_ids[start : start + 500]
                    placeholders = ",".join("?" for _ in batch)
                    self.conn.execute(
                        f"DELETE FROM phase3_document_chunks WHERE rowid IN ({placeholders})",
                        batch,
                    )
                self.conn.execute(
                    "DELETE FROM phase3_chunk_metadata WHERE document_id = ?",
                    (document_id,),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
            return len(row_ids)

    def get_document_chunk_count(self, document_id: str) -> int:
        with self._lock:
            row = self.conn.execute(
                "SELECT COUNT(*) FROM phase3_chunk_metadata WHERE document_id = ?",
                (document_id,),
            ).fetchone()
        return int(row[0])

    def close(self) -> None:
        with self._lock:
            if self.conn is not None:
                self.conn.close()
                self.conn = None  # type: ignore[assignment]
