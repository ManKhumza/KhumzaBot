"""Hybrid retrieval helpers for the active SQLAlchemy/vector-store stack."""

from __future__ import annotations

from dataclasses import replace
import math
import re
from typing import Iterable

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from backend.db.models import Chunk, Document
from backend.retrieval.vector_store import SearchResult


# Query framing words add noise without identifying a passage. Collection names
# are removed separately, so asking for information "from the Khumza knowledge
# base" searches for the subject of the question rather than the UI wording.
_QUERY_STOP_WORDS = {
    "a", "about", "according", "an", "and", "answer", "are", "as", "at",
    "bank", "base", "be", "by", "can", "contained", "could", "document",
    "for", "from", "give", "has", "have", "how", "i", "in", "information",
    "is", "it", "knowledge", "me", "of", "on", "please", "retrieve", "say",
    "show", "source", "tell", "that", "the", "their", "therein", "this",
    "to", "using", "was", "what", "when", "where", "which", "who", "with",
}


def _tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", text.casefold(), flags=re.UNICODE)


def extract_query_terms(query: str, collection_names: Iterable[str] = ()) -> list[str]:
    """Return bounded, de-duplicated terms suitable for literal keyword search."""
    excluded = set(_QUERY_STOP_WORDS)
    for name in collection_names:
        excluded.update(_tokens(name))

    terms: list[str] = []
    seen: set[str] = set()
    for token in _tokens(query):
        if len(token) < 3 or token in excluded:
            continue
        # A literal substring search for the singular also covers a plural in
        # the passage ("headache" matches "headaches").
        if len(token) > 4 and token.endswith("s") and not token.endswith("ss"):
            token = token[:-1]
        if token and token not in seen:
            seen.add(token)
            terms.append(token)
        if len(terms) == 16:
            break
    return terms


def prepare_semantic_query(query: str, collection_names: Iterable[str] = ()) -> str:
    """Remove collection/UI framing from the text sent to an embedding model."""
    cleaned = query
    for name in sorted((item.strip() for item in collection_names if item.strip()), key=len, reverse=True):
        cleaned = re.sub(re.escape(name), " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bknowledge\s+(?:base|bank|source)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,.:;-\t\r\n")
    return cleaned or query.strip()


def keyword_search(
    db: Session,
    query: str,
    collection_ids: list[str],
    *,
    top_k: int,
    collection_names: Iterable[str] = (),
) -> list[SearchResult]:
    """Rank ready chunks by literal query terms without requiring an FTS migration.

    IDF-style term weights keep a specific term such as ``headache`` ahead of
    generic corpus-wide terms such as ``herb``. The query is parameterized by
    SQLAlchemy, and work is bounded by the query-term and result limits.
    """
    if not collection_ids or top_k <= 0:
        return []
    terms = extract_query_terms(query, collection_names)
    if not terms:
        return []

    lowered_content = func.lower(Chunk.content)
    conditions = [lowered_content.contains(term, autoescape=True) for term in terms]
    ready_filter = (
        Chunk.collection_id.in_(collection_ids),
        Document.status == "ready",
    )

    count_columns = [func.sum(case((condition, 1), else_=0)) for condition in conditions]
    counts = (
        db.query(func.count(Chunk.id), *count_columns)
        .join(Document, Document.id == Chunk.document_id)
        .filter(*ready_filter)
        .one()
    )
    total_chunks = max(1, int(counts[0] or 0))
    document_frequencies = [int(value or 0) for value in counts[1:]]
    weights = [math.log((total_chunks + 1) / (frequency + 1)) + 1 for frequency in document_frequencies]
    max_weight = max(weights)
    total_weight = sum(weights)

    weighted_match = sum(
        (case((condition, weight), else_=0.0) for condition, weight in zip(conditions, weights)),
        0.0,
    )
    rows = (
        db.query(Chunk, weighted_match.label("keyword_weight"))
        .join(Document, Document.id == Chunk.document_id)
        .filter(*ready_filter, or_(*conditions))
        .order_by(weighted_match.desc(), Chunk.chunk_index.asc())
        .limit(min(100, max(1, top_k)))
        .all()
    )

    results: list[SearchResult] = []
    for chunk, matched_weight in rows:
        content = chunk.content.casefold()
        matched_weights = [weight for term, weight in zip(terms, weights) if term in content]
        if not matched_weights:
            continue
        weighted_coverage = sum(matched_weights) / total_weight
        rarest_match = max(matched_weights) / max_weight
        score = min(1.0, 0.7 * rarest_match + 0.3 * weighted_coverage)
        metadata = dict(chunk.chunk_metadata or {})
        metadata = {key: value for key, value in metadata.items() if not key.startswith("_nocai")}
        results.append(SearchResult(
            chunk_id=chunk.id,
            document_id=chunk.document_id,
            collection_id=chunk.collection_id,
            content=chunk.content,
            score=score,
            page_start=chunk.page_start,
            page_end=chunk.page_end,
            section_title=chunk.section_title,
            metadata=metadata,
        ))

    return results


def merge_hybrid_results(
    vector_results: list[SearchResult],
    keyword_results: list[SearchResult],
    *,
    minimum_vector_score: float,
    top_k: int,
    vector_weight: float,
) -> list[SearchResult]:
    """Fuse semantic and literal evidence while preserving the safety cutoff.

    The cutoff applies to vector-only candidates. A literal match may rescue a
    passage below that cutoff because the query text itself is present there.
    """
    vector_weight = max(0.0, min(1.0, float(vector_weight)))
    keyword_weight = 1.0 - vector_weight

    vectors: dict[str, SearchResult] = {}
    for result in vector_results:
        if result.chunk_id not in vectors or result.score > vectors[result.chunk_id].score:
            vectors[result.chunk_id] = result
    keywords: dict[str, SearchResult] = {result.chunk_id: result for result in keyword_results}

    candidate_ids: set[str] = set()
    if vector_weight > 0:
        candidate_ids.update(
            chunk_id for chunk_id, result in vectors.items()
            if result.score >= minimum_vector_score
        )
    if keyword_weight > 0:
        candidate_ids.update(keywords)

    fused: list[SearchResult] = []
    for chunk_id in candidate_ids:
        vector = vectors.get(chunk_id)
        keyword = keywords.get(chunk_id)
        if vector is not None and keyword is not None:
            score = vector_weight * vector.score + keyword_weight * keyword.score
            method = "hybrid"
            base = vector
        elif keyword is not None:
            score = keyword.score
            method = "keyword"
            base = keyword
        elif vector is not None:
            score = vector.score
            method = "semantic"
            base = vector
        else:  # pragma: no cover - candidate_ids is built from these mappings
            continue
        fused.append(replace(
            base,
            score=max(0.0, min(1.0, score)),
            metadata={**base.metadata, "retrievalMethod": method},
        ))

    fused.sort(
        key=lambda result: (
            result.score,
            result.metadata.get("retrievalMethod") == "hybrid",
            result.metadata.get("retrievalMethod") == "keyword",
        ),
        reverse=True,
    )
    return fused[:max(0, top_k)]
