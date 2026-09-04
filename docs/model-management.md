# NOC AI Assistant — Model Management & Inference

## Model Architecture

```
┌─────────────────────────────────────────────────────────────────┐
                        MODEL SUBSYSTEM                             
├─────────────────────────────────────────────────────────────────┤
                                                                 
  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐  
  │  Model Registry │    │  Lifecycle Mgr  │    │ Inference    │  
  │  (SQLite)       │◄───│  (State Machine)│◄───│ Queue        │  
  └────────┬────────┘    └────────┬────────┘    └──────┬───────┘  
           │                      │                    │          
           ▼                      ▼                    ▼          
  ┌─────────────────────────────────────────────────────────────┐ 
  │                    llama.cpp Runner                          │ 
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │ 
  │  │ Chat Model  │  │Embedding    │  │ Reranker (optional) │  │ 
  │  │ Process     │  │ Model Proc. │  │ Process             │  │ 
  │  └─────────────┘  └─────────────┘  └─────────────────────┘  │ 
  └─────────────────────────────────────────────────────────────┘ 
           │                      │                    │          
           ▼                      ▼                    ▼          
  ┌─────────────────────────────────────────────────────────────┐ 
  │                  Model Files (GGUF)                          │ 
  │  %APPDATA%\NOC AI Assistant\models\                          │ 
  │  ├── chat\                                                   │ 
  │  └── embedding\                                              │ 
  └─────────────────────────────────────────────────────────────┘ 
                                                                 
└─────────────────────────────────────────────────────────────────┘
```

## Model Provider Abstraction

```python
# backend/inference/providers/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Optional
from enum import Enum

class ModelRole(str, Enum):
    CHAT = "chat"
    EMBEDDING = "embedding"
    RERANKER = "reranker"

class ModelStatus(str, Enum):
    NOT_LOADED = "not_loaded"
    STARTING = "starting"
    READY = "ready"
    BUSY = "busy"
    STOPPING = "stopping"
    FAILED = "failed"

@dataclass
class ModelInfo:
    id: str
    name: str
    role: ModelRole
    filepath: str
    format: str
    architecture: str
    quantization: str
    parameter_count: str
    context_length: int
    embedding_dimension: Optional[int]
    size_bytes: int
    status: ModelStatus
    hardware_compatibility: dict
    config: dict

@dataclass
class ChatCompletionRequest:
    messages: list[dict]
    temperature: float = 0.7
    top_p: float = 0.95
    top_k: int = 40
    max_tokens: int = 4096
    stream: bool = True
    stop: list[str] | None = None
    repetition_penalty: float = 1.1
    presence_penalty: float = 0.0
    frequency_penalty: float = 0.0

@dataclass
class ChatCompletionChunk:
    id: str
    delta: str
    finish_reason: str | None
    usage: dict | None

@dataclass
class EmbeddingRequest:
    texts: list[str]
    normalize: bool = True
    truncate: bool = True

@dataclass
class EmbeddingResponse:
    embeddings: list[list[float]]
    usage: dict

class InferenceProvider(ABC):
    """Base interface for all inference providers."""
    
    @property
    @abstractmethod
    def role(self) -> ModelRole:
        pass
    
    @abstractmethod
    async def load(self, model_info: ModelInfo, config: dict) -> None:
        """Load model into memory."""
        pass
    
    @abstractmethod
    async def unload(self) -> None:
        """Unload model from memory."""
        pass
    
    @abstractmethod
    async def health_check(self) -> bool:
        """Check if model is responsive."""
        pass
    
    @property
    @abstractmethod
    def status(self) -> ModelStatus:
        pass

class ChatInferenceProvider(InferenceProvider):
    """Provider for chat/completion models."""
    
    @property
    def role(self) -> ModelRole:
        return ModelRole.CHAT
    
    @abstractmethod
    async def complete(
        self, 
        request: ChatCompletionRequest
    ) -> AsyncIterator[ChatCompletionChunk]:
        """Generate completion (streaming)."""
        pass
    
    @abstractmethod
    async def complete_sync(
        self, 
        request: ChatCompletionRequest
    ) -> str:
        """Generate completion (non-streaming)."""
        pass

class EmbeddingProvider(InferenceProvider):
    """Provider for embedding models."""
    
    @property
    def role(self) -> ModelRole:
        return ModelRole.EMBEDDING
    
    @abstractmethod
    async def embed(
        self, 
        request: EmbeddingRequest
    ) -> EmbeddingResponse:
        """Generate embeddings for texts."""
        pass
    
    @abstractmethod
    async def embed_single(self, text: str) -> list[float]:
        """Generate embedding for single text."""
        pass

class RerankerProvider(InferenceProvider):
    """Provider for reranking models."""
    
    @property
    def role(self) -> ModelRole:
        return ModelRole.RERANKER
    
    @abstractmethod
    async def rerank(
        self, 
        query: str, 
        documents: list[str], 
        top_k: int
    ) -> list[tuple[int, float]]:
        """Return (index, score) tuples for top-k documents."""
        pass
```

