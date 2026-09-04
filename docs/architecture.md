# NOC AI Assistant — Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    NOC AI Assistant                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Electron Desktop Shell (React + TypeScript)         │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │   │
│  │  │   Renderer  │ │  Preload    │ │   Main      │    │   │
│  │  │  (UI/UX)    │ │  (IPC API)  │ │  (Lifecycle)│    │   │
│  │  └─────────────┘ └─────────────┘ └─────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                   │
│                    Secure IPC                                │
│                          │                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Local Backend (FastAPI — Packaged Executable)       │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │   │
│  │  │  Auth    │ │  Chat    │ │ Knowledge│ │ Models │  │   │
│  │  │  /RBAC   │ │  /Queue  │ │  /RAG    │ │ /LLM   │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘  │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐             │   │
│  │  │  Jobs    │ │  Audit   │ │  Health  │             │   │
│  │  └──────────┘ └──────────┘ └──────────┘             │   │
│  └─────────────────────────────────────────────────────┘   │
│         │              │              │                      │
│         ▼              ▼              ▼                      │
│  ┌──────────┐   ┌────────────┐ ┌──────────┐                │
│  │  SQLite  │   │  Vector    │ │ llama.cpp│                │
│  │  (WAL)   │   │  (sqlite-vec)       │                │
│  └──────────┘   └────────────┘ └──────────┘                │
│                                              │               │
│                                      Local Models            │
│                                      (GGUF files)            │
└─────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Layer | Technology | Version Strategy |
|-------|------------|------------------|
| Desktop Shell | Electron | Latest stable LTS |
| UI Framework | React 18 + TypeScript 5 | Pinned in package.json |
| Styling | CSS Modules + CSS Variables | No runtime dependencies |
| Backend | FastAPI (Python 3.11+) | Bundled via PyInstaller |
| Database | SQLite 3 (WAL mode) | Embedded |
| Vector Search | sqlite-vec extension | Bundled/Compiled |
| Full-Text Search | SQLite FTS5 | Built-in |
| LLM Inference | llama.cpp | Bundled binary |
| Model Format | GGUF | Primary supported format |
| Embeddings | GGUF embedding models | Via llama.cpp |
| Password Hashing | Argon2id (passlib) | Industry standard |
| Packaging | electron-builder + NSIS | Windows installer |

## Core Architectural Decisions (ADRs)

### ADR-001: Electron over Tauri/Wails
**Status:** Accepted  
**Context:** Need predictable Windows packaging, mature ecosystem, reliable offline distribution.  
**Decision:** Electron with security hardening (contextIsolation, sandbox, strict CSP).  
**Consequences:** Larger binary (~100MB+) but reliable Windows installer generation and extensive ecosystem.

### ADR-002: FastAPI Backend as Packaged Executable
**Status:** Accepted  
**Context:** Python ecosystem for ML/RAG is superior; users must not install Python.  
**Decision:** Package FastAPI + dependencies via PyInstaller into single executable; Electron manages lifecycle.  
**Consequences:** Backend startup latency (~2-3s); need health checks; IPC security critical.

### ADR-003: SQLite + sqlite-vec for Vector Storage
**Status:** Accepted  
**Context:** Must avoid separate vector database (no Docker, no separate services).  
**Decision:** Use sqlite-vec extension for embedded vector search; FTS5 for keyword search; hybrid RRF fusion.  
**Consequences:** Need to compile/embed sqlite-vec; limited to ~1M vectors practical limit; sufficient for desktop use.

### ADR-004: llama.cpp as Primary Inference Engine
**Status:** Accepted  
**Context:** Best GGUF support, CPU/GPU offload, active development, C API for embedding.  
**Decision:** Bundle llama.cpp; use Python bindings (llama-cpp-python) in backend; abstract behind provider interface.  
**Consequences:** Must bundle platform-specific binaries (CUDA, Vulkan, CPU); manage model lifecycle carefully.

