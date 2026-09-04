from sqlalchemy.orm import Session
from backend.db.models import AuditLog
from backend.config import get_settings
import json
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

SENSITIVE_FIELDS = {
    'password', 'password_hash', 'token', 'session_token',
    'authorization', 'cookie', 'secret', 'key', 'credential',
    'api_key', 'access_token', 'refresh_token', 'private_key',
}

def sanitize_metadata(data: dict) -> dict:
    if not isinstance(data, dict):
        return data
    return {
        k: sanitize_metadata(v) 
        for k, v in data.items() 
        if k.lower() not in SENSITIVE_FIELDS
    }

def audit_log(
    action: str,
    metadata: dict = None,
    actor_id: str = None,
    actor_name: str = None,
    resource_type: str = None,
    resource_id: str = None,
    outcome: str = "success",
    db: Session = None
):
    if db is None:
        settings = get_settings()
        from backend.db.database import get_session_factory
        SessionLocal = get_session_factory(settings.database_url)
        db = SessionLocal()
        should_close = True
    else:
        should_close = False
    
    try:
        entry = AuditLog(
            action=action,
            actor_id=actor_id,
            actor_name=actor_name,
            resource_type=resource_type,
            resource_id=resource_id,
            outcome=outcome,
            audit_metadata=sanitize_metadata(metadata or {}),
            ip_address="127.0.0.1",
        )
        db.add(entry)
        db.commit()
    except Exception as e:
        logger.error(f"Audit log failed: {e}")
        db.rollback()
    finally:
        if should_close:
            db.close()


async def get_audit_db():
    settings = get_settings()
    from backend.db.database import get_session_factory
    SessionLocal = get_session_factory(settings.database_url)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
