from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional, List
import uuid
from datetime import datetime

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import User, Role, AuditLog, IngestionJob
from backend.auth.password import hash_password
from backend.auth.policy import validate_password
from backend.auth.dependencies import ROLE_PERMISSIONS
from backend.audit.service import audit_log

router = APIRouter(tags=["admin"])

class UserResponse(BaseModel):
    id: str
    username: str
    displayName: Optional[str]
    email: Optional[str]
    roles: List[str]
    isActive: bool
    mustChangePassword: bool
    lastLoginAt: Optional[str]
    failedLoginAttempts: int
    lockedUntil: Optional[str]
    createdAt: str

class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=12)
    displayName: Optional[str] = None
    email: Optional[str] = None
    roles: List[str] = ["operator"]


def validate_roles(roles):
    if not roles or any(role not in ROLE_PERMISSIONS for role in roles):
        raise HTTPException(400, "Choose a supported role: administrator, knowledge_manager or operator")


def protect_last_administrator(db, user, roles, active):
    if user.is_active and "administrator" in (user.roles or []) and (not active or "administrator" not in roles):
        others = db.query(User).filter(User.id != user.id, User.is_active.is_(True)).all()
        if not any("administrator" in (other.roles or []) for other in others):
            raise HTTPException(409, "At least one active administrator is required")

class UpdateUserRequest(BaseModel):
    displayName: Optional[str] = None
    email: Optional[str] = None
    roles: Optional[List[str]] = None
    isActive: Optional[bool] = None

class RoleResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    permissions: List[str]
    isSystem: bool

class AuditLogResponse(BaseModel):
    id: str
    timestamp: str
    actorId: Optional[str]
    actorName: Optional[str]
    action: str
    resourceType: Optional[str]
    resourceId: Optional[str]
    outcome: str
    metadata: dict
    ipAddress: str

class JobResponse(BaseModel):
    id: str
    documentId: str
    collectionId: str
    status: str
    priority: int
    currentStage: Optional[str]
    progress: int
    errorMessage: Optional[str]
    startedAt: Optional[str]
    completedAt: Optional[str]
    createdAt: str

class HealthResponse(BaseModel):
    backend: str
    database: str
    modelRuntime: str
    embeddingRuntime: str
    storage: dict
    memory: dict
    jobWorkers: dict

@router.get("/users", response_model=List[UserResponse])
async def list_users(
    current_user: User = Depends(require_permission("admin:users")),
    db: Session = Depends(get_db)
):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return [user_to_response(u) for u in users]

@router.post("/users", response_model=UserResponse)
async def create_user(
    request: CreateUserRequest,
    current_user: User = Depends(require_permission("admin:users")),
    db: Session = Depends(get_db)
):
    validate_roles(request.roles)
    validate_password(request.password, db)
    existing = db.query(User).filter(User.username == request.username).first()
    if existing:
        raise HTTPException(400, "Username already exists")
    
    user = User(
        id=str(uuid.uuid4()),
        username=request.username,
        password_hash=hash_password(request.password),
        display_name=request.displayName,
        email=request.email,
        roles=request.roles,
        is_active=True,
        must_change_password=True,
        created_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    audit_log("admin.user_created", {"roles": user.roles}, actor_id=current_user.id, actor_name=current_user.username,
              resource_type="user", resource_id=user.id, db=db)
    return user_to_response(user)

@router.patch("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    request: UpdateUserRequest,
    current_user: User = Depends(require_permission("admin:users")),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    if request.roles is not None:
        validate_roles(request.roles)
    protect_last_administrator(db, user, request.roles if request.roles is not None else user.roles,
                              request.isActive if request.isActive is not None else user.is_active)
    
    if request.displayName is not None:
        user.display_name = request.displayName
    if request.email is not None:
        user.email = request.email
    if request.roles is not None:
        user.roles = request.roles
    if request.isActive is not None:
        user.is_active = request.isActive
    
    user.updated_at = datetime.utcnow()
    db.commit()
    audit_log("admin.user_updated", {"roles": user.roles, "isActive": user.is_active}, actor_id=current_user.id,
              actor_name=current_user.username, resource_type="user", resource_id=user.id, db=db)
    return user_to_response(user)

@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    current_user: User = Depends(require_permission("admin:users")),
    db: Session = Depends(get_db)
):
    if user_id == current_user.id:
        raise HTTPException(400, "Cannot delete yourself")
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    protect_last_administrator(db, user, [], False)
    
    db.delete(user)
    db.commit()
    audit_log("admin.user_deleted", {}, actor_id=current_user.id, actor_name=current_user.username,
              resource_type="user", resource_id=user_id, db=db)
    return {"success": True}

@router.get("/roles", response_model=List[RoleResponse])
async def list_roles(
    current_user: User = Depends(require_permission("admin:roles")),
    db: Session = Depends(get_db)
):
    return [RoleResponse(id=name, name=name, description=name.replace("_", " ").capitalize(),
                         permissions=sorted(permissions), isSystem=True)
            for name, permissions in ROLE_PERMISSIONS.items()]

@router.get("/audit", response_model=List[AuditLogResponse])
async def get_audit_log(
    actorId: Optional[str] = None,
    action: Optional[str] = None,
    resourceType: Optional[str] = None,
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    limit: int = Query(100, le=1000),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(require_permission("admin:audit")),
    db: Session = Depends(get_db)
):
    query = db.query(AuditLog)
    
    if actorId:
        query = query.filter(AuditLog.actor_id == actorId)
    if action:
        query = query.filter(AuditLog.action == action)
    if resourceType:
        query = query.filter(AuditLog.resource_type == resourceType)
    if startDate:
        query = query.filter(AuditLog.timestamp >= datetime.fromisoformat(startDate))
    if endDate:
        query = query.filter(AuditLog.timestamp <= datetime.fromisoformat(endDate))
    
    logs = query.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit).all()
    return [audit_to_response(l) for l in logs]

