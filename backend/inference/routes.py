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
            resp = await client.request(
                method,
                url,
                json=json_body,
                headers={"Authorization": f"Bearer {server.api_key}"},
            )
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
    client: httpx.AsyncClient | None = None
    try:
        client = httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT)
        req = client.build_request(
            method,
            url,
            json=json_body,
            headers={"Authorization": f"Bearer {server.api_key}"},
        )
        resp = await client.send(req, stream=True)

        async def _iterate():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        return StreamingResponse(
            _iterate(),
            media_type=resp.headers.get(
                "content-type", "text/event-stream"
            ),
            status_code=resp.status_code,
        )
    except httpx.HTTPError as exc:
        if client is not None:
            await client.aclose()
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
