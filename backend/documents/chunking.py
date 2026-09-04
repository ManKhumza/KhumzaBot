from dataclasses import dataclass
from typing import List
import tiktoken
import re

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

def chunk_text(text: str, config: ChunkConfig) -> List[TextChunk]:
    encoder = tiktoken.get_encoding("cl100k_base")
    
    splits = _split_by_separators(text, config.separators)
    
    chunks = []
    current_chunk = ""
    current_tokens = 0
    current_start_page = 1
    current_section = None
    
    page_pattern = re.compile(r'\[Page (\d+)\]')
    section_pattern = re.compile(r'^(#{1,6})\s+(.+)$', re.MULTILINE)
    
    for split in splits:
        split_tokens = len(encoder.encode(split))
        
        page_match = page_pattern.search(split)
        if page_match:
            current_start_page = int(page_match.group(1))
        
        section_match = section_pattern.search(split)
        if section_match:
            current_section = section_match.group(2).strip()
        
        if current_tokens + split_tokens > config.chunk_size and current_tokens >= config.min_chunk_size:
            chunks.append(TextChunk(
                content=current_chunk.strip(),
                token_count=current_tokens,
                page_start=current_start_page,
                page_end=current_start_page,
                section_title=current_section,
                metadata={},
            ))
            
            overlap_text = _get_overlap(current_chunk, config.chunk_overlap, encoder)
            current_chunk = overlap_text + split
            current_tokens = len(encoder.encode(current_chunk))
        else:
            current_chunk += split
            current_tokens += split_tokens
    
    # A complete short document is still useful knowledge. The minimum is a
    # split/merge heuristic, not a reason to silently discard the final tail.
    if current_tokens > 0 and current_chunk.strip():
        chunks.append(TextChunk(
            content=current_chunk.strip(),
            token_count=current_tokens,
            page_start=current_start_page,
            page_end=current_start_page,
            section_title=current_section,
            metadata={},
        ))
    
    return chunks

def _split_by_separators(text: str, separators: List[str]) -> List[str]:
    if not separators:
        return [text]
    
    sep = separators[0]
    parts = text.split(sep)
    
    if len(parts) == 1:
        return _split_by_separators(text, separators[1:])
    
    result = []
    for i, part in enumerate(parts):
        if i > 0:
            result.append(sep)
        subparts = _split_by_separators(part, separators[1:])
        result.extend(subparts)
    
    return [p for p in result if p]

def _get_overlap(text: str, overlap_tokens: int, encoder) -> str:
    tokens = encoder.encode(text)
    if len(tokens) <= overlap_tokens:
        return text
    overlap_tokens = tokens[-overlap_tokens:]
    return encoder.decode(overlap_tokens)
