# NOC AI Assistant — Knowledge & RAG System

## Knowledge Architecture

```
┌─────────────────────────────────────────────────────────────────┐
                      KNOWLEDGE SUBSYSTEM                           
├─────────────────────────────────────────────────────────────────┤
                                                                 
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          
  │  Collections │  │  Documents   │  │   Chunks     │          
  │  (Metadata)  │──│  (Source)    │──│  (Indexed)   │          
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          
         │                 │                 │                   
         ▼                 ▼                 ▼                   
  ┌──────────────────────────────────────────────────────────┐  
  │                   Ingestion Pipeline                      │  
  │  Upload → Validate → Parse → Chunk → Embed → Index → FTS │  
  └──────────────────────────────────────────────────────────┘  
         │                                    │                  
         ▼                                    ▼                  
  ┌─────────────┐                    ┌─────────────┐           
  │  sqlite-vec │                    │   FTS5      │           
  │  (Vectors)  │                    │  (Keywords) │           
  └──────┬──────┘                    └──────┬──────┘           
         │                                  │                  
         └──────────────┬───────────────────┘                  
                        ▼                                      
         ┌─────────────────────────────────┐                  
         │     Hybrid Retrieval (RRF)      │                  
         │  ACL Filter → Vector + FTS →    │                  
         │  RRF Fusion → Rerank → Top-K    │                  
         └──────────────┬──────────────────┘                  
                        │                                      
                        ▼                                      
         ┌─────────────────────────────────┐                  
         │      Context Construction       │                  
         │  Citations + Token Budget +     │                  
         │  Prompt Template → LLM          │                  
         └─────────────────────────────────┘                  
                                                                 
└─────────────────────────────────────────────────────────────────┘
```

## Document Processing Pipeline

