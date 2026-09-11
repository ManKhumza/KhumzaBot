from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional, List
import uuid

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Collection, Model, User
from backend.retrieval.service import RetrievalService, RetrievalConfig
from backend.retrieval.hybrid import keyword_search, merge_hybrid_results, prepare_semantic_query

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
    collection_names = [collection.name for collection in collections]
    semantic_query = prepare_semantic_query(request.query, collection_names)
    if hasattr(provider, "embed_query"):
        query_embedding = await provider.embed_query(semantic_query)
    else:
        query_embedding = await provider.embed_single(semantic_query)
    candidate_limit = min(100, max(request.topK * 4, request.topK))
    vector_matches = await http_request.app.state.ingestion.vector_store.search(
        query_embedding,
        collection_ids=[collection.id for collection in collections],
        top_k=candidate_limit,
    )
    keyword_matches = keyword_search(
        db,
        request.query,
        [collection.id for collection in collections],
        top_k=candidate_limit,
        collection_names=collection_names,
    ) if request.enableHybrid else []
    matches = merge_hybrid_results(
        vector_matches,
        keyword_matches,
        minimum_vector_score=0.0,
        top_k=request.topK,
        vector_weight=request.hybridAlpha if request.enableHybrid else 1.0,
    )
    return [RetrievalResult(
        chunkId=item.chunk_id, documentId=item.document_id,
        collectionId=item.collection_id, content=item.content,
        score=item.score, pageStart=item.page_start, pageEnd=item.page_end,
        sectionTitle=item.section_title, metadata=item.metadata,
    ) for item in matches]
