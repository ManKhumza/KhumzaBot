import asyncio
import subprocess
import httpx
import os
import logging
import secrets
from dataclasses import dataclass, field
from typing import Optional, Dict
from contextlib import asynccontextmanager

from backend.config import Settings
from backend.db.models import Model

logger = logging.getLogger(__name__)

class ModelStatus(str):
    NOT_LOADED = "not_loaded"
    STARTING = "starting"
    READY = "ready"
    BUSY = "busy"
    STOPPING = "stopping"
    FAILED = "failed"

@dataclass
class ModelProvider:
    model_id: str
    role: str
    process: Optional[subprocess.Popen] = None
    port: Optional[int] = None
    client: Optional[httpx.AsyncClient] = None
    status: str = ModelStatus.NOT_LOADED
    stderr_tail: list[str] = field(default_factory=list)
    api_key: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)

    async def embed_single(self, text: str) -> list[float]:
        if not self.client:
            raise RuntimeError("Embedding runtime is not ready")
        response = await self.client.post(
            "/v1/embeddings",
            json={"input": text},
        )
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data") or []
        if not data or not data[0].get("embedding"):
            raise RuntimeError("Embedding runtime returned no vector")
        return data[0]["embedding"]

class ModelLifecycleManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.chat_provider: Optional[ModelProvider] = None
        self.embedding_provider: Optional[ModelProvider] = None
        self.active_chat_model_id: Optional[str] = None
        self.active_embedding_model_id: Optional[str] = None
        self._status_callbacks: list = []
        self._generation_count = 0
        self._generation_lock = asyncio.Lock()
    
    def on_status_change(self, callback):
        self._status_callbacks.append(callback)
    
    def _notify_status(self, model_id: str, status: str, role: str):
        for cb in self._status_callbacks:
            try:
                cb(model_id, status, role)
            except Exception as e:
                logger.error(f"Status callback error: {e}")
    
    async def startup(self, session_factory=None):
        """Reconcile persisted active flags with real runtime processes."""
        if session_factory is None:
            return
        with session_factory() as db:
            active_models = db.query(Model).filter(Model.status == "active").all()
            for model in active_models:
                if model.role not in ("chat", "embedding"):
                    model.status = "imported"
                    continue
                try:
                    await self.load_model(model, model.role)
                    model.validation_error = None
                except Exception as exc:
                    logger.exception("Could not restore active %s model %s", model.role, model.id)
                    model.status = "error"
                    model.validation_error = str(exc)[:2000]
            db.commit()
    
    async def shutdown(self):
        await self.unload_model("chat")
        await self.unload_model("embedding")
    
    async def load_model(self, model: Model, role: str, config: dict = None) -> ModelProvider:
        if model.role != role:
            raise ValueError(f"Model {model.id} is not a {role} model")
        
        if role == "chat" and self.active_chat_model_id == model.id and self.chat_provider:
            return self.chat_provider
        if role == "embedding" and self.active_embedding_model_id == model.id and self.embedding_provider:
            return self.embedding_provider
        
        await self.unload_model(role)
        
        provider = ModelProvider(model_id=model.id, role=role)
        
        self._notify_status(model.id, ModelStatus.STARTING, role)
        
        try:
            await self._start_llama_server(provider, model, config or {}, role)
            
            if role == "chat":
                self.chat_provider = provider
                self.active_chat_model_id = model.id
            else:
                self.embedding_provider = provider
                self.active_embedding_model_id = model.id
            
            self._notify_status(model.id, ModelStatus.READY, role)
            return provider
            
        except Exception as e:
            provider.status = ModelStatus.FAILED
            if provider.client:
                await provider.client.aclose()
                provider.client = None
            if provider.process and provider.process.poll() is None:
                provider.process.kill()
                await asyncio.get_event_loop().run_in_executor(None, provider.process.wait)
            self._notify_status(model.id, ModelStatus.FAILED, role)
            raise
    
    async def _start_llama_server(self, provider: ModelProvider, model: Model, config: dict, role: str):
        provider.port = await self._get_free_port()
        base_url = f"http://127.0.0.1:{provider.port}"
        
        cmd = [
            self.settings.llama_server_path,
            "-m", model.filepath,
            "-c", str(config.get("context_length", model.context_length or self.settings.default_context_length)),
            "-t", str(config.get("threads", self.settings.default_threads)),
            "-ngl", str(config.get("gpu_layers", self.settings.default_gpu_layers)),
            "--port", str(provider.port),
            "--host", "127.0.0.1",
            "--ctx-size", str(config.get("context_length", model.context_length or self.settings.default_context_length)),
            "--batch-size", str(config.get("batch_size", 512)),
            "--ubatch-size", str(config.get("ubatch_size", 512)),
            "--cont-batching",
            "--api-key", provider.api_key,
        ]

        if role == "embedding":
            cmd.extend(["--embedding", "--pooling", "cls"])
        
        if config.get("rope_freq_base"):
            cmd.extend(["--rope-freq-base", str(config["rope_freq_base"])])
        if config.get("rope_freq_scale"):
            cmd.extend(["--rope-freq-scale", str(config["rope_freq_scale"])])
        
        creationflags = 0
        if os.name == 'nt':
            creationflags = subprocess.CREATE_NO_WINDOW
        
        provider.process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
            env={**os.environ, "PATH": os.environ.get("PATH", "")},
        )
        
        asyncio.create_task(self._monitor_stderr(provider))
        
        await self._wait_for_ready(provider)
        
        provider.client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(300.0, connect=10.0),
            headers={"Authorization": f"Bearer {provider.api_key}"},
        )
        
        if not await self._health_check(provider):
            raise RuntimeError("llama-server failed its health check after startup")
        provider.status = ModelStatus.READY
    
    async def _get_free_port(self) -> int:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            return s.getsockname()[1]
    
    async def _wait_for_ready(self, provider: ModelProvider, timeout: float = 60.0):
        import time
        start = time.time()
        while time.time() - start < timeout:
            if provider.process and provider.process.poll() is not None:
                detail = " | ".join(provider.stderr_tail[-8:])
                raise RuntimeError(
                    f"llama-server exited with code {provider.process.returncode}"
                    + (f": {detail}" if detail else "")
                )
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    resp = await client.get(
                        f"http://127.0.0.1:{provider.port}/health",
                        headers={"Authorization": f"Bearer {provider.api_key}"},
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("status") == "ok":
                            return
            except:
                pass
            await asyncio.sleep(0.5)
        raise TimeoutError(f"llama-server not ready after {timeout}s")
    
    async def _monitor_stderr(self, provider: ModelProvider):
        if not provider.process or not provider.process.stderr:
            return
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, provider.process.stderr.readline)
            if not line:
                break
            text = line.decode(errors="replace").strip()
            provider.stderr_tail.append(text)
            del provider.stderr_tail[:-100]
            logger.info(f"[llama.cpp:{provider.model_id}] {text}")
    
    async def _health_check(self, provider: ModelProvider) -> bool:
        if not provider.client:
            return False
        try:
            resp = await provider.client.get("/health", timeout=5.0)
            return resp.status_code == 200 and resp.json().get("status") == "ok"
        except:
            return False
    
    async def unload_model(self, role: str):
        if role == "chat" and self.chat_provider:
            provider = self.chat_provider
            model_id = self.active_chat_model_id
            self.chat_provider = None
            self.active_chat_model_id = None
        elif role == "embedding" and self.embedding_provider:
            provider = self.embedding_provider
            model_id = self.active_embedding_model_id
            self.embedding_provider = None
            self.active_embedding_model_id = None
        else:
            return
        
        self._notify_status(model_id, ModelStatus.STOPPING, role)
        
        if provider.client:
            await provider.client.aclose()
            provider.client = None
        
        if provider.process:
            provider.process.terminate()
            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(None, provider.process.wait),
                    timeout=10.0
                )
            except asyncio.TimeoutError:
                provider.process.kill()
                await asyncio.get_event_loop().run_in_executor(None, provider.process.wait)
            provider.process = None
        
        self._notify_status(model_id, ModelStatus.NOT_LOADED, role)
    
    def get_chat_provider(self) -> Optional[ModelProvider]:
        return self.chat_provider
    
    def get_embedding_provider(self) -> Optional[ModelProvider]:
        return self.embedding_provider
    
    async def wait_for_idle(self, timeout: float = 30.0):
        start = asyncio.get_event_loop().time()
        while self._generation_count > 0:
            if asyncio.get_event_loop().time() - start > timeout:
                logger.warning(f"Timeout waiting for {self._generation_count} generations")
                break
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
