"""Faults exercise real subprocess ownership, persisted recovery and readiness."""
import asyncio
import os
import socket
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_backend_runtime_integrity import isolated_backend
from backend.inference.lifecycle import LlamaServerProcess, LlamaServerError
from backend.inference.port_pool import PortPool

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_fault_injection_port_collision():
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        port = occupied.getsockname()[1]
        pool = PortPool(port, port)
        with pytest.raises(RuntimeError, match="available loopback"):
            pool.acquire("embedding")
        assert pool.in_use_count == 0
    assert pool.acquire("embedding") == port
    pool.release(port)
    assert pool.available_count == 1


def test_fault_injection_corrupt_model(tmp_path):
    model = tmp_path / "corrupt.gguf"
    model.write_bytes(b"not a gguf model")
    async def scenario():
        server = LlamaServerProcess(model, free_port(), ROOT / "runtimes/llama/llama-server.exe", gpu_layers=0, health_timeout=10)
        try:
            with pytest.raises(LlamaServerError, match="exited|healthy"):
                await server.start()
            assert not server.is_running
            assert not server._drain_tasks
            assert server.api_key not in server.recent_stderr
        finally:
            await server.stop()
    asyncio.run(scenario())


def test_fault_injection_kill_llama_during_load(monkeypatch):
    async def scenario():
        server = LlamaServerProcess(ROOT / "resources/models/bge-small-en-v1.5-q8_0.gguf",
                                   free_port(), ROOT / "runtimes/llama/llama-server.exe",
                                   role="embedding", gpu_layers=0, ctx_size=512)
        started = asyncio.Event()
        async def waiting():
            started.set()
            await asyncio.Event().wait()
        monkeypatch.setattr(server, "_wait_for_ready", waiting)
        task = asyncio.create_task(server.start())
        try:
            await asyncio.wait_for(started.wait(), timeout=10)
            child = server.process
            assert child is not None
            child.kill()
            await asyncio.wait_for(child.wait(), timeout=10)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert child.returncode is not None
            assert not server.is_running
            assert not server._drain_tasks
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await server.stop()
    asyncio.run(scenario())


def test_fault_injection_parent_death_pipe_closes_owned_work():
    from backend.system.parent_watchdog import start_parent_watchdog
    async def scenario():
        reader, writer = os.pipe()
        stopped = asyncio.Event()
        async def parent_exited():
            stopped.set()
        thread = start_parent_watchdog(asyncio.get_running_loop(), parent_exited, reader)
        try:
            await asyncio.sleep(0.01)
            assert not stopped.is_set()
            os.close(writer)
            writer = None
            await asyncio.wait_for(stopped.wait(), timeout=3)
            await asyncio.to_thread(thread.join, 3)
            assert not thread.is_alive()
        finally:
            if writer is not None:
                os.close(writer)
            os.close(reader)
    asyncio.run(scenario())


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object ownership is platform-specific")
def test_fault_injection_kill_backend_terminates_owned_descendants():
    import psutil
    import subprocess
    import sys
    import time
    code = (
        "import os,subprocess,sys,time; from backend.system.process_ownership import ProcessOwnership; "
        "job=ProcessOwnership(); child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],"
        "creationflags=job.creationflags,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
        "job.assign_and_resume(child.pid); print(str(os.getpid())+' '+str(child.pid),flush=True); time.sleep(60)"
    )
    async def scenario():
        helper = await asyncio.create_subprocess_exec(sys.executable, "-c", code, cwd=ROOT,
                                                      stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        owned = []
        try:
            line = await asyncio.wait_for(helper.stdout.readline(), timeout=10)
            helper_pid, child_pid = map(int, line.decode().split())
            owned = [psutil.Process(child_pid)]
            owned.extend(owned[0].children(recursive=True))
            psutil.Process(helper_pid).kill()
            await asyncio.wait_for(helper.wait(), timeout=10)
            deadline = time.monotonic() + 5
            while any(item.is_running() for item in owned) and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert all(not item.is_running() for item in owned)
        finally:
            for item in owned:
                if item.is_running():
                    item.kill()
                    item.wait(timeout=5)
            if helper.returncode is None:
                helper.kill()
                await helper.wait()
    asyncio.run(scenario())


def test_fault_injection_write_protect_data_dir(isolated_backend, monkeypatch):
    from backend.documents.coordinator import IngestionCoordinator
    from backend.inference.lifecycle import ModelLifecycleManager
    from backend.health.service import health_snapshot
    import backend.health.service as service
    settings, engine, factory = isolated_backend
    async def scenario():
        coordinator = IngestionCoordinator(settings, factory, ModelLifecycleManager(settings))
        await coordinator.start()
        app = SimpleNamespace(state=SimpleNamespace(settings=settings, engine=engine, ingestion=coordinator,
                                                    model_manager=coordinator.model_manager, stopping=False))
        try:
            healthy = await health_snapshot(app)
            assert healthy["ready"] is True
            def denied(*args, **kwargs):
                raise PermissionError("fixture write denial")
            monkeypatch.setattr(service.tempfile, "TemporaryFile", denied)
            unhealthy = await health_snapshot(app)
            assert unhealthy["ready"] is False
            assert unhealthy["components"]["storage"]["status"] == "unhealthy"
            assert unhealthy["components"]["database"]["status"] == "healthy"
        finally:
            await coordinator.stop()
    asyncio.run(scenario())


def test_fault_injection_low_disk_and_memory(isolated_backend, monkeypatch):
    from backend.documents.coordinator import IngestionCoordinator
    from backend.inference.lifecycle import ModelLifecycleManager
    from backend.health.service import health_snapshot
    import backend.health.service as service
    settings, engine, factory = isolated_backend
    async def scenario():
        coordinator = IngestionCoordinator(settings, factory, ModelLifecycleManager(settings))
        await coordinator.start()
        app = SimpleNamespace(state=SimpleNamespace(settings=settings, engine=engine, ingestion=coordinator,
                                                    model_manager=coordinator.model_manager, stopping=False))
        try:
            monkeypatch.setattr(service.psutil, "disk_usage", lambda _: SimpleNamespace(free=1024, total=2**30))
            monkeypatch.setattr(service.psutil, "virtual_memory", lambda: SimpleNamespace(available=1024, used=2**30))
            result = await health_snapshot(app)
            assert result["ready"] is False
            assert result["components"]["storage"]["status"] == "unhealthy"
            assert result["components"]["memory"]["status"] == "degraded"
            assert result["components"]["storage"]["detail"]
        finally:
            await coordinator.stop()
    asyncio.run(scenario())
