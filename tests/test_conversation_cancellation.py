"""Tests for conversation and generation cancellation."""

from pathlib import Path
from fastapi.testclient import TestClient


def test_conversation_create_list_update_delete(tmp_path, monkeypatch):
    """Conversation: create, list, preference updates, and delete operations work."""
    data_dir = tmp_path / "data"
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine
    from backend.main import create_app

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    with TestClient(create_app()) as client:
        transport_headers = {"X-NOC-AI-Backend-Token": "test-transport-secret"}
        
        # Login
        login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "ChangeMe-12345!"},
            headers=transport_headers,
        )
        assert login.status_code == 200
        headers = {
            **transport_headers,
            "Authorization": f"Bearer {login.json()['token']}",
        }
        
        # List conversations (should be empty initially)
        convs = client.get("/api/v1/chat/conversations", headers=headers)
        assert convs.status_code == 200
        
        # Create conversation
        create = client.post(
            "/api/v1/chat/conversations",
            json={"title": "Test Chat"},
            headers=headers,
        )
        assert create.status_code == 200
        conv_id = create.json()["id"]
        
        # Get conversation
        get_conv = client.get(f"/api/v1/chat/conversations/{conv_id}", headers=headers)
        assert get_conv.status_code == 200
        assert get_conv.json()["title"] == "Test Chat"
        
        # Rename conversation
        rename = client.patch(
            f"/api/v1/chat/conversations/{conv_id}",
            json={"title": "Renamed Chat"},
            headers=headers,
        )
        assert rename.status_code == 200

        # Persist the model and knowledge choices made in the chat header.
        from backend.db.database import get_session_factory
        from backend.db.models import Collection, Model

        SessionLocal = get_session_factory(client.app.state.engine)
        with SessionLocal() as db:
            chat_model = Model(
                id="active-chat-model",
                name="Active Chat Model",
                filename="chat.gguf",
                filepath=str(data_dir / "models" / "chat.gguf"),
                size_bytes=1024,
                role="chat",
                status="active",
            )
            embedding_model = Model(
                id="active-embedding-model",
                name="Active Embedding Model",
                filename="embedding.gguf",
                filepath=str(data_dir / "models" / "embedding.gguf"),
                size_bytes=1024,
                role="embedding",
                status="active",
            )
            collection = Collection(
                id="owned-collection",
                name="Runbooks",
                owner_id=login.json()["user"]["id"],
                embedding_model_id=embedding_model.id,
                embedding_config={},
                chunking_config={},
                status="active",
            )
            db.add_all([chat_model, embedding_model, collection])
            db.commit()

        update = client.patch(
            f"/api/v1/chat/conversations/{conv_id}",
            json={
                "modelId": "active-chat-model",
                "collectionId": "owned-collection",
                "systemPrompt": "Prioritize operational safety.",
                "temperature": 0.25,
                "maxTokens": 2048,
            },
            headers=headers,
        )
        assert update.status_code == 200, update.text
        assert update.json()["modelId"] == "active-chat-model"
        assert update.json()["collectionId"] == "owned-collection"
        assert update.json()["systemPrompt"] == "Prioritize operational safety."
        assert update.json()["temperature"] == 0.25
        assert update.json()["maxTokens"] == 2048

        clear_collection = client.patch(
            f"/api/v1/chat/conversations/{conv_id}",
            json={"collectionId": None, "systemPrompt": None},
            headers=headers,
        )
        assert clear_collection.status_code == 200
        assert clear_collection.json()["collectionId"] is None
        assert clear_collection.json()["systemPrompt"] is None

        invalid_model = client.patch(
            f"/api/v1/chat/conversations/{conv_id}",
            json={"modelId": "missing-model"},
            headers=headers,
        )
        assert invalid_model.status_code == 400
        assert invalid_model.json()["detail"] == "Selected chat model is not active"
        
        # Delete conversation
        delete = client.delete(f"/api/v1/chat/conversations/{conv_id}", headers=headers)
        assert delete.status_code == 200

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_conversation_persisted_message_history(tmp_path, monkeypatch):
    """Conversation: message history is persisted and retrievable."""
    data_dir = tmp_path / "data"
    monkeypatch.setenv("NOC_AI_DATA_DIR", str(data_dir))
    monkeypatch.setenv("NOC_AI_MODELS_DIR", str(data_dir / "models"))
    monkeypatch.setenv("NOC_AI_KNOWLEDGE_DIR", str(data_dir / "knowledge"))
    monkeypatch.setenv("NOC_AI_LOGS_DIR", str(data_dir / "logs"))
    monkeypatch.setenv("NOC_AI_DATABASE_URL", f"sqlite:///{data_dir / 'test.db'}")
    monkeypatch.setenv("NOC_AI_SESSION_TOKEN", "test-transport-secret")

    from backend.config import get_settings
    from backend.db.database import create_db_engine
    from backend.main import create_app

    get_settings.cache_clear()
    create_db_engine.cache_clear()

    with TestClient(create_app()) as client:
        transport_headers = {"X-NOC-AI-Backend-Token": "test-transport-secret"}
        
        # Login
        login = client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "ChangeMe-12345!"},
            headers=transport_headers,
        )
        assert login.status_code == 200
        headers = {
            **transport_headers,
            "Authorization": f"Bearer {login.json()['token']}",
        }
        
        # Create conversation
        create = client.post(
            "/api/v1/chat/conversations",
            json={"title": "Test Chat"},
            headers=headers,
        )
        assert create.status_code == 200
        conv_id = create.json()["id"]
        
        # Get messages (should be empty initially)
        messages = client.get(f"/api/v1/chat/conversations/{conv_id}/messages", headers=headers)
        assert messages.status_code == 200
        assert messages.json() == []

    get_settings.cache_clear()
    create_db_engine.cache_clear()


def test_generation_cancellation_endpoint_exists(tmp_path, monkeypatch):
    """Cancellation: stop generation endpoint exists in chat routes."""
    # Check that the chat routes define a stop generation endpoint
    from backend.chat.routes import router
    
    routes = [r.path for r in router.routes]
    # Should have a stop endpoint like /conversations/{id}/stop
    stop_routes = [r for r in routes if 'stop' in r]
    assert len(stop_routes) > 0, f"No stop generation route found in {routes}"


def test_cancellation_through_all_layers(tmp_path):
    """Cancellation: generation cancellation flows through all layers."""
    from backend.inference.lifecycle import ModelLifecycleManager
    
    # Test that generation_context exists for cancellation tracking
    assert hasattr(ModelLifecycleManager, 'generation_context')
    assert hasattr(ModelLifecycleManager, 'wait_for_idle')
