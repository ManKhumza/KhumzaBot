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
    api_key: str | None = None,
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
            headers = (
                {"Authorization": f"Bearer {api_key}"} if api_key else None
            )
            resp = await client.get(url, headers=headers)
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
            result = await check_server(
                server.host,
                server.port,
                api_key=getattr(server, "api_key", None),
            )
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
