"""Contract tests for the preload, Electron main process, and FastAPI routes."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"


def test_typescript_preload_compiles() -> None:
    """Compile Electron, preload, and the imported shared IPC contract together."""
    compiler = DESKTOP_DIR / "electron" / "node_modules" / "typescript" / "bin" / "tsc"
    assert compiler.is_file(), "Electron TypeScript dependencies are not installed"
    result = subprocess.run(
        ["node", str(compiler), "--noEmit", "-p", str(DESKTOP_DIR / "electron" / "tsconfig.json")],
        capture_output=True,
        text=True,
        cwd=DESKTOP_DIR,
        check=False,
    )
    assert result.returncode == 0, (
        f"TypeScript IPC contract mismatch:\n{result.stdout}\n{result.stderr}"
    )


def test_packaged_preload_has_no_local_runtime_imports() -> None:
    """A sandboxed packaged preload must be a self-contained runtime module."""
    preload_text = (DESKTOP_DIR / "preload" / "preload.ts").read_text(encoding="utf-8")

    runtime_imports = re.findall(
        r"^import\s+(?!type\b).*?from\s+['\"](?:\.|/)",
        preload_text,
        flags=re.MULTILINE,
    )
    local_requires = re.findall(r"require\(['\"](?:\.|/)", preload_text)

    assert not runtime_imports, f"Sandboxed preload has local runtime imports: {runtime_imports}"
    assert not local_requires, f"Sandboxed preload has local require calls: {local_requires}"


def test_backend_routes_exist_for_electron() -> None:
    """Verify the HTTP methods and paths used by Electron exist in FastAPI."""
    from backend.main import create_app

    paths = create_app().openapi()["paths"]
    required_routes = {
        "/api/v1/chat/conversations/{conversation_id}": "patch",
        "/api/v1/chat/conversations/{conversation_id}/messages": "get",
        "/api/v1/chat/completions": "post",
        "/api/v1/chat/stop/{generation_id}": "post",
        "/api/v1/knowledge/collections/{collection_id}/documents": "post",
        "/api/v1/knowledge/documents/{document_id}/reprocess": "post",
        "/api/v1/models": "get",
        "/api/v1/auth/login": "post",
        "/api/v1/inference/chat/completions": "post",
    }
    missing = [
        f"{method.upper()} {path}"
        for path, method in required_routes.items()
        if path not in paths or method not in paths[path]
    ]
    assert not missing, f"Backend routes required by Electron are missing: {missing}"
    assert "requestBody" in paths["/api/v1/chat/conversations/{conversation_id}"]["patch"]


def test_ipc_channels_have_handlers() -> None:
    """Every channel in the shared contract has one Electron handler."""
    contract_text = (DESKTOP_DIR / "shared" / "ipc-contract.ts").read_text(encoding="utf-8")
    preload_text = (DESKTOP_DIR / "preload" / "preload.ts").read_text(encoding="utf-8")
    main_text = (DESKTOP_DIR / "electron" / "main.ts").read_text(encoding="utf-8")

    entries = re.findall(r"^\s*([A-Z_]+):\s*'([^']+)'", contract_text, flags=re.MULTILINE)
    assert entries, "No IPC channels were found in the shared contract"
    missing = []
    duplicates = []
    for key, channel in entries:
        literal_count = main_text.count(f"ipcMain.handle('{channel}'")
        constant_count = main_text.count(f"ipcMain.handle(IPC.{key}")
        count = literal_count + constant_count
        if count == 0:
            missing.append(channel)
        elif count > 1:
            duplicates.append(channel)

    assert "../shared/ipc-contract" in preload_text
    assert "../shared/ipc-contract" in main_text
    assert not missing, f"Electron handlers are missing for: {missing}"
    assert not duplicates, f"Electron has duplicate handlers for: {duplicates}"
