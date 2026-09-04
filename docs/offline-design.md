# NOC AI Assistant — Offline Design & Data Architecture

## Offline-First Principles

1. **Zero Runtime Dependencies** — No package managers, no auto-updates, no telemetry, no cloud APIs
2. **Bundled Runtimes** — Python, llama.cpp, Node.js all packaged in installer
3. **Local-First Data** — SQLite, file storage, embedded vector search
4. **Air-Gap Verified** — Network isolation tested in clean VM
5. **Graceful Degradation** — Clear errors when resources insufficient

## Data Directory Structure

```
%APPDATA%\NOC AI Assistant\
├── data/
│   ├── nocai.db              # SQLite database (WAL mode)
│   ├── nocai.db-wal          # Write-ahead log
│   ├── nocai.db-shm          # Shared memory
│   └── config.json           # Application settings
├── models/
│   ├── chat/
│   │   ├── qwen2.5-7b-instruct-q4_k_m.gguf
│   │   └── .metadata.json    # Cached model metadata
│   └── embedding/
│       ├── bge-m3-q4_k_m.gguf
│       └── .metadata.json
├── knowledge/
│   ├── collections/
│   │   ├── <collection-uuid>/
│   │   │   ├── source/       # Original uploaded files
│   │   │   ├── extracted/    # Parsed text (JSONL)
│   │   │   └── chunks/       # Chunk metadata (JSONL)
│   │   └── ...
│   └── .processing/          # Temporary ingestion workspace
├── logs/
│   ├── desktop-<date>.log    # Electron main/renderer
│   ├── backend-<date>.log    # FastAPI
│   ├── inference-<date>.log  # llama.cpp
│   ├── ingestion-<date>.log  # Document processing
│   └── audit-<date>.log      # Security audit (append-only)
├── cache/
│   ├── embeddings/           # Cached embeddings (if enabled)
│   └── thumbnails/           # Document previews
├── backups/
│   └── (user-created backups)
└── temp/
    └── (transient files, cleaned on startup)
```

## Database Schema (SQLite)

