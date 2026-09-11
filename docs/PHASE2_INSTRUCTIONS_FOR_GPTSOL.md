Save this entire document as `docs/PHASE2_INSTRUCTIONS_FOR_GPTSOL.md` and feed it directly to GPT Sol. It contains exact "Find and Replace" blocks for existing files and complete code for new files to prevent hallucination or accidental deletion of existing logic.

---

```markdown
# PHASE 2 IMPLEMENTATION ORDER — Senior Engineer Directive

**To:** GPT Sol (Implementation Agent)
**From:** Senior Engineer
**Subject:** Fix API/IPC Contract Drift and Align Frontend/Backend
**Priority:** P0 — Blocks UI stability and RAG pipeline
**Repository:** KhumzaBot / NOC AI Assistant

---

## YOUR MISSION

The Electron frontend (React/Node) and FastAPI backend have diverged. IPC 
calls use mismatched argument shapes, HTTP methods don't match route 
definitions, and some frontend calls reference backend routes that don't exist.

You will create three new files and surgically modify four existing files. 
For existing files, you MUST use the exact "FIND and REPLACE" instructions. 
Do NOT rewrite entire existing files, or you will destroy existing logic.

## FILE MAP

| # | Path | Action |
|---|------|--------|
| 1 | `apps/desktop/shared/ipc-contract.ts` | CREATE |
| 2 | `apps/desktop/preload/preload.ts` | REPLACE (Full file provided) |
| 3 | `apps/desktop/electron/main.ts` | MODIFY (Surgical patches) |
| 4 | `apps/desktop/src/components/ErrorBanner.tsx` | MODIFY (Surgical patch) |
| 5 | `backend/chat/routes.py` | MODIFY (Surgical patch) |
| 6 | `backend/knowledge/routes.py` | MODIFY (Surgical patch) |
| 7 | `tests/test_ipc_api_contract.py` | CREATE |

---

## FILE 1: `apps/desktop/shared/ipc-contract.ts`

Create the directory `apps/desktop/shared/` if it does not exist.
Create this file with exactly this content:

```typescript
/**
 * Single source of truth for all IPC channels and payload shapes.
 * Both the preload script and the main process MUST import from this file
 * to ensure compile-time type safety.
 */

export const IPC = {
  CHAT_SEND: 'nocai:chat:send',
  CHAT_STOP: 'nocai:chat:stopGeneration',
  CHAT_RENAME: 'nocai:chat:renameConversation',
  CHAT_LOAD: 'nocai:chat:loadMessages',
  KNOWLEDGE_UPLOAD: 'nocai:knowledge:upload',
  KNOWLEDGE_REPROCESS: 'nocai:knowledge:reprocess',
  SYSTEM_VERSION: 'nocai:system:getVersion',
  SYSTEM_SHUTDOWN: 'nocai:system:shutdown',
} as const;

export interface ChatSendPayload {
  conversationId: string;
  message: string;
  modelId: string;
}

export interface RenamePayload {
  id: string;
  title: string;
}

export interface ReprocessPayload {
  documentId: string;
}

/**
 * Type-safe map of IPC channels to their invoke signatures.
 * Used by the preload script to expose a strictly typed API to the renderer.
 */
