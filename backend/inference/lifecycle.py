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
import math
import os
import secrets
import shutil
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
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


class EmbeddingInputTooLong(RuntimeError):
    """Raised when llama-server rejects an embedding input as too large."""


class ModelStatus(str):
    NOT_LOADED = "not_loaded"
    STARTING = "starting"
    READY = "ready"
    STOPPING = "stopping"
    FAILED = "failed"


def _model_identity(model: Any) -> str:
    return " ".join(
        str(getattr(model, field_name, "") or "")
        for field_name in ("name", "filename", "architecture")
    ).casefold()


def _role_specific_runtime_args(model: Any, role: str) -> list[str]:
    """Return model-family flags needed for responsive local inference."""
    if role == "chat" and "qwen3" in _model_identity(model).replace("-", ""):
        return ["--reasoning", "off"]
    return []


@dataclass
class ModelProvider:
    """Compatibility facade used by chat and document services."""

    model_id: str
    role: str
    process: Any = None
    port: int | None = None
    client: Any = None
    status: str = ModelStatus.NOT_LOADED
    stderr_tail: list[str] = field(default_factory=list)
    api_key: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)
    query_prefix: str = ""

    async def embed_single(self, text: str) -> list[float]:
        return (await self.embed_batch([text]))[0]

    async def embed_query(self, text: str) -> list[float]:
        prepared = text
        if self.query_prefix and not text.startswith(self.query_prefix):
            prepared = f"{self.query_prefix}{text}"
        return (await self.embed_batch([prepared]))[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            return await self._request_embeddings(texts)
        except EmbeddingInputTooLong:
            return list(
                await asyncio.gather(
                    *(self._embed_with_splitting(text) for text in texts)
                )
            )

    async def _request_embeddings(self, texts: list[str]) -> list[list[float]]:
        if self.client is None:
            raise RuntimeError("Embedding runtime is not ready")
        response = await self.client.post("/v1/embeddings", json={"input": texts})
        if response.status_code >= 400 and any(
            fragment in response.text.lower()
            for fragment in (
                "too large to process",
                "physical batch size",
                "context size",
                "context window",
            )
        ):
            raise EmbeddingInputTooLong(response.text)
        response.raise_for_status()
        ordered = sorted(response.json().get("data") or [], key=lambda item: item.get("index", 0))
        embeddings = [item.get("embedding") for item in ordered]
        if len(embeddings) != len(texts) or any(not vector for vector in embeddings):
            raise RuntimeError(
                f"Embedding runtime returned {len(embeddings)} vectors for {len(texts)} inputs"
            )
        return embeddings

    async def _embed_with_splitting(self, text: str, depth: int = 0) -> list[float]:
        try:
            return (await self._request_embeddings([text]))[0]
        except EmbeddingInputTooLong:
            if depth >= 12 or len(text) < 2:
                raise RuntimeError(
                    "A document chunk could not fit in the embedding model context"
                )

        midpoint = len(text) // 2
        lower_bound = max(1, len(text) // 4)
        upper_bound = min(len(text) - 1, len(text) * 3 // 4)
        candidates = [
            index
            for index in (
                text.rfind(" ", lower_bound, midpoint + 1),
                text.find(" ", midpoint, upper_bound),
            )
            if index > 0
        ]
        split_at = min(candidates, key=lambda index: abs(index - midpoint)) if candidates else midpoint
        left, right = text[:split_at].strip(), text[split_at:].strip()
        if not left or not right:
            left, right = text[:midpoint], text[midpoint:]

        left_vector, right_vector = await asyncio.gather(
            self._embed_with_splitting(left, depth + 1),
            self._embed_with_splitting(right, depth + 1),
        )
        if len(left_vector) != len(right_vector):
            raise RuntimeError("Embedding runtime returned inconsistent vector dimensions")
        left_weight, right_weight = max(1, len(left)), max(1, len(right))
        total_weight = left_weight + right_weight
        combined = [
            (left_value * left_weight + right_value * right_weight) / total_weight
            for left_value, right_value in zip(left_vector, right_vector)
        ]
        norm = math.sqrt(sum(value * value for value in combined))
        if not math.isfinite(norm) or norm == 0:
            raise RuntimeError("Embedding runtime returned an empty or non-finite vector")
        return [value / norm for value in combined]


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
        threads: int = 0,
        role: str = "chat",
        api_key: str | None = None,
        extra_args: list[str] | None = None,
        host: str = "127.0.0.1",
        health_timeout: float = 60.0,
    ) -> None:
        self.model_path = Path(model_path)
        self.port = port
        self.binary_path = Path(binary_path)
        self.ctx_size = ctx_size
        self.gpu_layers = gpu_layers
        self.threads = threads
        self.role = role
        self.api_key = api_key or secrets.token_urlsafe(32)
        self.extra_args = list(extra_args or [])
        self.host = host
        self.health_timeout = health_timeout

        self.process: asyncio.subprocess.Process | None = None
        self._stdout_ring: deque[str] = deque(maxlen=_LOG_RING_SIZE)
        self._stderr_ring: deque[str] = deque(maxlen=_LOG_RING_SIZE)
        self._drain_tasks: list[asyncio.Task] = []
        self._started_at: float | None = None
        self._ownership = None

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
            "--threads", str(self.threads),
            "--no-webui",
            "--cors-origins", "http://nocai.invalid",
            "--no-cors-credentials",
            "--log-disable",
        ]

        if self.role == "embedding":
            cmd.extend(["--embedding", "--pooling", "cls"])
        cmd.extend(self.extra_args)

        logger.info(
            "Starting llama-server on %s:%s for %s model %s",
            self.host,
            self.port,
            self.role,
            self.model_path.name,
        )

        from backend.system.process_ownership import ProcessOwnership
        self._ownership = ProcessOwnership()
        try:
            self.process = await asyncio.create_subprocess_exec(
                *cmd,
                env={**os.environ, "LLAMA_API_KEY": self.api_key},
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=self._ownership.creationflags,
            )
            self._ownership.assign_and_resume(self.process.pid)
        except BaseException:
            await self._force_kill()
            raise

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
        except BaseException:
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
        if self.process is None or self.process.returncode is not None:
            self.process = None
            await self._stop_drains()
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
        await self._stop_drains()

    # ── health ─────────────────────────────────────────────────

    async def is_healthy(self) -> bool:
        """Check whether the server's /health endpoint responds 200."""
        if not self.is_running:
            return False
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(
                    f"http://{self.host}:{self.port}/health",
                    headers={"Authorization": f"Bearer {self.api_key}"},
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

    def poll(self) -> int | None:
        """Expose subprocess-style status for existing health consumers."""
        return self.exit_code

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
                    resp = await client.get(
                        url,
                        timeout=2.0,
                        headers={"Authorization": f"Bearer {self.api_key}"},
                    )
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
        if self.process is not None and self.process.returncode is None:
            self.process.kill()
            await self.process.wait()
        self.process = None
        await self._stop_drains()

    async def _stop_drains(self) -> None:
        tasks, self._drain_tasks = self._drain_tasks, []
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._ownership:
            self._ownership.close()
            self._ownership = None

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
        # Binary resolution is intentionally lazy: the backend remains usable
        # for administration when no inference runtime is installed or active.
        self._binary_path: Path | None = None
        self.chat_provider: ModelProvider | None = None
        self.embedding_provider: ModelProvider | None = None
        self.active_chat_model_id: str | None = None
        self.active_embedding_model_id: str | None = None
        self._status_callbacks: list[Any] = []
        self._generation_count = 0
        self._generation_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._session_factory: Any = None
        self._monitor_task: asyncio.Task | None = None
        self._stopping = False
        self.last_errors: dict[str, str] = {}

    # ── public API (called by main.py lifespan) ────────────────

    async def startup(self, session_factory: Any) -> None:
        """Reconcile DB state with running processes on app launch.

        Called once during FastAPI lifespan startup. Queries the database
        for models marked 'active' and attempts to load each one.
        Models that fail to load are marked 'error' in the database.
        """
        from backend.db.models import Model

        SessionLocal = session_factory
        self._session_factory = session_factory
        self._stopping = False
        with SessionLocal() as db:
            active_ids = [
                model.id
                for model in db.query(Model).filter(Model.status == "active").all()
            ]

        for model_id in active_ids:
            with SessionLocal() as db:
                model = db.query(Model).filter(Model.id == model_id).first()
                if model is None:
                    continue
                try:
                    await self.load_model(model, model.role)
                    model.validation_error = None
                except Exception as exc:
                    logger.exception("Failed to restore active model %s", model_id)
                    model.status = "error"
                    model.validation_error = str(exc)[:2000]
                db.commit()
        if self._monitor_task is None or self._monitor_task.done():
            self._monitor_task = asyncio.create_task(self._monitor(), name="model-runtime-monitor")

    async def shutdown(self) -> None:
        """Stop every managed llama-server. Called during app shutdown."""
        self._stopping = True
        if self._monitor_task:
            self._monitor_task.cancel()
            await asyncio.gather(self._monitor_task, return_exceptions=True)
            self._monitor_task = None
        if not self._servers:
            logger.info("No inference servers to stop")
            return

        logger.info("Stopping %d inference server(s)", len(self._servers))
        model_ids = list(self._servers)
        tasks = [self.unload_model(mid) for mid in model_ids]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for mid, result in zip(model_ids, results):
            if isinstance(result, Exception):
                logger.error("Error stopping server %s: %s", mid, result)

        logger.info("All inference servers stopped")

    # ── model management ───────────────────────────────────────

    async def load_model(
        self, model: Any, role: str, config: dict[str, Any] | None = None
    ) -> ModelProvider:
        async with self._lifecycle_lock:
            if self._stopping:
                raise LlamaServerError("Model runtime is shutting down")
            return await self._load_model_locked(model, role, config)

    async def _load_model_locked(
        self, model: Any, role: str, config: dict[str, Any] | None = None
    ) -> ModelProvider:
        """Load a model through an authenticated llama-server HTTP process."""
        if not hasattr(model, "id"):
            raise TypeError("load_model requires a Model instance")
        if role not in ("chat", "embedding") or model.role != role:
            raise ValueError(f"Model {model.id} is not a {role} model")

        current = self.get_chat_provider() if role == "chat" else self.get_embedding_provider()
        if current is not None and current.model_id == model.id and current.process.is_running:
            return current

        await self._unload_model_locked(role)
        model_path = Path(model.filepath)
        if not model_path.is_file():
            raise FileNotFoundError(f"Model file missing on disk: {model_path}")
        if self._binary_path is None:
            self._binary_path = self._resolve_binary()

        runtime_config = config or {}
        port = self._port_pool.acquire(model.id)
        identity = _model_identity(model)
        query_prefix = (
            "Represent this sentence for searching relevant passages: "
            if role == "embedding" and ("bge-" in identity or "bge_" in identity)
            else ""
        )
        provider = ModelProvider(
            model_id=model.id,
            role=role,
            port=port,
            status=ModelStatus.STARTING,
            query_prefix=query_prefix,
        )
        self._notify_status(model.id, ModelStatus.STARTING, role)
        server = LlamaServerProcess(
            model_path=model_path,
            port=port,
            binary_path=self._binary_path,
            ctx_size=runtime_config.get(
                "context_length", getattr(model, "context_length", None) or 4096
            ),
            gpu_layers=runtime_config.get(
                "gpu_layers", 0 if os.name == "nt" else getattr(self.settings, "default_gpu_layers", -1)
            ),
            threads=runtime_config.get(
                "threads", getattr(self.settings, "default_threads", 0)
            ),
            role=role,
            api_key=provider.api_key,
            extra_args=_role_specific_runtime_args(model, role),
        )
        provider.process = server
        try:
            await server.start()
            provider.client = httpx.AsyncClient(
                base_url=f"http://{server.host}:{server.port}",
                timeout=httpx.Timeout(300.0, connect=10.0),
                headers={"Authorization": f"Bearer {provider.api_key}"},
            )
        except BaseException:
            await server.stop()
            self._port_pool.release(port)
            provider.status = ModelStatus.FAILED
            self._notify_status(model.id, ModelStatus.FAILED, role)
            raise

        self._servers[model.id] = server
        provider.status = ModelStatus.READY
        if role == "chat":
            self.chat_provider = provider
            self.active_chat_model_id = model.id
        else:
            self.embedding_provider = provider
            self.active_embedding_model_id = model.id
        self._notify_status(model.id, ModelStatus.READY, role)
        self.last_errors.pop(role, None)
        self._persist_model_state(model.id, "active", role=role)
        return provider

    async def unload_model(self, model_id: str) -> None:
        async with self._lifecycle_lock:
            await self._unload_model_locked(model_id)

    async def _unload_model_locked(self, model_id: str) -> None:
        """Stop a model server, accepting either its id or its role."""
        provider: ModelProvider | None = None
        if model_id == "chat":
            provider = self.chat_provider
        elif model_id == "embedding":
            provider = self.embedding_provider
        elif self.active_chat_model_id == model_id:
            provider = self.chat_provider
        elif self.active_embedding_model_id == model_id:
            provider = self.embedding_provider
        if provider is not None:
            model_id = provider.model_id

        server = self._servers.pop(model_id, None)
        if provider is not None and provider.client is not None:
            await provider.client.aclose()
            provider.client = None
        if server is not None:
            await server.stop()
            self._port_pool.release(server.port)
            logger.info("Model %s unloaded", model_id)
        if self.active_chat_model_id == model_id:
            self.chat_provider = None
            self.active_chat_model_id = None
        if self.active_embedding_model_id == model_id:
            self.embedding_provider = None
            self.active_embedding_model_id = None
        if not self._stopping:
            self._persist_model_state(model_id, "imported")

    def _persist_model_state(self, model_id: str, status: str, error: str | None = None, role: str | None = None) -> None:
        if self._session_factory is None:
            return
        from backend.db.models import Model
        with self._session_factory() as db:
            if status == "active" and role:
                db.query(Model).filter(Model.role == role, Model.status == "active", Model.id != model_id).update({"status": "imported"})
            model = db.get(Model, model_id)
            if model:
                model.status = status
                model.validation_error = error
                db.commit()

    async def reconcile_runtime_state(self) -> None:
        """Clear active state as soon as an owned process exits or loses health."""
        async with self._lifecycle_lock:
            for role, provider in (("chat", self.chat_provider), ("embedding", self.embedding_provider)):
                if provider is None:
                    continue
                server = provider.process
                if server and server.is_running and await server.is_healthy():
                    continue
                diagnostics = server.diagnostics() if server else {}
                message = f"{role.capitalize()} runtime stopped or became unhealthy (exit code {diagnostics.get('exit_code')}); reload the model"
                model_id = provider.model_id
                await self._unload_model_locked(model_id)
                self.last_errors[role] = message
                self._persist_model_state(model_id, "error", message)
                self._notify_status(model_id, ModelStatus.FAILED, role)
                logger.error("%s", message)

    async def _monitor(self) -> None:
        while not self._stopping:
            await asyncio.sleep(2.0)
            try:
                await self.reconcile_runtime_state()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("Runtime reconciliation failed; retrying on the next probe", exc_info=False)

    def get_server(self, model_id: str) -> LlamaServerProcess | None:
        """Return the server process for a model, or None."""
        return self._servers.get(model_id)

    def get_server_by_role(
        self, role: str, session_factory: Any
    ) -> LlamaServerProcess | None:
        """Return the running server matching a model role."""
        provider = self.chat_provider if role == "chat" else self.embedding_provider
        if provider is None:
            return None
        return self._servers.get(provider.model_id)

    def get_chat_provider(self) -> ModelProvider | None:
        return self.chat_provider

    def get_embedding_provider(self) -> ModelProvider | None:
        return self.embedding_provider

    def get_reranker_provider(self) -> None:
        return None

    def on_status_change(self, callback: Any) -> None:
        self._status_callbacks.append(callback)

    def _notify_status(self, model_id: str, status: str, role: str) -> None:
        for callback in self._status_callbacks:
            try:
                callback(model_id, status, role)
            except Exception:
                logger.exception("Model status callback failed")

    async def wait_for_idle(self, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while self._generation_count > 0 and time.monotonic() < deadline:
            await asyncio.sleep(0.1)

    @asynccontextmanager
    async def generation_context(self):
        async with self._generation_lock:
            self._generation_count += 1
        try:
            yield
        finally:
            async with self._generation_lock:
                self._generation_count -= 1

    async def _get_free_port(self) -> int:
        """Return a currently available managed port for compatibility checks."""
        port = self._port_pool.acquire("probe")
        self._port_pool.release(port)
        return port

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
