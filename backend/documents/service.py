import asyncio
import logging
from pathlib import Path
from typing import Optional
from dataclasses import dataclass
from enum import Enum

from backend.config import get_settings
from backend.db.database import Database
from backend.inference.lifecycle import ModelLifecycleManager
from backend.retrieval.vector_store import VectorStore
from backend.documents.pipeline import IngestionPipeline, DocumentStatus

logger = logging.getLogger(__name__)

class JobPriority(int, Enum):
    INTERACTIVE_CHAT = 1
    KNOWLEDGE_RETRIEVAL = 2
    SMALL_EMBEDDING = 3
    BULK_INGESTION = 4
    MAINTENANCE = 5

@dataclass
class IngestionJob:
    id: str
    document_id: str
    collection_id: str
    priority: JobPriority
    status: str
    current_stage: Optional[str]
    progress: float

class DocumentService:
    def __init__(
        self,
        db: Database,
        model_manager: ModelLifecycleManager,
        vector_store: VectorStore,
    ):
        self.db = db
        self.model_manager = model_manager
        self.vector_store = vector_store
        self.settings = get_settings()
        self.knowledge_dir = Path(self.settings.knowledge_dir)
        self.knowledge_dir.mkdir(parents=True, exist_ok=True)
        
        self.pipeline = IngestionPipeline(
            db=db,
            model_manager=model_manager,
            vector_store=vector_store,
            knowledge_dir=self.knowledge_dir,
        )
        
        self._job_queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._worker_task: Optional[asyncio.Task] = None
        self._running = False
    
    async def start(self):
        self._running = True
        self._worker_task = asyncio.create_task(self._process_jobs())
        logger.info("Document ingestion worker started")
    
    async def stop(self):
        self._running = False
        if self._worker_task:
            await self._worker_task
        logger.info("Document ingestion worker stopped")
    
    async def queue_document(self, document_id: str, priority: JobPriority = JobPriority.BULK_INGESTION):
        await self._job_queue.put((priority.value, document_id))
    
    async def _process_jobs(self):
        while self._running:
            try:
                priority, document_id = await asyncio.wait_for(
                    self._job_queue.get(), timeout=1.0
                )
                
                doc = await self.db.documents.get(document_id)
                if not doc:
                    logger.warning(f"Document {document_id} not found, skipping")
                    continue
                
                if doc.status not in [DocumentStatus.QUEUED, DocumentStatus.FAILED]:
                    logger.info(f"Document {document_id} already processed, skipping")
                    continue
                
                try:
                    await self.pipeline.process_document(document_id)
                except Exception as e:
                    logger.error(f"Failed to process document {document_id}: {e}")
                    
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.error(f"Job processor error: {e}")
                await asyncio.sleep(1)
    
    async def reprocess_document(self, document_id: str):
        doc = await self.db.documents.get(document_id)
        if not doc:
            raise ValueError("Document not found")
        
        # Reset status
        doc.status = DocumentStatus.QUEUED
        doc.error_message = None
        await self.db.documents.update(doc)
        
        # Queue for reprocessing
        await self.queue_document(document_id, JobPriority.SMALL_EMBEDDING)
    
    async def delete_document(self, document_id: str):
        doc = await self.db.documents.get(document_id)
        if not doc:
            raise ValueError("Document not found")
        
        # Delete chunks from vector store
        chunks = await self.db.chunks.list_by_document(document_id)
        chunk_ids = [c.id for c in chunks]
        if chunk_ids:
            await self.vector_store.delete_chunks(chunk_ids)
        
        # Delete source file
        file_path = Path(self.settings.knowledge_dir) / doc.filepath
        try:
            file_path.unlink(missing_ok=True)
        except:
            pass
        
        # Delete extracted text
        extracted_path = self.knowledge_dir / "collections" / doc.collection_id / "extracted" / f"{doc.id}.jsonl"
        try:
            extracted_path.unlink(missing_ok=True)
        except:
            pass
        
        # Delete from database (cascades to chunks and ingestion_jobs)
        await self.db.documents.delete(document_id)
        
        # Update collection stats
        await self._update_collection_stats(doc.collection_id)
    
    async def _update_collection_stats(self, collection_id: str):
        stats = await self.db.chunks.get_collection_stats(collection_id)
        await self.db.collections.update_stats(collection_id, stats)