### Core Tables
```sql
-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Schema version for migrations
CREATE TABLE schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

-- Users
CREATE TABLE users (
    id                    TEXT PRIMARY KEY,           -- UUID
    username              TEXT NOT NULL UNIQUE,
    password_hash         TEXT NOT NULL,              -- Argon2id
    display_name          TEXT,
    email                 TEXT,
    roles                 TEXT NOT NULL DEFAULT '["operator"]',  -- JSON array
    is_active             INTEGER NOT NULL DEFAULT 1,
    must_change_password  INTEGER NOT NULL DEFAULT 0,
    last_login_at         TIMESTAMP,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until          TIMESTAMP,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_active ON users(is_active);

-- Sessions (for token-based auth tracking)
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,           -- UUID
    user_id         TEXT NOT NULL REFERENCES users(id),
    token_hash      TEXT NOT NULL,              -- SHA-256 of session token
    ip_address      TEXT DEFAULT '127.0.0.1',
    user_agent      TEXT,
    expires_at      TIMESTAMP NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at      TIMESTAMP
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Roles (extensible)
CREATE TABLE roles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    permissions TEXT NOT NULL,  -- JSON array of permission strings
    is_system   INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Conversations
CREATE TABLE conversations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    title           TEXT NOT NULL DEFAULT 'New Chat',
    model_id        TEXT REFERENCES models(id),
    collection_id   TEXT REFERENCES collections(id),  -- Active knowledge collection
    system_prompt   TEXT,
    temperature     REAL DEFAULT 0.7,
    max_tokens      INTEGER DEFAULT 4096,
    is_archived     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC);
CREATE INDEX idx_conversations_model ON conversations(model_id);

-- Messages
CREATE TABLE messages (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content             TEXT NOT NULL,
    model_id            TEXT REFERENCES models(id),
    token_count         INTEGER,
    generation_time_ms  INTEGER,
    citations           TEXT,  -- JSON array of Citation objects
    metadata            TEXT,  -- JSON (e.g., retrieval params used)
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_role ON messages(role);

-- Models Registry
CREATE TABLE models (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    filename                TEXT NOT NULL,
    filepath                TEXT NOT NULL,  -- Absolute path
    format                  TEXT NOT NULL DEFAULT 'GGUF',
    size_bytes              INTEGER NOT NULL,
    architecture            TEXT,           -- e.g., 'llama', 'qwen', 'mistral'
    quantization            TEXT,           -- e.g., 'Q4_K_M', 'Q8_0'
    parameter_count         TEXT,           -- e.g., '7B', '14B', '70B'
    context_length          INTEGER DEFAULT 4096,
    role                    TEXT NOT NULL CHECK (role IN ('chat', 'embedding', 'reranker')),
    status                  TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'validating', 'valid', 'invalid', 'active', 'error')),
    validation_error        TEXT,
    metadata                TEXT,           -- JSON (full GGUF metadata)
    hardware_compatibility  TEXT,           -- JSON (RECOMMENDED/COMPATIBLE/LIMITED/NOT_RECOMMENDED/UNSUPPORTED)
    imported_by             TEXT REFERENCES users(id),
    imported_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    activated_at            TIMESTAMP,
    last_used_at            TIMESTAMP
);

CREATE INDEX idx_models_role ON models(role);
CREATE INDEX idx_models_status ON models(status);

-- Model Configurations (runtime params per model)
CREATE TABLE model_configs (
    model_id        TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
    gpu_layers      INTEGER DEFAULT -1,     -- -1 = auto
    threads         INTEGER DEFAULT 0,      -- 0 = auto
    batch_size      INTEGER DEFAULT 512,
    context_length  INTEGER,                -- Override model default
    rope_freq_base  REAL,
    rope_freq_scale REAL,
    extra_args      TEXT,                   -- JSON array of additional llama.cpp args
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Knowledge Collections
CREATE TABLE collections (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    description             TEXT,
    owner_id                TEXT NOT NULL REFERENCES users(id),
    visibility              TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared', 'public')),
    embedding_model_id      TEXT NOT NULL REFERENCES models(id),
    embedding_config        TEXT NOT NULL,  -- JSON (chunk_size, overlap, etc.)
    chunking_config         TEXT NOT NULL,  -- JSON
    document_count          INTEGER NOT NULL DEFAULT 0,
    chunk_count             INTEGER NOT NULL DEFAULT 0,
    total_size_bytes        INTEGER NOT NULL DEFAULT 0,
    status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'reindexing')),
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reindex_required        INTEGER NOT NULL DEFAULT 0,
    reindex_reason          TEXT
);

CREATE INDEX idx_collections_owner ON collections(owner_id);
CREATE INDEX idx_collections_embedding_model ON collections(embedding_model_id);

-- Collection Permissions (ACL)
CREATE TABLE collection_permissions (
    id              TEXT PRIMARY KEY,
    collection_id   TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id),
    permission      TEXT NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
    granted_by      TEXT NOT NULL REFERENCES users(id),
    granted_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(collection_id, user_id)
);

CREATE INDEX idx_coll_perms_user ON collection_permissions(user_id);
CREATE INDEX idx_coll_perms_collection ON collection_permissions(collection_id);

-- Documents
CREATE TABLE documents (
    id                  TEXT PRIMARY KEY,
    collection_id       TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    filename            TEXT NOT NULL,
    original_filename   TEXT NOT NULL,
    filepath            TEXT NOT NULL,  -- Relative to knowledge root
    mime_type           TEXT NOT NULL,
    size_bytes          INTEGER NOT NULL,
    file_hash           TEXT NOT NULL,  -- SHA-256 for deduplication
    page_count          INTEGER,
    language            TEXT,
    status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'validating', 'parsing', 'chunking', 'embedding', 'indexing', 'ready', 'failed', 'disabled')),
    error_message       TEXT,
    chunk_count         INTEGER NOT NULL DEFAULT 0,
    embedded_model_id   TEXT REFERENCES models(id),
    embedded_config     TEXT,           -- JSON (chunk config used)
    uploaded_by         TEXT NOT NULL REFERENCES users(id),
    uploaded_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at        TIMESTAMP,
    disabled_at         TIMESTAMP
);

CREATE INDEX idx_documents_collection ON documents(collection_id);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_hash ON documents(file_hash);

-- Document Chunks (with vector + FTS)
CREATE TABLE chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id   TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    token_count     INTEGER,
    page_start      INTEGER,
    page_end        INTEGER,
    section_title   TEXT,
    metadata        TEXT,  -- JSON
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chunks_document ON chunks(document_id);
CREATE INDEX idx_chunks_collection ON chunks(collection_id);

-- Vector table (sqlite-vec virtual table)
-- Created dynamically per collection or single global table
-- See vector_schema.sql

-- FTS5 virtual table for keyword search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    content,
    document_id UNINDEXED,
    collection_id UNINDEXED,
    chunk_id UNINDEXED,
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts (content, document_id, collection_id, chunk_id)
    VALUES (new.content, new.document_id, new.collection_id, new.id);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE chunk_id = old.id;
    INSERT INTO chunks_fts (content, document_id, collection_id, chunk_id)
    VALUES (new.content, new.document_id, new.collection_id, new.id);
END;

-- Ingestion Jobs
CREATE TABLE ingestion_jobs (
    id                  TEXT PRIMARY KEY,
    document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id       TEXT NOT NULL REFERENCES collections(id),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    priority            INTEGER NOT NULL DEFAULT 4,  -- 1=highest, 5=lowest
    current_stage       TEXT,                        -- validating, parsing, chunking, embedding, indexing
    progress            REAL DEFAULT 0.0,            -- 0.0 to 1.0
    error_message       TEXT,
    started_at          TIMESTAMP,
    completed_at        TIMESTAMP,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_jobs_status ON ingestion_jobs(status, priority, created_at);
CREATE INDEX idx_jobs_document ON ingestion_jobs(document_id);

-- Audit Log (append-only)
CREATE TABLE audit_log (
    id              TEXT PRIMARY KEY,
    timestamp       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id        TEXT REFERENCES users(id),
    actor_name      TEXT,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
    metadata        TEXT,  -- JSON (sanitized)
    ip_address      TEXT NOT NULL DEFAULT '127.0.0.1'
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);

-- Settings (key-value, user-scoped or global)
CREATE TABLE settings (
    key         TEXT NOT NULL,
    user_id     TEXT REFERENCES users(id),  -- NULL = global
    value       TEXT NOT NULL,              -- JSON
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key, user_id)
);
```

