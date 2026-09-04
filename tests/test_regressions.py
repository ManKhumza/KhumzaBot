import importlib
from pathlib import Path

from backend.documents.chunking import ChunkConfig, chunk_text


def test_every_source_backend_module_imports():
    backend_root = Path(__file__).parents[1] / "backend"
    ignored = {"build", ".venv", "__pycache__"}
    modules = []
    for source in backend_root.rglob("*.py"):
        if ignored.intersection(source.parts):
            continue
        relative = source.relative_to(backend_root.parent).with_suffix("")
        modules.append(".".join(relative.parts))

    failures = []
    for module in modules:
        try:
            importlib.import_module(module)
        except Exception as exc:  # report all failures together
            failures.append(f"{module}: {type(exc).__name__}: {exc}")
    assert failures == []


def test_short_document_is_not_silently_discarded():
    text = "The unique incident code is ORCHID-7429."
    chunks = chunk_text(text, ChunkConfig(min_chunk_size=50))
    assert len(chunks) == 1
    assert chunks[0].content == text
