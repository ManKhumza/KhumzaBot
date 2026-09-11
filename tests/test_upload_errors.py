"""Upload failures keep the memory reserve and provide useful, sanitized UI errors."""

import asyncio
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from test_backend_runtime_integrity import isolated_backend


@pytest.mark.parametrize("available_mb, budget_mb", [(465, 0), (512, 0), (513, 1)])
def test_upload_memory_error_explains_reserve_and_keeps_documents_unchanged(
    isolated_backend, tmp_path, monkeypatch, available_mb, budget_mb
):
    from backend.db.models import Document, IngestionJob, User
    from backend.knowledge import routes

    settings, _, factory = isolated_backend
    monkeypatch.setattr(routes, "get_settings", lambda: settings)
    monkeypatch.setattr(
        routes.psutil, "virtual_memory",
        lambda: SimpleNamespace(available=available_mb * 1024 * 1024),
    )
    source = tmp_path / "synthetic-runbook.txt"
    source.write_bytes(b"x" * (512 * 1024))

    with factory() as db:
        documents_before = db.query(Document).count()
        jobs_before = db.query(IngestionJob).count()
        with pytest.raises(HTTPException) as failure:
            asyncio.run(routes.upload_documents(
                "collection", routes.DocumentPathsRequest(filePaths=[str(source)]),
                SimpleNamespace(), current_user=db.get(User, "owner"), db=db,
            ))
        assert failure.value.status_code == 413
        detail = failure.value.detail
        assert "about 2 MB" in detail
        assert f"{budget_mb} MB is available for ingestion" in detail
        assert f"{available_mb} MB free" in detail
        assert "512 MB reserved" in detail
        assert "unload a chat model" in detail
        assert "try again" in detail
        assert db.query(Document).count() == documents_before
        assert db.query(IngestionJob).count() == jobs_before
    assert source.exists()
    assert not (Path(settings.knowledge_dir) / "collections" / "collection" / "source").exists()


def test_renderer_upload_and_picker_errors_are_readable_and_retryable():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/renderer_upload_errors.cjs"],
        cwd=root, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
