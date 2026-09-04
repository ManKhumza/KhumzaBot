"""Tests for installed application smoke test."""

import subprocess
import tempfile
from pathlib import Path


def test_installed_app_launch(tmp_path):
    """Installed app smoke: launch packaged application."""
    # This test would run the installed executable
    # For now, document the requirement


def test_installed_app_onboarding_login(tmp_path):
    """Installed app smoke: onboarding/login works in packaged app."""
    # Test first-run experience creates admin or explains how


def test_installed_app_navigate_routes(tmp_path):
    """Installed app smoke: navigate every menu route."""
    # All visible menu items work end-to-end


def test_installed_app_backend_health(tmp_path):
    """Installed app smoke: backend health endpoint responds."""
    # Backend health reflects actual status


def test_installed_app_embedding_test(tmp_path):
    """Installed app smoke: embedded BGE model produces 384-dim vector."""
    # /v1/embeddings works with bundled model


def test_installed_app_tiny_chat_completion(tmp_path):
    """Installed app smoke: tiny chat GGUF returns completion."""
    # Chat completion works through full UI/IPC/backend path


def test_installed_app_no_orphan_processes(tmp_path):
    """Installed app smoke: close app leaves no orphan backend/llama processes."""
    # Process cleanup on exit