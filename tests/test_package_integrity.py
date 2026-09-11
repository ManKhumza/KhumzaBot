"""Tests for package integrity and version consistency."""

from pathlib import Path
import json
import re
import tomllib
import pytest
from scripts.release_integrity import check_versions, verify_checksums, digest, verify_backend_freshness, source_files, BGE_HASH


def test_package_integrity_checksums(tmp_path):
    """Package integrity: SHA-256 checksums generated and verified."""
    artifact = tmp_path / 'Setup.exe'
    artifact.write_bytes(b'MZ synthetic artifact')
    (tmp_path / 'SHA256SUMS.txt').write_text(f'{digest(artifact)}  Setup.exe\n')
    assert verify_checksums(tmp_path, {'Setup.exe'})['Setup.exe']['size'] == artifact.stat().st_size
    artifact.write_bytes(b'MZ changed after checksum')
    with pytest.raises(ValueError, match='checksum mismatch'):
        verify_checksums(tmp_path, {'Setup.exe'})


def test_package_integrity_version_consistency():
    """Package integrity: version consistent across all artifacts."""
    project_root = Path(__file__).resolve().parents[1]
    electron = json.loads(
        (project_root / "apps" / "desktop" / "electron" / "package.json").read_text(
            encoding="utf-8"
        )
    )
    renderer = json.loads(
        (project_root / "apps" / "desktop" / "renderer" / "package.json").read_text(
            encoding="utf-8"
        )
    )
    backend = tomllib.loads(
        (project_root / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    )
    build_script = (project_root / "scripts" / "build-all.ps1").read_text(
        encoding="utf-8"
    )
    version = (project_root / 'VERSION').read_text().strip()
    assert "'VERSION'" in build_script
    assert check_versions() == version
    assert {
        electron["version"],
        renderer["version"],
        backend["project"]["version"],
        version,
    } == {version}


def test_package_integrity_embedded_runtime_hashes(tmp_path):
    """Package integrity: embedded Python runtime and llama.cpp hashes verified."""
    source = tmp_path / 'source/backend'
    packaged = tmp_path / 'resources/python/Lib/site-packages/backend'
    source.mkdir(parents=True)
    packaged.mkdir(parents=True)
    (source / '__init__.py').write_text('version = 2')
    (packaged / '__init__.py').write_text('version = 1')
    with pytest.raises(ValueError, match='stale'):
        verify_backend_freshness(tmp_path / 'resources', tmp_path / 'source')
    (packaged / '__init__.py').write_text('version = 2')
    assert verify_backend_freshness(tmp_path / 'resources', tmp_path / 'source') is None
    (packaged / 'deleted_module.py').write_text('pass')
    with pytest.raises(ValueError, match='inventory'):
        verify_backend_freshness(tmp_path / 'resources', tmp_path / 'source')


@pytest.mark.parametrize('environment_name', ['.venv', 'venv'])
def test_package_inventory_excludes_local_virtual_environments(tmp_path, environment_name):
    source = tmp_path / 'source/backend'
    packaged = tmp_path / 'resources/python/Lib/site-packages/backend'
    dependency = source / environment_name / 'Lib/site-packages/dependency.py'
    dependency.parent.mkdir(parents=True)
    dependency.write_text('local_dependency = True')
    packaged.mkdir(parents=True)
    (source / '__init__.py').write_text('version = 2')
    (packaged / '__init__.py').write_text('version = 2')
    (tmp_path / 'source/VERSION').write_text('1.1.0')
    verify_backend_freshness(tmp_path / 'resources', tmp_path / 'source')
    assert set(source_files(tmp_path / 'source')) == {'backend/__init__.py', 'VERSION'}
    (source / 'missing.py').write_text('required = True')
    with pytest.raises(ValueError, match='inventory'):
        verify_backend_freshness(tmp_path / 'resources', tmp_path / 'source')


def test_package_integrity_bundled_model_hash(tmp_path):
    """Package integrity: bundled BGE model SHA-256 matches expected."""
    # Expected: f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804
    expected_hash = "f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804"
    assert digest(Path(__file__).resolve().parents[1] / 'resources/models/bge-small-en-v1.5-q8_0.gguf') == expected_hash == BGE_HASH


def test_installer_allowlists_required_models_only():
    """Package integrity: downloaded chat models cannot silently bloat the installer."""
    project_root = Path(__file__).resolve().parents[1]
    builder = (
        project_root / "apps" / "desktop" / "electron" / "builder.yaml"
    ).read_text(encoding="utf-8")

    assert '"bge-small-en-v1.5-q8_0.gguf"' in builder
    assert 'filter: ["*.gguf"' not in builder


def test_package_integrity_no_stale_artifacts():
    """Package integrity: no mixed-generation artifacts in release."""
    project_root = Path(__file__).resolve().parents[1]
    build = (project_root / "scripts" / "build-all.ps1").read_text(
        encoding="utf-8"
    )
    runtime_builder = (
        project_root / "scripts" / "build-python-runtime.ps1"
    ).read_text(encoding="utf-8")

    assert "Remove-Item -LiteralPath $ResolvedReleaseDir -Recurse -Force" in build
    assert "Remove-Item -LiteralPath $SitePackages -Recurse -Force" in runtime_builder


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


def test_embedded_runtime_dependencies_target_embedded_python():
    """Native wheels must match the Python version shipped in the installer."""
    project_root = Path(__file__).resolve().parents[1]
    runtime_builder = (
        project_root / "scripts" / "build-python-runtime.ps1"
    ).read_text(encoding="utf-8")

    assert "-m pip wheel" in runtime_builder
    assert "-m pip --python $EmbeddedPython install" in runtime_builder
    assert "& $VirtualPython -m pip install" not in runtime_builder