## llama.cpp Implementation

```python
# backend/inference/providers/llama_cpp.py
import asyncio
import json
import subprocess
import httpx
from pathlib import Path
from typing import AsyncIterator, Optional
import psutil

from backend.inference.providers.base import (
    ChatInferenceProvider,
    EmbeddingProvider,
    ModelInfo,
    ModelStatus,
    ChatCompletionRequest,
    ChatCompletionChunk,
    EmbeddingRequest,
    EmbeddingResponse,
    ModelRole,
)
from backend.config import Settings

class LlamaCppChatProvider(ChatInferenceProvider):
    """llama.cpp chat completion provider via HTTP API."""
    
    def __init__(self, settings: Settings):
        self.settings = settings
        self.process: Optional[subprocess.Popen] = None
        self.port: Optional[int] = None
        self.base_url: Optional[str] = None
        self.client: Optional[httpx.AsyncClient] = None
        self._model_info: Optional[ModelInfo] = None
        self._status = ModelStatus.NOT_LOADED
    
    @property
    def status(self) -> ModelStatus:
        return self._status
    
    async def load(self, model_info: ModelInfo, config: dict) -> None:
        self._model_info = model_info
        self._status = ModelStatus.STARTING
        
        # Find free port
        self.port = await self._get_free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        
        # Build llama-server command
        cmd = [
            str(self.settings.llama_server_path),
            "-m", model_info.filepath,
            "-c", str(config.get("context_length", model_info.context_length)),
            "-t", str(config.get("threads", self.settings.default_threads)),
            "-ngl", str(config.get("gpu_layers", self.settings.default_gpu_layers)),
            "--port", str(self.port),
            "--host", "127.0.0.1",
            "--embedding",  # Enable embedding endpoint
            "--ctx-size", str(config.get("context_length", model_info.context_length)),
            "--batch-size", str(config.get("batch_size", 512)),
            "--ubatch-size", str(config.get("ubatch_size", 512)),
            "--flash-attn",  # If supported
            "--cont-batching",
            "--mlock",  # Lock memory
            "--no-mmap",  # Disable mmap for better memory control
        ]
        
        # Add rope scaling if configured
        if config.get("rope_freq_base"):
            cmd.extend(["--rope-freq-base", str(config["rope_freq_base"])])
        if config.get("rope_freq_scale"):
            cmd.extend(["--rope-freq-scale", str(config["rope_freq_scale"])])
        
        # Windows: CREATE_NO_WINDOW
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW
        
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
            env={**os.environ, "PATH": os.environ.get("PATH", "")},
        )
        
        # Monitor stderr for errors
        asyncio.create_task(self._monitor_stderr())
        
        # Wait for server ready
        await self._wait_for_ready()
        
        # Create HTTP client
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(300.0, connect=10.0),
        )
        
        # Verify model loaded
        await self.health_check()
        self._status = ModelStatus.READY
    
    async def _wait_for_ready(self, timeout: float = 60.0) -> None:
        start = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - start < timeout:
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    resp = await client.get(f"{self.base_url}/health")
                    if resp.status_code == 200:
                        data = resp.json()
                        if data.get("status") == "ok":
                            return
            except:
                pass
            await asyncio.sleep(0.5)
        raise TimeoutError(f"llama-server not ready after {timeout}s")
    
    async def _monitor_stderr(self) -> None:
        if not self.process or not self.process.stderr:
            return
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, self.process.stderr.readline)
            if not line:
                break
            logger.debug(f"[llama.cpp] {line.decode().strip()}")
    
    async def unload(self) -> None:
        self._status = ModelStatus.STOPPING
        
        if self.client:
            await self.client.aclose()
            self.client = None
        
        if self.process:
            self.process.terminate()
            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(None, self.process.wait),
                    timeout=10.0
                )
            except asyncio.TimeoutError:
                self.process.kill()
                await asyncio.get_event_loop().run_in_executor(None, self.process.wait)
            self.process = None
        
        self._status = ModelStatus.NOT_LOADED
        self.port = None
        self.base_url = None
    
    async def health_check(self) -> bool:
        if not self.client:
            return False
        try:
            resp = await self.client.get("/health", timeout=5.0)
            return resp.status_code == 200 and resp.json().get("status") == "ok"
        except:
            return False
    
    async def complete(
        self, 
        request: ChatCompletionRequest
    ) -> AsyncIterator[ChatCompletionChunk]:
        self._status = ModelStatus.BUSY
        request_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        
        payload = {
            "model": self._model_info.name,
            "messages": request.messages,
            "temperature": request.temperature,
            "top_p": request.top_p,
            "top_k": request.top_k,
            "max_tokens": request.max_tokens,
            "stream": request.stream,
            "stop": request.stop,
            "repeat_penalty": request.repetition_penalty,
            "presence_penalty": request.presence_penalty,
            "frequency_penalty": request.frequency_penalty,
        }
        
        try:
            async with self.client.stream(
                "POST", "/v1/chat/completions", json=payload, timeout=300.0
            ) as response:
                if response.status_code != 200:
                    error = await response.aread()
                    raise RuntimeError(f"llama.cpp error: {error.decode()}")
                
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break
                    
                    try:
                        chunk = json.loads(data)
                        choice = chunk["choices"][0]
                        delta = choice["delta"].get("content", "")
                        finish_reason = choice.get("finish_reason")
                        
                        yield ChatCompletionChunk(
                            id=request_id,
                            delta=delta,
                            finish_reason=finish_reason,
                            usage=chunk.get("usage"),
                        )
                        
                        if finish_reason:
                            break
                    except json.JSONDecodeError:
                        continue
        finally:
            self._status = ModelStatus.READY
    
    async def complete_sync(self, request: ChatCompletionRequest) -> str:
        request.stream = False
        chunks = []
        async for chunk in self.complete(request):
            chunks.append(chunk.delta)
        return "".join(chunks)


class LlamaCppEmbeddingProvider(EmbeddingProvider):
    """llama.cpp embedding provider."""
    
    def __init__(self, settings: Settings):
        self.settings = settings
        self.process: Optional[subprocess.Popen] = None
        self.port: Optional[int] = None
        self.base_url: Optional[str] = None
        self.client: Optional[httpx.AsyncClient] = None
        self._model_info: Optional[ModelInfo] = None
        self._status = ModelStatus.NOT_LOADED
    
    @property
    def status(self) -> ModelStatus:
        return self._status
    
    async def load(self, model_info: ModelInfo, config: dict) -> None:
        # Similar to chat provider but optimized for embeddings
        self._model_info = model_info
        self._status = ModelStatus.STARTING
        
        self.port = await self._get_free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        
        cmd = [
            str(self.settings.llama_server_path),
            "-m", model_info.filepath,
            "-c", str(config.get("context_length", 512)),  # Smaller for embeddings
            "-t", str(config.get("threads", self.settings.default_threads)),
            "-ngl", str(config.get("gpu_layers", self.settings.default_gpu_layers)),
            "--port", str(self.port),
            "--host", "127.0.0.1",
            "--embedding",
            "--pooling", "mean",  # or 'cls', 'last'
            "--batch-size", "512",
            "--ubatch-size", "512",
            "--mlock",
            "--no-mmap",
        ]
        
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
        )
        
        await self._wait_for_ready()
        
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
        
        await self.health_check()
        self._status = ModelStatus.READY
    
    async def unload(self) -> None:
        self._status = ModelStatus.STOPPING
        if self.client:
            await self.client.aclose()
        if self.process:
            self.process.terminate()
            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(None, self.process.wait),
                    timeout=10.0
                )
            except asyncio.TimeoutError:
                self.process.kill()
        self._status = ModelStatus.NOT_LOADED
    
    async def health_check(self) -> bool:
        if not self.client:
            return False
        try:
            resp = await self.client.get("/health", timeout=5.0)
            return resp.status_code == 200
        except:
            return False
    
    async def embed(self, request: EmbeddingRequest) -> EmbeddingResponse:
        if self._status != ModelStatus.READY:
            raise RuntimeError("Model not ready")
        
        self._status = ModelStatus.BUSY
        try:
            payload = {
                "model": self._model_info.name,
                "input": request.texts,
                "encoding_format": "float",
            }
            resp = await self.client.post("/v1/embeddings", json=payload, timeout=60.0)
            resp.raise_for_status()
            data = resp.json()
            
            embeddings = [d["embedding"] for d in data["data"]]
            
            if request.normalize:
                import numpy as np
                embeddings = [np.array(e) / np.linalg.norm(e) for e in embeddings]
                embeddings = [e.tolist() for e in embeddings]
            
            return EmbeddingResponse(
                embeddings=embeddings,
                usage=data.get("usage", {}),
            )
        finally:
            self._status = ModelStatus.READY
    
    async def embed_single(self, text: str) -> list[float]:
        resp = await self.embed(EmbeddingRequest(texts=[text]))
        return resp.embeddings[0]
```

