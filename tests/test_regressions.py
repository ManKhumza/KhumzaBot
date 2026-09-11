import importlib
from pathlib import Path

from backend.documents.chunking import ChunkConfig, chunk_text, iter_text_chunks


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


def test_large_single_line_document_stays_within_chunk_budget():
    text = "Interface Gi0/1 changed state to down. " * 50_000
    chunks = chunk_text(
        text,
        ChunkConfig(chunk_size=256, chunk_overlap=32, min_chunk_size=20),
    )

    assert len(chunks) > 500
    assert all(0 < chunk.token_count <= 256 for chunk in chunks)
    assert all(chunk.content for chunk in chunks)


def test_large_document_chunk_iterator_is_lazy():
    text = "show interface counters\n" * 100_000
    iterator = iter_text_chunks(text, ChunkConfig(chunk_size=128, chunk_overlap=16))

    first = next(iterator)
    assert first.token_count <= 128
    assert not isinstance(iterator, list)


def test_sparse_model_compatibility_is_normalized():
    from datetime import datetime

    from backend.db.models import Model
    from backend.models.routes import model_to_response

    model = Model(
        id="embedding", name="Bundled embedding", filename="embedding.gguf",
        filepath="embedding.gguf", format="GGUF", size_bytes=1024,
        context_length=512, role="embedding", status="imported",
        hardware_compatibility={"cpu": True},
        model_metadata={}, imported_at=datetime.utcnow(),
    )
    compatibility = model_to_response(model).hardwareCompatibility

    assert compatibility["status"] == "COMPATIBLE"
    assert compatibility["warnings"] == []
    assert compatibility["reasons"] == []


def test_qwen3_chat_runtime_disables_hidden_reasoning_for_responsiveness():
    """CPU chat does not burn its response budget on Qwen3 thinking tokens."""
    from backend.db.models import Model
    from backend.inference.lifecycle import _role_specific_runtime_args

    model = Model(
        id="qwen3", name="Qwen3 4B", filename="Qwen3-4B-Q4_K_M.gguf",
        filepath="model.gguf", size_bytes=1, role="chat",
    )

    assert _role_specific_runtime_args(model, "chat") == ["--reasoning", "off"]
    assert _role_specific_runtime_args(model, "embedding") == []
