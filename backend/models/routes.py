from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional, List
import uuid
import shutil
from pathlib import Path
import logging
import psutil
from datetime import datetime

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Model, ModelConfig, User
from backend.config import get_settings

router = APIRouter(tags=["models"])
logger = logging.getLogger(__name__)

class ModelResponse(BaseModel):
    id: str
    name: str
    filename: str
    filepath: str
    format: str
    sizeBytes: int
    architecture: Optional[str]
    quantization: Optional[str]
    parameterCount: Optional[str]
    contextLength: int
    role: str
    status: str
    validationError: Optional[str]
    metadata: dict
    hardwareCompatibility: dict
    importedBy: Optional[str]
    importedAt: str
    activatedAt: Optional[str]
    lastUsedAt: Optional[str]

class ImportModelRequest(BaseModel):
    model_config = {"populate_by_name": True}
    sourcePath: str
    role: str
    name: Optional[str] = None
    copy_file: bool = Field(True, alias="copy")

class PathRequest(BaseModel):
    path: str

class ActivateModelRequest(BaseModel):
    role: str

class ModelConfigUpdate(BaseModel):
    gpuLayers: Optional[int] = None
    threads: Optional[int] = None
    batchSize: Optional[int] = None
    contextLength: Optional[int] = None
    ropeFreqBase: Optional[int] = None
    ropeFreqScale: Optional[int] = None
    extraArgs: Optional[List[str]] = None

@router.get("", response_model=List[ModelResponse])
async def list_models(
    role: Optional[str] = None,
    current_user: User = Depends(require_permission("models:list")),
    db: Session = Depends(get_db)
):
    query = db.query(Model)
    if role:
        query = query.filter(Model.role == role)
    models = query.order_by(Model.imported_at.desc()).all()
    return [model_to_response(m) for m in models]

@router.post("/scan")
async def scan_directory(
    request: PathRequest,
    current_user: User = Depends(require_permission("models:import")),
    db: Session = Depends(get_db)
):
    directory = Path(request.path).expanduser().resolve()
    if not directory.is_dir():
        raise HTTPException(404, "Directory not found")

    models = [
        {
            "name": item.stem,
            "filename": item.name,
            "filepath": str(item),
            "sizeBytes": item.stat().st_size,
            "format": "GGUF",
        }
        for item in sorted(directory.rglob("*.gguf"))
        if item.is_file()
    ]
    return {"models": models}