## Model Lifecycle Manager

```python
# backend/inference/lifecycle.py
import asyncio
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum
import uuid

from backend.inference.providers.base import (
    ModelInfo, ModelStatus, ModelRole,
    ChatInferenceProvider, EmbeddingProvider,
)
from backend.inference.providers.llama_cpp import (
    LlamaCppChatProvider, LlamaCppEmbeddingProvider,
)
from backend.config import Settings
from backend.db.database import Database

class ModelLifecycleManager:
    """Manages model loading, unloading, and state transitions."""
    
    def __init__(self, settings: Settings, db: Database):
        self.settings = settings
        self.db = db
        self.chat_provider: Optional[ChatInferenceProvider] = None
        self.embedding_provider: Optional[EmbeddingProvider] = None
        self.active_chat_model_id: Optional[str] = None
        self.active_embedding_model_id: Optional[str] = None
        self._status_callbacks: list[callable] = []
        self._generation_count = 0
        self._generation_lock = asyncio.Lock()
    
    def on_status_change(self, callback: callable):
        self._status_callbacks.append(callback)
    
    def _notify_status(self, model_id: str, status: ModelStatus, role: ModelRole):
        for cb in self._status_callbacks:
            try:
                cb(model_id, status, role)
            except Exception as e:
                logger.error(f"Status callback error: {e}")
    
    async def startup(self):
        """Initialize and load default models."""
        # Load default chat model
        default_chat = await self.db.models.get_default_chat()
        if default_chat:
            await self.load_model(default_chat.id, ModelRole.CHAT)
        
        # Load default embedding model
        default_embedding = await self.db.models.get_default_embedding()
        if default_embedding:
            await self.load_model(default_embedding.id, ModelRole.EMBEDDING)
    
    async def shutdown(self):
        """Unload all models."""
        await self.unload_model(ModelRole.CHAT)
        await self.unload_model(ModelRole.EMBEDDING)
    
    async def load_model(self, model_id: str, role: ModelRole) -> ModelInfo:
        """Load a model for the given role."""
        model_info = await self.db.models.get(model_id)
        if not model_info:
            raise ValueError(f"Model {model_id} not found")
        
        if model_info.role != role:
            raise ValueError(f"Model {model_id} is not a {role.value} model")
        
        # Check if already loaded
        if role == ModelRole.CHAT and self.active_chat_model_id == model_id:
            return model_info
        if role == ModelRole.EMBEDDING and self.active_embedding_model_id == model_id:
            return model_info
        
        # Unload current model for this role
        await self.unload_model(role)
        
        # Load new model
        if role == ModelRole.CHAT:
            provider = LlamaCppChatProvider(self.settings)
            self.chat_provider = provider
        elif role == ModelRole.EMBEDDING:
            provider = LlamaCppEmbeddingProvider(self.settings)
            self.embedding_provider = provider
        else:
            raise ValueError(f"Unsupported role: {role}")
        
        # Update status in DB
        await self.db.models.update_status(model_id, ModelStatus.STARTING)
        self._notify_status(model_id, ModelStatus.STARTING, role)
        
        try:
            config = await self.db.model_configs.get(model_id) or {}
            await provider.load(model_info, config)
            
            # Update active model
            if role == ModelRole.CHAT:
                self.active_chat_model_id = model_id
            else:
                self.active_embedding_model_id = model_id
            
            await self.db.models.update_status(model_id, ModelStatus.READY)
            self._notify_status(model_id, ModelStatus.READY, role)
            
            return model_info
        except Exception as e:
            await self.db.models.update_status(model_id, ModelStatus.FAILED, str(e))
            self._notify_status(model_id, ModelStatus.FAILED, role)
            raise
    
    async def unload_model(self, role: ModelRole):
        """Unload the active model for a role."""
        if role == ModelRole.CHAT and self.chat_provider:
            model_id = self.active_chat_model_id
            await self.chat_provider.unload()
            self.chat_provider = None
            self.active_chat_model_id = None
            if model_id:
                await self.db.models.update_status(model_id, ModelStatus.NOT_LOADED)
                self._notify_status(model_id, ModelStatus.NOT_LOADED, role)
        
        elif role == ModelRole.EMBEDDING and self.embedding_provider:
            model_id = self.active_embedding_model_id
            await self.embedding_provider.unload()
            self.embedding_provider = None
            self.active_embedding_model_id = None
            if model_id:
                await self.db.models.update_status(model_id, ModelStatus.NOT_LOADED)
                self._notify_status(model_id, ModelStatus.NOT_LOADED, role)
    
    def get_chat_provider(self) -> Optional[ChatInferenceProvider]:
        return self.chat_provider
    
    def get_embedding_provider(self) -> Optional[EmbeddingProvider]:
        return self.embedding_provider
    
    async def wait_for_idle(self, timeout: float = 30.0):
        """Wait for all generations to complete."""
        start = asyncio.get_event_loop().time()
        while self._generation_count > 0:
            if asyncio.get_event_loop().time() - start > timeout:
                logger.warning(f"Timeout waiting for {self._generation_count} generations")
                break
            await asyncio.sleep(0.1)
    
    @asynccontextmanager
    async def generation_context(self):
        """Context manager for tracking active generations."""
        async with self._generation_lock:
            self._generation_count += 1
        try:
            yield
        finally:
            async with self._generation_lock:
                self._generation_count -= 1
```

