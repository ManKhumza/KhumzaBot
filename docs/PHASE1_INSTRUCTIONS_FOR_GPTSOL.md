Save this entire document as `docs/PHASE1_INSTRUCTIONS_FOR_GPTSOL.md` and feed it directly to GPT Sol. Every file contains complete, production-ready code — no generation required, just placement.

---

```markdown
# PHASE 1 IMPLEMENTATION ORDER — Senior Engineer Directive

**To:** GPT Sol (Implementation Agent)
**From:** Senior Engineer
**Subject:** Replace subprocess-pipe inference with llama-server HTTP architecture
**Priority:** P0 — Blocks all other phases
**Repository:** KhumzaBot / NOC AI Assistant

---

## YOUR MISSION

You will create five new files and modify one existing file. The complete code
for every file is provided below. Your job is to:

1. Create each file at the exact path specified
2. Write the EXACT code provided — do not rewrite, refactor, or "improve" it
3. Make the small modifications to `backend/main.py` described in Section 7
4. Verify everything compiles and imports correctly
5. Do NOT touch any file not listed in this document

## ARCHITECTURE OVERVIEW

**Before (broken):**
```
FastAPI → spawn llama CLI → pipe stdin/stdout → deadlocks, HTTP 500s
```

**After (this phase):**
```
FastAPI → httpx proxy → llama-server HTTP process (per model)
```

Each GGUF model runs as its own `llama-server` HTTP server on a unique port.
FastAPI proxies inference requests to the correct server. No pipes. No deadlocks.

## FILE MAP

| # | Path | Action |
|---|------|--------|
| 1 | `backend/inference/__init__.py` | CREATE |
| 2 | `backend/inference/port_pool.py` | CREATE |
| 3 | `backend/inference/lifecycle.py` | CREATE |
| 4 | `backend/inference/routes.py` | CREATE |
| 5 | `backend/inference/health.py` | CREATE |
| 6 | `backend/main.py` | MODIFY (2 lines added) |

---

## FILE 1: `backend/inference/__init__.py`

Create the directory `backend/inference/` if it does not exist.
Create this file with exactly this content:

```python
"""Inference engine package – manages llama.cpp model lifecycles."""
```

That is the entire file. One line. Do not add anything else.

---

## FILE 2: `backend/inference/port_pool.py`

Create this file with exactly this content:

```python
"""Thread-safe port allocation for llama-server instances."""

from __future__ import annotations

import threading


class PortPool:
    """Allocates and releases TCP ports from a fixed range.

    Usage:
        pool = PortPool(start=8100, end=8200)
        port = pool.acquire("model-abc-123")
        pool.release(port)
    """

    def __init__(self, start: int = 8100, end: int = 8200) -> None:
        if start > end:
            raise ValueError(f"start ({start}) must be <= end ({end})")
        self._lock = threading.Lock()
        self._available: set[int] = set(range(start, end + 1))
        self._in_use: dict[int, str] = {}  # port -> model_id

    def acquire(self, model_id: str) -> int:
        """Allocate a free port for the given model.

        Raises RuntimeError if the pool is exhausted.
        """
        with self._lock:
            if not self._available:
                raise RuntimeError(
                    f"No free ports available in range for model {model_id}. "
                    f"All ports in use: {sorted(self._in_use.keys())}"
                )
            port = self._available.pop()
            self._in_use[port] = model_id
            return port

    def release(self, port: int) -> None:
        """Return a port to the available pool."""
        with self._lock:
            self._in_use.pop(port, None)
            self._available.add(port)

    def is_in_use(self, port: int) -> bool:
        with self._lock:
            return port in self._in_use

    @property
    def available_count(self) -> int:
        with self._lock:
            return len(self._available)

    @property
    def in_use_count(self) -> int:
        with self._lock:
            return len(self._in_use)