export type IpcInvokeMap = {
  [IPC.CHAT_SEND]: (payload: ChatSendPayload) => Promise<void>;
  [IPC.CHAT_STOP]: () => Promise<void>;
  [IPC.CHAT_RENAME]: (payload: RenamePayload) => Promise<void>;
  [IPC.CHAT_LOAD]: (conversationId: string) => Promise<any[]>;
  [IPC.KNOWLEDGE_UPLOAD]: (filePath: string) => Promise<void>;
  [IPC.KNOWLEDGE_REPROCESS]: (payload: ReprocessPayload) => Promise<void>;
  [IPC.SYSTEM_VERSION]: () => Promise<string>;
  [IPC.SYSTEM_SHUTDOWN]: () => Promise<void>;
};
```

---

## FILE 2: `apps/desktop/preload/preload.ts`

REPLACE the entire contents of this file with the following. 
This ensures the exposed `window.nocai` API strictly matches the contract.

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IpcInvokeMap } from '../shared/ipc-contract';

/**
 * The typed API exposed to the renderer process via window.nocai.
 * Every method maps directly to an ipcMain.handle in main.ts.
 */
const api: IpcInvokeMap = {
  [IPC.CHAT_SEND]: (payload) => ipcRenderer.invoke(IPC.CHAT_SEND, payload),
  
  [IPC.CHAT_STOP]: () => ipcRenderer.invoke(IPC.CHAT_STOP),
  
  [IPC.CHAT_RENAME]: (payload) => ipcRenderer.invoke(IPC.CHAT_RENAME, payload),
  
  [IPC.CHAT_LOAD]: (conversationId) => ipcRenderer.invoke(IPC.CHAT_LOAD, conversationId),
  
  [IPC.KNOWLEDGE_UPLOAD]: (filePath) => ipcRenderer.invoke(IPC.KNOWLEDGE_UPLOAD, filePath),
  
  [IPC.KNOWLEDGE_REPROCESS]: (payload) => ipcRenderer.invoke(IPC.KNOWLEDGE_REPROCESS, payload),
  
  [IPC.SYSTEM_VERSION]: () => ipcRenderer.invoke(IPC.SYSTEM_VERSION),
  
  [IPC.SYSTEM_SHUTDOWN]: () => ipcRenderer.invoke(IPC.SYSTEM_SHUTDOWN),
};

contextBridge.exposeInMainWorld('nocai', api);
```

---

## FILE 3: `apps/desktop/electron/main.ts` (MODIFY)

Do NOT rewrite this file. Apply the following surgical patches.

### Patch 3.1: Add the IPC import
**FIND:**
```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
```
*(Note: the exact import line might vary slightly, find the line importing `ipcMain`)*

**REPLACE WITH:**
```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC, RenamePayload, ReprocessPayload, ChatSendPayload } from '../shared/ipc-contract';
```

### Patch 3.2: Fix `renameConversation` handler
**FIND:**
```typescript
ipcMain.handle('nocai:chat:renameConversation', async (event, id, title) => {
```
*(Or similar destructuring that expects positional arguments)*

**REPLACE WITH:**
```typescript
ipcMain.handle(IPC.CHAT_RENAME, async (event, payload: RenamePayload) => {
  const { id, title } = payload;
```
*(Ensure the rest of the function body uses `id` and `title` and sends `{ title }` in the HTTP body, NOT as a query parameter).*

### Patch 3.3: Fix `getVersion` handler
**FIND:**
```typescript
ipcMain.handle('nocai:system:getVersion', async () => {
```
*(Look for the handler that currently returns health JSON or an object)*

**REPLACE WITH:**
```typescript
ipcMain.handle(IPC.SYSTEM_VERSION, async () => {
  return app.getVersion(); // Must return a plain string to match Promise<string>
});
```

### Patch 3.4: Add missing `stopGeneration` handler
**FIND:**
A good place to insert this is right after the `CHAT_RENAME` handler.

**INSERT THIS EXACT BLOCK:**
```typescript
ipcMain.handle(IPC.CHAT_STOP, async () => {
  // Forward the stop signal to the backend
  // Assuming you have a backend URL or abort controller mechanism
  // If using fetch/axios in main, abort the request here.
  // If the backend supports a stop endpoint, call it:
  try {
    await fetch(`${BACKEND_URL}/api/v1/inference/chat/completions/stop`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to send stop signal to backend', err);
  }
});
```

### Patch 3.5: Fix the `/admin/shutdown` HTTP dependency
**FIND:**
Any code in `main.ts` that makes an HTTP request to `/admin/shutdown` or `/api/v1/admin/shutdown` when the app is closing.

**REPLACE WITH:**
```typescript
// Do NOT call an HTTP route to shut down the backend.
// Simply terminate the child process gracefully.
if (backendProcess && !backendProcess.killed) {
  backendProcess.kill('SIGTERM');
}
```

---

## FILE 4: Frontend Error Banner Fix (MODIFY)

Locate the React component responsible for the backend error banner. It is likely 
named `ErrorBanner.tsx`, `BackendError.tsx`, or located inside `ChatView.tsx`.

