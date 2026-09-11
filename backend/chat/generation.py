"""Bounded ownership of in-flight chat work, including streamed responses."""
import asyncio
from dataclasses import dataclass
from fastapi import HTTPException


@dataclass
class Generation:
    user_id: str
    task: asyncio.Task | None = None
    cancelled: bool = False


class GenerationRegistry:
    def __init__(self, limit=1):
        self.limit = max(1, limit)
        self.active: dict[str, Generation] = {}

    def begin(self, conversation_id, user_id):
        if conversation_id in self.active or len(self.active) >= self.limit:
            raise HTTPException(429, "Another response is being generated; stop it or wait for completion")
        generation = Generation(user_id)
        self.active[conversation_id] = generation
        return generation

    def stop(self, conversation_id, user_id):
        generation = self.active.get(conversation_id)
        if generation is None:
            return False
        if generation.user_id != user_id:
            raise HTTPException(404, "Generation not found")
        generation.cancelled = True
        if generation.task and not generation.task.done():
            generation.task.cancel()
        return True

    def finish(self, conversation_id):
        self.active.pop(conversation_id, None)
