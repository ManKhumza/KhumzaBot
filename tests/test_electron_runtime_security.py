"""Behavioral tests execute Electron's source under isolated operating-system adapters."""

import subprocess
from pathlib import Path


def test_electron_runtime_security_and_supervision():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/electron_runtime_checks.cjs"],
        cwd=root, capture_output=True, text=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
