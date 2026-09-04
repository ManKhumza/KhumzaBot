from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional, List
import uuid

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Collection, Model, User
from backend.retrieval.service import RetrievalService, RetrievalConfig

router = APIRouter(tags=["retrieval"])

class RetrievalRequest(BaseModel):
    query: str = Field(..., min_length=1)
    collectionIds: Optional[List[str]] = None
    topK: int = Field(10, ge=1, le=100)
    enableHybrid: bool = True
    hybridAlpha: float = Field(0.5, ge=0, le=1)
    enableReranking: bool = False
    rerankerModelId: Optional[str] = None

class RetrievalResult(BaseModel):
    chunkId: str
    documentId: str
    collectionId: str
    content: str
    score: float
    pageStart: int
    pageEnd: int
    sectionTitle: Optional[str]
    metadata: dict

@router.post("/search", response_model=List[RetrievalResult])
async def search(
    request: RetrievalRequest,
    http_request: Request,
    current_user: User = Depends(require_permission("knowledge:list")),
    db: Session = Depends(get_db),
):
    collections_query = db.query(Collection).filter(Collection.owner_id == current_user.id)
    if request.collectionIds:
        collections_query = collections_query.filter(Collection.id.in_(request.collectionIds))
    collections = collections_query.all()
    if not collections:
        return []
    model_ids = {collection.embedding_model_id for collection in collections}
    if len(model_ids) != 1:
        raise HTTPException(400, "Search collections must use the same embedding model")
    model = db.get(Model, next(iter(model_ids)))
    if model is None:
        raise HTTPException(409, "The collection embedding model is unavailable")
    manager = http_request.app.state.model_manager
    provider = manager.get_embedding_provider()
    if provider is None or manager.active_embedding_model_id != model.id:
        provider = await manager.load_model(model, "embedding")
    query_embedding = await provider.embed_single(request.query)
    matches = await http_request.app.state.ingestion.vector_store.search(
        query_embedding,
        collection_ids=[collection.id for collection in collections],
        top_k=request.topK,
    )
    return [RetrievalResult(
        chunkId=item.chunk_id, documentId=item.document_id,
        collectionId=item.collection_id, content=item.content,
        score=item.score, pageStart=item.page_start, pageEnd=item.page_end,
        sectionTitle=item.section_title, metadata=item.metadata,
    ) for item in matches]
