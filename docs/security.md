# NOC AI Assistant — Security Architecture

## Threat Model

### Assets to Protect
1. **User credentials** — Argon2id hashes, session tokens
2. **Chat history** — Conversations, messages, citations
3. **Knowledge base** — Documents, embeddings, metadata
4. **Models** — GGUF files (IP-sensitive)
5. **Audit logs** — Security-relevant events
6. **System integrity** — Application binaries, configuration

### Threat Actors
| Actor | Capability | Motivation |
|-------|------------|------------|
| Local user (non-admin) | Read/write own files, run processes | Access other users' data, escalate privileges |
| Local admin | Full system access | Extract models, data, credentials |
| Malicious document | Parsed by ingestion pipeline | Code execution, path traversal, DoS |
| Compromised renderer | XSS, prototype pollution | Escape sandbox, access Node APIs |
| Network attacker | None (air-gapped) | N/A — verified zero outbound |

### Trust Boundaries
```
┌─────────────────────────────────────────────────────────────┐
│                    USER WORKSTATION                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ NOC AI Assistant Process Tree                        │    │
│  │                                                      │    │
│  │  Electron Main (Trusted)                             │    │
│  │    │                                                 │    │
│  │    ├── Preload (Trusted) ◄── contextBridge ──►      │    │
│  │    │                         Renderer (Untrusted)   │    │
│  │    │                                                 │    │
│  │    └── Backend Process (Trusted)                     │    │
│  │         │                                            │    │
│  │         ├── llama.cpp (Sandboxed child)              │    │
│  │         ├── SQLite (File-based)                      │    │
│  │         └── File System (App data dirs)              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Electron Security Configuration

### Main Process (`electron/main.ts`)
```typescript
// Security-hardened BrowserWindow options
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,           // Mandatory
    nodeIntegration: false,           // Mandatory
    sandbox: true,                    // Mandatory
    preload: path.join(__dirname, 'preload.js'),
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableRemoteModule: false,
    spellcheck: false,
  },
  // Navigation restrictions
  // Handled via webContents events below
});

// Block all navigation except explicit allow-list
mainWindow.webContents.on('will-navigate', (e, url) => {
  if (!ALLOWED_URLS.includes(url)) e.preventDefault();
});

// Block new-window creation
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  if (ALLOWED_EXTERNAL_URLS.includes(url)) {
    shell.openExternal(url);
  }
  return { action: 'deny' };
});

// Disable downloads outside app
session.defaultSession.setDownloadHandler((item, webContents) => {
  // Only allow explicit user-initiated exports
});

// Strict CSP
mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +  // CSS modules need inline
        "img-src 'self' data: blob:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' http://127.0.0.1:*; " +  // Backend API
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'none';"
      ],
    },
  });
});
```

### Preload Script (`electron/preload.ts`)
```typescript
// Minimal, typed IPC surface
interface NocAIAPI {
  // Auth
  auth: {
    login: (credentials: LoginRequest) => Promise<AuthResult>;
    logout: () => Promise<void>;
    getSession: () => Promise<Session | null>;
    changePassword: (req: ChangePasswordRequest) => Promise<void>;
  };
  
  // Chat
  chat: {
    sendMessage: (req: ChatRequest) => Promise<AsyncIterable<ChatChunk>>;
    stopGeneration: (requestId: string) => Promise<void>;
    getConversations: () => Promise<Conversation[]>;
    createConversation: (title?: string) => Promise<Conversation>;
    deleteConversation: (id: string) => Promise<void>;
    renameConversation: (id: string, title: string) => Promise<void>;
  };
  
  // Models
  models: {
    scanDirectory: (path: string) => Promise<ModelScanResult>;
    importModel: (req: ImportModelRequest) => Promise<Model>;
    listModels: (role?: ModelRole) => Promise<Model[]>;
    activateModel: (id: string, role: ModelRole) => Promise<void>;
    deactivateModel: (id: string) => Promise<void>;
    deleteModel: (id: string) => Promise<void>;
    getHardwareInfo: () => Promise<HardwareInfo>;
    estimateModelRequirements: (path: string) => Promise<ResourceEstimate>;
  };
  