```python
# backend/documents/pipeline.py
import asyncio
import hashlib
import magic
from pathlib import Path
from dataclasses import dataclass
from typing import AsyncIterator, Optional
from enum import Enum
import uuid

from backend.documents.parsers import parse_document, ParseResult
from backend.documents.chunking import chunk_text, ChunkConfig, TextChunk
from backend.inference.lifecycle import ModelLifecycleManager
from backend.db.database import Database

class DocumentStatus(str, Enum):
    QUEUED = "queued"
    VALIDATING = "validating"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXING = "indexing"
    READY = "ready"
    FAILED = "failed"
    DISABLED = "disabled"

@dataclass
class IngestionProgress:
    document_id: str
    stage: DocumentStatus
    progress: float  # 0.0 - 1.0
    message: str
    chunks_processed: int = 0
    total_chunks: int = 0

class IngestionPipeline:
    """Processes documents through the full ingestion pipeline."""
    
    def __init__(
        self, 
        db: Database, 
        model_manager: ModelLifecycleManager,
        vector_store: "VectorStore",
        knowledge_dir: Path,
    ):
        self.db = db
        self.model_manager = model_manager
        self.vector_store = vector_store
        self.knowledge_dir = knowledge_dir
        self._progress_callbacks: list[callable] = []
    
    def on_progress(self, callback: callable):
        self._progress_callbacks.append(callback)
    
    def _emit_progress(self, progress: IngestionProgress):
        for cb in self._progress_callbacks:
            try:
                cb(progress)
            except Exception as e:
                logger.error(f"Progress callback error: {e}")
    
    async def process_document(self, document_id: str) -> None:
        """Process a single document through all stages."""
        doc = await self.db.documents.get(document_id)
        if not doc:
            raise ValueError(f"Document {document_id} not found")
        
        collection = await self.db.collections.get(doc.collection_id)
        if not collection:
            raise ValueError(f"Collection {doc.collection_id} not found")
        
        # Get embedding model
        embedding_model = await self.db.models.get(collection.embedding_model_id)
        if not embedding_model:
            raise ValueError(f"Embedding model {collection.embedding_model_id} not found")
        
        # Ensure embedding model is loaded
        embedding_provider = self.model_manager.get_embedding_provider()
        if not embedding_provider or self.model_manager.active_embedding_model_id != embedding_model.id:
            await self.model_manager.load_model(embedding_model.id, "embedding")
            embedding_provider = self.model_manager.get_embedding_provider()
        
        try:
            # Stage 1: Validating
            await self._update_status(doc, DocumentStatus.VALIDATING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.VALIDATING, 0.05, "Validating file"))
            
            file_path = self.knowledge_dir / doc.filepath
            if not file_path.exists():
                raise FileNotFoundError(f"Source file not found: {file_path}")
            
            # Verify hash
            actual_hash = await self._compute_hash(file_path)
            if actual_hash != doc.file_hash:
                raise ValueError("File hash mismatch - file may have been modified")
            
            # Stage 2: Parsing
            await self._update_status(doc, DocumentStatus.PARSING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.PARSING, 0.15, "Extracting text"))
            
            parse_result = await parse_document(file_path, doc.mime_type)
            doc.page_count = parse_result.page_count
            doc.language = parse_result.language
            await self.db.documents.update(doc)
            
            # Save extracted text for preview/debug
            extracted_path = self.knowledge_dir / "collections" / doc.collection_id / "extracted" / f"{doc.id}.jsonl"
            extracted_path.parent.mkdir(parents=True, exist_ok=True)
            with open(extracted_path, "w", encoding="utf-8") as f:
                for page in parse_result.pages:
                    f.write(json.dumps({
                        "page": page.page_num,
                        "text": page.text,
                        "metadata": page.metadata,
                    }) + "\n")
            
            # Stage 3: Chunking
            await self._update_status(doc, DocumentStatus.CHUNKING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.CHUNKING, 0.30, "Chunking text"))
            
            chunk_config = ChunkConfig(**json.loads(collection.chunking_config))
            chunks = chunk_text(parse_result.full_text, chunk_config)
            
            # Stage 4: Embedding
            await self._update_status(doc, DocumentStatus.EMBEDDING)
            
            chunk_records = []
            for i, chunk in enumerate(chunks):
                progress = 0.30 + (0.40 * i / len(chunks))
                self._emit_progress(IngestionProgress(
                    document_id, DocumentStatus.EMBEDDING, progress, 
                    f"Embedding chunk {i+1}/{len(chunks)}", i, len(chunks)
                ))
                
                # Generate embedding
                embedding = await embedding_provider.embed_single(chunk.content)
                
                chunk_record = Chunk(
                    id=str(uuid.uuid4()),
                    document_id=doc.id,
                    collection_id=doc.collection_id,
                    chunk_index=i,
                    content=chunk.content,
                    token_count=chunk.token_count,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    section_title=chunk.section_title,
                    metadata=json.dumps(chunk.metadata),
                )
                chunk_records.append((chunk_record, embedding))
            
            # Stage 5: Indexing
            await self._update_status(doc, DocumentStatus.INDEXING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.INDEXING, 0.80, "Indexing vectors"))
            
            # Store chunks in database
            for chunk_record, _ in chunk_records:
                await self.db.chunks.create(chunk_record)
            
            # Store vectors in sqlite-vec
            await self.vector_store.add_chunks(chunk_records)
            
            # Update document
            doc.chunk_count = len(chunks)
            doc.embedded_model_id = embedding_model.id
            doc.embedded_config = collection.embedding_config
            doc.status = DocumentStatus.READY
            doc.processed_at = datetime.utcnow()
            await self.db.documents.update(doc)
            
            # Update collection stats
            await self._update_collection_stats(doc.collection_id)
            
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.READY, 1.0, "Complete", len(chunks), len(chunks)))
            
        except Exception as e:
            logger.error(f"Ingestion failed for {document_id}: {e}")
            await self._update_status(doc, DocumentStatus.FAILED, str(e))
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.FAILED, 0.0, f"Failed: {e}"))
            raise
    
    async def _update_status(self, doc, status: DocumentStatus, error: str = None):
        doc.status = status
        doc.error_message = error
        await self.db.documents.update(doc)
    
    async def _update_collection_stats(self, collection_id: str):
        stats = await self.db.chunks.get_collection_stats(collection_id)
        await self.db.collections.update_stats(collection_id, stats)
    
    async def _compute_hash(self, path: Path) -> str:
        sha256 = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()
```

## Document Parsers