### ADR-005: Loopback-Only Backend with Session Tokens
**Status:** Accepted  
**Context:** Security requirement — no trust for localhost traffic.  
**Decision:** Backend binds to 127.0.0.1:random_port; Electron generates cryptographically random session token at startup; token passed via --token arg + env var; all privileged requests require Authorization: Bearer <token>.  
**Consequences:** Adds complexity to IPC; prevents other local processes from accessing API.

### ADR-006: Argon2id for Password Hashing
**Status:** Accepted  
**Context:** Modern, memory-hard, resistant to GPU cracking.  
**Decision:** Use passlib with argon2; configurable memory/time parameters; never log passwords.  
**Consequences:** Requires argon2-cffi dependency (bundled in backend).

### ADR-007: RBAC with Explicit Capabilities
**Status:** Accepted  
**Context:** Roles (Admin, Knowledge Manager, Operator) must map to fine-grained permissions.  
**Decision:** Permission = resource:action (e.g., "models:import", "knowledge:write"); roles aggregate permissions; check at API layer + UI gating.  
**Consequences:** More boilerplate but auditable and extensible.

### ADR-008: Data Locations
**Status:** Accepted  
**Decision:**
- Application binaries: `%LOCALAPPDATA%\NOC AI Assistant\app-<version>\` (per-user install via electron-builder NSIS)
- Persistent data: `%APPDATA%\NOC AI Assistant\` (database, config, logs)
- Models: `%APPDATA%\NOC AI Assistant\models\` (copied/linked GGUF files)
- Knowledge sources: `%APPDATA%\NOC AI Assistant\knowledge\` (original documents)
- Cache/Temp: `%LOCALAPPDATA%\NOC AI Assistant\Cache\`
- Backups: User-selected location

### ADR-009: Model Lifecycle States
**Status:** Accepted  
**States:** `NOT_LOADED` → `STARTING` → `READY` → `BUSY` → `STOPPING` → `NOT_LOADED`; `FAILED` terminal.  
**Decision:** Backend owns lifecycle; exposes status via API; SSE for real-time updates; queue manages concurrent requests.

### ADR-010: Inference Queue with Priority
**Status:** Accepted  
**Priority Levels:**
1. Interactive chat (streaming)
2. Knowledge retrieval (RAG)
3. Small embedding jobs
4. Bulk ingestion
5. Re-indexing/maintenance

**Decision:** Async queue in backend; workers pull by priority; cancellation tokens per request.

### ADR-011: Deterministic Citations
**Status:** Accepted  
**Decision:** Retrieval engine returns structured citation metadata; LLM prompt instructs to use only provided sources; UI renders citations from retrieval metadata, not generated text.  
**Consequences:** Prompt engineering critical; citation format fixed in API contract.

### ADR-012: Permission-Aware Retrieval (Pre-Filter)
**Status:** Accepted  
**Decision:** ACL evaluation happens BEFORE vector/FTS search; SQL WHERE clause filters by user permissions; no post-filtering of retrieved chunks.  
**Consequences:** Requires permission metadata on every chunk/document; indexes must support filtered search.

### ADR-013: No Cloud Dependencies
**Status:** Accepted  
**Decision:** Zero outbound network calls at runtime. No telemetry, auto-updates, remote fonts, CDN assets, model downloads, HF Hub calls.  
**Consequences:** All assets bundled; model import only from local filesystem; manual update process.

## Data Flow Summary

### Chat Request (Knowledge Mode)
```
User Message
    │
    ▼
Electron Renderer → Preload IPC → Electron Main
    │
    ▼
HTTP POST /api/v1/chat/completions (Bearer token)
    │
    ▼
FastAPI: Auth → RBAC → Rate Limit
    │
    ▼
Chat Service: Build context (history + RAG)
    │
    ├─► Retrieval Service: ACL filter → Vector + FTS → RRF → Rerank → Top-K
    │       │
    │       ▼
    │   Citation metadata attached
    │
    ▼