  // Knowledge
  knowledge: {
    listCollections: () => Promise<Collection[]>;
    createCollection: (req: CreateCollectionRequest) => Promise<Collection>;
    deleteCollection: (id: string) => Promise<void>;
    uploadDocuments: (collectionId: string, files: File[]) => Promise<Document[]>;
    listDocuments: (collectionId: string) => Promise<Document[]>;
    deleteDocument: (id: string) => Promise<void>;
    reprocessDocument: (id: string) => Promise<void>;
    search: (req: SearchRequest) => Promise<SearchResult>;
  };
  
  // Admin (RBAC-gated on backend)
  admin: {
    listUsers: () => Promise<User[]>;
    createUser: (req: CreateUserRequest) => Promise<User>;
    updateUser: (id: string, req: UpdateUserRequest) => Promise<User>;
    deleteUser: (id: string) => Promise<void>;
    listRoles: () => Promise<Role[]>;
    getAuditLog: (filter: AuditFilter) => Promise<AuditEntry[]>;
    getJobs: (filter: JobFilter) => Promise<Job[]>;
    getHealth: () => Promise<HealthStatus>;
    restartBackend: () => Promise<void>;
  };
  
  // Settings
  settings: {
    get: () => Promise<Settings>;
    update: (partial: Partial<Settings>) => Promise<Settings>;
  };
  
  // System
  system: {
    getVersion: () => Promise<string>;
    getDataPaths: () => Promise<DataPaths>;
    createBackup: (options: BackupOptions) => Promise<BackupResult>;
    restoreBackup: (path: string) => Promise<RestoreResult>;
  };
  
  // Events (Main → Renderer)
  onModelStatusChange: (callback: (status: ModelStatus) => void) => () => void;
  onJobProgress: (callback: (progress: JobProgress) => void) => () => void;
  onBackendStatusChange: (callback: (status: BackendStatus) => void) => () => void;
}

// Expose via contextBridge
contextBridge.exposeInMainWorld('nocai', nocaiAPI);
```

### IPC Validation (Main Process)
```typescript
// Schema validation for every IPC handler
import { z } from 'zod';

const ChatRequestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1).max(100000),
  modelId: z.string().uuid().optional(),
  collectionId: z.string().uuid().optional(),
  stream: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().min(1).max(32768).default(4096),
});

ipcMain.handle('chat:sendMessage', async (event, rawRequest) => {
  const request = ChatRequestSchema.parse(rawRequest);
  // Verify conversation belongs to current user
  const conversation = await db.conversations.find(request.conversationId);
  if (conversation.userId !== getCurrentUserId(event)) {
    throw new Error('FORBIDDEN');
  }
  return backendClient.chat.completions(request);
});
```

## Backend Security

### Authentication Flow
```
┌─────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────┐
│ Electron│────►│  Backend     │────►│  SQLite     │────►│  Response  │
│  Main   │     │  /auth/login │     │  (users)    │     │  (token)   │
└─────────┘     └──────────────┘     └─────────────┘     └────────────┘
      │                                            ▲
      │ 1. Generate session token (256-bit)        │
      │ 2. Send token to backend via --token arg   │
      │ 3. Backend validates token on every request│
      └────────────────────────────────────────────┘
```

### Session Token Generation
```python
# Electron main process (TypeScript)
import { randomBytes } from 'crypto';
const sessionToken = randomBytes(32).toString('hex');  # 256-bit

# Pass to backend via command line + env var
const backendProcess = spawn(backendExe, [
  '--port', '0',           # Dynamic port
  '--token', sessionToken, # Session secret
  '--data-dir', dataDir,
], {
  env: { ...process.env, NOC_AI_SESSION_TOKEN: sessionToken },
  windowsHide: true,       # No console window
});
```

### Backend Token Validation (FastAPI)
```python
# backend/security/auth.py
from fastapi import Depends, HTTPException, Header
from typing import Annotated

SESSION_TOKEN: str = ""  # Set at startup from args/env

async def verify_session_token(
    authorization: Annotated[str | None, Header()] = None
) -> str:
    if not authorization:
        raise HTTPException(401, "Missing Authorization header")
    
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        raise HTTPException(401, "Invalid auth scheme")
    
    if not hmac.compare_digest(token, SESSION_TOKEN):
        # Log failed attempt
        audit_log("auth.token_invalid", {"ip": "127.0.0.1"})
        raise HTTPException(401, "Invalid session token")
    
    return token