```

---

## FILE 3: `backend/inference/lifecycle.py`

Create this file with exactly this content. This is the core of Phase 1.
Do NOT modify any logic. Do NOT rename any methods. The existing
`backend/main.py` depends on the exact interface defined here.

```python
"""
Model lifecycle manager – spawns and supervises llama-server processes.

Each GGUF model (chat or embedding) runs as an independent HTTP server.
The FastAPI backend proxies inference requests to the appropriate server.

This replaces the previous approach of piping stdin/stdout to the llama
CLI binary, which caused pipe deadlocks and orphaned processes.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from collections import deque
from pathlib import Path
from typing import Any

import httpx

from backend.inference.port_pool import PortPool

logger = logging.getLogger("nocai.inference")

# Bounded ring buffer size for captured stdout / stderr lines.
# Prevents unbounded memory growth while retaining enough history
# for meaningful diagnostics.
_LOG_RING_SIZE = 200


class LlamaServerError(RuntimeError):
    """Raised when a llama-server process fails to start or dies unexpectedly."""


class LlamaServerProcess:
    """Manages a single llama.cpp HTTP server instance.

    Lifecycle:
        server = LlamaServerProcess(model_path, port, binary_path)
        await server.start()       # spawn + wait for /health
        healthy = await server.is_healthy()
        await server.stop()        # graceful SIGTERM → SIGKILL
    """

    def __init__(
        self,
        model_path: Path,
        port: int,
        binary_path: Path,
        *,
        ctx_size: int = 4096,
        gpu_layers: int = 99,
        host: str = "127.0.0.1",
        health_timeout: float = 60.0,
    ) -> None:
        self.model_path = Path(model_path)
        self.port = port
        self.binary_path = Path(binary_path)
        self.ctx_size = ctx_size
        self.gpu_layers = gpu_layers
        self.host = host
        self.health_timeout = health_timeout

        self.process: asyncio.subprocess.Process | None = None
        self._stdout_ring: deque[str] = deque(maxlen=_LOG_RING_SIZE)
        self._stderr_ring: deque[str] = deque(maxlen=_LOG_RING_SIZE)
        self._drain_tasks: list[asyncio.Task] = []
        self._started_at: float | None = None

    # ── lifecycle ──────────────────────────────────────────────

    async def start(self) -> None:
        """Spawn llama-server and block until /health returns 200."""
        if self.process is not None and self.process.returncode is None:
            logger.warning(
                "llama-server already running on port %s, skipping start",
                self.port,
            )
            return

        if not self.binary_path.is_file():
            raise LlamaServerError(
                f"llama-server binary not found: {self.binary_path}"
            )

        if not self.model_path.is_file():
            raise LlamaServerError(
                f"Model file not found: {self.model_path}"
            )

        cmd = [
            str(self.binary_path),
            "--model", str(self.model_path),
            "--host", self.host,
            "--port", str(self.port),
            "--ctx-size", str(self.ctx_size),
            "--n-gpu-layers", str(self.gpu_layers),
            "--no-webui",
            "--log-disable",
        ]

        logger.info("Starting llama-server: %s", " ".join(cmd))

        self.process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Background tasks to continuously drain stdout/stderr so the
        # OS pipe buffers never fill up and block the child process.
        self._drain_tasks = [
            asyncio.create_task(
                self._drain_stream(self.process.stdout, self._stdout_ring),
                name=f"drain-stdout-{self.port}",
            ),
            asyncio.create_task(
                self._drain_stream(self.process.stderr, self._stderr_ring),
                name=f"drain-stderr-{self.port}",
            ),
        ]

        try:
            await self._wait_for_ready()
        except Exception:
            # Startup failed — clean up the process we just spawned
            await self._force_kill()
            raise

        self._started_at = time.monotonic()
        logger.info(
            "llama-server ready on port %s (model: %s)",
            self.port,
            self.model_path.name,
        )

    async def stop(self, timeout: float = 10.0) -> None:
        """Gracefully stop the server. SIGTERM first, SIGKILL after timeout."""
        # Cancel drain tasks first
        for task in self._drain_tasks:
            task.cancel()
        self._drain_tasks.clear()

        if self.process is None or self.process.returncode is not None:
            self.process = None
            return

        logger.info("Stopping llama-server on port %s", self.port)

        try:
            self.process.terminate()
            await asyncio.wait_for(self.process.wait(), timeout=timeout)
            logger.info(
                "llama-server on port %s exited with code %s",
                self.port,
                self.process.returncode,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "llama-server on port %s did not exit after %.1fs SIGTERM; "
                "sending SIGKILL",
                self.port,
                timeout,
            )
            self.process.kill()
            await self.process.wait()

        self.process = None

    # ── health ─────────────────────────────────────────────────

    async def is_healthy(self) -> bool:
        """Check whether the server's /health endpoint responds 200."""
        if not self.is_running:
            return False
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(
                    f"http://{self.host}:{self.port}/health"
                )
                return resp.status_code == 200
        except httpx.HTTPError:
            return False

    # ── diagnostics ────────────────────────────────────────────

    @property
    def is_running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    @property
    def exit_code(self) -> int | None:
        if self.process is None:
            return None
        return self.process.returncode

    @property
    def recent_stderr(self) -> str:
        return "\n".join(self._stderr_ring)

    @property
    def recent_stdout(self) -> str:
        return "\n".join(self._stdout_ring)

    def diagnostics(self) -> dict[str, Any]:
        """Return a JSON-serialisable snapshot of this server's state."""
        return {
            "model": self.model_path.name,
            "port": self.port,
            "running": self.is_running,
            "exit_code": self.exit_code,
            "uptime_seconds": (
                round(time.monotonic() - self._started_at, 1)
                if self._started_at is not None
                else None
            ),
            "stderr_tail": list(self._stderr_ring)[-10:],
            "stdout_tail": list(self._stdout_ring)[-10:],
        }

    # ── internals ──────────────────────────────────────────────

    async def _wait_for_ready(self) -> None:
        """Poll /health until the server responds or we hit the timeout."""
        deadline = time.monotonic() + self.health_timeout
        url = f"http://{self.host}:{self.port}/health"

        async with httpx.AsyncClient() as client:
            while time.monotonic() < deadline:
                # If the process already exited, fail fast
                if self.process is not None and self.process.returncode is not None:
                    raise LlamaServerError(
                        f"llama-server exited with code "
                        f"{self.process.returncode} during startup. "
                        f"stderr tail: {self.recent_stderr[:500]}"
                    )
                try:
                    resp = await client.get(url, timeout=2.0)
                    if resp.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass  # Server not ready yet, keep polling
                await asyncio.sleep(0.5)

        raise LlamaServerError(
            f"llama-server on port {self.port} did not become healthy "
            f"within {self.health_timeout}s. "
            f"stderr tail: {self.recent_stderr[:500]}"
        )

    async def _force_kill(self) -> None:
        """Kill the process and cancel drain tasks. Used on startup failure."""
        for task in self._drain_tasks:
            task.cancel()
        self._drain_tasks.clear()

        if self.process is not None and self.process.returncode is None:
            self.process.kill()
            await self.process.wait()
        self.process = None

    @staticmethod
    async def _drain_stream(
        stream: asyncio.StreamReader | None,
        ring: deque[str],
    ) -> None:
        """Read lines from a stream into a bounded ring buffer.

        This prevents the OS pipe buffer from filling up and blocking
        the child process (the root cause of the previous deadlocks).
        """
        if stream is None:
            return
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                ring.append(line.decode(errors="replace").rstrip())
        except asyncio.CancelledError:
            pass


