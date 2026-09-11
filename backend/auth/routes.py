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
from backend.auth.policy import security_policy, validate_password

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

class AuthStatusResponse(BaseModel):
    needsSetup: bool

@router.get("/status", response_model=AuthStatusResponse)
async def get_auth_status(db: Session = Depends(get_db)):
    return AuthStatusResponse(needsSetup=db.query(User.id).first() is None)

@router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest, db: Session = Depends(get_db)):
    policy = security_policy(db)
    user = db.query(User).filter(User.username == request.username).first()

    # The loopback API is protected by Electron's random transport token. On a
    # new database, the first credentials submitted create the administrator.
    if user is None and db.query(User).count() == 0:
        validate_password(request.password, db)
        user = await create_bootstrap_admin(db, request.username, request.password)
    
    if not user:
        audit_log("auth.login_failed", {"username": request.username, "reason": "user_not_found"}, db=db, outcome="failure")
        raise HTTPException(status_code=401, detail="Invalid username or password")
    
    if not user.is_active:
        audit_log("auth.login_failed", {"username": request.username, "reason": "account_disabled"}, db=db, actor_id=user.id, actor_name=user.username, outcome="failure")
        raise HTTPException(status_code=401, detail="Account is disabled")
    
    if user.locked_until and user.locked_until > datetime.utcnow():
        audit_log("auth.login_failed", {"username": request.username, "reason": "account_locked"}, db=db, actor_id=user.id, actor_name=user.username, outcome="failure")
        raise HTTPException(status_code=429, detail="Account temporarily locked")
    
    if not verify_password(request.password, user.password_hash):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= policy["maxFailedLogins"]:
            user.locked_until = datetime.utcnow() + timedelta(minutes=policy["lockoutDurationMinutes"])
        db.commit()
        audit_log("auth.login_failed", {"username": request.username, "reason": "invalid_password"}, db=db, actor_id=user.id, actor_name=user.username, outcome="failure")
        raise HTTPException(status_code=401, detail="Invalid username or password")
    
    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login_at = datetime.utcnow()
    db.commit()
    
    session_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(session_token.encode()).hexdigest()
    
    now = datetime.utcnow()
    # Retain audit events, but prune unusable session records and bound the
    # active sessions per local user. A fifth login revokes the oldest session.
    db.query(SessionModel).filter(SessionModel.expires_at <= now).delete(synchronize_session=False)
    active = db.query(SessionModel).filter(SessionModel.user_id == user.id, SessionModel.revoked_at.is_(None)).order_by(SessionModel.created_at.desc()).all()
    for old in active[4:]:
        old.revoked_at = now
    expires_at = now + timedelta(minutes=policy["sessionTimeoutMinutes"])
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
        actor_id=user.id, actor_name=user.username, db=db,
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
        actor_id=current_user.id, actor_name=current_user.username, db=db,
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
    , authorization: str | None = Header(default=None)
):
    if not verify_password(request.currentPassword, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    
    validate_password(request.newPassword, db)
    current_user.password_hash = hash_password(request.newPassword)
    current_user.must_change_password = False
    current_hash = hashlib.sha256(authorization.partition(" ")[2].encode()).hexdigest() if isinstance(authorization, str) else None
    sessions = db.query(SessionModel).filter(SessionModel.user_id == current_user.id, SessionModel.revoked_at.is_(None))
    if current_hash:
        sessions = sessions.filter(SessionModel.token_hash != current_hash)
    sessions.update({"revoked_at": datetime.utcnow()}, synchronize_session=False)
    db.commit()
    
    audit_log(
        "auth.password_change", {"username": current_user.username},
        actor_id=current_user.id, actor_name=current_user.username, db=db,
    )
    return {"success": True}

async def create_bootstrap_admin(db: Session, username: str, password: str) -> User:
    validate_password(password, db)
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
    
    audit_log("user.bootstrap_created", {"username": username}, actor_id=user.id, actor_name=username, db=db)
    return user