# Apply to all protected routes
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in ["/health", "/health/ready"]:
        return await call_next(request)
    
    try:
        await verify_session_token(request.headers.get("Authorization"))
    except HTTPException as e:
        return JSONResponse({"detail": e.detail}, status_code=e.status_code)
    
    return await call_next(request)
```

### Password Hashing (Argon2id)
```python
# backend/auth/password.py
from passlib.hash import argon2

# Configured for desktop: memory=64MB, time=3, parallelism=4
argon2_hasher = argon2.using(
    memory_cost=65536,    # 64 MB
    time_cost=3,          # 3 iterations
    parallelism=4,        # 4 threads
    hash_len=32,
    salt_size=16,
)

def hash_password(password: str) -> str:
    return argon2_hasher.hash(password)

def verify_password(password: str, hash: str) -> bool:
    return argon2_hasher.verify(password, hash)

# Bootstrap admin creation (first run)
async def create_bootstrap_admin(db: Database, username: str, password: str):
    existing = await db.users.find_by_username(username)
    if existing:
        return existing
    
    user = User(
        username=username,
        password_hash=hash_password(password),
        roles=["administrator"],
        is_active=True,
        must_change_password=True,
        created_at=datetime.utcnow(),
    )
    await db.users.create(user)
    audit_log("user.bootstrap_created", {"username": username})
    return user
```

### RBAC Implementation
```python
# backend/security/rbac.py
from enum import Enum
from dataclasses import dataclass
from typing import Set

class Permission(str, Enum):
    # Models
    MODELS_LIST = "models:list"
    MODELS_IMPORT = "models:import"
    MODELS_ACTIVATE = "models:activate"
    MODELS_DELETE = "models:delete"
    
    # Knowledge
    KNOWLEDGE_LIST = "knowledge:list"
    KNOWLEDGE_CREATE = "knowledge:create"
    KNOWLEDGE_WRITE = "knowledge:write"
    KNOWLEDGE_DELETE = "knowledge:delete"
    KNOWLEDGE_MANAGE_PERMS = "knowledge:manage_perms"
    
    # Chat
    CHAT_CREATE = "chat:create"
    CHAT_READ_OWN = "chat:read_own"
    CHAT_READ_ALL = "chat:read_all"
    CHAT_DELETE_OWN = "chat:delete_own"
    
    # Admin
    ADMIN_USERS = "admin:users"
    ADMIN_ROLES = "admin:roles"
    ADMIN_AUDIT = "admin:audit"
    ADMIN_JOBS = "admin:jobs"
    ADMIN_HEALTH = "admin:health"
    ADMIN_SETTINGS = "admin:settings"
    ADMIN_BACKUP = "admin:backup"

