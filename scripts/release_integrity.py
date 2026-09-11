"""Fail closed on mixed versions, stale backend code, resources and release hashes."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tomllib
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BGE_HASH = 'f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804'


def digest(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def check_versions(root: Path = ROOT) -> str:
    version = (root / 'VERSION').read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('VERSION must contain a stable semantic version')
    for relative in ['apps/desktop/electron', 'apps/desktop/renderer']:
        for filename in ['package.json', 'package-lock.json']:
            metadata = json.loads((root / relative / filename).read_text(encoding='utf-8'))
            if metadata['version'] != version:
                raise ValueError(f'{relative}/{filename} version differs from VERSION')
            if filename == 'package-lock.json' and metadata['packages']['']['version'] != version:
                raise ValueError(f'{relative} root lockfile version differs from VERSION')
    metadata = tomllib.loads((root / 'backend/pyproject.toml').read_text(encoding='utf-8'))
    if metadata['project']['version'] != version:
        raise ValueError('Backend package version differs from VERSION')
    match = re.search(r'__version__\s*=\s*[\'"]([^\'"]+)', (root / 'backend/version.py').read_text())
    if not match or match[1] != version:
        raise ValueError('Backend API version differs from VERSION')
    return version


def source_files(root: Path = ROOT) -> dict[str, str]:
    result = {}
    for directory in ['backend', 'apps/desktop/electron', 'apps/desktop/preload',
                      'apps/desktop/shared', 'apps/desktop/renderer', 'scripts']:
        for file in (root / directory).rglob('*'):
            if set(file.relative_to(root).parts) & {'node_modules', 'dist', 'build', 'release', '__pycache__', '.pytest_cache', 'test-results', '.venv', 'venv'}:
                continue
            if file.is_file() and file.suffix in {'.py', '.ts', '.tsx', '.js', '.cjs', '.css', '.html', '.json', '.toml', '.yaml', '.ps1', '.txt'}:
                result[file.relative_to(root).as_posix()] = digest(file)
    result['VERSION'] = digest(root / 'VERSION')
    return result


def verify_backend_freshness(resources: Path, root: Path = ROOT) -> None:
    packaged = resources / 'python/Lib/site-packages/backend'
    expected = {file.relative_to(root / 'backend').as_posix(): file for file in (root / 'backend').rglob('*.py')
                if not (set(file.relative_to(root / 'backend').parts) & {'build', 'dist', '__pycache__', '.venv', 'venv'})}
    actual = {file.relative_to(packaged).as_posix(): file for file in packaged.rglob('*.py')}
    if set(actual) != set(expected):
        raise ValueError('Packaged backend module inventory differs from authoritative source')
    for name, file in expected.items():
        if digest(file) != digest(actual[name]):
            raise ValueError(f'Packaged backend is stale: {name}')


def verify_checksums(release: Path, expected_names: set[str]) -> dict[str, dict]:
    entries = {}
    for line in (release / 'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
        match = re.fullmatch(r'([a-fA-F0-9]{64})  ([^/\\:]+)', line)
        if not match or match[2] in entries or match[2] not in expected_names:
            raise ValueError('Invalid, unexpected or duplicate checksum entry')
        file = release / match[2]
        if not file.is_file() or digest(file) != match[1].lower():
            raise ValueError(f'Release checksum mismatch: {match[2]}')
        entries[match[2]] = {'sha256': match[1].lower(), 'size': file.stat().st_size}
    if set(entries) != expected_names or {f.name for f in release.glob('*.exe')} != expected_names:
        raise ValueError('Missing or unexpected release artifact; mixed builds are not allowed')
    return entries


def verify_resources(resources: Path) -> None:
    bge = resources / 'models/bge-small-en-v1.5-q8_0.gguf'
    if not bge.is_file() or digest(bge) != BGE_HASH:
        raise ValueError('Bundled BGE model is missing or has the wrong SHA-256')
    if {item.name for item in (resources / 'models').glob('*.gguf')} != {bge.name}:
        raise ValueError('Unexpected chat model bundled in release')
    for file in ['python/python.exe', 'llama/llama-server.exe', 'app.asar']:
        if not (resources / file).is_file():
            raise ValueError(f'Missing packaged resource: {file}')


def release_manifest(release: Path, *, write: bool = False, signed: bool = False, root: Path = ROOT) -> dict:
    version = check_versions(root)
    artifacts = verify_checksums(release, {f'NOC-AI-Assistant-{kind}-{version}.exe' for kind in ['Setup', 'Portable']})
    resources = release / 'win-unpacked/resources'
    verify_resources(resources)
    verify_backend_freshness(resources, root)
    code_files = {file.relative_to(release / 'win-unpacked').as_posix(): digest(file)
                  for file in (release / 'win-unpacked').rglob('*') if file.is_file()}
    source = source_files(root)
    manifest_path = release / 'RELEASE-INFO.json'
    if write:
        manifest = {'schema': 1, 'version': version, 'build_id': uuid.uuid4().hex,
                    'created_at_utc': datetime.now(timezone.utc).isoformat(),
                    'distribution': 'signed-release' if signed else 'unsigned-development',
                    'artifacts': artifacts, 'source': source, 'unpacked': code_files}
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    else:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        for key, expected in [('version', version), ('artifacts', artifacts), ('source', source), ('unpacked', code_files)]:
            if manifest.get(key) != expected:
                raise ValueError(f'Release manifest {key} differs; rebuild from current source')
    return {'version': version, 'build_id': manifest['build_id'], 'distribution': manifest['distribution'], 'artifacts': artifacts}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-versions', action='store_true')
    parser.add_argument('--release', type=Path)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--signed', action='store_true')
    args = parser.parse_args()
    try:
        if args.check_versions:
            print(f'All application versions match VERSION: {check_versions()}')
        if args.release:
            print(json.dumps(release_manifest(args.release.resolve(), write=args.write, signed=args.signed), indent=2))
    except (ValueError, OSError, KeyError) as exc:
        print(f'Release integrity failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
