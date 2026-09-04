from dataclasses import dataclass
from typing import List, Optional
from pathlib import Path
import pypdf
import fitz
import logging
from typing import List
from backend.db.database import create_db_engine, get_session_factory
from backend.config import get_settings

logger = logging.getLogger(__name__)

@dataclass
class SourcePreview:
    document_id: str
    document_name: str
    collection_name: str
    chunk_id: str
    content: str
    page_start: int
    page_end: int
    section_title: Optional[str]
    mime_type: str
    file_path: str
    pdf_page_image: Optional[bytes] = None
    highlight_rects: Optional[List[dict]] = None

class SourcePreviewService:
    def __init__(self, knowledge_dir: Path):
        self.knowledge_dir = knowledge_dir
    
    async def get_preview(
        self,
        chunk_id: str,
        db,
        context_chars: int = 500,
    ) -> SourcePreview:
        # We'll use a simplified approach - get chunk from db directly
        from backend.db.database import get_session_factory
        from backend.config import get_settings
        from backend.db.models import Chunk, Document, Collection
        from sqlalchemy.orm import Session
        
        settings = get_settings()
        engine = create_db_engine(settings.database_url)
        from backend.db.database import get_session_factory
        SessionLocal = get_session_factory(settings.database_url)
        
        with SessionLocal() as db:
            chunk = db.query(Chunk).filter(Chunk.id == chunk_id).first()
            if not chunk:
                raise ValueError("Chunk not found")
            
            document = db.query(Document).filter(Document.id == chunk.document_id).first()
            collection = db.query(Collection).filter(Collection.id == chunk.collection_id).first()
            
            if not document or not collection:
                raise ValueError("Document or collection not found")
            
            file_path = Path(settings.knowledge_dir) / document.filepath
            
            preview = SourcePreview(
                document_id=document.id,
                document_name=document.original_filename,
                collection_name=collection.name,
                chunk_id=chunk.id,
                content=chunk.content,
                page_start=chunk.page_start,
                page_end=chunk.page_end,
                section_title=chunk.section_title,
                mime_type=document.mime_type,
                file_path=str(file_path),
            )
            
            if document.mime_type == "application/pdf":
                try:
                    doc = fitz.open(file_path)
                    page_num = max(1, chunk.page_start) - 1
                    
                    if page_num < len(doc):
                        page = doc[page_num]
                        
                        mat = fitz.Matrix(2, 2)
                        pix = page.get_pixmap(matrix=mat)
                        preview.pdf_page_image = pix.tobytes("png")
                        
                        text_instances = page.search_for(chunk.content[:100])
                        if text_instances:
                            preview.highlight_rects = [
                                {"x0": r.x0, "y0": r.y0, "x1": r.x1, "y1": r.y1}
                                for r in text_instances[:5]
                            ]
                    
                    doc.close()
                except Exception as e:
                    logger.warning(f"PDF preview failed: {e}")
        
        return preview