```python
# backend/documents/parsers.py
from dataclasses import dataclass
from typing import List
from pathlib import Path
import pypdf
import docx
from bs4 import BeautifulSoup
import csv
import markdown

@dataclass
class ParsedPage:
    page_num: int
    text: str
    metadata: dict

@dataclass
class ParseResult:
    full_text: str
    pages: List[ParsedPage]
    page_count: int
    language: str
    metadata: dict

async def parse_document(file_path: Path, mime_type: str) -> ParseResult:
    """Parse document based on MIME type."""
    
    if mime_type == "application/pdf":
        return await _parse_pdf(file_path)
    elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return await _parse_docx(file_path)
    elif mime_type in ("text/plain", "text/markdown"):
        return await _parse_text(file_path)
    elif mime_type == "text/csv":
        return await _parse_csv(file_path)
    elif mime_type in ("text/html", "application/xhtml+xml"):
        return await _parse_html(file_path)
    else:
        raise ValueError(f"Unsupported MIME type: {mime_type}")

async def _parse_pdf(file_path: Path) -> ParseResult:
    pages = []
    full_text_parts = []
    
    with pypdf.PdfReader(file_path) as reader:
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text:
                pages.append(ParsedPage(
                    page_num=i + 1,
                    text=text,
                    metadata={"source": "pdf", "page": i + 1},
                ))
                full_text_parts.append(f"[Page {i+1}]\n{text}")
    
    # Detect if scanned (no extractable text)
    if not full_text_parts:
        return ParseResult(
            full_text="",
            pages=[],
            page_count=len(reader.pages),
            language="unknown",
            metadata={"scanned": True, "warning": "No extractable text - OCR required"},
        )
    
    return ParseResult(
        full_text="\n\n".join(full_text_parts),
        pages=pages,
        page_count=len(reader.pages),
        language=_detect_language(full_text_parts[0][:1000]),
        metadata={"parser": "pypdf"},
    )

async def _parse_docx(file_path: Path) -> ParseResult:
    doc = docx.Document(file_path)
    pages = []
    full_text_parts = []
    
    # DOCX doesn't have explicit pages, treat as single page
    text_parts = []
    for para in doc.paragraphs:
        if para.text.strip():
            text_parts.append(para.text)
    
    for table in doc.tables:
        table_text = []
        for row in table.rows:
            row_text = [cell.text for cell in row.cells]
            table_text.append(" | ".join(row_text))
        if table_text:
            text_parts.append("\n".join(table_text))
    
    full_text = "\n\n".join(text_parts)
    pages.append(ParsedPage(
        page_num=1,
        text=full_text,
        metadata={"source": "docx", "paragraphs": len(doc.paragraphs), "tables": len(doc.tables)},
    ))
    
    return ParseResult(
        full_text=full_text,
        pages=pages,
        page_count=1,
        language=_detect_language(full_text[:1000]),
        metadata={"parser": "python-docx"},
    )

async def _parse_text(file_path: Path) -> ParseResult:
    text = file_path.read_text(encoding="utf-8", errors="replace")
    return ParseResult(
        full_text=text,
        pages=[ParsedPage(page_num=1, text=text, metadata={"source": "text"})],
        page_count=1,
        language=_detect_language(text[:1000]),
        metadata={"parser": "text"},
    )

async def _parse_csv(file_path: Path) -> ParseResult:
    rows = []
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        headers = next(reader, [])
        for i, row in enumerate(reader):
            if any(cell.strip() for cell in row):
                row_dict = dict(zip(headers, row))
                rows.append(" | ".join(f"{k}: {v}" for k, v in row_dict.items()))
    
    full_text = "\n".join(rows)
    return ParseResult(
        full_text=full_text,
        pages=[ParsedPage(page_num=1, text=full_text, metadata={"source": "csv", "rows": len(rows), "columns": headers})],
        page_count=1,
        language=_detect_language(full_text[:1000]),
        metadata={"parser": "csv", "columns": headers},
    )

async def _parse_html(file_path: Path) -> ParseResult:
    html = file_path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")
    
    # Remove script/style
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    
    text = soup.get_text(separator="\n", strip=True)
    
    return ParseResult(
        full_text=text,
        pages=[ParsedPage(page_num=1, text=text, metadata={"source": "html", "title": soup.title.string if soup.title else ""})],
        page_count=1,
        language=_detect_language(text[:1000]),
        metadata={"parser": "beautifulsoup4"},
    )

def _detect_language(text: str) -> str:
    # Simple heuristic - in production use fasttext or similar
    if not text:
        return "unknown"
    # Check for common English words
    english_words = {"the", "and", "is", "to", "of", "a", "in", "that", "it", "for"}
    words = set(text.lower().split()[:100])
    if len(words & english_words) > 3:
        return "en"
    return "unknown"
```

## Chunking Strategy