## Inference Queue

```python
# backend/inference/queue.py
import asyncio
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Awaitable, Any
import uuid
from collections import deque

class JobPriority(int, Enum):
    INTERACTIVE_CHAT = 1
    KNOWLEDGE_RETRIEVAL = 2
    SMALL_EMBEDDING = 3
    BULK_INGESTION = 4
    MAINTENANCE = 5

@dataclass
class QueueItem:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    priority: JobPriority = JobPriority.INTERACTIVE_CHAT
    coro_factory: Callable[[], Awaitable[Any]] = None
    future: asyncio.Future = field(default_factory=asyncio.Future)
    metadata: dict = field(default_factory=dict)
    cancellation_token: asyncio.Event = field(default_factory=asyncio.Event)

class InferenceQueue:
    """Priority-based async queue for inference workloads."""
    
    def __init__(self, max_concurrent: dict[JobPriority, int] = None):
        self.max_concurrent = max_concurrent or {
            JobPriority.INTERACTIVE_CHAT: 1,
            JobPriority.KNOWLEDGE_RETRIEVAL: 2,
            JobPriority.SMALL_EMBEDDING: 2,
            JobPriority.BULK_INGESTION: 1,
            JobPriority.MAINTENANCE: 1,
        }
        self.queues: dict[JobPriority, deque[QueueItem]] = {
            p: deque() for p in JobPriority
        }
        self.running: dict[JobPriority, set[str]] = {
            p: set() for p in JobPriority
        }
        self.worker_task: asyncio.Task | None = None
        self._shutdown = asyncio.Event()
    
    async def start(self):
        self.worker_task = asyncio.create_task(self._worker())
    
    async def stop(self):
        self._shutdown.set()
        if self.worker_task:
            await self.worker_task
    
    def enqueue(
        self, 
        coro_factory: Callable[[], Awaitable[Any]], 
        priority: JobPriority = JobPriority.INTERACTIVE_CHAT,
        metadata: dict = None
    ) -> asyncio.Future:
        item = QueueItem(
            priority=priority,
            coro_factory=coro_factory,
            metadata=metadata or {},
        )
        self.queues[priority].append(item)
        return item.future
    
    def cancel(self, item_id: str) -> bool:
        for priority in JobPriority:
            for item in self.queues[priority]:
                if item.id == item_id:
                    item.cancellation_token.set()
                    item.future.cancel()
                    self.queues[priority].remove(item)
                    return True
            
            # Check running
            if item_id in self.running[priority]:
                # Can't easily cancel running, but mark for cleanup
                return False
        return False
    
    async def _worker(self):
        while not self._shutdown.is_set():
            # Find highest priority item that can run
            item = None
            item_priority = None
            
            for priority in JobPriority:
                if len(self.running[priority]) < self.max_concurrent[priority]:
                    if self.queues[priority]:
                        item = self.queues[priority].popleft()
                        item_priority = priority
                        break
            
            if item:
                self.running[item_priority].add(item.id)
                asyncio.create_task(self._run_item(item, item_priority))
            else:
                # Nothing to run, wait a bit
                await asyncio.sleep(0.1)
    
    async def _run_item(self, item: QueueItem, priority: JobPriority):
        try:
            if item.cancellation_token.is_set():
                item.future.cancel()
                return
            
            result = await item.coro_factory()
            if not item.future.done():
                item.future.set_result(result)
        except asyncio.CancelledError:
            if not item.future.done():
                item.future.cancel()
        except Exception as e:
            if not item.future.done():
                item.future.set_exception(e)
        finally:
            self.running[priority].discard(item.id)
```

