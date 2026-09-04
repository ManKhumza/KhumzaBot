from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session
from typing import Annotated
import hmac
from datetime import datetime

from backend.db.database import get_session_factory
from backend.auth.password import verify_session_token
from backend.config import get_settings
from backend.db.models import User

# Session token is set at startup via set_session_token()
SESSION_TOKEN: str = ""

def set_session_token(token: str):
    global SESSION_TOKEN
    SESSION_TOKEN = token

def get_session_factory_from_settings():
    """Get session factory using current settings."""
    settings = get_settings()
    return get_session_factory(settings.database_url)

async def get_db():
    """Get database session."""
    SessionLocal = get_session_factory_from_settings()
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

async def verify_session_token_dependency(
    authorization: Annotated[str | None, Header()] = None
) -> str:
    if not authorization:
        raise HTTPException(401, "Missing Authorization header")
    
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        raise HTTPException(401, "Invalid auth scheme")
    
    # The database-backed user session is validated by get_current_user().
    # SESSION_TOKEN protects backend process startup and is never a user login.
    return token

async def get_current_user(
    token: Annotated[str, Depends(verify_session_token_dependency)],
    db: Annotated[Session, Depends(get_db)]
) -> User:
    # Look up user by session token hash
    import hashlib
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    from backend.db.models import Session as SessionModel
    session = db.query(SessionModel).filter(SessionModel.token_hash == token_hash).first()
    if not session or session.revoked_at is not None or session.expires_at <= datetime.utcnow():
        raise HTTPException(401, "Invalid or revoked session")
    
    user = db.query(User).filter(User.id == session.user_id).first()
    if not user or not user.is_active:
        raise HTTPException(401, "User not found or inactive")
    return user

# Permission constants (consolidated from both implementations)
class Permission(str):
    MODELS_LIST = "models:list"
    MODELS_IMPORT = "models:import"
    MODELS_ACTIVATE = "models:activate"
    MODELS_DELETE = "models:delete"
    
    KNOWLEDGE_LIST = "knowledge:list"
    KNOWLEDGE_CREATE = "knowledge:create"
    KNOWLEDGE_WRITE = "knowledge:write"
    KNOWLEDGE_DELETE = "knowledge:delete"
    KNOWLEDGE_MANAGE_PERMS = "knowledge:manage_perms"
    KNOWLEDGE_READ_ALL = "knowledge:read_all"
    
    CHAT_CREATE = "chat:create"
    CHAT_READ_OWN = "chat:read_own"
    CHAT_READ_ALL = "chat:read_all"
    CHAT_DELETE_OWN = "chat:delete_own"
    
    ADMIN_USERS = "admin:users"
    ADMIN_ROLES = "admin:roles"
    ADMIN_AUDIT = "admin:audit"
    ADMIN_JOBS = "admin:jobs"
    ADMIN_HEALTH = "admin:health"
    ADMIN_SETTINGS = "admin:settings"
    ADMIN_BACKUP = "admin:backup"

ROLE_PERMISSIONS = {
    "administrator": {
        value for name, value in vars(Permission).items()
        if name.isupper() and isinstance(value, str)
    },
    "knowledge_manager": {
        Permission.MODELS_LIST,
        Permission.KNOWLEDGE_LIST,
        Permission.KNOWLEDGE_CREATE,
        Permission.KNOWLEDGE_WRITE,
        Permission.KNOWLEDGE_DELETE,
        Permission.KNOWLEDGE_MANAGE_PERMS,
        Permission.CHAT_CREATE,
        Permission.CHAT_READ_OWN,
        Permission.CHAT_DELETE_OWN,
    },
    "operator": {
        Permission.MODELS_LIST,
        Permission.KNOWLEDGE_LIST,
        Permission.CHAT_CREATE,
        Permission.CHAT_READ_OWN,
        Permission.CHAT_DELETE_OWN,
    },
}

def check_permission(user: User, permission: Permission) -> bool:
    user_perms = set()
    for role in user.roles or []:
        user_perms.update(ROLE_PERMISSIONS.get(role, set()))
    return permission in user_perms

def require_permission(permission: Permission):
    async def _require_permission(
        current_user: Annotated[User, Depends(get_current_user)]
    ) -> User:
        if not check_permission(current_user, permission):
            from backend.audit.service import audit_log
            audit_log("auth.permission_denied", {
                "user": current_user.username,
                "permission": permission,
            })
            raise HTTPException(403, f"Requires {permission}")
        return current_user
    return _require_permission