class ModelLifecycleManager:
    """Supervises all llama-server instances for the application.

    This class is instantiated by backend/main.py and stored as
    app.state.model_manager. The constructor signature and the
    startup/shutdown methods MUST remain compatible with main.py.
    """

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self._servers: dict[str, LlamaServerProcess] = {}
        self._port_pool = PortPool(
            start=getattr(settings, "inference_port_start", 8100),
            end=getattr(settings, "inference_port_end", 8200),
        )
        self._binary_path = self._resolve_binary()

    # ── public API (called by main.py lifespan) ────────────────

    async def startup(self, session_factory: Any) -> None:
        """Reconcile DB state with running processes on app launch.

        Called once during FastAPI lifespan startup. Queries the database
        for models marked 'active' and attempts to load each one.
        Models that fail to load are marked 'error' in the database.
        """
        from backend.db.models import Model

        SessionLocal = session_factory
        with SessionLocal() as db:
            active_models = (
                db.query(Model).filter(Model.status == "active").all()
            )
            # Detach model data we need outside the session
            models_to_load = [
                {"id": m.id, "name": m.name, "filepath": m.filepath,
                 "role": m.role, "context_length": getattr(m, "context_length", None)}
                for m in active_models
            ]

        for model_info in models_to_load:
            try:
                await self.load_model(model_info["id"], session_factory)
                logger.info(
                    "Restored model '%s' (%s)",
                    model_info["name"],
                    model_info["id"],
                )
            except Exception as exc:
                logger.error(
                    "Failed to restore model '%s' (%s): %s",
                    model_info["name"],
                    model_info["id"],
                    exc,
                )
                with SessionLocal() as db:
                    db_model = (
                        db.query(Model)
                        .filter(Model.id == model_info["id"])
                        .first()
                    )
                    if db_model:
                        db_model.status = "error"
                        db_model.last_error = str(exc)[:500]
                        db.commit()

    async def shutdown(self) -> None:
        """Stop every managed llama-server. Called during app shutdown."""
        if not self._servers:
            logger.info("No inference servers to stop")
            return

        logger.info("Stopping %d inference server(s)", len(self._servers))
        tasks = [self.unload_model(mid) for mid in list(self._servers.keys())]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for mid, result in zip(list(self._servers.keys()), results):
            if isinstance(result, Exception):
                logger.error("Error stopping server %s: %s", mid, result)

        logger.info("All inference servers stopped")

    # ── model management ───────────────────────────────────────

    async def load_model(
        self, model_id: str, session_factory: Any
    ) -> LlamaServerProcess:
        """Load a model by spawning a llama-server process for it."""
        from backend.db.models import Model

        # Already loaded and running?
        if model_id in self._servers:
            existing = self._servers[model_id]
            if existing.is_running:
                logger.info("Model %s already loaded", model_id)
                return existing
            # Dead process — clean up and reload
            logger.warning("Model %s process died; reloading", model_id)
            await self.unload_model(model_id)

        SessionLocal = session_factory
        with SessionLocal() as db:
            model = db.query(Model).filter(Model.id == model_id).first()
            if model is None:
                raise ValueError(f"Model {model_id} not found in database")

            model_path = Path(model.filepath)
            if not model_path.is_file():
                raise FileNotFoundError(
                    f"Model file missing on disk: {model_path}"
                )

            port = self._port_pool.acquire(model_id)

            server = LlamaServerProcess(
                model_path=model_path,
                port=port,
                binary_path=self._binary_path,
                ctx_size=getattr(model, "context_length", None) or 4096,
            )

            try:
                await server.start()
            except Exception:
                self._port_pool.release(port)
                raise

            self._servers[model_id] = server
            model.status = "loaded"
            model.port = port
            db.commit()

            logger.info(
                "Model '%s' (%s) loaded on port %d",
                model.name,
                model.role,
                port,
            )
            return server

    async def unload_model(self, model_id: str) -> None:
        """Stop a model's server and release its port."""
        server = self._servers.pop(model_id, None)
        if server is not None:
            await server.stop()
            self._port_pool.release(server.port)
            logger.info("Model %s unloaded", model_id)

    def get_server(self, model_id: str) -> LlamaServerProcess | None:
        """Return the server process for a model, or None."""
        return self._servers.get(model_id)

    def get_server_by_role(
        self, role: str, session_factory: Any
    ) -> LlamaServerProcess | None:
        """Return the first loaded server matching a model role.

        Args:
            role: "chat" or "embedding"
        """
        from backend.db.models import Model

        SessionLocal = session_factory
        with SessionLocal() as db:
            model = (
                db.query(Model)
                .filter(Model.role == role, Model.status == "loaded")
                .first()
            )
            if model is not None:
                return self._servers.get(model.id)
        return None

    async def health_check(self, model_id: str) -> dict[str, Any]:
        """Return health status for a specific model."""
        server = self._servers.get(model_id)
        if server is None:
            return {"model_id": model_id, "status": "not_loaded"}

        healthy = await server.is_healthy()
        return {
            "model_id": model_id,
            "status": "healthy" if healthy else "unhealthy",
            **server.diagnostics(),
        }

    def list_servers(self) -> dict[str, Any]:
        """Return diagnostics for all managed servers."""
        return {
            model_id: server.diagnostics()
            for model_id, server in self._servers.items()
        }

    # ── internals ──────────────────────────────────────────────

    def _resolve_binary(self) -> Path:
        """Locate the llama-server binary.

        Search order:
            1. settings.llama_server_path (if set)
            2. resources/bin/llama-server.exe  (Windows)
            3. resources/bin/llama-server      (Linux/macOS)
            4. System PATH via shutil.which
        """
        candidates: list[Path | str | None] = [
            getattr(self.settings, "llama_server_path", None),
            Path("resources/bin/llama-server.exe"),
            Path("resources/bin/llama-server"),
            shutil.which("llama-server"),
        ]

        for candidate in candidates:
            if candidate is not None:
                p = Path(candidate)
                if p.is_file():
                    logger.info("Found llama-server binary: %s", p)
                    return p

        searched = ", ".join(str(c) for c in candidates if c is not None)
        raise FileNotFoundError(
            f"llama-server binary not found. Searched: {searched}. "
            f"Place the binary at resources/bin/llama-server.exe "
            f"or set settings.llama_server_path."
        )