### Vector Schema (sqlite-vec)
```sql
-- backend/db/vector_schema.sql
-- Load sqlite-vec extension first: SELECT vec_load_extension();

-- Global chunks vector table (collection_id filters via WHERE)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding FLOAT[768]  -- Dimension matches embedding model (e.g., 768 for BGE-M3, 1024 for E5-large)
);

-- Alternative: Per-collection vector tables (better isolation, more tables)
-- CREATE VIRTUAL TABLE coll_<uuid>_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[768]);

-- Index for fast filtering by collection_id
-- sqlite-vec supports auxiliary columns for filtering
-- See: https://github.com/asg017/sqlite-vec
```

## Configuration Files

### `config.json` (Global Settings)
```json
{
  "version": "1.0.0",
  "dataDir": "%APPDATA%/NOC AI Assistant",
  "modelsDir": "%APPDATA%/NOC AI Assistant/models",
  "knowledgeDir": "%APPDATA%/NOC AI Assistant/knowledge",
  "logsDir": "%APPDATA%/NOC AI Assistant/logs",
  "cacheDir": "%LOCALAPPDATA%/NOC AI Assistant/Cache",
  "backend": {
    "host": "127.0.0.1",
    "port": 0,
    "workers": 1,
    "timeout": 300
  },
  "inference": {
    "defaultChatModelId": null,
    "defaultEmbeddingModelId": null,
    "defaultContextLength": 4096,
    "defaultThreads": 0,
    "defaultGpuLayers": -1,
    "maxConcurrentGenerations": 1
  },
  "knowledge": {
    "defaultChunkSize": 512,
    "defaultChunkOverlap": 50,
    "defaultTopK": 10,
    "enableHybridSearch": true,
    "hybridAlpha": 0.5,
    "enableReranking": false,
    "rerankerModelId": null
  },
  "security": {
    "sessionTimeoutMinutes": 480,
    "maxFailedLogins": 5,
    "lockoutDurationMinutes": 15,
    "passwordMinLength": 12,
    "requireSpecialChars": true
  },
  "ui": {
    "theme": "system",
    "language": "en",
    "sidebarCollapsed": false,
    "compactMode": false
  },
  "advanced": {
    "logLevel": "info",
    "enableTelemetry": false,
    "autoCheckUpdates": false,
    "debugMode": false
  }
}
```