```python
# backend/documents/chunking.py
from dataclasses import dataclass
from typing import List
import tiktoken
import re

@dataclass
class ChunkConfig:
    chunk_size: int = 512       # Target tokens per chunk
    chunk_overlap: int = 50     # Overlap tokens
    min_chunk_size: int = 50    # Minimum viable chunk
    respect_boundaries: bool = True  # Respect paragraphs/sections
    separators: List[str] = None  # Custom separators
    
    def __post_init__(self):
        if self.separators is None:
            self.separators = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "]

@dataclass
class TextChunk:
    content: str
    token_count: int
    page_start: int
    page_end: int
    section_title: str | None
    metadata: dict

def chunk_text(text: str, config: ChunkConfig) -> List[TextChunk]:
    """Split text into overlapping chunks with boundary awareness."""
    
    encoder = tiktoken.get_encoding("cl100k_base")  # GPT-4 compatible
    
    # Split by separators recursively
    splits = _split_by_separators(text, config.separators)
    
    chunks = []
    current_chunk = ""
    current_tokens = 0
    current_start_page = 1
    current_section = None
    
    page_pattern = re.compile(r'\[Page (\d+)\]')
    section_pattern = re.compile(r'^(#{1,6})\s+(.+)$', re.MULTILINE)
    
    for split in splits:
        split_tokens = len(encoder.encode(split))
        
        # Check for page markers
        page_match = page_pattern.search(split)
        if page_match:
            current_start_page = int(page_match.group(1))
        
        # Check for section headers
        section_match = section_pattern.search(split)
        if section_match:
            current_section = section_match.group(2).strip()
        
        # If adding this split would exceed chunk_size, finalize current chunk
        if current_tokens + split_tokens > config.chunk_size and current_tokens >= config.min_chunk_size:
            chunks.append(TextChunk(
                content=current_chunk.strip(),
                token_count=current_tokens,
                page_start=current_start_page,
                page_end=current_start_page,  # Approximate
                section_title=current_section,
                metadata={},
            ))
            
            # Start new chunk with overlap
            overlap_text = _get_overlap(current_chunk, config.chunk_overlap, encoder)
            current_chunk = overlap_text + split
            current_tokens = len(encoder.encode(current_chunk))
        else:
            current_chunk += split
            current_tokens += split_tokens
    
    # Add final chunk
    if current_tokens >= config.min_chunk_size:
        chunks.append(TextChunk(
            content=current_chunk.strip(),
            token_count=current_tokens,
            page_start=current_start_page,
            page_end=current_start_page,
            section_title=current_section,
            metadata={},
        ))
    
    return chunks

def _split_by_separators(text: str, separators: List[str]) -> List[str]:
    """Recursively split text by separators."""
    if not separators:
        return [text]
    
    sep = separators[0]
    parts = text.split(sep)
    
    if len(parts) == 1:
        return _split_by_separators(text, separators[1:])
    
    result = []
    for i, part in enumerate(parts):
        if i > 0:
            result.append(sep)
        subparts = _split_by_separators(part, separators[1:])
        result.extend(subparts)
    
    return [p for p in result if p]

def _get_overlap(text: str, overlap_tokens: int, encoder) -> str:
    """Get the last overlap_tokens worth of text."""
    tokens = encoder.encode(text)
    if len(tokens) <= overlap_tokens:
        return text
    overlap_tokens = tokens[-overlap_tokens:]
    return encoder.decode(overlap_tokens)
```

## Vector Store (sqlite-vec)

```python
# backend/retrieval/vector_store.py
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
    """sqlite-vec backed vector storage with permission filtering."""
    
    def __init__(self, db_path: str, embedding_dim: int):
        self.db_path = db_path
        self.embedding_dim = embedding_dim
        self._conn: sqlite3.Connection | None = None
    
    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self.db_path)
            self._conn.enable_load_extension(True)
            sqlite_vec.load(self._conn)
            self._conn.enable_load_extension(False)
            self._init_vec_table()
        return self._conn
    
    def _init_vec_table(self):
        conn = self._get_conn()
        # Create virtual table for vectors
        # Using auxiliary columns for filtering
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
        """Add chunks with embeddings to vector store."""
        conn = self._get_conn()
        
        data = []
        for cwe in chunks_with_embeddings:
            chunk = cwe.chunk
            embedding = np.array(cwe.embedding, dtype=np.float32)
            # Normalize for cosine similarity
            embedding = embedding / np.linalg.norm(embedding)
            
            data.append((
                chunk.id,
                embedding.tobytes(),
                chunk.collection_id,
                chunk.document_id,
            ))
        
        conn.executemany(
            "INSERT INTO chunks_vec (chunk_id, embedding, collection_id, document_id) VALUES (?, ?, ?, ?)",
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
        filter_params: list = [],
    ) -> List[SearchResult]:
        """Search vectors with optional filters."""
        conn = self._get_conn()
        
        # Normalize query
        query_vec = np.array(query_embedding, dtype=np.float32)
        query_vec = query_vec / np.linalg.norm(query_vec)
        
        # Build filter
        where_clauses = []
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
            params.extend(filter_params)
        
        where_clause = " AND ".join(where_clauses) if where_clauses else "1=1"
        
        # sqlite-vec KNN query
        sql = f"""
            SELECT 
                chunk_id,
                distance,
                collection_id,
                document_id
            FROM chunks_vec
            WHERE {where_clause}
            ORDER BY embedding MATCH ? LIMIT ?
        """
        
        cursor = conn.execute(sql, params)
        results = []
        
        for row in cursor:
            chunk_id, distance, collection_id, document_id = row
            # Convert distance to similarity (vec0 uses L2 distance)
            score = 1.0 / (1.0 + distance)
            
            # Fetch chunk details from main DB
            chunk = await self._get_chunk_details(chunk_id)
            if chunk:
                results.append(SearchResult(
                    chunk_id=chunk_id,
                    document_id=document_id,
                    collection_id=collection_id,
                    content=chunk.content,
                    score=score,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    section_title=chunk.section_title,
                    metadata=json.loads(chunk.metadata) if chunk.metadata else {},
                ))
        
        return results
    
    async def delete_chunks(self, chunk_ids: List[str]) -> None:
        conn = self._get_conn()
        placeholders = ",".join("?" * len(chunk_ids))
        conn.execute(f"DELETE FROM chunks_vec WHERE chunk_id IN ({placeholders})", chunk_ids)
        conn.commit()
    
    async def delete_collection(self, collection_id: str) -> None:
        conn = self._get_conn()
        conn.execute("DELETE FROM chunks_vec WHERE collection_id = ?", (collection_id,))
        conn.commit()
    
    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None
```