```

---

## FILE 4: `backend/inference/routes.py`

Create this file with exactly this content:

```python
"""FastAPI routes that proxy inference requests to llama-server instances."""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger("nocai.inference.routes")
router = APIRouter()

# Timeout for upstream inference requests (seconds).
# Chat completions can take a while, especially on CPU-only machines.
_UPSTREAM_TIMEOUT = 300.0


# ── helpers ────────────────────────────────────────────────────

def _get_manager(request: Request) -> Any:
    """Retrieve the ModelLifecycleManager from app state."""
    return request.app.state.model_manager


def _get_session_factory(request: Request) -> Any:
    """Retrieve the DB session factory from app state."""
    from backend.db.database import get_session_factory
    return get_session_factory(request.app.state.engine)


async def _proxy_json(
    server: Any,
    method: str,
    path: str,
    json_body: dict | None = None,
) -> JSONResponse:
    """Forward a non-streaming request to a llama-server."""
    url = f"http://{server.host}:{server.port}{path}"
    try:
        async with httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT) as client:
            resp = await client.request(method, url, json=json_body)
            return JSONResponse(
                content=resp.json(),
                status_code=resp.status_code,
            )
    except httpx.HTTPError as exc:
        logger.error("Proxy error to %s: %s", url, exc)
        return JSONResponse(
            content={"detail": f"Inference backend error: {exc}"},
            status_code=502,
        )


