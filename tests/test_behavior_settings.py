"""Administrator behavior policy and grounded chat regression coverage."""

from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient


TRANSPORT_HEADERS = {"X-NOC-AI-Backend-Token": "test-transport-secret"}


def _configure_isolated_profile(tmp_path: Path, monkeypatch) -> Path:
    data_dir = tmp_path / "data"
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", TRANSPORT_HEADERS["X-NOC-AI-Backend-Token"])

    from backend.config import get_settings
    from backend.db.database import create_db_engine

    get_settings.cache_clear()
    create_db_engine.cache_clear()
    return data_dir


def _login(client: TestClient, username: str = "admin", password: str = "ChangeMe-12345!") -> dict:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
        headers=TRANSPORT_HEADERS,
    )
    assert response.status_code == 200, response.text
    return {**TRANSPORT_HEADERS, "Authorization": f"Bearer {response.json()['token']}"}


def test_admin_behavior_settings_round_trip_and_operator_cannot_change_them(tmp_path, monkeypatch):
    _configure_isolated_profile(tmp_path, monkeypatch)

    from backend.main import create_app

    with TestClient(create_app()) as client:
        admin_headers = _login(client)
        initial = client.get("/api/v1/settings", headers=admin_headers)
        assert initial.status_code == 200
        assert initial.json()["behavior"]["responseMode"] == "knowledge_only"

        behavior = {
            "systemInstructions": "Act as the operations change-control assistant.",
            "responseMode": "knowledge_preferred",
            "knowledgeScope": "all_collections",
            "citationStyle": "sources_list",
            "noKnowledgeResponse": "No approved source contains that answer.",
            "maxSources": 7,
            "minimumRelevanceScore": 0.7,
        }
        update = client.patch("/api/v1/settings", json={"behavior": behavior}, headers=admin_headers)
        assert update.status_code == 200, update.text
        assert update.json()["behavior"] == behavior
        assert client.get("/api/v1/settings", headers=admin_headers).json()["behavior"] == behavior

        created = client.post(
            "/api/v1/admin/users",
            headers=admin_headers,
            json={
                "username": "operator",
                "password": "Temporary-12345!",
                "roles": ["operator"],
            },
        )
        assert created.status_code == 200, created.text
        operator_headers = _login(client, "operator", "Temporary-12345!")
        changed = client.post(
            "/api/v1/auth/change-password",
            headers=operator_headers,
            json={
                "currentPassword": "Temporary-12345!",
                "newPassword": "Operator-New-12345!",
            },
        )
        assert changed.status_code == 200, changed.text

        forbidden = client.patch(
            "/api/v1/settings",
            json={"behavior": {"responseMode": "model_only"}},
            headers=operator_headers,
        )
        assert forbidden.status_code == 403
        assert forbidden.json()["detail"] == "Only administrators can change assistant behavior"

        invalid_empty_fallback = client.patch(
            "/api/v1/settings",
            json={"behavior": {"noKnowledgeResponse": "   "}},
            headers=admin_headers,
        )
        assert invalid_empty_fallback.status_code == 422


