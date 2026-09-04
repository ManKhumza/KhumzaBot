from dataclasses import dataclass
from typing import List
import tiktoken
from backend.retrieval.vector_store import SearchResult

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
    preview: str

@dataclass
class ContextPackage:
    system_prompt: str
    messages: List[dict]
    citations: List[Citation]
    total_tokens: int
    retrieval_metadata: dict

class ContextBuilder:
    def __init__(self, model_context_length: int = 4096, reserved_tokens: int = 1024):
        self.model_context_length = model_context_length
        self.reserved_tokens = reserved_tokens
        self.encoder = tiktoken.get_encoding("cl100k_base")
        self.max_context_tokens = model_context_length - reserved_tokens
    
    def build(
        self,
        conversation_history: List[dict],
        retrieval_results: List[SearchResult],
        system_prompt: str,
        user_query: str,
    ) -> ContextPackage:
        citations = self._format_citations(retrieval_results)
        retrieval_context = self._build_retrieval_context(retrieval_results, citations)
        full_system_prompt = self._build_system_prompt(system_prompt, retrieval_context)
        messages = self._build_messages(conversation_history, full_system_prompt, user_query)
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
        messages = [{"role": "system", "content": system_prompt}]
        
        history_tokens = 0
        for msg in reversed(history):
            msg_tokens = self._count_tokens([msg])
            if history_tokens + msg_tokens > self.max_context_tokens * 0.3:
                break
            messages.insert(1, msg)
            history_tokens += msg_tokens
        
        messages.append({"role": "user", "content": user_query})
        
        return messages
    
    def _count_tokens(self, messages: List[dict]) -> int:
        total = 0
        for msg in messages:
            total += len(self.encoder.encode(msg.get("content", "")))
            total += 4
        return total + 2
