import sqlite3
import sqlite_vec
import numpy as np
from dataclasses import dataclass
from typing import List, Optional
import json
import uuid

@dataclass
class ChunkWithEmbedding:
    chunk: "Chunk"
    embedding: List[float]

@dataclass
class SearchResult:
    chunk_id: str
    document_id: str
    collection_id: str
    content: str
    score: float
    page_start: int
    page_end: int
    section_title: str | None
    metadata: dict

class VectorStore:
    def __init__(self, db_path: str, embedding_dim: int):
        self.db_path = db_path.removeprefix("sqlite:///")
        self.embedding_dim = embedding_dim
        self._conn: sqlite3.Connection | None = None
    
    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            from backend.db.database import open_dbapi_connection

            self._conn = open_dbapi_connection(f"sqlite:///{self.db_path}")
            self._conn.enable_load_extension(True)
            sqlite_vec.load(self._conn)
            self._conn.enable_load_extension(False)
            self._init_vec_table()
        return self._conn
    
    def _init_vec_table(self):
        conn = self._get_conn()
        existing = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
        ).fetchone()
        if existing and f"FLOAT[{self.embedding_dim}]" not in (existing[0] or ""):
            conn.execute("DROP TABLE chunks_vec")
        conn.execute(f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding FLOAT[{self.embedding_dim}],
                collection_id TEXT,
                document_id TEXT
            )
        """)
        conn.commit()
    
    async def add_chunks(self, chunks_with_embeddings: List[ChunkWithEmbedding]) -> None:
        conn = self._get_conn()
        
        data = []
        for cwe in chunks_with_embeddings:
            chunk = cwe.chunk
            embedding = np.array(cwe.embedding, dtype=np.float32)
            if embedding.size != self.embedding_dim:
                raise ValueError(f"Expected {self.embedding_dim} embedding values, got {embedding.size}")
            norm = np.linalg.norm(embedding)
            if not np.isfinite(norm) or norm == 0:
                raise ValueError("Embedding is empty or non-finite")
            embedding = embedding / norm
            
            data.append((
                chunk.id,
                embedding.tobytes(),
                chunk.collection_id,
                chunk.document_id,
            ))
        
        conn.executemany(
            "INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding, collection_id, document_id) VALUES (?, ?, ?, ?)",
            data
        )
        conn.commit()
    
    async def search(
        self,
        query_embedding: List[float],
        collection_ids: List[str] | None = None,
        document_ids: List[str] | None = None,
        top_k: int = 10,
        filter_sql: str = "",
        filter_params: Optional[list] = None,
    ) -> List[SearchResult]:
        conn = self._get_conn()
        
        query_vec = np.array(query_embedding, dtype=np.float32)
        if query_vec.size != self.embedding_dim:
            raise ValueError(f"Expected {self.embedding_dim} query values, got {query_vec.size}")
        norm = np.linalg.norm(query_vec)
        if not np.isfinite(norm) or norm == 0:
            raise ValueError("Query embedding is empty or non-finite")
        query_vec = query_vec / norm
        
        # sqlite-vec KNN syntax requires MATCH in WHERE and the requested
        # neighbour count through its hidden `k` column.
        where_clauses = ["embedding MATCH ?", "k = ?"]
        params = [query_vec.tobytes(), top_k]
        
        if collection_ids:
            placeholders = ",".join("?" * len(collection_ids))
            where_clauses.append(f"collection_id IN ({placeholders})")
            params.extend(collection_ids)
        
        if document_ids:
            placeholders = ",".join("?" * len(document_ids))
            where_clauses.append(f"document_id IN ({placeholders})")
            params.extend(document_ids)
        
        if filter_sql:
            where_clauses.append(filter_sql)
            params.extend(filter_params or [])

        where_clause = " AND ".join(where_clauses)
        
        sql = f"""
            SELECT 
                chunk_id,
                distance,
                collection_id,
                document_id
            FROM chunks_vec
            WHERE {where_clause}
            ORDER BY distance
        """
        
        cursor = conn.execute(sql, params)
        results = []
        
        for row in cursor:
            chunk_id, distance, collection_id, document_id = row
            score = 1.0 / (1.0 + distance)
            
            chunk = await self._get_chunk_details(chunk_id)
            if chunk:
                metadata = (
                    chunk.chunk_metadata
                    if isinstance(chunk.chunk_metadata, dict)
                    else json.loads(chunk.chunk_metadata) if chunk.chunk_metadata else {}
                )
                metadata = {key: value for key, value in metadata.items() if not key.startswith("_nocai")}
                results.append(SearchResult(
                    chunk_id=chunk_id,
                    document_id=document_id,
                    collection_id=collection_id,
                    content=chunk.content,
                    score=score,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    section_title=chunk.section_title,
                    metadata=metadata,
                ))
        
        return results
    
    async def _get_chunk_details(self, chunk_id: str) -> Optional["Chunk"]:
        from backend.db.database import create_db_engine, get_session_factory
        from backend.config import get_settings
        from backend.db.models import Chunk, Document
        settings = get_settings()
        engine = create_db_engine(settings.database_url)
        Session = get_session_factory(engine)
        with Session() as session:
            return session.query(Chunk).join(Document).filter(
                Chunk.id == chunk_id,
                Document.status == "ready",
            ).first()
    
    async def delete_chunks(self, chunk_ids: List[str]) -> None:
        if not chunk_ids:
            return
        conn = self._get_conn()
        for start in range(0, len(chunk_ids), 500):
            batch = chunk_ids[start:start + 500]
            placeholders = ",".join("?" * len(batch))
            conn.execute(f"DELETE FROM chunks_vec WHERE chunk_id IN ({placeholders})", batch)
        conn.commit()
    
    async def delete_collection(self, collection_id: str) -> None:
        conn = self._get_conn()
        conn.execute("DELETE FROM chunks_vec WHERE collection_id = ?", (collection_id,))
        conn.commit()
    
    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None
