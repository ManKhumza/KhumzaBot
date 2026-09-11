"""Versioned local backup archives and recoverable, offline restore installation.

Encrypted snapshots retain their DPAPI-wrapped key and are for the same Windows
account. Restore is staged while the server is alive and installed before opening
the database on the next launch. Originals are retained in .restore-history.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from sqlalchemy.engine import make_url

from backend.db.database import open_dbapi_connection
from backend.security.dpapi import KeyManager
from backend.security.encryption import get_connection, is_encryption_enabled
from backend.version import __version__
from backend.db.migrations import MIGRATIONS
from backend.db.vector_schema import load_vector_extension

MAX_MEMBERS = 50_000
MAX_BYTES = 32 * 1024**3
FORMAT_VERSION = 1


def _hash(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def _profile(settings) -> Path:
    root = Path(settings.data_dir).resolve()
    if Path(make_url(settings.database_url).database or '').resolve() != root / 'nocai.db':
        raise ValueError('Backups require the standard profile database location')
    return root


def _write_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as output:
        json.dump(value, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def _safe_name(name: str) -> bool:
    parts = PurePosixPath(name).parts
    return bool(parts) and name == '/'.join(parts) and not name.startswith('/') and '\\' not in name and ':' not in name and all(
        part not in {'.', '..'} and not part.endswith(('.', ' ')) for part in parts
    ) and (name in {'manifest.json', 'nocai.db', '.nocai.key'} or parts[0] in {'knowledge', 'models'})


def create_backup(settings, destination: str | Path, *, include_models=False, include_knowledge=True) -> dict:
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('Backup destination already exists; choose a new archive name')
    root = _profile(settings)
    if destination.suffix.lower() != '.zip' or destination.is_relative_to(root):
        raise ValueError('Choose a .zip backup destination outside the application profile')
    if not destination.parent.is_dir():
        raise ValueError('Backup destination directory does not exist')
    if not (root / 'nocai.db').is_file():
        raise ValueError('No application database is available to back up')
    temporary_archive = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        with tempfile.TemporaryDirectory(prefix='.backup-', dir=root) as staging_name:
            staging = Path(staging_name)
            key = KeyManager(root).get_or_create_key() if is_encryption_enabled() else None
            source = open_dbapi_connection(settings.database_url)
            target = get_connection(staging / 'nocai.db', key)
            try:
                source.backup(target)
                load_vector_extension(target)
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Database integrity check failed')
                schema = target.execute('SELECT COALESCE(MAX(version), 0) FROM schema_version').fetchone()[0]
            finally:
                source.close()
                target.close()
            files = {'nocai.db': staging / 'nocai.db'}
            if key is not None:
                files['.nocai.key'] = root / '.nocai.key'
            for enabled, directory in ((include_models, 'models'), (include_knowledge, 'knowledge')):
                if not enabled:
                    continue
                source_root = Path(getattr(settings, directory + '_dir')).resolve()
                if source_root != root / directory:
                    raise ValueError('Backups require model and knowledge storage inside the profile')
                for item in source_root.rglob('*'):
                    if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
                        raise ValueError('Backup source contains an unsupported filesystem link')
                    if item.is_file():
                        name = directory + '/' + item.relative_to(source_root).as_posix()
                        if not _safe_name(name):
                            raise ValueError('Backup source contains an unsupported filename')
                        files[name] = item
            if len(files) > MAX_MEMBERS or sum(item.stat().st_size for item in files.values()) > MAX_BYTES:
                raise ValueError('Backup exceeds the supported archive limits')
            created = datetime.now(timezone.utc).isoformat()
            manifest = {'format_version': FORMAT_VERSION, 'app_version': __version__,
                        'schema_version': schema, 'created_at': created,
                        'encrypted': key is not None, 'includes_models': include_models,
                        'includes_knowledge': include_knowledge,
                        'model_root': str(Path(settings.models_dir).resolve()),
                        'files': {name: {'sha256': _hash(file), 'size': file.stat().st_size}
                                  for name, file in files.items()}}
            with zipfile.ZipFile(temporary_archive, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
                for name, file in files.items():
                    archive.write(file, name)
                archive.writestr('manifest.json', json.dumps(manifest))
            # A hard link publishes atomically and refuses to overwrite a destination
            # another process created after our initial check (same filesystem).
            os.link(temporary_archive, destination)
            return {'path': str(destination), 'size': destination.stat().st_size, 'createdAt': created}
    finally:
        temporary_archive.unlink(missing_ok=True)


def _extract_validated(archive_path: Path, staging: Path) -> dict:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            names = [item.filename for item in members]
            if len(names) > MAX_MEMBERS or len({name.casefold() for name in names}) != len(names):
                raise ValueError('Backup has too many or duplicate entries')
            if sum(item.file_size for item in members) > MAX_BYTES:
                raise ValueError('Backup exceeds the uncompressed size limit')
            for item in members:
                if not _safe_name(item.filename) or item.is_dir() or stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError('Backup contains an unsafe archive path or link')
            if 'manifest.json' not in names or archive.getinfo('manifest.json').file_size > 8 * 1024**2:
                raise ValueError('Backup manifest is missing or too large')
            manifest = json.loads(archive.read('manifest.json'))
            if manifest.get('format_version') != FORMAT_VERSION:
                raise ValueError('Unsupported backup format')
            version = tuple(int(part) for part in manifest['app_version'].split('.'))
            current = tuple(int(part) for part in __version__.split('.'))
            if len(version) != 3 or version[0] != current[0] or version > current:
                raise ValueError('Backup was made by an incompatible application version')
            if not isinstance(manifest.get('schema_version'), int) or not 0 <= manifest['schema_version'] <= max(item[0] for item in MIGRATIONS):
                raise ValueError('Backup database schema is not supported')
            expected = manifest['files']
            if set(expected) != set(names) - {'manifest.json'} or 'nocai.db' not in expected:
                raise ValueError('Backup contents do not match the manifest')
            for name, info in expected.items():
                if info['size'] != archive.getinfo(name).file_size:
                    raise ValueError('Backup file size does not match the manifest')
                output = staging / name
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, output.open('xb') as target:
                    shutil.copyfileobj(source, target, length=1024**2)
                if _hash(output) != info['sha256']:
                    raise ValueError('Backup file checksum validation failed')
            if manifest['encrypted']:
                if not (staging / '.nocai.key').is_file():
                    raise ValueError('Backup encryption key is missing')
                key = KeyManager(staging)._load_key()
            else:
                if is_encryption_enabled():
                    raise ValueError('Unencrypted test backups cannot replace an encrypted profile')
                key = None
            connection = get_connection(staging / 'nocai.db', key)
            try:
                load_vector_extension(connection)
                actual_schema = connection.execute('SELECT COALESCE(MAX(version), 0) FROM schema_version').fetchone()[0]
                if actual_schema != manifest['schema_version']:
                    raise ValueError('Backup database schema does not match the manifest')
                if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Backup database integrity check failed')
                if connection.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise ValueError('Backup database has invalid foreign keys')
                # Never revive old authenticated sessions after restore.
                connection.execute('DELETE FROM sessions')
                connection.commit()
            finally:
                connection.close()
            _write_json(staging / 'manifest.json', manifest)
            return manifest
    except (zipfile.BadZipFile, KeyError, TypeError, json.JSONDecodeError, RuntimeError) as exc:
        raise ValueError('Backup is invalid or cannot be decrypted by this Windows account') from exc


def stage_restore(settings, archive_path: str | Path) -> dict:
    root = _profile(settings)
    root.mkdir(parents=True, exist_ok=True)
    pending = root / '.restore-pending'
    if pending.exists():
        raise ValueError('A restore is already staged; restart the application first')
    staging = Path(tempfile.mkdtemp(prefix='.restore-validate-', dir=root))
    try:
        manifest = _extract_validated(Path(archive_path).resolve(), staging)
        rollback = root / '.restore-history' / uuid.uuid4().hex
        _write_json(staging / 'restore.json', {'rollback': rollback.name,
                    'files': {file.relative_to(staging).as_posix(): _hash(file)
                              for file in staging.rglob('*') if file.is_file()}})
        os.replace(staging, pending)
        return {'success': True, 'restartRequired': True, 'previousBackup': str(rollback)}
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _rollback(root: Path, history: Path, entries: list[dict]) -> None:
    failed = history / 'failed-replacement'
    failed.mkdir(exist_ok=True)
    for entry in reversed(entries):
        name = entry['name']
        saved, target = history / name, root / name
        if saved.exists() or not entry['existed']:
            if target.exists():
                os.replace(target, failed / name)
            if saved.exists():
                os.replace(saved, target)


def apply_pending_restore(settings) -> bool:
    """Run before init_db; a journal permits rollback after power/process loss."""
    root = Path(settings.data_dir).resolve()
    journal = root / '.restore-journal.json'
    pending = root / '.restore-pending'
    if not journal.exists() and not pending.exists():
        return False
    _profile(settings)
    if journal.exists():
        prior = json.loads(journal.read_text(encoding='utf-8'))
        _validate_transaction(prior['history'], prior['entries'])
        history = root / '.restore-history' / prior['history']
        if prior.get('committed'):
            if pending.exists():
                os.replace(pending, history / 'restore-metadata')
            journal.unlink()
            return True
        _rollback(root, history, prior['entries'])
        journal.unlink()
        if pending.exists():
            os.replace(pending, history / 'interrupted-restore')
        raise RuntimeError('An interrupted restore was rolled back; restart to use the preserved profile')
    if not pending.exists():
        return False
    manifest = json.loads((pending / 'manifest.json').read_text(encoding='utf-8'))
    transaction = json.loads((pending / 'restore.json').read_text(encoding='utf-8'))
    history_name = transaction['rollback']
    _validate_transaction(history_name, [])
    actual = {file.relative_to(pending).as_posix(): file for file in pending.rglob('*') if file.is_file()}
    if set(actual) != set(transaction['files']) | {'restore.json'}:
        raise ValueError('Staged restore contents changed; original profile was preserved')
    for name, expected in transaction['files'].items():
        if not _safe_name(name) or actual[name].is_symlink() or _hash(actual[name]) != expected:
            raise ValueError('Staged restore checksum failed; original profile was preserved')
    history = root / '.restore-history' / history_name
    history.mkdir(parents=True, exist_ok=False)
    names = ['nocai.db', 'nocai.db-wal', 'nocai.db-shm']
    if manifest['encrypted']:
        names.append('.nocai.key')
    for field, directory in [('includes_models', 'models'), ('includes_knowledge', 'knowledge')]:
        if manifest[field]:
            names.append(directory)
            (pending / directory).mkdir(exist_ok=True)
    entries = [{'name': name, 'existed': (root / name).exists()} for name in names]
    _write_json(journal, {'history': history_name, 'entries': entries})
    try:
        for entry in entries:
            name = entry['name']
            if entry['existed']:
                os.replace(root / name, history / name)
            if (pending / name).exists():
                os.replace(pending / name, root / name)
        # Remap bundled/copied model paths into the restored profile; absent external
        # models remain visibly unavailable for normal runtime reconciliation.
        key = KeyManager(root)._load_key() if manifest['encrypted'] else None
        connection = get_connection(root / 'nocai.db', key)
        try:
            old_root = Path(manifest['model_root'])
            for model_id, filepath in connection.execute('SELECT id, filepath FROM models').fetchall():
                candidate = Path(filepath)
                if candidate.is_relative_to(old_root):
                    destination = (Path(settings.models_dir) / candidate.relative_to(old_root)).resolve()
                    if not destination.is_relative_to(Path(settings.models_dir).resolve()):
                        raise ValueError('Backup contains an unsafe model storage path')
                    mapped = str(destination)
                    connection.execute('UPDATE models SET filepath=? WHERE id=?', (mapped, model_id))
            connection.commit()
        finally:
            connection.close()
        _write_json(journal, {'history': history_name, 'entries': entries, 'committed': True})
        os.replace(pending, history / 'restore-metadata')
        journal.unlink()
        return True
    except Exception:
        _rollback(root, history, entries)
        journal.unlink(missing_ok=True)
        if pending.exists():
            os.replace(pending, history / 'failed-restore')
        raise


def _validate_transaction(history: str, entries: list[dict]) -> None:
    allowed = {'nocai.db', 'nocai.db-wal', 'nocai.db-shm', '.nocai.key', 'models', 'knowledge'}
    if not isinstance(history, str) or len(history) != 32 or any(c not in '0123456789abcdef' for c in history):
        raise ValueError('Invalid restore transaction')
    if not isinstance(entries, list) or any(
        not isinstance(entry, dict) or entry.get('name') not in allowed or
        not isinstance(entry.get('existed'), bool) for entry in entries
    ) or len({entry['name'] for entry in entries}) != len(entries):
        raise ValueError('Invalid restore journal')