## Hybrid Retrieval with RRF

```python
# backend/retrieval/service.py
import asyncio
from dataclasses import dataclass
from typing import List, Optional, Set
import uuid

from backend.retrieval.vector_store import VectorStore, SearchResult
from backend.db.database import Database
from backend.security.rbac import check_permission, Permission

@dataclass
class RetrievalConfig:
    top_k: int = 10
    vector_weight: float = 0.5
    keyword_weight: float = 0.5
    use_reranker: bool = False
    reranker_model_id: str | None = None
    min_score: float = 0.0

class RetrievalService:
    """Permission-aware hybrid retrieval with RRF fusion."""
    
    def __init__(
        self, 
        db: Database, 
        vector_store: VectorStore,
        model_manager: "ModelLifecycleManager",
        config: RetrievalConfig = None,
    ):
        self.db = db
        self.vector_store = vector_store
        self.model_manager = model_manager
        self.config = config or RetrievalConfig()
    
    async def retrieve(
        self,
        query: str,
        user_id: str,
        collection_ids: List[str] | None = None,
        config: RetrievalConfig | None = None,
    ) -> List[SearchResult]:
        """Main retrieval entry point with permission filtering."""
        cfg = config or self.config
        
        # 1. Resolve accessible collections
        accessible_collections = await self._get_accessible_collections(user_id, collection_ids)
        if not accessible_collections:
            return []
        
        accessible_collection_ids = [str(c.id) for c in accessible_collections]
        
        # 2. Generate query embedding
        embedding_provider = self.model_manager.get_embedding_provider()
        if not embedding_provider:
            raise RuntimeError("No embedding model loaded")
        
        query_embedding = await embedding_provider.embed_single(query)
        
        # 3. Vector search (with ACL filter)
        vector_results = await self.vector_store.search(
            query_embedding=query_embedding,
            collection_ids=accessible_collection_ids,
            top_k=cfg.top_k * 3,  # Fetch extra for fusion
        )
        
        # 4. Keyword search (FTS5) with same ACL filter
        keyword_results = await self._fts_search(
            query=query,
            collection_ids=accessible_collection_ids,
            top_k=cfg.top_k * 3,
        )
        
        # 5. Reciprocal Rank Fusion
        fused_results = self._rrf_fusion(
            vector_results, 
            keyword_results, 
            cfg.top_k,
            cfg.vector_weight,
            cfg.keyword_weight,
        )
        
        # 6. Optional reranking
        if cfg.use_reranker and cfg.reranker_model_id:
            fused_results = await self._rerank(query, fused_results, cfg.top_k)
        
        # 7. Filter by min_score
        fused_results = [r for r in fused_results if r.score >= cfg.min_score]
        
        return fused_results[:cfg.top_k]
    
    async def _get_accessible_collections(
        self, 
        user_id: str, 
        requested_ids: List[str] | None
    ) -> List["Collection"]:
        """Get collections user has read access to."""
        # Admin bypass
        user = await self.db.users.get(user_id)
        if check_permission(user, Permission.KNOWLEDGE_READ_ALL):
            if requested_ids:
                return await self.db.collections.list(ids=requested_ids)
            return await self.db.collections.list()
        
        # Get explicit grants
        grants = await self.db.collection_perms.list_for_user(user_id)
        granted_ids = {g.collection_id for g in grants if g.permission in ("read", "write", "admin")}
        
        if requested_ids:
            granted_ids &= set(requested_ids)
        
        if not granted_ids:
            return []
        
        return await self.db.collections.list(ids=list(granted_ids))
    
    async def _fts_search(
        self, 
        query: str, 
        collection_ids: List[str], 
        top_k: int
    ) -> List[SearchResult]:
        """SQLite FTS5 keyword search."""
        conn = self.db.get_connection()
        
        # Build FTS query (simple tokenization)
        fts_query = " ".join(f'"{term}"' for term in query.split() if len(term) > 2)
        if not fts_query:
            return []
        
        placeholders = ",".join("?" * len(collection_ids))
        sql = f"""
            SELECT 
                chunk_id,
                document_id,
                collection_id,
                content,
                rank
            FROM chunks_fts
            WHERE collection_id IN ({placeholders})
            AND chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """
        
        params = collection_ids + [fts_query, top_k]
        cursor = conn.execute(sql, params)
        
        results = []
        for row in cursor:
            chunk_id, document_id, collection_id, content, rank = row
            # Convert rank to score (lower rank = better)
            score = 1.0 / (1.0 + abs(rank))
            
            chunk = await self._get_chunk_details(chunk_id)
            if chunk:
                results.append(SearchResult(
                    chunk_id=chunk_id,
                    document_id=document_id,
                    collection_id=collection_id,
                    content=content,
                    score=score,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    section_title=chunk.section_title,
                    metadata=json.loads(chunk.metadata) if chunk.metadata else {},
                ))
        
        return results
    
    def _rrf_fusion(
        self,
        vector_results: List[SearchResult],
        keyword_results: List[SearchResult],
        top_k: int,
        vector_weight: float,
        keyword_weight: float,
    ) -> List[SearchResult]:
        """Reciprocal Rank Fusion combining vector and keyword results."""
        # RRF formula: score = weight / (k + rank)
        # k=60 is standard
        k = 60
        
        # Build rank maps
        vector_ranks = {r.chunk_id: i for i, r in enumerate(vector_results)}
        keyword_ranks = {r.chunk_id: i for i, r in enumerate(keyword_results)}
        
        all_chunk_ids = set(vector_ranks.keys()) | set(keyword_ranks.keys())
        
        fused = []
        for chunk_id in all_chunk_ids:
            v_rank = vector_ranks.get(chunk_id)
            k_rank = keyword_ranks.get(chunk_id)
            
            score = 0.0
            if v_rank is not None:
                score += vector_weight / (k + v_rank + 1)
            if k_rank is not None:
                score += keyword_weight / (k + k_rank + 1)
            
            # Get the result object (prefer vector result for content)
            result_obj = None
            if v_rank is not None:
                result_obj = vector_results[v_rank]
            elif k_rank is not None:
                result_obj = keyword_results[k_rank]
            
            if result_obj:
                # Create new result with fused score
                fused.append(SearchResult(
                    chunk_id=result_obj.chunk_id,
                    document_id=result_obj.document_id,
                    collection_id=result_obj.collection_id,
                    content=result_obj.content,
                    score=score,
                    page_start=result_obj.page_start,
                    page_end=result_obj.page_end,
                    section_title=result_obj.section_title,
                    metadata=result_obj.metadata,
                ))
        
        # Sort by fused score descending
        fused.sort(key=lambda x: x.score, reverse=True)
        return fused
    
    async def _rerank(
        self, 
        query: str, 
        results: List[SearchResult], 
        top_k: int
    ) -> List[SearchResult]:
        """Rerank results using cross-encoder."""
        if not results:
            return results
        
        # Load reranker if needed
        reranker_provider = self.model_manager.get_reranker_provider()
        if not reranker_provider:
            # Try to load
            reranker_model = await self.db.models.get(self.config.reranker_model_id)
            if reranker_model:
                await self.model_manager.load_model(reranker_model.id, "reranker")
                reranker_provider = self.model_manager.get_reranker_provider()
        
        if not reranker_provider:
            logger.warning("Reranker requested but not available, skipping")
            return results
        
        documents = [r.content for r in results]
        reranked = await reranker_provider.rerank(query, documents, top_k)
        
        # Reorder results
        reranked_results = []
        for idx, score in reranked:
            if idx < len(results):
                r = results[idx]
                reranked_results.append(SearchResult(
                    chunk_id=r.chunk_id,
                    document_id=r.document_id,
                    collection_id=r.collection_id,
                    content=r.content,
                    score=score,  # Use reranker score
                    page_start=r.page_start,
                    page_end=r.page_end,
                    section_title=r.section_title,
                    metadata=r.metadata,
                ))
        
        return reranked_results
```

