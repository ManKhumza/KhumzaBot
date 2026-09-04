import asyncio
import hashlib
import magic
from pathlib import Path
from dataclasses import dataclass
from typing import AsyncIterator, Optional
from enum import Enum
import uuid
import json

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
    progress: float
    message: str
    chunks_processed: int = 0
    total_chunks: int = 0

class IngestionPipeline:
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
        doc = await self.db.documents.get(document_id)
        if not doc:
            raise ValueError(f"Document {document_id} not found")
        
        collection = await self.db.collections.get(doc.collection_id)
        if not collection:
            raise ValueError(f"Collection {doc.collection_id} not found")
        
        embedding_model = await self.db.models.get(collection.embedding_model_id)
        if not embedding_model:
            raise ValueError(f"Embedding model {collection.embedding_model_id} not found")
        
        embedding_provider = self.model_manager.get_embedding_provider()
        if not embedding_provider or self.model_manager.active_embedding_model_id != embedding_model.id:
            await self.model_manager.load_model(embedding_model.id, "embedding")
            embedding_provider = self.model_manager.get_embedding_provider()
        
        try:
            await self._update_status(doc, DocumentStatus.VALIDATING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.VALIDATING, 0.05, "Validating file"))
            
            file_path = self.knowledge_dir / doc.filepath
            if not file_path.exists():
                raise FileNotFoundError(f"Source file not found: {file_path}")
            
            actual_hash = await self._compute_hash(file_path)
            if actual_hash != doc.file_hash:
                raise ValueError("File hash mismatch - file may have been modified")
            
            await self._update_status(doc, DocumentStatus.PARSING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.PARSING, 0.15, "Extracting text"))
            
            parse_result = await parse_document(file_path, doc.mime_type)
            doc.page_count = parse_result.page_count
            doc.language = parse_result.language
            await self.db.documents.update(doc)
            
            extracted_path = self.knowledge_dir / "collections" / doc.collection_id / "extracted" / f"{doc.id}.jsonl"
            extracted_path.parent.mkdir(parents=True, exist_ok=True)
            with open(extracted_path, "w", encoding="utf-8") as f:
                for page in parse_result.pages:
                    f.write(json.dumps({
                        "page": page.page_num,
                        "text": page.text,
                        "metadata": page.metadata,
                    }) + "\n")
            
            await self._update_status(doc, DocumentStatus.CHUNKING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.CHUNKING, 0.30, "Chunking text"))
            
            chunk_config = ChunkConfig(**json.loads(collection.chunking_config))
            chunks = chunk_text(parse_result.full_text, chunk_config)
            
            await self._update_status(doc, DocumentStatus.EMBEDDING)
            
            chunk_records = []
            for i, chunk in enumerate(chunks):
                progress = 0.30 + (0.40 * i / len(chunks))
                self._emit_progress(IngestionProgress(
                    document_id, DocumentStatus.EMBEDDING, progress, 
                    f"Embedding chunk {i+1}/{len(chunks)}", i, len(chunks)
                ))
                
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
                    chunk_metadata=json.dumps(chunk.metadata),
                )
                chunk_records.append((chunk_record, embedding))
            
            await self._update_status(doc, DocumentStatus.INDEXING)
            self._emit_progress(IngestionProgress(document_id, DocumentStatus.INDEXING, 0.80, "Indexing vectors"))
            
            for chunk_record, _ in chunk_records:
                await self.db.chunks.create(chunk_record)
            
            await self.vector_store.add_chunks(chunk_records)
            
            doc.chunk_count = len(chunks)
            doc.embedded_model_id = embedding_model.id
            doc.embedded_config = collection.embedding_config
            doc.status = DocumentStatus.READY
            doc.processed_at = datetime.utcnow()
            await self.db.documents.update(doc)
            
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