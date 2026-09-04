from sqlalchemy import (
    create_engine, Column, String, Text, Integer, DateTime, Boolean, 
    ForeignKey, Index, LargeBinary, JSON, event
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from sqlalchemy.pool import StaticPool
import uuid
from datetime import datetime
from typing import Optional
from functools import lru_cache

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = Column(String(100), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    display_name = Column(String(200))
    email = Column(String(255))
    roles = Column(JSON, default=list)
    is_active = Column(Boolean, default=True, index=True)
    must_change_password = Column(Boolean, default=False)
    last_login_at = Column(DateTime)
    failed_login_attempts = Column(Integer, default=0)
    locked_until = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")
    documents = relationship("Document", back_populates="uploader", foreign_keys="Document.uploaded_by")
    audit_logs = relationship("AuditLog", back_populates="actor", foreign_keys="AuditLog.actor_id")

class Session(Base):
    __tablename__ = "sessions"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False)
    ip_address = Column(String(45), default="127.0.0.1")
    user_agent = Column(Text)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    revoked_at = Column(DateTime)
    
    user = relationship("User")

class Role(Base):
    __tablename__ = "roles"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text)
    permissions = Column(JSON, default=list)
    is_system = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Conversation(Base):
    __tablename__ = "conversations"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(500), default="New Chat")
    model_id = Column(String(36), ForeignKey("models.id"))
    collection_id = Column(String(36), ForeignKey("collections.id"))
    system_prompt = Column(Text)
    temperature = Column(Integer, default=70)
    max_tokens = Column(Integer, default=4096)
    is_archived = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at")
    model = relationship("Model", foreign_keys=[model_id], back_populates="conversations_as_chat")
    collection = relationship("Collection", foreign_keys=[collection_id])

class Message(Base):
    __tablename__ = "messages"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id = Column(String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    model_id = Column(String(36), ForeignKey("models.id"))
    token_count = Column(Integer)
    generation_time_ms = Column(Integer)
    citations = Column(JSON, default=list)
    message_metadata = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    conversation = relationship("Conversation", back_populates="messages")
    model = relationship("Model", foreign_keys=[model_id])

class Model(Base):
    __tablename__ = "models"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(200), nullable=False)
    filename = Column(String(500), nullable=False)
    filepath = Column(String(1000), nullable=False)
    format = Column(String(20), default="GGUF")
    size_bytes = Column(Integer, nullable=False)
    architecture = Column(String(100))
    quantization = Column(String(50))
    parameter_count = Column(String(20))
    context_length = Column(Integer, default=4096)
    role = Column(String(20), nullable=False, index=True)
    status = Column(String(20), default="imported", index=True)
    validation_error = Column(Text)
    model_metadata = Column(JSON, default=dict)
    hardware_compatibility = Column(JSON, default=dict)
    imported_by = Column(String(36), ForeignKey("users.id"))
    imported_at = Column(DateTime, default=datetime.utcnow)
    activated_at = Column(DateTime)
    last_used_at = Column(DateTime)
    
    importer = relationship("User", foreign_keys=[imported_by])
    conversations_as_chat = relationship("Conversation", foreign_keys="Conversation.model_id", back_populates="model")
    collections = relationship("Collection", foreign_keys="Collection.embedding_model_id", back_populates="embedding_model")
    documents = relationship("Document", foreign_keys="Document.embedded_model_id", back_populates="embedded_model")
    model_configs = relationship("ModelConfig", back_populates="model", cascade="all, delete-orphan")

class ModelConfig(Base):
    __tablename__ = "model_configs"
    
    model_id = Column(String(36), ForeignKey("models.id", ondelete="CASCADE"), primary_key=True)
    gpu_layers = Column(Integer, default=-1)
    threads = Column(Integer, default=0)
    batch_size = Column(Integer, default=512)
    context_length = Column(Integer)
    rope_freq_base = Column(Integer)
    rope_freq_scale = Column(Integer)
    extra_args = Column(JSON, default=list)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    model = relationship("Model", back_populates="model_configs")

