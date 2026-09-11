"""Thread-safe port allocation for llama-server instances."""

from __future__ import annotations

import threading
import socket


class PortPool:
    """Allocates and releases TCP ports from a fixed range.

    Usage:
        pool = PortPool(start=8100, end=8200)
        port = pool.acquire("model-abc-123")
        pool.release(port)
    """

    def __init__(self, start: int = 8100, end: int = 8200) -> None:
        if start > end:
            raise ValueError(f"start ({start}) must be <= end ({end})")
        self._lock = threading.Lock()
        self._available: set[int] = set(range(start, end + 1))
        self._in_use: dict[int, str] = {}  # port -> model_id

    def acquire(self, model_id: str) -> int:
        """Allocate a free port for the given model.

        Raises RuntimeError if the pool is exhausted.
        """
        with self._lock:
            if not self._available:
                raise RuntimeError(
                    f"No free ports available in range for model {model_id}. "
                    f"All ports in use: {sorted(self._in_use.keys())}"
                )
            port = None
            for candidate in sorted(self._available):
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    try:
                        probe.bind(("127.0.0.1", candidate))
                    except OSError:
                        continue
                port = candidate
                break
            if port is None:
                raise RuntimeError("No available loopback inference port; close the conflicting service and retry")
            self._available.remove(port)
            self._in_use[port] = model_id
            return port

    def release(self, port: int) -> None:
        """Return a port to the available pool."""
        with self._lock:
            self._in_use.pop(port, None)
            self._available.add(port)

    def is_in_use(self, port: int) -> bool:
        with self._lock:
            return port in self._in_use

    @property
    def available_count(self) -> int:
        with self._lock:
            return len(self._available)

    @property
    def in_use_count(self) -> int:
        with self._lock:
            return len(self._in_use)
