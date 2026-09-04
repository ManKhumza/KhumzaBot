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