**FIND:**
The close button's `onClick` handler. It currently looks something like this:
```tsx
<button onClick={() => restartBackend()}>×</button>
// OR
<button onClick={handleRestart}>×</button>
```

**REPLACE WITH:**
```tsx
<button onClick={() => setShowBanner(false)}>×</button>
// OR (depending on your state variable name)
<button onClick={() => dismissError()}>×</button>
```
*Rule: The close button MUST ONLY dismiss the UI banner. It must NOT restart the backend process.*

---

## FILE 5: `backend/chat/routes.py` (MODIFY)

The frontend sends `{ "title": "New Title" }` in the JSON body, but FastAPI 
currently expects `title` as a query parameter.

**FIND:**
The `PATCH /conversations/{conversation_id}` (or similar) route. It likely looks like this:
```python
@router.patch("/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: str,
    title: str = Query(...),  # <--- THIS IS THE BUG
    db: Session = Depends(get_db)
):
```

**REPLACE WITH:**
```python
from pydantic import BaseModel

class RenameConversationRequest(BaseModel):
    title: str

@router.patch("/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: str,
    payload: RenameConversationRequest,  # <--- FIXED: Reads from JSON body
    db: Session = Depends(get_db)
):
    title = payload.title
    # ... rest of the existing function body remains exactly the same ...
```

---

## FILE 6: `backend/knowledge/routes.py` (MODIFY)

The frontend invokes `/knowledge/documents/{id}/reprocess` but the route is missing.

**FIND:**
The end of the file, or the section with other document routes.

