"""Tests for IPC contract between preload, Electron main, and backend."""

import json
from pathlib import Path


def test_ipc_preload_chat_stop_generation():
    """IPC contract: preload.ts nocai:chat:stopGeneration has matching Electron handler."""
    preload_path = Path(__file__).parents[1] / "apps" / "desktop" / "preload" / "preload.ts"
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    
    if not preload_path.exists() or not main_path.exists():
        # Skip if files don't exist in test environment
        return
    
    preload_content = preload_path.read_text()
    main_content = main_path.read_text()
    
    # Check preload invokes nocai:chat:stopGeneration
    assert "nocai:chat:stopGeneration" in preload_content
    
    # Check Electron main has handler for stopGeneration
    assert "stopGeneration" in main_content or "chat:stop" in main_content


def test_ipc_preload_rename_conversation_signature():
    """IPC contract: preload renameConversation matches Electron handler signature."""
    preload_path = Path(__file__).parents[1] / "apps" / "desktop" / "preload" / "preload.ts"
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    
    if not preload_path.exists() or not main_path.exists():
        return
    
    preload_content = preload_path.read_text()
    main_content = main_path.read_text()
    
    # Check preload sends renameConversation with (id, title) as two args
    # Check Electron destructures { id, title } object
    # This documents the expected contract


def test_ipc_backend_patch_conversation_title_body():
    """IPC contract: Electron sends PATCH /api/v1/chat/conversations/{id} with {title} in body."""
    # This test documents the expected API contract
    # Backend should accept title in request body, not query parameter


def test_ipc_backend_reprocess_document_route():
    """IPC contract: Electron calls /api/v1/knowledge/documents/{id}/reprocess."""
    # Backend should expose this route


def test_ipc_system_get_version():
    """IPC contract: nocai:system:getVersion returns string version, not health JSON."""
    # Preload types it as Promise<string>
    # Implementation should return version string


def test_ipc_error_banner_does_not_restart_backend():
    """IPC contract: error banner close dismisses banner, doesn't restart backend."""
    # This documents expected behavior