## Model Metadata (`.metadata.json`)
```json
{
  "modelId": "uuid",
  "filename": "qwen2.5-7b-instruct-q4_k_m.gguf",
  "format": "GGUF",
  "sizeBytes": 4783218688,
  "architecture": "qwen2",
  "quantization": "Q4_K_M",
  "parameterCount": "7B",
  "contextLength": 32768,
  "embeddingDimension": null,
  "ggufMetadata": {
    "general.architecture": "qwen2",
    "general.name": "Qwen2.5-7B-Instruct",
    "general.quantization_version": 2,
    "qwen2.attention.head_count": 28,
    "qwen2.attention.head_count_kv": 4,
    "qwen2.block_count": 28,
    "qwen2.embedding_length": 3584,
    "qwen2.feed_forward_length": 18944,
    "qwen2.rotation_count": 28,
    "tokenizer.ggml.model": "qwen2",
    "tokenizer.ggml.tokens": 151936
  },
  "hardwareCompatibility": {
    "status": "RECOMMENDED",
    "estimatedMemoryMB": 5800,
    "estimatedVramMB": 0,
    "warnings": [],
    "reasons": [
      "Model fits comfortably in available system RAM (51 GB available)",
      "CPU inference viable with 8+ threads",
      "Quantization Q4_K_M offers good quality/size tradeoff"
    ]
  },
  "importedAt": "2026-09-04T10:30:00Z",
  "validatedAt": "2026-09-04T10:30:15Z",
  "status": "valid"
}
```

## Hardware Detection & Resource Estimation

### System Information Collection
```python
# backend/system/hardware.py
import psutil
import platform
import subprocess
import json
from dataclasses import dataclass
from typing import Optional

@dataclass
class HardwareInfo:
    # OS
    os_name: str
    os_version: str
    os_build: str
    
    # CPU
    cpu_name: str
    cpu_cores_logical: int
    cpu_cores_physical: int
    cpu_freq_max_mhz: float
    
    # Memory
    total_memory_gb: float
    available_memory_gb: float
    
    # GPU
    gpus: list[GPUInfo]
    
    # Disk
    data_disk_free_gb: float
    data_disk_total_gb: float
    
    # llama.cpp capabilities
    llama_cpp_version: str
    supports_cuda: bool
    supports_vulkan: bool
    supports_metal: bool
    supports_opencl: bool

@dataclass
class GPUInfo:
    name: str
    vendor: str  # NVIDIA, AMD, Intel
    vram_total_gb: float
    vram_free_gb: float
    driver_version: str
    cuda_version: Optional[str]
    vulkan_version: Optional[str]

def detect_hardware() -> HardwareInfo:
    # ... implementation using psutil, GPUtil, wmic, nvidia-smi, etc.
    pass

def estimate_model_requirements(model_path: str, hardware: HardwareInfo) -> ResourceEstimate:
    """Estimate memory/VRAM needs for a GGUF model."""
    import gguf
    
    reader = gguf.GGUFReader(model_path)
    metadata = {k: v for k, v in reader.get_all_metadata().items()}
    
    # Extract key metadata
    arch = metadata.get('general.architecture', ['unknown'])[0]
    quant = metadata.get('general.quantization_version', [0])[0]
    n_params = metadata.get('general.parameter_count', [0])[0]
    n_layers = metadata.get(f'{arch}.block_count', [0])[0]
    embed_dim = metadata.get(f'{arch}.embedding_length', [0])[0]
    
    # File size based estimation
    file_size_mb = Path(model_path).stat().st_size / (1024 * 1024)
    
    # Quantization bits per parameter (approximate)
    quant_bits = {
        'Q2_K': 2.5, 'Q3_K': 3.5, 'Q4_K': 4.5, 'Q5_K': 5.5, 'Q6_K': 6.5,
        'Q4_0': 4.0, 'Q4_1': 4.1, 'Q5_0': 5.0, 'Q5_1': 5.1,
        'Q8_0': 8.0, 'F16': 16.0, 'F32': 32.0,
    }.get(str(quant), 4.5)
    
    # Base model memory (weights)
    weight_memory_mb = file_size_mb * 1.1  # mmap overhead
    
    # KV cache estimation (per context token)
    # 2 * layers * embed_dim * 2 bytes (FP16) per token
    kv_per_token_mb = (2 * n_layers * embed_dim * 2) / (1024 * 1024)
    
    # Context memory for default 4K context
    context_tokens = 4096
    kv_memory_mb = kv_per_token_mb * context_tokens
    
    # Total system RAM estimate
    total_ram_mb = weight_memory_mb + kv_memory_mb + 500  # 500MB overhead
    
    # GPU offload estimation
    gpu_offload_possible = any(g.vram_free_gb * 1024 > weight_memory_mb for g in hardware.gpus)
    
    return ResourceEstimate(
        model_size_mb=file_size_mb,
        estimated_ram_mb=total_ram_mb,
        estimated_vram_mb=weight_memory_mb if gpu_offload_possible else 0,
        kv_cache_mb_per_1k_tokens=kv_per_token_mb * 1000,
        compatibility=assess_compatibility(total_ram_mb, hardware),
        warnings=generate_warnings(total_ram_mb, hardware, gpu_offload_possible),
    )
```