async def _proxy_stream(
    server: Any,
    method: str,
    path: str,
    json_body: dict | None = None,
) -> StreamingResponse | JSONResponse:
    """Forward a streaming request to a llama-server."""
    url = f"http://{server.host}:{server.port}{path}"
    try:
        async with httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT) as client:
            req = client.build_request(method, url, json=json_body)
            resp = await client.send(req, stream=True)

            async def _iterate():
                try:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                finally:
                    await resp.aclose()

            return StreamingResponse(
                _iterate(),
                media_type=resp.headers.get(
                    "content-type", "text/event-stream"
                ),
                status_code=resp.status_code,
            )
    except httpx.HTTPError as exc:
        logger.error("Stream proxy error to %s: %s", url, exc)
        return JSONResponse(
            content={"detail": f"Inference backend error: {exc}"},
            status_code=502,
        )


# ── chat endpoints ─────────────────────────────────────────────

@router.post("/chat/completions")
async def chat_completions(request: Request) -> Any:
    """Proxy a chat completion request to the active chat model."""
    manager = _get_manager(request)
    session_factory = _get_session_factory(request)
    server = manager.get_server_by_role("chat", session_factory)

    if server is None or not server.is_running:
        return JSONResponse(
            content={"detail": "No chat model is currently loaded"},
            status_code=503,
        )

    body = await request.json()
    is_stream = body.get("stream", False)

    if is_stream:
        return await _proxy_stream(
            server, "POST", "/v1/chat/completions", json_body=body
        )
    return await _proxy_json(
        server, "POST", "/v1/chat/completions", json_body=body
    )


