from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional, List
import uuid
import shutil
import aiofiles
from pathlib import Path
import logging
import hashlib
import psutil
from datetime import datetime

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Chunk, Collection, Conversation, Document, CollectionPermission, IngestionJob, Model, User
from backend.config import get_settings
from backend.db.database import create_db_engine
from backend.inference.lifecycle import ModelLifecycleManager
from backend.retrieval.vector_store import VectorStore
from backend.retrieval.hybrid import keyword_search, merge_hybrid_results, prepare_semantic_query
from backend.documents.service import DocumentService

router = APIRouter(tags=["knowledge"])
logger = logging.getLogger(__name__)

class CollectionResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    ownerId: str
    visibility: str
    embeddingModelId: str
    embeddingConfig: dict
    chunkingConfig: dict
    documentCount: int
    chunkCount: int
    totalSizeBytes: int
    status: str
    createdAt: str
    updatedAt: str
    reindexRequired: bool
    reindexReason: Optional[str]
    permission: Optional[str] = None

class CreateCollectionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    embeddingModelId: str
    embeddingConfig: dict = Field(default_factory=dict)
    chunkingConfig: dict = Field(default_factory=dict)

class DocumentPathsRequest(BaseModel):
    filePaths: List[str] = Field(..., min_length=1, max_length=100)

class DocumentResponse(BaseModel):
    id: str
    collectionId: str
    filename: str
    originalFilename: str
    filepath: str
    mimeType: str
    sizeBytes: int
    fileHash: str
    pageCount: Optional[int]
    language: Optional[str]
    status: str
    errorMessage: Optional[str]
    chunkCount: int
    embeddedModelId: Optional[str]
    embeddedConfig: Optional[dict]
    uploadedBy: str
    uploadedAt: str
    processedAt: Optional[str]
    disabledAt: Optional[str]
    ingestionStage: Optional[str]
    ingestionProgress: Optional[int]

class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    collectionIds: Optional[List[str]] = None
    topK: int = Field(10, ge=1, le=100)
    enableHybrid: bool = True
    hybridAlpha: float = Field(0.5, ge=0, le=1)
    enableReranking: bool = False

class SearchResultResponse(BaseModel):
    chunkId: str
    documentId: str
    collectionId: str
    content: str
    score: float
    pageStart: int
    pageEnd: int
    sectionTitle: Optional[str]
    metadata: dict


COPY_BUFFER_BYTES = 1024 * 1024
SUPPORTED_DOCUMENT_EXTENSIONS = {'.txt', '.md', '.pdf', '.docx', '.csv', '.html', '.htm'}
MEMORY_MULTIPLIERS = {
    '.txt': 4, '.md': 4, '.csv': 5, '.html': 6, '.htm': 6,
    '.pdf': 10, '.docx': 8,
}


async def copy_file_with_hash(source: Path, destination: Path) -> tuple[str, int]:
    """Copy without loading the entire source into memory."""
    digest = hashlib.sha256()
    size = 0
    async with aiofiles.open(source, "rb") as source_file, aiofiles.open(destination, "wb") as destination_file:
        while chunk := await source_file.read(COPY_BUFFER_BYTES):
            digest.update(chunk)
            size += len(chunk)
            await destination_file.write(chunk)
    return digest.hexdigest(), size

@router.get("/collections", response_model=List[CollectionResponse])
async def list_collections(
    current_user: User = Depends(require_permission("knowledge:list")),
    db: Session = Depends(get_db)
):
    collections = db.query(Collection).filter(Collection.owner_id == current_user.id).all()
    return [collection_to_response(c, "admin") for c in collections]

