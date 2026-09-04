import asyncio
from dataclasses import dataclass
from typing import List, Optional, Set
import uuid
import json

from backend.retrieval.vector_store import VectorStore, SearchResult
from backend.db.database import Database
from backend.auth.dependencies import check_permission, Permission

@dataclass
class RetrievalConfig:
    top_k: int = 10
    vector_weight: float = 0.5
    keyword_weight: float = 0.5
    use_reranker: bool = False
    reranker_model_id: str | None = None
    min_score: float = 0.0

class RetrievalService:
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
        cfg = config or self.config
        
        accessible_collections = await self._get_accessible_collections(user_id, collection_ids)
        if not accessible_collections:
            return []
        
        accessible_collection_ids = [str(c.id) for c in accessible_collections]
        
        embedding_provider = self.model_manager.get_embedding_provider()
        if not embedding_provider:
            raise RuntimeError("No embedding model loaded")
        
        query_embedding = await embedding_provider.embed_single(query)
        
        vector_results = await self.vector_store.search(
            query_embedding=query_embedding,
            collection_ids=accessible_collection_ids,
            top_k=cfg.top_k * 3,
        )
        
        keyword_results = await self._fts_search(
            query=query,
            collection_ids=accessible_collection_ids,
            top_k=cfg.top_k * 3,
        )
        
        fused_results = self._rrf_fusion(
            vector_results, 
            keyword_results, 
            cfg.top_k,
            cfg.vector_weight,
            cfg.keyword_weight,
        )
        
        if cfg.use_reranker and cfg.reranker_model_id:
            fused_results = await self._rerank(query, fused_results, cfg.top_k)
        
        fused_results = [r for r in fused_results if r.score >= cfg.min_score]
        
        return fused_results[:cfg.top_k]
    
    async def _get_accessible_collections(
        self, 
        user_id: str, 
        requested_ids: List[str] | None
    ) -> List["Collection"]:
        user = await self.db.users.get(user_id)
        if check_permission(user, Permission.KNOWLEDGE_READ_ALL):
            if requested_ids:
                return await self.db.collections.list(ids=requested_ids)
            return await self.db.collections.list()
        
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
        conn = self.db.get_connection()
        
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
                    metadata=json.loads(chunk.chunk_metadata) if chunk.chunk_metadata else {},
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
        k = 60
        
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
            
            result_obj = None
            if v_rank is not None:
                result_obj = vector_results[v_rank]
            elif k_rank is not None:
                result_obj = keyword_results[k_rank]
            
            if result_obj:
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
        
        fused.sort(key=lambda x: x.score, reverse=True)
        return fused
    
    async def _rerank(
        self, 
        query: str, 
        results: List[SearchResult], 
        top_k: int
    ) -> List[SearchResult]:
        if not results:
            return results
        
        reranker_provider = self.model_manager.get_reranker_provider()
        if not reranker_provider:
            return results
        
        documents = [r.content for r in results]
        reranked = await reranker_provider.rerank(query, documents, top_k)
        
        reranked_results = []
        for idx, score in reranked:
            if idx < len(results):
                r = results[idx]
                reranked_results.append(SearchResult(
                    chunk_id=r.chunk_id,
                    document_id=r.document_id,
                    collection_id=r.collection_id,
                    content=r.content,
                    score=score,
                    page_start=r.page_start,
                    page_end=r.page_end,
                    section_title=r.section_title,
                    metadata=r.metadata,
                ))
        
        return reranked_results
    
    async def _get_chunk_details(self, chunk_id: str):
        from backend.db.database import create_db_engine, get_session_factory
        from backend.config import get_settings
        from backend.db.models import Chunk
        settings = get_settings()
        engine = create_db_engine(settings.database_url)
        Session = get_session_factory(engine)
        with Session() as session:
            return session.query(Chunk).filter(Chunk.id == chunk_id).first()