ROLE_PERMISSIONS: dict[str, Set[Permission]] = {
    "administrator": set(Permission),  # All permissions
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
    for role in user.roles:
        user_perms.update(ROLE_PERMISSIONS.get(role, set()))
    return permission in user_perms

# Dependency for FastAPI routes
async def require_permission(
    permission: Permission,
    current_user: Annotated[User, Depends(get_current_user)]
) -> User:
    if not check_permission(current_user, permission):
        audit_log("auth.permission_denied", {
            "user": current_user.username,
            "permission": permission.value,
        })
        raise HTTPException(403, f"Requires {permission.value}")
    return current_user

# Usage on routes
@router.post("/models/import")
async def import_model(
    request: ImportModelRequest,
    user: Annotated[User, Depends(require_permission(Permission.MODELS_IMPORT))],
):
    ...
```

## Permission-Aware RAG (Critical Security Boundary)

### Retrieval with Pre-Filtering
```python
# backend/retrieval/service.py
class RetrievalService:
    def __init__(self, db: Database, vector_store: VectorStore):
        self.db = db
        self.vector_store = vector_store
    
    async def retrieve(
        self,
        query: str,
        user: User,
        collection_ids: list[UUID] | None = None,
        top_k: int = 10,
    ) -> list[RetrievalResult]:
        # 1. Resolve accessible collections for user
        accessible_collections = await self._get_accessible_collections(user, collection_ids)
        
        if not accessible_collections:
            return []
        
        # 2. Build permission filter for SQL
        collection_ids_filter = [str(c.id) for c in accessible_collections]
        
        # 3. Vector search WITH permission filter in WHERE clause
        vector_results = await self.vector_store.search(
            query_embedding=await self.embed(query),
            filter_sql="collection_id IN ({})".format(",".join("?" * len(collection_ids_filter))),
            filter_params=collection_ids_filter,
            top_k=top_k * 2,  # Fetch extra for RRF
        )
        
        # 4. FTS5 keyword search WITH same filter
        fts_results = await self.fts_search(
            query=query,
            collection_ids=collection_ids_filter,
            top_k=top_k * 2,
        )
        
        # 5. Reciprocal Rank Fusion
        fused = self._rrf_fusion(vector_results, fts_results, top_k)
        
        # 6. Optional local reranking (cross-encoder)
        if self.reranker:
            fused = await self.reranker.rerank(query, fused, top_k)
        
        return fused
    
    async def _get_accessible_collections(
        self, 
        user: User, 
        requested: list[UUID] | None
    ) -> list[Collection]:
        # Admin sees all
        if check_permission(user, Permission.KNOWLEDGE_READ_ALL):
            return await self.db.collections.list(ids=requested)
        
        # Otherwise, only collections with explicit grant
        grants = await self.db.collection_perms.list_for_user(user.id)
        granted_ids = {g.collection_id for g in grants}
        
        if requested:
            granted_ids &= set(requested)
        
        return await self.db.collections.list(ids=list(granted_ids))
```

### Document/Chunk Permission Metadata
```sql
-- Every chunk carries collection_id for filtering
CREATE TABLE chunks (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    collection_id TEXT NOT NULL REFERENCES collections(id),
    content     TEXT NOT NULL,
    embedding   BLOB,  -- sqlite-vec vector
    page_num    INTEGER,
    section     TEXT,
    metadata    TEXT,  -- JSON
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Index for permission-filtered vector search
    FOREIGN KEY (collection_id) REFERENCES collections(id)
);

-- Collection permissions
CREATE TABLE collection_permissions (
    id              TEXT PRIMARY KEY,
    collection_id   TEXT NOT NULL REFERENCES collections(id),
    user_id         TEXT NOT NULL REFERENCES users(id),
    permission      TEXT NOT NULL,  -- 'read', 'write', 'admin'
    granted_by      TEXT NOT NULL REFERENCES users(id),
    granted_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(collection_id, user_id)
);
```

## File Handling Security

### Upload Validation
```python
# backend/documents/validation.py
ALLOWED_EXTENSIONS = {'.txt', '.md', '.pdf', '.docx', '.csv', '.html', '.htm'}
MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
MAX_TOTAL_UPLOAD_SIZE = 500 * 1024 * 1024  # 500 MB per request

DANGEROUS_EXTENSIONS = {
    '.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.py', '.js', '.jar',
    '.msi', '.app', '.deb', '.rpm', '.apk', '.ipa', '.scr', '.vbs',
}

def validate_upload(file: UploadFile) -> ValidationResult:
    # 1. Extension check
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return ValidationResult(valid=False, reason=f"Extension {ext} not allowed")
    
    if ext in DANGEROUS_EXTENSIONS:
        return ValidationResult(valid=False, reason="Potentially executable file type")
    
    # 2. MIME type check (python-magic)
    mime = magic.from_buffer(file.file.read(8192), mime=True)
    file.file.seek(0)
    
    allowed_mimes = {
        'text/plain', 'text/markdown', 'text/csv', 'text/html',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
    if mime not in allowed_mimes:
        return ValidationResult(valid=False, reason=f"MIME type {mime} not allowed")
    
    # 3. Size check
    file.file.seek(0, 2)  # Seek to end
    size = file.file.tell()
    file.file.seek(0)
    
    if size > MAX_FILE_SIZE:
        return ValidationResult(valid=False, reason="File exceeds maximum size")
    
    # 4. Path traversal protection
    safe_name = sanitize_filename(file.filename)
    if safe_name != file.filename:
        return ValidationResult(valid=False, reason="Invalid filename")
    
    return ValidationResult(valid=True, safe_name=safe_name)

def sanitize_filename(filename: str) -> str:
    # Remove path components, normalize
    name = Path(filename).name
    # Remove control chars, limit length
    name = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', name)
    return name[:255]
```

### Path Traversal Prevention
```python
# backend/storage/paths.py
from pathlib import Path

APP_DATA_ROOT = Path(os.getenv("NOC_AI_DATA_DIR", "%APPDATA%/NOC AI Assistant")).expanduser()

def resolve_safe_path(user_path: str, base: Path = APP_DATA_ROOT) -> Path:
    """Resolve user-provided path relative to base, preventing traversal."""
    try:
        requested = (base / user_path).resolve()
        base_resolved = base.resolve()
        
        # Ensure requested path is within base
        requested.relative_to(base_resolved)
        return requested
    except (ValueError, OSError):
        raise SecurityError("Path traversal attempt detected")

# Usage: All file operations go through this
async def save_document(collection_id: str, file: UploadFile, safe_name: str):
    collection_dir = resolve_safe_path(f"knowledge/{collection_id}")
    collection_dir.mkdir(parents=True, exist_ok=True)
    
    file_path = resolve_safe_path(safe_name, collection_dir)
    # ... save file
```

## Subprocess Security (llama.cpp)

```python
# backend/inference/runner.py
import subprocess
import shlex

class LlamaCppRunner:
    def __init__(self, model_path: str, config: InferenceConfig):
        self.model_path = Path(model_path).resolve()
        self.config = config
        self._process: subprocess.Popen | None = None
    
    def start(self) -> None:
        # Validate model path is within allowed directory
        models_root = Path(os.getenv("NOC_AI_MODELS_DIR")).resolve()
        self.model_path.relative_to(models_root)  # Raises if outside
        
        # Build command - NO shell=True, NO user input in command
        cmd = [
            str(LLAMA_CPP_BINARY),  # Bundled binary, validated at startup
            "-m", str(self.model_path),
            "-c", str(self.config.context_length),
            "-t", str(self.config.threads),
            "-ngl", str(self.config.gpu_layers),
            "--port", str(self.config.api_port),  # Localhost only
            "--host", "127.0.0.1",
            "--embedding",  # Enable embedding endpoint
        ]
        
        # Windows: CREATE_NO_WINDOW flag
        creationflags = 0
        if os.name == 'nt':
            creationflags = subprocess.CREATE_NO_WINDOW
        
        self._process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
            # No shell, no env inheritance beyond explicit
            env={"PATH": os.getenv("PATH", "")},
        )
        
        # Monitor health
        self._start_health_monitor()
    
    def stop(self, timeout: float = 10.0) -> None:
        if self._process:
            self._process.terminate()
            try:
                self._process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()
            self._process = None
```

## Audit Logging

### Audit Event Schema
```python
# backend/audit/models.py
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import uuid

class AuditAction(str, Enum):
    # Auth
    LOGIN_SUCCESS = "auth.login_success"
    LOGIN_FAILED = "auth.login_failed"
    LOGOUT = "auth.logout"
    PASSWORD_CHANGE = "auth.password_change"
    
    # Users
    USER_CREATED = "user.created"
    USER_UPDATED = "user.updated"
    USER_DELETED = "user.deleted"
    USER_ROLE_CHANGED = "user.role_changed"
    
    # Models
    MODEL_IMPORTED = "model.imported"
    MODEL_ACTIVATED = "model.activated"
    MODEL_DEACTIVATED = "model.deactivated"
    MODEL_DELETED = "model.deleted"
    
    # Knowledge
    COLLECTION_CREATED = "collection.created"
    COLLECTION_DELETED = "collection.deleted"
    DOCUMENT_UPLOADED = "document.uploaded"
    DOCUMENT_DELETED = "document.deleted"
    DOCUMENT_REPROCESSED = "document.reprocessed"
    
    # System
    BACKEND_START = "system.backend_start"
    BACKEND_STOP = "system.backend_stop"
    SETTINGS_CHANGED = "system.settings_changed"
    BACKUP_CREATED = "system.backup_created"
    BACKUP_RESTORED = "system.backup_restored"

@dataclass
class AuditEntry:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=datetime.utcnow)
    actor_id: str | None = None  # User ID or 'system'
    actor_name: str | None = None
    action: AuditAction
    resource_type: str | None = None
    resource_id: str | None = None
    outcome: str  # 'success' | 'failure'
    metadata: dict = field(default_factory=dict)  # Sanitized
    ip_address: str = "127.0.0.1"