Inference Queue (Priority 1)
    │
    ▼
llama.cpp: Stream tokens via callback
    │
    ▼
SSE back to Electron → Renderer streams to UI
    │
    ▼
Persist message + citations to SQLite
```

### Document Ingestion
```
Upload Files
    │
    ▼
POST /api/v1/documents (multipart)
    │
    ▼
FastAPI: Validate → Save to knowledge/ → Create Job (Priority 4)
    │
    ▼
Job Worker: Parse → Extract Text → Chunk → Embed (llama.cpp) → Store vectors + FTS
    │
    ▼
Update status: QUEUED → PARSING → CHUNKING → EMBEDDING → INDEXING → READY/FAILED
    │
    ▼
SSE progress updates to UI
```

## Security Boundaries

```
┌────────────────────────────────────────────────────────────┐
│                      TRUST BOUNDARIES                       │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐      ┌─────────────┐      ┌────────────┐  │
│  │  Renderer   │◄────►│   Preload   │◄────►│   Main     │  │
│  │  (Untrusted)│      │  (Trusted)  │      │  (Trusted) │  │
│  └─────────────┘      └─────────────┘      └────────────┘  │
│        │                     │                    │          │
│        │   contextBridge    │   IPC (validated)  │          │
│        │   (expose only     │   (schema-checked) │          │
│        │    safe APIs)      │                    │          │
│        ▼                     ▼                    ▼          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Local Backend (127.0.0.1:port)         │    │
│  │  ┌─────────────────────────────────────────────┐   │    │
│  │  │ Authorization: Bearer <session-token>       │   │    │
│  │  │ Required on ALL endpoints except /health    │   │    │
│  │  └─────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Offline-First Guarantees

| Capability | Offline Status | Implementation |
|------------|----------------|----------------|
| Authentication | ✅ Fully offline | Local SQLite + Argon2id |
| Model inference | ✅ Fully offline | Bundled llama.cpp + local GGUF |
| Embeddings | ✅ Fully offline | GGUF embedding models via llama.cpp |
| Document parsing | ✅ Fully offline | python-pdf, python-docx, etc. bundled |
| Vector search | ✅ Fully offline | sqlite-vec embedded |
| FTS search | ✅ Fully offline | SQLite FTS5 |
| RAG | ✅ Fully offline | Local retrieval + local LLM |
| Model import | ✅ Fully offline | Local filesystem scan |
| Settings/Config | ✅ Fully offline | Local JSON/SQLite |
| Updates | ❌ Manual only | User downloads new installer |

## Performance Targets

| Metric | Target |
|--------|--------|
| Cold start (launch to UI ready) | < 5 seconds |
| Backend health check | < 2 seconds |
| Model load (7B Q4_K_M) | < 10 seconds |
| First token (chat) | < 2 seconds |
| Embedding (single doc) | < 500ms |
| Vector search (10K chunks) | < 200ms |
| Hybrid search + rerank | < 500ms |
| Memory idle (no model loaded) | < 500MB |
| Memory (7B model loaded) | ~6-8GB |

## Extension Points (Future-Proofing)

| Area | Abstraction | Future Support |
|------|-------------|----------------|
| Inference | `InferenceProvider` protocol | vLLM, ONNX Runtime, TensorRT-LLM |
| Embeddings | `EmbeddingProvider` protocol | Sentence Transformers, BGE, E5 |
| Vector DB | `VectorStore` interface | Qdrant, Chroma, pgvector (server mode) |
| Auth | `AuthProvider` interface | LDAP, OIDC, SAML (server edition) |
| Storage | `StorageBackend` interface | PostgreSQL, encrypted SQLite |
| Model Format | `ModelLoader` plugin | Safetensors, ONNX, MLX |

---
*Generated during Phase 1 — Architecture*