@router.post("/collections", response_model=CollectionResponse)
async def create_collection(
    request: CreateCollectionRequest,
    current_user: User = Depends(require_permission("knowledge:create")),
    db: Session = Depends(get_db)
):
    settings = get_settings()
    
    embedding_config = {
        "chunkSize": request.embeddingConfig.get("chunkSize", settings.default_chunk_size),
        "chunkOverlap": request.embeddingConfig.get("chunkOverlap", settings.default_chunk_overlap),
        "topK": request.embeddingConfig.get("topK", settings.default_top_k),
        "hybridAlpha": request.embeddingConfig.get("hybridAlpha", settings.hybrid_alpha),
        "enableReranking": request.embeddingConfig.get("enableReranking", settings.enable_reranking),
    }
    
    chunking_config = {
        "chunkSize": request.chunkingConfig.get("chunkSize", settings.default_chunk_size),
        "chunkOverlap": request.chunkingConfig.get("chunkOverlap", settings.default_chunk_overlap),
        "minChunkSize": request.chunkingConfig.get("minChunkSize", 50),
        "respectBoundaries": request.chunkingConfig.get("respectBoundaries", True),
    }
    
    collection = Collection(
        id=str(uuid.uuid4()),
        name=request.name,
        description=request.description,
        owner_id=current_user.id,
        embedding_model_id=request.embeddingModelId,
        embedding_config=embedding_config,
        chunking_config=chunking_config,
    )
    db.add(collection)
    db.commit()
    db.refresh(collection)
    
    perm = CollectionPermission(
        id=str(uuid.uuid4()),
        collection_id=collection.id,
        user_id=current_user.id,
        permission="admin",
        granted_by=current_user.id,
    )
    db.add(perm)
    db.commit()
    
    return collection_to_response(collection, "admin")

@router.delete("/collections/{collection_id}")
async def delete_collection(
    collection_id: str,
    http_request: Request,
    current_user: User = Depends(require_permission("knowledge:delete")),
    db: Session = Depends(get_db)
):
    collection = db.query(Collection).filter(Collection.id == collection_id).first()
    if not collection:
        raise HTTPException(404, "Collection not found")
    
    perm = db.query(CollectionPermission).filter(
        CollectionPermission.collection_id == collection_id,
        CollectionPermission.user_id == current_user.id,
        CollectionPermission.permission == "admin"
    ).first()
    
    if not perm and current_user.id != collection.owner_id:
        raise HTTPException(403, "Not authorized to delete this collection")

    settings = get_settings()
    collections_root = (Path(settings.knowledge_dir) / "collections").resolve()
    source_root = (collections_root / collection.id).resolve()
    try:
        source_root.relative_to(collections_root)
    except ValueError as exc:
        raise HTTPException(500, "Knowledge source path is outside the configured storage directory") from exc

    coordinator = http_request.app.state.ingestion
    async with coordinator.mutation_lock:
        # Conversations must not retain a reference to a source that no longer
        # exists. Commit the relational deletion before using the vector store's
        # separate SQLite connection, otherwise SQLite's write lock would deadlock.
        db.query(Conversation).filter(Conversation.collection_id == collection.id).update(
            {Conversation.collection_id: None}, synchronize_session=False
        )
        db.delete(collection)
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.exception("Could not delete knowledge source %s", collection.id)
            raise HTTPException(500, "Could not delete the knowledge source") from exc

        cleanup_warning = None
        try:
            await coordinator.vector_store.delete_collection(collection.id)
        except Exception:
            cleanup_warning = "The source was deleted, but unused vector data could not be cleaned up."
            logger.exception("Could not remove vectors for deleted knowledge source %s", collection.id)
        if source_root.exists():
            try:
                shutil.rmtree(source_root)
            except OSError:
                cleanup_warning = "The source was deleted, but some unused local files could not be cleaned up."
                logger.exception("Could not remove files for deleted knowledge source %s", collection.id)
    return {"success": True, "warning": cleanup_warning}