# Sanitization: NEVER log these fields
SENSITIVE_FIELDS = {
    'password', 'password_hash', 'token', 'session_token',
    'authorization', 'cookie', 'secret', 'key', 'credential'
}

def sanitize_metadata(data: dict) -> dict:
    """Recursively remove sensitive fields from audit metadata."""
    if not isinstance(data, dict):
        return data
    return {
        k: sanitize_metadata(v) 
        for k, v in data.items() 
        if k.lower() not in SENSITIVE_FIELDS
    }
```

### Audit Log Storage
```sql
CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    timestamp   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id    TEXT REFERENCES users(id),
    actor_name  TEXT,
    action      TEXT NOT NULL,
    resource_type TEXT,
    resource_id   TEXT,
    outcome     TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
    metadata    TEXT,  -- JSON, sanitized
    ip_address  TEXT NOT NULL DEFAULT '127.0.0.1'
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_action ON audit_log(action);

-- Append-only: No UPDATE/DELETE triggers for audit_log
-- Retention: Configurable (default 1 year), admin can export
```

## Network Isolation Verification

### Runtime Network Test
```python
# scripts/verify_network_isolation.py
import psutil
import socket

def verify_no_outbound_connections(pid: int) -> NetworkVerificationResult:
    """Verify the process has no established outbound connections."""
    proc = psutil.Process(pid)
    connections = proc.connections(kind='inet')
    
    violations = []
    for conn in connections:
        if conn.status == 'ESTABLISHED':
            raddr = conn.raddr
            if raddr and raddr.ip != '127.0.0.1' and raddr.ip != '::1':
                violations.append(f"Outbound connection to {raddr.ip}:{raddr.port}")
    
    # Also check listening ports - should only be 127.0.0.1
    for conn in connections:
        if conn.status == 'LISTEN':
            laddr = conn.laddr
            if laddr and laddr.ip not in ('127.0.0.1', '::1'):
                violations.append(f"Listening on non-loopback {laddr.ip}:{laddr.port}")
    
    return NetworkVerificationResult(
        passed=len(violations) == 0,
        violations=violations,
        checked_pid=pid,
        timestamp=datetime.utcnow(),
    )