## Hardware Detection & Resource Estimation

```python
# backend/system/hardware.py
import psutil
import platform
import subprocess
import json
from dataclasses import dataclass
from typing import Optional, List
from pathlib import Path

@dataclass
class GPUInfo:
    name: str
    vendor: str  # NVIDIA, AMD, Intel
    vram_total_mb: int
    vram_free_mb: int
    driver_version: str
    cuda_version: Optional[str] = None
    vulkan_version: Optional[str] = None
    compute_capability: Optional[str] = None

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
    cpu_architecture: str
    
    # Memory
    total_memory_mb: int
    available_memory_mb: int
    
    # GPU
    gpus: List[GPUInfo]
    
    # Disk
    data_disk_free_gb: float
    data_disk_total_gb: float
    
    # llama.cpp capabilities
    llama_cpp_version: str
    supports_cuda: bool
    supports_vulkan: bool
    supports_metal: bool
    supports_opencl: bool
    supports_rocm: bool

@dataclass
class ResourceEstimate:
    model_size_mb: float
    estimated_ram_mb: float
    estimated_vram_mb: float
    kv_cache_mb_per_1k_tokens: float
    compatibility: str  # RECOMMENDED, COMPATIBLE, LIMITED, NOT_RECOMMENDED, UNSUPPORTED
    warnings: List[str]
    reasons: List[str]

async def detect_hardware() -> HardwareInfo:
    """Detect system hardware capabilities."""
    
    # OS Info
    os_name = platform.system()
    os_version = platform.version()
    os_build = platform.platform()
    
    # CPU Info
    cpu_name = platform.processor()
    cpu_cores_logical = psutil.cpu_count(logical=True)
    cpu_cores_physical = psutil.cpu_count(logical=False)
    cpu_freq = psutil.cpu_freq()
    cpu_freq_max_mhz = cpu_freq.max if cpu_freq else 0
    cpu_architecture = platform.machine()
    
    # Memory
    mem = psutil.virtual_memory()
    total_memory_mb = mem.total // (1024 * 1024)
    available_memory_mb = mem.available // (1024 * 1024)
    
    # GPU Detection
    gpus = await detect_gpus()
    
    # Disk
    data_dir = Path(os.getenv("NOC_AI_DATA_DIR", ".")).resolve()
    disk = psutil.disk_usage(str(data_dir))
    data_disk_free_gb = disk.free / (1024**3)
    data_disk_total_gb = disk.total / (1024**3)
    
    # llama.cpp capabilities
    llama_info = await detect_llama_cpp_capabilities()
    
    return HardwareInfo(
        os_name=os_name,
        os_version=os_version,
        os_build=os_build,
        cpu_name=cpu_name,
        cpu_cores_logical=cpu_cores_logical,
        cpu_cores_physical=cpu_cores_physical,
        cpu_freq_max_mhz=cpu_freq_max_mhz,
        cpu_architecture=cpu_architecture,
        total_memory_mb=total_memory_mb,
        available_memory_mb=available_memory_mb,
        gpus=gpus,
        data_disk_free_gb=data_disk_free_gb,
        data_disk_total_gb=data_disk_total_gb,
        **llama_info
    )

async def detect_gpus() -> List[GPUInfo]:
    """Detect GPUs using multiple methods."""
    gpus = []
    
    # Try nvidia-smi
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version", 
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            for line in result.stdout.strip().split('\n'):
                name, total, free, driver = line.split(', ')
                gpus.append(GPUInfo(
                    name=name.strip(),
                    vendor="NVIDIA",
                    vram_total_mb=int(total.strip()),
                    vram_free_mb=int(free.strip()),
                    driver_version=driver.strip(),
                    cuda_version=await get_cuda_version(),
                ))
    except:
        pass
    
    # Try rocm-smi for AMD
    try:
        result = subprocess.run(
            ["rocm-smi", "--showproductname", "--showvram", "--showdriverversion", "--json"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            for gpu_id, info in data.items():
                gpus.append(GPUInfo(
                    name=info.get("Card series", "AMD GPU"),
                    vendor="AMD",
                    vram_total_mb=int(info.get("VRAM Total Memory (B)", 0)) // (1024*1024),
                    vram_free_mb=int(info.get("VRAM Free Memory (B)", 0)) // (1024*1024),
                    driver_version=info.get("Driver Version", "unknown"),
                ))
    except:
        pass
    
    # Fallback: WMI on Windows
    if not gpus and platform.system() == "Windows":
        try:
            result = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "name,AdapterRAM,DriverVersion", "/format:csv"],
                capture_output=True, text=True, timeout=10
            )
            # Parse WMI output
        except:
            pass
    
    return gpus

async def get_cuda_version() -> Optional[str]:
    try:
        result = subprocess.run(["nvcc", "--version"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.split('\n'):
            if 'release' in line:
                return line.split('release')[-1].split(',')[0].strip()
    except:
        pass
    return None

async def detect_llama_cpp_capabilities() -> dict:
    """Detect llama.cpp build capabilities."""
    llama_server = Path(os.getenv("NOC_AI_LLAMA_SERVER", "llama-server"))
    try:
        result = subprocess.run(
            [str(llama_server), "--help"],
            capture_output=True, text=True, timeout=10
        )
        help_text = result.stdout
        
        return {
            "llama_cpp_version": extract_version(help_text),
            "supports_cuda": "CUDA" in help_text or "ggml-cuda" in help_text,
            "supports_vulkan": "Vulkan" in help_text or "ggml-vulkan" in help_text,
            "supports_metal": "Metal" in help_text or "ggml-metal" in help_text,
            "supports_opencl": "OpenCL" in help_text or "ggml-opencl" in help_text,
            "supports_rocm": "HIP" in help_text or "ggml-hip" in help_text,
        }
    except:
        return {
            "llama_cpp_version": "unknown",
            "supports_cuda": False,
            "supports_vulkan": False,
            "supports_metal": False,
            "supports_opencl": False,
            "supports_rocm": False,
        }

def estimate_model_requirements(
    model_path: str, 
    hardware: HardwareInfo,
    context_length: int = 4096
) -> ResourceEstimate:
    """Estimate resource requirements for a GGUF model."""
    import gguf
    
    reader = gguf.GGUFReader(model_path)
    metadata = dict(reader.get_all_metadata())
    
    arch = metadata.get('general.architecture', ['unknown'])[0]
    n_params = metadata.get('general.parameter_count', [0])[0]
    n_layers = metadata.get(f'{arch}.block_count', [0])[0]
    embed_dim = metadata.get(f'{arch}.embedding_length', [0])[0]
    
    file_size_mb = Path(model_path).stat().st_size / (1024 * 1024)
    
    # Estimate weight memory (file size + overhead)
    weight_memory_mb = file_size_mb * 1.15
    
    # KV cache: 2 * layers * embed_dim * 2 bytes (FP16) * context_tokens
    kv_per_token_mb = (2 * n_layers * embed_dim * 2) / (1024 * 1024)
    kv_memory_mb = kv_per_token_mb * context_length
    
    # Activation memory (rough estimate)
    activation_mb = (n_layers * embed_dim * 4 * context_length) / (1024 * 1024) * 0.1
    
    # Total RAM estimate
    total_ram_mb = weight_memory_mb + kv_memory_mb + activation_mb + 1024  # 1GB overhead
    
    # GPU estimation
    gpu_offload_possible = any(
        g.vram_free_mb > weight_memory_mb * 1.2 for g in hardware.gpus
    )
    estimated_vram_mb = weight_memory_mb * 1.2 if gpu_offload_possible else 0
    
    # Assess compatibility
    available_ram = hardware.available_memory_mb
    ram_ratio = total_ram_mb / available_ram if available_ram > 0 else float('inf')
    
    if ram_ratio < 0.5:
        compatibility = "RECOMMENDED"
    elif ram_ratio < 0.75:
        compatibility = "COMPATIBLE"
    elif ram_ratio < 1.0:
        compatibility = "LIMITED"
    elif ram_ratio < 1.5:
        compatibility = "NOT_RECOMMENDED"
    else:
        compatibility = "UNSUPPORTED"
    
    warnings = []
    reasons = []
    
    if ram_ratio > 0.9:
        warnings.append(f"Model requires ~{total_ram_mb:.0f}MB RAM, only {available_ram}MB available")
    if not gpu_offload_possible and hardware.gpus:
        warnings.append("No GPU with sufficient VRAM for full offload")
    if not hardware.gpus:
        reasons.append("Running on CPU only - inference will be slower")
    else:
        reasons.append(f"GPU available: {', '.join(g.name for g in hardware.gpus)}")
    
    return ResourceEstimate(
        model_size_mb=file_size_mb,
        estimated_ram_mb=total_ram_mb,
        estimated_vram_mb=estimated_vram_mb,
        kv_cache_mb_per_1k_tokens=kv_per_token_mb * 1000,
        compatibility=compatibility,
        warnings=warnings,
        reasons=reasons,
    )
```

