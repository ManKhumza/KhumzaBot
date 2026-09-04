"""Durable, single-worker document ingestion for the desktop application."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import sessionmaker

from backend.config import Settings
from backend.db.models import Chunk, Collection, Document, IngestionJob, Model
from backend.documents.chunking import ChunkConfig, chunk_text
from backend.documents.parsers import parse_document
from backend.inference.lifecycle import ModelLifecycleManager
from backend.retrieval.vector_store import ChunkWithEmbedding, VectorStore

logger = logging.getLogger(__name__)


class IngestionCoordinator:
    """Runs durable ingestion jobs and recovers pending work after restart."""

    def __init__(
        self,
        settings: Settings,
        session_factory: sessionmaker,
        model_manager: ModelLifecycleManager,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.model_manager = model_manager
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.worker: asyncio.Task | None = None
        self.stopping = False
        self.vector_store = VectorStore(settings.database_url, embedding_dim=384)

    async def start(self) -> None:
        self.stopping = False
        with self.session_factory() as db:
            interrupted = db.query(IngestionJob).filter(
                IngestionJob.status.in_(["pending", "running"])
            ).all()
            for job in interrupted:
                job.status = "pending"
                job.current_stage = "queued"
                job.error_message = None
                job.started_at = None
                await self.queue.put(job.id)
            db.commit()
        self.worker = asyncio.create_task(self._run(), name="document-ingestion-worker")

    async def stop(self) -> None:
        self.stopping = True
        if self.worker:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
            self.worker = None
        self.vector_store.close()

    async def enqueue(self, job_id: str) -> None:
        await self.queue.put(job_id)

    async def enqueue_document(self, document_id: str, priority: int = 4) -> str:
        with self.session_factory() as db:
            document = db.get(Document, document_id)
            if document is None:
                raise ValueError("Document not found")
            existing = db.query(IngestionJob).filter(
                IngestionJob.document_id == document_id,
                IngestionJob.status.in_(["pending", "running"]),
            ).first()
            if existing:
                return existing.id
            job = IngestionJob(
                id=str(uuid.uuid4()),
                document_id=document.id,
                collection_id=document.collection_id,
                status="pending",
                priority=priority,
                current_stage="queued",
                progress=0,
                created_at=datetime.utcnow(),
            )
            document.status = "queued"
            document.error_message = None
            db.add(job)
            db.commit()
            job_id = job.id
        await self.enqueue(job_id)
        return job_id

    async def _run(self) -> None:
        while not self.stopping:
            job_id = await self.queue.get()
            try:
                await self._process(job_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unhandled ingestion failure for job %s", job_id)
            finally:
                self.queue.task_done()

    async def _process(self, job_id: str) -> None:
        with self.session_factory() as db:
            job = db.get(IngestionJob, job_id)
            if job is None or job.status == "cancelled":
                return
            document = db.get(Document, job.document_id)
            collection = db.get(Collection, job.collection_id)
            if document is None or collection is None:
                job.status = "failed"
                job.error_message = "Document or collection no longer exists"
                job.completed_at = datetime.utcnow()
                db.commit()
                return
            job.status = "running"
            job.current_stage = "parsing"
            job.progress = 5
            job.started_at = datetime.utcnow()
            document.status = "parsing"
            db.commit()

            try:
                source = Path(self.settings.knowledge_dir) / document.filepath
                if not source.is_file():
                    raise FileNotFoundError("The uploaded source file is missing")
                mime = document.mime_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
                parsed = await parse_document(source, mime)
                if not parsed.full_text.strip():
                    raise ValueError("No extractable text was found in the document")

                document.page_count = parsed.page_count
                document.language = parsed.language
                document.status = "chunking"
                job.current_stage = "chunking"
                job.progress = 20
                db.commit()

                raw_cfg = collection.chunking_config or {}
                chunks = chunk_text(parsed.full_text, ChunkConfig(
                    chunk_size=int(raw_cfg.get("chunkSize", 512)),
                    chunk_overlap=int(raw_cfg.get("chunkOverlap", 50)),
                    min_chunk_size=max(1, int(raw_cfg.get("minChunkSize", 20))),
                    respect_boundaries=bool(raw_cfg.get("respectBoundaries", True)),
                ))
                if not chunks:
                    raise ValueError("Document text was too short to create a searchable chunk")

                embedding_model = db.get(Model, collection.embedding_model_id)
                if embedding_model is None or embedding_model.role != "embedding":
                    raise ValueError("The collection embedding model is unavailable")
                provider = self.model_manager.get_embedding_provider()
                if provider is None or self.model_manager.active_embedding_model_id != embedding_model.id:
                    provider = await self.model_manager.load_model(embedding_model, "embedding")

                document.status = "embedding"
                job.current_stage = "embedding"
                job.progress = 30
                db.commit()

                old_ids = [row[0] for row in db.query(Chunk.id).filter(Chunk.document_id == document.id).all()]
                if old_ids:
                    await self.vector_store.delete_chunks(old_ids)
                db.query(Chunk).filter(Chunk.document_id == document.id).delete(synchronize_session=False)

                indexed: list[ChunkWithEmbedding] = []
                for index, item in enumerate(chunks):
                    latest = db.get(IngestionJob, job_id)
                    if latest is None or latest.status == "cancelled":
                        db.rollback()
                        return
                    embedding = await provider.embed_single(item.content)
                    if len(embedding) != self.vector_store.embedding_dim:
                        raise ValueError(
                            f"Embedding dimension mismatch: expected {self.vector_store.embedding_dim}, got {len(embedding)}"
                        )
                    record = Chunk(
                        id=str(uuid.uuid4()), document_id=document.id,
                        collection_id=document.collection_id, chunk_index=index,
                        content=item.content, token_count=item.token_count,
                        page_start=item.page_start, page_end=item.page_end,
                        section_title=item.section_title, chunk_metadata=item.metadata or {},
                    )
                    db.add(record)
                    indexed.append(ChunkWithEmbedding(record, embedding))
                    job.progress = 30 + int(50 * (index + 1) / len(chunks))
                    db.flush()

                job.current_stage = "indexing"
                document.status = "indexing"
                job.progress = 85
                db.commit()
                await self.vector_store.add_chunks(indexed)

                document = db.get(Document, document.id)
                job = db.get(IngestionJob, job_id)
                document.status = "ready"
                document.chunk_count = len(indexed)
                document.embedded_model_id = embedding_model.id
                document.embedded_config = collection.embedding_config or {}
                document.processed_at = datetime.utcnow()
                document.error_message = None
                job.status = "completed"
                job.current_stage = "ready"
                job.progress = 100
                job.completed_at = datetime.utcnow()
                collection.document_count = db.query(Document).filter(
                    Document.collection_id == collection.id, Document.status == "ready"
                ).count()
                collection.chunk_count = db.query(Chunk).filter(Chunk.collection_id == collection.id).count()
                collection.total_size_bytes = sum(
                    row[0] or 0 for row in db.query(Document.size_bytes).filter(Document.collection_id == collection.id)
                )
                db.commit()
            except Exception as exc:
                db.rollback()
                job = db.get(IngestionJob, job_id)
                document = db.get(Document, job.document_id) if job else None
                message = str(exc)[:2000]
                if job:
                    job.status = "failed"
                    job.current_stage = "failed"
                    job.error_message = message
                    job.completed_at = datetime.utcnow()
                if document:
                    document.status = "failed"
                    document.error_message = message
                db.commit()
                logger.exception("Ingestion job %s failed", job_id)
