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
            
            if item_id in self.running[priority]:
                return False
        return False
    
    async def _worker(self):
        while not self._shutdown.is_set():
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