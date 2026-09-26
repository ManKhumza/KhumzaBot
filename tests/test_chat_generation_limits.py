"""Chat generation must be bounded and must fail with an actionable status.

The reported defect was a 500 "Internal Server Error" from
``nocai:chat:sendMessage``. Reproduction on a real profile showed the backend
never sent ``max_tokens`` for a conversation that carried no explicit response
length, so llama-server generated until the model context window was exhausted
and the local runtime request exceeded the client read timeout. A real grounded
request on the reported machine took 453 seconds, so the previous 300-second
limit turned normal offline CPU latency into an opaque HTTP 500.
"""

import asyncio
import inspect

import httpx
import pytest
from fastapi import HTTPException

from backend.chat.routes import (
    ABSOLUTE_RESPONSE_TOKEN_LIMIT,
    call_llama_server,
    _resolve_response_token_limit,
)


def _messages(characters: int = 0) -> list[dict]:
    return [{"role": "system", "content": "x" * characters}, {"role": "user", "content": "5 herbs for pain"}]


def test_response_token_limit_is_always_bounded():
    """An unbounded conversation default can no longer request an endless answer."""
    limit = _resolve_response_token_limit(
        _messages(),
        conversation_limit=4096,
        request_limit=None,
        context_length=4096,
    )
    assert limit == ABSOLUTE_RESPONSE_TOKEN_LIMIT

    no_length = _resolve_response_token_limit(
        _messages(),
        conversation_limit=None,
        request_limit=None,
        context_length=4096,
    )
    assert no_length == ABSOLUTE_RESPONSE_TOKEN_LIMIT


def test_response_token_limit_respects_a_smaller_request_and_the_context_window():
    """Explicit request/conversation lengths win, and context leaves room to answer."""
    smaller = _resolve_response_token_limit(
        _messages(),
        conversation_limit=4096,
        request_limit=128,
        context_length=4096,
    )
    assert smaller == 128

    cramped = _resolve_response_token_limit(
        _messages(characters=4096 * 4),
        conversation_limit=4096,
        request_limit=None,
        context_length=4096,
    )
    assert cramped == 1


def test_local_model_budgets_are_generous_enough_for_cpu_only_hardware():
    """Loading and answering must not be bounded by a short default.

    Both budgets were too small for the reported machine: a 1.6 GB chat model
    once needed more than 60 seconds just to report healthy, and one grounded
    answer took 453 seconds.
    """
    from backend.config import get_settings
    from backend.inference.lifecycle import LlamaServerProcess

    settings = get_settings()
    assert settings.model_load_timeout_seconds >= 120
    assert settings.chat_generation_timeout_seconds >= 1800
    assert inspect.signature(LlamaServerProcess.__init__).parameters["health_timeout"].default >= 120