def test_knowledge_only_chat_refuses_without_sources_and_cites_grounded_context(tmp_path, monkeypatch):
    data_dir = _configure_isolated_profile(tmp_path, monkeypatch)

    from backend.chat import routes as chat_routes
    from backend.db.database import get_session_factory
    from backend.db.models import Document, Model
    from backend.main import create_app
    from backend.retrieval.vector_store import SearchResult

    captured_messages = []
    fake_answer = {"content": "Restart the router only after validation [Source 1]."}

    async def fake_llama_server(client, messages, temperature, max_tokens, stream):
        captured_messages.extend(messages)
        yield {
            "choices": [{
                "message": {"content": fake_answer["content"]},
                "finish_reason": "stop",
            }],
            "usage": {"total_tokens": 24},
        }

    monkeypatch.setattr(chat_routes, "call_llama_server", fake_llama_server)

    class FakeEmbeddingProvider:
        async def embed_single(self, _text):
            return [1.0] + [0.0] * 383

    class FakeModelManager:
        def __init__(self):
            self.chat_provider = None
            self.embedding_provider = None
            self.active_chat_model_id = None
            self.active_embedding_model_id = None
            self.chat_loads = 0

        def get_chat_provider(self):
            return self.chat_provider

        def get_embedding_provider(self):
            return self.embedding_provider

        async def load_model(self, model, role):
            if role == "embedding":
                self.embedding_provider = FakeEmbeddingProvider()
                self.active_embedding_model_id = model.id
                return self.embedding_provider
            self.chat_loads += 1
            self.chat_provider = SimpleNamespace(client=object())
            self.active_chat_model_id = model.id
            return self.chat_provider

        async def shutdown(self):
            return None

    class FakeVectorStore:
        def __init__(self):
            self.results = []
            self.searches = []

        async def search(self, embedding, collection_ids=None, top_k=10, **_kwargs):
            self.searches.append({"collection_ids": collection_ids, "top_k": top_k})
            return list(self.results)

        def close(self):
            return None

    with TestClient(create_app()) as client:
        headers = _login(client)
        SessionLocal = get_session_factory(client.app.state.engine)
        with SessionLocal() as db:
            db.add_all([
                Model(
                    id="chat-model", name="Chat", filename="chat.gguf", filepath="chat.gguf",
                    size_bytes=1, role="chat", status="active",
                ),
                Model(
                    id="embedding-model", name="Embedding", filename="embedding.gguf",
                    filepath="embedding.gguf", size_bytes=1, role="embedding", status="active",
                ),
            ])
            db.commit()

        collection_response = client.post(
            "/api/v1/knowledge/collections",
            headers=headers,
            json={
                "name": "Approved Runbooks",
                "embeddingModelId": "embedding-model",
                "embeddingConfig": {},
                "chunkingConfig": {},
            },
        )
        assert collection_response.status_code == 200, collection_response.text
        collection_id = collection_response.json()["id"]

        source_file = data_dir / "knowledge" / "collections" / collection_id / "source" / "router.txt"
        source_file.parent.mkdir(parents=True, exist_ok=True)
        source_file.write_text("Validate routing peers before restarting the router.", encoding="utf-8")
        with SessionLocal() as db:
            db.add(Document(
                id="document-1",
                collection_id=collection_id,
                filename=source_file.name,
                original_filename="router-runbook.txt",
                filepath=str(source_file.relative_to(data_dir / "knowledge")),
                mime_type="text/plain",
                size_bytes=source_file.stat().st_size,
                file_hash="hash",
                uploaded_by=client.get("/api/v1/auth/session", headers=headers).json()["user"]["id"],
                status="ready",
            ))
            db.commit()

        conversation = client.post(
            "/api/v1/chat/conversations",
            headers=headers,
            json={"modelId": "chat-model", "collectionId": collection_id},
        )
        assert conversation.status_code == 200, conversation.text
        conversation_id = conversation.json()["id"]

        policy = {
            "systemInstructions": "Follow approved change-control procedure.",
            "responseMode": "knowledge_only",
            "knowledgeScope": "selected_collection",
            "citationStyle": "inline_and_sources",
            "noKnowledgeResponse": "No approved source contains that answer.",
            "maxSources": 3,
            "minimumRelevanceScore": 0.75,
        }
        assert client.patch("/api/v1/settings", headers=headers, json={"behavior": policy}).status_code == 200

        fake_manager = FakeModelManager()
        fake_store = FakeVectorStore()
        client.app.state.model_manager = fake_manager
        client.app.state.ingestion.vector_store.close()
        client.app.state.ingestion.vector_store = fake_store

        no_source = client.post(
            "/api/v1/chat/completions",
            headers=headers,
            json={
                "conversationId": conversation_id,
                "message": "What is the firewall password?",
                "modelId": "chat-model",
                "collectionId": collection_id,
                "stream": False,
            },
        )
        assert no_source.status_code == 200, no_source.text
        assert no_source.json()["content"] == policy["noKnowledgeResponse"]
        assert no_source.json()["citations"] == []
        assert fake_manager.chat_loads == 0

        fake_store.results = [
            SearchResult(
                chunk_id="low-score", document_id="document-1", collection_id=collection_id,
                content="Unrelated note", score=0.5, page_start=1, page_end=1,
                section_title=None, metadata={},
            ),
            SearchResult(
                chunk_id="supported", document_id="document-1", collection_id=collection_id,
                content="Validate routing peers before restarting the router.", score=0.92,
                page_start=2, page_end=2, section_title="Restart procedure", metadata={},
            ),
        ]
        grounded = client.post(
            "/api/v1/chat/completions",
            headers=headers,
            json={
                "conversationId": conversation_id,
                "message": "When should I restart the router?",
                "modelId": "chat-model",
                "collectionId": collection_id,
                "stream": False,
            },
        )
        assert grounded.status_code == 200, grounded.text
        assert grounded.json()["content"].endswith("[Source 1].")
        assert [item["chunkId"] for item in grounded.json()["citations"]] == ["supported"]
        assert grounded.json()["citations"][0]["sourceNumber"] == 1
        assert fake_store.searches[-1] == {"collection_ids": [collection_id], "top_k": 12}
        assert any("Follow approved change-control procedure." in item["content"] for item in captured_messages)
        grounding_prompt = next(item["content"] for item in captured_messages if "LOCAL KNOWLEDGE SOURCES" in item["content"])
        assert "Answer only with facts supported by these sources" in grounding_prompt
        assert "router-runbook.txt" in grounding_prompt
        assert "[Source N]" in grounding_prompt

        fake_answer["content"] = "Restart it immediately without checking any source."
        uncited = client.post(
            "/api/v1/chat/completions",
            headers=headers,
            json={
                "conversationId": conversation_id,
                "message": "Can I skip validation?",
                "modelId": "chat-model",
                "collectionId": collection_id,
                "stream": False,
            },
        )
        assert uncited.status_code == 200, uncited.text
        assert uncited.json()["content"].startswith(fake_answer["content"])
        assert "Sources: [Source 1]" in uncited.json()["content"]
        assert [item["chunkId"] for item in uncited.json()["citations"]] == ["supported"]
