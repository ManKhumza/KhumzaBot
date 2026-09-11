"""Shared sqlite-vec loading and non-destructive index compatibility checks."""
import re


def load_vector_extension(connection) -> None:
    import sqlite_vec
    try:
        connection.enable_load_extension(True)
        sqlite_vec.load(connection)
        connection.execute("SELECT vec_version()").fetchone()
    except Exception as exc:
        raise RuntimeError("The required local vector extension could not be loaded; repair the application installation") from exc
    finally:
        connection.enable_load_extension(False)


def ensure_vector_schema(connection, dimension: int) -> bool:
    """Rebuild an incompatible derived index and queue preserved source documents."""
    if not 1 <= dimension <= 65536:
        raise ValueError("Invalid embedding dimension")
    existing = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
    ).fetchone()
    mismatch = bool(existing and not re.search(rf"FLOAT\s*\[\s*{dimension}\s*\]", existing[0] or "", re.I))
    if mismatch:
        connection.execute("DROP TABLE chunks_vec")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {"documents", "collections"}.issubset(tables):
            connection.execute("UPDATE documents SET status='queued', error_message='Embedding index changed; reindex queued' WHERE status='ready'")
            connection.execute("UPDATE collections SET reindex_required=1, reindex_reason='Embedding dimension changed'")
    connection.execute(f"""CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id TEXT PRIMARY KEY, embedding FLOAT[{dimension}], collection_id TEXT, document_id TEXT
    )""")
    return mismatch