class Collection(Base):
    __tablename__ = "collections"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(200), nullable=False)
    description = Column(Text)
    owner_id = Column(String(36), ForeignKey("users.id"), nullable=False)
    visibility = Column(String(20), default="private")
    embedding_model_id = Column(String(36), ForeignKey("models.id"), nullable=False)
    embedding_config = Column(JSON, nullable=False)
    chunking_config = Column(JSON, nullable=False)
    document_count = Column(Integer, default=0)
    chunk_count = Column(Integer, default=0)
    total_size_bytes = Column(Integer, default=0)
    status = Column(String(20), default="active")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    reindex_required = Column(Boolean, default=False)
    reindex_reason = Column(Text)
    
    owner = relationship("User", foreign_keys=[owner_id])
    embedding_model = relationship("Model", foreign_keys=[embedding_model_id], back_populates="collections")
    documents = relationship("Document", back_populates="collection", cascade="all, delete-orphan")
    chunks = relationship("Chunk", back_populates="collection", cascade="all, delete-orphan")
    permissions = relationship("CollectionPermission", back_populates="collection", cascade="all, delete-orphan")

class CollectionPermission(Base):
    __tablename__ = "collection_permissions"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    collection_id = Column(String(36), ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    permission = Column(String(20), nullable=False)
    granted_by = Column(String(36), ForeignKey("users.id"), nullable=False)
    granted_at = Column(DateTime, default=datetime.utcnow)
    
    collection = relationship("Collection", back_populates="permissions")
    user = relationship("User", foreign_keys=[user_id])
    grantor = relationship("User", foreign_keys=[granted_by])
    
    __table_args__ = (
        Index("ix_collection_permissions_collection_user", "collection_id", "user_id", unique=True),
    )

class Document(Base):
    __tablename__ = "documents"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    collection_id = Column(String(36), ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True)
    filename = Column(String(500), nullable=False)
    original_filename = Column(String(500), nullable=False)
    filepath = Column(String(1000), nullable=False)
    mime_type = Column(String(100), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    file_hash = Column(String(64), nullable=False, index=True)
    page_count = Column(Integer)
    language = Column(String(10))
    status = Column(String(20), default="queued", index=True)
    error_message = Column(Text)
    chunk_count = Column(Integer, default=0)
    embedded_model_id = Column(String(36), ForeignKey("models.id"))
    embedded_config = Column(JSON)
    uploaded_by = Column(String(36), ForeignKey("users.id"), nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    processed_at = Column(DateTime)
    disabled_at = Column(DateTime)
    
    collection = relationship("Collection", back_populates="documents")
    chunks = relationship("Chunk", back_populates="document", cascade="all, delete-orphan")
    uploader = relationship("User", foreign_keys=[uploaded_by], back_populates="documents")
    embedded_model = relationship("Model", foreign_keys=[embedded_model_id], back_populates="documents")
    ingestion_jobs = relationship("IngestionJob", back_populates="document", cascade="all, delete-orphan")

class Chunk(Base):
    __tablename__ = "chunks"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id = Column(String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True)
    collection_id = Column(String(36), ForeignKey("collections.id", ondelete="CASCADE"), nullable=False, index=True)
    chunk_index = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    token_count = Column(Integer)
    page_start = Column(Integer)
    page_end = Column(Integer)
    section_title = Column(String(500))
    chunk_metadata = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    document = relationship("Document", back_populates="chunks")
    collection = relationship("Collection", back_populates="chunks")

class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id = Column(String(36), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    collection_id = Column(String(36), ForeignKey("collections.id"), nullable=False)
    status = Column(String(20), default="pending", index=True)
    priority = Column(Integer, default=4)
    current_stage = Column(String(50))
    progress = Column(Integer, default=0)
    error_message = Column(Text)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    document = relationship("Document", back_populates="ingestion_jobs")

class AuditLog(Base):
    __tablename__ = "audit_log"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    actor_id = Column(String(36), ForeignKey("users.id"), index=True)
    actor_name = Column(String(200))
    action = Column(String(100), nullable=False, index=True)
    resource_type = Column(String(50), index=True)
    resource_id = Column(String(36), index=True)
    outcome = Column(String(20), nullable=False)
    audit_metadata = Column(JSON, default=dict)
    ip_address = Column(String(45), default="127.0.0.1")
    
    actor = relationship("User", foreign_keys=[actor_id])

class SchemaVersion(Base):
    __tablename__ = "schema_version"
    
    version = Column(Integer, primary_key=True)
    applied_at = Column(DateTime, default=datetime.utcnow)
    description = Column(String(500))

class Setting(Base):
    __tablename__ = "settings"
    
    key = Column(String(100), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id"), primary_key=True, nullable=True)
    setting_value = Column(JSON, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user = relationship("User")


@lru_cache(maxsize=4)
def create_db_engine(database_url: str):
    engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
    
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()
    
    return engine


def get_session_factory(engine_or_url):
    """Return sessions bound to the shared engine for a URL."""
    engine = create_db_engine(engine_or_url) if isinstance(engine_or_url, str) else engine_or_url
    return sessionmaker(bind=engine, expire_on_commit=False)


async def init_db(database_url: str):
    engine = create_db_engine(database_url)
    Base.metadata.create_all(engine)
    return engine


async def close_db(engine):
    engine.dispose()
    create_db_engine.cache_clear()


class Database:
    """Database wrapper providing a clean API over SQLAlchemy sessions."""
    
    def __init__(self, session_factory):
        self._session_factory = session_factory
    
    def _get_session(self):
        return self._session_factory()
    
    # User operations
    def get_user(self, user_id: str):
        with self._get_session() as session:
            from backend.db.models import User
            return session.query(User).filter(User.id == user_id).first()
    
    def get_user_by_username(self, username: str):
        with self._get_session() as session:
            from backend.db.models import User
            return session.query(User).filter(User.username == username).first()
    
    def create_user(self, user):
        with self._get_session() as session:
            session.add(user)
            session.commit()
            session.refresh(user)
            return user
    
    def update_user(self, user):
        with self._get_session() as session:
            session.merge(user)
            session.commit()
            return user
    
    # Conversation operations
    def get_conversation(self, conversation_id: str):
        with self._get_session() as session:
            from backend.db.models import Conversation
            return session.query(Conversation).filter(Conversation.id == conversation_id).first()
    
    def get_conversations(self, user_id: str):
        with self._get_session() as session:
            from backend.db.models import Conversation
            return session.query(Conversation).filter(Conversation.user_id == user_id).order_by(Conversation.updated_at.desc()).all()
    
    def create_conversation(self, conversation):
        with self._get_session() as session:
            session.add(conversation)
            session.commit()
            session.refresh(conversation)
            return conversation
    
    def update_conversation(self, conversation):
        with self._get_session() as session:
            session.merge(conversation)
            session.commit()
            return conversation
    
    def delete_conversation(self, conversation_id: str):
        with self._get_session() as session:
            from backend.db.models import Conversation
            conv = session.query(Conversation).filter(Conversation.id == conversation_id).first()
            if conv:
                session.delete(conv)
                session.commit()
    
    # Message operations
    def get_messages(self, conversation_id: str, limit: int = 50, offset: int = 0):
        with self._get_session() as session:
            from backend.db.models import Message
            return session.query(Message).filter(
                Message.conversation_id == conversation_id
            ).order_by(Message.created_at).offset(offset).limit(limit).all()
    
    def create_message(self, message):
        with self._get_session() as session:
            session.add(message)
            session.commit()
            session.refresh(message)
            return message
    
    # Model operations
    def get_model(self, model_id: str):
        with self._get_session() as session:
            from backend.db.models import Model
            return session.query(Model).filter(Model.id == model_id).first()
    
    def get_models(self, role: str = None):
        with self._get_session() as session:
            from backend.db.models import Model
            query = session.query(Model)
            if role:
                query = query.filter(Model.role == role)
            return query.order_by(Model.imported_at.desc()).all()
    
    def create_model(self, model):
        with self._get_session() as session:
            session.add(model)
            session.commit()
            session.refresh(model)
            return model
    
    def update_model(self, model):
        with self._get_session() as session:
            session.merge(model)
            session.commit()
            return model
    
    def delete_model(self, model_id: str):
        with self._get_session() as session:
            from backend.db.models import Model
            model = session.query(Model).filter(Model.id == model_id).first()
            if model:
                session.delete(model)
                session.commit()
    
    def find_model_by_hash(self, file_hash: str):
        with self._get_session() as session:
            from backend.db.models import Model
            return session.query(Model).filter(Model.file_hash == file_hash).first()
    
    def update_model_status(self, model_id: str, status: str, error: str = None):
        with self._get_session() as session:
            from backend.db.models import Model
            model = session.query(Model).filter(Model.id == model_id).first()
            if model:
                model.status = status
                model.validation_error = error
                session.commit()
    
    # Collection operations
    def get_collection(self, collection_id: str):
        with self._get_session() as session:
            from backend.db.models import Collection
            return session.query(Collection).filter(Collection.id == collection_id).first()
    
    def get_collections(self, owner_id: str = None):
        with self._get_session() as session:
            from backend.db.models import Collection
            query = session.query(Collection)
            if owner_id:
                query = query.filter(Collection.owner_id == owner_id)
            return query.all()
    
    def create_collection(self, collection):
        with self._get_session() as session:
            session.add(collection)
            session.commit()
            session.refresh(collection)
            return collection
    
    def update_collection(self, collection):
        with self._get_session() as session:
            session.merge(collection)
            session.commit()
            return collection
    
    def delete_collection(self, collection_id: str):
        with self._get_session() as session:
            from backend.db.models import Collection
            coll = session.query(Collection).filter(Collection.id == collection_id).first()
            if coll:
                session.delete(coll)
                session.commit()
    
    def update_collection_stats(self, collection_id: str, stats: dict):
        with self._get_session() as session:
            from backend.db.models import Collection
            coll = session.query(Collection).filter(Collection.id == collection_id).first()
            if coll:
                for key, value in stats.items():
                    setattr(coll, key, value)
                session.commit()
    
    # Document operations
    def get_document(self, document_id: str):
        with self._get_session() as session:
            from backend.db.models import Document
            return session.query(Document).filter(Document.id == document_id).first()
    
    def get_documents(self, collection_id: str):
        with self._get_session() as session:
            from backend.db.models import Document
            return session.query(Document).filter(Document.collection_id == collection_id).all()
    
    def create_document(self, document):
        with self._get_session() as session:
            session.add(document)
            session.commit()
            session.refresh(document)
            return document
    
    def update_document(self, document):
        with self._get_session() as session:
            session.merge(document)
            session.commit()
            return document
    
    def delete_document(self, document_id: str):
        with self._get_session() as session:
            from backend.db.models import Document
            doc = session.query(Document).filter(Document.id == document_id).first()
            if doc:
                session.delete(doc)
                session.commit()
    
    def find_document_by_hash(self, file_hash: str):
        with self._get_session() as session:
            from backend.db.models import Document
            return session.query(Document).filter(Document.file_hash == file_hash).first()
    
    # Chunk operations
    def get_chunk(self, chunk_id: str):
        with self._get_session() as session:
            from backend.db.models import Chunk
            return session.query(Chunk).filter(Chunk.id == chunk_id).first()
    
    def get_chunks(self, document_id: str):
        with self._get_session() as session:
            from backend.db.models import Chunk
            return session.query(Chunk).filter(Chunk.document_id == document_id).all()
    
    def list_chunks_by_document(self, document_id: str):
        return self.get_chunks(document_id)
    
    def create_chunk(self, chunk):
        with self._get_session() as session:
            session.add(chunk)
            session.commit()
            session.refresh(chunk)
            return chunk
    
    def get_collection_stats(self, collection_id: str):
        with self._get_session() as session:
            from backend.db.models import Chunk, Document
            from sqlalchemy import func
            chunk_count = session.query(func.count(Chunk.id)).filter(Chunk.collection_id == collection_id).scalar()
            doc_count = session.query(func.count(Document.id)).filter(Document.collection_id == collection_id).scalar()
            total_size = session.query(func.sum(Document.size_bytes)).filter(Document.collection_id == collection_id).scalar() or 0
            return {
                "document_count": doc_count or 0,
                "chunk_count": chunk_count or 0,
                "total_size_bytes": total_size or 0,
            }
    
    def update_collection_stats(self, collection_id: str, stats: dict):
        with self._get_session() as session:
            from backend.db.models import Collection
            coll = session.query(Collection).filter(Collection.id == collection_id).first()
            if coll:
                for key, value in stats.items():
                    setattr(coll, key, value)
                session.commit()
    
    # Collection permission operations
    def get_collection_permissions(self, collection_id: str):
        with self._get_session() as session:
            from backend.db.models import CollectionPermission
            return session.query(CollectionPermission).filter(
                CollectionPermission.collection_id == collection_id
            ).all()
    
    def get_collection_permission(self, collection_id: str, user_id: str):
        with self._get_session() as session:
            from backend.db.models import CollectionPermission
            return session.query(CollectionPermission).filter(
                CollectionPermission.collection_id == collection_id,
                CollectionPermission.user_id == user_id
            ).first()
    
    def create_collection_permission(self, permission):
        with self._get_session() as session:
            session.add(permission)
            session.commit()
            session.refresh(permission)
            return permission
    
    def update_collection_permission(self, permission):
        with self._get_session() as session:
            session.merge(permission)
            session.commit()
            return permission
    
    def list_collection_perms_for_user(self, user_id: str):
        with self._get_session() as session:
            from backend.db.models import CollectionPermission
            return session.query(CollectionPermission).filter(
                CollectionPermission.user_id == user_id
            ).all()
    
    # Ingestion job operations
    def create_ingestion_job(self, job):
        with self._get_session() as session:
            session.add(job)
            session.commit()
            session.refresh(job)
            return job
    
    def get_ingestion_job(self, job_id: str):
        with self._get_session() as session:
            from backend.db.models import IngestionJob
            return session.query(IngestionJob).filter(IngestionJob.id == job_id).first()
    
    def list_ingestion_jobs(self, status: str = None, priority: int = None, limit: int = 100, offset: int = 0):
        with self._get_session() as session:
            from backend.db.models import IngestionJob
            query = session.query(IngestionJob)
            if status:
                query = query.filter(IngestionJob.status == status)
            if priority:
                query = query.filter(IngestionJob.priority == priority)
            return query.order_by(IngestionJob.created_at.desc()).offset(offset).limit(limit).all()
    
    def update_ingestion_job(self, job):
        with self._get_session() as session:
            session.merge(job)
            session.commit()
            return job
    
    # Audit operations
    def audit_log(self, action: str, metadata: dict = None, actor_id: str = None, actor_name: str = None, 
                  resource_type: str = None, resource_id: str = None, outcome: str = "success"):
        with self._get_session() as session:
            from backend.db.models import AuditLog
            import uuid
            entry = AuditLog(
                id=str(uuid.uuid4()),
                action=action,
                actor_id=actor_id,
                actor_name=actor_name,
                resource_type=resource_type,
                resource_id=resource_id,
                outcome=outcome,
                audit_metadata=metadata or {},
                ip_address="127.0.0.1",
            )
            session.add(entry)
            session.commit()
