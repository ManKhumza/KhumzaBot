"""Administrator-only backup and staged restore operations."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from backend.auth.dependencies import get_db, require_permission
from backend.audit.service import audit_log
from backend.system.backup import create_backup, stage_restore

router = APIRouter(prefix='/system', tags=['system'])


class BackupRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    destination: str = Field(min_length=1, max_length=4096)
    includeModels: bool = False
    includeKnowledge: bool = True


class RestoreRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(min_length=1, max_length=4096)


async def _operate(request, user, db, action, operation):
    if getattr(request.app.state, 'maintenance', False):
        raise HTTPException(409, 'A maintenance operation is already running')
    if request.app.state.model_manager._generation_count:
        raise HTTPException(409, 'Wait for active chat generation to finish before backup or restore')
    actor_id, actor_name = user.id, user.username
    db.close()
    request.app.state.maintenance = True
    try:
        await request.app.state.ingestion.stop()
        result = await asyncio.to_thread(operation)
        audit_log(action, {'completed': True}, actor_id=actor_id, actor_name=actor_name)
        return result
    except (ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        request.app.state.maintenance = False
        await request.app.state.ingestion.start()


@router.post('/backup')
async def backup(payload: BackupRequest, request: Request,
                 user=Depends(require_permission('admin:backup')), db: Session = Depends(get_db)):
    return await _operate(request, user, db, 'system.backup', lambda: create_backup(
        request.app.state.settings, payload.destination,
        include_models=payload.includeModels, include_knowledge=payload.includeKnowledge))


@router.post('/restore')
async def restore(payload: RestoreRequest, request: Request,
                  user=Depends(require_permission('admin:backup')), db: Session = Depends(get_db)):
    return await _operate(request, user, db, 'system.restore_staged', lambda: stage_restore(
        request.app.state.settings, payload.path))
