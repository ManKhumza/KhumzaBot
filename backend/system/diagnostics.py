"""Bounded local diagnostics with no secrets or exception argument payloads."""
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import traceback
from backend.version import __version__


class SafeFormatter(logging.Formatter):
    def format(self, record):
        output = super().format(record)
        for key, value in os.environ.items():
            if value and len(value) >= 8 and any(part in key.upper() for part in ("TOKEN", "SECRET", "PASSWORD", "API_KEY")):
                output = output.replace(value, "[REDACTED]")
        output = re.sub(r"(?i)(Bearer\\s+)[^\\s\",]+", r"\1[REDACTED]", output)
        return output[:8192]

    def formatException(self, exc_info):
        frames = traceback.extract_tb(exc_info[2])
        return f"{exc_info[0].__name__}: " + " -> ".join(f"{Path(frame.filename).name}:{frame.lineno}" for frame in frames[-12:])


def open_diagnostics(logs_dir, max_bytes=2 * 1024**2, backups=3):
    directory = Path(logs_dir)
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(directory / "backend.log", maxBytes=max_bytes, backupCount=backups, encoding="utf-8")
    handler.setFormatter(SafeFormatter(f"%(asctime)s %(levelname)s %(name)s build={__version__} %(message)s"))
    logging.getLogger().addHandler(handler)
    return handler


def close_diagnostics(handler):
    logging.getLogger().removeHandler(handler)
    handler.close()