def test_chat_timeout_is_reported_as_an_actionable_unavailable_status():
    """A slow local model must not surface as an opaque 500."""
    class TimeoutClient:
        async def post(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("read operation timed out")

    class Provider:
        client = TimeoutClient()

        @property
        def authorization_headers(self):
            return {"Authorization": "Bearer test"}

    async def collect():
        return [chunk async for chunk in call_llama_server(
            provider=Provider(),
            messages=_messages(),
            temperature=0.0,
            max_tokens=64,
            stream=False,
        )]

    with pytest.raises(HTTPException) as failure:
        asyncio.run(collect())

    assert failure.value.status_code == 503
    assert "request time limit" in failure.value.detail
    assert "Shorten the question" in failure.value.detail


def test_chat_timeout_keeps_the_conversation_consistent(tmp_path, monkeypatch):
    """A timed-out answer stays retryable: no assistant row, no stuck generation."""
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    data_dir = tmp_path / "data"
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine, get_session_factory
    from backend.db.models import Model
    from backend.main import create_app

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    sent_payloads: list[dict] = []

    class SlowChatClient:
        context_length = 4096

        async def post(self, path, json=None, headers=None):
            assert path == "/v1/chat/completions"
            assert headers == {"Authorization": "Bearer test-key"}
            sent_payloads.append(json)
            raise httpx.ReadTimeout("read operation timed out")

    class FakeModelManager:
        """Reports both roles ready so the request reaches the model call."""

        def __init__(self):
            self.active_chat_model_id = "chat-model"
            self.active_embedding_model_id = "embedding-model"
            self.chat_provider = SimpleNamespace(
                model_id="chat-model", client=SlowChatClient(),
                authorization_headers={"Authorization": "Bearer test-key"},
            )
            self.embedding_provider = SimpleNamespace(model_id="embedding-model")

        def get_chat_provider(self):
            return self.chat_provider

        def get_embedding_provider(self):
            return self.embedding_provider

        async def load_model(self, model, role):
            raise AssertionError(f"The runtime is already ready for {role}")

        async def shutdown(self):
            return None

    transport_headers = {"X-NOC-AI-Backend-Token": "test-transport-secret"}
    with TestClient(create_app()) as client:
        login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "ChangeMe-12345!"},
            headers=transport_headers,
        )
        assert login.status_code == 200, login.text
        headers = {**transport_headers, "Authorization": f"Bearer {login.json()['token']}"}

        SessionLocal = get_session_factory(client.app.state.engine)
        with SessionLocal() as db:
            db.add(Model(
                id="chat-model", name="Chat", filename="chat.gguf", filepath="chat.gguf",
                size_bytes=1, role="chat", status="active", context_length=4096,
            ))
            db.commit()

        # "model_only" keeps the request independent of the retrieval fixtures.
        policy = client.patch(
            "/api/v1/settings", headers=headers,
            json={"behavior": {"responseMode": "model_only"}},
        )
        assert policy.status_code == 200, policy.text

        conversation = client.post(
            "/api/v1/chat/conversations", headers=headers,
            json={"title": "Timeout regression", "modelId": "chat-model"},
        )
        assert conversation.status_code == 200, conversation.text
        conversation_id = conversation.json()["id"]
        # Match the reported profile: the stored conversation keeps the 4096 default.
        assert conversation.json()["maxTokens"] == 4096

        client.app.state.model_manager = FakeModelManager()
        response = client.post(
            "/api/v1/chat/completions", headers=headers,
            json={
                "conversationId": conversation_id,
                "message": "5 herbs for pain",
                "modelId": "chat-model",
                "stream": False,
            },
        )

        assert response.status_code == 503, response.text
        assert "request time limit" in response.json()["detail"]
        assert sent_payloads and sent_payloads[0]["max_tokens"] == ABSOLUTE_RESPONSE_TOKEN_LIMIT
        assert sent_payloads[0]["stream"] is False

        stored = client.get(
            f"/api/v1/chat/conversations/{conversation_id}/messages", headers=headers,
        ).json()
        assert [message["role"] for message in stored] == ["user"]

        retried = client.post(
            "/api/v1/chat/completions", headers=headers,
            json={
                "conversationId": conversation_id,
                "message": "5 herbs for pain",
                "modelId": "chat-model",
                "stream": False,
            },
        )
        assert retried.status_code == 503, "A failed generation must free the conversation"
        assert len(sent_payloads) == 2


def test_chat_timeout_does_not_swallow_the_model_http_status():
    """A real model error keeps its own status instead of becoming a timeout error."""
    class StatusResponse:
        status_code = 400
        text = '{"error":{"message":"the request exceeds the available context size"}}'

    class StatusClient:
        async def post(self, *_args, **_kwargs):
            return StatusResponse()

    class Provider:
        client = StatusClient()

        @property
        def authorization_headers(self):
            return {"Authorization": "Bearer test"}

    async def collect():
        return [chunk async for chunk in call_llama_server(
            provider=Provider(),
            messages=_messages(),
            temperature=0.0,
            max_tokens=64,
            stream=False,
        )]

    with pytest.raises(HTTPException) as failure:
        asyncio.run(collect())

    assert failure.value.status_code == 400
    assert "context size" in failure.value.detail