## Context Construction & Citations

```python
# backend/chat/context.py
from dataclasses import dataclass
from typing import List
import tiktoken

@dataclass
class Citation:
    chunk_id: str
    document_id: str
    document_name: str
    collection_name: str
    page_start: int
    page_end: int
    section_title: str | None
    score: float
    preview: str  # First 200 chars of chunk

@dataclass
class ContextPackage:
    system_prompt: str
    messages: List[dict]  # OpenAI format
    citations: List[Citation]
    total_tokens: int
    retrieval_metadata: dict

class ContextBuilder:
    """Builds LLM context with citations and token budget management."""
    
    def __init__(self, model_context_length: int = 4096, reserved_tokens: int = 1024):
        self.model_context_length = model_context_length
        self.reserved_tokens = reserved_tokens  # For response
        self.encoder = tiktoken.get_encoding("cl100k_base")
        self.max_context_tokens = model_context_length - reserved_tokens
    
    def build(
        self,
        conversation_history: List[dict],
        retrieval_results: List[SearchResult],
        system_prompt: str,
        user_query: str,
    ) -> ContextPackage:
        """Build context package for LLM."""
        
        # 1. Format citations from retrieval results
        citations = self._format_citations(retrieval_results)
        
        # 2. Build retrieval context
        retrieval_context = self._build_retrieval_context(retrieval_results, citations)
        
        # 3. Build system prompt with retrieval context
        full_system_prompt = self._build_system_prompt(system_prompt, retrieval_context)
        
        # 4. Build message history within token budget
        messages = self._build_messages(
            conversation_history, 
            full_system_prompt, 
            user_query
        )
        
        # 5. Count tokens
        total_tokens = self._count_tokens(messages)
        
        return ContextPackage(
            system_prompt=full_system_prompt,
            messages=messages,
            citations=citations,
            total_tokens=total_tokens,
            retrieval_metadata={
                "num_chunks_retrieved": len(retrieval_results),
                "num_chunks_used": len(citations),
                "context_tokens": total_tokens,
            }
        )
    
    def _format_citations(self, results: List[SearchResult]) -> List[Citation]:
        citations = []
        for i, result in enumerate(results):
            # Generate citation ID (1-based for display)
            citation_id = i + 1
            
            preview = result.content[:200] + "..." if len(result.content) > 200 else result.content
            
            citations.append(Citation(
                chunk_id=result.chunk_id,
                document_id=result.document_id,
                document_name=result.metadata.get("document_name", "Unknown Document"),
                collection_name=result.metadata.get("collection_name", "Unknown Collection"),
                page_start=result.page_start,
                page_end=result.page_end,
                section_title=result.section_title,
                score=result.score,
                preview=preview,
            ))
        return citations
    
    def _build_retrieval_context(
        self, 
        results: List[SearchResult], 
        citations: List[Citation]
    ) -> str:
        """Build the retrieval context section."""
        if not results:
            return "No relevant documents found."
        
        parts = ["=== RETRIEVED KNOWLEDGE ==="]
        
        for citation in citations:
            parts.append(f"\n[Source {citation.chunk_id}]")
            parts.append(f"Document: {citation.document_name}")
            parts.append(f"Collection: {citation.collection_name}")
            if citation.page_start:
                parts.append(f"Page: {citation.page_start}")
            if citation.section_title:
                parts.append(f"Section: {citation.section_title}")
            parts.append(f"Relevance: {citation.score:.3f}")
            parts.append(f"Content: {citation.preview}")
            parts.append("---")
        
        parts.append("\n=== INSTRUCTIONS ===")
        parts.append("Answer the user's question using ONLY the retrieved knowledge above.")
        parts.append("Cite sources using [Source X] format where X is the source number.")
        parts.append("If the retrieved knowledge is insufficient, say so clearly.")
        parts.append("Do not use external knowledge or make up information.")
        
        return "\n".join(parts)
    
    def _build_system_prompt(self, base_prompt: str, retrieval_context: str) -> str:
        if not base_prompt:
            base_prompt = "You are a helpful AI assistant for Network Operations Centre tasks."
        return f"{base_prompt}\n\n{retrieval_context}"
    
    def _build_messages(
        self,
        history: List[dict],
        system_prompt: str,
        user_query: str,
    ) -> List[dict]:
        """Build message list within token budget."""
        messages = [{"role": "system", "content": system_prompt}]
        
        # Add history (most recent first, within budget)
        history_tokens = 0
        for msg in reversed(history):
            msg_tokens = self._count_tokens([msg])
            if history_tokens + msg_tokens > self.max_context_tokens * 0.3:  # Max 30% for history
                break
            messages.insert(1, msg)  # Insert after system
            history_tokens += msg_tokens
        
        # Add current user query
        messages.append({"role": "user", "content": user_query})
        
        return messages
    
    def _count_tokens(self, messages: List[dict]) -> int:
        total = 0
        for msg in messages:
            total += len(self.encoder.encode(msg.get("content", "")))
            total += 4  # Role overhead
        return total + 2  # Assistant prefix
```

