"""Behavioral authorization, administration and session policy regressions."""
import asyncio
import secrets
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from test_backend_runtime_integrity import isolated_backend
from backend.db.models import User, Session as SessionModel, AuditLog


def test_sessions_bounded_expired_cleaned_and_password_revokes_others(isolated_backend):
    _, _, factory = isolated_backend
    from backend.auth.routes import login, LoginRequest, change_password, ChangePasswordRequest
    from backend.auth.password import hash_password
    password = secrets.token_urlsafe(24) + "!"
    with factory() as db:
        user = db.get(User, "owner")
        user.password_hash = hash_password(password)
        db.add(SessionModel(id="expired", user_id=user.id, token_hash=secrets.token_hex(32),
                            expires_at=datetime.utcnow() - timedelta(seconds=1)))
        db.commit()
        responses = [asyncio.run(login(LoginRequest(username=user.username, password=password), db)) for _ in range(7)]
        assert db.query(SessionModel).filter(SessionModel.revoked_at.is_(None)).count() == 5
        assert db.get(SessionModel, "expired") is None
        current = responses[-1]
        asyncio.run(change_password(ChangePasswordRequest(currentPassword=password, newPassword=secrets.token_urlsafe(24) + "!"),
                                    current_user=user, db=db, authorization=f"Bearer {current.token}"))
        assert db.query(SessionModel).filter(SessionModel.revoked_at.is_(None)).count() == 1
        assert db.query(AuditLog).filter_by(action="auth.password_change", actor_id=user.id).count() == 1


def test_admin_cannot_disable_or_demote_last_administrator(isolated_backend):
    _, _, factory = isolated_backend
    from backend.admin.routes import update_user, UpdateUserRequest, create_user, CreateUserRequest, list_roles
    with factory() as db:
        owner = db.get(User, "owner")
        for request in (UpdateUserRequest(isActive=False), UpdateUserRequest(roles=["operator"])):
            with pytest.raises(HTTPException) as denied:
                asyncio.run(update_user(owner.id, request, current_user=owner, db=db))
            assert denied.value.status_code == 409
            assert owner.is_active and "administrator" in owner.roles
        with pytest.raises(HTTPException) as invalid:
            asyncio.run(create_user(CreateUserRequest(username="second", password=secrets.token_urlsafe(24) + "!", roles=["superuser"]),
                                    current_user=owner, db=db))
        assert invalid.value.status_code == 400
        assert db.query(User).count() == 1
        roles = asyncio.run(list_roles(current_user=owner, db=db))
        assert {role.name for role in roles} == {"administrator", "operator", "knowledge_manager"}
        assert "admin:users" in next(role.permissions for role in roles if role.name == "administrator")


def test_password_policy_applies_to_every_creation_path(isolated_backend):
    _, _, factory = isolated_backend
    from backend.auth.routes import create_bootstrap_admin
    from backend.admin.routes import create_user, CreateUserRequest
    with factory() as db:
        owner = db.get(User, "owner")
        weak = "lowercasepassword"
        with pytest.raises(HTTPException) as bootstrap:
            asyncio.run(create_bootstrap_admin(db, "bootstrap", weak))
        assert bootstrap.value.status_code == 400
        with pytest.raises(HTTPException) as admin:
            asyncio.run(create_user(CreateUserRequest(username="new-user", password=weak), current_user=owner, db=db))
        assert admin.value.status_code == 400
        assert db.query(User).count() == 1


def test_model_import_rejects_path_traversal_role():
    from pydantic import ValidationError
    from backend.models.routes import ImportModelRequest
    with pytest.raises(ValidationError) as invalid:
        ImportModelRequest(sourcePath="selected.gguf", role="../../outside")
    assert any(error["loc"] == ("role",) for error in invalid.value.errors())


def test_external_model_registration_and_removal_preserve_original(isolated_backend, monkeypatch, tmp_path):
    settings, _, factory = isolated_backend
    import backend.models.routes as routes
    monkeypatch.setattr(routes, "get_settings", lambda: settings)
    external = tmp_path / "external" / "fixture.gguf"
    external.parent.mkdir()
    external.write_bytes(b"GGUF" + bytes(16))
    with factory() as db:
        owner = db.get(User, "owner")
        response = asyncio.run(routes.import_model(routes.ImportModelRequest(sourcePath=str(external), role="chat", copy=False),
                                                   current_user=owner, db=db))
        assert external.is_file()
        assert response.filepath == str(external.resolve())
        asyncio.run(routes.delete_model(response.id, current_user=owner, db=db))
        assert external.read_bytes() == b"GGUF" + bytes(16)
