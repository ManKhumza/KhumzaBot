"""Test that audit_log correctly uses audit_metadata column."""

import tempfile
import os
from pathlib import Path
import uuid


def test_audit_log_uses_audit_metadata_column(tmp_path):
    """Audit log: metadata parameter maps to audit_metadata column."""
    db_path = tmp_path / "test.db"
    os.environ["NOC_AI_DATABASE_URL"] = f"sqlite:///{db_path}"
    os.environ["NOC_AI_DATA_DIR"] = str(tmp_path)
    os.environ["NOC_AI_MODELS_DIR"] = str(tmp_path / "models")
    os.environ["NOC_AI_KNOWLEDGE_DIR"] = str(tmp_path / "knowledge")
    os.environ["NOC_AI_LOGS_DIR"] = str(tmp_path / "logs")
    os.environ["NOC_AI_SESSION_TOKEN"] = "test-secret"

    from backend.config import get_settings
    from backend.db.database import create_db_engine, get_session_factory
    from backend.db.models import Base, AuditLog, User
    from backend.db.database import Database

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    engine = create_db_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)

    SessionLocal = get_session_factory(engine)
    
    # Create a user first to satisfy foreign key
    user_id = str(uuid.uuid4())
    with SessionLocal() as session:
        user = User(id=user_id, username="testuser", password_hash="hash", roles=["user"])
        session.add(user)
        session.commit()

    db = Database(SessionLocal)

    # Test audit_log with metadata
    db.audit_log("test_action", metadata={"key": "value"}, actor_id=user_id, actor_name="testuser")

    # Verify it was stored in audit_metadata column
    with SessionLocal() as session:
        entry = session.query(AuditLog).first()
        assert entry is not None
        assert entry.action == "test_action"
        assert entry.actor_name == "testuser"
        assert entry.audit_metadata == {"key": "value"}

    get_settings.cache_clear()
    create_db_engine.cache_clear()