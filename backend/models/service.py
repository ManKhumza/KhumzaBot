import gguf
import hashlib
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
import shutil
import logging
import uuid

from backend.config import get_settings

logger = logging.getLogger(__name__)

@dataclass
class ModelScanResult:
    filepath: str
    filename: str
    size_bytes: int
    is_valid_gguf: bool
    metadata: dict | None
    error: str | None
    suggested_role: str | None
    suggested_name: str

@dataclass
class ImportResult:
    model_id: str
    model_path: str
    copied: bool

@dataclass
class ModelInfo:
    id: str
    name: str
    filename: str
    filepath: str
    format: str
    size_bytes: int
    architecture: str | None
    quantization: str | None
    parameter_count: str | None
    context_length: int
    embedding_dimension: int | None
    role: str
    status: str
    hardware_compatibility: dict
    model_metadata: dict

class ModelService:
    def __init__(self, db):
        self.db = db
        self.settings = get_settings()
        self.models_dir = Path(self.settings.models_dir)
        self.models_dir.mkdir(parents=True, exist_ok=True)
        (self.models_dir / "chat").mkdir(exist_ok=True)
        (self.models_dir / "embedding").mkdir(exist_ok=True)
    
    async def scan_directory(self, path: str) -> list[ModelScanResult]:
        results = []
        scan_path = Path(path).resolve()
        
        if not scan_path.exists() or not scan_path.is_dir():
            raise ValueError("Invalid directory path")
        
        self._validate_safe_path(scan_path)
        
        for file_path in scan_path.rglob("*.gguf"):
            result = await self._analyze_model_file(file_path)
            results.append(result)
        
        return results
    
    async def _analyze_model_file(self, file_path: Path) -> ModelScanResult:
        try:
            reader = gguf.GGUFReader(str(file_path))
            metadata = dict(reader.get_all_metadata())
            
            arch = metadata.get('general.architecture', ['unknown'])[0]
            name = metadata.get('general.name', [file_path.stem])[0]
            quant = metadata.get('general.quantization_version', ['unknown'])[0]
            
            is_embedding = any(
                k in str(metadata).lower() 
                for k in ['embedding', 'embed', 'bge', 'e5', 'gte', 'nomic']
            )
            
            suggested_role = "embedding" if is_embedding else "chat"
            suggested_name = f"{name} ({quant})"
            
            return ModelScanResult(
                filepath=str(file_path),
                filename=file_path.name,
                size_bytes=file_path.stat().st_size,
                is_valid_gguf=True,
                metadata=metadata,
                error=None,
                suggested_role=suggested_role,
                suggested_name=suggested_name,
            )
        except Exception as e:
            return ModelScanResult(
                filepath=str(file_path),
                filename=file_path.name,
                size_bytes=file_path.stat().st_size,
                is_valid_gguf=False,
                metadata=None,
                error=str(e),
                suggested_role=None,
                suggested_name=file_path.stem,
            )
    
    async def import_model(
        self, 
        source_path: str, 
        role: str,
        name: str | None = None,
        copy: bool = True
    ) -> ImportResult:
        source = Path(source_path).resolve()
        self._validate_safe_path(source)
        
        if not source.exists():
            raise FileNotFoundError(f"Model not found: {source_path}")
        
        scan = await self._analyze_model_file(source)
        if not scan.is_valid_gguf:
            raise ValueError(f"Invalid GGUF file: {scan.error}")
        
        if scan.suggested_role != role:
            logger.warning(f"Model appears to be {scan.suggested_role}, importing as {role}")
        
        role_dir = self.models_dir / role
        dest_filename = source.name
        dest_path = role_dir / dest_filename
        
        counter = 1
        while dest_path.exists():
            dest_filename = f"{source.stem}_{counter}{source.suffix}"
            dest_path = role_dir / dest_filename
            counter += 1
        
        if copy:
            shutil.copy2(source, dest_path)
            copied = True
        else:
            shutil.copy2(source, dest_path)
            copied = True
        
        file_hash = await self._compute_hash(dest_path)
        
        existing = await self.db.models.find_by_hash(file_hash)
        if existing:
            dest_path.unlink()
            raise ValueError(f"Model already imported: {existing.name}")
        
        model_info = ModelInfo(
            id=str(uuid.uuid4()),
            name=name or scan.suggested_name,
            filename=dest_filename,
            filepath=str(dest_path),
            format="GGUF",
            size_bytes=source.stat().st_size,
            architecture=scan.metadata.get('general.architecture', ['unknown'])[0],
            quantization=str(scan.metadata.get('general.quantization_version', ['unknown'])[0]),
            parameter_count=str(scan.metadata.get('general.parameter_count', ['unknown'])[0]),
            context_length=scan.metadata.get(f'{arch}.context_length', [4096])[0] if 'arch' in dir() else 4096,
            embedding_dimension=scan.metadata.get(f'{arch}.embedding_length', [None])[0] if role == "embedding" else None,
            role=role,
            status="imported",
            hardware_compatibility={},
            model_metadata=scan.metadata,
        )
        
        await self.db.models.create(model_info)
        
        return ImportResult(
            model_id=model_info.id,
            model_path=str(dest_path),
            copied=copied,
        )
    
    def _validate_safe_path(self, path: Path):
        system_paths = [
            Path("C:/Windows"),
            Path("C:/Program Files"),
            Path("C:/Program Files (x86)"),
            Path(os.environ.get("SYSTEMROOT", "C:/Windows")),
        ]
        
        for sys_path in system_paths:
            try:
                path.relative_to(sys_path)
                raise SecurityError(f"Access to system directory not allowed: {sys_path}")
            except ValueError:
                pass
    
    async def _compute_hash(self, path: Path) -> str:
        sha256 = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()

import os

class SecurityError(Exception):
    pass