## RAG Chat Endpoint

```python
# backend/chat/routes.py
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional, List
import uuid
import json
import asyncio

from backend.auth.dependencies import get_current_user, require_permission
from backend.chat.service import ChatService
from backend.inference.queue import InferenceQueue, JobPriority
from backend.db.models import User, Conversation, Message
from backend.config import Settings

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])

class ChatRequest(BaseModel):
    conversation_id: str
    message: str = Field(..., min_length=1, max_length=100000)
    model_id: Optional[str] = None
    collection_id: Optional[str] = None
    stream: bool = True
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(4096, ge=1, le=32768)

class ChatResponse(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    citations: List[dict] = []
    model_id: str
    usage: dict | None = None

class ChatChunk(BaseModel):
    id: str
    delta: str
    finish_reason: str | None
    citations: List[dict] | None = None
    usage: dict | None = None

@router.post("/completions", response_model=ChatResponse)
async def chat_completion(
    request: ChatRequest,
    current_user: User = Depends(require_permission(Permission.CHAT_CREATE)),
    chat_service: ChatService = Depends(),
    inference_queue: InferenceQueue = Depends(),
):
    """Send a chat message and get completion (streaming or sync)."""
    
    # Verify conversation ownership
    conversation = await chat_service.get_conversation(request.conversation_id)
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    if conversation.user_id != current_user.id:
        raise HTTPException(403, "Not authorized to access this conversation")
    
    # Save user message
    user_message = Message(
        id=str(uuid.uuid4()),
        conversation_id=request.conversation_id,
        role="user",
        content=request.message,
        created_at=datetime.utcnow(),
    )
    await chat_service.save_message(user_message)
    
    # Prepare generation
    generation_id = f"gen-{uuid.uuid4().hex[:12]}"
    
    async def generate():
        async for chunk in chat_service.generate_response(
            conversation=conversation,
            user_message=request.message,
            model_id=request.model_id,
            collection_id=request.collection_id,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            generation_id=generation_id,
        ):
            if request.stream:
                yield f"data: {chunk.model_dump_json()}\n\n"
            else:
                # Accumulate for sync response
                pass
        yield "data: [DONE]\n\n"
    
    if request.stream:
        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Generation-ID": generation_id,
            }
        )
    else:
        # Non-streaming: collect all chunks
        full_content = ""
        citations = []
        usage = None
        async for chunk in chat_service.generate_response(...):
            full_content += chunk.delta
            if chunk.citations:
                citations = chunk.citations
            if chunk.usage:
                usage = chunk.usage
        
        # Save assistant message
        assistant_message = Message(
            id=str(uuid.uuid4()),
            conversation_id=request.conversation_id,
            role="assistant",
            content=full_content,
            citations=json.dumps([c.model_dump() for c in citations]),
            model_id=conversation.model_id,
            token_count=usage.get("total_tokens") if usage else None,
            created_at=datetime.utcnow(),
        )
        await chat_service.save_message(assistant_message)
        
        return ChatResponse(
            id=assistant_message.id,
            conversation_id=request.conversation_id,
            role="assistant",
            content=full_content,
            citations=citations,
            model_id=conversation.model_id,
            usage=usage,
        )

@router.post("/stop/{generation_id}")
async def stop_generation(
    generation_id: str,
    current_user: User = Depends(get_current_user),
    inference_queue: InferenceQueue = Depends(),
):
    """Stop a running generation."""
    success = inference_queue.cancel(generation_id)
    if not success:
        raise HTTPException(404, "Generation not found or already completed")
    return {"stopped": True}
```

