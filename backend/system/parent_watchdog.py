"""Inherited stdin ties the backend lifetime to its Electron owner."""
import asyncio
import logging
import os
import sys
import threading

logger = logging.getLogger("nocai.supervisor")


def start_parent_watchdog(loop, on_parent_exit, descriptor=None):
    """The pipe closes when Electron exits, including crashes; no PID reuse race."""
    descriptor = sys.stdin.fileno() if descriptor is None else descriptor
    def watch():
        try:
            while os.read(descriptor, 1):
                continue
        except OSError:
            logger.warning("Parent ownership pipe closed unexpectedly")
        if not loop.is_closed():
            asyncio.run_coroutine_threadsafe(on_parent_exit(), loop)
    thread = threading.Thread(target=watch, name="electron-owner-watchdog", daemon=True)
    thread.start()
    return thread