@router.get("/jobs", response_model=List[JobResponse])
async def get_jobs(
    status: Optional[str] = None,
    priority: Optional[int] = None,
    limit: int = Query(100, le=1000),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(require_permission("admin:jobs")),
    db: Session = Depends(get_db)
):
    query = db.query(IngestionJob)
    
    if status:
        query = query.filter(IngestionJob.status == status)
    if priority:
        query = query.filter(IngestionJob.priority == priority)
    
    jobs = query.order_by(IngestionJob.created_at.desc()).offset(offset).limit(limit).all()
    return [job_to_response(j) for j in jobs]

@router.get("/health", response_model=HealthResponse)
async def get_health(
    request: Request,
    current_user: User = Depends(require_permission("admin:health")),
    db: Session = Depends(get_db)
):
    import psutil
    import platform
    
    try:
        db.execute(text("SELECT 1"))
        db_status = "healthy"
    except:
        db_status = "unhealthy"
    
    disk = psutil.disk_usage("/")
    mem = psutil.virtual_memory()
    
    manager = request.app.state.model_manager
    chat = manager.get_chat_provider()
    embedding = manager.get_embedding_provider()
    active_jobs = db.query(IngestionJob).filter(IngestionJob.status == "running").count()
    return HealthResponse(
        backend="healthy",
        database=db_status,
        modelRuntime="healthy" if chat and chat.process and chat.process.poll() is None else "degraded",
        embeddingRuntime="healthy" if embedding and embedding.process and embedding.process.poll() is None else "degraded",
        storage={
            "freeGB": round(disk.free / (1024**3), 1),
            "totalGB": round(disk.total / (1024**3), 1),
            "usagePercent": round(disk.used / disk.total * 100, 1),
        },
        memory={
            "usedMB": round(mem.used / (1024**2), 1),
            "availableMB": round(mem.available / (1024**2), 1),
        },
        jobWorkers={
            "active": active_jobs,
            "queued": db.query(IngestionJob).filter(IngestionJob.status == "pending").count(),
        }
    )

from sqlalchemy import text

def user_to_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        username=user.username,
        displayName=user.display_name,
        email=user.email,
        roles=user.roles or [],
        isActive=user.is_active,
        mustChangePassword=user.must_change_password,
        lastLoginAt=user.last_login_at.isoformat() if user.last_login_at else None,
        failedLoginAttempts=user.failed_login_attempts,
        lockedUntil=user.locked_until.isoformat() if user.locked_until else None,
        createdAt=user.created_at.isoformat() if user.created_at else "",
    )

def role_to_response(role: Role) -> RoleResponse:
    return RoleResponse(
        id=role.id,
        name=role.name,
        description=role.description,
        permissions=role.permissions or [],
        isSystem=role.is_system,
    )

def audit_to_response(log: AuditLog) -> AuditLogResponse:
    return AuditLogResponse(
        id=log.id,
        timestamp=log.timestamp.isoformat() if log.timestamp else "",
        actorId=log.actor_id,
        actorName=log.actor_name,
        action=log.action,
        resourceType=log.resource_type,
        resourceId=log.resource_id,
        outcome=log.outcome,
        metadata=log.audit_metadata or {},
        ipAddress=log.ip_address,
    )

def job_to_response(job: IngestionJob) -> JobResponse:
    return JobResponse(
        id=job.id,
        documentId=job.document_id,
        collectionId=job.collection_id,
        status=job.status,
        priority=job.priority,
        currentStage=job.current_stage,
        progress=job.progress,
        errorMessage=job.error_message,
        startedAt=job.started_at.isoformat() if job.started_at else None,
        completedAt=job.completed_at.isoformat() if job.completed_at else None,
        createdAt=job.created_at.isoformat() if job.created_at else "",
    )