## Migration Strategy

### Migration Framework
```python
# backend/db/migrations.py
MIGRATIONS = [
    (1, "Initial schema", "sql/001_initial_schema.sql"),
    (2, "Add vector tables", "sql/002_vector_tables.sql"),
    (3, "Add collection permissions", "sql/003_collection_permissions.sql"),
    (4, "Add model configs", "sql/004_model_configs.sql"),
    (5, "Add audit log", "sql/005_audit_log.sql"),
    # ... future migrations
]

async def run_migrations(db: Database) -> None:
    current = await db.fetchone("SELECT MAX(version) FROM schema_version") or 0
    
    for version, description, sql_file in MIGRATIONS:
        if version <= current:
            continue
        
        print(f"Applying migration {version}: {description}")
        
        # Backup before migration
        await backup_database(db, f"pre_migration_{version}.db")
        
        # Read and execute SQL
        sql = Path(sql_file).read_text()
        await db.execute_script(sql)
        
        # Record version
        await db.execute(
            "INSERT INTO schema_version (version, description) VALUES (?, ?)",
            (version, description)
        )
        
        print(f"Migration {version} complete")
```

## Backup & Restore

### Backup Format (ZIP)
```
nocai-backup-<timestamp>.zip
├── manifest.json          # Metadata: version, timestamp, tables included
├── nocai.db               # Full SQLite dump (or .sql)
├── config.json            # Settings
├── models/                # Optional: model files (configurable)
│   └── <model-uuid>.gguf
├── knowledge/             # Optional: source documents (configurable)
│   └── <collection-uuid>/
│       └── source/
└── metadata/
    ├── users.json
    ├── collections.json
    └── models.json
```

### Restore Validation
```python
async def validate_backup(backup_path: Path) -> BackupValidationResult:
    with zipfile.ZipFile(backup_path) as zf:
        # 1. Check manifest exists
        if 'manifest.json' not in zf.namelist():
            return BackupValidationResult(valid=False, error="Missing manifest")
        
        manifest = json.loads(zf.read('manifest.json'))
        
        # 2. Check version compatibility
        if not is_version_compatible(manifest['version'], CURRENT_VERSION):
            return BackupValidationResult(
                valid=False, 
                error=f"Backup version {manifest['version']} incompatible with {CURRENT_VERSION}"
            )
        
        # 3. Verify database integrity
        db_content = zf.read('nocai.db')
        if not await verify_sqlite_integrity(db_content):
            return BackupValidationResult(valid=False, error="Database corruption detected")
        
        # 4. Check for path traversal in zip
        for name in zf.namelist():
            if '..' in name or name.startswith('/'):
                return BackupValidationResult(valid=False, error="Path traversal in backup")
        
        return BackupValidationResult(valid=True, manifest=manifest)

async def restore_backup(backup_path: Path, options: RestoreOptions) -> RestoreResult:
    validation = await validate_backup(backup_path)
    if not validation.valid:
        raise ValueError(validation.error)
    
    # 1. Stop backend
    await backend_manager.stop()
    
    # 2. Backup current state
    current_backup = await create_backup(BackupOptions(include_models=False))
    
    try:
        # 3. Extract and replace
        with zipfile.ZipFile(backup_path) as zf:
            zf.extractall(data_dir)
        
        # 4. Run migrations if needed
        await run_migrations(db)
        
        # 5. Restart backend
        await backend_manager.start()
        
        return RestoreResult(success=True, previous_backup=current_backup)
    except Exception as e:
        # Rollback
        await restore_backup_internal(current_backup.path)
        raise
```

---
*Generated during Phase 1 — Architecture*