## Model Import & Validation

```python
# backend/models/service.py
import gguf
import hashlib
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
import shutil

@dataclass
class ModelScanResult:
    filepath: str
    filename: str
    size_bytes: int
    is_valid_gguf: bool
    metadata: dict | None
    error: str | None
    suggested_role: str | None  # 'chat' or 'embedding'
    suggested_name: str

@dataclass
class ImportResult:
    model_id: str
    model_path: str
    copied: bool  # True if copied to managed dir, False if referenced in-place

class ModelService:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.models_dir = Path(settings.models_dir)
        self.models_dir.mkdir(parents=True, exist_ok=True)
        (self.models_dir / "chat").mkdir(exist_ok=True)
        (self.models_dir / "embedding").mkdir(exist_ok=True)
    
    async def scan_directory(self, path: str) -> list[ModelScanResult]:
        """Scan a directory for GGUF models."""
        results = []
        scan_path = Path(path).resolve()
        
        if not scan_path.exists() or not scan_path.is_dir():
            raise ValueError("Invalid directory path")
        
        # Security: Ensure path is not system-critical
        self._validate_safe_path(scan_path)
        
        for file_path in scan_path.rglob("*.gguf"):
            result = await self._analyze_model_file(file_path)
            results.append(result)
        
        return results
    
    async def _analyze_model_file(self, file_path: Path) -> ModelScanResult:
        try:
            reader = gguf.GGUFReader(str(file_path))
            metadata = dict(reader.get_all_metadata())
            
            arch = metadata.get('general.architecture', ['unknown'])[0]
            name = metadata.get('general.name', [file_path.stem])[0]
            quant = metadata.get('general.quantization_version', ['unknown'])[0]
            
            # Determine role from architecture and metadata
            is_embedding = any(
                k in str(metadata).lower() 
                for k in ['embedding', 'embed', 'bge', 'e5', 'gte', 'nomic']
            )
            
            # Check tokenizer type
            tokenizer = metadata.get('tokenizer.ggml.model', [''])[0]
            
            suggested_role = "embedding" if is_embedding else "chat"
            suggested_name = f"{name} ({quant})"
            
            return ModelScanResult(
                filepath=str(file_path),
                filename=file_path.name,
                size_bytes=file_path.stat().st_size,
                is_valid_gguf=True,
                metadata=metadata,
                error=None,
                suggested_role=suggested_role,
                suggested_name=suggested_name,
            )
        except Exception as e:
            return ModelScanResult(
                filepath=str(file_path),
                filename=file_path.name,
                size_bytes=file_path.stat().st_size,
                is_valid_gguf=False,
                metadata=None,
                error=str(e),
                suggested_role=None,
                suggested_name=file_path.stem,
            )
    
    async def import_model(
        self, 
        source_path: str, 
        role: str,
        name: str | None = None,
        copy: bool = True
    ) -> ImportResult:
        """Import a model into the managed registry."""
        source = Path(source_path).resolve()
        self._validate_safe_path(source)
        
        if not source.exists():
            raise FileNotFoundError(f"Model not found: {source_path}")
        
        # Validate GGUF
        scan = await self._analyze_model_file(source)
        if not scan.is_valid_gguf:
            raise ValueError(f"Invalid GGUF file: {scan.error}")
        
        if scan.suggested_role != role:
            logger.warning(f"Model appears to be {scan.suggested_role}, importing as {role}")
        
        # Determine destination
        role_dir = self.models_dir / role
        dest_filename = source.name
        dest_path = role_dir / dest_filename
        
        # Handle duplicates
        counter = 1
        while dest_path.exists():
            stem = source.stem
            suffix = source.suffix
            dest_filename = f"{stem}_{counter}{suffix}"
            dest_path = role_dir / dest_filename
            counter += 1
        
        if copy:
            # Copy to managed directory
            shutil.copy2(source, dest_path)
            copied = True
        else:
            # Reference in place (symlink or just record path)
            # For safety, we'll still copy but allow user to choose
            shutil.copy2(source, dest_path)
            copied = True
        
        # Compute hash
        file_hash = await self._compute_hash(dest_path)
        
        # Check for duplicate by hash
        existing = await self.db.models.find_by_hash(file_hash)
        if existing:
            dest_path.unlink()
            raise ValueError(f"Model already imported: {existing.name}")
        
        # Create model record
        model_info = ModelInfo(
            id=str(uuid.uuid4()),
            name=name or scan.suggested_name,
            filename=dest_filename,
            filepath=str(dest_path),
            format="GGUF",
            size_bytes=source.stat().st_size,
            architecture=scan.metadata.get('general.architecture', ['unknown'])[0],
            quantization=str(scan.metadata.get('general.quantization_version', ['unknown'])[0]),
            parameter_count=str(scan.metadata.get('general.parameter_count', ['unknown'])[0]),
            context_length=scan.metadata.get(f'{arch}.context_length', [4096])[0] if 'arch' in locals() else 4096,
            embedding_dimension=scan.metadata.get(f'{arch}.embedding_length', [None])[0] if role == "embedding" else None,
            role=role,
            status="imported",
            hardware_compatibility={},
            metadata=scan.metadata,
        )
        
        await self.db.models.create(model_info)
        
        return ImportResult(
            model_id=model_info.id,
            model_path=str(dest_path),
            copied=copied,
        )
    
    def _validate_safe_path(self, path: Path):
        """Prevent access to system directories."""
        system_paths = [
            Path("C:/Windows"),
            Path("C:/Program Files"),
            Path("C:/Program Files (x86)"),
            Path(os.environ.get("SYSTEMROOT", "C:/Windows")),
        ]
        
        for sys_path in system_paths:
            try:
                path.relative_to(sys_path)
                raise SecurityError(f"Access to system directory not allowed: {sys_path}")
            except ValueError:
                pass  # Good, not under system path
    
    async def _compute_hash(self, path: Path) -> str:
        sha256 = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()
```

---
*Generated during Phase 1 — Architecture*