@router.post("/import", response_model=ModelResponse)
async def import_model(
    request: ImportModelRequest,
    current_user: User = Depends(require_permission("models:import")),
    db: Session = Depends(get_db)
):
    settings = get_settings()
    source = Path(request.sourcePath).resolve()
    
    if not source.exists():
        raise HTTPException(404, "Source file not found")
    
    if source.suffix.lower() != ".gguf":
        raise HTTPException(400, "Only GGUF files are supported")
    
    role_dir = Path(settings.models_dir) / request.role
    role_dir.mkdir(parents=True, exist_ok=True)
    
    dest = role_dir / source.name
    counter = 1
    while dest.exists():
        dest = role_dir / f"{source.stem}_{counter}{source.suffix}"
        counter += 1
    
    if request.copy_file:
        shutil.copy2(source, dest)
    else:
        shutil.move(str(source), str(dest))
    
    model = Model(
        id=str(uuid.uuid4()),
        name=request.name or source.stem,
        filename=dest.name,
        filepath=str(dest),
        format="GGUF",
        size_bytes=dest.stat().st_size,
        role=request.role,
        status="imported",
        imported_by=current_user.id,
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    
    return model_to_response(model)

@router.post("/{model_id}/activate")
async def activate_model(
    model_id: str,
    activation: ActivateModelRequest,
    http_request: Request,
    current_user: User = Depends(require_permission("models:activate")),
    db: Session = Depends(get_db)
):
    model = db.query(Model).filter(Model.id == model_id).first()
    if not model:
        raise HTTPException(404, "Model not found")
    
    if model.role != activation.role:
        raise HTTPException(400, f"Model is not a {activation.role} model")

    try:
        await http_request.app.state.model_manager.load_model(model, activation.role)
    except Exception as exc:
        model.status = "error"
        model.validation_error = str(exc)[:2000]
        db.commit()
        raise HTTPException(503, f"Model runtime failed to start: {exc}") from exc
    
    db.query(Model).filter(Model.role == activation.role, Model.status == "active").update({"status": "imported"})
    
    model.status = "active"
    model.validation_error = None
    model.activated_at = datetime.utcnow()
    db.commit()
    
    return {"success": True}

@router.post("/{model_id}/deactivate")
async def deactivate_model(
    model_id: str,
    request: Request,
    current_user: User = Depends(require_permission("models:activate")),
    db: Session = Depends(get_db)
):
    model = db.query(Model).filter(Model.id == model_id).first()
    if not model:
        raise HTTPException(404, "Model not found")
    
    if request.app.state.model_manager.active_chat_model_id == model.id:
        await request.app.state.model_manager.unload_model("chat")
    if request.app.state.model_manager.active_embedding_model_id == model.id:
        await request.app.state.model_manager.unload_model("embedding")
    model.status = "imported"
    db.commit()
    return {"success": True}

@router.delete("/{model_id}")
async def delete_model(
    model_id: str,
    current_user: User = Depends(require_permission("models:delete")),
    db: Session = Depends(get_db)
):
    model = db.query(Model).filter(Model.id == model_id).first()
    if not model:
        raise HTTPException(404, "Model not found")
    
    try:
        Path(model.filepath).unlink(missing_ok=True)
    except:
        pass
    
    db.delete(model)
    db.commit()
    return {"success": True}

@router.get("/hardware")
async def get_hardware_info(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    import psutil
    import platform
    
    return {
        "osName": platform.system(),
        "osVersion": platform.version(),
        "cpuName": platform.processor(),
        "cpuCoresLogical": psutil.cpu_count(logical=True),
        "cpuCoresPhysical": psutil.cpu_count(logical=False),
        "totalMemoryGB": round(psutil.virtual_memory().total / (1024**3), 1),
        "availableMemoryGB": round(psutil.virtual_memory().available / (1024**3), 1),
        "gpus": [],
        "llamaCppVersion": "unknown",
        "supportsCuda": False,
        "supportsVulkan": False,
    }

@router.post("/estimate")
async def estimate_model_requirements(
    request: PathRequest,
    current_user: User = Depends(require_permission("models:import")),
    db: Session = Depends(get_db)
):
    source = Path(request.path).expanduser().resolve()
    if not source.exists():
        raise HTTPException(404, "File not found")
    
    size_mb = source.stat().st_size / (1024 * 1024)
    estimated_ram = size_mb * 1.3
    
    return {
        "modelSizeMB": round(size_mb, 1),
        "estimatedRAMMB": round(estimated_ram, 1),
        "estimatedVRAMMB": 0,
        "compatibility": "COMPATIBLE" if estimated_ram < psutil.virtual_memory().available / (1024**2) * 0.8 else "LIMITED",
        "warnings": [],
        "reasons": ["Estimated based on file size"],
    }

def model_to_response(model: Model) -> ModelResponse:
    return ModelResponse(
        id=model.id,
        name=model.name,
        filename=model.filename,
        filepath=model.filepath,
        format=model.format,
        sizeBytes=model.size_bytes,
        architecture=model.architecture,
        quantization=model.quantization,
        parameterCount=model.parameter_count,
        contextLength=model.context_length,
        role=model.role,
        status=model.status,
        validationError=model.validation_error,
        metadata=model.model_metadata or {},
        hardwareCompatibility=model.hardware_compatibility or {},
        importedBy=model.imported_by,
        importedAt=model.imported_at.isoformat() if model.imported_at else "",
        activatedAt=model.activated_at.isoformat() if model.activated_at else None,
        lastUsedAt=model.last_used_at.isoformat() if model.last_used_at else None,
    )