```

## Security Checklist (Pre-Release)

| Category | Check | Status |
|----------|-------|--------|
| Electron | `contextIsolation: true` | ☐ |
| Electron | `nodeIntegration: false` | ☐ |
| Electron | `sandbox: true` | ☐ |
| Electron | Strict CSP (no unsafe-eval) | ☐ |
| Electron | Navigation blocked | ☐ |
| Electron | New window blocked | ☐ |
| Electron | Preload exposes typed API only | ☐ |
| IPC | All handlers validate with Zod | ☐ |
| IPC | No arbitrary command execution | ☐ |
| Backend | Binds 127.0.0.1 only | ☐ |
| Backend | Dynamic port allocation | ☐ |
| Backend | Session token on all endpoints | ☐ |
| Backend | Token via constant-time compare | ☐ |
| Auth | Argon2id (mem≥64MB, time≥3) | ☐ |
| Auth | Bootstrap admin forces pwd change | ☐ |
| Auth | Session expiry implemented | ☐ |
| RBAC | Permissions checked at API layer | ☐ |
| RBAC | UI hides unauthorized actions | ☐ |
| RAG | ACL filter BEFORE retrieval | ☐ |
| RAG | No post-filter trust | ☐ |
| Files | Extension + MIME validation | ☐ |
| Files | Path traversal prevented | ☐ |
| Files | Size limits enforced | ☐ |
| Subprocess | No `shell=True` | ☐ |
| Subprocess | `CREATE_NO_WINDOW` on Windows | ☐ |
| Subprocess | Bundled binaries only | ☐ |
| Audit | All security events logged | ☐ |
| Audit | No secrets in logs | ☐ |
| Network | Zero outbound at runtime | ☐ |
| Network | Verified in clean VM | ☐ |

---
*Generated during Phase 1 — Architecture*