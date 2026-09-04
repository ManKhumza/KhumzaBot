from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional
import json

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Setting, User
from backend.config import get_settings

router = APIRouter(tags=["settings"])

class SettingsResponse(BaseModel):
    appearance: dict
    models: dict
    knowledge: dict
    storage: dict
    security: dict
    diagnostics: dict

class UpdateSettingsRequest(BaseModel):
    appearance: Optional[dict] = None
    models: Optional[dict] = None
    knowledge: Optional[dict] = None
    storage: Optional[dict] = None
    security: Optional[dict] = None
    diagnostics: Optional[dict] = None

DEFAULT_SETTINGS = {
    "appearance": {
        "theme": "system",
        "language": "en",
        "sidebarCollapsed": False,
        "compactMode": False,
    },
    "models": {
        "defaultChatModelId": None,
        "defaultEmbeddingModelId": None,
        "modelDirectory": "",
        "defaultContextLength": 4096,
        "defaultThreads": 0,
        "defaultGpuLayers": -1,
    },
    "knowledge": {
        "defaultChunkSize": 512,
        "defaultChunkOverlap": 50,
        "defaultTopK": 10,
        "hybridAlpha": 0.5,
        "enableReranking": False,
        "rerankerModelId": None,
    },
    "storage": {
        "dataLocation": "",
        "modelStorage": "",
        "knowledgeStorage": "",
    },
    "security": {
        "sessionTimeoutMinutes": 480,
        "maxFailedLogins": 5,
        "lockoutDurationMinutes": 15,
        "passwordMinLength": 12,
        "requireSpecialChars": True,
    },
    "diagnostics": {
        "logLevel": "info",
        "enableTelemetry": False,
        "autoCheckUpdates": False,
        "debugMode": False,
    },
}

@router.get("", response_model=SettingsResponse)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    settings_row = db.query(Setting).filter(Setting.key == "global", Setting.user_id == None).first()
    if settings_row:
        return SettingsResponse(**settings_row.value)
    
    user_settings = db.query(Setting).filter(Setting.user_id == current_user.id).all()
    result = DEFAULT_SETTINGS.copy()
    for s in user_settings:
        if s.key in result:
            result[s.key] = {**result[s.key], **s.value}
    
    return SettingsResponse(**result)

@router.patch("", response_model=SettingsResponse)
async def update_settings(
    request: UpdateSettingsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if "administrator" in current_user.roles:
        settings_row = db.query(Setting).filter(Setting.key == "global", Setting.user_id == None).first()
        if not settings_row:
            settings_row = Setting(key="global", user_id=None, value=DEFAULT_SETTINGS)
            db.add(settings_row)
        
        for key, value in request.dict(exclude_unset=True).items():
            if value is not None:
                settings_row.value[key] = {**settings_row.value.get(key, {}), **value}
    else:
        for key, value in request.dict(exclude_unset=True).items():
            if value is not None:
                setting = db.query(Setting).filter(Setting.key == key, Setting.user_id == current_user.id).first()
                if not setting:
                    setting = Setting(key=key, user_id=current_user.id, value=value)
                    db.add(setting)
                else:
                    setting.value = {**setting.value, **value}
    
    db.commit()
    
    return await get_settings(current_user, db)