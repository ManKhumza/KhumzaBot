"""Backup behavior with isolated databases and synthetic files."""
import asyncio
import json
import secrets
import zipfile

import pytest


def test_backup_restore_integrity_manifest(tmp_path, monkeypatch):
    from backend.config import Settings
    from backend.db.database import init_db, close_db
    from backend.system.backup import create_backup, stage_restore, apply_pending_restore
    data = tmp_path / 'data'
    settings = Settings(data_dir=str(data), models_dir=str(data / 'models'),
                        knowledge_dir=str(data / 'knowledge'), logs_dir=str(data / 'logs'),
                        database_url=f"sqlite:///{data / 'nocai.db'}")
    monkeypatch.delenv("NOCAI_ENCRYPTION", raising=False)
    settings.ensure_directories()
    engine = asyncio.run(init_db(settings.database_url, data_dir=str(data)))
    from backend.db.migrations import run_migrations
    asyncio.run(run_migrations(engine))
    with engine.begin() as connection:
        connection.exec_driver_sql('CREATE TABLE backup_test (value TEXT)')
        connection.exec_driver_sql('INSERT INTO backup_test VALUES (?)', (secrets.token_hex(8),))
    source = data / 'knowledge' / 'fixture.txt'
    source.write_text('Synthetic backup document', encoding='utf-8')
    result = create_backup(settings, tmp_path / 'snapshot.zip', include_models=False, include_knowledge=True)
    assert result['size'] > 0
    with zipfile.ZipFile(result['path']) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['app_version']
        assert 'knowledge/fixture.txt' in manifest['files']
        assert archive.read('nocai.db')[:16] != b'SQLite format 3\x00'
    source.write_text('Changed after snapshot', encoding='utf-8')
    staged = stage_restore(settings, tmp_path / 'snapshot.zip')
    assert staged['restartRequired'] is True
    assert source.read_text() == 'Changed after snapshot'
    asyncio.run(close_db(engine))
    assert apply_pending_restore(settings) is True
    assert source.read_text() == 'Synthetic backup document'
    assert any((data / '.restore-history').iterdir())


@pytest.mark.parametrize('entry', ['../escape', '/escape', 'C:/escape', 'knowledge/../../escape', 'knowledge/a:stream'])
def test_backup_restore_path_traversal_protection(tmp_path, entry):
    from backend.config import Settings
    from backend.system.backup import stage_restore
    archive = tmp_path / 'invalid.zip'
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr(entry, 'Synthetic fixture')
        output.writestr('manifest.json', '{}')
    with pytest.raises(ValueError):
        stage_restore(Settings(data_dir=str(tmp_path / 'data')), archive)
    assert not (tmp_path / 'escape').exists()


def test_backup_restore_rejects_corruption_without_mutating_profile(tmp_path):
    from backend.config import Settings
    from backend.system.backup import stage_restore
    data = tmp_path / 'data'
    data.mkdir()
    sentinel = data / 'nocai.db'
    sentinel.write_bytes(b'preserved synthetic sentinel')
    archive = tmp_path / 'bad.zip'
    archive.write_bytes(b'not a zip')
    with pytest.raises(ValueError):
        stage_restore(Settings(data_dir=str(data)), archive)
    assert sentinel.read_bytes() == b'preserved synthetic sentinel'


def test_backup_restore_rejects_overwrite_destination(tmp_path):
    from backend.config import Settings
    from backend.system.backup import create_backup
    archive = tmp_path / 'existing.zip'
    archive.write_bytes(b'existing backup')
    with pytest.raises(ValueError, match='exists'):
        create_backup(Settings(data_dir=str(tmp_path / 'data')), archive)
    assert archive.read_bytes() == b'existing backup'


@pytest.fixture
def staged_backup(tmp_path, monkeypatch):
    from backend.config import Settings
    from backend.db.database import init_db, close_db
    from backend.db.migrations import run_migrations
    from backend.system.backup import create_backup, stage_restore
    monkeypatch.delenv("NOCAI_ENCRYPTION", raising=False)
    data = tmp_path / "profile"
    settings = Settings(data_dir=str(data), models_dir=str(data / "models"),
                        knowledge_dir=str(data / "knowledge"), logs_dir=str(data / "logs"),
                        database_url=f"sqlite:///{data / 'nocai.db'}")
    settings.ensure_directories()
    engine = asyncio.run(init_db(settings.database_url, data_dir=str(data)))
    try:
        asyncio.run(run_migrations(engine))
        source = data / "knowledge" / "fixture.txt"
        source.write_bytes(b"synthetic archived content")
        archive = tmp_path / "snapshot.zip"
        create_backup(settings, archive)
        source.write_bytes(b"synthetic current content")
    finally:
        asyncio.run(close_db(engine))
    original_db = (data / "nocai.db").read_bytes()
    stage_restore(settings, archive)
    return settings, original_db


def test_restore_detects_staged_tampering_before_profile_mutation(staged_backup):
    from pathlib import Path
    from backend.system.backup import apply_pending_restore
    settings, original_db = staged_backup
    data = Path(settings.data_dir)
    (data / ".restore-pending" / "knowledge" / "fixture.txt").write_bytes(b"tampered fixture")
    with pytest.raises(ValueError, match="checksum"):
        apply_pending_restore(settings)
    assert (data / "nocai.db").read_bytes() == original_db
    assert (data / "knowledge" / "fixture.txt").read_bytes() == b"synthetic current content"


def test_restore_rolls_back_atomic_rename_failure(staged_backup, monkeypatch):
    from pathlib import Path
    import backend.system.backup as backup
    settings, original_db = staged_backup
    data = Path(settings.data_dir)
    replace = backup.os.replace
    failed = False
    def fail_once(source, destination):
        nonlocal failed
        if not failed and Path(source) == data / "knowledge":
            failed = True
            raise PermissionError("injected rename denial")
        return replace(source, destination)
    monkeypatch.setattr(backup.os, "replace", fail_once)
    with pytest.raises(PermissionError, match="injected"):
        backup.apply_pending_restore(settings)
    assert failed
    assert (data / "nocai.db").read_bytes() == original_db
    assert (data / "knowledge" / "fixture.txt").read_bytes() == b"synthetic current content"
    assert not (data / ".restore-journal.json").exists()
    assert any((data / ".restore-history").iterdir())


def test_restore_restart_recovers_after_interrupted_transaction(staged_backup, monkeypatch):
    from pathlib import Path
    import backend.system.backup as backup
    settings, original_db = staged_backup
    data = Path(settings.data_dir)
    replace = backup.os.replace
    class PowerLoss(BaseException):
        pass
    def interrupt(source, destination):
        if Path(source) == data / ".restore-pending" / "nocai.db":
            raise PowerLoss()
        return replace(source, destination)
    monkeypatch.setattr(backup.os, "replace", interrupt)
    with pytest.raises(PowerLoss):
        backup.apply_pending_restore(settings)
    assert (data / ".restore-journal.json").is_file()
    monkeypatch.setattr(backup.os, "replace", replace)
    with pytest.raises(RuntimeError, match="rolled back"):
        backup.apply_pending_restore(settings)
    assert (data / "nocai.db").read_bytes() == original_db
    assert (data / "knowledge" / "fixture.txt").read_bytes() == b"synthetic current content"
    assert backup.apply_pending_restore(settings) is False
