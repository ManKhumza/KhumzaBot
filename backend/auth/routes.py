from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import hashlib
import secrets

from backend.auth.dependencies import get_db, get_current_user, require_permission, set_session_token
from backend.auth.password import hash_password, verify_password
from backend.db.models import User, Session as SessionModel
from backend.audit.service import audit_log

router = APIRouter(tags=["auth"])

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1)

class LoginResponse(BaseModel):
    user: dict
    token: str
    expiresAt: str

class ChangePasswordRequest(BaseModel):
    currentPassword: str = Field(..., min_length=1)
    newPassword: str = Field(..., min_length=12)

@router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == request.username).first()

    # The loopback API is protected by Electron's random transport token. On a
    # new database, the first credentials submitted create the administrator.
    if user is None and db.query(User).count() == 0:
        if len(request.password) < 12:
            raise HTTPException(400, "The first administrator password must be at least 12 characters")
        user = await create_bootstrap_admin(db, request.username, request.password)
    
    if not user:
        audit_log("auth.login_failed", {"username": request.username, "reason": "user_not_found"})
        raise HTTPException(status_code=401, detail="Invalid username or password")
    
    if not user.is_active:
        audit_log("auth.login_failed", {"username": request.username, "reason": "account_disabled"})
        raise HTTPException(status_code=401, detail="Account is disabled")
    
    if user.locked_until and user.locked_until > datetime.utcnow():
        audit_log("auth.login_failed", {"username": request.username, "reason": "account_locked"})
        raise HTTPException(status_code=429, detail="Account temporarily locked")
    
    if not verify_password(request.password, user.password_hash):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= 5:
            user.locked_until = datetime.utcnow() + timedelta(minutes=15)
        db.commit()
        audit_log("auth.login_failed", {"username": request.username, "reason": "invalid_password"})
        raise HTTPException(status_code=401, detail="Invalid username or password")
    
    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login_at = datetime.utcnow()
    db.commit()
    
    session_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(session_token.encode()).hexdigest()
    
    expires_at = datetime.utcnow() + timedelta(minutes=480)
    session = SessionModel(
        id=secrets.token_urlsafe(16),
        user_id=user.id,
        token_hash=token_hash,
        expires_at=expires_at,
    )
    db.add(session)
    db.commit()
    
    audit_log(
        "auth.login_success", {"username": user.username},
        actor_id=user.id, actor_name=user.username,
    )
    
    return LoginResponse(
        user={
            "id": user.id,
            "username": user.username,
            "displayName": user.display_name,
            "email": user.email,
            "roles": user.roles,
            "mustChangePassword": user.must_change_password,
        },
        token=session_token,
        expiresAt=expires_at.isoformat(),
    )

@router.post("/logout")
async def logout(
    current_user: User = Depends(get_current_user),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db)
):
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer":
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            session = db.query(SessionModel).filter(SessionModel.token_hash == token_hash).first()
            if session:
                session.revoked_at = datetime.utcnow()
                db.commit()
    
    audit_log(
        "auth.logout", {"username": current_user.username},
        actor_id=current_user.id, actor_name=current_user.username,
    )
    return {"success": True}

@router.get("/session")
async def get_session(
    current_user: User = Depends(get_current_user),
):
    return {
        "user": {
            "id": current_user.id,
            "username": current_user.username,
            "displayName": current_user.display_name,
            "email": current_user.email,
            "roles": current_user.roles,
            "mustChangePassword": current_user.must_change_password,
        }
    }

@router.post("/change-password")
async def change_password(
    request: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if not verify_password(request.currentPassword, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    
    current_user.password_hash = hash_password(request.newPassword)
    current_user.must_change_password = False
    db.commit()
    
    audit_log(
        "auth.password_change", {"username": current_user.username},
        actor_id=current_user.id, actor_name=current_user.username,
    )
    return {"success": True}

async def create_bootstrap_admin(db: Session, username: str, password: str) -> User:
    existing = db.query(User).filter(User.username == username).first()
    if existing:
        return existing
    
    user = User(
        username=username,
        password_hash=hash_password(password),
        roles=["administrator"],
        is_active=True,
        # This is a user-chosen first-run password, not a temporary credential.
        must_change_password=False,
        created_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    
    audit_log("user.bootstrap_created", {"username": username})
    return user