# ── embedding endpoints ────────────────────────────────────────

@router.post("/embeddings")
async def embeddings(request: Request) -> Any:
    """Proxy an embedding request to the active embedding model."""
    manager = _get_manager(request)
    session_factory = _get_session_factory(request)
    server = manager.get_server_by_role("embedding", session_factory)

    if server is None or not server.is_running:
        return JSONResponse(
            content={"detail": "No embedding model is currently loaded"},
            status_code=503,
        )

    body = await request.json()
    return await _proxy_json(
        server, "POST", "/v1/embeddings", json_body=body
    )


# ── model status endpoints ─────────────────────────────────────

@router.get("/models")
async def list_inference_models(request: Request) -> Any:
    """Return diagnostics for every managed llama-server."""
    manager = _get_manager(request)
    return manager.list_servers()


@router.get("/models/{model_id}/health")
async def model_health(model_id: str, request: Request) -> Any:
    """Return health status for a specific model."""
    manager = _get_manager(request)
    return await manager.health_check(model_id)
```

---

## FILE 5: `backend/inference/health.py`

Create this file with exactly this content:

```python
"""Lightweight health-check utilities for inference servers."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger("nocai.inference.health")


async def check_server(
    host: str,
    port: int,
    timeout: float = 3.0,
) -> dict[str, Any]:
    """Check health of a single llama-server.

    Returns:
        {"healthy": True, "status_code": 200}
        or
        {"healthy": False, "error": "Connection refused"}
    """
    url = f"http://{host}:{port}/health"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url)
            return {
                "healthy": resp.status_code == 200,
                "status_code": resp.status_code,
            }
    except httpx.HTTPError as exc:
        return {"healthy": False, "error": str(exc)}


async def check_all(
    servers: dict[str, Any],
    concurrency: int = 5,
) -> dict[str, dict[str, Any]]:
    """Fan-out health checks across all servers with bounded concurrency.

    Args:
        servers: dict mapping model_id -> LlamaServerProcess
        concurrency: max simultaneous health checks

    Returns:
        dict mapping model_id -> health result
    """
    sem = asyncio.Semaphore(concurrency)

    async def _check_one(
        model_id: str, server: Any
    ) -> tuple[str, dict[str, Any]]:
        async with sem:
            result = await check_server(server.host, server.port)
            return model_id, result

    tasks = [
        _check_one(mid, srv) for mid, srv in servers.items()
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    output: dict[str, dict[str, Any]] = {}
    for result in results:
        if isinstance(result, Exception):
            logger.error("Health check task failed: %s", result)
            continue
        model_id, health = result
        output[model_id] = health

    return output
```

---

## FILE 6: MODIFY `backend/main.py`

Do NOT rewrite this file. Make exactly TWO additions:

### Addition 1 — Add the import

Find the block of imports near the top of `main.py` that looks like this:

```python
from backend.auth.routes import router as auth_router
from backend.chat.routes import router as chat_router
from backend.models.routes import router as models_router
```

Add this line immediately after them:

```python
from backend.inference.routes import router as inference_router
```

### Addition 2 — Register the router

Find the section inside `create_app()` where other routers are registered:

```python
    app.include_router(auth_router, prefix="/api/v1/auth", tags=["auth"])
    app.include_router(chat_router, prefix="/api/v1/chat", tags=["chat"])
    app.include_router(models_router, prefix="/api/v1/models", tags=["models"])
```

Add this line immediately after them:

```python
    app.include_router(inference_router, prefix="/api/v1/inference", tags=["inference"])
```

### Do NOT change anything else in main.py.

---

## DEPENDENCY

Install `httpx` if it is not already in the project:

```bash
pip install httpx
```

Add `httpx` to `backend/pyproject.toml` or `requirements.txt` if applicable.

---

## VERIFICATION CHECKLIST

After placing all files, run these checks IN ORDER. Do not skip any.

```bash
# 1. Verify all files exist
ls backend/inference/__init__.py
ls backend/inference/port_pool.py
ls backend/inference/lifecycle.py
ls backend/inference/routes.py
ls backend/inference/health.py

# 2. Verify imports work
python -c "from backend.inference.port_pool import PortPool; print('port_pool OK')"
python -c "from backend.inference.lifecycle import ModelLifecycleManager; print('lifecycle OK')"
python -c "from backend.inference.routes import router; print('routes OK')"
python -c "from backend.inference.health import check_server; print('health OK')"

# 3. Verify PortPool logic
python -c "
from backend.inference.port_pool import PortPool
p = PortPool(8100, 8102)
a = p.acquire('m1')
b = p.acquire('m2')
c = p.acquire('m3')
print(f'Allocated: {a}, {b}, {c}')
p.release(b)
d = p.acquire('m4')
print(f'Reallocated: {d} (should equal {b})')
assert d == b
print('PortPool OK')
"

# 4. Verify main.py still starts (will fail on missing binary, that's expected)
python -c "
from backend.main import create_app
app = create_app()
print('create_app OK')
"

# 5. Run the quality gate
./scripts/quality-gate.ps1
```

---

## THINGS YOU MUST NOT DO

1. **Do NOT modify any file not listed in this document.**
2. **Do NOT change the constructor signature of `ModelLifecycleManager`.**
   `backend/main.py` calls `ModelLifecycleManager(settings)` and expects
   `async startup(session_factory)` and `async shutdown()`.
3. **Do NOT add cloud calls, telemetry, or analytics.**
4. **Do NOT hard-code health responses.** The health check must actually
   poll the llama-server `/health` endpoint.
5. **Do NOT read or modify the real `%APPDATA%\NOC AI Assistant` profile.**
6. **Do NOT stub or fake any functionality.** Every function must be
   fully implemented.
7. **Do NOT "improve" or refactor the provided code.** Write it exactly
   as given.
8. **Do NOT leave orphaned processes.** The `stop()` method must always
   clean up the child process.
9. **Do NOT use `subprocess.Popen` or synchronous subprocess calls.**
   All process management must use `asyncio.create_subprocess_exec`.
10. **Do NOT expose tokens, passwords, or secrets in logs.**

---

## DEFINITION OF DONE

Phase 1 is complete when ALL of the following are true:

- [ ] All five files created at the correct paths
- [ ] `backend/main.py` has the two additions (import + router registration)
- [ ] `httpx` is listed as a dependency
- [ ] All import checks pass (verification step 2)
- [ ] PortPool unit test passes (verification step 3)
- [ ] `create_app()` succeeds without import errors
- [ ] `quality-gate.ps1` exits with code 0
- [ ] No files outside the six listed above were modified

---

## COMMIT MESSAGE

When all checks pass:

```bash
git add backend/inference/ backend/main.py
git commit -m "phase1: replace subprocess pipes with llama-server HTTP architecture

- Add PortPool for conflict-free port allocation
- Add LlamaServerProcess for HTTP-based model lifecycle management
- Add ModelLifecycleManager with startup/shutdown reconciliation
- Add inference routes proxying chat and embedding requests
- Add health check utilities with bounded concurrency
- Wire inference router into main.py
- Eliminates pipe deadlocks and orphaned processes"
```
```

---

Feed that entire document to GPT Sol. It contains every line of code, every constraint, and every verification step. GPT Sol should not need to generate any code — only place what's provided and run the checks.

Once Phase 1 passes, ask me for the Phase 2 document in the same format.
