from dataclasses import dataclass
from typing import Iterator, List
import tiktoken
import re

MAX_SEGMENT_CHARS = 64 * 1024

@dataclass
class ChunkConfig:
    chunk_size: int = 512
    chunk_overlap: int = 50
    min_chunk_size: int = 50
    respect_boundaries: bool = True
    separators: List[str] = None
    
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

def _iter_bounded_lines(text: str) -> Iterator[tuple[str, bool]]:
    """Yield line-aware segments without copying the entire document into a line list."""
    position = 0
    line_start = True
    while position < len(text):
        search_end = min(len(text), position + MAX_SEGMENT_CHARS)
        newline = text.find("\n", position, search_end)
        end = newline + 1 if newline >= 0 else search_end
        segment = text[position:end]
        yield segment, line_start
        line_start = segment.endswith("\n")
        position = end


def iter_text_chunks(text: str, config: ChunkConfig) -> Iterator[TextChunk]:
    """Yield bounded chunks lazily so ingestion can release each completed batch."""
    encoder = tiktoken.get_encoding("cl100k_base")
    chunk_size = max(1, int(config.chunk_size))
    overlap_size = min(max(0, int(config.chunk_overlap)), max(0, chunk_size - 1))
    min_chunk_size = min(max(1, int(config.min_chunk_size)), chunk_size)

    current_tokens: List[int] = []
    current_start_page = 1
    current_end_page = 1
    current_section: str | None = None
    has_new_content = False

    page_pattern = re.compile(r'\[Page (\d+)\]')
    section_pattern = re.compile(r'^#{1,6}\s+(.+)$')

    def emit_chunk() -> TextChunk | None:
        nonlocal current_tokens, current_start_page, has_new_content
        content = encoder.decode(current_tokens).strip()
        completed = None
        if content:
            completed = TextChunk(
                content=content,
                token_count=len(current_tokens),
                page_start=current_start_page,
                page_end=current_end_page,
                section_title=current_section,
                metadata={},
            )
        current_tokens = current_tokens[-overlap_size:] if overlap_size else []
        current_start_page = current_end_page
        has_new_content = False
        return completed

    for segment, is_line_start in _iter_bounded_lines(text):
        segment_tokens = encoder.encode(segment, disallowed_special=())
        if (
            config.respect_boundaries
            and is_line_start
            and current_tokens
            and len(current_tokens) >= min_chunk_size
            and len(current_tokens) + len(segment_tokens) > chunk_size
        ):
            completed = emit_chunk()
            if completed:
                yield completed

        page_match = page_pattern.search(segment) if is_line_start else None
        if page_match:
            current_end_page = int(page_match.group(1))
            if not current_tokens:
                current_start_page = current_end_page

        section_match = section_pattern.match(segment.strip()) if is_line_start else None
        if section_match:
            current_section = section_match.group(1).strip()

        cursor = 0
        while cursor < len(segment_tokens):
            capacity = chunk_size - len(current_tokens)
            if capacity <= 0:
                completed = emit_chunk()
                if completed:
                    yield completed
                capacity = chunk_size - len(current_tokens)
            take = min(capacity, len(segment_tokens) - cursor)
            current_tokens.extend(segment_tokens[cursor:cursor + take])
            cursor += take
            has_new_content = True
            if len(current_tokens) == chunk_size:
                completed = emit_chunk()
                if completed:
                    yield completed

    # The minimum is a split heuristic, not a reason to discard a useful tail.
    if current_tokens and has_new_content:
        completed = emit_chunk()
        if completed:
            yield completed


def chunk_text(text: str, config: ChunkConfig) -> List[TextChunk]:
    """Compatibility wrapper for callers that need all chunks at once."""
    return list(iter_text_chunks(text, config))