## Source Preview

```python
# backend/knowledge/preview.py
from dataclasses import dataclass
from typing | None
from pathlib import Path
import pypdf
import fitz  # PyMuPDF for rendering

@dataclass
class SourcePreview:
    document_id: str
    document_name: str
    collection_name: str
    chunk_id: str
    content: str
    page_start: int
    page_end: int
    section_title: str | None
    mime_type: str
    file_path: str
    # For PDF
    pdf_page_image: bytes | None = None  # Base64 encoded PNG
    highlight_rects: List[dict] | None = None

class SourcePreviewService:
    """Generate source previews for citations."""
    
    def __init__(self, knowledge_dir: Path):
        self.knowledge_dir = knowledge_dir
    
    async def get_preview(
        self,
        chunk_id: str,
        db: Database,
        context_chars: int = 500,
    ) -> SourcePreview:
        chunk = await db.chunks.get(chunk_id)
        if not chunk:
            raise ValueError("Chunk not found")
        
        document = await db.documents.get(chunk.document_id)
        collection = await db.collections.get(chunk.collection_id)
        
        file_path = self.knowledge_dir / document.filepath
        
        preview = SourcePreview(
            document_id=document.id,
            document_name=document.original_filename,
            collection_name=collection.name,
            chunk_id=chunk.id,
            content=chunk.content,
            page_start=chunk.page_start,
            page_end=chunk.page_end,
            section_title=chunk.section_title,
            mime_type=document.mime_type,
            file_path=str(file_path),
        )
        
        if document.mime_type == "application/pdf":
            await self._add_pdf_preview(preview, file_path, chunk)
        
        return preview
    
    async def _add_pdf_preview(
        self, 
        preview: SourcePreview, 
        file_path: Path, 
        chunk
    ):
        """Extract page image and highlight for PDF."""
        try:
            doc = fitz.open(file_path)
            page_num = max(1, chunk.page_start) - 1  # 0-indexed
            
            if page_num < len(doc):
                page = doc[page_num]
                
                # Render page at 2x zoom
                mat = fitz.Matrix(2, 2)
                pix = page.get_pixmap(matrix=mat)
                preview.pdf_page_image = pix.tobytes("png")
                
                # Search for chunk text on page to highlight
                text_instances = page.search_for(chunk.content[:100])
                if text_instances:
                    preview.highlight_rects = [
                        {"x0": r.x0, "y0": r.y0, "x1": r.x1, "y1": r.y1}
                        for r in text_instances[:5]
                    ]
            
            doc.close()
        except Exception as e:
            logger.warning(f"PDF preview failed: {e}")
```

---
*Generated during Phase 1 — Architecture*