@router.post("/collections/{collection_id}/documents", response_model=List[DocumentResponse])
async def upload_documents(
    collection_id: str,
    request: DocumentPathsRequest,
    http_request: Request,
    current_user: User = Depends(require_permission("knowledge:write")),
    db: Session = Depends(get_db)
):
    collection = db.query(Collection).filter(Collection.id == collection_id).first()
    if not collection:
        raise HTTPException(404, "Collection not found")
    
    perm = db.query(CollectionPermission).filter(
        CollectionPermission.collection_id == collection_id,
        CollectionPermission.user_id == current_user.id,
        CollectionPermission.permission.in_(["write", "admin"])
    ).first()
    
    if not perm and current_user.id != collection.owner_id:
        raise HTTPException(403, "Not authorized to upload to this collection")
    
    settings = get_settings()
    results = []
    job_ids = []
    max_document_bytes = max(1, settings.max_document_size_mb) * 1024 * 1024
    sources: list[tuple[Path, int]] = []
    available_memory = psutil.virtual_memory().available
    memory_reserve = 512 * 1024 * 1024
    memory_budget = max(0, available_memory - memory_reserve)

    for file_path in request.filePaths:
        try:
            source = Path(file_path).expanduser().resolve(strict=True)
            size = source.stat().st_size
        except (OSError, RuntimeError) as exc:
            raise HTTPException(400, f"Could not access document: {file_path}") from exc
        if not source.is_file():
            raise HTTPException(400, f"Document is not a file: {source.name}")
        if source.suffix.lower() not in SUPPORTED_DOCUMENT_EXTENSIONS:
            raise HTTPException(415, f"Unsupported document type: {source.suffix or source.name}")
        if size <= 0:
            raise HTTPException(400, f"Document is empty: {source.name}")
        if size > max_document_bytes:
            raise HTTPException(
                413,
                f"{source.name} is larger than the {settings.max_document_size_mb} MB document limit",
            )
        estimated_peak_memory = size * MEMORY_MULTIPLIERS[source.suffix.lower()]
        if estimated_peak_memory > memory_budget:
            estimated_mb = max(1, estimated_peak_memory // (1024 * 1024))
            available_mb = max(0, available_memory // (1024 * 1024))
            budget_mb = memory_budget // (1024 * 1024)
            reserve_mb = memory_reserve // (1024 * 1024)
            raise HTTPException(
                413,
                f"{source.name} may need about {estimated_mb} MB of working memory, "
                f"but only {budget_mb} MB is available for ingestion "
                f"({available_mb} MB free; {reserve_mb} MB reserved). "
                "Close other applications or unload a chat model in Models, then try again.",
            )
        sources.append((source, size))

    collection_dir = Path(settings.knowledge_dir) / "collections" / collection_id / "source"
    collection_dir.mkdir(parents=True, exist_ok=True)
    required_bytes = sum(size for _, size in sources) * 2
    if required_bytes > shutil.disk_usage(collection_dir).free:
        raise HTTPException(507, "Not enough free disk space to ingest the selected documents")

    duplicate_names: list[str] = []
    for source, _ in sources:
        ext = source.suffix.lower()
        
        dest = collection_dir / source.name
        counter = 1
        while dest.exists():
            dest = collection_dir / f"{source.stem}_{counter}{ext}"
            counter += 1

        try:
            file_hash, size_bytes = await copy_file_with_hash(source, dest)
        except OSError as exc:
            dest.unlink(missing_ok=True)
            raise HTTPException(500, f"Could not copy document: {source.name}") from exc
        
        existing = db.query(Document).filter(
            Document.collection_id == collection_id,
            Document.file_hash == file_hash,
        ).first()
        if existing:
            dest.unlink(missing_ok=True)
            duplicate_names.append(source.name)
            continue
        
        mime_types = {
            '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
        }
        document = Document(
            id=str(uuid.uuid4()),
            collection_id=collection_id,
            filename=dest.name,
            original_filename=source.name,
            filepath=str(dest.relative_to(settings.knowledge_dir)),
            mime_type=mime_types[ext],
            size_bytes=size_bytes,
            file_hash=file_hash,
            uploaded_by=current_user.id,
            status="queued",
        )
        db.add(document)
        job = IngestionJob(
            id=str(uuid.uuid4()), document_id=document.id, collection_id=collection_id,
            status="pending", priority=4, current_stage="queued", progress=0,
            created_at=datetime.utcnow(),
        )
        db.add(job)
        job_ids.append(job.id)
        results.append(document)

    if not results:
        detail = "All selected documents are already in this collection" if duplicate_names else "No documents were accepted"
        raise HTTPException(409 if duplicate_names else 400, detail)

    db.commit()
    for doc in results:
        db.refresh(doc)
    for job_id in job_ids:
        await http_request.app.state.ingestion.enqueue(job_id)
    
    return [document_to_response(d) for d in results]

@router.get("/collections/{collection_id}/documents", response_model=List[DocumentResponse])
async def list_documents(
    collection_id: str,
    current_user: User = Depends(require_permission("knowledge:list")),
    db: Session = Depends(get_db)
):
    documents = db.query(Document).filter(Document.collection_id == collection_id).all()
    return [document_to_response(d) for d in documents]


@router.get("/documents/{document_id}/status")
async def document_status(
    document_id: str,
    current_user: User = Depends(require_permission("knowledge:list")),
    db: Session = Depends(get_db),
):
    """Return the latest durable ingestion state for an accessible document."""
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(404, "Document not found")
    permission = db.query(CollectionPermission).filter(
        CollectionPermission.collection_id == document.collection_id,
        CollectionPermission.user_id == current_user.id,
        CollectionPermission.permission.in_(["read", "write", "admin"]),
    ).first()
    if permission is None and current_user.id != document.collection.owner_id:
        raise HTTPException(403, "Not authorized to view this document")
    job = db.query(IngestionJob).filter(
        IngestionJob.document_id == document_id
    ).order_by(IngestionJob.created_at.desc()).first()
    return {
        "documentId": document.id,
        "filename": document.original_filename or document.filename,
        "status": job.status if job else document.status,
        "currentStage": job.current_stage if job else document.status,
        "progress": job.progress if job else (100 if document.status == "ready" else 0),
        "errorMessage": job.error_message if job else document.error_message,
    }

@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    http_request: Request,
    current_user: User = Depends(require_permission("knowledge:write")),
    db: Session = Depends(get_db)
):
    document = db.query(Document).filter(Document.id == document_id).first()
    if not document:
        raise HTTPException(404, "Document not found")
    
    settings = get_settings()
    perm = db.query(CollectionPermission).filter(
        CollectionPermission.collection_id == document.collection_id,
        CollectionPermission.user_id == current_user.id,
        CollectionPermission.permission.in_(["write", "admin"])
    ).first()
    
    if not perm and current_user.id != document.collection.owner_id:
        raise HTTPException(403, "Not authorized to delete this document")

    knowledge_root = Path(settings.knowledge_dir).resolve()
    source_path = (knowledge_root / document.filepath).resolve()
    try:
        source_path.relative_to(knowledge_root)
    except ValueError as exc:
        raise HTTPException(500, "Document path is outside the configured knowledge directory") from exc

    chunk_ids = [row[0] for row in db.query(Chunk.id).filter(Chunk.document_id == document.id).all()]
    coordinator = http_request.app.state.ingestion
    async with coordinator.mutation_lock:
        db.delete(document)
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.exception("Could not delete knowledge document %s", document.id)
            raise HTTPException(500, "Could not delete the knowledge document") from exc

        cleanup_warning = None
        try:
            await coordinator.vector_store.delete_chunks(chunk_ids)
        except Exception:
            cleanup_warning = "The document was deleted, but unused vector data could not be cleaned up."
            logger.exception("Could not remove vectors for deleted document %s", document.id)
        try:
            source_path.unlink(missing_ok=True)
        except OSError:
            cleanup_warning = "The document was deleted, but its unused source file could not be cleaned up."
            logger.exception("Could not remove the source file for deleted document %s", document.id)
    return {"success": True, "warning": cleanup_warning}

@router.post("/documents/{document_id}/reprocess")
async def reprocess_document(
    document_id: str,
    request: Request,
    current_user: User = Depends(require_permission("knowledge:write")),
    db: Session = Depends(get_db)
):
    document = db.query(Document).filter(Document.id == document_id).first()
    if not document:
        raise HTTPException(404, "Document not found")
    
    perm = db.query(CollectionPermission).filter(
        CollectionPermission.collection_id == document.collection_id,
        CollectionPermission.user_id == current_user.id,
        CollectionPermission.permission.in_(["write", "admin"])
    ).first()
    
    if not perm and current_user.id != document.collection.owner_id:
        raise HTTPException(403, "Not authorized to reprocess this document")
    
    job_id = await request.app.state.ingestion.enqueue_document(document_id, priority=3)
    return {"success": True, "jobId": job_id}

@router.post("/search", response_model=List[SearchResultResponse])
async def search_knowledge(
    request: SearchRequest,
    http_request: Request,
    current_user: User = Depends(require_permission("knowledge:list")),
    db: Session = Depends(get_db),
):
    query = db.query(Collection).filter(Collection.owner_id == current_user.id)
    if request.collectionIds:
        query = query.filter(Collection.id.in_(request.collectionIds))
    collections = query.all()
    if not collections:
        return []
    model_ids = {c.embedding_model_id for c in collections}
    if len(model_ids) != 1:
        raise HTTPException(400, "Search collections must use the same embedding model")
    model = db.get(Model, next(iter(model_ids)))
    if model is None:
        raise HTTPException(409, "The collection embedding model is unavailable")
    manager = http_request.app.state.model_manager
    provider = manager.get_embedding_provider()
    if provider is None or manager.active_embedding_model_id != model.id:
        provider = await manager.load_model(model, "embedding")
    collection_names = [collection.name for collection in collections]
    semantic_query = prepare_semantic_query(request.query, collection_names)
    if hasattr(provider, "embed_query"):
        embedding = await provider.embed_query(semantic_query)
    else:
        embedding = await provider.embed_single(semantic_query)
    candidate_limit = min(100, max(request.topK * 4, request.topK))
    vector_results = await http_request.app.state.ingestion.vector_store.search(
        embedding, collection_ids=[c.id for c in collections], top_k=candidate_limit
    )
    keyword_results = keyword_search(
        db,
        request.query,
        [collection.id for collection in collections],
        top_k=candidate_limit,
        collection_names=collection_names,
    ) if request.enableHybrid else []
    results = merge_hybrid_results(
        vector_results,
        keyword_results,
        minimum_vector_score=0.0,
        top_k=request.topK,
        vector_weight=request.hybridAlpha if request.enableHybrid else 1.0,
    )
    return [SearchResultResponse(
        chunkId=r.chunk_id, documentId=r.document_id, collectionId=r.collection_id,
        content=r.content, score=r.score, pageStart=r.page_start,
        pageEnd=r.page_end, sectionTitle=r.section_title, metadata=r.metadata,
    ) for r in results]

def collection_to_response(collection: Collection, permission: str) -> CollectionResponse:
    return CollectionResponse(
        id=collection.id,
        name=collection.name,
        description=collection.description,
        ownerId=collection.owner_id,
        visibility=collection.visibility,
        embeddingModelId=collection.embedding_model_id,
        embeddingConfig=collection.embedding_config or {},
        chunkingConfig=collection.chunking_config or {},
        documentCount=collection.document_count,
        chunkCount=collection.chunk_count,
        totalSizeBytes=collection.total_size_bytes,
        status=collection.status,
        createdAt=collection.created_at.isoformat() if collection.created_at else "",
        updatedAt=collection.updated_at.isoformat() if collection.updated_at else "",
        reindexRequired=collection.reindex_required,
        reindexReason=collection.reindex_reason,
        permission=permission,
    )

def document_to_response(doc: Document) -> DocumentResponse:
    latest_job = max(
        doc.ingestion_jobs,
        key=lambda job: job.created_at or datetime.min,
        default=None,
    )
    return DocumentResponse(
        id=doc.id,
        collectionId=doc.collection_id,
        filename=doc.filename,
        originalFilename=doc.original_filename,
        filepath=doc.filepath,
        mimeType=doc.mime_type,
        sizeBytes=doc.size_bytes,
        fileHash=doc.file_hash,
        pageCount=doc.page_count,
        language=doc.language,
        status=doc.status,
        errorMessage=doc.error_message,
        chunkCount=doc.chunk_count,
        embeddedModelId=doc.embedded_model_id,
        embeddedConfig=doc.embedded_config,
        uploadedBy=doc.uploaded_by,
        uploadedAt=doc.uploaded_at.isoformat() if doc.uploaded_at else "",
        processedAt=doc.processed_at.isoformat() if doc.processed_at else None,
        disabledAt=doc.disabled_at.isoformat() if doc.disabled_at else None,
        ingestionStage=latest_job.current_stage if latest_job else None,
        ingestionProgress=latest_job.progress if latest_job else None,
    )