**INSERT THIS EXACT BLOCK:**
```python
from fastapi import HTTPException

@router.post("/documents/{document_id}/reprocess")
async def reprocess_document(
    document_id: str,
    db: Session = Depends(get_db),
    ingestion_coordinator = Depends(get_ingestion_coordinator) # Adjust dependency based on your app state
):
    """Reset a document's ingestion job to QUEUED and re-enqueue it."""
    from backend.db.models import Document, IngestionJob
    
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
        
    job = db.query(IngestionJob).filter(IngestionJob.document_id == document_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Ingestion job not found for document")
        
    # Reset state
    job.status = "queued"
    job.progress = 0.0
    job.error_message = None
    db.commit()
    
    # Re-enqueue (adjust based on how your coordinator handles jobs)
    await ingestion_coordinator.enqueue(job)
    
    return {"status": "re-queued", "document_id": document_id}
```
*(Note: If `get_ingestion_coordinator` doesn't exist as a FastAPI dependency, fetch it from `request.app.state.ingestion` by adding `request: Request` to the route parameters).*

---

## FILE 7: `tests/test_ipc_api_contract.py` (CREATE)

Create this file to ensure contracts never drift again.

```python
"""
Contract smoke tests.
Verifies that the TypeScript frontend and Python backend agree on all 
IPC channels and HTTP routes.
"""
import json
import subprocess
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"


def test_typescript_preload_compiles():
    """Ensure preload.ts strictly matches the ipc-contract.ts types."""
    if not (DESKTOP_DIR / "node_modules").exists():
        pytest.skip("node_modules not installed, skipping TS check")
        
    result = subprocess.run(
        ["npx", "tsc", "--noEmit", "--strict", "preload/preload.ts"],
        capture_output=True,
        text=True,
        cwd=str(DESKTOP_DIR),
    )
    assert result.returncode == 0, (
        f"TypeScript contract mismatch in preload.ts:\n{result.stdout}\n{result.stderr}"
    )


def test_backend_routes_exist_for_electron():
    """Ensure every HTTP route called by Electron main.ts exists in FastAPI."""
    from fastapi.testclient import TestClient
    from backend.main import create_app
    
    app = create_app()
    openapi = app.openapi()
    available_paths = set(openapi["paths"].keys())
    
    # These are the exact routes the Electron main process proxies to the backend
    required_routes = [
        "/api/v1/chat/conversations/{conversation_id}",
        "/api/v1/knowledge/documents",
        "/api/v1/knowledge/documents/{document_id}/reprocess",
        "/api/v1/models",
        "/api/v1/auth/login",
        "/api/v1/inference/chat/completions",
    ]
    
    missing = []
    for route in required_routes:
        # FastAPI OpenAPI uses {param} format, ensure we match it
        if route not in available_paths:
            missing.append(route)
            
    assert not missing, (
        f"Backend is missing routes required by Electron: {missing}. "
        f"Available: {sorted(available_paths)}"
    )


def test_ipc_channels_have_handlers():
    """Parse main.ts to ensure every IPC channel in the contract has a handler."""
    contract_file = DESKTOP_DIR / "shared" / "ipc-contract.ts"
    main_file = DESKTOP_DIR / "electron" / "main.ts"
    
    if not contract_file.exists() or not main_file.exists():
        pytest.skip("Electron files not found")
        
    contract_text = contract_file.read_text(encoding="utf-8")
    main_text = main_file.read_text(encoding="utf-8")
    
    # Extract channel names from the IPC object (e.g., 'nocai:chat:send')
    import re
    channels = re.findall(r"'(nocai:[a-zA-Z0-9:_]+)'", contract_text)
    
    missing_handlers = []
    for channel in channels:
        # Check if ipcMain.handle is called with this channel or the IPC constant
        if f"'{channel}'" not in main_text and f"IPC.{channel.split(':')[-1].upper()}" not in main_text:
            # Fallback: just check if the string literal is handled
            if channel not in main_text:
                missing_handlers.append(channel)
                
    assert not missing_handlers, (
        f"main.ts is missing ipcMain.handle for: {missing_handlers}"
    )
```

---

## VERIFICATION CHECKLIST

Run these checks IN ORDER. Do not skip any.

```bash
# 1. Verify TypeScript compiles without errors
cd apps/desktop
npx tsc --noEmit
# EXPECT: Exit code 0. No output.

# 2. Verify Backend starts and contract tests pass
cd ../../
pytest tests/test_ipc_api_contract.py -v
# EXPECT: 3 passed.

# 3. Verify Chat Rename works via curl (Simulating Electron)
# Start backend first, then:
curl -X PATCH http://127.0.0.1:8000/api/v1/chat/conversations/test-id \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"title": "New Title"}'
# EXPECT: HTTP 200 (or 404 if ID doesn't exist, but NOT 422 Unprocessable Entity)

# 4. Run the quality gate
./scripts/quality-gate.ps1
```

---

## THINGS YOU MUST NOT DO

1. **Do NOT rewrite `main.ts` or `routes.py` from scratch.** Use the exact FIND/REPLACE blocks.
2. **Do NOT change the IPC channel string names** (e.g., don't change `nocai:chat:send` to `chat:send`).
3. **Do NOT remove Context Isolation** or enable `nodeIntegration` in `main.ts` to "make things easier".
4. **Do NOT expose the backend transport token** (`X-NOC-AI-Backend-Token`) to the renderer process via IPC.
5. **Do NOT alter the `backend/inference/` files** created in Phase 1.

---

## DEFINITION OF DONE

Phase 2 is complete when ALL of the following are true:

- [ ] `ipc-contract.ts` created and imported by `preload.ts`.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] `PATCH /conversations/{id}` accepts JSON body `{"title": "..."}` without 422 errors.
- [ ] `POST /documents/{id}/reprocess` exists and returns 200/404 (not 405 Method Not Allowed).
- [ ] Error banner close button only hides the UI, does not restart backend.
- [ ] `pytest tests/test_ipc_api_contract.py` passes all 3 tests.
- [ ] `quality-gate.ps1` exits with code 0.

---

## COMMIT MESSAGE

When all checks pass:

```bash
git add apps/desktop/ backend/chat/ backend/knowledge/ tests/
git commit -m "phase2: fix API/IPC contract drift between Electron and FastAPI

- Add shared ipc-contract.ts for strict TypeScript IPC typing
- Rewrite preload.ts to use typed contextBridge API
- Patch main.ts: fix rename args, fix getVersion return, add stopGeneration
- Remove /admin/shutdown HTTP dependency in favor of direct SIGTERM
- Fix PATCH /conversations to accept title in JSON body, not query param
- Add POST /documents/{id}/reprocess route for RAG pipeline
- Fix ErrorBanner close button to dismiss UI instead of restarting backend
- Add contract smoke tests to prevent future drift"
```
```
