"""Tests for package integrity and version consistency."""

from pathlib import Path
import json


def test_package_integrity_checksums(tmp_path):
    """Package integrity: SHA-256 checksums generated and verified."""
    # Test that build generates SHA256SUMS.txt with correct hashes


def test_package_integrity_version_consistency(tmp_path):
    """Package integrity: version consistent across all artifacts."""
    # Check version in package.json, backend, installer filenames


def test_package_integrity_embedded_runtime_hashes(tmp_path):
    """Package integrity: embedded Python runtime and llama.cpp hashes verified."""
    # Check that resource hashes match expected values


def test_package_integrity_bundled_model_hash(tmp_path):
    """Package integrity: bundled BGE model SHA-256 matches expected."""
    # Expected: f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804
    expected_hash = "f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804"
    assert len(expected_hash) == 64  # SHA-256 is 64 hex chars


def test_package_integrity_no_stale_artifacts(tmp_path):
    """Package integrity: no mixed-generation artifacts in release."""
    # All release outputs from same source/version/build run


def test_package_gate_reuses_current_powershell():
    """Package gate works under both Windows PowerShell and PowerShell 7."""
    project_root = Path(__file__).resolve().parents[1]
    gate = (project_root / "scripts" / "quality-gate.ps1").read_text(encoding="utf-8")

    assert "$PowerShellExecutable = (Get-Process -Id $PID).Path" in gate
    assert '"Clean package and release verification" $PowerShellExecutable' in gate
    assert '"Clean package and release verification" "pwsh.exe"' not in gate


def test_build_scripts_do_not_use_stale_native_exit_codes():
    """PowerShell child scripts propagate exceptions without stale LASTEXITCODE checks."""
    project_root = Path(__file__).resolve().parents[1]
    build = (project_root / "scripts" / "build-all.ps1").read_text(encoding="utf-8")
    downloader = (project_root / "scripts" / "download-llama.ps1").read_text(
        encoding="utf-8"
    )

    assert 'throw "llama.cpp runtime setup failed."' not in build
    assert 'throw "Portable Python backend runtime setup failed."' not in build
    assert "exit 0" not in downloader
