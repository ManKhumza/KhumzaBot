"""Regression coverage for llama.cpp's private per-process API credential."""

import asyncio
import httpx

from backend.chat.routes import call_llama_server
from backend.inference.lifecycle import ModelProvider


def _authenticated_provider(handler) -> ModelProvider:
    provider = ModelProvider(model_id="chat-model", role="chat")
    # Deliberately do not configure a client-wide Authorization header. Each
    # inference request must carry the provider's current credential itself.
    provider.client = httpx.AsyncClient(
        base_url="http://127.0.0.1:1",
        transport=httpx.MockTransport(handler),
    )
    return provider


def test_non_streaming_chat_always_sends_llama_api_key():
    seen_authorization = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers.get("Authorization"))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ready"}, "finish_reason": "stop"}]},
        )

    async def exercise():
        provider = _authenticated_provider(handler)
        try:
            chunks = [chunk async for chunk in call_llama_server(
                provider=provider,
                messages=[{"role": "user", "content": "hello"}],
                temperature=0.7,
                max_tokens=32,
                stream=False,
            )]
            assert chunks[0]["choices"][0]["message"]["content"] == "ready"
            assert seen_authorization == [f"Bearer {provider.api_key}"]
        finally:
            await provider.client.aclose()

    asyncio.run(exercise())


def test_streaming_chat_always_sends_llama_api_key():
    seen_authorization = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_authorization.append(request.headers.get("Authorization"))
        body = (
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(200, content=body, headers={"Content-Type": "text/event-stream"})

    async def exercise():
        provider = _authenticated_provider(handler)
        try:
            chunks = [chunk async for chunk in call_llama_server(
                provider=provider,
                messages=[{"role": "user", "content": "hello"}],
                temperature=0.7,
                max_tokens=32,
                stream=True,
            )]
            assert chunks[0]["choices"][0]["delta"]["content"] == "hello"
            assert seen_authorization == [f"Bearer {provider.api_key}"]
        finally:
            await provider.client.aclose()

    asyncio.run(exercise())
